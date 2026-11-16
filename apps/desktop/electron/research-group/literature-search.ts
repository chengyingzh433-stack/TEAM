import { createHash } from "node:crypto";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ResearchClaimActualRead,
  ResearchClaimSourceSnapshot,
} from "../../contracts/research-claims";
import { decodeResearchClaimActualRead } from "../../contracts/research-claims";
import {
  decodeResearchLiteratureHost,
  decodeResearchLiteratureSearch,
  decodeResearchLiteratureStrategyRequest,
  decodeResearchLiteratureScreenRequest,
  type ResearchLiteratureHost,
  type ResearchLiteratureSearch,
  type ResearchLiteratureBatch,
  type ResearchLiteratureScreen,
  type ResearchLiteratureAccess,
} from "../../contracts/research-literature-search";

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
export const RESEARCH_LITERATURE_BOUNDARY =
  "数量仅代表实际返回或导入的记录，不代表数据库全覆盖、原文已读或系统综述完整性；纳排属于有身份的内容判断，程序只核对出处、版本和实际读取范围。";
export function createResearchLiteratureSearch(): ResearchLiteratureSearch {
  return {
    schemaVersion: 1,
    strategies: [],
    batches: [],
    records: [],
    screenings: [],
    stops: [],
    accesses: [],
  };
}
function candidate(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("候选记录须为原始对象。");
  return raw as Record<string, unknown>;
}
function canonicalDoi(value: unknown) {
  if (typeof value !== "string") return undefined;
  const doi = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}
function identity(raw: unknown, fallback: string) {
  const row = candidate(raw),
    doi = canonicalDoi(row.DOI ?? row.doi) ?? canonicalDoi(row.URL ?? row.url);
  if (doi) return `doi:${doi}`;
  const value = row.URL ?? row.url;
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (["https:", "http:"].includes(url.protocol)) {
        url.hash = "";
        return `url:${url.href}`;
      }
    } catch {
      /* Missing/invalid URLs do not establish identity. */
    }
  }
  return `record:${fallback}`;
}
function intact(value: ResearchLiteratureSearch) {
  const state = decodeResearchLiteratureSearch(value);
  for (const batch of state.batches) {
    if (sha(Buffer.from(batch.original.text, batch.original.encoding)) !== batch.original.sha256)
      throw new Error("检索原批次摘要已变化。");
    if (batch.status !== "succeeded") continue;
    if (batch.original.encoding !== "utf8")
      throw new Error("成功记录必须来源于实际解析的UTF-8 JSON。");
    const parsed: unknown = JSON.parse(batch.original.text);
    const envelope = Array.isArray(parsed) ? undefined : candidate(parsed);
    const originals =
      batch.origin === "execution"
        ? envelope?.records
        : Array.isArray(parsed)
          ? parsed
          : (envelope?.candidates ?? (envelope?.message && candidate(envelope.message).items));
    const saved = state.records
      .filter((row) => row.batchId === batch.id)
      .map((row): unknown => JSON.parse(row.rawJson));
    if (!isDeepStrictEqual(originals, saved)) throw new Error("候选清单与实际批次原记录不一致。");
  }
  for (const record of state.records) {
    const raw: unknown = JSON.parse(record.rawJson);
    if (sha(record.rawJson) !== record.rawSha256 || identity(raw, record.id) !== record.dedupeKey)
      throw new Error("候选原记录摘要或身份已变化。");
  }
  for (const screen of state.screenings) {
    const record = state.records.find((row) => row.id === screen.recordId)!;
    if (record.rawSha256 !== screen.rawSha256) throw new Error("筛选引用的原记录版本已变化。");
  }
  return state;
}
function strategy(state: ResearchLiteratureSearch, id: string, version: number) {
  const found = state.strategies.find((row) => row.id === id && row.version === version);
  if (!found) throw new Error("检索策略版本不存在。");
  return found;
}
function append<T>(items: T[], item: T, key: (value: T) => string) {
  const prior = items.find((row) => key(row) === key(item));
  if (prior) {
    if (!isDeepStrictEqual(prior, item)) throw new Error("同一宿主操作身份不能重写原记录。");
  } else items.push(structuredClone(item));
}
/** Model-facing request has no actor, timestamps, execution counts or completed flag. */
export function registerResearchLiteratureStrategy(
  state: ResearchLiteratureSearch,
  input: unknown,
  actualHost: ResearchLiteratureHost,
) {
  const next = intact(state),
    request = decodeResearchLiteratureStrategyRequest(input),
    host = decodeResearchLiteratureHost(actualHost);
  const prior = next.strategies.find(
    (row) => row.id === request.id && row.version === request.version,
  );
  if (
    !prior &&
    request.version !==
      Math.max(
        0,
        ...next.strategies.filter((row) => row.id === request.id).map((row) => row.version),
      ) +
        1
  )
    throw new Error("策略调整须追加连续新版本，不能替换旧策略。");
  append(next.strategies, { ...request, recordedBy: host }, (row) => `${row.id}:${row.version}`);
  return next;
}

