import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import type { RegisteredResearchAnalysisRun } from "../../contracts/research-analysis-registry";
import { decodeRegisteredResearchAnalysisPlan } from "../../contracts/research-analysis-registry";
import type { ResearchAnalysisRun } from "../../contracts/research-evidence";
import {
  createResearchAnalysisRegistry,
  executeRegisteredResearchAnalysis,
  recordRegisteredAnalysisReview,
  registerResearchAnalysisPlan,
  researchAnalysisRegistryReport,
} from "./analysis-registry";
import {
  captureAnalysisNativeContext,
  recordAnalysisOperationReceipt,
  recordAnalysisReviewContext,
  reuseRegisteredResearchAnalysis,
  hasCurrentAnalysisRead,
  evaluateAnalysisReuse,
  registeredAnalysisReplayScript,
  verifyAnalysisResultFiles,
} from "./analysis-result-reuse";
import { isCurrentResearchAnalysis } from "./paper-pipeline";
import { readPinnedResearchFile, researchHash } from "./materials";
import { activeFusionAttempt, attachFusionAnalysisInput } from "./fusion-task-runtime";
import { applyResearchChange, attachResearchTaskInput, setResearchInput } from "./task-graph";

export const REGISTERED_ANALYSIS_OPERATIONS = [
  "analysis-registry",
  "register-analysis",
  "run-analysis",
  "reuse-analysis",
  "read-registered-analysis",
  "review-analysis",
] as const;
const digest = (value: unknown) => researchHash(JSON.stringify(value));
const stableId = (projectId: string, callId: string) => {
  const hash = createHash("sha256").update(`${projectId}:${callId}`).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};
function assertCurrentAnalysisToolAttempt(p: ResearchProject, role: ResearchRole): void {
  const attempt = activeFusionAttempt(p, role),
    task = p.fusion?.tasks.find((entry) => entry.id === attempt?.taskId);
  if (
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    attempt.taskVersion !== task.inputVersion ||
    !task.id.startsWith(`v${p.revision}:`)
  )
    throw new Error("任务输入已变化或原生请求已结束；旧尝试不能登记、采用或审阅当前分析计划。");
}
const runView = (run: RegisteredResearchAnalysisRun) => ({
  ...run,
  sample: {
    ...run.sample,
    selectedSourceLines: run.sample.selectedSourceLines.slice(0, 100),
    completeSourceLines: run.sample.completeSourceLines.slice(0, 100),
    perVariableSourceLines: Object.fromEntries(
      Object.entries(run.sample.perVariableSourceLines).map(([key, lines]) => [
        key,
        lines.slice(0, 100),
      ]),
    ),
    missing: run.sample.missing.slice(0, 100),
    excluded: run.sample.excluded.slice(0, 100),
  },
  sampleCounts: {
    selected: run.sample.selectedSourceLines.length,
    complete: run.sample.completeSourceLines.length,
    missing: run.sample.missing.length,
    excluded: run.sample.excluded.length,
  },
  notice: "实际行定位每类只展示前100项；完整记录在项目归档。同引擎复跑不是独立算法或内容审阅。",
});

