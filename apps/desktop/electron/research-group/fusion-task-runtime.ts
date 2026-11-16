import { settleResearchUsage } from "../../contracts/research-usage";
import type { NewResearchDecisionRequest, ResearchDecisionAnswer } from "./task-graph";
import type {
  ResearchAnalysisBinding,
  ResearchAnalysisSpec,
} from "../../contracts/research-evidence";
import { researchAnalysisMatchesPlan } from "./paper-pipeline";
import { researchExecutionRoute } from "../../contracts/research-method";
import { createHash } from "node:crypto";
import { currentResearchTaskScope } from "./research-task-scope";
import type { SessionTokenCounts } from "@lancer/session-driver";
import {
  RESEARCH_ROLES,
  isResearchStageId,
  researchStages,
  type ResearchArtifact,
  type ResearchProject,
  type ResearchRole,
  type ResearchStageId,
} from "../../contracts/research-group";
import {
  decodeResearchTaskGraph,
  type ResearchTaskAttempt,
  type ResearchAttemptResolution,
  type ResearchTaskRetryRequest,
} from "../../contracts/research-task-graph";
import {
  addResearchTask,
  requestResearchDecision,
  answerResearchDecision,
  resolveResearchAttempt,
  requestResearchTaskRetry,
  attachResearchTaskInput,
  attachResearchTaskArtifact,
  applyResearchChange,
  createResearchTaskGraph,
  failResearchTask,
  finishResearchTaskAttempt,
  markResearchTaskDispatched,
  publishResearchTaskResult,
  requestResearchTaskContinuation,
  researchTaskBlockers,
  researchTaskUsage,
  retryResearchTask,
  reviewResearchTaskArtifact,
  setResearchInput,
  startResearchTask,
} from "./task-graph";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const fusionTaskId = (p: ResearchProject, role: ResearchRole, stage = p.currentStage) =>
  `v${p.revision}:${stage ?? "question"}:${role}`;
