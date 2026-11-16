import { isDeepStrictEqual } from "node:util";
import {
  decodeResearchTaskGraph,
  type ResearchTask,
  type ResearchTaskArtifact,
  type ResearchTaskAttempt,
  type ResearchTaskBlocker,
  type ResearchTaskChange,
  type ResearchTaskDecision,
  type ResearchTaskGraph,
  type ResearchTaskInput,
  type ResearchTaskInputRef,
  type ResearchDecisionRequest,
  type ResearchAttemptResolution,
  type ResearchTaskRetryRequest,
} from "../../contracts/research-task-graph";
import { researchTaskControlDecisionStatus as researchDecisionStatus } from "../../contracts/research-task-controls";
export { researchDecisionStatus };

/** All operations return a validated copy. Persist it before dispatch/notification. */
export function createResearchTaskGraph(
  projectId: string,
  methodVersion: string,
): ResearchTaskGraph {
  return decodeResearchTaskGraph({
    version: 1,
    projectId,
    methodVersion,
    paused: false,
    inputs: [],
    adoptedInputs: [],
    tasks: [],
    attempts: [],
    artifacts: [],
    changes: [],
    decisions: [],
  });
}
function taskFor(g: ResearchTaskGraph, taskId: string): ResearchTask {
  const task = g.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error("研究任务不存在。");
  return task;
}
function attemptFor(g: ResearchTaskGraph, attemptId: string): ResearchTaskAttempt {
  const attempt = g.attempts.find((a) => a.id === attemptId);
  if (!attempt) throw new Error("研究执行尝试不存在。");
  return attempt;
}
function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}
function active(a: ResearchTaskAttempt): boolean {
  return ["prepared", "running", "unknown"].includes(a.state);
}
function currentArtifact(g: ResearchTaskGraph, taskId: string): ResearchTaskArtifact | undefined {
  const task = taskFor(g, taskId);
  return g.artifacts.find(
    (a) => a.id === task.currentArtifactId && a.taskVersion === task.inputVersion,
  );
}

function userConfirmed(graph: ResearchTaskGraph, ref: ResearchTaskInputRef): boolean {
  const request = graph.decisionRequests?.find(
    (r) => r.inputId === ref.inputId && r.version === ref.version,
  );
  if (request) return researchDecisionStatus(graph, request.id) === "confirmed";
  return graph.decisions.some(
    (d) =>
      d.inputId === ref.inputId &&
      d.version === ref.version &&
      d.actor === "user" &&
      (d.outcome === undefined || d.outcome === "confirmed"),
  );
}

export function researchTaskBlockers(g: ResearchTaskGraph, taskId: string): ResearchTaskBlocker[] {
  const task = taskFor(g, taskId),
    blockers: ResearchTaskBlocker[] = [];
  if (g.paused)
    blockers.push({ kind: "pause", objectId: g.projectId, reason: "全组暂停，不派发新请求。" });
  for (const a of g.attempts.filter((a) => a.taskId === task.id && active(a))) {
    blockers.push({
      kind: "attempt",
      objectId: a.id,
      reason:
        a.state === "unknown" ? "外部请求结果未知，核对前不自动重试。" : "已有未结束的执行尝试。",
    });
  }
  for (const ref of task.inputs) {
    const input = g.inputs.find((i) => i.inputId === ref.inputId && i.version === ref.version);
    const adopted = g.adoptedInputs.some(
      (i) => i.inputId === ref.inputId && i.version === ref.version,
    );
    if (ref.requirement === "user-confirmed") {
      if (!adopted || input?.kind !== "decision" || !userConfirmed(g, ref))
        blockers.push({
          kind: "decision",
          objectId: ref.inputId,
          reason: "等待该版本条件的实际用户回复。",
        });
    } else if (!adopted || input?.availability !== "available") {
      blockers.push({
        kind: "input",
        objectId: ref.inputId,
        reason: "所需输入版本未采用、不可用或仅为计划。",
      });
    }
  }
  for (const dep of task.dependencies) {
    const artifact = currentArtifact(g, dep.taskId);
    if (
      !artifact ||
      ["needs-review", "superseded", "revision-required"].includes(artifact.reviewState) ||
      (dep.requirement === "accepted" && artifact.reviewState !== "accepted")
    ) {
      blockers.push({
        kind: "task",
        objectId: dep.taskId,
        reason:
          dep.requirement === "accepted"
            ? "等待当前版本成果审阅接受。"
            : "等待可用的当前版本中间成果。",
      });
    }
  }
  if (
    task.kind === "analysis" &&
    !task.inputs.some((ref) => {
      const input = g.inputs.find((i) => i.inputId === ref.inputId && i.version === ref.version);
      return (
        input?.kind === "material" &&
        input.actual &&
        input.availability === "available" &&
        g.adoptedInputs.some((i) => i.inputId === ref.inputId && i.version === ref.version)
      );
    })
  )
    blockers.push({
      kind: "material",
      objectId: task.id,
      reason: "实际分析需要已采用的真实供给材料；方案或计划不能代替材料。",
    });
  return blockers;
}
function finish(g: ResearchTaskGraph): ResearchTaskGraph {
  for (const task of g.tasks) {
    task.blockers = researchTaskBlockers(g, task.id);
    if (["failed", "cancelled"].includes(task.state)) continue;
    if (
      g.attempts.some(
        (a) =>
          a.taskId === task.id &&
          a.taskVersion === task.inputVersion &&
          ["prepared", "running"].includes(a.state),
      )
    ) {
      task.state = "running";
      continue;
    }
    const result = currentArtifact(g, task.id);
    if (
      result &&
      !result.interim &&
      !["needs-review", "superseded"].includes(result.reviewState) &&
      !task.continuations.some((c) => !c.attemptId) &&
      !task.blockers.some((b) => b.kind === "attempt")
    ) {
      task.state = "completed";
      continue;
    }
    task.state = g.paused
      ? "paused"
      : task.blockers.some((b) => b.kind === "decision")
        ? "waiting-user"
        : task.blockers.length
          ? "waiting-dependency"
          : "pending";
  }
  return decodeResearchTaskGraph(g);
}

