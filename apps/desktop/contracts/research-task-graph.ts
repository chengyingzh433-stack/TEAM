import { validateResearchUsage, type ResearchTokenCounts } from "./research-usage";
/** Versioned research work, embedded in a project; never a second provider runtime. */
export const RESEARCH_TASK_STATES = [
  "pending",
  "running",
  "waiting-dependency",
  "waiting-user",
  "paused",
  "failed",
  "completed",
  "cancelled",
] as const;
export type ResearchTaskState = (typeof RESEARCH_TASK_STATES)[number];
export const RESEARCH_REVIEW_STATES = [
  "draft",
  "pending-review",
  "revision-required",
  "accepted",
  "needs-review",
  "superseded",
] as const;
export type ResearchTaskReviewState = (typeof RESEARCH_REVIEW_STATES)[number];
export interface ResearchTaskInputRef {
  inputId: string;
  version: number;
}
export interface ResearchTaskInput extends ResearchTaskInputRef {
  kind: "material" | "decision" | "context";
  availability: "available" | "planned" | "missing" | "withdrawn";
  /** Actual supplied material, independent of its subsequent quality/content review. */
  actual: boolean;
  label: string;
  sourceRef: string;
  digest: string;
}
export interface ResearchTaskInputRequirement extends ResearchTaskInputRef {
  requirement: "available" | "user-confirmed";
}
export interface ResearchTaskDependency {
  taskId: string;
  requirement: "published" | "accepted";
}
export interface ResearchTaskBlocker {
  kind: "input" | "decision" | "task" | "attempt" | "pause" | "material";
  objectId: string;
  reason: string;
}
export interface ResearchTask {
  id: string;
  stage: string;
  role: string;
  kind: "proposal" | "analysis" | "research" | "review" | "writing";
  goal: string;
  inputVersion: number;
  inputs: ResearchTaskInputRequirement[];
  dependencies: ResearchTaskDependency[];
  earlyHandoff: string;
  deliverable: string;
  reviewRequired: boolean;
  writeScope: string[];
  /** Undefined is no local task budget, not an unlimited billing guarantee. */
  tokenBudget?: number;
  state: ResearchTaskState;
  blockers: ResearchTaskBlocker[];
  continuations: { id: string; at: string; reason: string; attemptId?: string }[];
  currentArtifactId?: string;
  error?: string;
}
export interface ResearchTaskAttempt {
  id: string;
  taskId: string;
  taskVersion: number;
  inputRefs: ResearchTaskInputRef[];
  dependencyArtifactIds: string[];
  /** Inputs actually obtained after dispatch; earlier artifact snapshots remain unchanged. */
  acquiredInputs?: (ResearchTaskInputRef & { at: string; evidenceRef: string })[];
  acquiredArtifacts?: { artifactId: string; at: string; evidenceRef: string }[];
  state: "prepared" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  preparedAt: string;
  dispatchedAt?: string;
  nativeRunId?: string;
  sessionTotalTokens?: number;
  tokenUsage?: ResearchTokenCounts;
  sessionTokenUsage?: ResearchTokenCounts;
  finishedAt?: string;
  model?: { provider: string; modelId: string; thinkingLevel?: string };
  modelSource?: import("./research-m3").ResearchModelSource;
  reservedTokens: number;
  /** Absent remains unknown. In particular it must not be settled as zero. */
  usedTokens?: number;
  error?: string;
}
export interface ResearchTaskArtifact {
  id: string;
  taskId: string;
  taskVersion: number;
  attemptId: string;
  createdAt: string;
  content: string;
  inputRefs: ResearchTaskInputRef[];
  dependencyArtifactIds: string[];
  interim: boolean;
  reviewState: ResearchTaskReviewState;
  reviews: {
    id: string;
    at: string;
    actor: "model" | "user" | "external-expert" | "program";
    reviewer: string;
    verdict: "accepted" | "revision-required";
    reason: string;
  }[];
}
export interface ResearchTaskChange {
  id: string;
  at: string;
  inputId: string;
  fromVersion: number | null;
  toVersion: number;
  reason: string;
  authorizedBy: "user" | "existing-authorization" | "routine";
  authorizationRef: string;
  /** Explicit extra impact when available dependencies are incomplete. */
  additionalTaskIds: string[];
  affectedTaskIds: string[];
}
export interface ResearchTaskDecision {
  id: string;
  inputId: string;
  version: number;
  at: string;
  actor: "user" | "mentor-agent" | "external-expert";
  text: string;
  /** Reference to actual user input, agent verdict, or external statement. */
  evidenceRef: string;
  requestId?: string;
  optionId?: string;
  outcome?: "confirmed" | "declined" | "deferred";
  origin?: "new-reply" | "prior-authorization";
  /** Actual prior user decision; the current mapping also has its own user-action evidence. */
  sourceDecisionId?: string;
}
export interface ResearchDecisionRequest {
  id: string;
  inputId: string;
  version: number;
  at: string;
  requestedBy: string;
  question: string;
  context: string;
  impact: string;
  options: {
    id: string;
    label: string;
    consequence: string;
    outcome: "confirmed" | "declined" | "deferred";
  }[];
  recommendedOptionId: string;
  taskIds: string[];
  affectedTaskIds: string[];
}
export interface ResearchAttemptResolution {
  id: string;
  attemptId: string;
  at: string;
  outcome: "succeeded" | "failed" | "cancelled";
  actor: "user" | "provider-record" | "native-session-record";
  evidenceRef: string;
  reason: string;
  usedTokens?: number;
}
export interface ResearchTaskRetryRequest {
  id: string;
  taskId: string;
  at: string;
  reason: string;
  evidenceRef: string;
}
export interface ResearchTaskGraph {
  version: 1;
  projectId: string;
  methodVersion: string;
  paused: boolean;
  inputs: ResearchTaskInput[];
  adoptedInputs: ResearchTaskInputRef[];
  tasks: ResearchTask[];
  attempts: ResearchTaskAttempt[];
  artifacts: ResearchTaskArtifact[];
  changes: ResearchTaskChange[];
  decisions: ResearchTaskDecision[];
  decisionRequests?: ResearchDecisionRequest[];
  attemptResolutions?: ResearchAttemptResolution[];
  retryRequests?: ResearchTaskRetryRequest[];
}