/** Native identities stay attached across stage changes and process recovery. */
export function activeFusionAttempt(
  p: ResearchProject,
  role: ResearchRole,
  nativeRunId?: string,
): ResearchTaskAttempt | undefined {
  return p.fusion?.attempts
    .filter((a) => {
      const task = p.fusion!.tasks.find((t) => t.id === a.taskId);
      return (
        task?.role === role &&
        (nativeRunId
          ? a.nativeRunId === nativeRunId
          : ["prepared", "running", "unknown"].includes(a.state))
      );
    })
    .at(-1);
}
export function fusionRoleStage(
  p: ResearchProject,
  role: ResearchRole,
): ResearchStageId | undefined {
  const attempt = activeFusionAttempt(p, role);
  const stage = p.fusion?.tasks.find((t) => t.id === attempt?.taskId)?.stage;
  return isResearchStageId(stage) ? stage : undefined;
}
/** Called inside the owner's durable mutation, never from a renderer projection. */
export function ensureFusionStageTasks(p: ResearchProject, at: string): void {
  if (p.workflowVersion !== "fusion-v2") return;
  p.fusion ??= createResearchTaskGraph(p.id, p.methodVersion ?? "2.0.0");
  let graph = p.fusion;
  const register = (
    id: string,
    contentDigest: string,
    sourceRef: string,
    kind: "material" | "context",
    actual: boolean,
    available = true,
  ) => {
    const prior = graph.inputs.filter((i) => i.inputId === id).at(-1);
    if (prior?.digest === contentDigest) return prior;
    const input = {
      inputId: id,
      version: (prior?.version ?? 0) + 1,
      kind,
      actual,
      availability: available ? ("available" as const) : ("missing" as const),
      label: id,
      sourceRef,
      digest: contentDigest,
    };
    graph = setResearchInput(graph, input);
    graph = applyResearchChange(graph, {
      id: `adopt:${id}:${input.version}`,
      at,
      inputId: id,
      fromVersion: graph.adoptedInputs.find((i) => i.inputId === id)?.version ?? null,
      toVersion: input.version,
      reason: "接续已明确的课题输入及登记材料。",
      authorizedBy: "existing-authorization",
      authorizationRef: `project:${p.id}:revision:${p.revision}`,
      ...(id === "implementation-material" && prior
        ? {
            additionalTaskIds: graph.tasks
              .filter(
                (task) =>
                  task.id.startsWith(`v${p.revision}:`) &&
                  ["analysis", "writing", "audit"].includes(task.stage),
              )
              .map((task) => task.id),
          }
        : {}),
    });
    return input;
  };
  const objective = register("objective", digest(p.objective), `project:${p.id}`, "context", false);
  const method = p.sharedMethod
    ? register(
        "method-rules",
        digest(JSON.stringify(p.sharedMethod)),
        `project:${p.id}:method:${p.sharedMethod.version}`,
        "context",
        false,
      )
    : undefined;
  const path = register(
    "research-path",
    digest(p.path ?? "quantitative"),
    `project:${p.id}:path`,
    "context",
    false,
  );
  const sourceRefs = (p.evidence?.sources ?? []).map((source) =>
    register(`source:${source.id}`, source.sha256, source.file, "material", true),
  );
  const dataRefs = (p.evidence?.datasets ?? []).map((data) =>
    register(`dataset:${data.id}`, data.sha256, data.file, "material", true),
  );
  const implementation = register(
    "implementation-material",
    digest(JSON.stringify(dataRefs.map((d) => d.digest))),
    dataRefs.map((d) => d.sourceRef).join("; ") || "waiting-for-actual-material",
    "material",
    dataRefs.length > 0,
    dataRefs.length > 0,
  );
  const stage = researchStages(p).find((s) => s.id === p.currentStage);
  if (!stage) throw new Error("融合任务缺少有效方法阶段。");
  const stages = researchStages(p),
    previous = stages[stages.findIndex((s) => s.id === stage.id) - 1];
  const previousTaskId = previous ? fusionTaskId(p, "mentor", previous.id) : undefined;
  const route = researchExecutionRoute(p, p.entryInventory);
  for (const task of graph.tasks)
    task.continuations = task.continuations.filter(
      (c) =>
        !!c.attemptId ||
        !p.m3?.memberInputs?.some(
          (input) =>
            input.taskId === task.id &&
            input.taskVersion < task.inputVersion &&
            c.id === `member:${input.id}`,
        ),
    );
  for (const role of route.requiredRoles) {
    const id = fusionTaskId(p, role);
    if (graph.tasks.some((t) => t.id === id)) continue;
    const analysis =
      stage.id === "analysis" && role === "lead" && (p.path ?? "quantitative") === "quantitative";
    const materialRefs = analysis ? [implementation, ...dataRefs] : sourceRefs;
    graph = addResearchTask(graph, {
      id,
      stage: stage.id,
      role,
      kind: analysis ? "analysis" : stage.id === "design" ? "proposal" : "research",
      goal: stage.goal,
      inputs: [
        objective,
        ...(["search", "reading", "synthesis", "design", "analysis", "writing", "audit"].includes(
          stage.id,
        )
          ? [path]
          : []),
        ...(method ? [method] : []),
        ...materialRefs,
      ].map((i) => ({
        inputId: i.inputId,
        version: i.version,
        requirement: "available",
      })),
      dependencies:
        previousTaskId &&
        route.stageIds.some((id) => id === previous?.id) &&
        graph.tasks.some((t) => t.id === previousTaskId)
          ? [{ taskId: previousTaskId, requirement: "accepted" }]
          : [],
      earlyHandoff: "发布首批可定位成果后，其他成员可立即读取。",
      deliverable: stage.deliverables,
      reviewRequired: true,
      writeScope: [`artifacts/${stage.id}/${role}`],
    });
  }
  p.fusion = graph;
}