/** Registering candidates never invalidates adopted research. Adoption is a separate operation. */
export function setResearchInput(
  graph: ResearchTaskGraph,
  input: ResearchTaskInput,
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph);
  const previous = g.inputs.find((i) => i.inputId === input.inputId && i.version === input.version);
  if (previous) {
    if (!same(previous, input)) throw new Error("输入版本不可改写；请登记新版本。");
    return g;
  }
  g.inputs.push(structuredClone(input));
  return finish(g);
}
export type NewResearchTask = Omit<
  ResearchTask,
  "state" | "blockers" | "continuations" | "currentArtifactId" | "error" | "inputVersion"
> & { inputVersion?: number };
export function addResearchTask(
  graph: ResearchTaskGraph,
  task: NewResearchTask,
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph);
  if (g.tasks.some((t) => t.id === task.id)) throw new Error("研究任务身份已存在。");
  g.tasks.push({
    ...structuredClone(task),
    inputVersion: task.inputVersion ?? 1,
    state: "pending",
    blockers: [],
    continuations: [],
  });
  // Validate references and cycles before deriving the state.
  return finish(decodeResearchTaskGraph(g));
}
export type ApplyResearchTaskChange = Omit<
  ResearchTaskChange,
  "affectedTaskIds" | "additionalTaskIds"
