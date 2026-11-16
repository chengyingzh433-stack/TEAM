import type {
  ResearchGroupsState,
  ResearchModel,
  ResearchProject,
  ResearchRole,
} from "../../contracts/research-group";
import type { ResearchModelSource } from "../../contracts/research-m3";
import { researchTaskUsage } from "./task-graph";
import {
  activeLegacyExecution,
  legacyProjectSettings,
  researchRequestReservation,
} from "./legacy-execution-policy";

export function pendingResearchMemberInputs(p: ResearchProject, taskId: string) {
  const active = p.fusion?.attempts.some(
    (attempt) =>
      attempt.taskId === taskId && ["prepared", "running", "unknown"].includes(attempt.state),
  );
  const version = p.fusion?.tasks.find((task) => task.id === taskId)?.inputVersion;
  return (
    p.m3?.memberInputs?.filter(
      (input) =>
        input.revision === p.revision &&
        input.taskId === taskId &&
        input.taskVersion === version &&
        !input.attemptId &&
        (!active || input.delivery !== "followUp"),
    ) ?? []
  );
}
export function researchPromptWithMemberInputs(
  p: ResearchProject,
  taskId: string,
  prompt: string,
): string {
  const inputs = pendingResearchMemberInputs(p, taskId);
  return (
    prompt +
    (inputs.length
      ? "\n\n用户对当前任务的补充（仅在既有范围内处理，改变研究目标或许可须另走对应决定／新输入）：\n" +
        inputs.map((input) => `${input.id}：${input.text}`).join("\n\n") +
        "\n若据此修订现有A稿，先read当前稿，再publish(stage-revision,memberInputIds:[实际本轮输入ID],refs:[当前稿ID],content:实际新稿)。B／导师等正式回应可用memberInputIds关联本人已收到的补充。若仅需解释而无需改稿，先read当前A稿，再member-input-response(memberInputId,artifactId,memberInputDisposition:no-manuscript-change,content:至少80字具体理由)；需改稿用requires-revision并继续既有修订链。后续改稿后说明失效时，同角色可实读新稿再重评旧输入。不虚构B批评，不把用户说明或模型处理意见当作研究许可或事实已核验，范围和B新稿复核要求继续。"
      : "")
  );
}

export function selectResearchTaskModel(
  state: Pick<ResearchGroupsState, "m3">,
  p: ResearchProject,
  role: ResearchRole,
  taskId: string,
  stage: string,
): { model?: ResearchModel; source: ResearchModelSource } {
  const recovery = p.m3?.recoveries?.filter((r) => r.taskId === taskId).at(-1);
  const last = p.fusion?.attempts.filter((a) => a.taskId === taskId).at(-1);
  if (
    recovery &&
    p.m3?.recoveryPolicies?.[taskId] &&
    recovery.attemptId === last?.id &&
    last.state === "failed"
  )
    return { model: recovery.model, source: "authorized-recovery" };
  const options: [ResearchModel | undefined, ResearchModelSource][] = [
    [p.m3?.taskModels?.[taskId], "task-override"],
    [p.stages?.find((s) => s.id === stage)?.models[role], "stage-role"],
    [p.m3?.defaultModels?.[role], "project-default"],
    [state.m3?.defaultModels?.[role], "application-default"],
  ];
  const selected = options.find(([model]) => !!model);
  return selected
    ? { model: structuredClone(selected[0]), source: selected[1] }
    : { source: "session-current" };
}

export function researchExecutionCount(
  p: ResearchProject,
  state: Pick<ResearchGroupsState, "m3"> = {},
): number {
  const graph = p.fusion;
  const attempts =
    graph?.attempts.filter((a) => ["prepared", "running", "unknown"].includes(a.state)) ?? [];
  // A legacy or not-yet-bound native still occupies a slot. Never double-count its attempt.
  const legacy =
    state.m3?.legacyExecutions?.filter(
      (a) => a.projectId === p.id && ["prepared", "running", "unknown"].includes(a.state),
    ) ?? [];
  return (
    attempts.length +
    legacy.length +
    p.members.filter(
      (m) =>
        m.status === "running" &&
        !legacy.some((a) => a.role === m.role) &&
        !attempts.some((a) => graph!.tasks.some((t) => t.id === a.taskId && t.role === m.role)),
    ).length
  );
}

