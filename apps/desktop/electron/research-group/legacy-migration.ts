import { createHash } from "node:crypto";
import {
  RESEARCH_LEGACY_MAPPING_VERSION,
  decodeResearchLegacyMigrationIntent,
  type ResearchLegacyMigrationIntent,
  type ResearchLegacyMigrationPreview,
  type ResearchLegacyMigrationRecord,
  type ResearchLegacyMigrationResult,
  type ResearchLegacyMigrationTarget,
} from "../../contracts/research-legacy-migration";
import { fusionResearchStages } from "../../contracts/research-method";
import {
  RESEARCH_ROLES,
  decodeResearchStages,
  type ResearchProject,
  type ResearchStage,
} from "../../contracts/research-group";
import {
  SHARED_RESEARCH_METHOD_VERSION,
  snapshotSharedResearchMethod,
} from "../../contracts/shared-research-method";
import { decodeResearchState } from "./repository";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Pure preview. It neither reads referenced files nor treats historical verdicts as new acceptance. */
export function previewLegacyResearchMigration(
  source: ResearchProject,
  input: ResearchLegacyMigrationIntent,
): ResearchLegacyMigrationPreview {
  decodeResearchState({ version: 1, config: { knowledgeDir: "" }, projects: [source] });
  if (source.workflowVersion !== undefined || source.fusion !== undefined)
    throw new Error("只有旧流程项目可采用这项新任务迁移。");
  if (source.status === "running" || source.members.some((member) => member.status === "running"))
    throw new Error("请先暂停旧项目并等待在途成员停止，再预览新任务。");
  const intent = decodeResearchLegacyMigrationIntent(input);
  const legacy = source.stages ? decodeResearchStages(source.stages) : [];
  const stages = fusionResearchStages({ models: intent.defaultModels, stages: legacy });
  const mappings: ResearchLegacyMigrationPreview["mappings"] = legacy.map((original) => {
    if (original.id === "review")
      return {
        sourceStageId: original.id,
        targetStageIds: [],
        kind: "history-only",
        original: structuredClone(original),
        note: "历史初步方案审阅及自定义配置留在源快照；横向审阅需按新任务重新核查，不表示 S2–S5 已执行或接受。",
      };
    if (original.id === "literature")
      return {
        sourceStageId: original.id,
        targetStageIds: ["search", "reading", "synthesis"],
        kind: "split-models",
        original: structuredClone(original),
        note: "S2、S3、S4 建议继承旧文献角色模型，逐项可编辑；旧自定义目标及正文保留于历史，不补造检索、读取或接受记录。",
      };
    return {
      sourceStageId: original.id,
      targetStageIds: [original.id],
      kind: "direct",
      original: structuredClone(original),
      note: "继承标题、目标、交付要求和角色模型；旧正文、裁定及版本仅作为待核查历史，新任务尚未接受成果。",
    };
  });
  for (const stage of stages) {
    if (!mappings.some((mapping) => mapping.targetStageIds.includes(stage.id)))
      mappings.push({
        targetStageIds: [stage.id],
        kind: "new-default",
        note: `新增 ${stage.id} 使用当前共享方法及本次明确选择的默认模型；不是旧阶段执行记录。`,
      });
  }
  const sourceSha256 = digest(source);
  const preview: ResearchLegacyMigrationPreview = {
    mappingVersion: RESEARCH_LEGACY_MAPPING_VERSION,
    sourceProjectId: source.id,
    sourceRevision: source.revision,
    sourceWorkflowVersion: !source.stages
      ? "legacy-unspecified"
      : source.stages.length === 2
        ? "legacy-two-stage"
        : "legacy-seven-stage",
    sourceSha256,
    token: digest({
      mappingVersion: RESEARCH_LEGACY_MAPPING_VERSION,
      sourceSha256,
      intent,
      method: snapshotSharedResearchMethod(),
    }),
    stages: structuredClone(intent.stages ?? stages),
    mappings,
    pending: [
      {
        id: "material-availability",
        stageIds: ["search", "reading", "synthesis"],
        message:
          "重新清点拟沿用的原文、稿件与材料，核对文件可用性及摘要；源快照的路径记录不证明文件仍可用，尚未复制或采用进新项目。",
      },
      {
        id: "design-gates",
        stageIds: ["design"],
        message:
          "分别核查方案质量与实施条件；旧 review 或 design 接受不替代新任务的方案、授权及材料关口。",
      },
      {
        id: "analysis-validity",
        stageIds: ["analysis"],
        message: "旧数据、分析和复算留在历史；只有核对材料版本及方法支持后才能采用，不补造计算。",
      },
      {
        id: "manuscript-version",
        stageIds: ["writing", "audit"],
        message: "原稿与旧终审保留；旧终审仅对旧稿有效，新任务改稿需重新审阅指定版本。",
      },
      {
        id: "human-conditions",
        stageIds: [],
        message: "核对原用户授权的来源与适用范围；模型 accept 不当作人的确认或外部审批。",
      },
    ],
  };
  if (!source.stages)
    preview.pending.push({
      id: "missing-stage-config",
      stageIds: [],
      message: "旧项目没有保存阶段配置；已构造最低九阶段映射，未推断丢失的自定义目标或模型。",
    });
  const missingModels = preview.stages.filter((stage) =>
    RESEARCH_ROLES.some((role) => !stage.models[role]),
  );
  if (missingModels.length)
    preview.pending.push({
      id: "model-selection",
      stageIds: missingModels.map((stage) => stage.id),
      message:
        "这些阶段存在未指定的角色模型；启动前明确采用何种默认或阶段配置，预览不声称实际请求已使用模型。",
    });
  return preview;
}

