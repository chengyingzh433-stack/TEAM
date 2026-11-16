import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";

export interface KnowledgeRecord extends Record<string, unknown> {
  id: string;
  title: string;
  text: string;
  required_context_ids: string[];
}

/** Read-only adapter. The JSONL itself, including provenance, is the pinned source. */
export class ResearchKnowledge {
  private constructor(
    readonly pin: ResearchProject["knowledge"],
    private readonly records: Map<string, KnowledgeRecord>,
  ) {}

  static async open(directory: string): Promise<ResearchKnowledge> {
    if (!isAbsolute(directory)) throw new Error("知识库需要完整的本地目录路径。");
    const index = join(directory, "索引", "知识块.jsonl");
    if ((await stat(index)).size > 25_000_000)
      throw new Error("知识库索引超过 25 MB，请拆分后接入。");
    const bytes = await readFile(index);
    const records = new Map<string, KnowledgeRecord>();
    for (const line of bytes
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())) {
      const r = JSON.parse(line) as KnowledgeRecord;
      if (
        !r ||
        typeof r.id !== "string" ||
        !r.id ||
        records.has(r.id) ||
        typeof r.title !== "string" ||
        typeof r.text !== "string" ||
        r.text.length > 100_000 ||
        !Array.isArray(r.required_context_ids) ||
        r.required_context_ids.some((id) => typeof id !== "string")
      )
        throw new Error("知识块格式错误或标识重复；原文件未修改。");
      records.set(r.id, r);
    }
    if (!records.size) throw new Error("知识库索引为空。");
    for (const r of records.values())
      for (const id of r.required_context_ids)
        if (!records.has(id)) throw new Error(`知识块 ${r.id} 缺少必要上下文 ${id}。`);
    const ledger = JSON.parse(await readFile(join(directory, "溯源", "来源清单.json"), "utf8")) as {
      version?: unknown;
    };
    return new ResearchKnowledge(
      {
        directory: resolve(directory),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        version: String(ledger.version ?? "unknown"),
        count: records.size,
      },
      records,
    );
  }

  async assertPinned(pin: ResearchProject["knowledge"]): Promise<void> {
    const bytes = await readFile(join(this.pin.directory, "索引", "知识块.jsonl"));
    if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      throw new Error("本轮知识库索引已变化。请结束本轮并开始新一轮，不能混用来源版本。");
  }

  retrieve(query: string, role: ResearchRole, ids?: string[]): KnowledgeRecord[] {
    return this.retrieveWithRoots(query, role, ids).records;
  }

  retrieveWithRoots(
    query: string,
    role: ResearchRole,
    ids?: string[],
  ): { rootIds: string[]; records: KnowledgeRecord[] } {
    let selected: string[];
    if (ids?.length) {
      if (ids.length > 8 || ids.some((id) => !this.records.has(id)))
        throw new Error("知识块标识不存在，或一次请求超过 8 块。");
      selected = ids;
    } else {
      const terms = [
        ...new Set(query.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]{2,}/gu) ?? []),
      ];
      const tokens = terms.flatMap((t) =>
        /\p{Script=Han}/u.test(t)
          ? [t, ...Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2))]
          : [t],
      );
      const scored = [...this.records.values()]
        .map((r) => {
          const title =
            `${r.title} ${String(r.topic_title ?? "")} ${JSON.stringify(r.tags ?? [])}`.toLowerCase();
          const body = r.text.toLowerCase();
          const relevance = tokens.reduce(
            (n, t) => n + (title.includes(t) ? 4 : body.includes(t) ? 1 : 0),
            0,
          );
          return {
            r,
            score: relevance
              ? relevance + (JSON.stringify(r.roles ?? []).includes(role) ? 1 : 0)
              : 0,
          };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id));
      selected = scored.slice(0, 3).map((s) => s.r.id);
    }
    const result = new Map<string, KnowledgeRecord>();
    const add = (id: string) => {
      if (result.has(id)) return;
      const r = this.records.get(id)!;
      result.set(id, structuredClone(r));
      if (result.size > 40) throw new Error("必要上下文超过 40 块，请缩小问题。");
      for (const next of r.required_context_ids) add(next);
    };
    selected.forEach(add);
    return { rootIds: [...new Set(selected)], records: [...result.values()] };
  }
}
