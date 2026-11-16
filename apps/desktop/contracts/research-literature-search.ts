import type { ResearchClaimDepth } from "./research-claims";

export interface ResearchLiteratureActor {
  kind: "model" | "user" | "external" | "host";
  id: string;
  sessionId?: string;
  evidenceRef: string;
}
export interface ResearchLiteratureHost {
  id: string;
  at: string;
  actor: ResearchLiteratureActor;
}
export interface ResearchLiteratureStrategyRequest {
  id: string;
  version: number;
  questionVersion: string;
  question: string;
  concepts: string[];
  synonyms: string[];
  queries: { source: string; query: string; filters: string }[];
  inclusionCriteria: string[];
  exclusionCriteria: string[];
  stopRule: string;
  changeReason: string;
}
export interface ResearchLiteratureStrategy extends ResearchLiteratureStrategyRequest {
  recordedBy: ResearchLiteratureHost;
}
export interface ResearchLiteratureBatch {
  id: string;
  strategyId: string;
  strategyVersion: number;
  origin: "execution" | "import";
  host: ResearchLiteratureHost;
  startedAt: string;
  completedAt: string;
  query: string | null;
  endpoint: string | null;
  status: "succeeded" | "failed";
  failure: string | null;
  limitations: string[];
  representation: "returned-candidate-metadata" | "imported-json-records";
  original: {
    name: string;
    text: string;
    sha256: string;
    encoding: "utf8" | "base64";
    available: boolean;
  };
  recordIds: string[];
}
export interface ResearchLiteratureRecord {
  id: string;
  batchId: string;
  index: number;
  rawJson: string;
  rawSha256: string;
  /** Reliable DOI or exact canonical URL; title similarity is never an identity. */
  dedupeKey: string;
}
export interface ResearchLiteratureScreenRequest {
  recordId: string;
  strategyId: string;
  strategyVersion: number;
  decision: "include" | "exclude" | "undecided";
  depth: ResearchClaimDepth;
  reason: string;
  readIds: string[];
}
export interface ResearchLiteratureScreen extends ResearchLiteratureScreenRequest {
  host: ResearchLiteratureHost;
  rawSha256: string;
  /** Exact host-validated read scope, not a claim that every page or figure was read. */
  readings: {
    readId: string;
    sourceId: string;
    sourceSha256: string;
    bodySha256: string;
    locatorId: string;
    start: number;
    end: number;
    depth: ResearchClaimDepth;
    evidenceRef: string;
  }[];
}
export interface ResearchLiteratureStop {
  strategyId: string;
  strategyVersion: number;
  reason: string;
  remainingLimitations: string[];
  host: ResearchLiteratureHost;
}
export interface ResearchLiteratureAccess {
  recordId: string;
  url: string;
  host: ResearchLiteratureHost;
  outcome:
    | { status: "fetched-text"; sourceId: string; sourceSha256: string }
    | { status: "failed"; error: string };
}
export interface ResearchLiteratureSearch {
  schemaVersion: 1;
  strategies: ResearchLiteratureStrategy[];
  batches: ResearchLiteratureBatch[];
  records: ResearchLiteratureRecord[];
  screenings: ResearchLiteratureScreen[];
  stops: ResearchLiteratureStop[];
  accesses: ResearchLiteratureAccess[];
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("检索记录含无效或未知字段。");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 12000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("检索记录需要非空文本。");
}
function list(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > 20000) throw new Error("检索清单无效。");
}
function texts(value: unknown) {
  list(value);
  value.forEach((item) => text(item));
}
function time(value: unknown) {
  text(value);
  if (!Number.isFinite(Date.parse(value))) throw new Error("检索时间无效。");
}
function hash(value: unknown) {
  text(value);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("检索摘要无效。");
}
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("检索版本无效。");
}
const depths = ["metadata", "abstract", "partial-text", "full-text"];
export function decodeResearchLiteratureHost(value: unknown): ResearchLiteratureHost {
  const r = object(value, ["id", "at", "actor"]),
    a = object(r.actor, ["kind", "id", "sessionId", "evidenceRef"]);
  text(r.id, 512);
  time(r.at);
  text(a.id, 512);
  text(a.evidenceRef);
  if (!["model", "user", "external", "host"].includes(String(a.kind)))
    throw new Error("实际操作者身份无效。");
  if (a.sessionId !== undefined) text(a.sessionId, 512);
  if (a.kind === "model" && !String(a.id).startsWith("model:"))
    throw new Error("模型身份必须明确标注。");
  return structuredClone(value) as ResearchLiteratureHost;
}
const strategyKeys = [
  "id",
  "version",
  "questionVersion",
  "question",
  "concepts",
  "synonyms",
  "queries",
  "inclusionCriteria",
  "exclusionCriteria",
  "stopRule",
  "changeReason",
];
export function decodeResearchLiteratureStrategyRequest(
  value: unknown,
): ResearchLiteratureStrategyRequest {
  const r = object(value, strategyKeys);
  for (const key of ["id", "questionVersion", "question", "stopRule", "changeReason"]) text(r[key]);
  version(r.version);
  for (const key of ["concepts", "synonyms", "inclusionCriteria", "exclusionCriteria"])
    texts(r[key]);
  list(r.queries);
  if (!r.queries.length) throw new Error("检索策略至少需要一条计划查询。");
  for (const q of r.queries) {
    const query = object(q, ["source", "query", "filters"]);
    text(query.source);
    text(query.query);
    text(query.filters);
  }
  return structuredClone(value) as ResearchLiteratureStrategyRequest;
}
export function decodeResearchLiteratureScreenRequest(
  value: unknown,
): ResearchLiteratureScreenRequest {
  const r = object(value, [
    "recordId",
    "strategyId",
    "strategyVersion",
    "decision",
    "depth",
    "reason",
    "readIds",
  ]);
  text(r.recordId);
  text(r.strategyId);
  text(r.reason);
  version(r.strategyVersion);
  texts(r.readIds);
  if (
    !["include", "exclude", "undecided"].includes(String(r.decision)) ||
    !depths.includes(String(r.depth))
  )
    throw new Error("筛选决定或阅读深度无效。");
  return structuredClone(value) as ResearchLiteratureScreenRequest;
}
export function decodeResearchLiteratureSearch(value: unknown): ResearchLiteratureSearch {
  const r = object(value, [
    "schemaVersion",
    "strategies",
    "batches",
    "records",
    "screenings",
    "stops",
    "accesses",
  ]);
  if (r.schemaVersion !== 1) throw new Error("检索记录版本无效。");
  for (const key of ["strategies", "batches", "records", "screenings", "stops", "accesses"])
    list(r[key]);
  const strategies = r.strategies as unknown[],
    batches = r.batches as unknown[],
    records = r.records as unknown[];
  const strategyIds = new Set<string>(),
    batchIds = new Set<string>(),
    recordIds = new Set<string>();
  const unique = (set: Set<string>, id: string) => {
    if (set.has(id)) throw new Error("检索记录身份重复。");
    set.add(id);
  };
  for (const item of strategies) {
    const row = object(item, [...strategyKeys, "recordedBy"]),
      { recordedBy, ...request } = row;
    const s = decodeResearchLiteratureStrategyRequest(request);
    decodeResearchLiteratureHost(recordedBy);
    unique(strategyIds, `${s.id}:${s.version}`);
  }
  const ref = (row: Record<string, unknown>) => {
    if (!strategyIds.has(`${String(row.strategyId)}:${String(row.strategyVersion)}`))
      throw new Error("引用的检索策略版本不存在。");
  };
  for (const item of batches) {
    const b = object(item, [
      "id",
      "strategyId",
      "strategyVersion",
      "origin",
      "host",
      "startedAt",
      "completedAt",
      "query",
      "endpoint",
      "status",
      "failure",
      "limitations",
      "representation",
      "original",
      "recordIds",
    ]);
    text(b.id);
    unique(batchIds, b.id);
    ref(b);
    decodeResearchLiteratureHost(b.host);
    time(b.startedAt);
    time(b.completedAt);
    texts(b.limitations);
    texts(b.recordIds);
    if (
      Date.parse(String(b.completedAt)) < Date.parse(String(b.startedAt)) ||
      !["execution", "import"].includes(String(b.origin)) ||
      !["succeeded", "failed"].includes(String(b.status))
    )
      throw new Error("实际检索批次无效。");
    if (b.status === "failed") {
      text(b.failure);
      if ((b.recordIds as unknown[]).length) throw new Error("失败批次不能计入返回记录。");
    } else if (b.failure !== null) throw new Error("成功批次不能冒称失败。");
    if (b.origin === "execution") {
      text(b.query);
      text(b.endpoint);
      if (b.representation !== "returned-candidate-metadata")
        throw new Error("检索原记录表示无效。");
    } else if (
      b.query !== null ||
      b.endpoint !== null ||
      b.representation !== "imported-json-records"
    )
      throw new Error("导入不能冒充实际查询。");
    const o = object(b.original, ["name", "text", "sha256", "encoding", "available"]);
    text(o.name);
    hash(o.sha256);
    if (
      typeof o.available !== "boolean" ||
      (b.status === "succeeded" && o.available !== true) ||
      !["utf8", "base64"].includes(String(o.encoding)) ||
      typeof o.text !== "string" ||
      o.text.length > 14000000
    )
      throw new Error("原记录过大或无效。");
  }
  for (const item of records) {
    const row = object(item, ["id", "batchId", "index", "rawJson", "rawSha256", "dedupeKey"]);
    text(row.id);
    unique(recordIds, row.id);
    text(row.batchId);
    text(row.dedupeKey);
    hash(row.rawSha256);
    text(row.rawJson, 1000000);
    if (!batchIds.has(row.batchId) || !Number.isSafeInteger(row.index) || Number(row.index) < 0)
      throw new Error("候选原记录批次无效。");
    const raw: unknown = JSON.parse(row.rawJson);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("候选原记录必须为对象。");
  }
  for (const raw of batches) {
    const batch = raw as ResearchLiteratureBatch;
    const members = (records as ResearchLiteratureRecord[]).filter(
      (row) => row.batchId === batch.id,
    );
    if (
      JSON.stringify(members.map((row) => row.id)) !== JSON.stringify(batch.recordIds) ||
      members.some((row, index) => row.index !== index)
    )
      throw new Error("批次返回数与原记录不一致。");
  }
  for (const item of r.screenings as unknown[]) {
    const row = object(item, [
      "recordId",
      "strategyId",
      "strategyVersion",
      "decision",
      "depth",
      "reason",
      "readIds",
      "host",
      "rawSha256",
      "readings",
    ]);
    const { host, rawSha256, readings, ...request } = row;
    const screen = decodeResearchLiteratureScreenRequest(request);
    ref(row);
    decodeResearchLiteratureHost(host);
    hash(rawSha256);
    list(readings);
    if (!recordIds.has(screen.recordId)) throw new Error("筛选原记录不存在。");
    for (const item of readings) {
      const read = object(item, [
        "readId",
        "sourceId",
        "sourceSha256",
        "bodySha256",
        "locatorId",
        "start",
        "end",
        "depth",
        "evidenceRef",
      ]);
      for (const key of ["readId", "sourceId", "locatorId", "evidenceRef"]) text(read[key]);
      hash(read.sourceSha256);
      hash(read.bodySha256);
      if (
        !depths.includes(String(read.depth)) ||
        depths.indexOf(String(read.depth)) < depths.indexOf(screen.depth) ||
        !Number.isSafeInteger(read.start) ||
        !Number.isSafeInteger(read.end) ||
        Number(read.start) < 0 ||
        Number(read.end) <= Number(read.start)
      )
        throw new Error("筛选阅读范围无效。");
    }
    if (
      JSON.stringify(readings.map((item) => (item as { readId: string }).readId)) !==
        JSON.stringify(screen.readIds) ||
      (["partial-text", "full-text"].includes(screen.depth) && !readings.length)
    )
      throw new Error("正文筛选缺少实际读取凭据。");
  }
  for (const item of r.stops as unknown[]) {
    const stop = object(item, [
      "strategyId",
      "strategyVersion",
      "reason",
      "remainingLimitations",
      "host",
    ]);
    ref(stop);
    text(stop.reason);
    texts(stop.remainingLimitations);
    decodeResearchLiteratureHost(stop.host);
    if (!(stop.remainingLimitations as unknown[]).length)
      throw new Error("停止时必须说明剩余限制。");
  }
  for (const item of r.accesses as unknown[]) {
    const access = object(item, ["recordId", "url", "host", "outcome"]);
    text(access.recordId);
    text(access.url);
    decodeResearchLiteratureHost(access.host);
    if (!recordIds.has(access.recordId)) throw new Error("访问凭据的候选不存在。");
    const outcome = object(access.outcome, ["status", "sourceId", "sourceSha256", "error"]);
    if (outcome.status === "fetched-text") {
      text(outcome.sourceId);
      hash(outcome.sourceSha256);
      if (outcome.error !== undefined) throw new Error("成功获取不能带失败声明。");
    } else if (outcome.status === "failed") {
      text(outcome.error);
      if (outcome.sourceId !== undefined || outcome.sourceSha256 !== undefined)
        throw new Error("访问失败不能登记为取得正文。");
    } else throw new Error("访问状态不能冒充原文已读。");
  }
  return structuredClone(value) as ResearchLiteratureSearch;
}