> & { additionalTaskIds?: string[] };
export function researchChangeImpact(
  graph: ResearchTaskGraph,
  inputId: string,
  additionalTaskIds: string[] = [],
): { affectedTaskIds: string[]; reusableTaskIds: string[] } {
  const g = decodeResearchTaskGraph(graph);
  additionalTaskIds.forEach((id) => taskFor(g, id));
  // In-stage A/B handoffs cannot be declared as task dependencies: their feedback
  // would form a scheduling cycle. Follow the inputs actually consumed by the
  // current output and current active attempt as well as declared prerequisites.
  // Earlier attempts stay historical once replaced or finished without an output.
  const artifacts = new Map(g.artifacts.map((artifact) => [artifact.id, artifact]));
  const consumed = new Map(
    g.tasks.map((task) => {
      const output = task.currentArtifactId ? artifacts.get(task.currentArtifactId) : undefined;
      const current = output?.taskVersion === task.inputVersion ? [output] : [];
      const active = g.attempts.filter(
        (attempt) =>
          attempt.taskId === task.id &&
          attempt.taskVersion === task.inputVersion &&
          ["prepared", "running", "unknown"].includes(attempt.state),
      );
      return [
        task.id,
        {
          inputIds: new Set([
            ...current.flatMap((artifact) => artifact.inputRefs.map((ref) => ref.inputId)),
            ...active.flatMap((attempt) =>
              [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].map((ref) => ref.inputId),
            ),
          ]),
          producerIds: new Set(
            [
              ...current.flatMap((artifact) => artifact.dependencyArtifactIds),
              ...active.flatMap((attempt) => [
                ...attempt.dependencyArtifactIds,
                ...(attempt.acquiredArtifacts ?? []).map((ref) => ref.artifactId),
              ]),
            ].map((id) => artifacts.get(id)!.taskId),
          ),
        },
      ] as const;
    }),
  );
  const affected = new Set([
    ...g.tasks
      .filter(
        (t) =>
          t.inputs.some((r) => r.inputId === inputId) || consumed.get(t.id)!.inputIds.has(inputId),
      )
      .map((t) => t.id),
    ...additionalTaskIds,
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of g.tasks) {
      if (
        !affected.has(task.id) &&
        (task.dependencies.some((dep) => affected.has(dep.taskId)) ||
          [...consumed.get(task.id)!.producerIds].some((id) => affected.has(id)))
      ) {
        affected.add(task.id);
        changed = true;
      }
    }
  }
  return {
    affectedTaskIds: g.tasks.filter((t) => affected.has(t.id)).map((t) => t.id),
    reusableTaskIds: g.tasks.filter((t) => !affected.has(t.id)).map((t) => t.id),
  };
}
export function applyResearchChange(
  graph: ResearchTaskGraph,
  change: ApplyResearchTaskChange,
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    request = { ...change, additionalTaskIds: change.additionalTaskIds ?? [] };
  const old = g.changes.find((c) => c.id === change.id);
  if (old) {
    const { affectedTaskIds: _affected, ...saved } = old;
    if (!same(saved, request)) throw new Error("变更身份已用于不同内容。");
    return g;
  }
  const input = g.inputs.find(
    (i) => i.inputId === change.inputId && i.version === change.toVersion,
  );
  if (!input) throw new Error("请先登记变更后的输入版本。");
  const prior = g.adoptedInputs.find((i) => i.inputId === change.inputId);
  if ((prior?.version ?? null) !== change.fromVersion)
    throw new Error("输入已变化，请重新查看影响。");
  if (prior && change.toVersion <= prior.version)
    throw new Error("采用版本必须前进，历史版本不能覆盖新版本。");
  const impact = researchChangeImpact(g, change.inputId, request.additionalTaskIds);
  if (
    change.authorizedBy === "routine" &&
    impact.affectedTaskIds.some((id) => currentArtifact(g, id)?.reviewState === "accepted")
  )
    throw new Error("变更影响已接受成果，需要用户指示或已记录的既有授权。");
  g.adoptedInputs = g.adoptedInputs.filter((i) => i.inputId !== change.inputId);
  g.adoptedInputs.push({ inputId: change.inputId, version: change.toVersion });
  for (const task of g.tasks.filter((t) => impact.affectedTaskIds.includes(t.id))) {
    const artifact = currentArtifact(g, task.id);
    if (artifact) artifact.reviewState = "needs-review";
    task.inputs = task.inputs.map((ref) =>
      ref.inputId === change.inputId ? { ...ref, version: change.toVersion } : ref,
    );
    task.inputVersion++;
    delete task.currentArtifactId;
    delete task.error;
    if (task.state !== "cancelled") task.state = "pending";
  }
  g.changes.push({ ...request, affectedTaskIds: impact.affectedTaskIds });
  return finish(g);
}