/** Fail closed on damaged persisted snapshots; never substitute an empty project. */
export function decodeLegacyResearchMigrationRecord(value: unknown): ResearchLegacyMigrationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("迁移恢复记录无效，原项目保留。");
  const record = value as ResearchLegacyMigrationRecord;
  const { recordSha256, ...contents } = record;
  if (
    record.version !== 1 ||
    record.sourceDataVersion !== 1 ||
    record.targetDataVersion !== 1 ||
    typeof record.id !== "string" ||
    !record.id.trim() ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    record.preview?.mappingVersion !== RESEARCH_LEGACY_MAPPING_VERSION ||
    record.sourceSnapshot?.id !== record.preview.sourceProjectId ||
    record.sourceSnapshot?.revision !== record.preview.sourceRevision ||
    digest(record.sourceSnapshot) !== record.preview.sourceSha256 ||
    digest(contents) !== recordSha256
  )
    throw new Error("迁移恢复快照不完整或摘要不一致；原项目不得被空记录覆盖。");
  decodeResearchState({
    version: 1,
    config: { knowledgeDir: "" },
    projects: [record.sourceSnapshot, record.createdProject],
  });
  if (
    record.createdProject.id === record.sourceSnapshot.id ||
    record.createdProject.workflowVersion !== "fusion-v2" ||
    record.sourceSnapshot.workflowVersion !== undefined ||
    digest(record.createdProject.stages) !== digest(record.preview.stages)
  )
    throw new Error("迁移记录的源、目标或阶段映射不一致。");
  decodeResearchLegacyMigrationIntent(record.intent);
  return structuredClone(record);
}

/** Restore JSON state only; reference files are retained, never rewritten by migration. */
export function restoreLegacyResearchSnapshot(value: unknown): ResearchProject {
  const record = decodeLegacyResearchMigrationRecord(value);
  return structuredClone(record.sourceSnapshot);
}

