import { settleResearchUsage, type ResearchTokenCounts } from "../../contracts/research-usage";
import { randomUUID } from "node:crypto";
import type {
  ResearchGroupsState,
  ResearchProject,
  ResearchRole,
} from "../../contracts/research-group";
import type { ResearchLegacyExecution } from "../../contracts/research-m3";

export const activeLegacyExecution = (
  state: Pick<ResearchGroupsState, "m3">,
  projectId: string,
  role: ResearchRole,
) =>
  state.m3?.legacyExecutions
    ?.filter(
      (a) =>
        a.projectId === projectId &&
        a.role === role &&
        ["prepared", "running", "unknown"].includes(a.state),
    )
    .at(-1);
export const legacyProjectSettings = (state: Pick<ResearchGroupsState, "m3">, projectId: string) =>
  state.m3?.legacySettings?.find((s) => s.projectId === projectId);
export const researchRequestReservation = (prompt: string) => Math.ceil(prompt.length / 2) + 4096;

/** The caller persists this reservation under the same owner used by fusion admission. */
export function reserveLegacyExecution(
  state: ResearchGroupsState,
  p: ResearchProject,
  role: ResearchRole,
  prompt: string,
  at: string,
): ResearchLegacyExecution {
  const call: ResearchLegacyExecution = {
    id: randomUUID(),
    projectId: p.id,
    revision: p.revision,
    role,
    state: "prepared",
    preparedAt: at,
    reservedTokens: researchRequestReservation(prompt),
  };
  ((state.m3 ??= {}).legacyExecutions ??= []).push(call);
  return call;
}
export function queueLegacyExecution(
  state: ResearchGroupsState,
  p: ResearchProject,
  role: ResearchRole,
  text: string,
  reason: string,
  at: string,
  delivery: "steer" | "followUp" = "steer",
): void {
  const queue = ((state.m3 ??= {}).legacyQueue ??= []);
  const prior = queue.find(
    (q) =>
      q.projectId === p.id &&
      q.revision === p.revision &&
      q.role === role &&
      q.text === text &&
      (q.delivery ?? "steer") === delivery,
  );
  if (prior) prior.reason = reason;
  else queue.push({ projectId: p.id, revision: p.revision, role, text, reason, at, delivery });
}
export function settleLegacyExecution(
  state: ResearchGroupsState,
  call: ResearchLegacyExecution,
  outcome: "succeeded" | "failed" | "cancelled",
  at: string,
  total?: number,
  counts?: ResearchTokenCounts,
): void {
  call.state = outcome;
  call.finishedAt = at;
  const index = state.m3?.legacyExecutions?.findIndex((a) => a.id === call.id) ?? -1;
  const previous = state.m3?.legacyExecutions
    ?.slice(0, index)
    .filter((a) => !(a.usedTokens === 0 && !a.nativeRunId && a.sessionTotalTokens === undefined))
    .filter((a) => a.projectId === call.projectId && a.role === call.role)
    .at(-1);
  settleResearchUsage(call, previous, total, counts);
}
