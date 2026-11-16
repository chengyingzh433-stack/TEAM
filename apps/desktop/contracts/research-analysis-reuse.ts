/** Project-private evidence. None of these identities may come from a model tool payload. */
export interface AnalysisNativeContext {
  projectId: string;
  revision: number;
  role: "lead" | "reviewer" | "mentor" | "librarian";
  taskId: string;
  taskInputVersion: number;
  attemptId: string;
  nativeRunId: string;
  sessionId: string;
  model: { provider: string; modelId: string; thinkingLevel?: string };
}
export interface AnalysisResultPin {
  runId: string;
  runSha256: string;
  projectionSha256: string;
  planId: string;
  planVersion: number;
  planSha256: string;
  datasetId: string;
  datasetSha256: string;
  datasetInput: { inputId: string; version: number };
  engine: string;
  adapter: "analysis-registry-1";
  /** Includes the referenced comparison-plan closure, not unrelated plans. */
  plans: { id: string; version: number; sha256: string; inputId: string; inputVersion: number }[];
}
export const ANALYSIS_ARCHIVE_FILES = [
  "input.csv",
  "calculation-input.csv",
  "plan.json",
  "registered-run.json",
  "result.json",
  "replay.mjs",
] as const;
export type AnalysisArchiveHashes = Record<
  (typeof ANALYSIS_ARCHIVE_FILES)[number] | "dataset",
  string