/** Prepare only. Caller persists recovery record before an atomic, additive project registration. */
export function createLegacyResearchMigration(
  source: ResearchProject,
  input: ResearchLegacyMigrationIntent,
  target: ResearchLegacyMigrationTarget,
  prior?: ResearchLegacyMigrationRecord,
): ResearchLegacyMigrationResult {
  const intent = decodeResearchLegacyMigrationIntent(input);
  if (prior) {
    restoreLegacyResearchSnapshot(prior);
    if (digest(source) !== prior.preview.sourceSha256)
      throw new Error("旧项目已变化，请重新预览，不复用旧任务授权。");
    if (
      prior.id !== target.migrationId ||
      prior.createdProject.id !== target.projectId ||
      prior.preview.sourceProjectId !== source.id ||
      prior.preview.token !== target.expectedPreviewToken ||
      digest(prior.intent) !== digest(intent) ||
      digest(prior.createdProject.root) !== digest(target.root)
    )
      throw new Error("迁移身份已被不同请求使用，请重新查看原迁移记录。");
    return { alreadyApplied: true, record: structuredClone(prior) };
  }
  const preview = previewLegacyResearchMigration(source, intent);
  if (preview.token !== target.expectedPreviewToken)
    throw new Error("旧项目或新任务选择已变化，请重新预览映射与待核查条件。");
  if (
    !/^[a-f0-9-]{36}$/.test(target.projectId) ||
    target.projectId === source.id ||
    !target.migrationId.trim() ||
    target.migrationId.length > 200 ||
    !Number.isFinite(Date.parse(target.at))
  )
    throw new Error("新任务需要独立且有效的迁移、项目身份与时间。");
  const sessionKey = (ref: ResearchProject["root"]) => `${ref.workspaceId}\0${ref.sessionId}`;
  const oldRefs = new Set(
    [source.root, ...source.members.map((member) => member.ref)].map(sessionKey),
  );
  const newRefs = target.members.map((member) => member.ref);
  if (
    newRefs.some(
      (ref) =>
        !ref.sessionId.trim() ||
        ref.workspaceId !== source.root.workspaceId ||
        oldRefs.has(sessionKey(ref)),
    ) ||
    new Set(newRefs.map(sessionKey)).size !== newRefs.length ||
    !target.members.some(
      (member) => member.role === "mentor" && sessionKey(member.ref) === sessionKey(target.root),
    ) ||
    target.members.length !== RESEARCH_ROLES.length ||
    RESEARCH_ROLES.some(
      (role) => target.members.filter((member) => member.role === role).length !== 1,
    ) ||
    target.members.some((member) => member.status !== "idle")
  )
    throw new Error("新任务必须使用四个互异且空闲的新成员会话，根会话须为导师，不能复用旧会话。");
  const sharedMethod = snapshotSharedResearchMethod();
  const project: ResearchProject = {
    id: target.projectId,
    root: structuredClone(target.root),
    workspacePath: source.workspacePath,
    objective: intent.objective,
    revision: 0,
    status: "paused",
    createdAt: target.at,
    updatedAt: target.at,
    knowledge: structuredClone(source.knowledge),
    members: target.members.map((member) => ({
      role: member.role,
      ref: structuredClone(member.ref),
      status: "idle",
      ...(member.model ? { model: structuredClone(member.model) } : {}),
    })),
    stages: structuredClone(preview.stages),
    ...intent.method,
    workflowVersion: "fusion-v2",
    methodVersion: SHARED_RESEARCH_METHOD_VERSION,
    sharedMethod,
    scope: intent.method.goal === "paper" ? "paper" : "proposal",
    ...(source.memberTokenBudget === undefined
      ? {}
      : { memberTokenBudget: source.memberTokenBudget }),
    legacyMigration: {
      id: target.migrationId,
      sourceProjectId: source.id,
      recordFile: target.recordFile,
    },
    artifacts: [],
    packets: [],
    events: [],
    analyses: [],
  };
  const contents: Omit<ResearchLegacyMigrationRecord, "recordSha256"> = {
    version: 1,
    sourceDataVersion: 1,
    targetDataVersion: 1,
    id: target.migrationId,
    createdAt: target.at,
    preview,
    intent,
    sourceSnapshot: structuredClone(source),
    createdProject: structuredClone(project),
  };
  const record = decodeLegacyResearchMigrationRecord({
    ...contents,
    recordSha256: digest(contents),
  });
  return { alreadyApplied: false, record, project };
}
