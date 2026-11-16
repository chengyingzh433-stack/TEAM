import { CYZ_PAPER_WORKFLOW } from "./cyz-paper-workflow";
import { SHARED_RESEARCH_METHOD_VERSION } from "./shared-research-method";
import type {
  ResearchConfig,
  ResearchStage,
  ResearchStageId,
  ResearchRole,
} from "./research-group";

/** Shared method revision. Projects pin this value; updating templates never updates a project. */
export const RESEARCH_METHOD_VERSION = SHARED_RESEARCH_METHOD_VERSION;
export const FUSION_WORKFLOW_VERSION = "fusion-v2" as const;
export const FUSION_STAGE_IDS = [
  "scan",
  "question",
  "search",
  "reading",
  "synthesis",
  "design",
  "analysis",
  "writing",
  "audit",
] as const;
export const RESEARCH_ENTRIES = ["discovery", "idea", "materials", "manuscript", "task"] as const;
export const RESEARCH_GOALS = ["direction", "question", "design", "paper", "task"] as const;
export const RESEARCH_PATHS = ["quantitative", "review", "qualitative", "theoretical"] as const;
export const RESEARCH_TASK_KINDS = [
  "reading",
  "citations",
  "design-review",
  "chapter-edit",
  "manuscript-review",
] as const;
export type ResearchSingleTaskKind = (typeof RESEARCH_TASK_KINDS)[number];
export interface ResearchSingleTask {
  kind: ResearchSingleTaskKind;
  /** Requested boundary, not evidence that source files have been parsed or protected. */
  scope: string;
}
export const RESEARCH_TASK_LABELS: Record<ResearchSingleTaskKind, string> = {
  reading: "单篇精读",
  citations: "指定引用核查",
  "design-review": "研究设计评估",
  "chapter-edit": "指定章节修改",
  "manuscript-review": "全文审阅",
};
export interface ResearchMethodConfig {
  workflowVersion?: typeof FUSION_WORKFLOW_VERSION;
  methodVersion?: typeof RESEARCH_METHOD_VERSION;
  entry?: (typeof RESEARCH_ENTRIES)[number];
  goal?: (typeof RESEARCH_GOALS)[number];
  path?: (typeof RESEARCH_PATHS)[number];
  task?: ResearchSingleTask;
}
export const RESEARCH_ENTRY_LABELS: Record<NonNullable<ResearchMethodConfig["entry"]>, string> = {
  discovery: "没有明确选题",
  idea: "已有想法",
  materials: "从材料或方案继续",
  manuscript: "审阅已有稿件",
  task: "完成单项任务",
};
export const RESEARCH_GOAL_LABELS: Record<NonNullable<ResearchMethodConfig["goal"]>, string> = {
  direction: "方向比较",
  question: "研究问题",
  design: "研究方案",
  paper: "完整论文",
  task: "指定单项任务",
};
export const RESEARCH_PATH_LABELS: Record<NonNullable<ResearchMethodConfig["path"]>, string> = {
  quantitative: "有限量化",
  review: "范围明确的文献综述",
  qualitative: "已有文本质性",
  theoretical: "理论与概念",
};

export function decodeResearchMethodConfig(value: unknown): ResearchMethodConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效研究方法配置。");
  const input = value as Record<string, unknown>;
  const result: ResearchMethodConfig = {};
  for (const [name, allowed] of [
    ["workflowVersion", [FUSION_WORKFLOW_VERSION]],
    ["methodVersion", [RESEARCH_METHOD_VERSION]],
    ["entry", RESEARCH_ENTRIES],
    ["goal", RESEARCH_GOALS],
    ["path", RESEARCH_PATHS],
  ] as const) {
    if (input[name] === undefined) continue;
    if (!(allowed as readonly unknown[]).includes(input[name]))
      throw new Error(`无效研究方法配置：${name}。`);
    Object.assign(result, { [name]: input[name] });
  }
  if (input.task !== undefined) {
    if (!input.task || typeof input.task !== "object" || Array.isArray(input.task))
      throw new Error("无效单项研究任务。");
    const task = input.task as Record<string, unknown>;
    if (
      Object.keys(task).some((key) => !["kind", "scope"].includes(key)) ||
      !(RESEARCH_TASK_KINDS as readonly unknown[]).includes(task.kind) ||
      typeof task.scope !== "string" ||
      !task.scope.trim() ||
      task.scope.length > 6000
    )
      throw new Error("请选择有效单项任务并说明非空范围（最多6000字）。");
    result.task = { kind: task.kind as ResearchSingleTaskKind, scope: task.scope.trim() };
  }
  if (!result.workflowVersion && Object.keys(result).length)
    throw new Error("新研究入口与方法需要明确的融合流程版本。");
  return result;
}