/** Called only within the coordinator's durable mutation. A model cannot supply an actual input. */
export function adoptRegisteredAnalysisPlanInput(
  p: ResearchProject,
  planId: string,
  version: number,
  at: string,
): void {
  if (!p.fusion || !p.analysisRegistry) return;
  const plan = p.analysisRegistry.plans.find(
    (entry) => entry.id === planId && entry.version === version,
  );
  if (!plan) throw new Error("分析计划版本未登记。");
  if (p.analysisRegistry.plans.filter((entry) => entry.id === planId).at(-1)?.version !== version)
    throw new Error("旧计划版本不能重新采用为当前输入。");
  const contentDigest = digest(plan);
  // The accepted design records what was planned at that time. A later analysis-stage
  // amendment changes execution and downstream review without rewriting that baseline.
  const inputIds = [
    `analysis-plan:${plan.id}`,
    ...(p.currentStage === "design" ? [`design-plan:${plan.id}`] : []),
  ];
  let changed = false;
  for (const inputId of inputIds) {
    const old = p.fusion.inputs.filter((entry) => entry.inputId === inputId).at(-1);
    if (old?.digest === contentDigest) continue;
    changed = true;
    const inputVersion = (old?.version ?? 0) + 1;
    const designSnapshot = inputId.startsWith("design-plan:");
    p.fusion = setResearchInput(p.fusion, {
      inputId,
      version: inputVersion,
      kind: "context",
      actual: false,
      availability: "available",
      label: designSnapshot ? `设计阶段计划快照：${plan.label}` : plan.label,
      sourceRef: plan.registration.sourceRef,
      digest: contentDigest,
    });
    p.fusion = applyResearchChange(p.fusion, {
      id: `adopt:${inputId}:${inputVersion}`,
      at,
      inputId,
      fromVersion:
        p.fusion.adoptedInputs.find((entry) => entry.inputId === inputId)?.version ?? null,
      toVersion: inputVersion,
      reason: designSnapshot
        ? "固定本次设计实际采用的计划版本；后续分析修改另存。"
        : "采用有版本的结构化分析计划；保留旧计划和实际结果。",
      authorizedBy: "existing-authorization",
      authorizationRef: plan.registration.sourceRef,
      additionalTaskIds: designSnapshot
        ? []
        : p.fusion.tasks
            .filter(
              (task) =>
                task.id.startsWith(`v${p.revision}:`) &&
                (["writing", "audit"].includes(task.stage) ||
                  (task.stage === "analysis" && !!task.currentArtifactId)),
            )
            .map((task) => task.id),
    });
  }
  if (!changed) return;
  if (p.finalPaper) {
    (p.supersededExports ??= []).push({
      files: p.finalPaper,
      at,
      reason: "采用的分析计划发生变化，需要对当前版本重新审阅。",
    });
    p.finalPaper = undefined;
  }
}
export function attachRegisteredAnalysisPlanInput(
  p: ResearchProject,
  role: ResearchRole,
  planId: string,
  version: number,
  at: string,
  evidenceRef: string,
): void {
  adoptRegisteredAnalysisPlanInput(p, planId, version, at);
  const attempt = activeFusionAttempt(p, role),
    inputId = `${p.currentStage === "design" ? "design-plan" : "analysis-plan"}:${planId}`,
    ref = p.fusion?.adoptedInputs.find((entry) => entry.inputId === inputId);
  if (!attempt || !p.fusion || !ref) throw new Error("实际计划使用需要当前任务执行尝试。");
  p.fusion = attachResearchTaskInput(p.fusion, attempt.id, ref, { at, evidenceRef });
}

function independentAnalysisJudgmentPublished(p: ResearchProject, role: ResearchRole): boolean {
  if (role !== "lead" && role !== "reviewer") return true;
  const active = activeFusionAttempt(p, role);
  const stage = p.fusion?.tasks.find((task) => task.id === active?.taskId)?.stage ?? p.currentStage;
  return p.artifacts.some((artifact) => {
    if (
      artifact.role !== role ||
      artifact.revision !== p.revision ||
      artifact.stage !== stage ||
      artifact.kind !== (role === "lead" ? "stage-draft" : "stage-risk")
    )
      return false;
    const record = p.fusion?.artifacts.find((item) => item.id === artifact.id);
    const task = p.fusion?.tasks.find((item) => item.id === record?.taskId);
    const attempt = p.fusion?.attempts.find((item) => item.id === record?.attemptId);
    return (
      !!record &&
      !!task &&
      !!attempt &&
      task.role === role &&
      task.stage === stage &&
      task.id.startsWith(`v${p.revision}:`) &&
      task.inputVersion === record.taskVersion &&
      attempt.taskId === task.id &&
      attempt.taskVersion === record.taskVersion &&
      !!attempt.nativeRunId &&
      record.content === artifact.content &&
      record.createdAt === artifact.createdAt &&
      !["superseded", "needs-review"].includes(record.reviewState)
    );
  });
}

