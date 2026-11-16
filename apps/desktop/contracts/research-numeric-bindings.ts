import { isResearchStageId, type ResearchStageId } from "./research-group";

/** UTF-16 code-unit offsets, [start,end), matching JavaScript/editor string slicing. */
export interface ResearchNumericArtifactSnapshot {
  id: string;
  body: string;
  bodySha256: string;
}
export type ResearchNumericRounding = "half-away-from-zero" | "half-even" | "truncate";
export type ResearchNumericQuantity = "sample-size" | "r-squared" | "coefficient" | "other";
/** Separate host-owned declaration. A binding must never supply its own unit authority. */
export interface ResearchResultFieldMetadata {
  id: string;
  runId: string;
  runSha256: string;
  path: string[];
  quantity: ResearchNumericQuantity;
  /** Empty string explicitly means dimensionless; unknown is represented by status. No unit conversion. */
  unit: string;
  status: "unknown" | "declared" | "verified";
  provenance: {
    actor: "host" | "model" | "user" | "external-expert";
    actorId: string;
    at: string;
    sourceRef: string;
    note: string;
    /** Host-owned declaration stage; absent historical records remain unscoped. */
    stage?: ResearchStageId;
  };
}
export interface ResearchNumericBinding {
  id: string;
  artifactId: string;
  bodySha256: string;
  start: number;
  end: number;
  exactText: string;
  runId: string;
  runSha256: string;
  path: string[];
  fieldMetadataId: string;
  fieldMetadataSha256: string;
  quantity: ResearchNumericQuantity;
  unit: string;
  decimalPlaces: number;
  /** Applied to the finite result number's shortest round-trip decimal representation. */
  rounding: ResearchNumericRounding;
  unitSeparator: "" | " ";
}
export interface ResearchNumericBindingRequest {
  id: string;
  artifactId: string;
  start: number;
  end: number;
  runId: string;
  path: string[];
  fieldMetadataId: string;
  quantity: ResearchNumericQuantity;
  unit: string;
  decimalPlaces: number;
  rounding: ResearchNumericRounding;
  unitSeparator: "" | " ";
}
/** Host-recorded semantic review of one lexical candidate, never a whole-document waiver. */
export interface ResearchNumericCandidateReview {
  id: string;
  artifactId: string;
  bodySha256: string;
  start: number;
  end: number;
  exactText: string;
  classification: "non-result-number" | "requires-binding";
  reason: string;
  provenance: {
    actor: "host" | "model" | "user" | "external-expert";
    actorId: string;
    at: string;
    sourceRef: string;
  };
}
export type ResearchNumericCandidateReviewInput = Pick<
  ResearchNumericCandidateReview,
  "id" | "start" | "end" | "classification" | "reason"
