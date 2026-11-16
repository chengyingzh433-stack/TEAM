import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import {
  RESEARCH_PATH_OPERATIONS,
  RESEARCH_SPECIALIST_OPERATIONS,
  RESEARCH_MEMBER_INPUT_OPERATIONS,
} from "../../contracts/research-m3";
import { RESEARCH_M3_TOOL_PROPERTIES } from "../../contracts/research-m3-schema";
import { RESEARCH_LANGUAGE_OPERATIONS } from "../../contracts/research-language-tools";
import { SOURCE_PAGE_OPERATIONS } from "../../contracts/research-source-pages";
import { SYNTHESIS_OPERATIONS } from "../../contracts/research-synthesis";
import { RESEARCH_LITERATURE_TOOL_OPERATIONS } from "../../contracts/research-literature-search";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  decodeResearchRoute,
  RESEARCH_STAGE_IDS,
  type ResearchModel,
} from "../../contracts/research-group";

/** Keep image bytes in Pi image content, never in the text response or project details. */
export function researchGroupToolResult(
  operation: unknown,
  response: unknown,
  nextStage?: unknown,
): AgentToolResult<unknown> {
  let result = response;
  const images: { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }[] = [];
  const unavailablePage =
    operation === "source-read-page" &&
    response &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    "ok" in response &&
    response.ok === false;
  if (operation === "method-read-image" || (operation === "source-read-page" && !unavailablePage)) {
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("方法图片工具没有返回实际图像。");
    const envelope = response as Record<string, unknown>;
    const media = envelope.media;
    if (!media || typeof media !== "object" || Array.isArray(media))
      throw new Error("方法图片工具没有返回实际图像。");
    const image = media as Record<string, unknown>;
    if (
      Object.keys(envelope).some((key) => !["result", "media"].includes(key)) ||
      Object.keys(image).some((key) => !["type", "data", "mimeType"].includes(key)) ||
      image.type !== "image" ||
      !["image/png", "image/jpeg"].includes(String(image.mimeType)) ||
      typeof image.data !== "string" ||
      !image.data.length ||
      image.data.length > 33_333_336 ||
      image.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    )
      throw new Error("方法图片工具返回的图像格式无效。");
    result = envelope.result;
    images.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType as "image/png" | "image/jpeg",
    });
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          nextStage ? { result, nextStage } : result,
          null,
          operation === "status" || operation === "synthesis-context" ? undefined : 2,
        ),
      },
      ...images,
    ],
    details: result,
  };
}

