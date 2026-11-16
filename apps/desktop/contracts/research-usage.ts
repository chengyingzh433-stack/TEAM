/** Provider counters, not estimates or monetary charges. */
export interface ResearchTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface ResearchUsageRecord {
  usedTokens?: number;
  sessionTotalTokens?: number;
  tokenUsage?: ResearchTokenCounts;
  sessionTokenUsage?: ResearchTokenCounts;
}
export const RESEARCH_TOKEN_BUCKETS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export function validateResearchUsage(row: ResearchUsageRecord): void {
  for (const counts of [row.tokenUsage, row.sessionTokenUsage]) {
    if (counts === undefined) continue;
    if (
      !counts ||
      typeof counts !== "object" ||
      Array.isArray(counts) ||
      Object.keys(counts).some(
        (key) => !RESEARCH_TOKEN_BUCKETS.includes(key as (typeof RESEARCH_TOKEN_BUCKETS)[number]),
      ) ||
      RESEARCH_TOKEN_BUCKETS.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0) ||
      !Number.isSafeInteger(RESEARCH_TOKEN_BUCKETS.reduce((sum, key) => sum + counts[key], 0))
    )
      throw new Error("执行用量分项无效，原记录保留。");
  }
  if (
    row.tokenUsage &&
    RESEARCH_TOKEN_BUCKETS.reduce((sum, key) => sum + row.tokenUsage![key], 0) !== row.usedTokens
  )
    throw new Error("用量分项与实际总数不符。");
  if (
    row.sessionTokenUsage &&
    RESEARCH_TOKEN_BUCKETS.reduce((sum, key) => sum + row.sessionTokenUsage![key], 0) !==
      row.sessionTotalTokens
  )
    throw new Error("会话累计分项与总数不符。");
}
/** Never attribute an unknown earlier call's consumption to this call. */
export function settleResearchUsage(
  row: ResearchUsageRecord,
  previous: ResearchUsageRecord | undefined,
  total: number | undefined,
  counts?: ResearchTokenCounts,
): number | undefined {
  if (row.sessionTotalTokens !== undefined) return row.usedTokens;
  if (total === undefined || !Number.isSafeInteger(total) || total < 0) return undefined;
  if (counts) {
    counts = {
      input: counts.input,
      output: counts.output,
      cacheRead: counts.cacheRead,
      cacheWrite: counts.cacheWrite,
    };
    try {
      validateResearchUsage({ sessionTotalTokens: total, sessionTokenUsage: counts });
    } catch {
      return undefined;
    }
  }
  const baseline = previous?.sessionTotalTokens;
  if (baseline !== undefined && total < baseline) return undefined;
  if (
    counts &&
    previous?.sessionTokenUsage &&
    RESEARCH_TOKEN_BUCKETS.some((key) => counts[key] < previous.sessionTokenUsage![key])
  )
    return undefined;
  row.sessionTotalTokens = total;
  if (counts)
    row.sessionTokenUsage = {
      input: counts.input,
      output: counts.output,
      cacheRead: counts.cacheRead,
      cacheWrite: counts.cacheWrite,
    };
  if (previous && baseline === undefined) return undefined;
  const used = total - (baseline ?? 0);
  // Explicit human reconciliation remains authoritative; don't relabel it with a later snapshot.
  if (row.usedTokens !== undefined && row.usedTokens !== used) return row.usedTokens;
  row.usedTokens = used;
  if (counts && (!previous || previous.sessionTokenUsage)) {
    row.tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const key of RESEARCH_TOKEN_BUCKETS)
      row.tokenUsage[key] = counts[key] - (previous?.sessionTokenUsage?.[key] ?? 0);
  }
  return used;
}
