import type {
  ResearchDecisionRequest,
  ResearchTaskDecision,
  ResearchTaskGraph,
} from "./research-task-graph";

/** A UI action only. Models may reference context, but cannot submit this mapping. */
export interface ResearchTaskReuseDecisionInput {
  requestId: string;
  optionId: string;
  sourceDecisionId: string;
  expectedContextToken: string;
}
export function decodeResearchTaskReuseDecisionInput(
  value: unknown,
): ResearchTaskReuseDecisionInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("沿用决定操作无效。");
  const raw = value as Record<string, unknown>;
  const keys = ["requestId", "optionId", "sourceDecisionId", "expectedContextToken"] as const;
  if (
    Reflect.ownKeys(raw).some(
      (key) => typeof key !== "string" || !keys.includes(key as (typeof keys)[number]),
    )
  )
    throw new Error("沿用操作含未知字段；身份、结果和出处由宿主核对。");
  for (const key of keys)
    if (
      typeof raw[key] !== "string" ||
      !raw[key].trim() ||
      raw[key].includes("\0") ||
      raw[key].length > (key === "expectedContextToken" ? 8_000_000 : 512)
    )
      throw new Error(`沿用决定的 ${key} 无效。`);
  return {
    requestId: raw.requestId as string,
    optionId: raw.optionId as string,
    sourceDecisionId: raw.sourceDecisionId as string,
    expectedContextToken: raw.expectedContextToken as string,
  };
}

function currentRequest(graph: ResearchTaskGraph, request: ResearchDecisionRequest) {
  return graph.adoptedInputs.some(
    (input) => input.inputId === request.inputId && input.version === request.version,
  );
}
function latestReply(graph: ResearchTaskGraph, requestId: string) {
  return graph.decisions
    .filter((reply) => reply.requestId === requestId && reply.actor === "user")
    .at(-1);
}
/** No inference from text: only host-recorded explicit choices with a complete, still-valid chain. */
function validSource(
  graph: ResearchTaskGraph,
  decision: ResearchTaskDecision,
  seen = new Set<string>(),
): boolean {
  if (seen.has(decision.id)) return false;
  seen.add(decision.id);
  const request = graph.decisionRequests?.find((item) => item.id === decision.requestId);
  if (
    !request ||
    decision.actor !== "user" ||
    decision.outcome !== "confirmed" ||
    decision.inputId !== request.inputId ||
    decision.version !== request.version ||
    !currentRequest(graph, request) ||
    latestReply(graph, request.id)?.id !== decision.id ||
    !request.options.some(
      (option) => option.id === decision.optionId && option.outcome === "confirmed",
    ) ||
    decision.evidenceRef !== `user-action:${decision.id}`
  )
    return false;
  if (decision.origin === "new-reply") return !decision.sourceDecisionId;
  if (decision.origin !== "prior-authorization" || !decision.sourceDecisionId) return false;
  const source = graph.decisions.find((item) => item.id === decision.sourceDecisionId);
  return !!source && validSource(graph, source, seen);
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
export function projectResearchDecisionReuse(graph: ResearchTaskGraph, requestId: string) {
  const request = graph.decisionRequests?.find((item) => item.id === requestId);
  if (!request) throw new Error("当前决定请求不存在。");
  const available =
    currentRequest(graph, request) && latestReply(graph, request.id)?.outcome !== "confirmed";
  const candidates = available
    ? graph.decisions
        .filter((decision) => decision.requestId !== requestId && validSource(graph, decision))
        .map((decision) => ({
          decision,
          request: graph.decisionRequests!.find((item) => item.id === decision.requestId)!,
        }))
    : [];
  const token = JSON.stringify(
    stable({
      projectId: graph.projectId,
      request,
      adoptedInputs: graph.adoptedInputs,
      requests: graph.decisionRequests,
      decisions: graph.decisions,
      tasks: graph.tasks.map(({ id, stage, role, goal, inputVersion, inputs, dependencies }) => ({
        id,
        stage,
        role,
        goal,
        inputVersion,
        inputs,
        dependencies,
      })),
    }),
  );
  return { token, request, available, candidates };
}
export function validateResearchDecisionReuse(
  graph: ResearchTaskGraph,
  raw: ResearchTaskReuseDecisionInput,
) {
  const input = decodeResearchTaskReuseDecisionInput(raw);
  const projected = projectResearchDecisionReuse(graph, input.requestId);
  if (!projected.available || projected.token !== input.expectedContextToken)
    throw new Error("当前条件或既有决定已变化，请重新查看后沿用。");
  const source = projected.candidates.find((item) => item.decision.id === input.sourceDecisionId);
  if (!source) throw new Error("来源不是仍有效且有出处的真实用户确认，不能沿用。");
  const option = projected.request.options.find((item) => item.id === input.optionId);
  if (!option || option.outcome !== "confirmed")
    throw new Error("沿用确认只能映射到本次明确允许继续的选项；其他选择请直接答复。");
  return { input, source, request: projected.request, option };
}
