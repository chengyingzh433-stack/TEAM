/** Shared education-method rules only: no project materials, decisions, transcripts or model settings. */
export const SHARED_RESEARCH_METHOD_VERSION = "2.0.0" as const;
export interface SharedResearchMethodSnapshot {
  readonly source: "lancer-education-research-method";
  readonly version: string;
  readonly rules: readonly { readonly id: string; readonly text: string }[];
}
export const SHARED_RESEARCH_METHOD: SharedResearchMethodSnapshot = {
  source: "lancer-education-research-method",
  version: SHARED_RESEARCH_METHOD_VERSION,
  rules: [
    {
      id: "scope",
      text: "先明确输入成熟度和本轮交付范围；已有题目不强制重新扫描，单项任务不扩成完整研究，缺早期会话不补造已执行记录。",
    },
    {
      id: "evidence",
      text: "候选、摘要、部分正文与全文分别记录；引用须有实际阅读及出处定位，方法课程不替代研究原文，原件与旧版本保留。",
    },
    {
      id: "inference",
      text: "问题、构念、材料、方法与结论强度相互对应；检查竞争解释和相反证据，不把关联、模型审阅或计划写成已证实事实。",
    },
    {
      id: "implementation",
      text: "无实际数据仍可完成合格方案；分析与实证结论必须等待实际可用材料，保留处理、排除、缺失与复核记录。",
    },
    {
      id: "human-decision",
      text: "沿用已有授权与实际用户选择；模型建议、导师Agent裁定、人的确认和外部审批分别记录，未答复不得自动同意，只等待依赖该决定的工作。",
    },
    {
      id: "revision",
      text: "按证据修订并保留版本；语言打磨核对事实、数值、否定、因果、引文与结论强度，审阅和导出指向同一明确版本。",
    },
  ],
};

/** Copy the actual rule text; version alone is not a reproducible method snapshot. */
export function snapshotSharedResearchMethod(
  value: unknown = SHARED_RESEARCH_METHOD,
): SharedResearchMethodSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("共享方法快照无效。");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["source", "version", "rules"].includes(key)) ||
    record.source !== "lancer-education-research-method" ||
    typeof record.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(record.version) ||
    record.version.length > 64 ||
    !Array.isArray(record.rules) ||
    record.rules.length < 1 ||
    record.rules.length > 32
  )
    throw new Error("共享方法快照字段无效。");
  const rules = record.rules.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("共享方法规则无效。");
    const rule = item as Record<string, unknown>;
    if (
      Object.keys(rule).some((key) => !["id", "text"].includes(key)) ||
      typeof rule.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(rule.id) ||
      typeof rule.text !== "string" ||
      !rule.text.trim() ||
      rule.text.length > 6000 ||
      rule.text.includes("\0")
    )
      throw new Error("共享方法规则字段无效。");
    return { id: rule.id, text: rule.text };
  });
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length)
    throw new Error("共享方法规则身份重复。");
  return { source: "lancer-education-research-method", version: record.version, rules };
}

export function formatSharedResearchMethod(snapshot: SharedResearchMethodSnapshot): string {
  const pinned = snapshotSharedResearchMethod(snapshot);
  return `共享教育研究方法 ${pinned.version}（创建任务时固定的规则快照）\n${pinned.rules.map((rule) => `- [${rule.id}] ${rule.text}`).join("\n")}\n上述规则只共享方法，不共享其他项目的证据、决定或稿件；宿主适配说明不得扩大本轮范围或替换已固定的原则。`;
}
