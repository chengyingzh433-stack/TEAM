import type { LancerWorkflow } from "./lancer-workflows";
import { snapshotSharedResearchMethod } from "./shared-research-method";

export const CYZ_PAPER_MODULE_ID = "cyz-paper";
export const CYZ_GUIDE_PREFIX = "cyz-edu-research/";
export type CyzStageId = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";
export type CyzGuideId = `${typeof CYZ_GUIDE_PREFIX}${CyzStageId}`;

export function isCyzGuideId(value: unknown): value is CyzGuideId {
  return typeof value === "string" && /^cyz-edu-research\/S[0-8]$/.test(value);
}

/** Stable guide identifiers travel with edited/reordered stages, never with array positions. */
export const CYZ_PAPER_WORKFLOW: LancerWorkflow = {
  method: snapshotSharedResearchMethod(),
  steps: [
    {
      title: "S0 领域扫描与灵感发现",
      guide: "cyz-edu-research/S0",
      goal: "尚未明确选题时，哪些教育研究方向值得探索，并且适合我的教学场景、时间和可获得的材料？已有文献提供了哪些线索，哪些仍只是初步设想？",
      deliverables:
        "交付：有依据的候选方向及比较，说明推荐理由、需要的材料和下一步。\n验收：每个方向标明来源或设想依据、可行性及不确定性；不凑数量，不把候选方向当成已证实的创新点。方向选择由我确认。",
    },
    {
      title: "S1 实践问题与研究问题",
      guide: "cyz-edu-research/S1",
      goal: "如何把我现有的教学困惑、题目或方案变成可回答的研究问题？对象、情境、核心概念和所需证据是否清楚，是否存在更合理的解释？",
      deliverables:
        "交付：问题卡，包含研究问题、范围、所需证据、备选解释和待决定项。\n验收：与原想法及已有材料对应，说明可行性和结论边界；未经我确认的方向保留为建议，证据缺口列为待核验。",
    },
    {
      title: "S2 文献检索设计",
      guide: "cyz-edu-research/S2",
      goal: "围绕本轮问题，应查哪些概念、来源和文献范围？已有检索还缺什么，怎样让检索可以复现，并避免无休止地扩大范围？",
      deliverables:
        "交付：检索方案，以及本轮实际执行的检索记录和待执行项。\n验收：写明来源、检索式、日期、筛选范围及停止条件；计划与已执行分开，结果数量和访问限制有真实依据。",
    },
    {
      title: "S3 文献筛选与分级阅读",
      guide: "cyz-edu-research/S3",
      goal: "本轮指定的论文研究了什么、怎样研究、发现了什么？哪些内容与我的问题相关，哪些判断需要全文或原始图表才能确认？",
      deliverables:
        "交付：本轮论文的阅读笔记；涉及筛选时附纳入或排除理由。\n验收：说明实际读到的范围，关键判断指向原文页码或段落；区分作者结论、我的理解和模型建议，无法核验处明确保留。",
    },
    {
      title: "S4 文献综合与研究缺口",
      guide: "cyz-edu-research/S4",
      goal: "这些文献有哪些共识、分歧和适用条件？拟研究的问题是否仍未解决，还是已有研究已经给出答案？这个判断对选题有什么影响？",
      deliverables:
        "交付：按主题组织的证据对照和候选研究缺口，附对当前选题的建议。\n验收：主张能追溯到来源，包含相反证据及适用条件；尚未做反证检索的缺口标为待核验，不以文献数量少证明创新。",
    },
    {
      title: "S5 研究设计",
      guide: "cyz-edu-research/S5",
      goal: "要回答当前研究问题，应该取得什么证据，用什么方法才合适？方案能否在我的条件下实施，哪些结论是这种设计无法支持的？",
      deliverables:
        "交付：本轮研究方案或方案修订，列明问题、证据、获取方式和分析的对应关系。\n验收：方法适合研究类型，所需条件可落实；涉及人员或学生数据时说明必要伦理安排；已有材料与计划采集分开，写明结论边界。",
    },
    {
      title: "S6 数据收集与分析",
      guide: "cyz-edu-research/S6",
      goal: "现有数据或研究材料能够支持哪些结果，怎样让处理和分析可复核？缺失、异常或相反结果会如何影响解释？没有数据时，本轮能先完成什么计划？",
      deliverables:
        "交付：已执行的处理记录、分析结果与解释；没有数据时交付分析计划。\n验收：原始材料保留，结果可追溯到数据、代码或编码证据；披露排除、缺失、反例及不确定性，计划不得写成已取得的结果。",
    },
    {
      title: "S7 论文写作与语言打磨",
      guide: "cyz-edu-research/S7",
      goal: "本轮指定的章节或段落要表达什么，已有证据是否足够？怎样让论证和语言更清楚，同时保留我的观点、事实、引用及结论的确定程度？",
      deliverables:
        "交付：约定范围的草稿或修订稿、修改说明及待补材料；保留改写前版本。\n验收：数字、引文、术语和结论强度与依据一致，缺证据处明确标注；说明模型已检查的范围及仍需我复核的地方。",
    },
    {
      title: "S8 全文审查与正式输出",
      guide: "cyz-edu-research/S8",
      goal: "当前稿件或指定部分有哪些证据、引用、数字、方法和结论不一致的问题？哪些会影响可信度，哪些只需调整表达或格式？本轮是否需要导出文件？",
      deliverables:
        "交付：审查清单，逐项列出位置、依据和处理建议；需要且能够导出时附对应文件。\n验收：说明所审版本、范围和未解决问题；局部检查不称全文通过，结构检查不等于学术通过，导出内容须与已审版本一致。",
    },
  ],
};