/** Entry inventory may move an unstarted task, but never erases its placeholder history. */
export function reconcileUnstartedFusionEntry(p: ResearchProject): void {
  if (
    !p.fusion ||
    p.fusion.attempts.some((attempt) => attempt.taskId.startsWith(`v${p.revision}:`))
  )
    return;
  const route = researchExecutionRoute(p, p.entryInventory);
  const reason = "实际材料清点重新定位入口；此占位任务未派发，保留记录。";
  for (const task of p.fusion.tasks.filter((task) => task.id.startsWith(`v${p.revision}:`))) {
    if (task.currentArtifactId) continue;
    const inScope =
      route.stageIds.some((stage) => stage === task.stage) &&
      route.requiredRoles.some((role) => role === task.role);
    if (!inScope && !["failed", "cancelled", "completed"].includes(task.state)) {
      task.state = "cancelled";
      task.error = reason;
    } else if (inScope && task.state === "cancelled" && task.error === reason) {
      task.state = "pending";
      delete task.error;
    }
  }
  p.fusion = decodeResearchTaskGraph(p.fusion);
}

/** Pure readiness check shared by dispatch and mailbox selection. */
export function fusionDeliveryBlockReason(
  p: ResearchProject,
  role: ResearchRole,
  prompt: string,
  taskIdOverride?: string,
): string | undefined {
  if (!p.fusion) return;
  if (p.goal === "task" && !!p.task && !currentResearchTaskScope(p))
    return "等待用户固定本轮材料、引用或章节的实际范围。";
  const existing = activeFusionAttempt(p, role),
    taskId = taskIdOverride ?? fusionTaskId(p, role);
  const task = p.fusion.tasks.find((t) => t.id === taskId);
  if (!task || task.role !== role || !task.id.startsWith(`v${p.revision}:`))
    throw new Error("恢复目标不属于当前版本的该成员任务。");
  if (existing) {
    if (existing.state === "unknown") return "外部请求结果未知，不能自动重放。";
    if (existing.taskId !== taskId) return "成员仍在完成上一阶段；在下一原生运行边界接续。";
    if (existing.taskVersion !== task.inputVersion)
      return "成员在途输入已过期，等待原请求结束后按新版本接续。";
    return;
  }
  if (task.state === "failed" || task.state === "cancelled")
    return task.error ?? "任务失败，需要明确恢复。";
  const blockers = researchTaskBlockers(p.fusion, taskId);
  if (blockers.length) return blockers.map((b) => b.reason).join(" ");
  const reservedTokens = Math.ceil(prompt.length / 2) + 4096;
  const roleTasks = p.fusion.tasks.filter((t) => t.role === role);
  const usage = roleTasks.map((t) => researchTaskUsage(p.fusion!, t.id));
  if (
    p.memberTokenBudget !== undefined &&
    usage.reduce((sum, u) => sum + u.knownTokens + u.reservedTokens, 0) + reservedTokens >
      p.memberTokenBudget
  )
    return "成员剩余额度不足以预留本次请求，未知用量仍保留预留。";
}

