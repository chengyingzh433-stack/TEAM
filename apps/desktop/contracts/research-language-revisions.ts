/** Renderer-safe records. UTF-16 half-open ranges refer to exact immutable artifact bodies. */
export interface ResearchLanguageArtifact {
  id: string;
  body: string;
  bodySha256: string;
}
export interface ResearchLanguageSpan {
  start: number;
  end: number;
  exactText: string;
}
export interface ResearchLanguageRange extends ResearchLanguageSpan {
  id: string;
  label: string;
}
export interface ResearchLanguageFrozenAnchor extends ResearchLanguageSpan {
  id: string;
  kind: "number" | "symbol" | "unit" | "variable" | "term" | "citation" | "ai-disclosure";
}
/** Trusted host resolves an actual UI selection or already-authorized scope; never model input. */
export interface ResearchLanguageAuthorization {
  id: string;
  at: string;
  kind: "explicit-user-selection" | "existing-authorized-scope";
  sourceRef: string;
}
export type ResearchLanguageActor =
  | {
      kind: "model";
      id: string;
      role: "lead" | "reviewer";
      sessionId: string;
      attemptId: string;
      nativeRunId: string;
      model: { provider: string; modelId: string };
    }
  | { kind: "user" | "external"; id: string };
/** Already-recorded host read, consumed here; this library cannot create native/user read events. */
export interface ResearchLanguageActualRead extends ResearchLanguageSpan {
  id: string;
  artifactId: string;
  bodySha256: string;
  at: string;
  actor: ResearchLanguageActor;
}
export interface ResearchLanguageChange {
  id: string;
  baseline: ResearchLanguageSpan;
  target: ResearchLanguageSpan;
}
export interface ResearchLanguageReviewUnit extends ResearchLanguageChange {
  rangeId: string;
}
export interface ResearchLanguageIssue {
  id: string;
  category: string;
  reason: string;
  baseline: ResearchLanguageSpan;
  target: ResearchLanguageSpan;
}
export interface ResearchLanguageCandidate extends ResearchLanguageIssue {
  unitId: string;
}
export interface ResearchLanguageProgramReport {
  programVersion: "language-revisions-1" | "language-revisions-2";
  at: string;
  baselineSha256: string;
  targetSha256: string;
  sha256: string;
  changes: ResearchLanguageChange[];
  units: ResearchLanguageReviewUnit[];
  hardIssues: ResearchLanguageIssue[];
  semanticCandidates: ResearchLanguageCandidate[];
  boundary: string;
}
export interface ResearchLanguageReviewCoverage {
  unitId: string;
  baseline: ResearchLanguageSpan;
  target: ResearchLanguageSpan;
}
export interface ResearchLanguageSemanticReviewRequest {
  revisionId: string;
  classification: "meaning-preserved" | "substantive-change" | "insufficient-material";
  reason: string;
  coverage: ResearchLanguageReviewCoverage[];
}
export interface ResearchLanguageReviewHost {
  id: string;
  at: string;
  actor: ResearchLanguageActor;
  evidenceRef: string;
  readIds: string[];
}
export interface ResearchLanguageSemanticReview
  extends ResearchLanguageSemanticReviewRequest, ResearchLanguageReviewHost {
  baselineSha256: string;
  targetSha256: string;
  programReportSha256: string;
  actualReads: ResearchLanguageActualRead[];
  judgment: "attributed-semantic-review-not-program-proof";
}
export interface ResearchLanguageSkip {
  id: string;
  at: string;
  actor: ResearchLanguageActor;
  evidenceRef: string;
  classification: "user-skipped" | "not-applicable";
  reason: string;
  baselineSha256: string;
  targetSha256: string;
}
export interface ResearchLanguageRevision {
  id: string;
  createdAt: string;
  baseline: ResearchLanguageArtifact;
  target: ResearchLanguageArtifact;
  authorization: ResearchLanguageAuthorization;
  ranges: ResearchLanguageRange[];
  frozenAnchors: ResearchLanguageFrozenAnchor[];
  programReport: ResearchLanguageProgramReport;
  semanticReviews: ResearchLanguageSemanticReview[];
  skip?: ResearchLanguageSkip;
}

