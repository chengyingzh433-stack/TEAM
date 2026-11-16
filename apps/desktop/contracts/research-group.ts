import { decodeResearchDiscussionInput, type ResearchDiscussionInput } from "./research-discussion";
import {
  decodeArchiveSelection,
  type ResearchArchiveSelection,
  type ResearchArchiveReceipt,
} from "./research-archive";
import {
  decodeResearchTaskAnswerInput,
  decodeResearchTaskRetryInput,
  decodeResearchTaskResolveInput,
} from "./research-task-controls";
import type {
  ResearchTaskAnswerInput,
  ResearchTaskRetryInput,
  ResearchTaskResolveInput,
} from "./research-task-controls";
import {
  decodeMaterialAdoptionDeclaration,
  decodeMaterialRecoveryRequest,
} from "./research-materials";
import type { MaterialAdoptionDeclaration, MaterialRecoveryRequest } from "./research-materials";
import type { ResearchTaskGraph } from "./research-task-graph";
import { decodeResearchM3Action } from "./research-m3";
import type {
  ResearchM3Action,
  ResearchM3Application,
  ResearchM3Project,
  ResearchModelSource,
} from "./research-m3";
import type { ResearchAnalysisRegistry } from "./research-analysis-registry";
import type { ResearchClaims, ResearchClaimActualRead } from "./research-claims";
import type { ResearchContentCheckRecord } from "./research-content-checks";
import type { ResearchSourcePageRecords } from "./research-source-pages";
import type { ResearchSynthesis } from "./research-synthesis";
import type { ResearchLanguageRevision } from "./research-language-revisions";
import {
  decodeResearchLanguageSelection,
  type ResearchLanguageSelection,
  type ResearchLanguageScope,
  type ResearchLanguageHostRead,
  type ResearchLanguageDisposition,
} from "./research-language-tools";
import type { ResearchMethodProgramCheck } from "./research-method-checks";
import type { ResearchAnalysisReuseRecords } from "./research-analysis-reuse";
import type {
  ResearchLiteratureSearch,
  ResearchLiteratureToolOperation,
  ResearchLiteratureRecordReading,
} from "./research-literature-search";
import type {
  ResearchMethodPackage,
  ResearchMethodApplication,
  ResearchMethodImageReading,
  ResearchMethodImageReceipt,
  ResearchMethodContentOpinion,
  ResearchMethodAdjudication,
  ResearchMethodPackageUse,
} from "./research-method-packages";
import type {
  ResearchNumericBinding,
  ResearchNumericCandidateReview,
  ResearchResultFieldMetadata,
} from "./research-numeric-bindings";
import type { ResearchUserInputContext } from "./research-input-history";
import type { SharedResearchMethodSnapshot } from "./shared-research-method";
import {
  decodeResearchTaskReuseDecisionInput,
  type ResearchTaskReuseDecisionInput,
} from "./research-decision-reuse";
import {
  decodeResearchLegacyMigrationIntent,
  decodeResearchLegacyMigrationCommit,
  type ResearchLegacyMigrationIntent,
  type ResearchLegacyMigrationCommit,
} from "./research-legacy-migration";
import {
  decodeResearchMaterialChangeCommit,
  decodeResearchMaterialChangeRequest,
} from "./research-material-impact";
import type {
  ResearchMaterialChangeCommit,
  ResearchMaterialChangeRequest,
} from "./research-material-impact";
import type { ImportedResearchMaterial } from "./research-materials";
import {
  FUSION_STAGE_IDS,
  fusionResearchStages,
  decodeResearchMethodConfig,
} from "./research-method";
import type { ResearchMethodConfig, ResearchInventorySnapshot } from "./research-method";
import type { SessionRef } from "@lancer/session-driver";
import type {
  ResearchEvidence,
  ResearchAnalysisRun,
  ResearchAnalysisSpec,
} from "./research-evidence";

export const RESEARCH_GROUP_ZONE = "edu-research-group";
export const RESEARCH_ROLES = ["mentor", "lead", "reviewer", "librarian"] as const;
export type ResearchRole = (typeof RESEARCH_ROLES)[number];
export const RESEARCH_ROLE_LABELS: Record<ResearchRole, string> = {
  mentor: "导师",
  lead: "研究者 A · 推进",
  reviewer: "研究者 B · 复核",
  librarian: "资料员",
};
export type ResearchArtifactKind =
  | "plan"
  | "proposal"
  | "assessment"
  | "material"
  | "critique"
  | "revision"
  | "verification"
  | "review"
  | "stage-draft"
  | "stage-risk"
  | "stage-material"
  | "stage-critique"
  | "stage-revision"
  | "stage-verification"
  | "stage-review";