/** Derive method navigation without altering the saved legacy stages or inventing execution. */
export function fusionResearchStages(
  config: Pick<ResearchConfig, "models" | "stages" | "path"> = {},
): ResearchStage[] {
  return FUSION_STAGE_IDS.map((id, index) => {
    const guide = CYZ_PAPER_WORKFLOW.steps[index]!;
    if (!guide.goal || !guide.deliverables) throw new Error("共享方法缺少阶段目标或交付要求。");
    const saved = config.stages?.find((stage) => stage.id === id);
    const inherited = ["search", "reading", "synthesis"].includes(id)
      ? config.stages?.find((stage) => stage.id === "literature")
      : undefined;
    const pathAnalysis =
      id === "analysis" && config.path && config.path !== "quantitative"
        ? {
            review: {
              title: "文献证据综合",
              goal: "按明确范围比较原文、研究质量与相反证据，形成有限综述。",
              deliverables: "可定位综合记录、纳排与质量判断、B复核和导师裁定；不要求CSV。",
            },
            qualitative: {
              title: "文本主题分析",
              goal: "按反思性主题分析取向处理允许研究使用的文本，记录片段、编码、主题和反例。",
              deliverables: "片段—编码—主题—主张链、研究者反思、B复核和导师裁定；不机械要求Kappa。",
            },
            theoretical: {
              title: "概念与论证分析",
              goal: "澄清概念、前提和推导，检查竞争解释及反例。",
              deliverables: "可追溯概念与论证记录、竞争解释、B复核和导师裁定；不虚构经验结果。",
            },
          }[config.path]
        : undefined;
    return {
      id,
      title:
        saved?.title && saved.title !== guide.title
          ? saved.title
          : (pathAnalysis?.title ?? guide.title),
      goal:
        saved?.goal && saved.goal !== guide.goal ? saved.goal : (pathAnalysis?.goal ?? guide.goal),
      deliverables:
        saved?.deliverables && saved.deliverables !== guide.deliverables
          ? saved.deliverables
          : (pathAnalysis?.deliverables ?? guide.deliverables),
      models: structuredClone(saved?.models ?? inherited?.models ?? config.models ?? {}),
    };
  });
}

export interface ResearchEntryInventory {
  /** Must come from an actual material/accepted-output inspection, not an entry label. */
  firstMissingStage: (typeof FUSION_STAGE_IDS)[number];
  evidenceRef: string;
}
export interface ResearchInventorySnapshot extends ResearchEntryInventory {
  revision: number;
  checkedAt: string;
  canStart: boolean;
  reusable: string[];
  pending: string[];
  missing: string[];
  limitations: string[];
}
export interface ResearchExecutionRoute {
  startStage: (typeof FUSION_STAGE_IDS)[number];
  endStage: (typeof FUSION_STAGE_IDS)[number];
  stageIds: (typeof FUSION_STAGE_IDS)[number][];
  mode: "research" | "single-task";
  requiredRoles: ResearchRole[];
  needsInventory: boolean;
  blockedReasons: string[];
  reason: string;
}

export function defaultResearchGoal(
  entry: ResearchMethodConfig["entry"],
): NonNullable<ResearchMethodConfig["goal"]> {
  return entry === "discovery"
    ? "direction"
    : entry === "task" || entry === "manuscript"
      ? "task"
      : "design";
}

