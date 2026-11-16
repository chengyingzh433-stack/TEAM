/** Offsets are UTF-16 code units, [start,end), in a pinned host text snapshot. */
export interface ResearchClaimArtifactSnapshot {
  id: string;
  body: string;
  bodySha256: string;
}
export type ResearchClaimCategory = "source-fact" | "research-result" | "inference" | "method";
export type ResearchClaimDepth = "metadata" | "abstract" | "partial-text" | "full-text";
export type ResearchClaimConclusion =
  "supported" | "partially-supported" | "unsupported" | "insufficient-material";
/** Labels and mappings come from the parser/host, not from a model's invented page numbers. */
export interface ResearchClaimSourceSnapshot extends ResearchClaimArtifactSnapshot {
  sha256: string;
  available: boolean;
  locators: { id: string; label: string; start: number; end: number; depth: ResearchClaimDepth }[];
}
export interface ResearchClaimActualRead {
  id: string;
  sourceId: string;
  sourceSha256: string;
  bodySha256: string;
  locatorId: string;
  start: number;
  end: number;
  depth: ResearchClaimDepth;
  sessionId: string;
  at: string;
  evidenceRef: string;
}
export type ResearchClaimEvidenceRequest =
  | {
      kind: "source";
      sourceId: string;
      locatorId: string;
      start: number;
      end: number;
      requiredDepth: ResearchClaimDepth;
      relation: "support" | "counterevidence";
    }
  | { kind: "result"; runId: string; path: string[] };
export type ResearchClaimEvidence =
  | (Extract<ResearchClaimEvidenceRequest, { kind: "source" }> & {
      sourceSha256: string;
      bodySha256: string;
      exactText: string;
    })
  | (Extract<ResearchClaimEvidenceRequest, { kind: "result" }> & { runSha256: string });
/** Model input contains references only: no body hashes, read receipts or reviewer identities. */
export interface ResearchClaimRequest {
  id: string;
  artifactId: string;
  start: number;
  end: number;
  category: ResearchClaimCategory;
  evidence: ResearchClaimEvidenceRequest[];
}
export interface ResearchClaim extends Omit<ResearchClaimRequest, "evidence"> {
  bodySha256: string;
  exactText: string;
  evidence: ResearchClaimEvidence[];
}
export interface ResearchClaimReviewRequest {
  claimId: string;
  conclusion: ResearchClaimConclusion;
  reason: string;
  resolvesReviewIds: string[];
}
/** Only the trusted host supplies this identity from the actual invoking session/run/tool call. */
export interface ResearchClaimReviewHost {
  id: string;
  at: string;
  actor: {
    kind: "model";
    role: "reviewer" | "mentor";
    sessionId: string;
    runId: string;
    toolCallId: string;
    provider: string;
    modelId: string;
  };
}
export interface ResearchClaimReview extends ResearchClaimReviewRequest, ResearchClaimReviewHost {
  claimSha256: string;
  actualReads: ResearchClaimActualRead[];
  judgment: "model-semantic-review";
}
export interface ResearchClaims {
  version: 1;
  claims: ResearchClaim[];
  reviews: ResearchClaimReview[];
}

const text = (v: unknown, limit = 512): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= limit && !v.includes("\0");
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const depth = (v: unknown) =>
  ["metadata", "abstract", "partial-text", "full-text"].includes(String(v));