export interface ResearchModel {
  provider: string;
  modelId: string;
  thinkingLevel?: ResearchThinkingLevel;
}
export const RESEARCH_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ResearchThinkingLevel = (typeof RESEARCH_THINKING_LEVELS)[number];
export const RESEARCH_STAGE_IDS = [
  "question",
  "review",
  "literature",
  "design",
  "analysis",
  "writing",
  "audit",
] as const;
export type ResearchRunScope = "proposal" | "paper";
export type ResearchStageId =
  (typeof RESEARCH_STAGE_IDS)[number] | (typeof FUSION_STAGE_IDS)[number];
export function isResearchStageId(value: unknown): value is ResearchStageId {
  return [...RESEARCH_STAGE_IDS, ...FUSION_STAGE_IDS].some((id) => id === value);
}
export interface ResearchStage {
  id: ResearchStageId;
  title: string;
  goal: string;
  deliverables: string;
  models: Partial<Record<ResearchRole, ResearchModel>>;
}
export const DEFAULT_RESEARCH_STAGES: readonly ResearchStage[] = [
  {
    id: "question",
    title: "研究问题打磨",
    goal: "把实践困惑收敛成可回答的问题，独立判断风险，明确对象、概念、证据与现实条件。",
    deliverables: "导师边界、A 独立初稿、B 独立风险判断、资料员的方法依据。",
    models: {},
  },
  {
    id: "review",
    title: "初步方案审阅",
    goal: "检查问题—证据—方法—结论的一致性，提出具体批评，完成修订、逐条复核与导师裁定。",
    deliverables: "批评、完整修订、复核结论与导师裁定；未解决问题和采集前关口。",
    models: {},
  },
  {
    id: "literature",
    title: "文献综合",
    goal: "读取原文，比较证据、理论和相反解释，形成有出处的研究缺口。",
    deliverables: "来源矩阵、综合稿、独立质疑、修订与导师裁定；元数据不冒充全文。",
    models: {},
  },
  {
    id: "design",
    title: "研究设计",
    goal: "冻结问题、数据、变量、分析方法与判断规则，确认数据来源和可实施条件。",
    deliverables: "可执行研究方案、数据字典和分析计划；缺数据或许可则暂缓。",
    models: {},
  },
  {
    id: "analysis",
    title: "数据分析",
    goal: "对已登记数据实际计算、记录缺失处理与参数，由 B 复算检查。",
    deliverables: "真实计算记录、结果表、复算及解释边界；不编造未运行的检验。",
    models: {},
  },
  {
    id: "writing",
    title: "论文写作",
    goal: "依据已审阅的来源、方案和实际计算，形成完整论文。",
    deliverables: "题目、摘要、引言、文献、方法、结果、讨论、结论、参考文献；逐项可追溯。",
    models: {},
  },
  {
    id: "audit",
    title: "全文审阅",
    goal: "审阅全文一致性、数字和引用，修订后交付可追溯终稿。",
    deliverables: "完整终稿、逐项复核、导师终审与导出文件；演练数据显著标注。",
    models: {},
  },
];
export function researchStages(
  config: {
    models?: ResearchConfig["models"];
    stages?: readonly ResearchStage[];
    workflowVersion?: ResearchMethodConfig["workflowVersion"];
    path?: ResearchMethodConfig["path"];
  } = {},
): ResearchStage[] {
  if (config.workflowVersion === "fusion-v2")
    return fusionResearchStages({
      ...config,
      stages: config.stages ? [...config.stages] : undefined,
    });
  return DEFAULT_RESEARCH_STAGES.map((base) => {
    const saved = config.stages?.find((stage) => stage.id === base.id);
    return {
      ...base,
      ...saved,
      models: {
        ...(saved?.models ??
          config.models ??
          config.stages?.find((s) => s.id === "review")?.models ??
          {}),
      },
    };
  });
}
function decodeResearchModels(value: unknown): ResearchConfig["models"] {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效成员模型。");
  const record = value as Record<string, ResearchModel | undefined>;
  if (Object.keys(record).some((role) => !RESEARCH_ROLES.includes(role as ResearchRole)))
    throw new Error("未知课题组成员。");
  const models: ResearchConfig["models"] = {};
  for (const role of RESEARCH_ROLES) {
    const m = record[role];
    if (m === undefined) continue;
    if (
      !m ||
      typeof m.provider !== "string" ||
      !m.provider.trim() ||
      m.provider.length > 200 ||
      typeof m.modelId !== "string" ||
      !m.modelId.trim() ||
      m.modelId.length > 512 ||
      (m.thinkingLevel !== undefined && !RESEARCH_THINKING_LEVELS.includes(m.thinkingLevel))
    )
      throw new Error("无效成员模型或思考强度。");
    models[role] = {
      provider: m.provider.trim(),
      modelId: m.modelId.trim(),
      ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
    };
  }
  return models;
}
export function decodeResearchStages(
  value: unknown,
  workflowVersion?: ResearchMethodConfig["workflowVersion"],
): ResearchStage[] {
  const fusion = workflowVersion === "fusion-v2";
  if (!Array.isArray(value) || !(fusion ? [9] : [2, 7]).includes(value.length))
    throw new Error("研究阶段配置需要包含旧流程两个／七个阶段，或明确选择融合流程的九个阶段。");
  const ids = fusion
    ? FUSION_STAGE_IDS
    : value.length === 2
      ? RESEARCH_STAGE_IDS.slice(0, 2)
      : RESEARCH_STAGE_IDS;
  return ids.map((id) => {
    const stage = value.find(
      (s: unknown) => !!s && typeof s === "object" && "id" in s && s.id === id,
    ) as ResearchStage | undefined;
    if (
      !stage ||
      value.filter((s: unknown) => !!s && typeof s === "object" && "id" in s && s.id === id)
        .length !== 1 ||
      typeof stage.title !== "string" ||
      !stage.title.trim() ||
      stage.title.length > 40 ||
      typeof stage.goal !== "string" ||
      !stage.goal.trim() ||
      stage.goal.length > 2000 ||
      typeof stage.deliverables !== "string" ||
      !stage.deliverables.trim() ||
      stage.deliverables.length > 2000
    )
      throw new Error("阶段名称、目标或交付物无效。");
    return {
      id,
      title: stage.title.trim(),
      goal: stage.goal.trim(),
      deliverables: stage.deliverables.trim(),
      models: decodeResearchModels(stage.models) ?? {},
    };
  });
}
export interface ResearchRoute {
  role: ResearchRole;
  stage: Omit<ResearchStage, "models">;
  model?: ResearchModel;
  modelSource?: ResearchModelSource;
  specialistId?: string;
  revision: number;
  active: boolean;
}
export function decodeResearchRoute(value: unknown): ResearchRoute {
  const r = value as ResearchRoute;
  if (
    !r ||
    typeof r.active !== "boolean" ||
    !RESEARCH_ROLES.includes(r.role) ||
    !Number.isInteger(r.revision) ||
    !isResearchStageId(r.stage?.id) ||
    typeof r.stage.title !== "string" ||
    typeof r.stage.goal !== "string" ||
    typeof r.stage.deliverables !== "string"
  )
    throw new Error("无效阶段执行配置。");
  if (
    r.modelSource !== undefined &&
    ![
      "task-override",
      "stage-role",
      "project-default",
      "application-default",
      "session-current",
      "authorized-recovery",
    ].includes(r.modelSource)
  )
    throw new Error("无效模型继承来源。");
  if (
    r.specialistId !== undefined &&
    (typeof r.specialistId !== "string" || !r.specialistId || r.specialistId.length > 100)
  )
    throw new Error("无效专项成员身份。");
  const model = decodeResearchModels(r.model ? { [r.role]: r.model } : {})?.[r.role];
  return {
    role: r.role,
    stage: {
      id: r.stage.id,
      title: r.stage.title,
      goal: r.stage.goal,
      deliverables: r.stage.deliverables,
    },
    revision: r.revision,
    active: r.active,
    ...(model ? { model } : {}),
    ...(r.modelSource ? { modelSource: r.modelSource } : {}),
    ...(r.specialistId ? { specialistId: r.specialistId } : {}),
  };
}
export interface ResearchConfig extends ResearchMethodConfig {
  knowledgeDir: string;
  materialsDir?: string;
  scope?: ResearchRunScope;
  memberTokenBudget?: number;
  models?: Partial<Record<ResearchRole, ResearchModel>>;
  stages?: ResearchStage[];
}
export interface ResearchMember {
  role: ResearchRole;
  ref: SessionRef;
  model?: ResearchModel;
  status: "idle" | "running" | "failed";
  startedAt?: string;
  firstOutputAt?: string;
  finishedAt?: string;
  error?: string;
  stage?: ResearchStageId;
  thinkingLevel?: ResearchThinkingLevel;
}
export interface ResearchArtifact {
  id: string;
  role: ResearchRole;
  kind: ResearchArtifactKind;
  revision: number;
  round: number;
  createdAt: string;
  content: string;
  refs: string[];
  verdict?: "accept" | "revise" | "hold";
  sourceIds?: string[];
  analysisIds?: string[];
  analysisPlan?: ResearchAnalysisSpec;
  toolCallId: string;
  stage?: ResearchStageId;
  model?: ResearchModel;
  /** Explicit language-only publication; its immutable baseline/check live in languageRevisions. */
  languageBaselineId?: string;
  pathRecordId?: string;
  memberInputIds?: string[];
  scopeFindings?: import("./research-m3").ResearchScopeFinding[];
}
export interface ResearchEvent {
  id: string;
  revision?: number;
  at: string;
  type:
    | "started"
    | "output"
    | "finished"
    | "published"
    | "handoff"
    | "read"
    | "knowledge"
    | "message"
    | "paused"
    | "error"
    | "model"
    | "configuration"
    | "source-read"
    | "literature"
    | "analysis"
    | "stage"
    | "decision";
  role?: ResearchRole;
  to?: ResearchRole;
  artifactId?: string;
  sourceId?: string;
  sourceSha256?: string;
  analysisId?: string;
  stage?: ResearchStageId;
  producerRunning?: boolean;
  runId?: string;
  runtimeAt?: string;
  producerRunId?: string;
  detail: string;
}
export interface ResearchKnowledgePacket {
  id: string;
  stage?: ResearchStageId;
  revision: number;
  role: ResearchRole;
  query: string;
  ids: string[];
  at: string;
  records: Record<string, unknown>[];
}
export interface ResearchProject
  extends ResearchMethodConfig, ResearchAnalysisReuseRecords, ResearchSourcePageRecords {
  id: string;
  m3?: ResearchM3Project;
  root: SessionRef;
  workspacePath: string;
  objective: string;
  /** Immutable source contexts, not confirmed decision conditions. */
  inputHistory?: ResearchUserInputContext[];
  revision: number;
  status: "running" | "paused" | "needs-decision" | "completed";
  createdAt: string;
  updatedAt: string;
  knowledge: { directory: string; sha256: string; version: string; count: number };
  members: ResearchMember[];
  stages?: ResearchStage[];
  scope?: ResearchRunScope;
  memberTokenBudget?: number;
  currentStage?: ResearchStageId;
  materialsDir?: string;
  evidence?: ResearchEvidence;
  importedMaterials?: ImportedResearchMaterial[];
  entryInventory?: ResearchInventorySnapshot;
  fusion?: ResearchTaskGraph;
  sharedMethod?: SharedResearchMethodSnapshot;
  legacyMigration?: { id: string; sourceProjectId: string; recordFile: string };
  evidenceHistory?: { revision: number; evidence: ResearchEvidence }[];
  materialHistory?: {
    changeId: string;
    at: string;
    evidence: Pick<ResearchEvidence, "sources" | "datasets">;
  }[];
  analyses?: ResearchAnalysisRun[];
  analysisPlan?: ResearchAnalysisSpec;
  analysisRegistry?: ResearchAnalysisRegistry;
  activeAnalysisPlans?: { id: string; version: number }[];
  numericBindings?: ResearchNumericBinding[];
  numericFieldMetadata?: ResearchResultFieldMetadata[];
  numericCandidateReviews?: ResearchNumericCandidateReview[];
  claims?: ResearchClaims;
  sourceReads?: ResearchClaimActualRead[];
  methodPackages?: ResearchMethodPackage[];
  methodPackageUses?: ResearchMethodPackageUse[];
  methodApplications?: ResearchMethodApplication[];
  methodImageReadings?: ResearchMethodImageReading[];
  methodImageReceipts?: ResearchMethodImageReceipt[];
  methodContentOpinions?: ResearchMethodContentOpinion[];
  methodAdjudications?: ResearchMethodAdjudication[];
  methodProgramChecks?: ResearchMethodProgramCheck[];
  literatureSearch?: ResearchLiteratureSearch;
  literatureToolOperations?: ResearchLiteratureToolOperation[];
  literatureRecordReads?: ResearchLiteratureRecordReading[];
  synthesis?: ResearchSynthesis;
  contentChecks?: ResearchContentCheckRecord[];
  languageScopes?: ResearchLanguageScope[];
  languageRevisions?: ResearchLanguageRevision[];
  languageReads?: ResearchLanguageHostRead[];
  languageDispositions?: ResearchLanguageDisposition[];
  archives?: ResearchArchiveReceipt[];
  archiveOrigin?: ResearchArchiveReceipt;
  reviewPapers?: {
    manuscriptId: string;
    revision: number;
    files: NonNullable<ResearchProject["finalPaper"]>;
  }[];
  finalPaper?: { markdown: string; html: string; provenance: string; docx?: string };
  supersededExports?: {
    files: NonNullable<ResearchProject["finalPaper"]>;
    at: string;
    reason: string;
  }[];
  artifacts: ResearchArtifact[];
  packets: ResearchKnowledgePacket[];
  events: ResearchEvent[];
  error?: string;
}
export interface ResearchGroupsState {
  version: 1;
  config: ResearchConfig;
  projects: ResearchProject[];
  error?: string;
  m3?: ResearchM3Application;
}
export type ResearchGroupAction =
  | { kind: "discussion"; target: SessionRef; input: ResearchDiscussionInput }
  | { kind: "export-archive"; target: SessionRef; input: ResearchArchiveSelection }
  | { kind: "import-archive"; target: SessionRef; input: { directory: string } }
  | { kind: "export-review"; target: SessionRef; input: { manuscriptId: string } }
  | { kind: "m3"; target: SessionRef; input: ResearchM3Action }
  | { kind: "language-scope"; target: SessionRef; input: ResearchLanguageSelection }
  | { kind: "language-skip"; target: SessionRef; input: { revisionId: string; reason: string } }
  | { kind: "reuse-decision"; target: SessionRef; input: ResearchTaskReuseDecisionInput }
  | { kind: "preview-legacy-migration"; target: SessionRef; input: ResearchLegacyMigrationIntent }
  | { kind: "apply-legacy-migration"; target: SessionRef; input: ResearchLegacyMigrationCommit }
  | { kind: "preview-material-change"; target: SessionRef; input: ResearchMaterialChangeRequest }
  | { kind: "apply-material-change"; target: SessionRef; input: ResearchMaterialChangeCommit }
  | { kind: "answer-decision"; target: SessionRef; input: ResearchTaskAnswerInput }
  | { kind: "retry-task"; target: SessionRef; input: ResearchTaskRetryInput }
  | { kind: "resolve-attempt"; target: SessionRef; input: ResearchTaskResolveInput }
  | {
      kind: "recover-material";
      target: SessionRef;
      materialId: string;
      recovery: MaterialRecoveryRequest;
    }
  | {
      kind: "adopt-material";
      target: SessionRef;
      materialId: string;
      declaration: MaterialAdoptionDeclaration;
      expectedImpactToken?: string;
    }
  | { kind: "configure"; config: ResearchConfig; target?: SessionRef }
  | { kind: "pause" | "resume" | "import-materials" | "inspect-materials"; target: SessionRef }
  | { kind: "reconsider"; target: SessionRef; conditions: string };

