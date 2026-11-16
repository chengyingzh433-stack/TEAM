export interface MaterialLocation {
  kind: "line" | "page" | "paragraph" | "table-cell" | "cell";
  locator: string;
  text: string;
  page?: number;
  sheet?: string;
  formula?: string;
}
export interface MaterialTablePreview {
  name: string;
  headerRow: number;
  headers: string[];
  rows: string[][];
  rowLocations: string[];
  columns: { name: string; type: "number" | "text" | "mixed" | "empty"; missing: number }[];
  errors: { row: number; reason: string }[];
}
export interface MaterialMetadata {
  category?: "paper" | "method" | "data" | "manuscript" | "other";
  title?: string;
  authors?: string;
  year?: string;
  url?: string;
  providedBy?: string;
  purpose?: string;
  dataKind?: "observed" | "synthetic" | "unknown";
  permission?: string;
}
export interface MaterialParseOptions {
  encoding?: "auto" | "utf-8" | "utf-16le" | "utf-16be" | "gb18030";
  delimiter?: "," | ";" | "\t";
  sheet?: string;
  headerRow?: number;
}
export interface MaterialImportRequest extends MaterialParseOptions {
  file: string;
  metadata?: MaterialMetadata;
}
export type MaterialRecoveryRequest =
  | ({ kind: "reparse" } & MaterialParseOptions)
  | { kind: "replace" }
  | { kind: "supplement"; locator: string; text: string; description: string };
export interface MaterialRecoveryRecord {
  fromImportId: string;
  kind: MaterialRecoveryRequest["kind"];
  description?: string;
}
export interface ImportedResearchMaterial {
  id: string;
  name: string;
  sha256: string;
  bytes: number;
  importedAt: string;
  original: string;
  parsed: string;
  parserVersion: string;
  duplicate: boolean;
  metadata: MaterialMetadata;
  status: "ready" | "partial" | "needs-parsing" | "failed";
  locations: MaterialLocation[];
  tables: MaterialTablePreview[];
  warnings: string[];
  error?: string;
  parseOptions?: MaterialParseOptions;
  recovery?: MaterialRecoveryRecord;
}
export type MaterialImportResult =
  { ok: true; material: ImportedResearchMaterial } | { ok: false; file: string; error: string };

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("材料记录不是有效对象。");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key)))
    throw new Error("材料记录含未知字段，保留原文件并停止写入。");
  return record;
}
function string(value: unknown, max = 8192, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error("材料记录的文本字段无效。");
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("材料记录的数值字段无效。");
  return value;
}
function list(value: unknown, max = 1_000_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("材料记录的列表无效或过长。");
  return value as unknown[];
}
function choice<const T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error("材料记录的状态或类别无效。");
  return value as T;
}
function metadata(value: unknown): MaterialMetadata {
  const record = object(value, [
    "category",
    "title",
    "authors",
    "year",
    "url",
    "providedBy",
    "purpose",
    "dataKind",
    "permission",
  ]);
  const result: MaterialMetadata = {};
  for (const key of [
    "title",
    "authors",
    "year",
    "url",
    "providedBy",
    "purpose",
    "permission",
  ] as const)
    if (record[key] !== undefined) result[key] = string(record[key], 8192, true);
  if (record.category !== undefined)
    result.category = choice(record.category, ["paper", "method", "data", "manuscript", "other"]);
  if (record.dataKind !== undefined)
    result.dataKind = choice(record.dataKind, ["observed", "synthetic", "unknown"]);
  return result;
}
function location(value: unknown): MaterialLocation {
  const record = object(value, ["kind", "locator", "text", "page", "sheet", "formula"]);
  const result: MaterialLocation = {
    kind: choice(record.kind, ["line", "page", "paragraph", "table-cell", "cell"]),
    locator: string(record.locator),
    text: string(record.text, 8_000_000, true),
  };
  if (record.page !== undefined) result.page = integer(record.page, 1, 1000);
  if (record.sheet !== undefined) result.sheet = string(record.sheet, 1000, true);
  if (record.formula !== undefined) result.formula = string(record.formula, 100_000, true);
  if (result.kind === "page" && result.page === undefined)
    throw new Error("PDF 定位缺少物理页码。");
  if (result.kind === "cell" && result.sheet === undefined)
    throw new Error("工作表定位缺少工作表名。");
  return result;
}
function preview(value: unknown): MaterialTablePreview {
  const record = object(value, [
    "name",
    "headerRow",
    "headers",
    "rows",
    "rowLocations",
    "columns",
    "errors",
  ]);
  const rows = list(record.rows, 100_000).map((row) =>
    list(row, 16384).map((cell) => string(cell, 1_000_000, true)),
  );
  const rowLocations = list(record.rowLocations, 100_000).map((item) => string(item));
  const headers = list(record.headers, 16384).map((item) => string(item, 1_000_000, true));
  const headerRow = integer(record.headerRow, 1, rows.length);
  if (
    rowLocations.length !== rows.length ||
    JSON.stringify(headers) !== JSON.stringify(rows[headerRow - 1])
  )
    throw new Error("材料表头或行定位与原预览不一致。");
  const columns = list(record.columns, 16384).map((item) => {
    const column = object(item, ["name", "type", "missing"]);
    return {
      name: string(column.name, 1_000_000, true),
      type: choice(column.type, ["number", "text", "mixed", "empty"]),
      missing: integer(column.missing, 0, rows.length - headerRow),
    };
  });
  if (columns.length !== headers.length || columns.some((column, i) => column.name !== headers[i]))
    throw new Error("材料字段预览不一致。");
  return {
    name: string(record.name),
    headerRow,
    headers,
    rows,
    rowLocations,
    columns,
    errors: list(record.errors, 100_000).map((item) => {
      const error = object(item, ["row", "reason"]);
      return { row: integer(error.row, 1, rows.length), reason: string(error.reason) };
    }),
  };
}