/** Host adapter fields are separate from the portable search ledger; no model may supply them. */
export const RESEARCH_LITERATURE_TOOL_OPERATIONS = [
  "literature-context",
  "literature-strategy",
  "literature-search",
  "literature-import",
  "literature-record",
  "literature-fetch",
  "literature-screen",
  "literature-stop",
] as const;
export type ResearchLiteratureToolKind = (typeof RESEARCH_LITERATURE_TOOL_OPERATIONS)[number];
export interface ResearchLiteratureToolScope {
  projectId: string;
  revision: number;
  role: "mentor" | "lead" | "reviewer" | "librarian";
  stage: string;
  sessionId: string;
  taskId: string;
  taskVersion: number;
  attemptId: string;
  nativeRunId: string;
  model: { provider: string; modelId: string };
  inputs: { inputId: string; version: number; digest: string }[];
}
export interface ResearchLiteratureFetchedSource {
  id: string;
  title: string;
  authors: string;
  year: string;
  url: string;
  file: string;
  sha256: string;
  kind: "paper";
  access: "retrieved-text";
}
export interface ResearchLiteratureToolOperation {
  id: string;
  callId: string;
  operation: Exclude<ResearchLiteratureToolKind, "literature-context">;
  requestSha256: string;
  scope: ResearchLiteratureToolScope;
  startedAt: string;
  completedAt: string;
  /** Permanent when completion arrived after its owner/input changed; never re-adopt on replay. */
  historical: boolean;
  historyReason?: string;
  /** Aggregate ledger still retains actual bytes if a separate immutable disk copy failed. */
  archiveError?: string;
  strategy?: { id: string; version: number; sha256: string };
  record?: { id: string; rawSha256: string };
  material?: { id: string; name: string; original: string; sha256: string; bytes: number };
  sourceChecks?: {
    sourceId: string;
    sourceSha256: string;
    bodySha256: string;
    characters: number;
    depth: ResearchClaimDepth;
  }[];
  /** Also retained for a late fetch which was deliberately not added to current evidence. */
  fetchedSource?: ResearchLiteratureFetchedSource;
}
export interface ResearchLiteratureRecordReading {
  id: string;
  recordId: string;
  rawSha256: string;
  depth: "metadata" | "abstract";
  host: ResearchLiteratureHost;
}
export interface ResearchLiteratureToolState {
  literatureSearch?: ResearchLiteratureSearch;
  literatureToolOperations?: ResearchLiteratureToolOperation[];
  literatureRecordReads?: ResearchLiteratureRecordReading[];
}