export function researchProjectFor(
  state: ResearchGroupsState | undefined,
  ref: SessionRef,
): ResearchProject | undefined {
  return state?.projects.find((p) =>
    [...p.members, ...(p.m3?.specialists ?? [])].some(
      (m) => m.ref.workspaceId === ref.workspaceId && m.ref.sessionId === ref.sessionId,
    ),
  );
}

export function decodeResearchAction(raw: unknown): ResearchGroupAction {
  const a = raw as ResearchGroupAction;
  if (!a || typeof a !== "object") throw new Error("无效课题组操作。");
  if (
    a.kind === "discussion" ||
    a.kind === "export-archive" ||
    a.kind === "import-archive" ||
    a.kind === "export-review" ||
    a.kind === "m3" ||
    a.kind === "answer-decision" ||
    a.kind === "language-scope" ||
    a.kind === "language-skip" ||
    a.kind === "reuse-decision" ||
    a.kind === "retry-task" ||
    a.kind === "resolve-attempt" ||
    a.kind === "preview-material-change" ||
    a.kind === "apply-material-change" ||
    a.kind === "preview-legacy-migration" ||
    a.kind === "apply-legacy-migration"
  ) {
    if (
      Array.isArray(raw) ||
      Object.keys(a).some((key) => !["kind", "target", "input"].includes(key))
    )
      throw new Error("课题操作含未知字段。");
    if (
      !a.target ||
      typeof a.target !== "object" ||
      Array.isArray(a.target) ||
      Object.keys(a.target).some((key) => !["workspaceId", "sessionId"].includes(key)) ||
      typeof a.target.workspaceId !== "string" ||
      !a.target.workspaceId.trim() ||
      a.target.workspaceId.length > 4096 ||
      typeof a.target.sessionId !== "string" ||
      !a.target.sessionId.trim() ||
      a.target.sessionId.length > 4096
    )
      throw new Error("无效课题组目标。");
    const target = { workspaceId: a.target.workspaceId, sessionId: a.target.sessionId };
    if (a.kind === "export-archive")
      return { kind: a.kind, target, input: decodeArchiveSelection(a.input) };
    if (a.kind === "import-archive") {
      if (
        !a.input ||
        typeof a.input !== "object" ||
        Array.isArray(a.input) ||
        Object.keys(a.input).some((key) => key !== "directory") ||
        typeof a.input.directory !== "string" ||
        !a.input.directory.trim() ||
        a.input.directory.length > 4096 ||
        a.input.directory.includes("\0")
      )
        throw new Error("请选择归档目录。");
      return { kind: a.kind, target, input: { directory: a.input.directory } };
    }
    if (a.kind === "export-review") {
      if (
        !a.input ||
        typeof a.input !== "object" ||
        Array.isArray(a.input) ||
        Object.keys(a.input).some((key) => key !== "manuscriptId") ||
        typeof a.input.manuscriptId !== "string" ||
        !a.input.manuscriptId ||
        a.input.manuscriptId.length > 512
      )
        throw new Error("请选择实际稿件。");
      return { kind: a.kind, target, input: { manuscriptId: a.input.manuscriptId } };
    }
    if (a.kind === "m3") return { kind: a.kind, target, input: decodeResearchM3Action(a.input) };
    if (a.kind === "language-scope")
      return { kind: a.kind, target, input: decodeResearchLanguageSelection(a.input) };
    if (a.kind === "language-skip") {
      const input = a.input;
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !["revisionId", "reason"].includes(key)) ||
        typeof input.revisionId !== "string" ||
        !input.revisionId ||
        input.revisionId.length > 1024 ||
        typeof input.reason !== "string" ||
        !input.reason.trim() ||
        input.reason.length > 12000
      )
        throw new Error("跳过语言打磨需要具体原因和实际修订身份。");
      return {
        kind: a.kind,
        target,
        input: { revisionId: input.revisionId, reason: input.reason },
      };
    }
    if (a.kind === "reuse-decision")
      return { kind: a.kind, target, input: decodeResearchTaskReuseDecisionInput(a.input) };
    if (a.kind === "preview-legacy-migration")
      return { kind: a.kind, target, input: decodeResearchLegacyMigrationIntent(a.input) };
    if (a.kind === "apply-legacy-migration")
      return { kind: a.kind, target, input: decodeResearchLegacyMigrationCommit(a.input) };
    if (a.kind === "preview-material-change")
      return { kind: a.kind, target, input: decodeResearchMaterialChangeRequest(a.input) };
    if (a.kind === "apply-material-change")
      return { kind: a.kind, target, input: decodeResearchMaterialChangeCommit(a.input) };
    if (a.kind === "discussion")
      return { kind: a.kind, target: a.target, input: decodeResearchDiscussionInput(a.input) };
    if (a.kind === "answer-decision")
      return { kind: a.kind, target, input: decodeResearchTaskAnswerInput(a.input) };
    if (a.kind === "retry-task")
      return { kind: a.kind, target, input: decodeResearchTaskRetryInput(a.input) };
    return { kind: a.kind, target, input: decodeResearchTaskResolveInput(a.input) };
  }
  if (a.kind === "adopt-material" || a.kind === "recover-material") {
    if (
      typeof a.target?.workspaceId !== "string" ||
      !a.target.workspaceId ||
      typeof a.target.sessionId !== "string" ||
      !a.target.sessionId ||
      typeof a.materialId !== "string" ||
      a.materialId.length > 100 ||
      !a.materialId
    )
      throw new Error("无效课题或材料身份。");
    if (a.kind === "recover-material")
      return {
        kind: a.kind,
        target: { workspaceId: a.target.workspaceId, sessionId: a.target.sessionId },
        materialId: a.materialId,
        recovery: decodeMaterialRecoveryRequest(a.recovery),
      };
    if (
      a.expectedImpactToken !== undefined &&
      (typeof a.expectedImpactToken !== "string" || a.expectedImpactToken.length > 2_000_000)
    )
      throw new Error("采用影响快照无效，请重新查看。");
    return {
      kind: a.kind,
      target: { workspaceId: a.target.workspaceId, sessionId: a.target.sessionId },
      materialId: a.materialId,
      declaration: decodeMaterialAdoptionDeclaration(a.declaration),
      ...(a.expectedImpactToken === undefined
        ? {}
        : { expectedImpactToken: a.expectedImpactToken }),
    };
  }
  if (a.kind === "configure") {
    if (
      typeof a.config?.knowledgeDir !== "string" ||
      !a.config.knowledgeDir.trim() ||
      a.config.knowledgeDir.length > 4096
    )
      throw new Error("请填写本地课程知识库目录。");
    const models = decodeResearchModels(a.config.models);
    if (
      a.config.memberTokenBudget !== undefined &&
      (!Number.isSafeInteger(a.config.memberTokenBudget) ||
        a.config.memberTokenBudget < 1000 ||
        a.config.memberTokenBudget > 10_000_000)
    )
      throw new Error("成员 Token 上限需为 1000–10000000 的整数。");
    if (a.config.scope !== undefined && !["proposal", "paper"].includes(a.config.scope))
      throw new Error("无效研究范围。");
    if (
      a.config.materialsDir !== undefined &&
      (typeof a.config.materialsDir !== "string" || a.config.materialsDir.length > 4096)
    )
      throw new Error("无效研究材料目录。");
    if (
      a.target &&
      (typeof a.target.workspaceId !== "string" ||
        !a.target.workspaceId ||
        typeof a.target.sessionId !== "string" ||
        !a.target.sessionId)
    )
      throw new Error("无效课题组目标。");
    return {
      kind: a.kind,
      config: {
        ...decodeResearchMethodConfig(a.config),
        knowledgeDir: a.config.knowledgeDir.trim(),
        models,
        ...(a.config.scope ? { scope: a.config.scope } : {}),
        ...(a.config.memberTokenBudget !== undefined
          ? { memberTokenBudget: a.config.memberTokenBudget }
          : {}),
        ...(a.config.materialsDir !== undefined
          ? { materialsDir: a.config.materialsDir.trim() }
          : {}),
        ...(a.config.stages !== undefined
          ? { stages: decodeResearchStages(a.config.stages, a.config.workflowVersion) }
          : {}),
      },
      ...(a.target
        ? { target: { workspaceId: a.target.workspaceId, sessionId: a.target.sessionId } }
        : {}),
    };
  }
  if (
    (a.kind === "pause" ||
      a.kind === "resume" ||
      a.kind === "reconsider" ||
      a.kind === "inspect-materials" ||
      a.kind === "import-materials") &&
    typeof a.target?.workspaceId === "string" &&
    a.target.workspaceId &&
    typeof a.target.sessionId === "string" &&
    a.target.sessionId
  ) {
    if (a.kind === "reconsider") {
      if (
        typeof a.conditions !== "string" ||
        a.conditions.trim().length < 20 ||
        a.conditions.length > 6000
      )
        throw new Error("请具体填写补充条件或再审理由（20–6000 字）。");
      return {
        kind: a.kind,
        target: { workspaceId: a.target.workspaceId, sessionId: a.target.sessionId },
        conditions: a.conditions.trim(),
      };
    }
    return {
      kind: a.kind,
      target: { workspaceId: a.target.workspaceId, sessionId: a.target.sessionId },
    };
  }
  throw new Error("无效课题组操作。");
}
