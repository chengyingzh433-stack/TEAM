import { decodeResearchClaimActualRead } from "./research-claims";
import type { ResearchClaimActualRead, ResearchClaimDepth } from "./research-claims";
import type { ResearchLiteratureToolScope } from "./research-literature-search";

/** The host captures this before an asynchronous read. Model arguments never supply it. */
export type ResearchSynthesisOwner = ResearchLiteratureToolScope;
export interface ResearchSynthesisHost {
  callId: string;
  at: string;
  owner: ResearchSynthesisOwner;
  judgment: "model-semantic-review";
}
export interface ResearchSynthesisSourceRef {
  sourceId: string;
  locatorId: string;
  start: number;
  end: number;
  requiredDepth: ResearchClaimDepth;
}
export interface ResearchSynthesisEvidence extends ResearchSynthesisSourceRef {
  sourceSha256: string;
  bodySha256: string;
  exactText: string;
  readIds: string[];
}
export interface ResearchSynthesisReadBinding {
  id: string;
  receipt: ResearchClaimActualRead;
  owner: ResearchSynthesisOwner;
}
export interface ResearchSynthesisDraft {
  artifactId: string;
  bodySha256: string;
  taskId: string;
  taskVersion: number;
  attemptId: string;
}
export const RESEARCH_SYNTHESIS_COLUMNS = [
  "researchQuestion",
  "populationContext",
  "conceptsMeasures",
  "designEvidence",
  "findings",
  "limitations",
  "relationToQuestion",
] as const;
export type ResearchSynthesisColumn = (typeof RESEARCH_SYNTHESIS_COLUMNS)[number];
export type ResearchSynthesisCellRequest =
  { summary: string; evidence: ResearchSynthesisSourceRef[] } | { unavailable: string };
export type ResearchSynthesisCell =
  { summary: string; evidence: ResearchSynthesisEvidence[] } | { unavailable: string };