/** No role is reserved for internal/UI callers; every native tool response passes its host-owned role. */
export function registeredAnalysisStatus(p: ResearchProject, role?: ResearchRole) {
  const original = p.analysisRegistry ?? createResearchAnalysisRegistry();
  const ownOnly = role !== undefined && !independentAnalysisJudgmentPublished(p, role);
  const registry = ownOnly
    ? {
        ...original,
        reviews: original.reviews.filter((review) => review.actor === `model:${role}`),
      }
    : original;
  return {
    activePlans: p.activeAnalysisPlans ?? [],
    plans: registry.plans,
    report: researchAnalysisRegistryReport(registry, p.evidence?.datasets ?? []),
    runs: registry.runs.map((run) => ({
      id: run.id,
      planId: run.planId,
      planVersion: run.planVersion,
      actor: run.actor,
      at: run.at,
      verification: run.verification,
      resultSha256: run.resultSha256,
      current: !!p.analyses?.some(
        (projection) => projection.id === run.id && isCurrentResearchAnalysis(p, projection),
      ),
      ...(role ? { reuse: evaluateAnalysisReuse(p, role, run.id) } : {}),
    })),
    reviews: registry.reviews,
    reviewVisibility:
      role === undefined
        ? "internal-unfiltered"
        : ownOnly
          ? "own-until-independent-draft"
          : "peer-review-open",
    notice:
      "计划登记不等于执行。事后变化保持事后标记；工具未支持的方法/输出不能以替代结果冒充完成。",
  };
}

