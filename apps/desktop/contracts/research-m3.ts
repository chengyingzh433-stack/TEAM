import type { ResearchDiscussion } from "./research-discussion";
import type { ResearchTokenCounts } from "./research-usage";
import type { SessionRef } from "@lancer/session-driver";
import type { ResearchModel, ResearchRole, ResearchStageId } from "./research-group";
import type { ResearchClaimActualRead } from "./research-claims";
import type { ResearchSingleTaskKind } from "./research-method";

export type NonNumericResearchPath = "review" | "qualitative" | "theoretical";
export const RESEARCH_PATH_OPERATIONS = [
  "path-context",
  "path-record",
  "path-read",
  "path-review",
] as const;
export const RESEARCH_SPECIALIST_OPERATIONS = [
  "specialist-context",
  "specialist-read",
  "specialist-submit",
  "specialist-disposition",
] as const;
export const RESEARCH_MEMBER_INPUT_OPERATIONS = ["member-input-response"] as const;
export type ResearchModelSource =
  | "task-override"
  | "stage-role"
  | "project-default"
  | "application-default"
  | "session-current"
  | "authorized-recovery";

export interface ResearchTextEvidence {
  id: string;
  sourceId: string;
  locatorId: string;
  start: number;
  end: number;
  interpretation: string;
}
/** Model-supplied analysis; identity, pinned bytes and read receipts are supplied by the host. */
export interface ResearchPathRecordInput {
  path: NonNumericResearchPath;
  scope: string;
  approach: string;
  limitations: string;
  evidence: ResearchTextEvidence[];
  review?: { inclusionCriteria: string; qualityAssessment: string; selectionLimitations: string };
  qualitative?: {
    approach: "reflexive-thematic-analysis";
    researcherPosition: string;
    codes: { id: string; label: string; evidenceIds: string[]; interpretation: string }[];
    themes: {
      id: string;
      label: string;
      codeIds: string[];
      claim: string;
      counterEvidenceIds: string[];
    }[];
    negativeCaseSearch: string;
    reflexivity: string;
  };
  theoretical?: {
    concepts: { id: string; definition: string; evidenceIds: string[] }[];
    arguments: {
      id: string;
      proposition: string;
      premiseIds: string[];
      steps: string[];
      evidenceIds: string[];
      competingExplanation: string;
      counterexample: string;
    }[];
  };
}
export interface ResearchPathRecord {
  id: string;
  revision: number;
  taskId: string;
  taskVersion: number;
  attemptId: string;
  role: ResearchRole;
  sessionId: string;
  at: string;
  input: ResearchPathRecordInput;
  actualReads: ResearchClaimActualRead[];
  excerpts: { id: string; text: string; sha256: string }[];
  sources: { id: string; sha256: string; bodySha256: string }[];
}
export interface ResearchPathReview {
  id: string;
  recordId: string;
  artifactId: string;
  artifactSha256: string;
  role: "reviewer" | "mentor";
  attemptId: string;
  at: string;
  verdict: "supported" | "limited" | "revision-required";
  reason: string;
}
export interface ResearchTaskScope {
  id: string;
  revision: number;
  sourceId: string;
  sourceSha256: string;
  bodySha256: string;
  baseline: string;
  ranges: { start: number; end: number; label: string }[];
  at: string;
}
export interface ResearchScopeFinding {
  rangeIndex: number;
  conclusion: "supported" | "partially-supported" | "unsupported" | "insufficient-material";
  reason: string;
}
export interface ResearchScopedResult {
  id: string;
  kind: ResearchSingleTaskKind;
  revision: number;
  scopeId: string;
  artifactId: string;
  artifactSha256: string;
  sourcePins: { id: string; sha256: string }[];
  analysisPins: { id: string; sha256: string }[];
  fullText: string;
  fullTextSha256: string;
  edits: { start: number; end: number; replacement: string }[];
  findings?: ResearchScopeFinding[];
  at: string;
  adoptedAt?: string;
  adoptionReason?: string;
  adoptions?: { revision: number; at: string; reason: string }[];
}
export interface ResearchSpecialist {
  id: string;
  kind: "method" | "editor" | "external-reviewer";
  label: string;
  ref: SessionRef;
  revision: number;
  taskId: string;
  stage: ResearchStageId;
  objective: string;
  deliverable: string;
  exitCondition: string;
  integrator: "lead" | "mentor";
  sourceIds: string[];
  artifactIds: string[];
  model?: ResearchModel;
  state: "pending" | "running" | "submitted" | "failed" | "exited";
  initialOpinion?: { id: string; content: string; at: string; attemptId: string };
  followups?: { id: string; content: string; at: string; attemptId: string }[];
  /** The user opens discussion only after an independent first opinion. */
  discussionOpenedAt?: string;
  discussionQuestion?: string;
  reads: {
    kind: "source" | "artifact" | "standards";
    id: string;
    sha256: string;
    at: string;
    attemptId: string;
    start?: number;
    end?: number;
  }[];
  disposition?: {
    opinionId: string;
    actor: "user" | "model";
    by: ResearchRole;
    at: string;
    verdict: "adopt" | "revise" | "decline";
    reason: string;
    artifactId: string;
  };
  error?: string;
}
export interface ResearchM3Project {
  discussions?: ResearchDiscussion[];
  memberInputs?: {
    id: string;
    revision: number;
    actor: string;
    taskId: string;
    taskVersion: number;
    text: string;
    at: string;
    delivery: "steer" | "followUp";
    attemptId?: string;
    responses?: {
      id: string;
      kind: "model";
      at: string;
      attemptId: string;
      artifactId: string;
      artifactSha256: string;
      disposition: "no-manuscript-change" | "requires-revision";
      content: string;
    }[];
  }[];
  projectLimit?: number;
  tokenBudget?: number;
  defaultModels?: Partial<Record<ResearchRole, ResearchModel>>;
  taskModels?: Record<string, ResearchModel>;
  recoveryPolicies?: Record<string, { candidates: ResearchModel[]; maxRetries: number }>;
  recoveries?: {
    taskId: string;
    attemptId: string;
    model: ResearchModel;
    retryAt: string;
    reason: string;
  }[];
  queued?: { taskId: string; at: string; reason: string }[];
  pathRecords?: ResearchPathRecord[];
  pathReads?: { recordId: string; role: ResearchRole; attemptId: string; at: string }[];
  pathReviews?: ResearchPathReview[];
  scopes?: ResearchTaskScope[];
  scopePreview?: { sourceId: string; sourceSha256: string; bodySha256: string; body: string };
  results?: ResearchScopedResult[];
  specialists?: ResearchSpecialist[];
}
export interface ResearchM3Application {
  applicationLimit?: number;
  defaultModels?: Partial<Record<ResearchRole, ResearchModel>>;
  /** Existing 2/7-stage projects retain their workflow and share the same execution admission. */
  legacyExecutions?: ResearchLegacyExecution[];
  legacyQueue?: {
    projectId: string;
    revision: number;
    role: ResearchRole;
    text: string;
    reason: string;
    delivery?: "steer" | "followUp";
    at: string;
  }[];
  legacySettings?: { projectId: string; projectLimit: number; tokenBudget?: number }[];
  modelPresets?: {
    name: "balanced" | "economy" | "review";
    models: Partial<Record<ResearchRole, ResearchModel>>;
    savedAt: string;
  }[];
}
export interface ResearchLegacyExecution {
  id: string;
  projectId: string;
  revision: number;
  role: ResearchRole;
  state: "prepared" | "running" | "unknown" | "succeeded" | "failed" | "cancelled";
  preparedAt: string;
  nativeRunId?: string;
  finishedAt?: string;
  reservedTokens: number;
  usedTokens?: number;
  sessionTotalTokens?: number;
  tokenUsage?: ResearchTokenCounts;
  sessionTokenUsage?: ResearchTokenCounts;
  resolution?: { at: string; reason: string; evidenceRef: string };
}

