import type { ResearchTaskDecision, ResearchTaskGraph } from "./research-task-graph";

export interface ResearchTaskAnswerInput {
  requestId: string;
  optionId: string;
  text: string;
}
export interface ResearchTaskRetryInput {
  taskId: string;
  reason: string;
}
export interface ResearchTaskResolveInput {
  attemptId: string;
  outcome: "succeeded" | "failed" | "cancelled";
  reason: string;
  evidenceRef: string;
  usedTokens?: number;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("操作内容无效。");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) throw new Error("操作含有未知字段。");
  return result;
}
function text(value: unknown, label: string, max = 6000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}不能为空或过长。`);
  return value.trim();
}
export function decodeResearchTaskAnswerInput(value: unknown): ResearchTaskAnswerInput {
  const r = record(value, ["requestId", "optionId", "text"]);
  return {
    requestId: text(r.requestId, "请求", 512),
    optionId: text(r.optionId, "选项", 512),
    text: text(r.text, "答复"),
  };
}
export function decodeResearchTaskRetryInput(value: unknown): ResearchTaskRetryInput {
  const r = record(value, ["taskId", "reason"]);
  return { taskId: text(r.taskId, "任务", 512), reason: text(r.reason, "恢复说明") };
}
export function decodeResearchTaskResolveInput(value: unknown): ResearchTaskResolveInput {
  const r = record(value, ["attemptId", "outcome", "reason", "evidenceRef", "usedTokens"]);
  if (r.outcome !== "succeeded" && r.outcome !== "failed" && r.outcome !== "cancelled")
    throw new Error("请选择已核实的执行结果。");
  if (
    r.usedTokens !== undefined &&
    (typeof r.usedTokens !== "number" || !Number.isSafeInteger(r.usedTokens) || r.usedTokens < 0)
  )
    throw new Error("用量必须是非负整数，未知请留空。");
  return {
    attemptId: text(r.attemptId, "执行记录", 512),
    outcome: r.outcome,
    reason: text(r.reason, "核对说明"),
    evidenceRef: text(r.evidenceRef, "核对依据", 4096),
    ...(r.usedTokens === undefined ? {} : { usedTokens: r.usedTokens }),
  };
}
export function parseResearchControlTokenCount(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const count = Number(value.trim());
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(count))
    throw new Error("用量必须是非负整数，未知请留空。");
  return count;
}
export function researchTaskControlDecisionStatus(
  graph: ResearchTaskGraph,
  requestId: string,
): "pending" | "confirmed" | "declined" | "deferred" | "superseded" {
  const request = graph.decisionRequests?.find((r) => r.id === requestId);
  if (!request) throw new Error("人的决定请求不存在。");
  if (
    !graph.tasks.some((task) =>
      task.inputs.some(
        (ref) =>
          ref.inputId === request.inputId &&
          ref.version === request.version &&
          ref.requirement === "user-confirmed",
      ),
    )
  )
    return "superseded";
  if (
    !graph.adoptedInputs.some((i) => i.inputId === request.inputId && i.version === request.version)
  )
    return "superseded" as const;
  return (
    graph.decisions.filter((d) => d.requestId === requestId && d.actor === "user").at(-1)
      ?.outcome ?? "pending"
  );
}
export function researchDecisionReplyIdentity(reply: ResearchTaskDecision): string {
  if (reply.actor === "mentor-agent") return "导师 Agent 意见";
  if (reply.actor === "external-expert") return "外部专业意见";
  if (reply.origin === "prior-authorization" && reply.sourceDecisionId)
    return "用户明确沿用既有决定";
  if (reply.origin === "prior-authorization") return "已有用户授权";
  return reply.requestId && reply.outcome ? "用户答复" : "用户说明（未选择本次选项）";
}
export function projectResearchTaskControls(graph: ResearchTaskGraph) {
  const decisions = (graph.decisionRequests ?? []).map((request) => ({
    request,
    status: researchTaskControlDecisionStatus(graph, request.id),
    replies: graph.decisions.filter(
      (d) => d.inputId === request.inputId && d.version === request.version,
    ),
  }));
  return {
    decisions,
    waiting: decisions.filter((d) => d.status !== "confirmed" && d.status !== "superseded"),
    failed: graph.tasks.filter(
      (t) =>
        t.state === "failed" &&
        !graph.attempts.some(
          (a) => a.taskId === t.id && ["prepared", "running", "unknown"].includes(a.state),
        ),
    ),
    unknown: graph.attempts
      .filter((a) => a.state === "unknown")
      .map((attempt) => ({ attempt, task: graph.tasks.find((t) => t.id === attempt.taskId) })),
  };
}