export function prepareFusionDelivery(
  p: ResearchProject,
  role: ResearchRole,
  id: string,
  at: string,
  prompt: string,
  taskIdOverride?: string,
): { kind: "dispatch" | "steer" | "blocked"; attemptId?: string; reason?: string } {
  ensureFusionStageTasks(p, at);
  if (!p.fusion) return { kind: "dispatch" };
  const reason = fusionDeliveryBlockReason(p, role, prompt, taskIdOverride);
  if (reason) return { kind: "blocked", reason };
  const existing = activeFusionAttempt(p, role);
  if (existing) return { kind: "steer", attemptId: existing.id };
  const taskId = taskIdOverride ?? fusionTaskId(p, role),
    task = p.fusion.tasks.find((t) => t.id === taskId)!;
  const reservedTokens = Math.ceil(prompt.length / 2) + 4096;
  if (task.state === "completed")
    p.fusion = requestResearchTaskContinuation(p.fusion, taskId, {
      id: `continuation:${id}`,
      at,
      reason: "新的协作交接或用户明确恢复要求继续本任务。",
    });
  const model = researchStages(p).find((s) => s.id === task.stage)?.models[role];
  p.fusion = startResearchTask(p.fusion, taskId, {
    id,
    at,
    reservedTokens,
    ...(model ? { model } : {}),
  });
  return { kind: "dispatch", attemptId: id };
}
export function dispatchFusionAttempt(p: ResearchProject, attemptId: string, at: string): void {
  if (p.fusion) p.fusion = markResearchTaskDispatched(p.fusion, attemptId, at);
}
export function bindFusionNativeRun(p: ResearchProject, role: ResearchRole, runId: string): void {
  const attempt = activeFusionAttempt(p, role);
  if (!attempt || !p.fusion) return;
  if (attempt.nativeRunId && attempt.nativeRunId !== runId)
    throw new Error("同一派发尝试收到不同原生运行身份。");
  attempt.nativeRunId = runId;
  p.fusion = decodeResearchTaskGraph(p.fusion);
}
export function finishFusionNativeRun(
  p: ResearchProject,
  role: ResearchRole,
  runId: string | undefined,
  at: string,
  totals?: SessionTokenCounts,
  aborted = false,
): void {
  if (!p.fusion) return;
  const attempt = runId ? activeFusionAttempt(p, role, runId) : activeFusionAttempt(p, role);
  if (!attempt || !["running", "unknown"].includes(attempt.state)) return;
  let usedTokens: number | undefined;
  if (totals) {
    const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
    const previous = p.fusion.attempts
      .slice(
        0,
        p.fusion.attempts.findIndex((a) => a.id === attempt.id),
      )
      .filter((a) => !(a.usedTokens === 0 && !a.nativeRunId && a.sessionTotalTokens === undefined))
      .filter((a) => p.fusion!.tasks.find((t) => t.id === a.taskId)?.role === role)
      .at(-1);
    usedTokens = settleResearchUsage(attempt, previous, total, totals);
  }
  p.fusion = aborted
    ? failResearchTask(p.fusion, attempt.id, {
        at,
        reason: "原生运行确认已取消。",
        outcome: "cancelled",
        ...(usedTokens !== undefined ? { usedTokens } : {}),
      })
    : finishResearchTaskAttempt(p.fusion, attempt.id, {
        at,
        ...(usedTokens !== undefined ? { usedTokens } : {}),
      });
}
export function failFusionAttempt(
  p: ResearchProject,
  role: ResearchRole,
  reason: string,
  at: string,
): void {
  const attempt = activeFusionAttempt(p, role);
  if (p.fusion && attempt)
    p.fusion = failResearchTask(p.fusion, attempt.id, { at, reason, outcome: "failed" });
}
export function retryFusionFailures(p: ResearchProject): void {
  if (!p.fusion) return;
  for (const task of p.fusion.tasks.filter((t) => t.state === "failed")) {
    if (
      !p.fusion.attempts.some(
        (a) => a.taskId === task.id && ["prepared", "running", "unknown"].includes(a.state),
      )
    )
      p.fusion = retryResearchTask(p.fusion, task.id);
  }
}

/** Called only by an explicit user resume. Unknown or genuinely failed requests stay separate. */
export function resumeCancelledFusionTasks(
  p: ResearchProject,
  at: string,
  evidenceRef: string,
): void {
  if (!p.fusion) return;
  for (const task of p.fusion.tasks.filter(
    (task) => task.id.startsWith(`v${p.revision}:`) && task.state === "failed",
  )) {
    const attempts = p.fusion.attempts.filter((attempt) => attempt.taskId === task.id);
    const latest = attempts.at(-1);
    if (
      latest?.state !== "cancelled" ||
      latest.taskVersion !== task.inputVersion ||
      attempts.some((attempt) => ["prepared", "running", "unknown"].includes(attempt.state))
    )
      continue;
    p.fusion = requestResearchTaskRetry(p.fusion, {
      id: `resume-cancelled:${latest.id}`,
      taskId: task.id,
      at,
      reason: "用户显式恢复：继续已确认取消的未完成工作，保留已交成果。",
      evidenceRef,
    });
  }
}
export function publishFusionArtifact(
  p: ResearchProject,
  artifact: ResearchArtifact,
  historical = false,
): void {
  if (!p.fusion) return;
  const attempt = activeFusionAttempt(p, artifact.role);
  if (!attempt) throw new Error("成果缺少本角色的实际派发尝试。");
  p.fusion = publishResearchTaskResult(p.fusion, {
    projectId: p.id,
    id: artifact.id,
    attemptId: attempt.id,
    at: artifact.createdAt,
    content: artifact.content,
    keepAttemptRunning: true,
    historical,
  });
  if (
    !historical &&
    artifact.verdict &&
    ["stage-verification", "stage-review"].includes(artifact.kind)
  ) {
    const verdict =
      artifact.verdict === "accept" ? ("accepted" as const) : ("revision-required" as const);
    // The decision itself and each explicitly referenced current draft retain separate review records.
    for (const artifactId of [artifact.id, ...artifact.refs]) {
      const graphArtifact = p.fusion.artifacts.find((a) => a.id === artifactId);
      if (
        !graphArtifact ||
        p.fusion.tasks.find((t) => t.id === graphArtifact.taskId)?.currentArtifactId !== artifactId
      )
        continue;
      p.fusion = reviewResearchTaskArtifact(p.fusion, artifactId, {
        id: `review:${artifact.id}:${artifactId}`,
        at: artifact.createdAt,
        actor: "model",
        reviewer: artifact.role,
        verdict,
        reason: artifact.content,
      });
    }
  }
}