export function createResearchGroupExtension(
  invoke: (
    ctx: ExtensionContext,
    callId: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>,
): ExtensionFactory {
  return (pi) => {
    const applied = new Map<string, string>();
    const actualModel = (ctx: ExtensionContext): ResearchModel => {
      if (!ctx.model) throw new Error("成员尚未选择可用模型。");
      return {
        provider: ctx.model.provider,
        modelId: ctx.model.id,
        thinkingLevel: pi.getThinkingLevel(),
      };
    };
    const applyRoute = async (ctx: ExtensionContext, requireActive = false) => {
      const route = decodeResearchRoute(await invoke(ctx, "route", { operation: "route" }));
      if (!route.active) {
        if (requireActive) throw new Error("课题组已停止，请在导师会话恢复或开始新输入版本。");
        return undefined;
      }
      const key = ctx.sessionManager.getSessionId();
      const current = actualModel(ctx);
      const signature = JSON.stringify({
        route,
        inheritedModel: route.model ? undefined : current,
      });
      if (
        applied.get(key) === signature &&
        (!route.model ||
          (current.provider === route.model.provider &&
            current.modelId === route.model.modelId &&
            (!route.model.thinkingLevel || current.thinkingLevel === route.model.thinkingLevel)))
      )
        return undefined;
      try {
        if (ctx.signal?.aborted) return undefined;
        if (
          route.model &&
          (current.provider !== route.model.provider || current.modelId !== route.model.modelId)
        ) {
          const model = ctx.modelRegistry.find(route.model.provider, route.model.modelId);
          if (!model || !(await pi.setModel(model)))
            throw new Error(
              `阶段“${route.stage.title}”需要 ${route.model.provider}/${route.model.modelId}，模型或认证不可用；请检查配置。`,
            );
        }
        if (route.model?.thinkingLevel) pi.setThinkingLevel(route.model.thinkingLevel);
        const actual = actualModel(ctx);
        if (
          route.model &&
          (actual.provider !== route.model.provider ||
            actual.modelId !== route.model.modelId ||
            (route.model.thinkingLevel && actual.thinkingLevel !== route.model.thinkingLevel))
        )
          throw new Error(`阶段“${route.stage.title}”的模型或思考强度未能应用，请调整配置。`);
        await invoke(ctx, "route-applied", {
          operation: "route-applied",
          route: { ...route, model: actual },
        });
        applied.set(key, signature);
        return {
          id: route.stage.id,
          title: route.stage.title,
          goal: route.stage.goal,
          deliverables: route.stage.deliverables,
          model: actual,
        };
      } catch (error) {
        try {
          await invoke(ctx, "route-failed", {
            operation: "route-failed",
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          /* Preserve the original routing failure. */
        }
        throw error;
      }
    };
    pi.on("before_agent_start", async (event, ctx) => {
      try {
        const scope = (await invoke(ctx, "scope", { operation: "scope" })) as
          { scope?: string } | undefined;
        if (scope?.scope === "none") return;
        if (!["research-group", "research-specialist"].includes(scope?.scope ?? ""))
          throw new Error("无法核实研究会话范围，停止原生请求。");
      } catch (error) {
        ctx.abort();
        throw error;
      }
      event.systemPromptOptions.selectedTools = ["research_group"];
      // Member selection can be unchanged while this is a new native attempt.
      // Reapply once at admission so inherited models acquire their own durable provenance.
      applied.delete(ctx.sessionManager.getSessionId());
      try {
        await applyRoute(ctx, true);
      } catch (error) {
        // Pi reports extension hook exceptions and continues. Explicit abort is the
        // pre-request boundary; a failed route must never silently use the old model.
        ctx.abort();
        throw error;
      }
    });
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName === "research_group") return;
      try {
        const scope = (await invoke(ctx, "scope", { operation: "scope" })) as
          { scope?: string } | undefined;
        if (scope?.scope === "none") return;
        if (!["research-group", "research-specialist"].includes(scope?.scope ?? ""))
          throw new Error("无法核实研究会话范围。");
      } catch {
        ctx.abort();
        return { block: true, reason: "研究会话范围无法核实，未开放其他工具，请检查课题记录。" };
      }
      return {
        block: true,
        reason:
          "本轮课题组只使用 research_group 接入的方法库与有版本的成果；原文检索、材料和数据分析使用本工具的对应操作；其他文件操作和派生团队请列为导师待决事项。",
      };
    });
    const tool: ToolDefinition<any, unknown> = {
      name: "research_group",
      label: "课题组协作",
      description:
        "仅供教育研究课题组固定成员检索只读课程库、发布/读取有版本的中间成果、定向讨论和复核。不能创建团队；普通会话不使用。",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "knowledge",
              "method-package",
              "method-read-image",
              "method-image-reading",
              "method-apply",
              "method-opinion",
              "method-adjudicate",
              "method-check",
              "status",
              "publish",
              "read",
              "message",
              "inputs",
              "source-search",
              "source-fetch",
              "source-read",
              "analyze",
              "read-analysis",
              "analysis-registry",
              "register-analysis",
              "run-analysis",
              "reuse-analysis",
              "read-registered-analysis",
              "review-analysis",
              "numeric-check",
              "numeric-bind",
              "numeric-render",
              "declare-result-field",
              "review-result-field",
              "numeric-candidate-review",
              "claim-context",
              "claim-register",
              "claim-review",
              "claim-check",
              ...RESEARCH_LITERATURE_TOOL_OPERATIONS,
              ...RESEARCH_LANGUAGE_OPERATIONS,
              ...SOURCE_PAGE_OPERATIONS,
              ...SYNTHESIS_OPERATIONS,
              ...RESEARCH_PATH_OPERATIONS,
              ...RESEARCH_MEMBER_INPUT_OPERATIONS,
              ...RESEARCH_SPECIALIST_OPERATIONS,
              "request-decision",
              "discussion-post",
            ],
          },
          discussion: {
            type: "object",
            properties: {
              topic: { type: "string" },
              revision: { type: "integer" },
              expectedMessages: { type: "integer" },
              text: { type: "string" },
              question: { type: "string" },
            },
            required: ["topic", "revision", "expectedMessages", "text", "question"],
            additionalProperties: false,
          },
          decision: {
            anyOf: [
              {
                type: "object",
                properties: {
                  conditionId: { type: "string" },
                  supersedesRequestId: { type: "string" },
                  changedCondition: { type: "string" },
                  question: { type: "string" },
                  context: { type: "string" },
                  impact: { type: "string" },
                  taskIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
                  recommendedOptionId: { type: "string" },
                  options: {
                    type: "array",
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        label: { type: "string" },
                        consequence: { type: "string" },
                        outcome: { type: "string", enum: ["confirmed", "declined", "deferred"] },
                      },
                      required: ["id", "label", "consequence", "outcome"],
                      additionalProperties: false,
                    },
                  },
                },
                required: [
                  "conditionId",
                  "question",
                  "context",
                  "impact",
                  "taskIds",
                  "recommendedOptionId",
                  "options",
                ],
                additionalProperties: false,
              },
              { type: "string", enum: ["include", "exclude", "undecided"] },
            ],
          },
          query: { type: "string" },
          request: { type: "object", additionalProperties: true },
          scopeId: { type: "string" },
          baselineId: { type: "string" },
          languageBaselineId: { type: "string" },
          languageScopeId: { type: "string" },
          languageRevisionId: { type: "string" },
          side: { type: "string", enum: ["baseline", "target"] },
          page: { type: "integer", minimum: 1, maximum: 1000 },
          languageReview: {
            type: "object",
            properties: {
              revisionId: { type: "string" },
              classification: {
                type: "string",
                enum: ["meaning-preserved", "substantive-change", "insufficient-material"],
              },
              reason: { type: "string" },
              coverage: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    unitId: { type: "string" },
                    baseline: {
                      type: "object",
                      properties: {
                        start: { type: "integer" },
                        end: { type: "integer" },
                        exactText: { type: "string" },
                      },
                      required: ["start", "end", "exactText"],
                      additionalProperties: false,
                    },
                    target: {
                      type: "object",
                      properties: {
                        start: { type: "integer" },
                        end: { type: "integer" },
                        exactText: { type: "string" },
                      },
                      required: ["start", "end", "exactText"],
                      additionalProperties: false,
                    },
                  },
                  required: ["unitId", "baseline", "target"],
                  additionalProperties: false,
                },
              },
            },
            required: ["revisionId", "classification", "reason", "coverage"],
            additionalProperties: false,
          },
          strategyId: { type: "string" },
          strategyVersion: { type: "integer" },
          queryIndex: { type: "integer", minimum: 0 },
          materialId: { type: "string" },
          recordId: { type: "string" },
          requiredDepth: {
            type: "string",
            enum: ["metadata", "abstract", "partial-text", "full-text"],
          },
          remainingLimitations: { type: "array", items: { type: "string" } },
          strategy: {
            type: "object",
            properties: {
              id: { type: "string" },
              version: { type: "integer" },
              question: { type: "string" },
              concepts: { type: "array", items: { type: "string" } },
              synonyms: { type: "array", items: { type: "string" } },
              queries: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    source: { type: "string" },
                    query: { type: "string" },
                    filters: { type: "string" },
                  },
                  required: ["source", "query", "filters"],
                  additionalProperties: false,
                },
              },
              inclusionCriteria: { type: "array", items: { type: "string" } },
              exclusionCriteria: { type: "array", items: { type: "string" } },
              stopRule: { type: "string" },
              changeReason: { type: "string" },
            },
            required: [
              "id",
              "version",
              "question",
              "concepts",
              "synonyms",
              "queries",
              "inclusionCriteria",
              "exclusionCriteria",
              "stopRule",
              "changeReason",
            ],
            additionalProperties: false,
          },
          packageId: { type: "string" },
          supersedesPackageId: { type: "string" },
          receiptId: { type: "string" },
          applicationId: { type: "string" },
          opinionIds: { type: "array", items: { type: "string" } },
          recordIds: { type: "array", items: { type: "string" } },
          observations: { type: "string" },
          methodSelection: { type: "string" },
          applicabilityExplanation: { type: "string" },
          nonApplicableConditions: { type: "array", items: { type: "string" } },
          limitations: { type: "string" },
          scoringClaim: { type: "string", enum: ["not-scored", "partial-indicators-only"] },
          note: { type: "string" },
          stage: {
            type: "string",
            enum: [...new Set([...RESEARCH_STAGE_IDS, ...FUSION_STAGE_IDS])],
          },
          sourceId: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
          analysisId: { type: "string" },
          analysisIds: { type: "array", items: { type: "string" } },
          planId: { type: "string" },
          planVersion: { type: "integer" },
          replayOf: { type: "string" },
          runId: { type: "string" },
          path: {
            description:
              '数值与结果证据操作使用相对 run.result 的逐键数组，不含 result 前缀、不使用点分字符串；例如 ["regression","rSquared"]。图片操作使用本包图片 path 字符串。',
            anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
          },
          quantity: { type: "string", enum: ["sample-size", "r-squared", "coefficient", "other"] },
          unit: { type: "string" },
          decimalPlaces: { type: "integer" },
          rounding: { type: "string", enum: ["half-away-from-zero", "half-even", "truncate"] },
          unitSeparator: { type: "string", enum: ["", " "] },
          fieldMetadataId: { type: "string" },
          metadataId: { type: "string" },
          start: { type: "integer" },
          end: { type: "integer" },
          classification: { type: "string", enum: ["non-result-number", "requires-binding"] },
          claim: {
            type: "object",
            properties: {
              id: { type: "string" },
              artifactId: { type: "string" },
              start: { type: "integer" },
              end: { type: "integer" },
              category: {
                type: "string",
                enum: ["source-fact", "research-result", "inference", "method"],
              },
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["source", "result"] },
                    sourceId: { type: "string" },
                    locatorId: { type: "string" },
                    start: { type: "integer" },
                    end: { type: "integer" },
                    requiredDepth: {
                      type: "string",
                      enum: ["metadata", "abstract", "partial-text", "full-text"],
                    },
                    relation: { type: "string", enum: ["support", "counterevidence"] },
                    runId: { type: "string" },
                    path: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "相对实际 run.result 的逐键路径，不含 result 前缀；每个键保持原样，不拆分键内的句点。",
                    },
                  },
                  required: ["kind"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "artifactId", "start", "end", "category", "evidence"],
            additionalProperties: false,
          },
          review: {
            type: "object",
            properties: {
              claimId: { type: "string" },
              conclusion: {
                type: "string",
                enum: ["supported", "partially-supported", "unsupported", "insufficient-material"],
              },
              reason: { type: "string" },
              resolvesReviewIds: { type: "array", items: { type: "string" } },
            },
            required: ["claimId", "conclusion", "reason", "resolvesReviewIds"],
            additionalProperties: false,
          },
          reason: { type: "string" },
          binding: {
            type: "object",
            properties: {
              artifactId: { type: "string" },
              start: { type: "integer" },
              end: { type: "integer" },
              runId: { type: "string" },
              path: {
                type: "array",
                items: { type: "string" },
                description:
                  "相对实际 run.result 的逐键路径，不含 result 前缀；每个键保持原样，不拆分键内的句点。",
              },
              fieldMetadataId: { type: "string" },
              quantity: {
                type: "string",
                enum: ["sample-size", "r-squared", "coefficient", "other"],
              },
              unit: { type: "string" },
              decimalPlaces: { type: "integer" },
              rounding: { type: "string", enum: ["half-away-from-zero", "half-even", "truncate"] },
              unitSeparator: { type: "string", enum: ["", " "] },
            },
            required: [
              "artifactId",
              "start",
              "end",
              "runId",
              "path",
              "quantity",
              "unit",
              "decimalPlaces",
              "rounding",
              "unitSeparator",
            ],
            additionalProperties: false,
          },
          plan: {
            type: "object",
            properties: {
              id: { type: "string" },
              version: { type: "integer" },
              label: { type: "string" },
              purpose: {
                type: "string",
                enum: ["primary", "comparison", "descriptive", "supplementary", "exploratory"],
              },
              objective: { type: "string" },
              dataset: {
                type: "object",
                properties: { id: { type: "string" }, sha256: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
              method: { type: "string" },
              columns: { type: "array", items: { type: "string" } },
              outcome: { type: "string" },
              parameters: {
                type: "object",
                additionalProperties: { type: ["string", "number", "boolean", "null"] },
              },
              outputs: { type: "array", items: { type: "string" } },
              reviewPlan: { type: "string" },
              registrationReason: { type: "string" },
              timing: { type: "string", enum: ["prospective", "post-hoc"] },
              sample: {
                type: "object",
                properties: {
                  mode: { type: "string", enum: ["all", "selected-rows"] },
                  id: { type: "string" },
                  sourceLines: { type: "array", items: { type: "integer" } },
                  reason: { type: "string" },
                },
                required: ["mode"],
                additionalProperties: false,
              },
              compareWith: {
                type: "object",
                properties: {
                  planId: { type: "string" },
                  planVersion: { type: "integer" },
                  requireSameSample: { type: "boolean" },
                },
                required: ["planId", "planVersion", "requireSameSample"],
                additionalProperties: false,
              },
            },
            required: [
              "id",
              "version",
              "label",
              "purpose",
              "objective",
              "dataset",
              "method",
              "columns",
              "parameters",
              "outputs",
              "reviewPlan",
              "registrationReason",
              "timing",
              "sample",
            ],
            additionalProperties: false,
          },
          ...RESEARCH_M3_TOOL_PROPERTIES,
          offset: { type: "integer" },
          url: { type: "string" },
          title: { type: "string" },
          authors: { type: "string" },
          year: { type: "string" },
          datasetId: { type: "string" },
          method: { type: "string", enum: ["describe", "correlation", "ols"] },
          columns: { type: "array", items: { type: "string" } },
          outcome: { type: "string" },
          analysisPlan: {
            type: "object",
            properties: {
              datasetId: { type: "string" },
              method: { type: "string", enum: ["describe", "correlation", "ols"] },
              columns: { type: "array", items: { type: "string" } },
              outcome: { type: "string" },
            },
            required: ["datasetId", "method", "columns"],
          },
          ids: { type: "array", items: { type: "string" } },
          artifactId: { type: "string" },
          revision: { type: "integer" },
          kind: {
            type: "string",
            enum: [
              "plan",
              "proposal",
              "assessment",
              "material",
              "critique",
              "revision",
              "verification",
              "review",
              "stage-draft",
              "stage-risk",
              "stage-material",
              "stage-critique",
              "stage-revision",
              "stage-verification",
              "stage-review",
            ],
          },
          content: { type: "string" },
          refs: {
            type: "array",
            items: { type: "string" },
            description:
              "Only current artifact IDs actually returned by operation=read. Use [] for an initial publication. Source IDs and method-package/knowledge IDs must never appear here; source IDs belong in sourceIds.",
          },
          verdict: {
            type: "string",
            enum: [
              "accept",
              "support",
              "revise",
              "hold",
              "supported",
              "limited",
              "revision-required",
              "adopt",
              "decline",
            ],
          },
          to: { type: "string", enum: ["mentor", "lead", "reviewer", "librarian"] },
        },
        required: ["operation"],
      },
      async execute(callId, input, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
        try {
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw new Error("无效协作参数。");
          const parameters = input as Record<string, unknown>;
          if (
            ![
              "knowledge",
              "method-package",
              "method-read-image",
              "method-image-reading",
              "method-apply",
              "method-opinion",
              "method-adjudicate",
              "method-check",
              "status",
              "publish",
              "read",
              "message",
              "inputs",
              "source-search",
              "source-fetch",
              "source-read",
              "analyze",
              "read-analysis",
              "analysis-registry",
              "register-analysis",
              "run-analysis",
              "reuse-analysis",
              "read-registered-analysis",
              "review-analysis",
              "numeric-check",
              "numeric-bind",
              "numeric-render",
              "declare-result-field",
              "review-result-field",
              "numeric-candidate-review",
              "claim-context",
              "claim-register",
              "claim-review",
              "claim-check",
              ...RESEARCH_LITERATURE_TOOL_OPERATIONS,
              ...RESEARCH_LANGUAGE_OPERATIONS,
              ...SOURCE_PAGE_OPERATIONS,
              ...SYNTHESIS_OPERATIONS,
              ...RESEARCH_PATH_OPERATIONS,
              ...RESEARCH_SPECIALIST_OPERATIONS,
              ...RESEARCH_MEMBER_INPUT_OPERATIONS,
              "request-decision",
              "discussion-post",
            ].includes(String(parameters.operation))
          )
            throw new Error("无效协作操作。");
          const executionModel = actualModel(ctx);
          await applyRoute(ctx);
          const result = await invoke(ctx, callId, { ...parameters, executionModel });
          const nextStage = await applyRoute(ctx);
          return researchGroupToolResult(parameters.operation, result, nextStage);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message }],
            details: { error: message },
            isError: true,
          };
        }
      },
    };
    pi.registerTool(tool);
  };
}