/** Mutates only the owner's draft; files are immutable and written before aggregate state is saved. */
export async function applyRegisteredAnalysisTool(
  p: ResearchProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Promise<{ result: unknown; detail?: string; analysisId?: string }> {
  if (p.workflowVersion !== "fusion-v2")
    throw new Error("多项分析登记仅适用于融合流程，旧研究记录保留原方式。");
  const registry = p.analysisRegistry ?? createResearchAnalysisRegistry(),
    id = stableId(p.id, callId);
  if (input.operation === "analysis-registry") return { result: registeredAnalysisStatus(p, role) };
  if (input.operation !== "read-registered-analysis") assertCurrentAnalysisToolAttempt(p, role);
  if (input.operation === "register-analysis") {
    if (
      !["lead", "mentor"].includes(role) ||
      !["design", "analysis"].includes(p.currentStage ?? "")
    )
      throw new Error("请由设计或分析阶段的 A/导师登记计划。");
    const raw = input.plan;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("请提供结构化 plan。");
    const { registrationReason, timing, ...fields } = raw as Record<string, unknown>;
    if (
      typeof registrationReason !== "string" ||
      !registrationReason.trim() ||
      !["prospective", "post-hoc"].includes(String(timing)) ||
      "registration" in fields
    )
      throw new Error(
        "计划需说明 registrationReason 和 timing；时间与出处由宿主登记，不能自填 registration。",
      );
    const supplied = decodeRegisteredResearchAnalysisPlan({
        ...fields,
        registration: {
          at,
          timing,
          reason: registrationReason,
          sourceRef: `tool:${callId}`,
        },
      }),
      previous = registry.plans.find((plan) => plan.registration.sourceRef === `tool:${callId}`),
      dataset = p.evidence?.datasets.find((item) => item.id === supplied.dataset.id);
    if (supplied.dataset.sha256 && dataset && supplied.dataset.sha256 !== dataset.sha256)
      throw new Error("计划数据摘要不是当前已采用材料；请核对 inputs。");
    const hasResults = !!(registry.runs.length || p.analyses?.length);
    const plan = decodeRegisteredResearchAnalysisPlan({
      ...supplied,
      dataset: {
        id: supplied.dataset.id,
        ...(dataset
          ? { sha256: dataset.sha256 }
          : supplied.dataset.sha256
            ? { sha256: supplied.dataset.sha256 }
            : {}),
      },
      registration: {
        ...supplied.registration,
        at: previous?.registration.at ?? at,
        sourceRef: `tool:${callId}`,
        timing:
          previous?.registration.timing ??
          (hasResults || timing === "post-hoc" ? "post-hoc" : "prospective"),
      },
    });
    p.analysisRegistry = registerResearchAnalysisPlan(registry, plan);
    if (previous)
      return {
        result: { plan: previous, duplicate: true, status: registeredAnalysisStatus(p, role) },
      };
    p.activeAnalysisPlans = [
      ...(p.activeAnalysisPlans ?? []).filter((item) => item.id !== plan.id),
      { id: plan.id, version: plan.version },
    ];
    adoptRegisteredAnalysisPlanInput(p, plan.id, plan.version, at);
    return {
      result: {
        plan,
        status: registeredAnalysisStatus(p, role),
        timingAuthority: "host-observed-registration-time",
      },
      detail: `登记${plan.purpose}分析 ${plan.id} v${plan.version}（${plan.registration.timing}），尚不代表执行或审阅。`,
    };
  }
  if (input.operation === "reuse-analysis") {
    if (
      Object.keys(input).some(
        (key) => !["operation", "analysisId", "reason", "executionModel"].includes(key),
      ) ||
      typeof input.analysisId !== "string" ||
      typeof input.reason !== "string"
    )
      throw new Error("显式复用仅接受 analysisId 和 reason；执行身份由宿主固定。");
    const context = captureAnalysisNativeContext(p, role);
    const adoption = await reuseRegisteredResearchAnalysis(
      p,
      context,
      callId,
      input.analysisId,
      input.reason,
      at,
    );
    for (const plan of adoption.pin.plans)
      attachRegisteredAnalysisPlanInput(
        p,
        role,
        plan.id,
        plan.version,
        at,
        `reuse-analysis:${adoption.id}`,
      );
    attachFusionAnalysisInput(p, role, adoption.pin.datasetId, at, `reuse-analysis:${adoption.id}`);
    return {
      result: {
        adoption,
        validForCurrentInputs: true,
        notice:
          "明确采用原实际计算，不是新实算/复跑，也不恢复旧读取或解释意见。请实际读取后重新审阅。",
      },
      analysisId: adoption.pin.runId,
      detail: `显式采用未变分析 ${adoption.pin.runId}，保留原计算与归档。`,
    };
  }
  if (input.operation === "read-registered-analysis") {
    const run = registry.runs.find((entry) => entry.id === input.analysisId);
    if (!run) throw new Error("实际登记运行不存在。");
    const current =
      !!p.analyses?.some(
        (projection) => projection.id === run.id && isCurrentResearchAnalysis(p, projection),
      ) &&
      (researchAnalysisRegistryReport(registry, p.evidence?.datasets ?? [])
        .find((item) => item.planId === run.planId && item.planVersion === run.planVersion)
        ?.runIds.includes(run.id) ??
        false);
    if (current) {
      assertCurrentAnalysisToolAttempt(p, role);
      const context = captureAnalysisNativeContext(p, role);
      await verifyAnalysisResultFiles(p, run.id);
      attachRegisteredAnalysisPlanInput(
        p,
        role,
        run.planId,
        run.planVersion,
        at,
        `read-analysis:${run.id}`,
      );
      attachFusionAnalysisInput(p, role, run.datasetId, at, `read-analysis:${run.id}`);
      await recordAnalysisOperationReceipt(
        p,
        context,
        callId,
        "read-registered-analysis",
        run.id,
        at,
      );
    }
    return {
      result: { ...runView(run), validForCurrentInputs: current },
      detail: `读取${current ? "当前" : "历史"}登记分析 ${run.id}`,
      analysisId: run.id,
    };
  }
  if (input.operation === "review-analysis") {
    if (!["reviewer", "mentor"].includes(role))
      throw new Error("分析审阅由 B/导师的真实会话提交。");
    if (typeof input.planId !== "string" || !Number.isSafeInteger(input.planVersion))
      throw new Error("审阅需要明确计划版本。");
    const runId = typeof input.analysisId === "string" ? input.analysisId : undefined;
    const context = captureAnalysisNativeContext(p, role);
    if (runId && !hasCurrentAnalysisRead(p, role, runId))
      throw new Error("请先实际读取该运行，不能直接自报已复核或借旧读取复活意见。");
    p.analysisRegistry = recordRegisteredAnalysisReview(registry, {
      id,
      planId: input.planId,
      planVersion: input.planVersion as number,
      ...(runId ? { runId } : {}),
      kind: runId ? "interpretation-review" : "plan-review",
      at: registry.reviews.find((review) => review.id === id)?.at ?? at,
      actor: `model:${role}`,
      verdict: input.verdict as "accept" | "revise" | "hold",
      evidenceRef: `tool:${callId}`,
      note: typeof input.content === "string" ? input.content : "",
    });
    if (runId) {
      const review = p.analysisRegistry.reviews.find((entry) => entry.id === id)!;
      recordAnalysisReviewContext(p, context, callId, id, review.at);
    }
    return {
      result: p.analysisRegistry.reviews.find((review) => review.id === id),
      detail: `模型 ${role} 提交分析计划/解释审阅，不是人类专家确认。`,
    };
  }
  if (
    input.operation !== "run-analysis" ||
    p.currentStage !== "analysis" ||
    !["lead", "reviewer"].includes(role)
  )
    throw new Error("只有分析阶段的 A/B 能执行登记分析。");
  if (typeof input.planId !== "string" || !Number.isSafeInteger(input.planVersion))
    throw new Error("请引用明确的 planId/planVersion。");
  const plan = registry.plans.find(
    (entry) => entry.id === input.planId && entry.version === input.planVersion,
  );
  if (
    !plan ||
    !(p.activeAnalysisPlans ?? []).some(
      (entry) => entry.id === plan.id && entry.version === plan.version,
    )
  )
    throw new Error("此计划不是本轮采用的明确版本。");
  const context = captureAnalysisNativeContext(p, role);
  const existing = registry.runs.find((run) => run.id === id);
  if (existing) {
    if (
      existing.planId !== plan.id ||
      existing.planVersion !== plan.version ||
      (existing.verification.level === "same-engine-replay"
        ? existing.verification.replayOf
        : undefined) !== input.replayOf
    )
      throw new Error("工具调用身份已用于不同分析。");
    await recordAnalysisOperationReceipt(p, context, callId, "run-analysis", existing.id, at);
    return { result: runView(existing), analysisId: existing.id };
  }
  const dataset = p.evidence?.datasets.find((entry) => entry.id === plan.dataset.id);
  if (!dataset) throw new Error("没有实际数据，计划不能登记为实算完成。");
  if (typeof input.replayOf === "string") {
    const original = p.analyses?.find((entry) => entry.id === input.replayOf);
    if (!original || !isCurrentResearchAnalysis(p, original))
      throw new Error("复跑对象不是当前有效原运行；历史读取不能授权新复跑。");
    await verifyAnalysisResultFiles(p, original.id);
  }
  const csv = await readPinnedResearchFile(dataset, 10_000_000);
  attachRegisteredAnalysisPlanInput(p, role, plan.id, plan.version, at, `run-analysis:${id}`);
  attachFusionAnalysisInput(p, role, dataset.id, at, `run-analysis:${id}`);
  const attempt = activeFusionAttempt(p, role),
    task = p.fusion?.tasks.find((entry) => entry.id === attempt?.taskId);
  if (
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    attempt.taskVersion !== task.inputVersion ||
    task.stage !== "analysis"
  )
    throw new Error("实际分析需要当前输入版本的原生分析尝试。");
  const execution = executeRegisteredResearchAnalysis(registry, {
    id,
    planId: plan.id,
    planVersion: plan.version,
    at,
    actor: `model:${role}`,
    dataset: { id: dataset.id, sha256: dataset.sha256, delimiter: dataset.delimiter },
    csv,
    ...(typeof input.replayOf === "string" ? { replayOf: input.replayOf } : {}),
  });
  const run = execution.run,
    directory = join(p.workspacePath, ".lancer", "research-groups", p.id, "analysis", id);
  const script = registeredAnalysisReplayScript();
  const projection: ResearchAnalysisRun = {
    id,
    revision: p.revision,
    role,
    createdAt: at,
    spec: run.spec,
    datasetSha256: run.datasetSha256,
    taskId: task.id,
    taskInputVersion: task.inputVersion,
    attemptId: attempt.id,
    engine: run.engine,
    replayScriptSha256: researchHash(script),
    result: run.result,
    sha256: run.resultSha256,
    file: join(directory, "result.json"),
  };
  await mkdir(directory, { recursive: true });
  for (const [name, body] of [
    ["input.csv", csv],
    ["calculation-input.csv", execution.calculationInput],
    ["plan.json", JSON.stringify(plan, null, 2)],
    ["registered-run.json", JSON.stringify(run, null, 2)],
    ["result.json", JSON.stringify(projection, null, 2)],
  ])
    await writeFile(join(directory, name!), body!, { flag: "wx" });
  await writeFile(join(directory, "replay.mjs"), script, { flag: "wx" });
  p.analysisRegistry = execution.registry;
  (p.analyses ??= []).push(projection);
  await recordAnalysisOperationReceipt(p, context, callId, "run-analysis", id, at);
  return {
    result: { ...runView(run), file: projection.file, validForCurrentInputs: true },
    analysisId: id,
    detail: `实际执行登记分析 ${plan.id} v${plan.version}：${run.sample.completeSourceLines.length}/${run.sample.originalDataRows} 完整案例；${run.verification.level}。`,
  };
}
