import {
  researchStages,
  RESEARCH_ROLES,
  type ResearchModel,
  type ResearchStage,
  type ResearchRole,
} from "./research-group";

export const RESEARCH_MODEL_GUIDANCE: Record<ResearchRole, string> = {
  mentor: "深度推理：界定问题、取舍研究路线与最终裁定。",
  lead: "均衡主力：推进方案、整合证据、逐条修订。",
  reviewer: "关键审阅用深度推理：反证、方法漏洞与结论边界。",
  librarian: "快速整理：检索、摘录和来源定位；复杂方法判断交给研究者复核。",
};
export const RESEARCH_LATER_STAGE_GUIDANCE = [
  { title: "文献检索与去重", model: "Flash · low", reason: "批量筛选、元数据与出处整理。" },
  {
    title: "精读、综合与研究缺口",
    model: "Sol · high；关键判断 Astra · high",
    reason: "比较证据强弱、理论关系与相反解释。",
  },
  {
    title: "研究设计与测量",
    model: "Astra · high + Sol · high",
    reason: "方法选择、效度、混杂和操作化是关键决策。",
  },
  {
    title: "数据分析",
    model: "Sol · high 执行；Astra · high 审核",
    reason: "分析代码与可复现运行交给主力，方法假设及解释单独复核。",
  },
  { title: "论文初稿", model: "Sol · high", reason: "依据已审阅的资料与分析逐章写作。" },
  {
    title: "格式、语言与引用对照",
    model: "Flash · low 整理；Sol 复核语义",
    reason: "重复核对可用快速模型；论点变化需主研究者复核。",
  },
  { title: "全文审阅", model: "Astra · high", reason: "检查全文一致性、证据边界及替代解释。" },
];

/** A starting point, not a measured ranking on the user's research tasks. */
export function recommendResearchStages(
  available: readonly { provider: string; modelId: string }[],
  preset: "balanced" | "fast" = "balanced",
  workflowVersion?: "fusion-v2",
): { stages: ResearchStage[]; missing: string[] } {
  const missing = new Set<string>();
  const model = (
    id: string,
    thinkingLevel: ResearchModel["thinkingLevel"],
  ): ResearchModel | undefined => {
    const found =
      available.find((m) => m.modelId === id && m.provider === "openai-codex") ??
      available.find((m) => m.modelId === id);
    if (!found) {
      missing.add(id);
      return undefined;
    }
    return { ...found, thinkingLevel };
  };
  const stages = researchStages({ workflowVersion });
  const criticalReviewStages =
    workflowVersion === "fusion-v2"
      ? ["scan", "question", "synthesis", "design", "analysis", "audit"]
      : ["review", "design", "analysis", "audit"];
  for (const stage of stages)
    for (const role of RESEARCH_ROLES) {
      const wanted =
        preset === "fast" || role === "librarian"
          ? model("deepseek-flash", "low")
          : role === "mentor" || (role === "reviewer" && criticalReviewStages.includes(stage.id))
            ? model("gpt-6-astra", "high")
            : model("gpt-6.1-sol", "high");
      if (wanted) stage.models[role] = wanted;
    }
  return { stages, missing: [...missing] };
}