>;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, max = 512) =>
  typeof value === "string" && !!value.trim() && value.length <= max && !value.includes("\0");
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("数值绑定含未知或无效字段。");
  return value as Record<string, unknown>;
}
export function decodeResearchNumericPath(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16 ||
    value.some((key) => !text(key, 300) || ["__proto__", "prototype", "constructor"].includes(key))
  )
    throw new Error("结果字段路径必须是安全的独立键数组。");
  return [...value] as string[];
}
const requestKeys = [
  "id",
  "artifactId",
  "start",
  "end",
  "runId",
  "path",
  "fieldMetadataId",
  "quantity",
  "unit",
  "decimalPlaces",
  "rounding",
  "unitSeparator",
];
function request(value: unknown, extra: string[] = []): ResearchNumericBindingRequest {
  const row = record(value, [...requestKeys, ...extra]);
  if (
    !["id", "artifactId", "runId", "fieldMetadataId"].every((key) => text(row[key])) ||
    !Number.isSafeInteger(row.start) ||
    !Number.isSafeInteger(row.end) ||
    Number(row.start) < 0 ||
    Number(row.end) <= Number(row.start) ||
    !["sample-size", "r-squared", "coefficient", "other"].includes(String(row.quantity)) ||
    typeof row.unit !== "string" ||
    row.unit.length > 80 ||
    /[\r\n\0]/.test(row.unit) ||
    !Number.isInteger(row.decimalPlaces) ||
    Number(row.decimalPlaces) < 0 ||
    Number(row.decimalPlaces) > 12 ||
    !["half-away-from-zero", "half-even", "truncate"].includes(String(row.rounding)) ||
    !["", " "].includes(String(row.unitSeparator))
  )
    throw new Error("数值绑定身份、范围、单位或舍入声明无效。");
  decodeResearchNumericPath(row.path);
  return structuredClone(row) as unknown as ResearchNumericBindingRequest;
}
export function decodeResearchNumericBindingRequest(value: unknown): ResearchNumericBindingRequest {
  return request(value);
}
export function decodeResearchNumericBindings(value: unknown): ResearchNumericBinding[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("数值绑定清单无效。");
  const ids = new Set<string>();
  return value.map((raw) => {
    const row = request(raw, [
      "bodySha256",
      "exactText",
      "runSha256",
      "fieldMetadataSha256",
    ]) as ResearchNumericBinding;
    if (
      ids.has(row.id) ||
      !hash(row.bodySha256) ||
      !hash(row.runSha256) ||
      !hash(row.fieldMetadataSha256) ||
      !text(row.exactText, 1000) ||
      row.exactText.length !== row.end - row.start
    )
      throw new Error("绑定快照摘要、片段或唯一身份无效。");
    ids.add(row.id);
    return row;
  });
}
export function decodeResearchResultFieldMetadata(value: unknown): ResearchResultFieldMetadata[] {
  if (!Array.isArray(value)) throw new Error("结果字段元数据清单无效。");
  const ids = new Set<string>();
  return value.map((raw) => {
    const row = record(raw, [
      "id",
      "runId",
      "runSha256",
      "path",
      "quantity",
      "unit",
      "status",
      "provenance",
    ]);
    const provenance = record(row.provenance, [
      "actor",
      "actorId",
      "at",
      "sourceRef",
      "note",
      "stage",
    ]);
    if (
      !text(row.id) ||
      ids.has(String(row.id)) ||
      !text(row.runId) ||
      !hash(row.runSha256) ||
      !["sample-size", "r-squared", "coefficient", "other"].includes(String(row.quantity)) ||
      typeof row.unit !== "string" ||
      row.unit.length > 80 ||
      /[\r\n\0]/.test(row.unit) ||
      !["unknown", "declared", "verified"].includes(String(row.status)) ||
      !["host", "model", "user", "external-expert"].includes(String(provenance.actor)) ||
      !text(provenance.actorId) ||
      !text(provenance.sourceRef, 3000) ||
      !text(provenance.note, 6000) ||
      typeof provenance.at !== "string" ||
      !Number.isFinite(Date.parse(provenance.at)) ||
      (provenance.stage !== undefined && !isResearchStageId(provenance.stage))
    )
      throw new Error("字段元数据必须保留独立声明状态、身份与出处。");
    decodeResearchNumericPath(row.path);
    ids.add(String(row.id));
    return structuredClone(row) as unknown as ResearchResultFieldMetadata;
  });
}

export function decodeResearchNumericCandidateReviewInput(
  value: unknown,
): ResearchNumericCandidateReviewInput {
  const row = record(value, ["id", "start", "end", "classification", "reason"]);
  if (
    !text(row.id) ||
    !Number.isSafeInteger(row.start) ||
    !Number.isSafeInteger(row.end) ||
    Number(row.start) < 0 ||
    Number(row.end) <= Number(row.start) ||
    !["non-result-number", "requires-binding"].includes(String(row.classification)) ||
    !text(row.reason, 6000)
  )
    throw new Error("候选复核必须限定一个精确范围、分类和非空理由。");
  return structuredClone(row) as unknown as ResearchNumericCandidateReviewInput;
}
export function decodeResearchNumericCandidateReviews(
  value: unknown,
): ResearchNumericCandidateReview[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error("候选复核记录清单无效。");
  const ids = new Set<string>();
  return value.map((raw) => {
    const row = record(raw, [
      "id",
      "artifactId",
      "bodySha256",
      "start",
      "end",
      "exactText",
      "classification",
      "reason",
      "provenance",
    ]);
    decodeResearchNumericCandidateReviewInput({
      id: row.id,
      start: row.start,
      end: row.end,
      classification: row.classification,
      reason: row.reason,
    });
    const provenance = record(row.provenance, ["actor", "actorId", "at", "sourceRef"]);
    if (
      ids.has(String(row.id)) ||
      !text(row.artifactId) ||
      !hash(row.bodySha256) ||
      !text(row.exactText, 1000) ||
      String(row.exactText).length !== Number(row.end) - Number(row.start) ||
      !["host", "model", "user", "external-expert"].includes(String(provenance.actor)) ||
      !text(provenance.actorId) ||
      !text(provenance.sourceRef, 3000) ||
      typeof provenance.at !== "string" ||
      !Number.isFinite(Date.parse(provenance.at))
    )
      throw new Error("候选复核需唯一身份、同稿摘要、精确片段及真实审阅出处。");
    ids.add(String(row.id));
    return structuredClone(row) as unknown as ResearchNumericCandidateReview;
  });
}