function decodeLiteratureScope(value: unknown): ResearchLiteratureToolScope {
  const s = object(value, [
    "projectId",
    "revision",
    "role",
    "stage",
    "sessionId",
    "taskId",
    "taskVersion",
    "attemptId",
    "nativeRunId",
    "model",
    "inputs",
  ]);
  for (const key of ["projectId", "stage", "sessionId", "taskId", "attemptId", "nativeRunId"])
    text(s[key], 1000);
  version(s.revision);
  version(s.taskVersion);
  if (!["mentor", "lead", "reviewer", "librarian"].includes(String(s.role)))
    throw new Error("检索操作角色无效。");
  const model = object(s.model, ["provider", "modelId"]);
  text(model.provider, 512);
  text(model.modelId, 512);
  list(s.inputs);
  const ids = new Set<string>();
  for (const value of s.inputs) {
    const pin = object(value, ["inputId", "version", "digest"]);
    text(pin.inputId);
    text(pin.digest);
    version(pin.version);
    if (ids.has(pin.inputId)) throw new Error("检索输入定位重复。");
    ids.add(pin.inputId);
  }
  return structuredClone(value) as ResearchLiteratureToolScope;
}
/** Strict persistence entry point for the three optional project fields, including cross-links. */
export function decodeResearchLiteratureToolState(value: unknown): ResearchLiteratureToolState {
  const r = object(value, [
    "literatureSearch",
    "literatureToolOperations",
    "literatureRecordReads",
  ]);
  const ledger =
    r.literatureSearch === undefined
      ? undefined
      : decodeResearchLiteratureSearch(r.literatureSearch);
  const operations: ResearchLiteratureToolOperation[] = [];
  const readings: ResearchLiteratureRecordReading[] = [];
  const ids = new Set<string>();
  list(r.literatureToolOperations ?? []);
  list(r.literatureRecordReads ?? []);
  for (const value of (r.literatureToolOperations ?? []) as unknown[]) {
    const op = object(value, [
      "id",
      "callId",
      "operation",
      "requestSha256",
      "scope",
      "startedAt",
      "completedAt",
      "historical",
      "historyReason",
      "archiveError",
      "strategy",
      "record",
      "material",
      "sourceChecks",
      "fetchedSource",
    ]);
    text(op.id, 1000);
    text(op.callId, 1000);
    if (ids.has(op.id)) throw new Error("检索宿主调用身份重复。");
    ids.add(op.id);
    hash(op.requestSha256);
    decodeLiteratureScope(op.scope);
    time(op.startedAt);
    time(op.completedAt);
    if (Date.parse(String(op.completedAt)) < Date.parse(String(op.startedAt)))
      throw new Error("检索操作完成早于开始。");
    if (
      typeof op.historical !== "boolean" ||
      !RESEARCH_LITERATURE_TOOL_OPERATIONS.slice(1).includes(op.operation as never)
    )
      throw new Error("检索宿主操作类型无效。");
    if (op.historical) text(op.historyReason);
    else if (op.historyReason !== undefined) throw new Error("当前检索操作不能带历史原因。");
    if (op.archiveError !== undefined) text(op.archiveError);
    if (op.strategy !== undefined) {
      const pin = object(op.strategy, ["id", "version", "sha256"]);
      text(pin.id);
      version(pin.version);
      hash(pin.sha256);
      if (!ledger?.strategies.some((s) => s.id === pin.id && s.version === pin.version))
        throw new Error("宿主操作引用的检索策略不存在。");
    }
    if (op.record !== undefined) {
      const pin = object(op.record, ["id", "rawSha256"]);
      text(pin.id);
      hash(pin.rawSha256);
      if (
        !ledger?.records.some(
          (record) => record.id === pin.id && record.rawSha256 === pin.rawSha256,
        )
      )
        throw new Error("宿主操作引用的候选版本不存在。");
    }
    if (op.material !== undefined) {
      const pin = object(op.material, ["id", "name", "original", "sha256", "bytes"]);
      for (const key of ["id", "name", "original"]) text(pin[key]);
      hash(pin.sha256);
      if (
        !Number.isSafeInteger(pin.bytes) ||
        Number(pin.bytes) < 0 ||
        Number(pin.bytes) > 10_000_000
      )
        throw new Error("检索导入字节数无效。");
    }
    if (op.fetchedSource !== undefined) {
      const source = object(op.fetchedSource, [
        "id",
        "title",
        "authors",
        "year",
        "url",
        "file",
        "sha256",
        "kind",
        "access",
      ]);
      for (const key of ["id", "title", "authors", "year", "url", "file"]) text(source[key]);
      hash(source.sha256);
      if (
        source.kind !== "paper" ||
        source.access !== "retrieved-text" ||
        op.operation !== "literature-fetch"
      )
        throw new Error("实际获取来源类型无效。");
    }
    if (op.sourceChecks !== undefined) {
      if (op.operation !== "literature-screen") throw new Error("原文读取核对只能关联筛选。");
      list(op.sourceChecks);
      const sources = new Set<string>();
      for (const value of op.sourceChecks) {
        const check = object(value, [
          "sourceId",
          "sourceSha256",
          "bodySha256",
          "characters",
          "depth",
        ]);
        text(check.sourceId);
        hash(check.sourceSha256);
        hash(check.bodySha256);
        if (
          sources.has(check.sourceId) ||
          !Number.isSafeInteger(check.characters) ||
          Number(check.characters) < 1 ||
          Number(check.characters) > 300_000 ||
          !depths.includes(String(check.depth))
        )
          throw new Error("原文固定范围核对无效。");
        sources.add(check.sourceId);
      }
    }
    const strategyRequired = [
      "literature-strategy",
      "literature-search",
      "literature-import",
      "literature-screen",
      "literature-stop",
    ].includes(String(op.operation));
    const recordRequired = ["literature-record", "literature-fetch", "literature-screen"].includes(
      String(op.operation),
    );
    if (
      strategyRequired !== (op.strategy !== undefined) ||
      recordRequired !== (op.record !== undefined) ||
      (op.operation === "literature-import") !== (op.material !== undefined)
    )
      throw new Error("宿主操作缺少对应输入定位。");
    operations.push(structuredClone(value) as ResearchLiteratureToolOperation);
  }
  for (const value of (r.literatureRecordReads ?? []) as unknown[]) {
    const read = object(value, ["id", "recordId", "rawSha256", "depth", "host"]);
    text(read.id);
    text(read.recordId);
    hash(read.rawSha256);
    if (!["metadata", "abstract"].includes(String(read.depth)))
      throw new Error("题录读取不能冒充正文已读。");
    decodeResearchLiteratureHost(read.host);
    if (readings.some((row) => row.id === read.id)) throw new Error("候选读取身份重复。");
    const op = operations.find((row) => row.id === read.id);
    if (
      op?.operation !== "literature-record" ||
      op.record?.id !== read.recordId ||
      op.record.rawSha256 !== read.rawSha256
    )
      throw new Error("候选读取缺少真实宿主操作。");
    const record = ledger?.records.find((row) => row.id === read.recordId);
    const raw: unknown = record && JSON.parse(record.rawJson);
    if (
      read.depth === "abstract" &&
      (!raw ||
        typeof raw !== "object" ||
        !("abstract" in raw) ||
        typeof raw.abstract !== "string" ||
        !raw.abstract.trim())
    )
      throw new Error("候选原记录没有实际返回的摘要。");
    readings.push(structuredClone(value) as ResearchLiteratureRecordReading);
  }
  for (const op of operations) {
    const evidence =
      op.operation === "literature-strategy"
        ? ledger?.strategies.find(
            (row) => row.id === op.strategy?.id && row.version === op.strategy.version,
          )?.recordedBy
        : op.operation === "literature-search" || op.operation === "literature-import"
          ? ledger?.batches.find((row) => row.id === op.id)?.host
          : op.operation === "literature-fetch"
            ? ledger?.accesses.find((row) => row.host.id === op.id)?.host
            : op.operation === "literature-screen"
              ? ledger?.screenings.find((row) => row.host.id === op.id)?.host
              : op.operation === "literature-stop"
                ? ledger?.stops.find((row) => row.host.id === op.id)?.host
                : readings.find((row) => row.id === op.id)?.host;
    if (
      !evidence ||
      evidence.id !== op.id ||
      evidence.at !== op.completedAt ||
      evidence.actor.kind !== "model" ||
      evidence.actor.sessionId !== op.scope.sessionId ||
      evidence.actor.id !==
        `model:${op.scope.role}:${op.scope.model.provider}/${op.scope.model.modelId}` ||
      evidence.actor.evidenceRef !==
        `tool:${op.callId};native:${op.scope.nativeRunId};attempt:${op.scope.attemptId}`
    )
      throw new Error("检索记录与真实宿主身份不一致。");
    if (op.operation === "literature-search" || op.operation === "literature-import") {
      const batch = ledger!.batches.find((row) => row.id === op.id)!;
      if (
        batch.strategyId !== op.strategy?.id ||
        batch.strategyVersion !== op.strategy.version ||
        batch.origin !== (op.operation === "literature-import" ? "import" : "execution") ||
        batch.startedAt !== op.startedAt ||
        batch.completedAt !== op.completedAt
      )
        throw new Error("实际批次与宿主操作不一致。");
    }
    if (op.operation === "literature-fetch") {
      const access = ledger!.accesses.find((row) => row.host.id === op.id)!;
      if (
        access.recordId !== op.record?.id ||
        (access.outcome.status === "fetched-text"
          ? access.outcome.sourceId !== op.fetchedSource?.id ||
            access.outcome.sourceSha256 !== op.fetchedSource.sha256
          : op.fetchedSource !== undefined)
      )
        throw new Error("来源访问结果与宿主操作不一致。");
    }
    if (op.operation === "literature-screen" || op.operation === "literature-stop") {
      const item =
        op.operation === "literature-screen"
          ? ledger!.screenings.find((row) => row.host.id === op.id)!
          : ledger!.stops.find((row) => row.host.id === op.id)!;
      if (
        item.strategyId !== op.strategy?.id ||
        item.strategyVersion !== op.strategy.version ||
        ("recordId" in item && item.recordId !== op.record?.id)
      )
        throw new Error("筛选或停止的版本与宿主操作不一致。");
      if ("readings" in item) {
        if (
          !item.readings.length &&
          !readings.some(
            (read) =>
              read.recordId === item.recordId &&
              read.rawSha256 === item.rawSha256 &&
              read.host.actor.sessionId === op.scope.sessionId &&
              Date.parse(read.host.at) <= Date.parse(op.completedAt) &&
              depths.indexOf(read.depth) >= depths.indexOf(item.depth),
          )
        )
          throw new Error("纳排判断没有对应的实际候选阅读。");
        for (const read of item.readings) {
          const source = op.sourceChecks?.find((check) => check.sourceId === read.sourceId);
          if (
            !source ||
            source.sourceSha256 !== read.sourceSha256 ||
            source.bodySha256 !== read.bodySha256 ||
            read.end > source.characters ||
            depths.indexOf(source.depth) < depths.indexOf(item.depth)
          )
            throw new Error("筛选位置超出实际核对的原文版本或范围。");
        }
        if (
          item.depth === "full-text" &&
          !op.sourceChecks?.some((source) => {
            if (source.depth !== "full-text") return false;
            let end = 0;
            for (const read of item.readings
              .filter((read) => read.sourceId === source.sourceId && read.depth === "full-text")
              .sort((a, b) => a.start - b.start)) {
              if (read.start > end) return false;
              end = Math.max(end, read.end);
            }
            return end === source.characters;
          })
        )
          throw new Error("全文筛选未覆盖固定正文全部字符范围。");
      }
    }
  }
  return {
    ...(ledger ? { literatureSearch: ledger } : {}),
    ...(r.literatureToolOperations !== undefined ? { literatureToolOperations: operations } : {}),
    ...(r.literatureRecordReads !== undefined ? { literatureRecordReads: readings } : {}),
  };
}