export interface StartResearchTaskOptions {
  id: string;
  at: string;
  reservedTokens: number;
  model?: ResearchTaskAttempt["model"];
}
/** First persist the returned prepared attempt; then mark dispatch and invoke the existing Pi host. */
export function startResearchTask(
  graph: ResearchTaskGraph,
  taskId: string,
  options: StartResearchTaskOptions,
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    task = taskFor(g, taskId);
  const old = g.attempts.find((a) => a.id === options.id);
  if (old) {
    if (
      old.taskId !== taskId ||
      old.preparedAt !== options.at ||
      old.reservedTokens !== options.reservedTokens ||
      !same(old.model, options.model)
    )
      throw new Error("尝试身份冲突。");
    return g;
  }
  const blockers = researchTaskBlockers(g, taskId);
  if (blockers.length) throw new Error(blockers.map((b) => b.reason).join(" "));
  if (["completed", "failed", "cancelled"].includes(task.state))
    throw new Error("该任务不能重复派发；需要明确的修订或重试操作。");
  const usage = researchTaskUsage(g, taskId);
  if (
    task.tokenBudget !== undefined &&
    usage.knownTokens + usage.reservedTokens + options.reservedTokens > task.tokenBudget
  )
    throw new Error("任务预算不足，未派发请求。");
  const continuation = task.continuations.find((c) => !c.attemptId);
  if (continuation) continuation.attemptId = options.id;
  g.attempts.push({
    id: options.id,
    taskId,
    taskVersion: task.inputVersion,
    inputRefs: task.inputs.map(({ inputId, version }) => ({ inputId, version })),
    dependencyArtifactIds: task.dependencies.map((d) => currentArtifact(g, d.taskId)!.id),
    state: "prepared",
    preparedAt: options.at,
    reservedTokens: options.reservedTokens,
    ...(options.model ? { model: structuredClone(options.model) } : {}),
  });
  return finish(g);
}
export function markResearchTaskDispatched(
  graph: ResearchTaskGraph,
  attemptId: string,
  at: string,
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    attempt = attemptFor(g, attemptId);
  if (attempt.dispatchedAt) return g;
  if (g.paused || attempt.state !== "prepared") throw new Error("当前尝试不能派发。");
  if (attempt.taskVersion !== taskFor(g, attempt.taskId).inputVersion)
    throw new Error("准备派发的输入已过期。");
  attempt.state = "running";
  attempt.dispatchedAt = at;
  return finish(g);
}
/** Attach only actually read input versions to a live attempt without rewriting earlier outputs. */
export function attachResearchTaskInput(
  graph: ResearchTaskGraph,
  attemptId: string,
  ref: ResearchTaskInputRef,
  receipt: { at: string; evidenceRef: string },
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    attempt = attemptFor(g, attemptId),
    task = taskFor(g, attempt.taskId);
  if (attempt.state !== "running" || attempt.taskVersion !== task.inputVersion)
    throw new Error("旧任务或非运行尝试不能取得新版本输入。");
  const input = g.inputs.find((i) => i.inputId === ref.inputId && i.version === ref.version);
  if (
    (input?.availability !== "available" &&
      !(input?.kind === "decision" && userConfirmed(g, ref))) ||
    !g.adoptedInputs.some((i) => i.inputId === ref.inputId && i.version === ref.version)
  )
    throw new Error("运行中输入尚未采用或不可用。");
  const frozen = [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].find(
    (i) => i.inputId === ref.inputId,
  );
  if (frozen && frozen.version !== ref.version)
    throw new Error("同一尝试不能混用同一输入的不同版本。");
  const required = task.inputs.find((i) => i.inputId === ref.inputId);
  if (required && required.version !== ref.version)
    throw new Error("任务依赖版本与取得输入不一致。");
  if (!required)
    task.inputs.push({
      inputId: ref.inputId,
      version: ref.version,
      requirement: input.kind === "decision" ? "user-confirmed" : "available",
    });
  if (!frozen)
    (attempt.acquiredInputs ??= []).push({
      inputId: ref.inputId,
      version: ref.version,
      ...receipt,
    });
  return finish(g);
}

/** Reading an intermediate artifact inherits its dependencies, not a claim of reading its originals. */
export function attachResearchTaskArtifact(
  graph: ResearchTaskGraph,
  attemptId: string,
  artifactId: string,
  receipt: { at: string; evidenceRef: string },
): ResearchTaskGraph {
  let g = decodeResearchTaskGraph(graph);
  const artifact = g.artifacts.find((a) => a.id === artifactId);
  if (
    !artifact ||
    artifact.taskVersion !== taskFor(g, artifact.taskId).inputVersion ||
    ["superseded", "needs-review"].includes(artifact.reviewState)
  )
    throw new Error("旧成果不能作为新任务的有效交接依赖。");
  const attempt = attemptFor(g, attemptId);
  if (
    attempt.state !== "running" ||
    attempt.taskVersion !== taskFor(g, attempt.taskId).inputVersion
  )
    throw new Error("旧任务或非运行尝试不能读取新的交接成果。");
  for (const ref of artifact.inputRefs) g = attachResearchTaskInput(g, attemptId, ref, receipt);
  const updated = attemptFor(g, attemptId);
  if (
    !updated.dependencyArtifactIds.includes(artifactId) &&
    !updated.acquiredArtifacts?.some((r) => r.artifactId === artifactId)
  )
    (updated.acquiredArtifacts ??= []).push({ artifactId, ...receipt });
  return finish(g);
}