export type ResearchM3Action =
  | {
      operation: "save-model-preset";
      name: "balanced" | "economy" | "review";
      models: Partial<Record<ResearchRole, ResearchModel>>;
    }
  | { operation: "apply-model-preset"; name: "balanced" | "economy" | "review" }
  | { operation: "preview-task-source"; sourceId: string }
  | {
      operation: "execution-settings";
      applicationLimit: number;
      projectLimit: number;
      tokenBudget?: number | null;
    }
  | {
      operation: "default-model";
      level: "application" | "project";
      role: ResearchRole;
      model?: ResearchModel;
    }
  | {
      operation: "task-model";
      taskId: string;
      model?: ResearchModel;
      recovery?: { candidates: ResearchModel[]; maxRetries: number };
    }
  | {
      operation: "task-scope";
      sourceId: string;
      sourceSha256: string;
      ranges: { start: number; end: number; label: string }[];
    }
  | { operation: "adopt-task-result"; resultId: string; reason: string }
  | {
      operation: "add-specialist";
      kind: ResearchSpecialist["kind"];
      label: string;
      objective: string;
      deliverable: string;
      exitCondition: string;
      integrator: "lead" | "mentor";
      sourceIds: string[];
      artifactIds: string[];
      model?: ResearchModel;
    }
  | { operation: "open-specialist-discussion"; specialistId: string; question?: string }
  | { operation: "exit-specialist"; specialistId: string }
  | {
      operation: "specialist-disposition";
      specialistId: string;
      artifactId: string;
      verdict: "adopt" | "revise" | "decline";
      reason: string;
    };

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Error("研究扩展记录含无效或未知字段。");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    throw new Error("研究扩展字段须为非空且长度有效的文字。");
  return value.trim();
}
function list<T>(value: unknown, decode: (v: unknown) => T, max = 200, min = 1): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error("研究扩展列表数量无效。");
  return value.map(decode);
}
const id = (value: unknown) => text(value, 1024);
const ids = (value: unknown, min = 1) => list(value, id, 200, min);
const integer = (value: unknown, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error("研究扩展整数范围无效。");
  return Number(value);
};
export function decodeM3Model(value: unknown): ResearchModel {
  const m = object(value, ["provider", "modelId", "thinkingLevel"]);
  if (
    m.thinkingLevel !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(m.thinkingLevel))
  )
    throw new Error("无效模型思考强度。");
  return {
    provider: text(m.provider, 200),
    modelId: text(m.modelId, 512),
    ...(m.thinkingLevel !== undefined
      ? { thinkingLevel: m.thinkingLevel as ResearchModel["thinkingLevel"] }
      : {}),
  };
}
export function decodeResearchPathRecord(value: unknown): ResearchPathRecordInput {
  const r = object(value, [
    "path",
    "scope",
    "approach",
    "limitations",
    "evidence",
    "review",
    "qualitative",
    "theoretical",
  ]);
  if (!["review", "qualitative", "theoretical"].includes(String(r.path)))
    throw new Error("仅非数值路径使用该证据记录。");
  const evidence = list(r.evidence, (v) => {
    const e = object(v, ["id", "sourceId", "locatorId", "start", "end", "interpretation"]);
    const start = integer(e.start, 0, 100_000_000),
      end = integer(e.end, 1, 100_000_000);
    if (end <= start) throw new Error("原文范围必须非空。");
    return {
      id: id(e.id),
      sourceId: id(e.sourceId),
      locatorId: id(e.locatorId),
      start,
      end,
      interpretation: text(e.interpretation),
    };
  });
  const evidenceIds = new Set(evidence.map((e) => e.id));
  if (evidenceIds.size !== evidence.length) throw new Error("片段标识不能重复。");
  const references = (v: unknown, allowed: Set<string>, min = 1) => {
    const values = ids(v, min);
    if (new Set(values).size !== values.length || values.some((i) => !allowed.has(i)))
      throw new Error("存在缺失或重复的证据、编码或前提引用。");
    return values;
  };
  const result: ResearchPathRecordInput = {
    path: r.path as NonNumericResearchPath,
    scope: text(r.scope),
    approach: text(r.approach),
    limitations: text(r.limitations),
    evidence,
  };
  if (r.path === "review") {
    const q = object(r.review, ["inclusionCriteria", "qualityAssessment", "selectionLimitations"]);
    if (r.qualitative || r.theoretical) throw new Error("综述记录不得混入其他路径结构。");
    result.review = {
      inclusionCriteria: text(q.inclusionCriteria),
      qualityAssessment: text(q.qualityAssessment),
      selectionLimitations: text(q.selectionLimitations),
    };
    if (new Set(evidence.map((e) => e.sourceId)).size < 2)
      throw new Error("综述综合至少需要两份可定位来源。");
  } else if (r.path === "qualitative") {
    const q = object(r.qualitative, [
      "approach",
      "researcherPosition",
      "codes",
      "themes",
      "negativeCaseSearch",
      "reflexivity",
    ]);
    if (q.approach !== "reflexive-thematic-analysis" || r.review || r.theoretical)
      throw new Error("请明确采用反思性主题分析；该取向不机械要求一致率。");
    const codes = list(q.codes, (v) => {
      const c = object(v, ["id", "label", "evidenceIds", "interpretation"]);
      return {
        id: id(c.id),
        label: text(c.label),
        evidenceIds: references(c.evidenceIds, evidenceIds),
        interpretation: text(c.interpretation),
      };
    });
    const codeIds = new Set(codes.map((c) => c.id));
    if (codeIds.size !== codes.length) throw new Error("编码标识重复。");
    const themes = list(q.themes, (v) => {
      const t = object(v, ["id", "label", "codeIds", "claim", "counterEvidenceIds"]);
      return {
        id: id(t.id),
        label: text(t.label),
        codeIds: references(t.codeIds, codeIds),
        claim: text(t.claim),
        counterEvidenceIds: references(t.counterEvidenceIds, evidenceIds, 0),
      };
    });
    if (new Set(themes.map((t) => t.id)).size !== themes.length) throw new Error("主题标识重复。");
    result.qualitative = {
      approach: "reflexive-thematic-analysis",
      researcherPosition: text(q.researcherPosition),
      codes,
      themes,
      negativeCaseSearch: text(q.negativeCaseSearch),
      reflexivity: text(q.reflexivity),
    };
  } else {
    const t = object(r.theoretical, ["concepts", "arguments"]);
    if (r.review || r.qualitative) throw new Error("理论记录不得混入其他路径结构。");
    const concepts = list(t.concepts, (v) => {
      const c = object(v, ["id", "definition", "evidenceIds"]);
      return {
        id: id(c.id),
        definition: text(c.definition),
        evidenceIds: references(c.evidenceIds, evidenceIds),
      };
    });
    const conceptIds = new Set(concepts.map((c) => c.id));
    if (conceptIds.size !== concepts.length) throw new Error("概念标识重复。");
    const arguments_ = list(t.arguments, (v) => {
      const a = object(v, [
        "id",
        "proposition",
        "premiseIds",
        "steps",
        "evidenceIds",
        "competingExplanation",
        "counterexample",
      ]);
      return {
        id: id(a.id),
        proposition: text(a.proposition),
        premiseIds: references(a.premiseIds, conceptIds),
        steps: list(a.steps, (v) => text(v)),
        evidenceIds: references(a.evidenceIds, evidenceIds),
        competingExplanation: text(a.competingExplanation),
        counterexample: text(a.counterexample),
      };
    });
    if (new Set(arguments_.map((a) => a.id)).size !== arguments_.length)
      throw new Error("论证标识重复。");
    result.theoretical = { concepts, arguments: arguments_ };
  }
  return result;
}

