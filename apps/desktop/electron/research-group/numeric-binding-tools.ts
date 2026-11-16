import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ResearchArtifact,
  ResearchProject,
  ResearchRole,
} from "../../contracts/research-group";
import type { RegisteredResearchAnalysisRun } from "../../contracts/research-analysis-registry";
import {
  decodeResearchNumericBindingRequest,
  decodeResearchNumericCandidateReviewInput,
  decodeResearchNumericPath,
  decodeResearchResultFieldMetadata,
  type ResearchNumericBinding,
  type ResearchNumericCandidateReview,
  type ResearchNumericQuantity,
  type ResearchResultFieldMetadata,
} from "../../contracts/research-numeric-bindings";
import { activeFusionAttempt, fusionRoleStage } from "./fusion-task-runtime";
import { isCurrentResearchAnalysis, isCurrentResearchArtifact } from "./paper-pipeline";
import {
  hasCurrentAnalysisRead,
  verifyAnalysisResultFiles,
  type AnalysisReuseProject,
} from "./analysis-result-reuse";
import {
  createResearchAnalysisRegistry,
  researchAnalysisRegistryReport,
} from "./analysis-registry";
import {
  createResearchNumericArtifactSnapshot,
  createResearchNumericBinding,
  createResearchNumericCandidateReview,
  renderResearchNumericValue,
  validateResearchNumericBindings,
  type ResearchNumericBindingContext,
} from "./numeric-bindings";

export type NumericProject = ResearchProject &
  AnalysisReuseProject & {
    numericBindings?: ResearchNumericBinding[];
    numericFieldMetadata?: ResearchResultFieldMetadata[];
    numericCandidateReviews?: ResearchNumericCandidateReview[];
  };
export const NUMERIC_BINDING_OPERATIONS = [
  "numeric-check",
  "numeric-bind",
  "numeric-render",
  "declare-result-field",
  "review-result-field",
  "numeric-candidate-review",
] as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const stableId = (p: NumericProject, role: ResearchRole, callId: string) =>
  `numeric:${hash(`${p.id}:${role}:${callId}`).slice(0, 40)}`;