>;
export interface ResearchAnalysisRunAdoption {
  id: string;
  kind: "analysis-result-reuse";
  at: string;
  callId: string;
  reason: string;
  source: AnalysisNativeContext;
  target: AnalysisNativeContext;
  pin: AnalysisResultPin;
  changeIds: string[];
  fileHashes: AnalysisArchiveHashes;
  integritySha256: string;
}
export interface ResearchAnalysisRead {
  id: string;
  kind: "analysis-operation-receipt";
  at: string;
  callId: string;
  operation: "run-analysis" | "read-analysis" | "read-registered-analysis";
  context: AnalysisNativeContext;
  pin: AnalysisResultPin;
  adoptionId?: string;
  usableForCurrentInputs: boolean;
  integritySha256: string;
}
export interface ResearchAnalysisReviewContext {
  id: string;
  kind: "analysis-interpretation-context";
  at: string;
  callId: string;
  reviewId: string;
  reviewSha256: string;
  context: AnalysisNativeContext;
  runId: string;
  runSha256: string;
  readId: string;
  adoptionId?: string;
  integritySha256: string;
}
export interface ResearchAnalysisReuseRecords {
  analysisRunAdoptions?: ResearchAnalysisRunAdoption[];
  analysisReads?: ResearchAnalysisRead[];
  analysisReviewContexts?: ResearchAnalysisReviewContext[];
}
function fail(): never {
  throw new Error("分析复用凭据格式、身份或引用无效。");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    fail();
}
function number(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail();
}
function sha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
}
function time(value: unknown): asserts value is string {
  text(value, 100);
  if (!Number.isFinite(Date.parse(value))) fail();
}
function context(value: unknown): AnalysisNativeContext {
  const row = object(value, [
    "projectId",
    "revision",
    "role",
    "taskId",
    "taskInputVersion",
    "attemptId",
    "nativeRunId",
    "sessionId",
    "model",
  ]);
  for (const key of ["projectId", "taskId", "attemptId", "nativeRunId", "sessionId"])
    text(row[key]);
  number(row.revision);
  number(row.taskInputVersion);
  if (!["lead", "reviewer", "mentor", "librarian"].includes(String(row.role))) fail();
  if (!String(row.taskId).startsWith(`v${row.revision}:`)) fail();
  const model = object(row.model, ["provider", "modelId", "thinkingLevel"]);
  text(model.provider);
  text(model.modelId);
  if (
    model.thinkingLevel !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(model.thinkingLevel))
  )
    fail();
  return structuredClone(value) as AnalysisNativeContext;
}
function pin(value: unknown): AnalysisResultPin {
  const row = object(value, [
    "runId",
    "runSha256",
    "projectionSha256",
    "planId",
    "planVersion",
    "planSha256",
    "datasetId",
    "datasetSha256",
    "datasetInput",
    "engine",
    "adapter",
    "plans",
  ]);
  for (const key of ["runId", "planId", "datasetId", "engine"]) text(row[key]);
  for (const key of ["runSha256", "projectionSha256", "planSha256", "datasetSha256"]) sha(row[key]);
  number(row.planVersion);
  if (row.adapter !== "analysis-registry-1") fail();
  const data = object(row.datasetInput, ["inputId", "version"]);
  number(data.version);
  if (data.inputId !== `dataset:${row.datasetId}`) fail();
  if (!Array.isArray(row.plans) || !row.plans.length || row.plans.length > 1000) fail();
  const ids = new Set<string>();
  for (const entry of row.plans) {
    const plan = object(entry, ["id", "version", "sha256", "inputId", "inputVersion"]);
    text(plan.id);
    number(plan.version);
    sha(plan.sha256);
    number(plan.inputVersion);
    if (ids.has(plan.id) || plan.inputId !== `analysis-plan:${plan.id}`) fail();
    ids.add(plan.id);
  }
  if (
    !row.plans.some((entry: unknown) => {
      const p = entry as Record<string, unknown>;
      return p.id === row.planId && p.version === row.planVersion && p.sha256 === row.planSha256;
    })
  )
    fail();
  return structuredClone(value) as AnalysisResultPin;
}
/** Renderer-safe shape/reference validation. Electron additionally verifies immutable SHA contents. */
export function decodeResearchAnalysisReuseRecords(value: unknown): ResearchAnalysisReuseRecords {
  const row = object(value, ["analysisRunAdoptions", "analysisReads", "analysisReviewContexts"]);
  const list = (key: string): unknown[] => {
    const items = row[key];
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 20_000) fail();
    return items;
  };
  const ids = new Set<string>();
  const common = (item: Record<string, unknown>) => {
    text(item.id);
    text(item.callId);
    time(item.at);
    sha(item.integritySha256);
    if (ids.has(item.id)) fail();
    ids.add(item.id);
  };
  const adoptions = list("analysisRunAdoptions").map((item) => {
    const r = object(item, [
      "id",
      "kind",
      "at",
      "callId",
      "reason",
      "source",
      "target",
      "pin",
      "changeIds",
      "fileHashes",
      "integritySha256",
    ]);
    common(r);
    if (r.kind !== "analysis-result-reuse") fail();
    text(r.reason, 6000);
    const source = context(r.source),
      target = context(r.target);
    pin(r.pin);
    if (
      !["lead", "reviewer"].includes(target.role) ||
      source.role !== target.role ||
      source.projectId !== target.projectId ||
      source.revision !== target.revision ||
      source.taskId !== target.taskId ||
      source.taskInputVersion >= target.taskInputVersion ||
      source.attemptId === target.attemptId
    )
      fail();
    if (
      !Array.isArray(r.changeIds) ||
      !r.changeIds.length ||
      r.changeIds.length > 10_000 ||
      new Set(r.changeIds).size !== r.changeIds.length
    )
      fail();
    r.changeIds.forEach((id) => text(id));
    const hashes = object(r.fileHashes, ["dataset", ...ANALYSIS_ARCHIVE_FILES]);
    for (const key of ["dataset", ...ANALYSIS_ARCHIVE_FILES]) sha(hashes[key]);
    if (
      hashes.dataset !== (r.pin as AnalysisResultPin).datasetSha256 ||
      hashes["input.csv"] !== hashes.dataset
    )
      fail();
    return structuredClone(item) as ResearchAnalysisRunAdoption;
  });
  const reads = list("analysisReads").map((item) => {
    const r = object(item, [
      "id",
      "kind",
      "at",
      "callId",
      "operation",
      "context",
      "pin",
      "adoptionId",
      "usableForCurrentInputs",
      "integritySha256",
    ]);
    common(r);
    if (
      r.kind !== "analysis-operation-receipt" ||
      !["run-analysis", "read-analysis", "read-registered-analysis"].includes(
        String(r.operation),
      ) ||
      typeof r.usableForCurrentInputs !== "boolean"
    )
      fail();
    const c = context(r.context),
      p = pin(r.pin);
    if (r.adoptionId !== undefined) {
      text(r.adoptionId);
      const adopted = adoptions.find((a) => a.id === r.adoptionId);
      if (
        !adopted ||
        !r.usableForCurrentInputs ||
        r.operation === "run-analysis" ||
        adopted.pin.runId !== p.runId ||
        adopted.pin.runSha256 !== p.runSha256 ||
        adopted.target.projectId !== c.projectId ||
        adopted.target.revision !== c.revision ||
        Date.parse(adopted.at) > Date.parse(String(r.at))
      )
        fail();
    }
    return structuredClone(item) as ResearchAnalysisRead;
  });
  const reviews = list("analysisReviewContexts").map((item) => {
    const r = object(item, [
      "id",
      "kind",
      "at",
      "callId",
      "reviewId",
      "reviewSha256",
      "context",
      "runId",
      "runSha256",
      "readId",
      "adoptionId",
      "integritySha256",
    ]);
    common(r);
    if (r.kind !== "analysis-interpretation-context") fail();
    for (const key of ["reviewId", "runId", "readId"]) text(r[key]);
    sha(r.reviewSha256);
    sha(r.runSha256);
    const c = context(r.context),
      read = reads.find((read) => read.id === r.readId);
    if (
      !["reviewer", "mentor"].includes(c.role) ||
      !read ||
      !read.usableForCurrentInputs ||
      read.pin.runId !== r.runId ||
      read.pin.runSha256 !== r.runSha256 ||
      JSON.stringify(read.context) !== JSON.stringify(c) ||
      read.adoptionId !== r.adoptionId ||
      Date.parse(read.at) > Date.parse(String(r.at))
    )
      fail();
    return structuredClone(item) as ResearchAnalysisReviewContext;
  });
  if (new Set(reviews.map((r) => r.reviewId)).size !== reviews.length) fail();
  return {
    ...(row.analysisRunAdoptions !== undefined ? { analysisRunAdoptions: adoptions } : {}),
    ...(row.analysisReads !== undefined ? { analysisReads: reads } : {}),
    ...(row.analysisReviewContexts !== undefined ? { analysisReviewContexts: reviews } : {}),
  };
}