/** One bounded route is shared by entry selection, progression, and completion. No execution is inferred. */
export function researchExecutionRoute(
  config: ResearchMethodConfig,
  inventory?: ResearchEntryInventory,
): ResearchExecutionRoute {
  const entry = config.entry ?? "idea";
  const goal = config.goal ?? defaultResearchGoal(entry);
  const single = goal === "task" || entry === "task";
  const blockedReasons: string[] = [];
  if (entry === "task" && goal !== "task")
    blockedReasons.push("单项任务入口需要选择“指定单项任务”目标；完整研究请更换入口。");
  if (single && (!config.task || !config.task.scope.trim()))
    blockedReasons.push("请指定单项任务类型和材料、引用或章节范围。");
  const taskStages: Record<ResearchSingleTaskKind, (typeof FUSION_STAGE_IDS)[number]> = {
    reading: "reading",
    citations: "audit",
    "design-review": "design",
    "chapter-edit": "writing",
    "manuscript-review": "audit",
  };
  if (single) {
    const stage = config.task
      ? taskStages[config.task.kind]
      : entry === "manuscript"
        ? "audit"
        : "reading";
    return {
      startStage: stage,
      endStage: stage,
      stageIds: [stage],
      mode: "single-task",
      requiredRoles: ["lead", "reviewer", "mentor"],
      needsInventory: false,
      blockedReasons,
      reason: "只处理所指定范围；该路由不表示材料已解析、未选章节已受保护或内容已核验。",
    };
  }
  const validInventory =
    inventory &&
    FUSION_STAGE_IDS.includes(inventory.firstMissingStage) &&
    inventory.evidenceRef.trim()
      ? inventory
      : undefined;
  const needsInventory = entry === "materials" && !validInventory;
  const endStage =
    goal === "direction"
      ? entry === "discovery"
        ? "scan"
        : "question"
      : goal === "question"
        ? "question"
        : goal === "design"
          ? "design"
          : "audit";
  let startStage: (typeof FUSION_STAGE_IDS)[number] =
    entry === "discovery"
      ? "scan"
      : entry === "manuscript"
        ? "audit"
        : (validInventory?.firstMissingStage ?? "question");
  // Asking for an earlier deliverable means revisiting that deliverable, never an unreachable endpoint.
  if (FUSION_STAGE_IDS.indexOf(startStage) > FUSION_STAGE_IDS.indexOf(endStage))
    startStage = endStage;
  return {
    startStage,
    endStage,
    stageIds: FUSION_STAGE_IDS.slice(
      FUSION_STAGE_IDS.indexOf(startStage),
      FUSION_STAGE_IDS.indexOf(endStage) + 1,
    ),
    mode: "research",
    requiredRoles: ["mentor", "lead", "reviewer", "librarian"],
    needsInventory,
    blockedReasons,
    reason: needsInventory
      ? "先清点实际材料和有效成果，再定位最早缺失条件；仅选择材料入口不证明方案或上游研究已完成。"
      : goal === "direction" && entry !== "discovery"
        ? "围绕已有想法比较候选问题，在S1完成本轮；不重新做宽泛S0扫描。"
        : "从当前输入成熟度推进到明确目标；跳过的阶段不生成完成记录。",
  };
}

/** Compatibility entry point; coordinators must also consume route.endStage and needsInventory. */
export function researchEntryStage(
  config: ResearchMethodConfig,
  inventory?: ResearchEntryInventory,
): ResearchStageId {
  return researchExecutionRoute(config, inventory).startStage;
}
export function researchGoalStage(
  config: ResearchMethodConfig,
  inventory?: ResearchEntryInventory,
): ResearchStageId {
  return researchExecutionRoute(config, inventory).endStage;
}

/** Saved templates and projects keep their original workflow; only genuinely new setups default to fusion. */
export function researchEditorWorkflow(
  config: ResearchMethodConfig,
  context: "new" | "saved" | "project",
): ResearchMethodConfig["workflowVersion"] {
  return context === "new" ? FUSION_WORKFLOW_VERSION : config.workflowVersion;
}