/** Reject malformed persisted records; retain failed imports as evidence and recovery inputs. */
export function decodeImportedResearchMaterials(value: unknown): ImportedResearchMaterial[] {
  const result = list(value, 10_000).map((item) => {
    const record = object(item, [
      "id",
      "name",
      "sha256",
      "bytes",
      "importedAt",
      "original",
      "parsed",
      "parserVersion",
      "duplicate",
      "metadata",
      "status",
      "locations",
      "tables",
      "warnings",
      "error",
      "parseOptions",
      "recovery",
    ]);
    const sha256 = string(record.sha256, 64),
      importedAt = string(record.importedAt, 50);
    if (
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isFinite(Date.parse(importedAt)) ||
      typeof record.duplicate !== "boolean"
    )
      throw new Error("材料摘要、导入时间或重复标记无效。");
    const status = choice(record.status, ["ready", "partial", "needs-parsing", "failed"]);
    const error = record.error === undefined ? undefined : string(record.error, 100_000);
    if (status === "failed" && !error) throw new Error("失败的材料记录缺少失败原因。");
    return {
      id: string(record.id, 100),
      name: string(record.name, 4096),
      sha256,
      bytes: integer(record.bytes, 0, 40_000_000),
      importedAt,
      original: string(record.original),
      parsed: string(record.parsed),
      parserVersion: string(record.parserVersion, 100),
      duplicate: record.duplicate,
      metadata: metadata(record.metadata),
      status,
      locations: list(record.locations).map(location),
      tables: list(record.tables, 10_000).map(preview),
      warnings: list(record.warnings, 100_000).map((warning) => string(warning, 100_000)),
      ...(error ? { error } : {}),
      ...(record.parseOptions === undefined
        ? {}
        : { parseOptions: decodeMaterialParseOptions(record.parseOptions) }),
      ...(record.recovery === undefined
        ? {}
        : { recovery: decodeMaterialRecoveryRecord(record.recovery) }),
    };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length)
    throw new Error("材料解析版本 ID 重复。");
  return result;
}

export interface MaterialAdoptionDeclaration {
  category: "paper" | "method" | "data" | "manuscript" | "design";
  sourceDescription: string;
  title?: string;
  authors?: string;
  year?: string;
  url?: string;
  dataKind?: "observed" | "synthetic";
  permission?: "public" | "user-authorized";
  tableName?: string;
  locators?: string[];
  formulaValueBasis?: string;
  textScope?: "metadata" | "abstract" | "partial-text" | "full-text";
}

export function decodeMaterialAdoptionDeclaration(value: unknown): MaterialAdoptionDeclaration {
  const record = object(value, [
    "category",
    "sourceDescription",
    "title",
    "authors",
    "year",
    "url",
    "dataKind",
    "permission",
    "tableName",
    "locators",
    "formulaValueBasis",
    "textScope",
  ]);
  const result: MaterialAdoptionDeclaration = {
    category: choice(record.category, ["paper", "method", "data", "manuscript", "design"]),
    sourceDescription: string(record.sourceDescription, 8000).trim(),
  };
  for (const [field, limit] of [
    ["title", 1000],
    ["authors", 2000],
    ["year", 40],
    ["url", 4000],
    ["tableName", 1000],
    ["formulaValueBasis", 8000],
  ] as const) {
    if (record[field] !== undefined) result[field] = string(record[field], limit).trim();
  }
  if (record.dataKind !== undefined)
    result.dataKind = choice(record.dataKind, ["observed", "synthetic"]);
  if (record.permission !== undefined)
    result.permission = choice(record.permission, ["public", "user-authorized"]);
  if (record.textScope !== undefined)
    result.textScope = choice(record.textScope, [
      "metadata",
      "abstract",
      "partial-text",
      "full-text",
    ]);
  if (result.category === "data" && (!result.dataKind || !result.permission))
    throw new Error("数据采用必须明确材料类别和公开或用户已授权的用途许可。");
  if (record.locators !== undefined) {
    result.locators = list(record.locators, 10000).map((locator) => string(locator, 8192));
    if (!result.locators.length || new Set(result.locators).size !== result.locators.length)
      throw new Error("采用定位列表不能为空或重复。");
  }
  return result;
}

export function decodeMaterialParseOptions(value: unknown): MaterialParseOptions {
  const record = object(value, ["encoding", "delimiter", "sheet", "headerRow"]);
  const result: MaterialParseOptions = {};
  if (record.encoding !== undefined)
    result.encoding = choice(record.encoding, ["auto", "utf-8", "utf-16le", "utf-16be", "gb18030"]);
  if (record.delimiter !== undefined) result.delimiter = choice(record.delimiter, [",", ";", "\t"]);
  if (record.sheet !== undefined) result.sheet = string(record.sheet, 1000, true);
  if (record.headerRow !== undefined) result.headerRow = integer(record.headerRow, 1, 100_000);
  return result;
}
function decodeMaterialRecoveryRecord(value: unknown): MaterialRecoveryRecord {
  const record = object(value, ["fromImportId", "kind", "description"]);
  return {
    fromImportId: string(record.fromImportId, 100),
    kind: choice(record.kind, ["reparse", "replace", "supplement"]),
    ...(record.description === undefined ? {} : { description: string(record.description, 8000) }),
  };
}
export function decodeMaterialRecoveryRequest(value: unknown): MaterialRecoveryRequest {
  const record = object(value, [
    "kind",
    "encoding",
    "delimiter",
    "sheet",
    "headerRow",
    "locator",
    "text",
    "description",
  ]);
  if (record.kind === "reparse") {
    const { kind: _kind, ...options } = record;
    return { kind: "reparse", ...decodeMaterialParseOptions(options) };
  }
  if (record.kind === "replace") {
    object(record, ["kind"]);
    return { kind: "replace" };
  }
  if (record.kind === "supplement") {
    object(record, ["kind", "locator", "text", "description"]);
    return {
      kind: "supplement",
      locator: string(record.locator, 8192),
      text: string(record.text, 300_000),
      description: string(record.description, 8000),
    };
  }
  throw new Error("无效材料恢复方式。");
}