export interface ResearchTaskResult {
  projectId: string;
  id: string;
  attemptId: string;
  at: string;
  content: string;
  interim?: boolean;
  usedTokens?: number;
  /** The Pi runtime, rather than this tool publication, will close the actual call. */
  keepAttemptRunning?: boolean;
  historical?: boolean;
}
/** An interim result can satisfy a published dependency while its producer remains running. */
export function publishResearchTaskResult(
  graph: ResearchTaskGraph,
  result: ResearchTaskResult,
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph);
  if (result.projectId !== g.projectId) throw new Error("成果不属于本课题。");
  const attempt = attemptFor(g, result.attemptId),
    task = taskFor(g, attempt.taskId);
  const old = g.artifacts.find((a) => a.id === result.id);
  if (old) {
    if (
      old.attemptId !== result.attemptId ||
      old.content !== result.content ||
      old.createdAt !== result.at ||
      old.interim !== (result.interim ?? false) ||
      (!old.interim &&
        result.usedTokens !== undefined &&
        !result.keepAttemptRunning &&
        attempt.usedTokens !== result.usedTokens)
    )
      throw new Error("成果身份已用于不同内容。");
    return g;
  }
  if (!["running", "unknown"].includes(attempt.state))
    throw new Error("未执行或已结束的尝试不能发布新成果。");
  const inputRefs = [
    ...attempt.inputRefs,
    ...(attempt.acquiredInputs ?? []).map(({ inputId, version }) => ({ inputId, version })),
  ];
  const stale =
    result.historical === true ||
    attempt.taskVersion !== task.inputVersion ||
    inputRefs.some(
      (ref) => !g.adoptedInputs.some((i) => i.inputId === ref.inputId && i.version === ref.version),
    );
  const artifact: ResearchTaskArtifact = {
    id: result.id,
    taskId: task.id,
    taskVersion: attempt.taskVersion,
    attemptId: attempt.id,
    createdAt: result.at,
    content: result.content,
    inputRefs: structuredClone(inputRefs),
    dependencyArtifactIds: [
      ...attempt.dependencyArtifactIds,
      ...(attempt.acquiredArtifacts ?? []).map((r) => r.artifactId),
    ],
    interim: result.interim ?? false,
    reviewState: stale ? "superseded" : task.reviewRequired ? "pending-review" : "draft",
    reviews: [],
  };
  g.artifacts.push(artifact);
  if (!stale) task.currentArtifactId = artifact.id;
  if (!artifact.interim && !result.keepAttemptRunning) {
    attempt.state = "succeeded";
    attempt.finishedAt = result.at;
    if (result.usedTokens !== undefined) attempt.usedTokens = result.usedTokens;
  }
  return finish(g);
}
/** Called at the native Pi completion boundary, after tool publications are durable. */
export function finishResearchTaskAttempt(
  graph: ResearchTaskGraph,
  attemptId: string,
  completion: { at: string; usedTokens?: number },
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    attempt = attemptFor(g, attemptId);
  if (attempt.state === "succeeded") {
    if (attempt.finishedAt !== completion.at || attempt.usedTokens !== completion.usedTokens)
      throw new Error("完成通知与已结算尝试不一致。");
    return g;
  }
  if (!["running", "unknown"].includes(attempt.state)) throw new Error("该尝试不能登记执行完成。");
  attempt.state = "succeeded";
  attempt.finishedAt = completion.at;
  if (completion.usedTokens !== undefined) attempt.usedTokens = completion.usedTokens;
  return finish(g);
}

/** A new real turn needs an explicit continuation, never inferred from visiting a session. */
export function requestResearchTaskContinuation(
  graph: ResearchTaskGraph,
  taskId: string,
  request: { id: string; at: string; reason: string },
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    task = taskFor(g, taskId);
  const old = task.continuations.find((c) => c.id === request.id);
  if (old) {
    if (old.at !== request.at || old.reason !== request.reason)
      throw new Error("接续请求身份冲突。");
    return g;
  }
  if (["failed", "cancelled"].includes(task.state))
    throw new Error("失败或取消任务需要先明确恢复。");
  task.continuations.push(structuredClone(request));
  return finish(g);
}

