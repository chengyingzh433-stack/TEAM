import {
  decodeResearchMethodConfig,
  fusionResearchStages,
  researchExecutionRoute,
  type ResearchMethodConfig,
} from "./research-method";
import {
  decodeResearchStages,
  type ResearchMember,
  type ResearchProject,
  type ResearchStage,
} from "./research-group";

export const RESEARCH_LEGACY_MAPPING_VERSION = "legacy-to-fusion-1" as const;

/** An explicit new task request, never inferred from opening an old project. */
export interface ResearchLegacyMigrationIntent {
  objective: string;
  method: ResearchMethodConfig;
  defaultModels?: ResearchStage["models"];
  /** Optional user-edited nine-stage mapping, after inspecting the initial preview. */
  stages?: ResearchStage[];
}

export interface ResearchLegacyStageMapping {
  sourceStageId?: ResearchStage["id"];
  targetStageIds: ResearchStage["id"][];
  kind: "direct" | "split-models" | "history-only" | "new-default";
  original?: ResearchStage;
  note: string;
}

export interface ResearchLegacyMigrationPreview {
  mappingVersion: typeof RESEARCH_LEGACY_MAPPING_VERSION;
  sourceProjectId: string;
  sourceRevision: number;
  sourceWorkflowVersion: "legacy-two-stage" | "legacy-seven-stage" | "legacy-unspecified";
  sourceSha256: string;
  token: string;
  stages: ResearchStage[];
  mappings: ResearchLegacyStageMapping[];
  pending: { id: string; stageIds: ResearchStage["id"][]; message: string }[];
}

export interface ResearchLegacyMigrationTarget {
  migrationId: string;
  projectId: string;
  expectedPreviewToken: string;
  root: ResearchProject["root"];
  members: ResearchMember[];
  at: string;
  recordFile: string;
}

export interface ResearchLegacyMigrationCommit {
  migrationId: string;
  expectedPreviewToken: string;
  intent: ResearchLegacyMigrationIntent;
}

export function decodeResearchLegacyMigrationIntent(value: unknown): ResearchLegacyMigrationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效旧项目新任务选择。");
  const intent = value as ResearchLegacyMigrationIntent;
  if (
    Object.keys(intent).some(
      (key) => !["objective", "method", "defaultModels", "stages"].includes(key),
    ) ||
    typeof intent.objective !== "string" ||
    !intent.objective.trim() ||
    intent.objective.length > 32_000
  )
    throw new Error("请明确新修改任务的目标（1–32000 字）。");
  const method = decodeResearchMethodConfig(intent.method);
  if (method.workflowVersion !== "fusion-v2") throw new Error("新修改任务必须明确选择融合流程。");
  const route = researchExecutionRoute(method);
  if (route.blockedReasons.length) throw new Error(route.blockedReasons.join("；"));
  const defaults = decodeResearchStages(
    fusionResearchStages({ models: intent.defaultModels }),
    "fusion-v2",
  )[0]!.models;
  return {
    objective: intent.objective.trim(),
    method,
    defaultModels: defaults,
    ...(intent.stages ? { stages: decodeResearchStages(intent.stages, "fusion-v2") } : {}),
  };
}

export function decodeResearchLegacyMigrationCommit(value: unknown): ResearchLegacyMigrationCommit {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效新任务迁移请求。");
  const commit = value as ResearchLegacyMigrationCommit;
  if (
    Object.keys(commit).some(
      (key) => !["migrationId", "expectedPreviewToken", "intent"].includes(key),
    ) ||
    typeof commit.migrationId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(commit.migrationId) ||
    typeof commit.expectedPreviewToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(commit.expectedPreviewToken)
  )
    throw new Error("迁移身份或预览令牌无效，请重新预览。");
  return {
    migrationId: commit.migrationId,
    expectedPreviewToken: commit.expectedPreviewToken,
    intent: decodeResearchLegacyMigrationIntent(commit.intent),
  };
}

/** Persist this recovery record before exposing the independently created project. */
export interface ResearchLegacyMigrationRecord {
  version: 1;
  recordSha256: string;
  sourceDataVersion: 1;
  targetDataVersion: 1;
  id: string;
  createdAt: string;
  preview: ResearchLegacyMigrationPreview;
  intent: ResearchLegacyMigrationIntent;
  /** Complete JSON state; referenced file bytes remain at their original locations. */
  sourceSnapshot: ResearchProject;
  createdProject: ResearchProject;
}

export type ResearchLegacyMigrationResult =
  | { alreadyApplied: false; record: ResearchLegacyMigrationRecord; project: ResearchProject }
  // A retry must never replace the live new project with its initial paused snapshot.
  | { alreadyApplied: true; record: ResearchLegacyMigrationRecord };