export function languageObject(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("语言修订含未知字段或宿主专有字段。");
}
export function languageText(value: unknown, max = 12000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("语言记录需要非空文本。");
}
function hash(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("语言版本SHA无效。");
}
export function languageTime(value: unknown): asserts value is string {
  languageText(value, 100);
  if (!Number.isFinite(Date.parse(value))) throw new Error("语言记录时间无效。");
}
function list(value: unknown, max = 20000): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("语言记录清单无效。");
}
function ids(value: unknown) {
  list(value);
  value.forEach((id) => languageText(id, 1024));
  if (new Set(value).size !== value.length) throw new Error("语言引用身份重复。");
}
function enumeration(value: unknown, choices: string[]) {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error("语言记录分类无效。");
}
export function assertResearchLanguageSpan(
  value: unknown,
  body?: string,
): asserts value is ResearchLanguageSpan {
  languageObject(value, ["start", "end", "exactText"]);
  if (
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end) ||
    Number(value.start) < 0 ||
    Number(value.end) < Number(value.start) ||
    typeof value.exactText !== "string" ||
    value.exactText.length > 300000 ||
    value.exactText.includes("\0")
  )
    throw new Error("UTF16位置无效。");
  if (body !== undefined) {
    const start = Number(value.start),
      end = Number(value.end);
    const splitPair = (at: number) =>
      at > 0 &&
      at < body.length &&
      /[\uD800-\uDBFF]/.test(body[at - 1]!) &&
      /[\uDC00-\uDFFF]/.test(body[at]!);
    if (
      end > body.length ||
      body.slice(start, end) !== value.exactText ||
      splitPair(start) ||
      splitPair(end)
    )
      throw new Error("位置/原文不符或切断UTF16字符。");
  }
}
export function decodeResearchLanguageActor(value: unknown): ResearchLanguageActor {
  if (!value || typeof value !== "object") throw new Error("缺少实际身份。");
  const kind = (value as Record<string, unknown>).kind;
  languageObject(
    value,
    kind === "model"
      ? ["kind", "id", "role", "sessionId", "attemptId", "nativeRunId", "model"]
      : ["kind", "id"],
  );
  enumeration(value.kind, ["model", "user", "external"]);
  languageText(value.id, 512);
  if (kind === "model") {
    enumeration(value.role, ["lead", "reviewer"]);
    if (value.id !== `model:${String(value.role)}`) throw new Error("模型身份不能自称人类。");
    for (const key of ["sessionId", "attemptId", "nativeRunId"]) languageText(value[key], 1024);
    languageObject(value.model, ["provider", "modelId"]);
    languageText(value.model.provider, 512);
    languageText(value.model.modelId, 512);
  } else if (value.id.startsWith("model:")) throw new Error("模型不能改报用户或外部身份。");
  return structuredClone(value) as unknown as ResearchLanguageActor;
}
export function researchLanguageActorKey(actor: ResearchLanguageActor) {
  return actor.kind === "model"
    ? JSON.stringify([
        actor.kind,
        actor.id,
        actor.role,
        actor.sessionId,
        actor.attemptId,
        actor.nativeRunId,
        actor.model.provider,
        actor.model.modelId,
      ])
    : JSON.stringify([actor.kind, actor.id]);
}
export function researchLanguageRangesCover(
  ranges: readonly { start: number; end: number }[],
  start: number,
  end: number,
) {
  if (start === end) return ranges.some((range) => range.start <= start && range.end >= end);
  let covered = start;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.start > covered) break;
    if (range.end > covered) covered = range.end;
    if (covered >= end) return true;
  }
  return false;
}
export function decodeResearchLanguageArtifact(value: unknown): ResearchLanguageArtifact {
  languageObject(value, ["id", "body", "bodySha256"]);
  languageText(value.id, 1024);
  hash(value.bodySha256);
  if (typeof value.body !== "string" || value.body.length > 300000 || value.body.includes("\0"))
    throw new Error("稿件正文无效或超过30万UTF16字符。");
  return structuredClone(value) as unknown as ResearchLanguageArtifact;
}
export function decodeResearchLanguageSemanticReviewRequest(
  value: unknown,
): ResearchLanguageSemanticReviewRequest {
  languageObject(value, ["revisionId", "classification", "reason", "coverage"]);
  languageText(value.revisionId, 1024);
  languageText(value.reason);
  enumeration(value.classification, [
    "meaning-preserved",
    "substantive-change",
    "insufficient-material",
  ]);
  list(value.coverage, 1000);
  if (!value.coverage.length) throw new Error("不能用整体接受替代具体段落覆盖。");
  const seen = new Set<string>();
  for (const row of value.coverage) {
    languageObject(row, ["unitId", "baseline", "target"]);
    languageText(row.unitId, 1024);
    if (seen.has(row.unitId)) throw new Error("复核覆盖重复。");
    seen.add(row.unitId);
    assertResearchLanguageSpan(row.baseline);
    assertResearchLanguageSpan(row.target);
  }
  return structuredClone(value) as unknown as ResearchLanguageSemanticReviewRequest;
}
export function decodeResearchLanguageReviewHost(value: unknown): ResearchLanguageReviewHost {
  languageObject(value, ["id", "at", "actor", "evidenceRef", "readIds"]);
  languageText(value.id, 1024);
  languageTime(value.at);
  languageText(value.evidenceRef);
  decodeResearchLanguageActor(value.actor);
  ids(value.readIds);
  return structuredClone(value) as unknown as ResearchLanguageReviewHost;
}
export function decodeResearchLanguageActualRead(value: unknown): ResearchLanguageActualRead {
  languageObject(value, [
    "id",
    "artifactId",
    "bodySha256",
    "start",
    "end",
    "exactText",
    "at",
    "actor",
  ]);
  languageText(value.id, 1024);
  languageText(value.artifactId, 1024);
  hash(value.bodySha256);
  languageTime(value.at);
  decodeResearchLanguageActor(value.actor);
  assertResearchLanguageSpan({ start: value.start, end: value.end, exactText: value.exactText });
  return structuredClone(value) as unknown as ResearchLanguageActualRead;
}
export function decodeResearchLanguageRevisions(value: unknown): ResearchLanguageRevision[] {
  list(value, 1000);
  const revisionIds = new Set<string>();
  for (const entry of value) {
    languageObject(entry, [
      "id",
      "createdAt",
      "baseline",
      "target",
      "authorization",
      "ranges",
      "frozenAnchors",
      "programReport",
      "semanticReviews",
      "skip",
    ]);
    languageText(entry.id, 1024);
    if (revisionIds.has(entry.id)) throw new Error("修订ID重复。");
    revisionIds.add(entry.id);
    languageTime(entry.createdAt);
    const baseline = decodeResearchLanguageArtifact(entry.baseline),
      target = decodeResearchLanguageArtifact(entry.target);
    if (baseline.id === target.id) throw new Error("基线与改写必须为不同不可变稿件ID。");
    languageObject(entry.authorization, ["id", "at", "kind", "sourceRef"]);
    languageText(entry.authorization.id, 1024);
    languageTime(entry.authorization.at);
    enumeration(entry.authorization.kind, ["explicit-user-selection", "existing-authorized-scope"]);
    languageText(entry.authorization.sourceRef);
    if (Date.parse(entry.authorization.at) > Date.parse(entry.createdAt))
      throw new Error("授权晚于改写检查。");
    list(entry.ranges, 1000);
    if (!entry.ranges.length) throw new Error("缺少实际授权范围。");
    let lastEnd = -1;
    const rangeIds = new Set<string>();
    for (const range of entry.ranges) {
      languageObject(range, ["id", "label", "start", "end", "exactText"]);
      languageText(range.id, 1024);
      languageText(range.label, 1024);
      const span = { start: range.start, end: range.end, exactText: range.exactText };
      assertResearchLanguageSpan(span, baseline.body);
      if (span.end === span.start || span.start < lastEnd || rangeIds.has(range.id))
        throw new Error("选定范围为空、重叠、未排序或ID重复。");
      lastEnd = span.end;
      rangeIds.add(range.id);
    }
    list(entry.frozenAnchors, 5000);
    const frozenIds = new Set<string>();
    for (const anchor of entry.frozenAnchors) {
      languageObject(anchor, ["id", "kind", "start", "end", "exactText"]);
      languageText(anchor.id, 1024);
      enumeration(anchor.kind, [
        "number",
        "symbol",
        "unit",
        "variable",
        "term",
        "citation",
        "ai-disclosure",
      ]);
      assertResearchLanguageSpan(
        { start: anchor.start, end: anchor.end, exactText: anchor.exactText },
        baseline.body,
      );
      if (anchor.start === anchor.end || frozenIds.has(anchor.id))
        throw new Error("冻结锚点为空或重复。");
      frozenIds.add(anchor.id);
    }
    const program = entry.programReport;
    languageObject(program, [
      "programVersion",
      "at",
      "baselineSha256",
      "targetSha256",
      "sha256",
      "changes",
      "units",
      "hardIssues",
      "semanticCandidates",
      "boundary",
    ]);
    enumeration(program.programVersion, ["language-revisions-1", "language-revisions-2"]);
    languageTime(program.at);
    hash(program.sha256);
    languageText(program.boundary);
    if (
      program.baselineSha256 !== baseline.bodySha256 ||
      program.targetSha256 !== target.bodySha256
    )
      throw new Error("程序检查与双稿版本不符。");
    const unitIds = new Set<string>();
    for (const key of ["changes", "units", "hardIssues", "semanticCandidates"] as const) {
      list(program[key], 20000);
      const localIds = new Set<string>();
      for (const row of program[key]) {
        languageObject(row, [
          "id",
          "baseline",
          "target",
          ...(key === "units"
            ? ["rangeId"]
            : key === "hardIssues"
              ? ["category", "reason"]
              : key === "semanticCandidates"
                ? ["category", "reason", "unitId"]
                : []),
        ]);
        languageText(row.id, 1024);
        if (localIds.has(row.id)) throw new Error("程序定位ID重复。");
        localIds.add(row.id);
        assertResearchLanguageSpan(row.baseline, baseline.body);
        assertResearchLanguageSpan(row.target, target.body);
        if (key === "units") {
          if (!rangeIds.has(String(row.rangeId))) throw new Error("复核段落无授权范围。");
          unitIds.add(row.id);
        }
        if (key === "hardIssues" || key === "semanticCandidates") {
          enumeration(
            row.category,
            key === "hardIssues"
              ? [
                  "unselected-body",
                  "diff-limit",
                  "number",
                  "symbol",
                  "unit",
                  "citation",
                  "frozen-number",
                  "frozen-symbol",
                  "frozen-unit",
                  "frozen-variable",
                  "frozen-term",
                  "frozen-citation",
                  "frozen-ai-disclosure",
                ]
              : ["negation", "causality", "uncertainty", "sample-scope", "claim-strength"],
          );
          languageText(row.reason);
        }
        if (key === "semanticCandidates" && !unitIds.has(String(row.unitId)))
          throw new Error("风险候选无具体段落。");
      }
    }
    list(entry.semanticReviews, 10000);
    const reviewIds = new Set<string>();
    for (const review of entry.semanticReviews) {
      languageObject(review, [
        "revisionId",
        "classification",
        "reason",
        "coverage",
        "id",
        "at",
        "actor",
        "evidenceRef",
        "readIds",
        "baselineSha256",
        "targetSha256",
        "programReportSha256",
        "actualReads",
        "judgment",
      ]);
      decodeResearchLanguageSemanticReviewRequest({
        revisionId: review.revisionId,
        classification: review.classification,
        reason: review.reason,
        coverage: review.coverage,
      });
      const host = decodeResearchLanguageReviewHost({
        id: review.id,
        at: review.at,
        actor: review.actor,
        evidenceRef: review.evidenceRef,
        readIds: review.readIds,
      });
      if (reviewIds.has(host.id)) throw new Error("复核ID重复。");
      reviewIds.add(host.id);
      if (
        review.revisionId !== entry.id ||
        review.baselineSha256 !== baseline.bodySha256 ||
        review.targetSha256 !== target.bodySha256 ||
        review.programReportSha256 !== program.sha256 ||
        review.judgment !== "attributed-semantic-review-not-program-proof" ||
        Date.parse(host.at) < Date.parse(String(program.at))
      )
        throw new Error("语义复核不是当前双稿检查版本。");
      for (const coverage of review.coverage as ResearchLanguageReviewCoverage[]) {
        const unit = (program.units as unknown as ResearchLanguageReviewUnit[]).find(
          (row) => row.id === coverage.unitId,
        );
        if (
          !unit ||
          ["baseline", "target"].some((side) => {
            const key = side as "baseline" | "target";
            return (
              coverage[key].start !== unit[key].start ||
              coverage[key].end !== unit[key].end ||
              coverage[key].exactText !== unit[key].exactText
            );
          })
        )
          throw new Error("复核须覆盖实际完整变化段落。");
      }
      list(review.actualReads);
      const reads = review.actualReads.map(decodeResearchLanguageActualRead);
      if (
        reads.length !== host.readIds.length ||
        new Set(reads.map((read) => read.id)).size !== reads.length ||
        reads.some(
          (read) =>
            !host.readIds.includes(read.id) ||
            researchLanguageActorKey(read.actor) !== researchLanguageActorKey(host.actor) ||
            Date.parse(read.at) > Date.parse(host.at),
        )
      )
        throw new Error("复核读取身份、顺序或引用无效。");
      for (const read of reads) {
        const artifact = [baseline, target].find((row) => row.id === read.artifactId);
        if (!artifact || read.bodySha256 !== artifact.bodySha256)
          throw new Error("读取凭据稿件版本无效。");
        assertResearchLanguageSpan(
          { start: read.start, end: read.end, exactText: read.exactText },
          artifact.body,
        );
      }
      for (const coverage of review.coverage as ResearchLanguageReviewCoverage[])
        for (const side of ["baseline", "target"] as const) {
          const artifact = side === "baseline" ? baseline : target;
          if (
            !researchLanguageRangesCover(
              reads.filter((read) => read.artifactId === artifact.id),
              coverage[side].start,
              coverage[side].end,
            )
          )
            throw new Error("语义复核没有实际双稿段落读取覆盖。");
        }
    }
    if (entry.skip !== undefined) {
      const skip = entry.skip;
      languageObject(skip, [
        "id",
        "at",
        "actor",
        "evidenceRef",
        "classification",
        "reason",
        "baselineSha256",
        "targetSha256",
      ]);
      languageText(skip.id, 1024);
      languageTime(skip.at);
      languageText(skip.evidenceRef);
      languageText(skip.reason);
      const actor = decodeResearchLanguageActor(skip.actor);
      enumeration(skip.classification, ["user-skipped", "not-applicable"]);
      if (
        (skip.classification === "user-skipped" && actor.kind !== "user") ||
        skip.baselineSha256 !== baseline.bodySha256 ||
        skip.targetSha256 !== target.bodySha256 ||
        Date.parse(skip.at) < Date.parse(entry.createdAt)
      )
        throw new Error("跳过记录身份或版本无效。");
    }
  }
  return structuredClone(value) as ResearchLanguageRevision[];
}