/** Pin a source only after its contents were actually read; fetch/metadata alone is insufficient. */
export function attachFusionSourceInputs(
  p: ResearchProject,
  role: ResearchRole,
  sourceIds: string[],
  at: string,
  evidenceRef: string,
): void {
  if (p.workflowVersion !== "fusion-v2" || !sourceIds.length) return;
  const sources = sourceIds.map((id) => {
    const source = p.evidence?.sources.find((s) => s.id === id);
    if (!source) throw new Error("不能绑定未登记的研究来源。");
    return { inputId: `source:${source.id}`, sha256: source.sha256, file: source.file };
  });
  attachFusionMaterialInputs(p, role, sources, at, evidenceRef);
}

/** Use for actual calculation and for a downstream role's successful read-analysis. */
export function attachFusionAnalysisInput(
  p: ResearchProject,
  role: ResearchRole,
  datasetId: string,
  at: string,
  evidenceRef: string,
): void {
  if (p.workflowVersion !== "fusion-v2") return;
  const data = p.evidence?.datasets.find((d) => d.id === datasetId);
  if (!data) throw new Error("不能绑定未登记的数据集。");
  attachFusionMaterialInputs(
    p,
    role,
    [{ inputId: `dataset:${data.id}`, sha256: data.sha256, file: data.file }],
    at,
    evidenceRef,
  );
}
function attachFusionMaterialInputs(
  p: ResearchProject,
  role: ResearchRole,
  inputs: { inputId: string; sha256: string; file: string }[],
  at: string,
  evidenceRef: string,
): void {
  const attempt = activeFusionAttempt(p, role);
  if (!attempt || !p.fusion) throw new Error("实际读取缺少融合任务执行尝试。");
  let graph = p.fusion;
  for (const item of inputs) {
    let input = graph.inputs.filter((i) => i.inputId === item.inputId).at(-1);
    if (!input || input.digest !== item.sha256) {
      const version = (input?.version ?? 0) + 1;
      input = {
        inputId: item.inputId,
        version,
        kind: "material",
        actual: true,
        availability: "available",
        label: item.inputId,
        sourceRef: item.file,
        digest: item.sha256,
      };
      graph = setResearchInput(graph, input);
      graph = applyResearchChange(graph, {
        id: `adopt:${item.inputId}:${version}`,
        at,
        inputId: item.inputId,
        fromVersion: graph.adoptedInputs.find((i) => i.inputId === item.inputId)?.version ?? null,
        toVersion: version,
        reason: "实际读取项目已取得材料，登记本次使用的不可变版本。",
        authorizedBy: "existing-authorization",
        authorizationRef: evidenceRef,
      });
    }
    graph = attachResearchTaskInput(
      graph,
      attempt.id,
      { inputId: input.inputId, version: input.version },
      { at, evidenceRef },
    );
  }
  p.fusion = graph;
}