export function reviewResearchTaskArtifact(
  graph: ResearchTaskGraph,
  artifactId: string,
  review: ResearchTaskArtifact["reviews"][number],
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    artifact = g.artifacts.find((a) => a.id === artifactId);
  if (!artifact) throw new Error("审阅成果不存在。");
  const previous = artifact.reviews.find((r) => r.id === review.id);
  if (previous) {
    if (!same(previous, review)) throw new Error("审阅身份冲突。");
    return g;
  }
  const task = taskFor(g, artifact.taskId);
  if (
    artifact.taskVersion !== task.inputVersion ||
    task.currentArtifactId !== artifact.id ||
    ["superseded", "needs-review"].includes(artifact.reviewState)
  )
    throw new Error("旧稿审阅不能放行当前版本。");
  artifact.reviews.push(structuredClone(review));
  artifact.reviewState = review.verdict;
  return finish(g);
}
export function failResearchTask(
  graph: ResearchTaskGraph,
  attemptId: string,
  failure: {
    at: string;
    reason: string;
    usedTokens?: number;
    outcome: "failed" | "unknown" | "cancelled";
  },
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    attempt = attemptFor(g, attemptId),
    task = taskFor(g, attempt.taskId);
  if (!active(attempt)) {
    if (
      attempt.state === failure.outcome &&
      attempt.error === failure.reason &&
      attempt.usedTokens === failure.usedTokens
    )
      return g;
    throw new Error("已结束尝试不能改写失败结论。");
  }
  if (attempt.state === "prepared" && failure.outcome === "unknown")
    throw new Error("未派发请求不能记为未知外部结果。");
  attempt.state = failure.outcome;
  attempt.error = failure.reason;
  if (failure.outcome !== "unknown") attempt.finishedAt = failure.at;
  if (failure.usedTokens !== undefined) attempt.usedTokens = failure.usedTokens;
  if (task.inputVersion === attempt.taskVersion) {
    task.state = failure.outcome === "unknown" ? "waiting-dependency" : "failed";
    task.error = failure.reason;
  }
  return finish(g);
}
/** Explicit retry only after the previous external outcome is known. Partial artifacts remain. */
export function retryResearchTask(graph: ResearchTaskGraph, taskId: string): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    task = taskFor(g, taskId);
  if (g.attempts.some((a) => a.taskId === task.id && active(a)))
    throw new Error("仍有在途或未知请求，不能重试。");
  if (task.state !== "failed") throw new Error("只有失败任务可以重试。");
  task.state = "pending";
  delete task.error;
  return finish(g);
}
export function pauseResearchTasks(graph: ResearchTaskGraph): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph);
  g.paused = true;
  return finish(g);
}
export function resumeResearchTasks(graph: ResearchTaskGraph): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph);
  g.paused = false;
  return finish(g);
}
/** Unknown in-flight work keeps reservations; a prepared, never-dispatched attempt costs zero. */
export function recoverResearchTasks(graph: ResearchTaskGraph, at: string): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph);
  g.paused = true;
  for (const attempt of g.attempts) {
    if (attempt.state === "running") {
      attempt.state = "unknown";
      attempt.error = "重启时外部请求结果未知，需核对已保存成果。";
    }
    if (attempt.state === "prepared") {
      attempt.state = "cancelled";
      attempt.usedTokens = 0;
      attempt.finishedAt = at;
      attempt.error = "派发前中断，没有发出模型请求。";
    }
  }
  return finish(g);
}
export function recordResearchDecision(
  graph: ResearchTaskGraph,
  decision: ResearchTaskDecision,
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph),
    previous = g.decisions.find((d) => d.id === decision.id);
  if (previous) {
    if (!same(previous, decision)) throw new Error("决定身份冲突。");
    return g;
  }
  if (decision.requestId !== undefined)
    throw new Error("人的请求答复须使用 answerResearchDecision；模型意见不能代替用户选项。");
  g.decisions.push(structuredClone(decision));
  return finish(g);
}
export function researchTaskUsage(
  graph: ResearchTaskGraph,
  taskId?: string,
): { knownTokens: number; reservedTokens: number; unknownAttempts: string[] } {
  let knownTokens = 0,
    reservedTokens = 0;
  const unknownAttempts: string[] = [];
  for (const attempt of graph.attempts.filter((a) => taskId === undefined || a.taskId === taskId)) {
    if (attempt.usedTokens !== undefined) knownTokens += attempt.usedTokens;
    if (active(attempt) || attempt.usedTokens === undefined) {
      reservedTokens += Math.max(0, attempt.reservedTokens - (attempt.usedTokens ?? 0));
      if (attempt.state === "unknown" || (!active(attempt) && attempt.usedTokens === undefined))
        unknownAttempts.push(attempt.id);
    }
  }
  return { knownTokens, reservedTokens, unknownAttempts };
}