const text = (value: unknown, name: string, max = 6000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error(`${name}需要非空有界文本。`);
  return value;
};
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("数值操作含未知字段；实际运行、身份、摘要、状态和出处由宿主生成。");
  return value as Record<string, unknown>;
}
function roleScope(p: NumericProject, role: ResearchRole) {
  const attempt = activeFusionAttempt(p, role),
    task = p.fusion?.tasks.find((item) => item.id === attempt?.taskId);
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    !["lead", "reviewer", "mentor"].includes(role) ||
    !p.members.some((member) => member.role === role) ||
    !attempt ||
    attempt.state !== "running" ||
    !task ||
    task.inputVersion !== attempt.taskVersion ||
    !task.id.startsWith(`v${p.revision}:`) ||
    !["analysis", "writing", "audit"].includes(task.stage)
  )
    throw new Error("数值操作需要当前输入版本、分析/写作/审计阶段的 A/B/导师实际执行尝试。");
  return { attempt, task };
}
function currentArtifact(p: NumericProject, role: ResearchRole, id: unknown): ResearchArtifact {
  const { task } = roleScope(p, role),
    artifactId = text(id, "artifactId", 512);
  const matches = p.artifacts.filter((artifact) => artifact.id === artifactId),
    artifact = matches[0];
  const pinned = p.fusion?.artifacts.find((item) => item.id === artifactId),
    producer = p.fusion?.tasks.find((item) => item.id === pinned?.taskId);
  if (
    matches.length !== 1 ||
    !artifact ||
    artifact.revision !== p.revision ||
    !isCurrentResearchArtifact(p, artifact) ||
    !pinned ||
    producer?.currentArtifactId !== artifact.id ||
    pinned.content !== artifact.content ||
    (role === "lead" && artifact.role !== "lead") ||
    !artifact.stage ||
    !["analysis", "writing", "audit"].includes(artifact.stage) ||
    (task.stage === "analysis" && artifact.stage !== "analysis") ||
    (task.stage === "writing" && artifact.stage === "audit")
  )
    throw new Error("稿件不是本角色范围内的当前不可变成果；旧稿保留，不能作为当前数值绑定目标。");
  if (
    !p.events.some(
      (event) =>
        event.type === "read" &&
        event.role === role &&
        event.revision === p.revision &&
        event.artifactId === artifact.id &&
        Date.parse(event.at) >= Date.parse(artifact.createdAt),
    )
  )
    throw new Error("请先实际 read 当前稿件；发布或声明已读不能代替读取记录。");
  return artifact;
}
function currentRun(p: NumericProject, id: unknown): RegisteredResearchAnalysisRun {
  const runId = text(id, "runId", 512),
    matches = p.analysisRegistry?.runs.filter((run) => run.id === runId) ?? [],
    run = matches[0];
  const projection = p.analyses?.find((item) => item.id === runId);
  if (
    matches.length !== 1 ||
    !run ||
    !projection ||
    !isCurrentResearchAnalysis(p, projection) ||
    !p.activeAnalysisPlans?.some(
      (plan) => plan.id === run.planId && plan.version === run.planVersion,
    ) ||
    !researchAnalysisRegistryReport(p.analysisRegistry!, p.evidence?.datasets ?? []).some(
      (report) =>
        report.planId === run.planId &&
        report.planVersion === run.planVersion &&
        report.state === "executed" &&
        report.runIds.includes(run.id),
    )
  )
    throw new Error("运行不存在、未实际采用或因数据/计划/任务版本变化而过期。");
  const { runSha256, ...contents } = run;
  const plan = p.analysisRegistry!.plans.find(
    (item) => item.id === run.planId && item.version === run.planVersion,
  );
  if (
    digest(contents) !== runSha256 ||
    digest(run.result) !== run.resultSha256 ||
    digest(plan) !== run.replay.planSha256 ||
    !isDeepStrictEqual(projection.result, run.result) ||
    projection.sha256 !== run.resultSha256
  )
    throw new Error("登记运行、计划或结果摘要不完整。");
  return run;
}
function requireAnalysisRead(
  p: NumericProject,
  role: ResearchRole,
  run: RegisteredResearchAnalysisRun,
) {
  if (!hasCurrentAnalysisRead(p, role, run.id))
    throw new Error(
      "请先实际 read-analysis/read-registered-analysis 当前运行；实际运行返回也可取得数字，旧事件或自报已读不算本次审阅。",
    );
}
function contextToken(p: NumericProject) {
  return digest({
    revision: p.revision,
    status: p.status,
    registry: p.analysisRegistry,
    adoptions: p.analysisRunAdoptions,
    actualReads: p.analysisReads,
    reviewContexts: p.analysisReviewContexts,
    active: p.activeAnalysisPlans,
    datasets: p.evidence?.datasets,
    artifacts: p.artifacts,
    fusion: p.fusion,
    metadata: p.numericFieldMetadata,
    bindings: p.numericBindings,
    reviews: p.numericCandidateReviews,
  });
}
async function actualContext(
  p: NumericProject,
  role: ResearchRole,
  artifacts: ResearchArtifact[],
  runIds: string[],
): Promise<ResearchNumericBindingContext> {
  roleScope(p, role);
  const token = contextToken(p),
    datasets: ResearchNumericBindingContext["currentDatasets"] = [];
  for (const id of [...new Set(runIds)]) {
    const run = currentRun(p, id);
    const dataset = p.evidence?.datasets.find((item) => item.id === run.datasetId);
    if (!dataset) throw new Error("当前实际数据不存在。");
    await verifyAnalysisResultFiles(p, run.id);
    if (!datasets.some((item) => item.id === dataset.id))
      datasets.push({ id: dataset.id, sha256: dataset.sha256 });
  }
  if (token !== contextToken(p))
    throw new Error("读取实际文件期间项目版本发生变化，请重新查看后操作。");
  roleScope(p, role);
  return {
    artifacts: artifacts.map((artifact) =>
      createResearchNumericArtifactSnapshot(artifact.id, artifact.content),
    ),
    registry: structuredClone(p.analysisRegistry ?? createResearchAnalysisRegistry()),
    currentDatasets: datasets,
    fieldMetadata: structuredClone(p.numericFieldMetadata ?? []),
    candidateReviews: structuredClone(p.numericCandidateReviews ?? []),
  };
}
function actualField(run: RegisteredResearchAnalysisRun, path: string[]) {
  let value: unknown = run.result;
  for (const key of decodeResearchNumericPath(path)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error("实际结果没有此字段。");
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("实际结果字段非有限数值或未定义，不能替换为0。");
  return value;
}
function builtinQuantity(path: string[]): ResearchNumericQuantity | undefined {
  if (JSON.stringify(path) === JSON.stringify(["regression", "rSquared"])) return "r-squared";
  if (
    (path.length === 2 && path[0] === "regression" && path[1] === "sampleSize") ||
    (path.length === 3 && path[0] === "descriptive" && path[2] === "n") ||
    (path.length === 1 && ["totalRows", "completeRows", "excludedRows"].includes(path[0]!))
  )
    return "sample-size";
  return undefined;
}
function metadataFor(
  context: ResearchNumericBindingContext,
  run: RegisteredResearchAnalysisRun,
  path: string[],
  metadataId: unknown,
  at: string,
) {
  if (metadataId !== undefined) {
    const id = text(metadataId, "fieldMetadataId", 512),
      metadata = context.fieldMetadata.find((item) => item.id === id);
    if (
      !metadata ||
      metadata.runId !== run.id ||
      metadata.runSha256 !== run.runSha256 ||
      !isDeepStrictEqual(metadata.path, path)
    )
      throw new Error("字段元数据不属于此实际运行字段。");
    return metadata;
  }
  const quantity = builtinQuantity(path);
  if (!quantity) throw new Error("该字段的单位不能推断；先声明单位并由B/导师审阅。");
  const id = `numeric-host:${digest({ run: run.runSha256, path }).slice(0, 40)}`;
  const existing = context.fieldMetadata.find((item) => item.id === id);
  if (existing) return existing;
  const metadata: ResearchResultFieldMetadata = {
    id,
    runId: run.id,
    runSha256: run.runSha256,
    path,
    quantity,
    unit: "",
    status: "verified",
    provenance: {
      actor: "host",
      actorId: "numeric-built-in-fields-1",
      at,
      sourceRef: `registered-result:${run.id}:${JSON.stringify(path)}`,
      note: "引擎明确的样本计数/R²为无量纲数值；不推断人数、物理单位或科学解释。",
    },
  };
  context.fieldMetadata.push(metadata);
  return metadata;
}
function preserveOrAppend<T extends { id: string }>(records: T[], record: T): T {
  const existing = records.find((item) => item.id === record.id);
  if (existing) {
    if (!isDeepStrictEqual(existing, record))
      throw new Error("同一工具调用身份已用于不同内容；不能覆盖旧记录。");
    return existing;
  }
  records.push(record);
  return record;
}
const fieldKeys = [
  "runId",
  "path",
  "fieldMetadataId",
  "quantity",
  "unit",
  "decimalPlaces",
  "rounding",
  "unitSeparator",
];

/** Called inside the coordinator's durable mutation; host owns role/callId/time and actual snapshots. */
export async function applyNumericBindingTool(
  p: NumericProject,
  role: ResearchRole,
  callId: string,
  raw: Record<string, unknown>,
  hostAt: string,
): Promise<{ result: unknown; detail?: string; analysisId?: string }> {
  text(callId, "实际工具调用身份", 512);
  if (!Number.isFinite(Date.parse(hostAt))) throw new Error("宿主时间无效。");
  roleScope(p, role);
  const operation = raw.operation,
    id = stableId(p, role, callId),
    sourceRef = `tool:${callId}:role:${role}:revision:${p.revision}`;
  const previousMetadata = p.numericFieldMetadata?.find((item) => item.id === id),
    previousBinding = p.numericBindings?.find((item) => item.id === id),
    previousReview = p.numericCandidateReviews?.find((item) => item.id === id);
  const at = previousMetadata?.provenance.at ?? previousReview?.provenance.at ?? hostAt;
  if (
    !NUMERIC_BINDING_OPERATIONS.includes(operation as (typeof NUMERIC_BINDING_OPERATIONS)[number])
  )
    throw new Error("未知数值绑定操作。");
  if (
    (previousMetadata &&
      !["declare-result-field", "review-result-field"].includes(String(operation))) ||
    (previousBinding && operation !== "numeric-bind") ||
    (previousReview && operation !== "numeric-candidate-review")
  )
    throw new Error("工具调用身份已用于另一类数值操作。");
  if (operation === "declare-result-field" || operation === "review-result-field") {
    fields(
      raw,
      operation === "declare-result-field"
        ? ["operation", "runId", "path", "quantity", "unit", "content"]
        : ["operation", "metadataId", "content"],
    );
    const origin =
      operation === "review-result-field"
        ? p.numericFieldMetadata?.find((item) => item.id === raw.metadataId)
        : undefined;
    if (operation === "review-result-field" && (!["reviewer", "mentor"].includes(role) || !origin))
      throw new Error("只有B/导师可以审阅已存在的字段元数据。");
    const run = currentRun(p, origin?.runId ?? raw.runId),
      path = origin?.path ?? decodeResearchNumericPath(raw.path);
    requireAnalysisRead(p, role, run);
    actualField(run, path);
    const quantity = origin?.quantity ?? raw.quantity;
    const knownQuantity =
      builtinQuantity(path) ??
      (path.length === 3 && path[0] === "regression" && path[1] === "coefficients"
        ? "coefficient"
        : undefined);
    if (knownQuantity && quantity !== knownQuantity)
      throw new Error("字段数量身份必须与实际n、R²或系数字段一致。");
    const context = await actualContext(p, role, [], [run.id]);
    const metadata: ResearchResultFieldMetadata = {
      id,
      runId: run.id,
      runSha256: run.runSha256,
      path,
      quantity: origin?.quantity ?? (raw.quantity as ResearchNumericQuantity),
      unit: origin?.unit ?? (raw.unit as string),
      status: origin ? "verified" : "declared",
      provenance: {
        actor: "model",
        actorId: `model:${role}`,
        at,
        sourceRef: origin ? `${sourceRef}:review-of:${origin.id}` : sourceRef,
        note: text(raw.content, "单位声明/语义审阅理由"),
        stage: fusionRoleStage(p, role) ?? p.currentStage,
      },
    };
    if (origin && origin.runSha256 !== run.runSha256)
      throw new Error("原声明已不属于当前运行版本。");
    decodeResearchResultFieldMetadata([metadata]);
    const result = preserveOrAppend(context.fieldMetadata, metadata);
    p.numericFieldMetadata = context.fieldMetadata;
    return {
      result: {
        metadata: result,
        boundary:
          "模型单位审阅保留实际身份；verified仅是有出处的语义审阅，不是物理含义由程序证明。",
      },
      analysisId: run.id,
      detail: `模型 ${role} ${origin ? "审阅" : "声明"}实际结果字段单位，保留原记录。`,
    };
  }
  if (operation === "numeric-check" || operation === "numeric-candidate-review") {
    fields(
      raw,
      operation === "numeric-check"
        ? ["operation", "artifactId"]
        : ["operation", "artifactId", "start", "end", "classification", "reason"],
    );
    if (operation === "numeric-candidate-review" && !["reviewer", "mentor"].includes(role))
      throw new Error("疑似数字的语义排除由B/导师在实际读稿后记录。");
    const artifact = currentArtifact(p, role, raw.artifactId),
      bindings = (p.numericBindings ?? []).filter((binding) => binding.artifactId === artifact.id);
    const context = await actualContext(
      p,
      role,
      [artifact],
      bindings.map((binding) => binding.runId),
    );
    if (operation === "numeric-check") {
      const report = validateResearchNumericBindings(context, bindings);
      return {
        result: {
          artifactId: artifact.id,
          bodySha256: context.artifacts[0]!.bodySha256,
          deterministic: { checks: report.checks, blockers: report.blockers },
          semantic: {
            unbound: report.unbound,
            reviewedNonResults: report.reviewedNonResults,
            candidateReviewChecks: report.candidateReviewChecks,
            boundary: report.candidateReviewBoundary,
          },
          blocksFormalAcceptance: report.blocksFormalAcceptance,
          requiresContentReview: report.requiresContentReview,
          boundary: report.boundary,
        },
      };
    }
    const input = decodeResearchNumericCandidateReviewInput({
      id,
      start: raw.start,
      end: raw.end,
      classification: raw.classification,
      reason: raw.reason,
    });
    const review = createResearchNumericCandidateReview(context.artifacts[0]!, input, {
      actor: "model",
      actorId: `model:${role}`,
      at,
      sourceRef,
    });
    const reviews = context.candidateReviews ?? [];
    const result = preserveOrAppend(reviews, review);
    p.numericCandidateReviews = reviews;
    return {
      result: {
        review: result,
        boundary: "仅排除同稿同片段的词法候选；真实绑定错误仍阻断。模型审阅不冒称人类核验。",
      },
      detail: `模型 ${role} 逐项复核当前稿件数字候选。`,
    };
  }
  fields(
    raw,
    operation === "numeric-bind" ? ["operation", "binding"] : ["operation", ...fieldKeys],
  );
  const supplied =
    operation === "numeric-bind"
      ? fields(raw.binding, ["artifactId", "start", "end", ...fieldKeys])
      : raw;
  const artifact =
    operation === "numeric-bind" ? currentArtifact(p, role, supplied.artifactId) : undefined;
  const run = currentRun(p, supplied.runId),
    path = decodeResearchNumericPath(supplied.path);
  requireAnalysisRead(p, role, run);
  const value = actualField(run, path),
    context = await actualContext(p, role, artifact ? [artifact] : [], [run.id]);
  const metadata = metadataFor(context, run, path, supplied.fieldMetadataId, at);
  const request = decodeResearchNumericBindingRequest({
    id,
    artifactId: artifact?.id ?? "numeric-render-preview",
    start: artifact ? supplied.start : 0,
    end: artifact ? supplied.end : 1,
    runId: run.id,
    path,
    fieldMetadataId: metadata.id,
    quantity: supplied.quantity,
    unit: supplied.unit,
    decimalPlaces: supplied.decimalPlaces,
    rounding: supplied.rounding,
    unitSeparator: supplied.unitSeparator,
  });
  if (operation === "numeric-render") {
    const renderedText =
      renderResearchNumericValue(value, request.decimalPlaces, request.rounding) +
      (request.unit ? request.unitSeparator + request.unit : "");
    const preview = createResearchNumericArtifactSnapshot(request.artifactId, renderedText);
    const projected: ResearchNumericBinding = {
      ...request,
      end: renderedText.length,
      exactText: renderedText,
      bodySha256: preview.bodySha256,
      runSha256: run.runSha256,
      fieldMetadataSha256: digest(metadata),
    };
    const report = validateResearchNumericBindings({ ...context, artifacts: [preview] }, [
      projected,
    ]);
    return {
      result: {
        renderedText,
        metadata,
        metadataPersisted: !!p.numericFieldMetadata?.some((item) => item.id === metadata.id),
        bindingFields: {
          runId: run.id,
          path,
          ...(supplied.fieldMetadataId === undefined ? {} : { fieldMetadataId: metadata.id }),
          quantity: request.quantity,
          unit: request.unit,
          decimalPlaces: request.decimalPlaces,
          rounding: request.rounding,
          unitSeparator: request.unitSeparator,
        },
        deterministicBlockers: report.blockers,
        tableSuggestion: {
          fieldPath: path,
          value: renderedText,
          unit: request.unit,
          runId: run.id,
        },
        insertion: "只读建议；不会修改稿件。插入后必须对实际新稿创建绑定并重审。",
        boundary: report.boundary,
      },
    };
  }
  const binding = createResearchNumericBinding(context, request),
    bindings = structuredClone(p.numericBindings ?? []);
  const result = preserveOrAppend(bindings, binding);
  const sameArtifact = bindings.filter((item) => item.artifactId === binding.artifactId);
  if (validateResearchNumericBindings(context, sameArtifact).blockers.length)
    throw new Error("新绑定与当前稿的其他绑定存在错误或重叠，不能保存。");
  p.numericFieldMetadata = context.fieldMetadata;
  p.numericBindings = bindings;
  return {
    result: {
      binding: result,
      boundary: "仅绑定此不可变稿件片段；正式接受仍需宿主数值检查和内容审阅。",
    },
    analysisId: run.id,
    detail: `模型 ${role} 绑定当前稿件的实际计算字段。`,
  };
}
