import type { ResearchModel, ResearchRole } from "./research-group";

export const SOURCE_PAGE_OPERATIONS = [
  "source-pages",
  "source-read-page",
  "source-page-reading",
] as const;

/** A byte-delivery receipt is separate from a model's later visual observations. */
export interface ResearchSourcePageReceipt {
  id: string;
  projectId: string;
  revision: number;
  role: ResearchRole;
  taskId: string;
  taskInputVersion: number;
  attemptId: string;
  nativeRunId: string;
  sessionId: string;
  model: ResearchModel;
  callId: string;
  at: string;
  sourceId: string;
  sourceSha256: string;
  materialImportId: string;
  originalSha256: string;
  parserVersion: string;
  rendererVersion: string;
  page: number;
  locator: string;
  pageCount: number;
  cacheKey: string;
  imageSha256: string;
  bytes: number;
  width: number;
  height: number;
  mimeType: "image/png";
  limitations: string[];
}

export interface ResearchSourcePageReading {
  id: string;
  projectId: string;
  revision: number;
  role: ResearchRole;
  taskId: string;
  taskInputVersion: number;
  attemptId: string;
  nativeRunId: string;
  sessionId: string;
  model: ResearchModel;
  callId: string;
  at: string;
  receiptId: string;
  observations: string;
  remainingLimitations: string[];
  kind: "model-visual-observation";
}

export interface ResearchSourcePageRecords {
  sourcePageReceipts?: ResearchSourcePageReceipt[];
  sourcePageReadings?: ResearchSourcePageReading[];
}

export function sourcePageObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("原页工具记录不是有效对象。");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("原页工具记录含未知字段；不接受路径或图像字节注入。");
}
export function sourcePageText(value: unknown, max = 1024): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("原页工具文本字段无效。");
}
function integer(value: unknown, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error("原页工具物理页码、尺寸或版本无效。");
}
function sha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("原页工具摘要无效。");
}
function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("原页限制清单无效。");
  value.forEach((item: unknown) => sourcePageText(item, 100_000));
}
const identityKeys = [
  "id",
  "projectId",
  "revision",
  "role",
  "taskId",
  "taskInputVersion",
  "attemptId",
  "nativeRunId",
  "sessionId",
  "model",
  "callId",
  "at",
] as const;
function identity(value: Record<string, unknown>) {
  for (const key of [
    "id",
    "projectId",
    "taskId",
    "attemptId",
    "nativeRunId",
    "sessionId",
    "callId",
  ])
    sourcePageText(value[key]);
  integer(value.revision, Number.MAX_SAFE_INTEGER);
  integer(value.taskInputVersion, Number.MAX_SAFE_INTEGER);
  if (!["mentor", "lead", "reviewer", "librarian"].includes(String(value.role)))
    throw new Error("原页工具成员身份无效。");
  sourcePageText(value.at, 64);
  if (!Number.isFinite(Date.parse(value.at))) throw new Error("原页工具实际时间无效。");
  sourcePageObject(value.model, ["provider", "modelId", "thinkingLevel"]);
  sourcePageText(value.model.provider);
  sourcePageText(value.model.modelId);
  if (value.model.thinkingLevel !== undefined) sourcePageText(value.model.thinkingLevel);
}
export function decodeResearchSourcePageReceipt(value: unknown): ResearchSourcePageReceipt {
  sourcePageObject(value, [
    ...identityKeys,
    "sourceId",
    "sourceSha256",
    "materialImportId",
    "originalSha256",
    "parserVersion",
    "rendererVersion",
    "page",
    "locator",
    "pageCount",
    "cacheKey",
    "imageSha256",
    "bytes",
    "width",
    "height",
    "mimeType",
    "limitations",
  ]);
  identity(value);
  for (const key of ["sourceId", "materialImportId", "parserVersion", "rendererVersion"])
    sourcePageText(value[key]);
  for (const key of ["sourceSha256", "originalSha256", "cacheKey", "imageSha256"]) sha(value[key]);
  integer(value.page, 1000);
  integer(value.pageCount, 1000);
  integer(value.bytes, 25_000_000);
  integer(value.width, 2400);
  integer(value.height, 2400);
  if (
    value.page > value.pageCount ||
    value.locator !== `page:${value.page}` ||
    value.mimeType !== "image/png"
  )
    throw new Error("原页工具物理定位或图像格式不一致。");
  strings(value.limitations);
  return structuredClone(value) as unknown as ResearchSourcePageReceipt;
}
export function decodeResearchSourcePageReading(value: unknown): ResearchSourcePageReading {
  sourcePageObject(value, [
    ...identityKeys,
    "receiptId",
    "observations",
    "remainingLimitations",
    "kind",
  ]);
  identity(value);
  sourcePageText(value.receiptId);
  sourcePageText(value.observations, 12_000);
  strings(value.remainingLimitations);
  if (value.kind !== "model-visual-observation") throw new Error("原页观察身份无效。");
  return structuredClone(value) as unknown as ResearchSourcePageReading;
}
export function decodeResearchSourcePageRecords(value: unknown): ResearchSourcePageRecords {
  sourcePageObject(value, ["sourcePageReceipts", "sourcePageReadings"]);
  const result: ResearchSourcePageRecords = {};
  for (const key of ["sourcePageReceipts", "sourcePageReadings"] as const) {
    const rows = value[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > 100_000) throw new Error("原页读取记录过长。");
    const ids = new Set<string>();
    if (key === "sourcePageReceipts") result[key] = rows.map(decodeResearchSourcePageReceipt);
    else result[key] = rows.map(decodeResearchSourcePageReading);
    for (const row of result[key]!) {
      if (ids.has(row.id)) throw new Error("原页工具记录身份重复。");
      ids.add(row.id);
    }
  }
  for (const reading of result.sourcePageReadings ?? []) {
    const receipt = result.sourcePageReceipts?.find((row) => row.id === reading.receiptId);
    if (
      !receipt ||
      [
        "projectId",
        "revision",
        "role",
        "taskId",
        "taskInputVersion",
        "attemptId",
        "nativeRunId",
        "sessionId",
      ].some(
        (key) =>
          receipt[key as keyof ResearchSourcePageReceipt] !==
          reading[key as keyof ResearchSourcePageReading],
      ) ||
      JSON.stringify(receipt.model) !== JSON.stringify(reading.model) ||
      Date.parse(receipt.at) > Date.parse(reading.at) ||
      receipt.callId === reading.callId
    )
      throw new Error("原页观察缺少本人同一实际执行此前返回的图像凭据。");
  }
  return result;
}