export interface ResearchSynthesisMatrixRequest {
  id: string;
  artifactId: string;
  supersedesId?: string;
  rows: {
    sourceId: string;
    cells: Record<ResearchSynthesisColumn, ResearchSynthesisCellRequest>;
  }[];
}
export interface ResearchSynthesisMatrix extends Omit<ResearchSynthesisMatrixRequest, "rows"> {
  rows: { sourceId: string; cells: Record<ResearchSynthesisColumn, ResearchSynthesisCell> }[];
  draft: ResearchSynthesisDraft;
  host: ResearchSynthesisHost;
}
export type ResearchGapState = "pending-validation" | "supported-in-scope" | "weakened-or-rejected";
export interface ResearchCandidateGapRequest {
  id: string;
  artifactId: string;
  supersedesId?: string;
  statement: string;
  scope: string;
  state: ResearchGapState;
  matrixIds: string[];
  claimIds: string[];
  evidence: ResearchSynthesisSourceRef[];
  counterSearchBatchIds: string[];
  remainingUncertainty: string;
}
export interface ResearchCandidateGap extends Omit<ResearchCandidateGapRequest, "evidence"> {
  evidence: ResearchSynthesisEvidence[];
  searchPins: { id: string; sha256: string }[];
  draft: ResearchSynthesisDraft;
  host: ResearchSynthesisHost;
}
export interface ResearchCounterevidenceRequest {
  id: string;
  source: ResearchSynthesisSourceRef;
  claimIds: string[];
  gapIds: string[];
  reason: string;
  materialChange: boolean;
}
export interface ResearchCounterevidence extends Omit<ResearchCounterevidenceRequest, "source"> {
  source: ResearchSynthesisEvidence;
  target: ResearchSynthesisDraft;
  targetClaimPins: { id: string; sha256: string }[];
  targetGapPins: { id: string; sha256: string }[];
  impact: { directTaskIds: string[]; affectedTaskIds: string[]; reusableTaskIds: string[] };
  changeId: string;
  host: ResearchSynthesisHost;
}
export interface ResearchCounterevidenceResponseRequest {
  id: string;
  counterevidenceId: string;
  artifactId: string;
  start: number;
  end: number;
  reason: string;
  claimReplacements: { beforeId: string; afterId: string }[];
  gapReplacements: { beforeId: string; afterId: string }[];
}
export interface ResearchCounterevidenceResponse extends ResearchCounterevidenceResponseRequest {
  draft: ResearchSynthesisDraft;
  exactText: string;
  source: ResearchSynthesisEvidence;
  host: ResearchSynthesisHost;
}
export interface ResearchCounterevidenceReviewRequest {
  id: string;
  responseId: string;
  start: number;
  end: number;
  conclusion: "addressed" | "unresolved";
  reason: string;
}
export interface ResearchCounterevidenceReview extends ResearchCounterevidenceReviewRequest {
  responseSha256: string;
  exactText: string;
  source: ResearchSynthesisEvidence;
  host: ResearchSynthesisHost;
}
export interface ResearchCounterevidenceResolutionRequest {
  id: string;
  reviewId: string;
  decision: "close" | "keep-open";
  reason: string;
  direction: "maintain" | "narrow" | "change-question-or-design";
  decisionId?: string;
}
export interface ResearchCounterevidenceResolution extends ResearchCounterevidenceResolutionRequest {
  reviewSha256: string;
  source: ResearchSynthesisEvidence;
  host: ResearchSynthesisHost;
}
export const SYNTHESIS_OPERATIONS = [
  "synthesis-context",
  "synthesis-matrix",
  "synthesis-gap",
  "synthesis-counterevidence",
  "synthesis-respond",
  "synthesis-review",
  "synthesis-resolve",
] as const;
export type ResearchSynthesisOperation = (typeof SYNTHESIS_OPERATIONS)[number];
export interface ResearchSynthesis {
  version: 1;
  reads: ResearchSynthesisReadBinding[];
  matrices: ResearchSynthesisMatrix[];
  gaps: ResearchCandidateGap[];
  counterevidence: ResearchCounterevidence[];
  responses: ResearchCounterevidenceResponse[];
  reviews: ResearchCounterevidenceReview[];
  resolutions: ResearchCounterevidenceResolution[];
  operations: {
    id: string;
    operation: Exclude<ResearchSynthesisOperation, "synthesis-context">;
    requestSha256: string;
    recordId: string;
    host: ResearchSynthesisHost;
  }[];
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("综合记录含未知或宿主专有字段。");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 12000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("综合记录需要有界的非空文本。");
}
function hash(value: unknown) {
  text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("综合 SHA 无效。");
}
function positive(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("综合版本无效。");
}
function array(value: unknown, max = 5000): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("综合清单无效。");
}
function ids(value: unknown) {
  array(value, 200);
  value.forEach((v) => text(v, 512));
  if (new Set(value).size !== value.length) throw new Error("综合引用身份重复。");
}
function span(r: Record<string, unknown>) {
  if (
    !Number.isSafeInteger(r.start) ||
    !Number.isSafeInteger(r.end) ||
    Number(r.start) < 0 ||
    Number(r.end) <= Number(r.start)
  )
    throw new Error("综合 UTF-16 定位无效。");
}
function ref(value: unknown, saved: boolean) {
  const r = object(value, [
    "sourceId",
    "locatorId",
    "start",
    "end",
    "requiredDepth",
    ...(saved ? ["sourceSha256", "bodySha256", "exactText", "readIds"] : []),
  ]);
  text(r.sourceId, 512);
  text(r.locatorId, 512);
  span(r);
  if (!["metadata", "abstract", "partial-text", "full-text"].includes(String(r.requiredDepth)))
    throw new Error("综合阅读深度无效。");
  if (saved) {
    hash(r.sourceSha256);
    hash(r.bodySha256);
    text(r.exactText, 100000);
    ids(r.readIds);
    if (!(r.readIds as unknown[]).length) throw new Error("综合缺少本人实际读取。");
  }
}
function draft(value: unknown) {
  const r = object(value, ["artifactId", "bodySha256", "taskId", "taskVersion", "attemptId"]);
  for (const key of ["artifactId", "taskId", "attemptId"]) text(r[key], 512);
  hash(r.bodySha256);
  positive(r.taskVersion);
}
function owner(value: unknown) {
  const r = object(value, [
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
    text(r[key], 512);
  positive(r.revision);
  positive(r.taskVersion);
  if (!["mentor", "lead", "reviewer", "librarian"].includes(String(r.role)))
    throw new Error("综合角色无效。");
  const model = object(r.model, ["provider", "modelId"]);
  text(model.provider, 512);
  text(model.modelId, 512);
  array(r.inputs, 1000);
  const names = new Set();
  for (const input of r.inputs) {
    const pin = object(input, ["inputId", "version", "digest"]);
    text(pin.inputId, 512);
    positive(pin.version);
    text(pin.digest, 512);
    if (names.has(pin.inputId)) throw new Error("综合输入重复。");
    names.add(pin.inputId);
  }
}
function host(value: unknown) {
  const r = object(value, ["callId", "at", "owner", "judgment"]);
  text(r.callId, 512);
  text(r.at, 100);
  if (!Number.isFinite(Date.parse(r.at)) || r.judgment !== "model-semantic-review")
    throw new Error("综合身份或判断边界无效。");
  owner(r.owner);
}
const requestKeys = {
  "synthesis-matrix": ["id", "artifactId", "supersedesId", "rows"],
  "synthesis-gap": [
    "id",
    "artifactId",
    "supersedesId",
    "statement",
    "scope",
    "state",
    "matrixIds",
    "claimIds",
    "evidence",
    "counterSearchBatchIds",
    "remainingUncertainty",
  ],
  "synthesis-counterevidence": ["id", "source", "claimIds", "gapIds", "reason", "materialChange"],
  "synthesis-respond": [
    "id",
    "counterevidenceId",
    "artifactId",
    "start",
    "end",
    "reason",
    "claimReplacements",
    "gapReplacements",
  ],
  "synthesis-review": ["id", "responseId", "start", "end", "conclusion", "reason"],
  "synthesis-resolve": ["id", "reviewId", "decision", "reason", "direction", "decisionId"],
} as const;
type WriteOperation = keyof typeof requestKeys;
function entry(value: unknown, operation: WriteOperation, saved: boolean) {
  const extra = saved
    ? operation === "synthesis-matrix"
      ? ["draft", "host"]
      : operation === "synthesis-gap"
        ? ["searchPins", "draft", "host"]
        : operation === "synthesis-counterevidence"
          ? ["target", "targetClaimPins", "targetGapPins", "impact", "changeId", "host"]
          : operation === "synthesis-respond"
            ? ["draft", "exactText", "source", "host"]
            : operation === "synthesis-review"
              ? ["responseSha256", "exactText", "source", "host"]
              : ["reviewSha256", "source", "host"]
    : [];
  const r = object(value, [...requestKeys[operation], ...extra]);
  text(r.id, 512);
  if (["synthesis-matrix", "synthesis-gap", "synthesis-respond"].includes(operation))
    text(r.artifactId, 512);
  if (r.supersedesId !== undefined) text(r.supersedesId, 512);
  if (!["synthesis-matrix", "synthesis-gap"].includes(operation)) text(r.reason);
  if (operation === "synthesis-matrix") {
    array(r.rows, 500);
    if (!r.rows.length) throw new Error("综合矩阵没有来源行。");
    const seen = new Set();
    for (const row of r.rows) {
      const rowObject = object(row, ["sourceId", "cells"]);
      text(rowObject.sourceId, 512);
      if (seen.has(rowObject.sourceId)) throw new Error("矩阵来源行重复。");
      seen.add(rowObject.sourceId);
      const cells = object(rowObject.cells, RESEARCH_SYNTHESIS_COLUMNS);
      for (const key of RESEARCH_SYNTHESIS_COLUMNS) {
        const cell = object(cells[key], ["summary", "evidence", "unavailable"]);
        if ("unavailable" in cell) {
          if ("summary" in cell || "evidence" in cell)
            throw new Error("不可用单元不能冒充已核验。");
          text(cell.unavailable);
        } else {
          text(cell.summary);
          array(cell.evidence, 40);
          if (!cell.evidence.length) throw new Error("综合单元必须指向原文。");
          cell.evidence.forEach((e) => ref(e, saved));
        }
      }
    }
  } else if (operation === "synthesis-gap") {
    for (const key of ["statement", "scope", "remainingUncertainty"]) text(r[key]);
    if (
      !["pending-validation", "supported-in-scope", "weakened-or-rejected"].includes(
        String(r.state),
      )
    )
      throw new Error("候选缺口状态无效。");
    for (const key of ["matrixIds", "claimIds", "counterSearchBatchIds"]) ids(r[key]);
    array(r.evidence, 40);
    r.evidence.forEach((e) => ref(e, saved));
    if (saved) pins(r.searchPins);
  } else if (operation === "synthesis-counterevidence") {
    ref(r.source, saved);
    ids(r.claimIds);
    ids(r.gapIds);
    if (
      typeof r.materialChange !== "boolean" ||
      (!(r.claimIds as unknown[]).length && !(r.gapIds as unknown[]).length)
    )
      throw new Error("反证必须点名已有主张或候选缺口。");
    if (saved) {
      draft(r.target);
      pins(r.targetClaimPins);
      pins(r.targetGapPins);
      text(r.changeId, 512);
      const impact = object(r.impact, ["directTaskIds", "affectedTaskIds", "reusableTaskIds"]);
      Object.values(impact).forEach(ids);
    }
  } else if (operation === "synthesis-respond") {
    text(r.counterevidenceId, 512);
    span(r);
    for (const key of ["claimReplacements", "gapReplacements"]) {
      array(r[key], 200);
      for (const pair of r[key]) {
        const p = object(pair, ["beforeId", "afterId"]);
        text(p.beforeId, 512);
        text(p.afterId, 512);
      }
    }
  } else if (operation === "synthesis-review") {
    text(r.responseId, 512);
    span(r);
    if (!["addressed", "unresolved"].includes(String(r.conclusion)))
      throw new Error("反证复核结论无效。");
    if (saved) hash(r.responseSha256);
  } else {
    text(r.reviewId, 512);
    if (
      !["close", "keep-open"].includes(String(r.decision)) ||
      !["maintain", "narrow", "change-question-or-design"].includes(String(r.direction))
    )
      throw new Error("导师反证处理无效。");
    if (r.decisionId !== undefined) text(r.decisionId, 512);
    if (saved) hash(r.reviewSha256);
  }
  if (saved) {
    host(r.host);
    if (
      operation === "synthesis-matrix" ||
      operation === "synthesis-gap" ||
      operation === "synthesis-respond"
    )
      draft(r.draft);
    if (["synthesis-respond", "synthesis-review", "synthesis-resolve"].includes(operation))
      ref(r.source, true);
    if (operation === "synthesis-respond" || operation === "synthesis-review")
      text(r.exactText, 100000);
  }
  return structuredClone(value);
}
function pins(value: unknown) {
  array(value, 200);
  for (const raw of value) {
    const r = object(raw, ["id", "sha256"]);
    text(r.id, 512);
    hash(r.sha256);
  }
}
export function decodeResearchSynthesisRequest(operation: WriteOperation, value: unknown): unknown {
  try {
    return entry(value, operation, false);
  } catch (error) {
    const sourceShape =
      operation === "synthesis-counterevidence"
        ? " source字段为{sourceId,locatorId,start,end,requiredDepth}。"
        : "";
    throw new Error(
      `${error instanceof Error ? error.message : "无效综合请求。"} ${operation} 的request允许字段：${requestKeys[operation].join(", ")}。${sourceShape}`,
    );
  }
}
export function decodeResearchSynthesis(value: unknown): ResearchSynthesis {
  const r = object(value, [
    "version",
    "reads",
    "matrices",
    "gaps",
    "counterevidence",
    "responses",
    "reviews",
    "resolutions",
    "operations",
  ]);
  if (r.version !== 1) throw new Error("综合记录版本无效。");
  const mapping = {
    matrices: "synthesis-matrix",
    gaps: "synthesis-gap",
    counterevidence: "synthesis-counterevidence",
    responses: "synthesis-respond",
    reviews: "synthesis-review",
    resolutions: "synthesis-resolve",
  } as const;
  for (const [key, operation] of Object.entries(mapping)) {
    array(r[key]);
    const seen = new Set();
    for (const value of r[key]) {
      const parsed = entry(value, operation, true) as { id: string };
      if (seen.has(parsed.id)) throw new Error("综合不可变身份重复。");
      seen.add(parsed.id);
    }
  }
  array(r.reads, 20000);
  array(r.operations, 20000);
  const readIds = new Set(),
    operationIds = new Set();
  for (const value of r.reads) {
    const read = object(value, ["id", "receipt", "owner"]);
    text(read.id, 512);
    const receipt = decodeResearchClaimActualRead(read.receipt);
    owner(read.owner);
    if (read.id !== receipt.id || readIds.has(read.id))
      throw new Error("综合实际读取绑定重复或不符。");
    readIds.add(read.id);
  }
  for (const value of r.operations) {
    const op = object(value, ["id", "operation", "requestSha256", "recordId", "host"]);
    text(op.id, 512);
    text(op.recordId, 512);
    hash(op.requestSha256);
    host(op.host);
    if (!Object.hasOwn(requestKeys, String(op.operation)) || operationIds.has(op.id))
      throw new Error("综合操作身份重复或无效。");
    operationIds.add(op.id);
  }
  return structuredClone(value) as ResearchSynthesis;
}