export function decodeResearchM3Action(value: unknown): ResearchM3Action {
  if (!value || typeof value !== "object" || !("operation" in value))
    throw new Error("无效 M3 操作。");
  const operation = value.operation;
  const model = (r: Record<string, unknown>) =>
    r.model === undefined ? {} : { model: decodeM3Model(r.model) };
  if (operation === "save-model-preset" || operation === "apply-model-preset") {
    const r = object(
      value,
      operation === "save-model-preset" ? ["operation", "name", "models"] : ["operation", "name"],
    );
    if (!["balanced", "economy", "review"].includes(String(r.name)))
      throw new Error("模型预设名称无效。");
    const name = r.name as "balanced" | "economy" | "review";
    if (operation === "apply-model-preset") return { operation, name };
    const models = object(r.models, ["mentor", "lead", "reviewer", "librarian"]);
    if (!Object.keys(models).length) throw new Error("预设至少需要一个明确的可用模型选择。");
    return {
      operation,
      name,
      models: Object.fromEntries(
        Object.entries(models).map(([role, model]) => [role, decodeM3Model(model)]),
      ),
    };
  }
  if (operation === "preview-task-source") {
    const r = object(value, ["operation", "sourceId"]);
    return { operation, sourceId: id(r.sourceId) };
  }
  if (operation === "execution-settings") {
    const r = object(value, ["operation", "applicationLimit", "projectLimit", "tokenBudget"]);
    return {
      operation,
      applicationLimit: integer(r.applicationLimit, 1, 64),
      projectLimit: integer(r.projectLimit, 1, 16),
      ...(r.tokenBudget === undefined
        ? {}
        : {
            tokenBudget: r.tokenBudget === null ? null : integer(r.tokenBudget, 1000, 100_000_000),
          }),
    };
  }
  if (operation === "default-model") {
    const r = object(value, ["operation", "level", "role", "model"]);
    if (
      !["application", "project"].includes(String(r.level)) ||
      !["mentor", "lead", "reviewer", "librarian"].includes(String(r.role))
    )
      throw new Error("默认模型层级或角色无效。");
    return {
      operation,
      level: r.level as "application" | "project",
      role: r.role as ResearchRole,
      ...model(r),
    };
  }
  if (operation === "task-model") {
    const r = object(value, ["operation", "taskId", "model", "recovery"]);
    let recovery;
    if (r.recovery !== undefined) {
      const x = object(r.recovery, ["candidates", "maxRetries"]);
      recovery = {
        candidates: list(x.candidates, decodeM3Model, 3),
        maxRetries: integer(x.maxRetries, 1, 3),
      };
    }
    return { operation, taskId: id(r.taskId), ...model(r), ...(recovery ? { recovery } : {}) };
  }
  if (operation === "task-scope") {
    const r = object(value, ["operation", "sourceId", "sourceSha256", "ranges"]);
    const sha = text(r.sourceSha256, 64);
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("原稿 SHA 无效。");
    const ranges = list(
      r.ranges,
      (v) => {
        const x = object(v, ["start", "end", "label"]);
        const start = integer(x.start, 0, 100_000_000),
          end = integer(x.end, 1, 100_000_000);
        if (end <= start) throw new Error("任务选择范围必须非空。");
        return { start, end, label: text(x.label, 512) };
      },
      50,
    ).sort((a, b) => a.start - b.start);
    if (ranges.some((r, i) => i > 0 && r.start < ranges[i - 1]!.end))
      throw new Error("任务选择范围不得重叠。");
    return { operation, sourceId: id(r.sourceId), sourceSha256: sha, ranges };
  }
  if (operation === "adopt-task-result") {
    const r = object(value, ["operation", "resultId", "reason"]);
    return { operation, resultId: id(r.resultId), reason: text(r.reason) };
  }
  if (operation === "add-specialist") {
    const r = object(value, [
      "operation",
      "kind",
      "label",
      "objective",
      "deliverable",
      "exitCondition",
      "integrator",
      "sourceIds",
      "artifactIds",
      "model",
    ]);
    if (
      !["method", "editor", "external-reviewer"].includes(String(r.kind)) ||
      !["lead", "mentor"].includes(String(r.integrator))
    )
      throw new Error("专项成员类型或整合人无效。");
    return {
      operation,
      kind: r.kind as ResearchSpecialist["kind"],
      label: text(r.label, 100),
      objective: text(r.objective),
      deliverable: text(r.deliverable),
      exitCondition: text(r.exitCondition),
      integrator: r.integrator as "lead" | "mentor",
      sourceIds: ids(r.sourceIds, 0),
      artifactIds: ids(r.artifactIds, 0),
      ...model(r),
    };
  }
  if (operation === "open-specialist-discussion" || operation === "exit-specialist") {
    const r = object(
      value,
      operation === "open-specialist-discussion"
        ? ["operation", "specialistId", "question"]
        : ["operation", "specialistId"],
    );
    return {
      operation,
      specialistId: id(r.specialistId),
      ...(operation === "open-specialist-discussion" && r.question !== undefined
        ? { question: text(r.question) }
        : {}),
    };
  }
  if (operation === "specialist-disposition") {
    const r = object(value, ["operation", "specialistId", "artifactId", "verdict", "reason"]);
    if (!["adopt", "revise", "decline"].includes(String(r.verdict)))
      throw new Error("无效专项意见处理结论。");
    return {
      operation,
      specialistId: id(r.specialistId),
      artifactId: id(r.artifactId),
      verdict: r.verdict as "adopt" | "revise" | "decline",
      reason: text(r.reason),
    };
  }
  throw new Error("未知 M3 操作。");
}

/** Renderer selection uses the actual host snapshot, never guessed chapter offsets. */
export function researchSelectableTaskRanges(
  body: string,
  kind: string,
): { start: number; end: number; label: string }[] {
  if (kind !== "chapter-edit" && kind !== "citations")
    return body.length ? [{ start: 0, end: body.length, label: "全部指定材料" }] : [];
  if (kind === "chapter-edit") {
    const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)];
    if (headings.length)
      return headings.map((heading, i) => ({
        start: heading.index!,
        end: headings[i + 1]?.index ?? body.length,
        label: heading[1]!.trim(),
      }));
  }
  const ranges = [...body.matchAll(/[^\r\n]+/g)]
    .filter((match) => match[0].trim())
    .map((match) => ({
      start: match.index!,
      end: match.index! + match[0].length,
      label: match[0].slice(0, 140),
    }));
  return ranges;
}