const time = (v: unknown) =>
  typeof v === "string" && v.length <= 100 && Number.isFinite(Date.parse(v));
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("主张记录含未知或越权字段。");
  return value as Record<string, unknown>;
}
function span(row: Record<string, unknown>) {
  if (
    !Number.isSafeInteger(row.start) ||
    !Number.isSafeInteger(row.end) ||
    Number(row.start) < 0 ||
    Number(row.end) <= Number(row.start)
  )
    throw new Error("主张定位范围无效。");
}
function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    value.some((v) => !text(v)) ||
    new Set(value).size !== value.length
  )
    throw new Error("主张引用身份无效或重复。");
  return [...value] as string[];
}
export function decodeResearchClaimPath(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16 ||
    value.some((key) => !text(key, 300) || ["__proto__", "prototype", "constructor"].includes(key))
  )
    throw new Error("结果字段需要安全的独立键路径。");
  return [...value] as string[];
}
function evidence(
  value: unknown,
  saved: boolean,
): ResearchClaimEvidenceRequest | ResearchClaimEvidence {
  const kind = value && typeof value === "object" ? (value as { kind?: unknown }).kind : undefined;
  const keys =
    kind === "source"
      ? [
          "kind",
          "sourceId",
          "locatorId",
          "start",
          "end",
          "requiredDepth",
          "relation",
          ...(saved ? ["sourceSha256", "bodySha256", "exactText"] : []),
        ]
      : ["kind", "runId", "path", ...(saved ? ["runSha256"] : [])];
  const row = record(value, keys);
  if (kind === "source") {
    span(row);
    if (
      !text(row.sourceId) ||
      !text(row.locatorId) ||
      !depth(row.requiredDepth) ||
      !["support", "counterevidence"].includes(String(row.relation)) ||
      (saved &&
        (!hash(row.sourceSha256) ||
          !hash(row.bodySha256) ||
          typeof row.exactText !== "string" ||
          row.exactText.length > 100_000))
    )
      throw new Error("来源主张依赖无效。");
  } else if (kind === "result") {
    if (!text(row.runId) || (saved && !hash(row.runSha256))) throw new Error("计算主张依赖无效。");
    decodeResearchClaimPath(row.path);
  } else throw new Error("未知主张依赖类型。");
  return structuredClone(value) as ResearchClaimEvidenceRequest | ResearchClaimEvidence;
}
function claim(value: unknown, saved: boolean): ResearchClaimRequest | ResearchClaim {
  const row = record(value, [
    "id",
    "artifactId",
    "start",
    "end",
    "category",
    "evidence",
    ...(saved ? ["bodySha256", "exactText"] : []),
  ]);
  span(row);
  if (
    !text(row.id) ||
    !text(row.artifactId) ||
    !["source-fact", "research-result", "inference", "method"].includes(String(row.category)) ||
    !Array.isArray(row.evidence) ||
    row.evidence.length > 40 ||
    (saved && (!hash(row.bodySha256) || !text(row.exactText, 100_000)))
  )
    throw new Error("主张字段无效。");
  row.evidence.forEach((entry) => evidence(entry, saved));
  return structuredClone(value) as ResearchClaimRequest | ResearchClaim;
}
export function decodeResearchClaimRequest(value: unknown): ResearchClaimRequest {
  return claim(value, false) as ResearchClaimRequest;
}
export function decodeResearchClaimActualRead(value: unknown): ResearchClaimActualRead {
  const row = record(value, [
    "id",
    "sourceId",
    "sourceSha256",
    "bodySha256",
    "locatorId",
    "start",
    "end",
    "depth",
    "sessionId",
    "at",
    "evidenceRef",
  ]);
  span(row);
  if (
    ![row.id, row.sourceId, row.locatorId, row.sessionId, row.evidenceRef].every((v) => text(v)) ||
    !hash(row.sourceSha256) ||
    !hash(row.bodySha256) ||
    !depth(row.depth) ||
    !time(row.at)
  )
    throw new Error("实际读取凭据无效。");
  return structuredClone(value) as ResearchClaimActualRead;
}
export function decodeResearchClaimReviewRequest(value: unknown): ResearchClaimReviewRequest {
  const row = record(value, ["claimId", "conclusion", "reason", "resolvesReviewIds"]);
  if (
    !text(row.claimId) ||
    !text(row.reason, 12_000) ||
    !["supported", "partially-supported", "unsupported", "insufficient-material"].includes(
      String(row.conclusion),
    )
  )
    throw new Error("主张审阅需要支持结论和具体理由。");
  ids(row.resolvesReviewIds);
  return structuredClone(value) as ResearchClaimReviewRequest;
}
export function decodeResearchClaimReviewHost(value: unknown): ResearchClaimReviewHost {
  const row = record(value, ["id", "at", "actor"]);
  const actor = record(row.actor, [
    "kind",
    "role",
    "sessionId",
    "runId",
    "toolCallId",
    "provider",
    "modelId",
  ]);
  if (
    !text(row.id) ||
    !time(row.at) ||
    actor.kind !== "model" ||
    !["reviewer", "mentor"].includes(String(actor.role)) ||
    ![actor.sessionId, actor.runId, actor.toolCallId, actor.provider, actor.modelId].every((v) =>
      text(v),
    )
  )
    throw new Error("主张核查身份必须来自宿主的 B 或导师模型运行；不是人类专家确认。");
  return structuredClone(value) as ResearchClaimReviewHost;
}
export function decodeResearchClaims(value: unknown): ResearchClaims {
  const row = record(value, ["version", "claims", "reviews"]);
  if (
    row.version !== 1 ||
    !Array.isArray(row.claims) ||
    !Array.isArray(row.reviews) ||
    row.claims.length > 5000 ||
    row.reviews.length > 20_000
  )
    throw new Error("主张登记保存记录无效。");
  const claims = row.claims.map((entry) => claim(entry, true) as ResearchClaim);
  const reviews = row.reviews.map((entry) => {
    const r = record(entry, [
      "claimId",
      "conclusion",
      "reason",
      "resolvesReviewIds",
      "id",
      "at",
      "actor",
      "claimSha256",
      "actualReads",
      "judgment",
    ]);
    decodeResearchClaimReviewRequest({
      claimId: r.claimId,
      conclusion: r.conclusion,
      reason: r.reason,
      resolvesReviewIds: r.resolvesReviewIds,
    });
    decodeResearchClaimReviewHost({ id: r.id, at: r.at, actor: r.actor });
    if (
      !hash(r.claimSha256) ||
      r.judgment !== "model-semantic-review" ||
      !Array.isArray(r.actualReads) ||
      r.actualReads.length > 1000
    )
      throw new Error("主张审阅记录无效。");
    r.actualReads.forEach(decodeResearchClaimActualRead);
    return structuredClone(entry) as ResearchClaimReview;
  });
  if (
    new Set(claims.map((c) => c.id)).size !== claims.length ||
    new Set(reviews.map((r) => r.id)).size !== reviews.length
  )
    throw new Error("不可变主张或审阅身份重复。");
  for (let i = 0; i < reviews.length; i++) {
    const review = reviews[i]!;
    if (
      !claims.some((c) => c.id === review.claimId) ||
      (review.resolvesReviewIds.length > 0 && review.actor.role !== "mentor") ||
      review.resolvesReviewIds.some(
        (id) =>
          !reviews.slice(0, i).some((prior) => prior.id === id && prior.claimId === review.claimId),
      )
    )
      throw new Error("主张审阅或分歧处理缺少在先同主张记录。");
  }
  return { version: 1, claims, reviews };
}