export type NewResearchDecisionRequest = Omit<ResearchDecisionRequest, "affectedTaskIds">;
/** Discovering another dependent task does not create a new question or user answer. */
export function attachResearchDecisionDependency(
  graph: ResearchTaskGraph,
  requestId: string,
  taskIds: string[],
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph);
  const request = g.decisionRequests?.find((entry) => entry.id === requestId);
  if (!request || researchDecisionStatus(g, requestId) === "superseded")
    throw new Error("只能依赖当前有效的决定条件。");
  const direct = taskIds
    .map((id) => taskFor(g, id))
    .filter(
      (task) =>
        !task.inputs.some(
          (ref) =>
            ref.inputId === request.inputId &&
            ref.version === request.version &&
            ref.requirement === "user-confirmed",
        ),
    );
  if (!direct.length) return g;
  const affected = new Set(direct.map((task) => task.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const task of g.tasks)
      if (!affected.has(task.id) && task.dependencies.some((dep) => affected.has(dep.taskId))) {
        affected.add(task.id);
        changed = true;
      }
  }
  for (const task of g.tasks.filter((item) => affected.has(item.id))) {
    const artifact = currentArtifact(g, task.id);
    if (artifact) artifact.reviewState = "needs-review";
    if (direct.some((item) => item.id === task.id)) {
      task.inputs = task.inputs.filter((ref) => ref.inputId !== request.inputId);
      task.inputs.push({
        inputId: request.inputId,
        version: request.version,
        requirement: "user-confirmed",
      });
    }
    task.inputVersion++;
    delete task.currentArtifactId;
    if (!["failed", "cancelled"].includes(task.state)) task.state = "pending";
  }
  // Original question, explicit scope and every reply remain immutable. This is dependency impact.
  request.affectedTaskIds = [...new Set([...request.affectedTaskIds, ...affected])];
  return finish(g);
}
/** A new fact/permission gate invalidates only its named scope, never an unrelated task. */
export function requestResearchDecision(
  graph: ResearchTaskGraph,
  request: NewResearchDecisionRequest,
): ResearchTaskGraph {
  let g = decodeResearchTaskGraph(graph);
  const old = g.decisionRequests?.find((r) => r.id === request.id);
  if (old) {
    const { affectedTaskIds: _affected, ...original } = old;
    if (!same(original, request))
      throw new Error("决定请求身份已用于不同内容；变更条件请建立新版本。");
    return g;
  }
  if (
    g.decisionRequests?.some((r) => r.inputId === request.inputId && r.version === request.version)
  )
    throw new Error("此条件已有决定请求，请复用原请求与已有答复。");
  const prior = g.inputs.filter((i) => i.inputId === request.inputId).at(-1);
  if (request.version !== (prior?.version ?? 0) + 1 || (prior && prior.kind !== "decision"))
    throw new Error("决定条件必须采用下一个独立版本。");
  const impact = researchChangeImpact(g, request.inputId, request.taskIds);
  g = setResearchInput(g, {
    inputId: request.inputId,
    version: request.version,
    kind: "decision",
    availability: "missing",
    actual: false,
    label: request.question,
    sourceRef: `decision-request:${request.id}`,
    digest: JSON.stringify({
      question: request.question,
      context: request.context,
      options: request.options,
    }),
  });
  g.adoptedInputs = g.adoptedInputs.filter((i) => i.inputId !== request.inputId);
  g.adoptedInputs.push({ inputId: request.inputId, version: request.version });
  for (const task of g.tasks.filter((t) => impact.affectedTaskIds.includes(t.id))) {
    const current = currentArtifact(g, task.id);
    if (current) current.reviewState = "needs-review";
    task.inputVersion++;
    delete task.currentArtifactId;
    delete task.error;
    task.inputs = task.inputs.map((ref) =>
      ref.inputId === request.inputId ? { ...ref, version: request.version } : ref,
    );
    if (
      request.taskIds.includes(task.id) &&
      !task.inputs.some((i) => i.inputId === request.inputId)
    )
      task.inputs.push({
        inputId: request.inputId,
        version: request.version,
        requirement: "user-confirmed",
      });
    if (task.state !== "cancelled") task.state = "pending";
  }
  (g.decisionRequests ??= []).push({
    ...structuredClone(request),
    affectedTaskIds: impact.affectedTaskIds,
  });
  return finish(g);
}
export interface ResearchDecisionAnswer {
  id: string;
  requestId: string;
  at: string;
  optionId: string;
  text: string;
  evidenceRef: string;
  origin: "new-reply" | "prior-authorization";
}
/** Only the host's actual user-input route should call this; no clock or model verdict can answer. */
export function answerResearchDecision(
  graph: ResearchTaskGraph,
  answer: ResearchDecisionAnswer,
): ResearchTaskGraph {
  const g = decodeResearchTaskGraph(graph);
  const request = g.decisionRequests?.find((r) => r.id === answer.requestId);
  if (!request) throw new Error("人的决定请求不存在。");
  const option = request.options.find((o) => o.id === answer.optionId);
  if (!option) throw new Error("答复没有选择本次请求中的有效选项。");
  const decision: ResearchTaskDecision = {
    ...answer,
    inputId: request.inputId,
    version: request.version,
    actor: "user",
    outcome: option.outcome,
  };
  const previous = g.decisions.find((d) => d.id === answer.id);
  if (previous) {
    if (!same(previous, decision)) throw new Error("用户答复身份冲突。");
    return g;
  }
  const status = researchDecisionStatus(g, request.id);
  if (status === "superseded") throw new Error("旧条件的答复不能确认新版本。");
  if (status === "confirmed")
    throw new Error("此条件已有有效用户确认；改变决定请建立新条件版本，不重复询问。");
  g.decisions.push(decision);
  return finish(g);
}