function invalid(message: string): never {
  throw new Error(`研究任务记录无效：${message}`);
}
function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid(`${label} 含未知字段`);
  return result;
}
function text(value: unknown, label: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > 2_000_000)
    invalid(label);
}
function integer(value: unknown, label: string, minimum = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(label);
}
function oneOf(value: unknown, values: readonly string[], label: string): void {
  if (typeof value !== "string" || !values.includes(value)) invalid(label);
}
function boolean(value: unknown, label: string): void {
  if (typeof value !== "boolean") invalid(label);
}
function array(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > 100_000) invalid(label);
}
function refs(value: unknown): void {
  array(value, "输入引用");
  const keys = new Set<string>();
  for (const raw of value) {
    const r = record(raw, ["inputId", "version", "requirement"], "输入引用");
    text(r.inputId, "输入身份");
    integer(r.version, "输入版本");
    if (r.requirement !== undefined)
      oneOf(r.requirement, ["available", "user-confirmed"], "输入关口");
    if (keys.has(r.inputId)) invalid("重复输入引用");
    keys.add(r.inputId);
  }
}
function strings(value: unknown, label: string): void {
  array(value, label);
  value.forEach((item) => text(item, label));
  if (new Set(value).size !== value.length) invalid(`重复${label}`);
}
function stamp(value: unknown): void {
  text(value, "时间");
  if (!Number.isFinite(Date.parse(value))) invalid("时间");
}
function optionalText(value: unknown, label: string): void {
  if (value !== undefined) text(value, label);
}