export function legacyExecutionAdmission(
  state: ResearchGroupsState,
  p: ResearchProject,
  role: ResearchRole,
  prompt: string,
): string | undefined {
  const active = activeLegacyExecution(state, p.id, role);
  if (active)
    return active.state === "unknown"
      ? "旧流程请求结果未知，需先核实，不能重放。"
      : "该角色仍有在途执行。";
  const limits = legacyProjectSettings(state, p.id);
  const capacity = researchCapacityBlockReason(state, p, limits?.projectLimit ?? 4);
  if (capacity) return capacity;
  const calls = state.m3?.legacyExecutions?.filter((a) => a.projectId === p.id) ?? [];
  const spend = (list: typeof calls) =>
    list.reduce((n, a) => n + (a.usedTokens ?? a.reservedTokens), 0);
  const reserved = researchRequestReservation(prompt);
  if (limits?.tokenBudget !== undefined && spend(calls) + reserved > limits.tokenBudget)
    return "课题额度不足，未结算用量继续保留预留。";
  if (
    p.memberTokenBudget &&
    spend(calls.filter((a) => a.role === role)) + reserved > p.memberTokenBudget
  )
    return "成员累计额度不足，未结算用量继续保留预留。";
}

function researchCapacityBlockReason(
  state: ResearchGroupsState,
  p: ResearchProject,
  projectLimit = p.m3?.projectLimit ?? 4,
): string | undefined {
  const globalLimit = state.m3?.applicationLimit ?? 8;
  if (researchExecutionCount(p, state) >= projectLimit)
    return `等待课题执行名额（上限${projectLimit}）。`;
  if (
    state.projects.reduce((n, project) => n + researchExecutionCount(project, state), 0) >=
    globalLimit
  )
    return `等待应用执行名额（跨课题上限${globalLimit}）。`;
}

/** Called only inside the coordinator's shared durable mutation, before preparing a request. */
export function researchExecutionAdmission(
  state: ResearchGroupsState,
  p: ResearchProject,
  taskId: string,
  prompt: string,
): string | undefined {
  const task = p.fusion?.tasks.find((t) => t.id === taskId);
  if (!task) return "任务不存在。";
  const active = p.fusion!.attempts.find(
    (a) => a.taskId === taskId && ["prepared", "running", "unknown"].includes(a.state),
  );
  if (active)
    return active.state === "unknown" ? "外部请求结果未知，需先核实，不能重放。" : undefined;
  if (
    p.fusion!.attempts.some(
      (a) =>
        ["prepared", "running", "unknown"].includes(a.state) &&
        p.fusion!.tasks.some((t) => t.id === a.taskId && t.role === task.role),
    )
  )
    return "该角色仍有在途任务。";
  const capacity = researchCapacityBlockReason(state, p);
  if (capacity) return capacity;
  const usage = p.fusion!.tasks.map((t) => researchTaskUsage(p.fusion!, t.id));
  const reservation = Math.ceil(prompt.length / 2) + 4096;
  if (
    p.m3?.tokenBudget !== undefined &&
    usage.reduce((n, u) => n + u.knownTokens + u.reservedTokens, 0) + reservation > p.m3.tokenBudget
  )
    return "课题额度不足以原子预留本次请求；未结算用量继续保留预留。";
  const recovery = p.m3?.recoveries?.filter((r) => r.taskId === taskId).at(-1);
  if (recovery && Date.parse(recovery.retryAt) > Date.now())
    return "模型恢复等待中，不占执行名额。";
}

export function queueResearchExecution(
  p: ResearchProject,
  taskId: string,
  reason: string,
  at: string,
): void {
  const m3 = (p.m3 ??= {}),
    queue = (m3.queued ??= []);
  const existing = queue.find((q) => q.taskId === taskId);
  if (existing) existing.reason = reason;
  else queue.push({ taskId, reason, at });
}
export function clearResearchExecutionQueue(p: ResearchProject, taskId: string): void {
  if (p.m3?.queued) p.m3.queued = p.m3.queued.filter((q) => q.taskId !== taskId);
}
export function plannedResearchRecovery(
  p: ResearchProject,
  taskId: string,
  error: string,
  at: string,
) {
  const policy = p.m3?.recoveryPolicies?.[taskId];
  const previous = p.m3?.recoveries?.filter((r) => r.taskId === taskId) ?? [];
  const attempt = p.fusion?.attempts.filter((a) => a.taskId === taskId).at(-1);
  if (
    !policy ||
    !attempt ||
    attempt.state !== "failed" ||
    attempt.usedTokens === undefined ||
    previous.some((r) => r.attemptId === attempt.id) ||
    previous.length >= policy.maxRetries ||
    /auth|credential|401|403|not.found|不存在|认证|许可|unknown|未知/i.test(error) ||
    !/429|5\d\d|timeout|temporar|rate.limit|超时|暂时|限流/i.test(error)
  )
    return;
  const model = policy.candidates[Math.min(previous.length, policy.candidates.length - 1)];
  if (!model) return;
  return {
    taskId,
    attemptId: attempt.id,
    model: structuredClone(model),
    retryAt: new Date(Date.parse(at) + Math.min(250 * 2 ** previous.length, 2000)).toISOString(),
    reason: error,
  };
}