/** Reconcile one unknown call using an actual user/provider/native record, not a model guess. */
export function resolveResearchAttempt(
  graph: ResearchTaskGraph,
  resolution: ResearchAttemptResolution,
): ResearchTaskGraph {
  let g = decodeResearchTaskGraph(graph);
  const old = g.attemptResolutions?.find((r) => r.id === resolution.id);
  if (old) {
    if (!same(old, resolution)) throw new Error("请求核对身份冲突。");
    return g;
  }
  const attempt = attemptFor(g, resolution.attemptId);
  if (attempt.state !== "unknown")
    throw new Error("只有未知请求需要显式核对；不得改写已知执行结果。");
  if (resolution.outcome === "succeeded") {
    g = finishResearchTaskAttempt(g, attempt.id, {
      at: resolution.at,
      ...(resolution.usedTokens !== undefined ? { usedTokens: resolution.usedTokens } : {}),
    });
    const task = taskFor(g, attempt.taskId),
      result = currentArtifact(g, task.id);
    if (task.inputVersion === attempt.taskVersion && (!result || result.interim)) {
      task.state = "failed";
      task.error = "请求已核实完成，但没有可恢复的完整成果；请检查已有批次后明确重试。";
    }
  } else {
    g = failResearchTask(g, attempt.id, {
      at: resolution.at,
      reason: resolution.reason,
      outcome: resolution.outcome,
      ...(resolution.usedTokens !== undefined ? { usedTokens: resolution.usedTokens } : {}),
    });
  }
  (g.attemptResolutions ??= []).push(structuredClone(resolution));
  return finish(g);
}
/** A retry targets one failed task; it does not reset its inputs, artifacts, reviews or other roles. */
export function requestResearchTaskRetry(
  graph: ResearchTaskGraph,
  request: ResearchTaskRetryRequest,
): ResearchTaskGraph {
  let g = decodeResearchTaskGraph(graph);
  const old = g.retryRequests?.find((r) => r.id === request.id);
  if (old) {
    if (!same(old, request)) throw new Error("重试请求身份冲突。");
    return g;
  }
  const task = taskFor(g, request.taskId);
  if (task.state !== "failed") throw new Error("只能显式恢复失败任务，已交成果不会重跑。");
  g = retryResearchTask(g, task.id);
  // A saved result can make retryResearchTask complete again; explicit remaining
  // work needs its own durable continuation without discarding that result.
  g = requestResearchTaskContinuation(g, task.id, {
    id: `retry:${request.id}`,
    at: request.at,
    reason: request.reason,
  });
  (g.retryRequests ??= []).push(structuredClone(request));
  return finish(g);
}
