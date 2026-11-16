import type { ResearchGroupsState, ResearchProject } from "./research-group";
import { RESEARCH_TOKEN_BUCKETS, type ResearchTokenCounts } from "./research-usage";

export function researchUsageRows(state: ResearchGroupsState, project: ResearchProject) {
  const fusion = (project.fusion?.attempts ?? []).map((attempt) => ({
    id: attempt.id,
    task: attempt.taskId,
    member: project.fusion!.tasks.find((t) => t.id === attempt.taskId)?.role ?? "unknown",
    state: attempt.state,
    usedTokens: attempt.usedTokens,
    reservedTokens: attempt.reservedTokens,
    tokenUsage: attempt.tokenUsage,
  }));
  const legacy = (state.m3?.legacyExecutions ?? [])
    .filter((call) => call.projectId === project.id)
    .map((call) => ({
      id: call.id,
      task: `旧流程 v${call.revision}`,
      member: call.role,
      state: call.state,
      usedTokens: call.usedTokens,
      reservedTokens: call.reservedTokens,
      tokenUsage: call.tokenUsage,
    }));
  return [...fusion, ...legacy];
}
export function researchUsageSummary(rows: ReturnType<typeof researchUsageRows>) {
  const buckets: ResearchTokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of rows)
    if (row.tokenUsage)
      for (const key of RESEARCH_TOKEN_BUCKETS) buckets[key] += row.tokenUsage[key];
  return {
    attempts: rows.length,
    knownTokens: rows.reduce((n, row) => n + (row.usedTokens ?? 0), 0),
    unresolved: rows.filter((row) => row.usedTokens === undefined).length,
    reservedTokens: rows.reduce(
      (n, row) =>
        n +
        (["prepared", "running", "unknown"].includes(row.state) || row.usedTokens === undefined
          ? Math.max(0, row.reservedTokens - (row.usedTokens ?? 0))
          : 0),
      0,
    ),
    missingBreakdown: rows.filter((row) => row.usedTokens !== undefined && !row.tokenUsage).length,
    buckets,
  };
}