declare const receiptBrand: unique symbol;
export interface ResearchLiteratureBatchReceipt {
  readonly [receiptBrand]: true;
}
type ReceiptData = Omit<ResearchLiteratureBatch, "strategyId" | "strategyVersion" | "recordIds"> & {
  records: unknown[];
};
const receipts = new WeakMap<ResearchLiteratureBatchReceipt, ReceiptData>();
function seal(data: ReceiptData) {
  const receipt = Object.freeze({}) as ResearchLiteratureBatchReceipt;
  receipts.set(receipt, structuredClone(data));
  return receipt;
}
/** HOST ONLY: wrap actual searchResearchSources output. Never expose this factory as a model tool. */
export function createResearchLiteratureExecutionReceipt(actual: {
  host: ResearchLiteratureHost;
  query: string;
  endpoint: string;
  startedAt: string;
  completedAt: string;
  outcome: { status: "succeeded"; records: unknown[] } | { status: "failed"; error: string };
  limitations: string[];
}): ResearchLiteratureBatchReceipt {
  const host = decodeResearchLiteratureHost(actual.host),
    endpoint = new URL(actual.endpoint);
  if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error("实际检索端点无效。");
  const records = actual.outcome.status === "succeeded" ? actual.outcome.records : [];
  records.forEach(candidate);
  const original = JSON.stringify(actual.outcome);
  const data: ReceiptData = {
    id: host.id,
    host,
    origin: "execution",
    startedAt: actual.startedAt,
    completedAt: actual.completedAt,
    query: actual.query,
    endpoint: actual.endpoint,
    status: actual.outcome.status,
    failure: actual.outcome.status === "failed" ? actual.outcome.error : null,
    limitations: [...actual.limitations],
    representation: "returned-candidate-metadata",
    original: {
      name: "returned-candidate-metadata.json",
      text: original,
      sha256: sha(original),
      encoding: "utf8",
      available: true,
    },
    records,
  };
  return seal(data);
}
/** Reads the real import file without altering it. Unsupported/unreadable imports become failed batches. */
export async function importResearchLiteratureRecords(
  file: string,
  actualHost: ResearchLiteratureHost,
  limitations: string[],
): Promise<ResearchLiteratureBatchReceipt> {
  const host = decodeResearchLiteratureHost(actualHost);
  let original = "",
    encoding: "utf8" | "base64" = "utf8",
    originalBytes = Buffer.alloc(0),
    available = false,
    records: unknown[] = [],
    failure: string | null = null;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 10_000_000)
      throw new Error("导入原件不是可读文件或超过10MB。");
    const bytes = await readFile(file);
    originalBytes = bytes;
    available = true;
    original = bytes.toString("utf8");
    if (!Buffer.from(original, "utf8").equals(bytes)) {
      original = bytes.toString("base64");
      encoding = "base64";
      throw new Error("仅支持无损UTF-8 JSON原记录；不自动转换其他编码。");
    }
    const parsed: unknown = JSON.parse(original),
      row = Array.isArray(parsed) ? undefined : candidate(parsed);
    const result = Array.isArray(parsed)
      ? parsed
      : (row?.candidates ?? (row?.message && candidate(row.message).items));
    if (!Array.isArray(result))
      throw new Error(
        "导入仅支持记录数组、candidates数组或Crossref message.items；不能伪造解析结果。",
      );
    records = result;
    records.forEach(candidate);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    records = [];
  }
  return seal({
    id: host.id,
    host,
    origin: "import",
    startedAt: host.at,
    completedAt: host.at,
    query: null,
    endpoint: null,
    status: failure ? "failed" : "succeeded",
    failure,
    limitations: [...limitations],
    representation: "imported-json-records",
    original: {
      name: basename(file),
      text: original,
      sha256: sha(originalBytes),
      encoding,
      available,
    },
    records,
  });
}
/** A plain JSON/model object is not a host receipt. Failed batches append without clearing earlier records. */
export function recordResearchLiteratureExecution(
  state: ResearchLiteratureSearch,
  ref: { id: string; version: number },
  receipt: ResearchLiteratureBatchReceipt,
) {
  const next = intact(state),
    data = receipts.get(receipt);
  if (!data) throw new Error("实际执行/导入只能使用宿主单独产生的凭据。");
  const plan = strategy(next, ref.id, ref.version);
  if (Date.parse(data.startedAt) < Date.parse(plan.recordedBy.at))
    throw new Error("实际执行早于本策略登记，不能倒填为此策略的查询。");
  const records = data.records.map((raw, index) => {
    const id = `${data.id}:record:${index}`,
      rawJson = JSON.stringify(raw);
    return {
      id,
      batchId: data.id,
      index,
      rawJson,
      rawSha256: sha(rawJson),
      dedupeKey: identity(raw, id),
    };
  });
  const { records: ignored, ...batchData } = data;
  void ignored;
  append(
    next.batches,
    {
      ...batchData,
      strategyId: ref.id,
      strategyVersion: ref.version,
      recordIds: records.map((row) => row.id),
    },
    (row) => row.id,
  );
  for (const record of records) append(next.records, record, (row) => row.id);
  return intact(next);
}
/** Optional immutable on-disk copy; state also retains the original text. No paths come from model input. */
export async function saveResearchLiteratureOriginal(
  directory: string,
  batch: ResearchLiteratureBatch,
) {
  if (!batch.original.available) throw new Error("此失败批次未取得原件，不能保存伪造的空原件。");
  if (sha(Buffer.from(batch.original.text, batch.original.encoding)) !== batch.original.sha256)
    throw new Error("原记录摘要不符。");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${batch.original.sha256}.json`);
  try {
    await writeFile(file, Buffer.from(batch.original.text, batch.original.encoding), {
      flag: "wx",
    });
  } catch (error) {
    if (
      !(error && typeof error === "object" && "code" in error && error.code === "EEXIST") ||
      !(await readFile(file)).equals(Buffer.from(batch.original.text, batch.original.encoding))
    )
      throw error;
  }
  return { file, sha256: batch.original.sha256 };
}
export interface ResearchLiteratureReadingContext {
  /** Built from actual project sources/parser snapshots and sourceReads, never model arguments. */
  sources: ResearchClaimSourceSnapshot[];
  reads: ResearchClaimActualRead[];
  recordSources: { recordId: string; sourceId: string }[];
}
const depthRank = { metadata: 0, abstract: 1, "partial-text": 2, "full-text": 3 };
export function screenResearchLiteratureRecord(
  state: ResearchLiteratureSearch,
  input: unknown,
  actualHost: ResearchLiteratureHost,
  context: ResearchLiteratureReadingContext,
) {
  const next = intact(state),
    request = decodeResearchLiteratureScreenRequest(input),
    host = decodeResearchLiteratureHost(actualHost);
  strategy(next, request.strategyId, request.strategyVersion);
  const record = next.records.find((row) => row.id === request.recordId);
  if (!record) throw new Error("筛选原记录不存在。");
  if (new Set(request.readIds).size !== request.readIds.length)
    throw new Error("实际读取凭据不能重复。");
  const readings: ResearchLiteratureScreen["readings"] = request.readIds.map((id) => {
    const read = context.reads.find((row) => row.id === id),
      source = context.sources.find((row) => row.id === read?.sourceId);
    if (read) decodeResearchClaimActualRead(read);
    const locator = source?.locators.find((row) => row.id === read?.locatorId);
    if (
      !read ||
      !source?.available ||
      !locator ||
      !host.actor.sessionId ||
      read.sessionId !== host.actor.sessionId ||
      !context.recordSources.some(
        (link) => link.recordId === record.id && link.sourceId === source.id,
      ) ||
      source.sha256 !== read.sourceSha256 ||
      source.bodySha256 !== read.bodySha256 ||
      sha(source.body) !== source.bodySha256 ||
      read.start < locator.start ||
      read.end > locator.end ||
      read.start < 0 ||
      read.end > source.body.length ||
      read.start >= read.end ||
      depthRank[read.depth] < depthRank[request.depth] ||
      depthRank[locator.depth] < depthRank[request.depth] ||
      Date.parse(read.at) > Date.parse(host.at)
    )
      throw new Error("筛选深度超出当前同源、同版本、同操作者的实际读取范围。");
    return {
      readId: read.id,
      sourceId: read.sourceId,
      sourceSha256: read.sourceSha256,
      bodySha256: read.bodySha256,
      locatorId: read.locatorId,
      start: read.start,
      end: read.end,
      depth: read.depth,
      evidenceRef: read.evidenceRef,
    };
  });
  if (depthRank[request.depth] >= 2 && !readings.length)
    throw new Error("正文筛选必须有实际原文读取凭据；摘要不能升级。");
  const raw = candidate(JSON.parse(record.rawJson));
  if (
    request.depth === "abstract" &&
    !readings.length &&
    !(typeof raw.abstract === "string" && raw.abstract.trim())
  )
    throw new Error("此记录没有实际摘要；只能进行题录筛选。");
  append(
    next.screenings,
    { ...request, host, rawSha256: record.rawSha256, readings },
    (row) => row.host.id,
  );
  return intact(next);
}
export function stopResearchLiteratureSearch(
  state: ResearchLiteratureSearch,
  input: unknown,
  actualHost: ResearchLiteratureHost,
) {
  const next = intact(state),
    host = decodeResearchLiteratureHost(actualHost);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["strategyId", "strategyVersion", "reason", "remainingLimitations"].includes(key),
    )
  )
    throw new Error("停止请求不能自报执行量或身份。");
  const item = { ...input, host } as ResearchLiteratureSearch["stops"][number];
  strategy(next, item.strategyId, item.strategyVersion);
  append(next.stops, item, (row) => row.host.id);
  return intact(next);
}
/** Small read-only bridge for sources/claims: records remain addressable after deduplication. */
export function locateResearchLiteratureRecord(state: ResearchLiteratureSearch, recordId: string) {
  const next = intact(state),
    record = next.records.find((row) => row.id === recordId);
  if (!record) throw new Error("文献原记录不存在。");
  return {
    record,
    batch: next.batches.find((row) => row.id === record.batchId)!,
    duplicateRecordIds: next.records
      .filter((row) => row.dedupeKey === record.dedupeKey)
      .map((row) => row.id),
    screenings: next.screenings.filter((row) => row.recordId === recordId),
    accesses: next.accesses.filter((row) => row.recordId === recordId),
  };
}
export function reportResearchLiteratureSearch(state: ResearchLiteratureSearch) {
  const next = intact(state),
    successful = next.batches.filter(
      (row) => row.origin === "execution" && row.status === "succeeded",
    );
  const groups = [...new Set(next.records.map((row) => row.dedupeKey))].map((key) => ({
    key,
    recordIds: next.records.filter((row) => row.dedupeKey === key).map((row) => row.id),
  }));
  return {
    plannedStrategyVersions: next.strategies.length,
    successfulSearches: successful.length,
    returnedRecords: successful.reduce((sum, row) => sum + row.recordIds.length, 0),
    importedRecords: next.batches
      .filter((row) => row.origin === "import" && row.status === "succeeded")
      .reduce((sum, row) => sum + row.recordIds.length, 0),
    failures: next.batches.filter((row) => row.status === "failed"),
    sourceAccessFailures: next.accesses.filter((row) => row.outcome.status === "failed"),
    fetchedRecords: new Set(
      next.accesses
        .filter((row) => row.outcome.status === "fetched-text")
        .map((row) => row.recordId),
    ).size,
    groups,
    screenedRecords: new Set(next.screenings.map((row) => row.recordId)).size,
    stoppedVersions: next.stops,
    boundary: RESEARCH_LITERATURE_BOUNDARY,
  };
}

declare const accessReceiptBrand: unique symbol;
export interface ResearchLiteratureAccessReceipt {
  readonly [accessReceiptBrand]: true;
}
const accessReceipts = new WeakMap<ResearchLiteratureAccessReceipt, ResearchLiteratureAccess>();
/** HOST ONLY: records actual source-fetch outcome; successful retrieval never means the model read it. */
export function createResearchLiteratureAccessReceipt(actual: ResearchLiteratureAccess) {
  decodeResearchLiteratureHost(actual.host);
  const url = new URL(actual.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("实际来源访问URL无效。");
  const receipt = Object.freeze({}) as ResearchLiteratureAccessReceipt;
  accessReceipts.set(receipt, structuredClone(actual));
  return receipt;
}
export function recordResearchLiteratureAccess(
  state: ResearchLiteratureSearch,
  receipt: ResearchLiteratureAccessReceipt,
) {
  const next = intact(state),
    actual = accessReceipts.get(receipt);
  if (!actual) throw new Error("来源访问只能使用宿主实际获取凭据。");
  append(next.accesses, actual, (row) => row.host.id);
  return intact(next);
}