/** Reject schema skew and broken identity/version links before replacing durable project state. */
export function decodeResearchTaskGraph(value: unknown): ResearchTaskGraph {
  const g = record(
    value,
    [
      "version",
      "projectId",
      "methodVersion",
      "paused",
      "inputs",
      "adoptedInputs",
      "tasks",
      "attempts",
      "artifacts",
      "changes",
      "decisions",
      "decisionRequests",
      "attemptResolutions",
      "retryRequests",
    ],
    "任务图",
  );
  if (g.version !== 1) invalid("任务图版本");
  text(g.projectId, "项目身份");
  text(g.methodVersion, "方法版本");
  boolean(g.paused, "暂停状态");
  for (const key of ["inputs", "tasks", "attempts", "artifacts", "changes", "decisions"])
    array(g[key], key);
  refs(g.adoptedInputs);
  const inputs = g.inputs as unknown[],
    tasks = g.tasks as unknown[],
    attempts = g.attempts as unknown[],
    artifacts = g.artifacts as unknown[],
    changes = g.changes as unknown[],
    decisions = g.decisions as unknown[];
  for (const raw of inputs) {
    const r = record(
      raw,
      ["inputId", "version", "kind", "availability", "actual", "label", "sourceRef", "digest"],
      "输入",
    );
    text(r.inputId, "输入身份");
    integer(r.version, "输入版本");
    oneOf(r.kind, ["material", "decision", "context"], "输入类别");
    oneOf(r.availability, ["available", "planned", "missing", "withdrawn"], "材料状态");
    boolean(r.actual, "实际材料");
    for (const k of ["label", "sourceRef", "digest"]) text(r[k], k);
    if (r.actual && r.kind !== "material") invalid("实际材料类别");
  }
  for (const raw of tasks) {
    const r = record(
      raw,
      [
        "id",
        "stage",
        "role",
        "kind",
        "goal",
        "inputVersion",
        "inputs",
        "dependencies",
        "earlyHandoff",
        "deliverable",
        "reviewRequired",
        "writeScope",
        "tokenBudget",
        "state",
        "blockers",
        "continuations",
        "currentArtifactId",
        "error",
      ],
      "任务",
    );
    for (const k of ["id", "stage", "role", "goal", "deliverable"]) text(r[k], k);
    text(r.earlyHandoff, "提前交接", true);
    oneOf(r.kind, ["proposal", "analysis", "research", "review", "writing"], "任务类别");
    integer(r.inputVersion, "任务输入版本");
    refs(r.inputs);
    for (const input of r.inputs as Record<string, unknown>[])
      oneOf(input.requirement, ["available", "user-confirmed"], "任务输入关口");
    array(r.dependencies, "任务依赖");
    const dependencies = new Set<string>();
    for (const d of r.dependencies) {
      const dep = record(d, ["taskId", "requirement"], "任务依赖");
      text(dep.taskId, "依赖任务");
      oneOf(dep.requirement, ["published", "accepted"], "依赖关口");
      if (dependencies.has(dep.taskId)) invalid("重复任务依赖");
      dependencies.add(dep.taskId);
    }
    boolean(r.reviewRequired, "审阅要求");
    strings(r.writeScope, "写入范围");
    if (r.tokenBudget !== undefined) integer(r.tokenBudget, "任务预算", 0);
    oneOf(r.state, RESEARCH_TASK_STATES, "执行状态");
    array(r.blockers, "等待原因");
    for (const rawBlock of r.blockers) {
      const b = record(rawBlock, ["kind", "objectId", "reason"], "等待原因");
      oneOf(b.kind, ["input", "decision", "task", "attempt", "pause", "material"], "等待类别");
      text(b.objectId, "等待对象");
      text(b.reason, "等待原因");
    }
    array(r.continuations, "接续请求");
    for (const rawContinuation of r.continuations) {
      const c = record(rawContinuation, ["id", "at", "reason", "attemptId"], "接续请求");
      text(c.id, "接续身份");
      stamp(c.at);
      text(c.reason, "接续原因");
      optionalText(c.attemptId, "接续尝试");
    }
    optionalText(r.currentArtifactId, "当前成果");
    optionalText(r.error, "任务错误");
  }
  for (const raw of attempts) {
    const r = record(
      raw,
      [
        "id",
        "taskId",
        "taskVersion",
        "inputRefs",
        "dependencyArtifactIds",
        "acquiredInputs",
        "acquiredArtifacts",
        "state",
        "preparedAt",
        "dispatchedAt",
        "nativeRunId",
        "sessionTotalTokens",
        "tokenUsage",
        "sessionTokenUsage",
        "finishedAt",
        "model",
        "modelSource",
        "reservedTokens",
        "usedTokens",
        "error",
      ],
      "执行尝试",
    );
    text(r.id, "尝试身份");
    text(r.taskId, "尝试任务");
    integer(r.taskVersion, "尝试输入版本");
    refs(r.inputRefs);
    if (r.acquiredInputs !== undefined) {
      array(r.acquiredInputs, "运行中取得的输入");
      const acquiredIds = new Set<string>();
      for (const rawInput of r.acquiredInputs) {
        const input = record(rawInput, ["inputId", "version", "at", "evidenceRef"], "运行中输入");
        text(input.inputId, "取得的输入身份");
        integer(input.version, "取得的输入版本");
        stamp(input.at);
        text(input.evidenceRef, "实际读取证据");
        if (acquiredIds.has(input.inputId)) invalid("重复运行中输入");
        acquiredIds.add(input.inputId);
      }
    }
    if (r.acquiredArtifacts !== undefined) {
      array(r.acquiredArtifacts, "运行中取得的成果");
      const ids = new Set<string>();
      for (const rawArtifact of r.acquiredArtifacts) {
        const artifact = record(rawArtifact, ["artifactId", "at", "evidenceRef"], "运行中成果");
        text(artifact.artifactId, "取得的成果身份");
        stamp(artifact.at);
        text(artifact.evidenceRef, "读取依据");
        if (ids.has(artifact.artifactId)) invalid("重复运行中成果");
        ids.add(artifact.artifactId);
      }
    }
    strings(r.dependencyArtifactIds, "依赖成果");
    oneOf(
      r.state,
      ["prepared", "running", "succeeded", "failed", "cancelled", "unknown"],
      "尝试状态",
    );
    stamp(r.preparedAt);
    if (r.dispatchedAt !== undefined) stamp(r.dispatchedAt);
    optionalText(r.nativeRunId, "原生运行身份");
    validateResearchUsage(r as unknown as ResearchTaskAttempt);
    if (r.sessionTotalTokens !== undefined) integer(r.sessionTotalTokens, "会话累计用量", 0);
    if (r.finishedAt !== undefined) stamp(r.finishedAt);
    integer(r.reservedTokens, "预留用量", 0);
    if (r.usedTokens !== undefined) integer(r.usedTokens, "实际用量", 0);
    optionalText(r.error, "尝试错误");
    if (
      ["running", "unknown", "succeeded"].includes(r.state as string) &&
      r.dispatchedAt === undefined
    )
      invalid("尝试缺派发记录");
    if (r.model !== undefined) {
      const model = record(r.model, ["provider", "modelId", "thinkingLevel"], "实际模型");
      text(model.provider, "提供商");
      text(model.modelId, "模型");
      optionalText(model.thinkingLevel, "思考强度");
    }
    if (r.modelSource !== undefined)
      oneOf(
        r.modelSource,
        [
          "task-override",
          "stage-role",
          "project-default",
          "application-default",
          "session-current",
          "authorized-recovery",
        ],
        "模型选择来源",
      );
  }
  for (const raw of artifacts) {
    const r = record(
      raw,
      [
        "id",
        "taskId",
        "taskVersion",
        "attemptId",
        "createdAt",
        "content",
        "inputRefs",
        "dependencyArtifactIds",
        "interim",
        "reviewState",
        "reviews",
      ],
      "成果",
    );
    for (const k of ["id", "taskId", "attemptId", "content"]) text(r[k], k);
    integer(r.taskVersion, "成果输入版本");
    stamp(r.createdAt);
    refs(r.inputRefs);
    strings(r.dependencyArtifactIds, "成果依赖");
    boolean(r.interim, "中间成果");
    oneOf(r.reviewState, RESEARCH_REVIEW_STATES, "审阅状态");
    array(r.reviews, "审阅记录");
    for (const rawReview of r.reviews) {
      const review = record(
        rawReview,
        ["id", "at", "actor", "reviewer", "verdict", "reason"],
        "审阅",
      );
      for (const k of ["id", "reviewer", "reason"]) text(review[k], k);
      stamp(review.at);
      oneOf(review.actor, ["model", "user", "external-expert", "program"], "审阅身份");
      oneOf(review.verdict, ["accepted", "revision-required"], "审阅结论");
    }
  }
  for (const raw of changes) {
    const r = record(
      raw,
      [
        "id",
        "at",
        "inputId",
        "fromVersion",
        "toVersion",
        "reason",
        "authorizedBy",
        "authorizationRef",
        "additionalTaskIds",
        "affectedTaskIds",
      ],
      "变更",
    );
    for (const k of ["id", "inputId", "reason", "authorizationRef"]) text(r[k], k);
    stamp(r.at);
    if (r.fromVersion !== null) integer(r.fromVersion, "变更前版本");
    integer(r.toVersion, "变更后版本");
    oneOf(r.authorizedBy, ["user", "existing-authorization", "routine"], "变更授权");
    strings(r.additionalTaskIds, "补充影响");
    strings(r.affectedTaskIds, "影响任务");
  }
  for (const raw of decisions) {
    const r = record(
      raw,
      [
        "id",
        "inputId",
        "version",
        "at",
        "actor",
        "text",
        "evidenceRef",
        "requestId",
        "optionId",
        "outcome",
        "origin",
        "sourceDecisionId",
      ],
      "决定",
    );
    for (const k of ["id", "inputId", "text", "evidenceRef"]) text(r[k], k);
    integer(r.version, "决定输入版本");
    stamp(r.at);
    oneOf(r.actor, ["user", "mentor-agent", "external-expert"], "决定身份");
    optionalText(r.requestId, "决定请求");
    optionalText(r.optionId, "用户选项");
    optionalText(r.sourceDecisionId, "沿用决定来源");
    if (
      r.sourceDecisionId !== undefined &&
      (r.actor !== "user" || r.origin !== "prior-authorization" || r.outcome !== "confirmed")
    )
      invalid("沿用来源只能属于用户明确映射的确认记录");
    if (r.outcome !== undefined)
      oneOf(r.outcome, ["confirmed", "declined", "deferred"], "用户答复结果");
    if (r.origin !== undefined) oneOf(r.origin, ["new-reply", "prior-authorization"], "答复来源");
  }
  for (const key of ["decisionRequests", "attemptResolutions", "retryRequests"])
    if (g[key] !== undefined) array(g[key], key);
  for (const raw of (g.decisionRequests ?? []) as unknown[]) {
    const r = record(
      raw,
      [
        "id",
        "inputId",
        "version",
        "at",
        "requestedBy",
        "question",
        "context",
        "impact",
        "options",
        "recommendedOptionId",
        "taskIds",
        "affectedTaskIds",
      ],
      "人的决定请求",
    );
    for (const k of [
      "id",
      "inputId",
      "requestedBy",
      "question",
      "context",
      "impact",
      "recommendedOptionId",
    ])
      text(r[k], k);
    integer(r.version, "条件版本");
    stamp(r.at);
    strings(r.taskIds, "决定范围");
    strings(r.affectedTaskIds, "决定影响");
    array(r.options, "决定选项");
    if (r.options.length < 2 || r.options.length > 8) invalid("决定需要2至8个明确选项");
    const options = new Set<string>();
    for (const rawOption of r.options) {
      const option = record(rawOption, ["id", "label", "consequence", "outcome"], "决定选项");
      for (const k of ["id", "label", "consequence"]) text(option[k], k);
      oneOf(option.outcome, ["confirmed", "declined", "deferred"], "选项结果");
      if (options.has(option.id as string)) invalid("重复决定选项");
      options.add(option.id as string);
    }
    if (!options.has(r.recommendedOptionId as string)) invalid("推荐选项不存在");
  }
  for (const raw of (g.attemptResolutions ?? []) as unknown[]) {
    const r = record(
      raw,
      ["id", "attemptId", "at", "outcome", "actor", "evidenceRef", "reason", "usedTokens"],
      "未知请求核对",
    );
    for (const k of ["id", "attemptId", "evidenceRef", "reason"]) text(r[k], k);
    stamp(r.at);
    oneOf(r.outcome, ["succeeded", "failed", "cancelled"], "核对结果");
    oneOf(r.actor, ["user", "provider-record", "native-session-record"], "核对身份");
    if (r.usedTokens !== undefined) integer(r.usedTokens, "核对用量", 0);
  }
  for (const raw of (g.retryRequests ?? []) as unknown[]) {
    const r = record(raw, ["id", "taskId", "at", "reason", "evidenceRef"], "显式任务重试");
    for (const k of ["id", "taskId", "reason", "evidenceRef"]) text(r[k], k);
    stamp(r.at);
  }
  const graph = value as ResearchTaskGraph;
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length) invalid(`重复${label}`);
  };
  unique(
    graph.inputs.map((i) => JSON.stringify([i.inputId, i.version])),
    "输入版本",
  );
  for (const items of [
    graph.tasks,
    graph.attempts,
    graph.artifacts,
    graph.changes,
    graph.decisions,
  ])
    unique(
      items.map((i) => i.id),
      "身份",
    );
  for (const items of [
    graph.decisionRequests ?? [],
    graph.attemptResolutions ?? [],
    graph.retryRequests ?? [],
  ])
    unique(
      items.map((item) => item.id),
      "恢复或决定身份",
    );
  unique(
    (graph.decisionRequests ?? []).map((request) =>
      JSON.stringify([request.inputId, request.version]),
    ),
    "决定条件版本",
  );
  const hasInput = (ref: ResearchTaskInputRef) =>
    graph.inputs.some((i) => i.inputId === ref.inputId && i.version === ref.version);
  const taskMap = new Map(graph.tasks.map((t) => [t.id, t]));
  const artifactMap = new Map(graph.artifacts.map((a) => [a.id, a]));
  const attemptMap = new Map(graph.attempts.map((a) => [a.id, a]));
  if (graph.adoptedInputs.some((i) => !hasInput(i))) invalid("采用输入不存在");
  for (const task of graph.tasks) {
    if (task.inputs.some((i) => !hasInput(i))) invalid("任务输入不存在");
    if (task.dependencies.some((d) => !taskMap.has(d.taskId) || d.taskId === task.id))
      invalid("依赖任务不存在或自循环");
    unique(
      task.continuations.map((c) => c.id),
      "接续身份",
    );
    if (
      task.continuations.some((c) => c.attemptId && attemptMap.get(c.attemptId)?.taskId !== task.id)
    )
      invalid("接续尝试不属于任务");
    if (task.currentArtifactId) {
      const a = artifactMap.get(task.currentArtifactId);
      if (
        !a ||
        a.taskId !== task.id ||
        a.taskVersion !== task.inputVersion ||
        ["superseded", "needs-review"].includes(a.reviewState)
      )
        invalid("当前成果版本不一致");
    }
  }
  const done = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) invalid("任务依赖循环");
    if (done.has(id)) return;
    visiting.add(id);
    taskMap.get(id)!.dependencies.forEach((d) => visit(d.taskId));
    visiting.delete(id);
    done.add(id);
  };
  graph.tasks.forEach((t) => visit(t.id));
  for (const a of graph.attempts) {
    const task = taskMap.get(a.taskId);
    if (
      !task ||
      a.taskVersion > task.inputVersion ||
      [...a.inputRefs, ...(a.acquiredInputs ?? [])].some((i) => !hasInput(i)) ||
      [...a.dependencyArtifactIds, ...(a.acquiredArtifacts ?? []).map((r) => r.artifactId)].some(
        (id) => !artifactMap.has(id),
      )
    )
      invalid("尝试关联损坏");
  }
  for (const a of graph.artifacts) {
    const attempt = attemptMap.get(a.attemptId);
    if (
      !attempt ||
      a.taskId !== attempt.taskId ||
      a.taskVersion !== attempt.taskVersion ||
      attempt.inputRefs.some(
        (ref) => !a.inputRefs.some((i) => i.inputId === ref.inputId && i.version === ref.version),
      ) ||
      a.inputRefs.some(
        (ref) =>
          ![...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].some(
            (i) => i.inputId === ref.inputId && i.version === ref.version,
          ),
      ) ||
      attempt.dependencyArtifactIds.some((id) => !a.dependencyArtifactIds.includes(id)) ||
      a.dependencyArtifactIds.some(
        (id) =>
          ![
            ...attempt.dependencyArtifactIds,
            ...(attempt.acquiredArtifacts ?? []).map((r) => r.artifactId),
          ].includes(id),
      )
    )
      invalid("成果尝试关联不一致");
    unique(
      a.reviews.map((r) => r.id),
      "审阅身份",
    );
    if (a.reviewState === "accepted" && !a.reviews.some((r) => r.verdict === "accepted"))
      invalid("接受成果缺审阅依据");
  }
  for (const c of graph.changes) {
    if (
      !hasInput({ inputId: c.inputId, version: c.toVersion }) ||
      (c.fromVersion !== null && !hasInput({ inputId: c.inputId, version: c.fromVersion })) ||
      [...c.affectedTaskIds, ...c.additionalTaskIds].some((id) => !taskMap.has(id))
    )
      invalid("变更关联损坏");
  }
  for (const d of graph.decisions)
    if (
      !graph.inputs.some(
        (i) => i.kind === "decision" && i.inputId === d.inputId && i.version === d.version,
      )
    )
      invalid("决定对象不存在");
  for (const request of graph.decisionRequests ?? []) {
    if (
      !graph.inputs.some(
        (i) =>
          i.inputId === request.inputId && i.version === request.version && i.kind === "decision",
      ) ||
      !request.taskIds.length ||
      [...request.taskIds, ...request.affectedTaskIds].some((id) => !taskMap.has(id))
    )
      invalid("决定请求关联损坏");
  }
  for (const decision of graph.decisions.filter((d) => d.requestId !== undefined)) {
    const request = graph.decisionRequests?.find((r) => r.id === decision.requestId);
    const option = request?.options.find((o) => o.id === decision.optionId);
    if (
      !request ||
      request.inputId !== decision.inputId ||
      request.version !== decision.version ||
      decision.actor !== "user" ||
      !option ||
      option.outcome !== decision.outcome ||
      !decision.origin
    )
      invalid("人的答复与请求不一致");
  }
  for (const [index, decision] of graph.decisions.entries()) {
    if (!decision.sourceDecisionId) continue;
    const source = graph.decisions
      .slice(0, index)
      .find((item) => item.id === decision.sourceDecisionId);
    if (
      !source ||
      source.actor !== "user" ||
      source.outcome !== "confirmed" ||
      !source.requestId ||
      source.evidenceRef !== `user-action:${source.id}` ||
      decision.evidenceRef !== `user-action:${decision.id}` ||
      !(
        source.origin === "new-reply" ||
        (source.origin === "prior-authorization" && source.sourceDecisionId)
      )
    )
      invalid("沿用决定缺少实际在先用户选择及本次映射出处");
  }
  for (const resolution of graph.attemptResolutions ?? [])
    if (!attemptMap.has(resolution.attemptId)) invalid("核对请求不存在");
  for (const retry of graph.retryRequests ?? [])
    if (!taskMap.has(retry.taskId)) invalid("重试任务不存在");
  return structuredClone(graph);
}
