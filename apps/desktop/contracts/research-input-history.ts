/** Exact submitted context; never a structured answer, permission certificate or ethics approval. */
export interface ResearchUserInputContext {
  id: string;
  revision: number;
  at: string;
  text: string;
  source:
    | { kind: "explicit-submit"; actionRef: string }
    | { kind: "existing-migration"; migrationId: string; recordFile: string };
}

export function decodeResearchInputHistory(value: unknown): ResearchUserInputContext[] {
  if (!Array.isArray(value)) throw new Error("用户输入上下文记录无效。");
  const ids = new Set<string>();
  const revisions = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("用户输入上下文无效。");
    const row = item as Record<string, unknown>;
    if (
      Object.keys(row).some((key) => !["id", "revision", "at", "text", "source"].includes(key)) ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 1 ||
      revisions.has(Number(row.revision)) ||
      typeof row.at !== "string" ||
      !Number.isFinite(Date.parse(row.at)) ||
      typeof row.text !== "string" ||
      !row.text.trim() ||
      row.text.length > 64_000 ||
      !row.source ||
      typeof row.source !== "object" ||
      Array.isArray(row.source)
    )
      throw new Error("用户输入上下文身份、版本或原文无效。");
    const source = row.source as Record<string, unknown>;
    if (source.kind === "explicit-submit") {
      if (
        Object.keys(source).some((key) => !["kind", "actionRef"].includes(key)) ||
        source.actionRef !== `user-input:${row.id}`
      )
        throw new Error("用户提交来源必须对应实际输入记录。");
    } else if (source.kind === "existing-migration") {
      if (
        Object.keys(source).some((key) => !["kind", "migrationId", "recordFile"].includes(key)) ||
        typeof source.migrationId !== "string" ||
        !source.migrationId ||
        typeof source.recordFile !== "string" ||
        !source.recordFile
      )
        throw new Error("沿用迁移任务必须保留迁移记录出处。");
    } else throw new Error("未知用户输入上下文来源。");
    ids.add(row.id);
    revisions.add(Number(row.revision));
  }
  return structuredClone(value) as ResearchUserInputContext[];
}