/** Capture before computation; preserve this exact binding until storing the result. */
export function captureFusionAnalysisBinding(
  p: ResearchProject,
  role: ResearchRole,
  spec: ResearchAnalysisSpec,
): ResearchAnalysisBinding | undefined {
  if (p.workflowVersion !== "fusion-v2") return undefined;
  const attempt = activeFusionAttempt(p, role),
    task = p.fusion?.tasks.find((t) => t.id === attempt?.taskId);
  if (
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    task.stage !== "analysis" ||
    task.inputVersion !== attempt.taskVersion
  )
    throw new Error("分析需要当前有效的分析任务尝试。");
  if (!researchAnalysisMatchesPlan(p.analysisPlan, spec))
    throw new Error("分析参数与当前计划不一致。");
  const dataset = p.evidence?.datasets.find((d) => d.id === spec.datasetId);
  const ref = [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].find(
    (i) => i.inputId === `dataset:${spec.datasetId}`,
  );
  if (
    !dataset ||
    !ref ||
    !p.fusion!.inputs.some(
      (i) => i.inputId === ref.inputId && i.version === ref.version && i.digest === dataset.sha256,
    ) ||
    !p.fusion!.adoptedInputs.some((i) => i.inputId === ref.inputId && i.version === ref.version)
  )
    throw new Error("分析数据尚未按本次实际读取版本绑定。");
  return { taskId: task.id, taskInputVersion: task.inputVersion, attemptId: attempt.id };
}

/** An actual cross-member read carries the source versions through the handoff chain. */
export function attachFusionArtifactInputs(
  p: ResearchProject,
  role: ResearchRole,
  artifactIds: string[],
  at: string,
  evidenceRef: string,
): void {
  if (p.workflowVersion !== "fusion-v2" || !artifactIds.length) return;
  const attempt = activeFusionAttempt(p, role);
  if (!attempt || !p.fusion) throw new Error("成果交接缺少当前执行尝试。");
  let graph = p.fusion;
  for (const id of artifactIds)
    graph = attachResearchTaskArtifact(graph, attempt.id, id, { at, evidenceRef });
  p.fusion = graph;
}

/** UI/user reply routes own the provenance of answers; these helpers only mutate the project draft. */
export function requestFusionDecision(
  p: ResearchProject,
  request: NewResearchDecisionRequest,
): void {
  if (!p.fusion) throw new Error("本课题尚无融合任务图。");
  p.fusion = requestResearchDecision(p.fusion, request);
}
export function answerFusionDecision(p: ResearchProject, answer: ResearchDecisionAnswer): void {
  if (!p.fusion) throw new Error("本课题尚无融合任务图。");
  p.fusion = answerResearchDecision(p.fusion, answer);
}
export function resolveFusionAttempt(
  p: ResearchProject,
  resolution: ResearchAttemptResolution,
): void {
  if (!p.fusion) throw new Error("本课题尚无融合任务图。");
  p.fusion = resolveResearchAttempt(p.fusion, resolution);
}
export function requestFusionTaskRetry(
  p: ResearchProject,
  request: ResearchTaskRetryRequest,
): void {
  if (!p.fusion) throw new Error("本课题尚无融合任务图。");
  p.fusion = requestResearchTaskRetry(p.fusion, request);
}
/** Resume dispatches unfinished ready work only; it never creates another turn for delivered work. */
export function resumableFusionTasks(
  p: ResearchProject,
): { taskId: string; role: ResearchRole; stage: ResearchStageId }[] {
  if (!p.fusion || p.fusion.paused) return [];
  return p.fusion.tasks.flatMap((task) => {
    if (
      !task.id.startsWith(`v${p.revision}:`) ||
      task.state !== "pending" ||
      !RESEARCH_ROLES.includes(task.role as ResearchRole) ||
      !isResearchStageId(task.stage) ||
      activeFusionAttempt(p, task.role as ResearchRole) ||
      (p.fusion!.attempts.some(
        (attempt) =>
          attempt.taskId === task.id &&
          attempt.taskVersion === task.inputVersion &&
          attempt.state === "succeeded",
      ) &&
        !task.continuations.some((continuation) => !continuation.attemptId)) ||
      researchTaskBlockers(p.fusion!, task.id).length
    )
      return [];
    return [{ taskId: task.id, role: task.role as ResearchRole, stage: task.stage }];
  });
}
