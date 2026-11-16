import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ResearchAnalysisRegistry } from "../../contracts/research-analysis-registry";
import {
  decodeResearchClaimActualRead,
  decodeResearchClaimRequest,
  decodeResearchClaimReviewHost,
  decodeResearchClaimReviewRequest,
  decodeResearchClaims,
  type ResearchClaim,
  type ResearchClaimActualRead,
  type ResearchClaimArtifactSnapshot,
  type ResearchClaimDepth,
  type ResearchClaimEvidence,
  type ResearchClaimRequest,
  type ResearchClaimReview,
  type ResearchClaimReviewHost,
  type ResearchClaimReviewRequest,
  type ResearchClaims,
  type ResearchClaimSourceSnapshot,
} from "../../contracts/research-claims";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));
const depths: Record<ResearchClaimDepth, number> = {
  metadata: 0,
  abstract: 1,
  "partial-text": 2,
  "full-text": 3,
};
export const RESEARCH_CLAIM_REVIEW_BOUNDARY =
  "程序仅核对已登记主张的版本、定位、实际读取和计算依赖。支持结论属于有出处的模型语义审阅，不是程序证明或人类专家确认；不自动发现所有关键主张，也不判断自然语言含义。";
/** Trusted snapshots/receipts only. Never build this context by spreading model tool arguments. */
export interface ResearchClaimContext {
  artifacts: ResearchClaimArtifactSnapshot[];
  sources: ResearchClaimSourceSnapshot[];
  structuredActualReads: ResearchClaimActualRead[];
  registry: ResearchAnalysisRegistry;
  currentDatasets: { id: string; sha256: string }[];
}
export interface ResearchClaimIssue {
  claimId?: string;
  artifactId: string;
  start?: number;
  end?: number;
  exactText?: string;
  code: string;
  detail: string;
  evidenceIndex?: number;
  reviewId?: string;
}
export function createResearchClaimArtifactSnapshot(
  id: string,
  body: string,
): ResearchClaimArtifactSnapshot {
  if (!id.trim() || !body || body.length > 5_000_000)
    throw new Error("主张需要有界的不可变正文快照。");
  return { id, body, bodySha256: sha(body) };
}
export function createResearchClaims(): ResearchClaims {
  return { version: 1, claims: [], reviews: [] };
}
function boundary(body: string, offset: number) {
  return (
    offset >= 0 &&
    offset <= body.length &&
    !(
      offset > 0 &&
      offset < body.length &&
      /[\uD800-\uDBFF]/.test(body[offset - 1]!) &&
      /[\uDC00-\uDFFF]/.test(body[offset]!)
    )
  );
}
function artifactFor(context: ResearchClaimContext, id: string) {
  const matches = context.artifacts.filter((item) => item.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}
function sourceFor(context: ResearchClaimContext, id: string) {
  const matches = context.sources.filter((item) => item.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}
function field(result: unknown, path: string[]): unknown {
  let current = result;
  for (const key of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function coveringReads(
  context: ResearchClaimContext,
  evidence: Extract<ResearchClaimEvidence, { kind: "source" }>,
  sessionId?: string,
  before?: string,
) {
  const source = sourceFor(context, evidence.sourceId);
  const locators = source?.locators.filter((locator) => locator.id === evidence.locatorId) ?? [];
  const locator = locators.length === 1 ? locators[0] : undefined;
  if (!source || !locator) return [];
  const candidates = context.structuredActualReads.filter((raw) => {
    let read: ResearchClaimActualRead;
    try {
      read = decodeResearchClaimActualRead(raw);
    } catch {
      return false;
    }
    return (
      context.structuredActualReads.filter((r) => r.id === read.id).length === 1 &&
      read.sourceId === evidence.sourceId &&
      read.sourceSha256 === evidence.sourceSha256 &&
      read.bodySha256 === evidence.bodySha256 &&
      read.locatorId === evidence.locatorId &&
      (!sessionId || read.sessionId === sessionId) &&
      (!before || Date.parse(read.at) <= Date.parse(before)) &&
      read.start >= locator.start &&
      read.end <= locator.end &&
      boundary(source.body, read.start) &&
      boundary(source.body, read.end) &&
      read.start < evidence.end &&
      read.end > evidence.start &&
      depths[read.depth] >= depths[evidence.requiredDepth] &&
      depths[read.depth] <= depths[locator.depth]
    );
  });
  // A long source is delivered in pages. Union only one person's matching receipts,
  // keeping the exact pages used so a missing page or borrowed read cannot pass later.
  for (const reader of new Set(candidates.map((read) => read.sessionId))) {
    let end = evidence.start;
    const used: ResearchClaimActualRead[] = [];
    for (const read of candidates
      .filter((entry) => entry.sessionId === reader)
      .sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id))) {
      if (read.start > end) break;
      if (read.end <= end) continue;
      used.push(read);
      end = read.end;
      if (end >= evidence.end) return used;
    }
  }
  return [];
}
function inspectEvidence(
  context: ResearchClaimContext,
  claim: ResearchClaim,
): ResearchClaimIssue[] {
  const issues: ResearchClaimIssue[] = [];
  const fail = (code: string, detail: string, evidenceIndex?: number) =>
    issues.push({
      claimId: claim.id,
      artifactId: claim.artifactId,
      start: claim.start,
      end: claim.end,
      exactText: claim.exactText,
      code,
      detail,
      ...(evidenceIndex === undefined ? {} : { evidenceIndex }),
    });
  const artifact = artifactFor(context, claim.artifactId);
  if (
    !artifact ||
    sha(artifact.body) !== artifact.bodySha256 ||
    artifact.bodySha256 !== claim.bodySha256
  )
    fail("artifact-stale", "稿件身份或正文 SHA 不符，旧稿支持不能用于新稿。");
  if (
    artifact &&
    (!boundary(artifact.body, claim.start) ||
      !boundary(artifact.body, claim.end) ||
      artifact.body.slice(claim.start, claim.end) !== claim.exactText)
  )
    fail("claim-location-stale", "稿件定位或原句改变，需要重新登记并审阅。");
  if (!claim.evidence.some((e) => e.kind === "result" || e.relation === "support"))
    fail("support-evidence-missing", "没有登记支持依赖；反证本身不自动构成支持。");
  if (claim.category === "research-result" && !claim.evidence.some((e) => e.kind === "result"))
    fail("actual-result-missing", "本研究结果需要实际注册运行及字段，来源论文不能替代本研究实算。");
  claim.evidence.forEach((e, index) => {
    if (e.kind === "source") {
      const source = sourceFor(context, e.sourceId);
      if (
        !source ||
        !source.available ||
        source.sha256 !== e.sourceSha256 ||
        source.bodySha256 !== e.bodySha256 ||
        sha(source.body) !== source.bodySha256
      )
        fail("source-stale", "来源已撤回、缺失或原件/提取文本版本改变。", index);
      const locators = source?.locators.filter((l) => l.id === e.locatorId) ?? [];
      const locator = locators.length === 1 ? locators[0] : undefined;
      if (
        !source ||
        !locator ||
        e.start < locator.start ||
        e.end > locator.end ||
        !boundary(source.body, e.start) ||
        !boundary(source.body, e.end) ||
        source.body.slice(e.start, e.end) !== e.exactText ||
        !e.exactText.trim()
      )
        fail("source-location-stale", "来源定位不存在、不可用或精确片段已改变。", index);
      if (locator && depths[locator.depth] < depths[e.requiredDepth])
        fail(
          "reading-depth-insufficient",
          "题录、摘要或部分正文不能冒充更深层级的原文核验。",
          index,
        );
      if (!coveringReads(context, e).length)
        fail("actual-read-missing", "没有覆盖此版本、定位及要求深度的宿主实际读取凭据。", index);
    } else {
      const runs = context.registry.runs.filter((run) => run.id === e.runId),
        run = runs[0];
      if (runs.length !== 1 || !run) {
        fail("run-missing", "没有唯一的实际登记运行。", index);
        return;
      }
      const { runSha256, ...contents } = run;
      if (
        runSha256 !== e.runSha256 ||
        digest(contents) !== runSha256 ||
        digest(run.result) !== run.resultSha256
      )
        fail("run-stale", "运行或结果 SHA 改变，旧支持需要重审。", index);
      const plans = context.registry.plans.filter((plan) => plan.id === run.planId);
      const plan = plans.find((p) => p.version === run.planVersion);
      if (
        !plan ||
        plans.some((p) => p.version > run.planVersion) ||
        digest(plan) !== run.replay.planSha256
      )
        fail("plan-stale", "运行的分析计划已变化或有新版本。", index);
      const datasets = context.currentDatasets.filter((d) => d.id === run.datasetId);
      if (
        datasets.length !== 1 ||
        datasets[0]!.sha256 !== run.datasetSha256 ||
        plan?.dataset.id !== run.datasetId ||
        plan.dataset.sha256 !== run.datasetSha256
      )
        fail("dataset-stale", "实际数据版本与运行/计划不符。", index);
      const value = field(run.result, e.path);
      if (
        value === undefined ||
        value === null ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        fail("result-field-missing", "指定计算字段不存在或没有可用结果；不把缺失当成零。", index);
    }
  });
  return issues;
}
/** Registration preserves even unresolved evidence as a locatable pending claim. */
export function registerResearchClaim(
  raw: ResearchClaims,
  context: ResearchClaimContext,
  input: ResearchClaimRequest,
): ResearchClaims {
  const ledger = decodeResearchClaims(raw),
    request = decodeResearchClaimRequest(input);
  const artifact = artifactFor(context, request.artifactId);
  if (
    !artifact ||
    sha(artifact.body) !== artifact.bodySha256 ||
    !boundary(artifact.body, request.start) ||
    !boundary(artifact.body, request.end)
  )
    throw new Error("不能登记不明确或已改变的稿件版本/位置。");
  const evidence: ResearchClaimEvidence[] = request.evidence.map((e) => {
    if (e.kind === "source") {
      const source = sourceFor(context, e.sourceId);
      if (!source || sha(source.body) !== source.bodySha256)
        throw new Error("依赖来源缺少唯一宿主正文快照。");
      return {
        ...e,
        sourceSha256: source.sha256,
        bodySha256: source.bodySha256,
        exactText: source.body.slice(e.start, e.end),
      };
    }
    const runs = context.registry.runs.filter((run) => run.id === e.runId);
    if (runs.length !== 1) throw new Error("依赖计算缺少唯一实际运行。");
    return { ...e, runSha256: runs[0]!.runSha256 };
  });
  const claim: ResearchClaim = {
    ...request,
    bodySha256: artifact.bodySha256,
    exactText: artifact.body.slice(request.start, request.end),
    evidence,
  };
  const old = ledger.claims.find((c) => c.id === claim.id);
  if (old && !isDeepStrictEqual(old, claim))
    throw new Error("主张身份不可改写；新稿或新依赖使用新身份。");
  if (!old) ledger.claims.push(claim);
  return decodeResearchClaims(ledger);
}
/** Semantic judgments are retained even when evidence is insufficient; they cannot remove deterministic blockers. */
export function recordResearchClaimReview(
  raw: ResearchClaims,
  context: ResearchClaimContext,
  input: ResearchClaimReviewRequest,
  identity: ResearchClaimReviewHost,
): ResearchClaims {
  const ledger = decodeResearchClaims(raw),
    request = decodeResearchClaimReviewRequest(input),
    host = decodeResearchClaimReviewHost(identity);
  const claim = ledger.claims.find((c) => c.id === request.claimId);
  if (!claim) throw new Error("待审主张不存在。");
  if (ledger.reviews.some((r) => r.claimId === claim.id && Date.parse(r.at) > Date.parse(host.at)))
    throw new Error("不能倒填主张审阅时间。");
  const actualReads = [
    ...new Map(
      claim.evidence
        .flatMap((e) =>
          e.kind === "source" ? coveringReads(context, e, host.actor.sessionId, host.at) : [],
        )
        .map((read) => [read.id, read]),
    ).values(),
  ];
  const review: ResearchClaimReview = {
    ...request,
    ...host,
    claimSha256: digest(claim),
    actualReads,
    judgment: "model-semantic-review",
  };
  const old = ledger.reviews.find((r) => r.id === host.id);
  if (old && !isDeepStrictEqual(old, review)) throw new Error("审阅身份不可改写。");
  if (!old) ledger.reviews.push(review);
  return decodeResearchClaims(ledger);
}
function inspectReview(
  context: ResearchClaimContext,
  claim: ResearchClaim,
  review: ResearchClaimReview,
): ResearchClaimIssue[] {
  const issue = (code: string, detail: string): ResearchClaimIssue => ({
    claimId: claim.id,
    artifactId: claim.artifactId,
    start: claim.start,
    end: claim.end,
    exactText: claim.exactText,
    reviewId: review.id,
    code,
    detail,
  });
  const problems: ResearchClaimIssue[] = [];
  if (review.claimSha256 !== digest(claim))
    problems.push(issue("review-stale", "审阅对应的不可变主张内容/依赖已改变。"));
  for (const e of claim.evidence.filter((item) => item.kind === "source")) {
    const reads = coveringReads(context, e, review.actor.sessionId, review.at);
    if (
      !reads.length ||
      !reads.every((read) =>
        review.actualReads.some((recorded) => isDeepStrictEqual(recorded, read)),
      )
    )
      problems.push(
        issue("review-read-missing", "该审阅者在裁定前没有覆盖所引范围的有效实际读取凭据。"),
      );
  }
  return problems;
}
/** One explicit manuscript version, never 'latest by label'. Historical claims remain in the ledger. */
export function validateResearchClaims(
  context: ResearchClaimContext,
  raw: ResearchClaims,
  artifactId: string,
) {
  const ledger = decodeResearchClaims(raw),
    artifact = artifactFor(context, artifactId);
  const blockers: ResearchClaimIssue[] = [];
  if (!artifact || sha(artifact.body) !== artifact.bodySha256)
    blockers.push({ artifactId, code: "artifact-stale", detail: "所审稿件不是唯一完整宿主快照。" });
  const claims = ledger.claims.filter((claim) => claim.artifactId === artifactId);
  if (!claims.length)
    blockers.push({
      artifactId,
      code: "claims-missing",
      detail: "本版本尚无主张登记；旧稿审阅不能放行新稿。",
    });
  const checks = claims.map((claim) => {
    const issues = inspectEvidence(context, claim);
    const issue = (code: string, detail: string) =>
      issues.push({
        claimId: claim.id,
        artifactId,
        start: claim.start,
        end: claim.end,
        exactText: claim.exactText,
        code,
        detail,
      });
    const reviews = ledger.reviews.filter((r) => r.claimId === claim.id);
    const reviewer = reviews.filter((r) => r.actor.role === "reviewer").at(-1);
    const mentor = reviews.filter((r) => r.actor.role === "mentor").at(-1);
    if (!reviewer) issue("review-missing", "尚无 B 对本主张版本的实际审阅记录。");
    if (reviewer) issues.push(...inspectReview(context, claim, reviewer));
    if (mentor) issues.push(...inspectReview(context, claim, mentor));
    let conclusion = reviewer?.conclusion;
    if (mentor && reviewer) {
      if (
        mentor.conclusion !== reviewer.conclusion &&
        (!mentor.resolvesReviewIds.includes(reviewer.id) ||
          Date.parse(mentor.at) < Date.parse(reviewer.at))
      )
        issue("disagreement-unresolved", "导师与 B 结论不同，尚未明确处理当前这条分歧。");
      else conclusion = mentor.conclusion;
    }
    // A mentor's semantic resolution is recorded, not a blanket override of B's open negative finding.
    // A revised claim or a fresh B check must close that finding before formal acceptance.
    for (const review of [reviewer, mentor])
      if (review && review.conclusion !== "supported")
        issue(
          `review-${review.conclusion}`,
          `${review.actor.role === "reviewer" ? "B" : "导师"}当前记录仍为部分支持、不支持或材料不足，仅可输出明确待核验稿。`,
        );
    blockers.push(...issues);
    return {
      claim: structuredClone(claim),
      conclusion,
      reviews: structuredClone(reviews),
      blockers: issues,
      eligible: issues.length === 0,
    };
  });
  return {
    artifactId,
    bodySha256: artifact?.bodySha256,
    checks,
    blockers,
    blocksFormalAcceptance: blockers.length > 0,
    requiresContentReview: true as const,
    boundary: RESEARCH_CLAIM_REVIEW_BOUNDARY,
  };
}
/** Explicit dependency projection, not a semantic detector for whether a new paper is contrary. */
export function projectResearchClaimSourceImpact(
  raw: ResearchClaims,
  change: { sourceId: string; sourceSha256: string; reason: string; additionalClaimIds?: string[] },
) {
  const ledger = decodeResearchClaims(raw);
  if (
    !change.sourceId.trim() ||
    !/^[a-f0-9]{64}$/.test(change.sourceSha256) ||
    !change.reason.trim()
  )
    throw new Error("来源影响需要明确版本与理由。");
  const additional = change.additionalClaimIds ?? [];
  if (
    new Set(additional).size !== additional.length ||
    additional.some((id) => !ledger.claims.some((c) => c.id === id))
  )
    throw new Error("相反证据的显式影响范围含未知或重复主张。");
  const affected = ledger.claims.filter(
    (claim) =>
      additional.includes(claim.id) ||
      claim.evidence.some(
        (e) =>
          e.kind === "source" &&
          e.sourceId === change.sourceId &&
          e.sourceSha256 === change.sourceSha256,
      ),
  );
  const affectedIds = new Set(affected.map((claim) => claim.id));
  return {
    affected: affected.map((claim) => ({
      claimId: claim.id,
      artifactId: claim.artifactId,
      bodySha256: claim.bodySha256,
      start: claim.start,
      end: claim.end,
      exactText: claim.exactText,
      action: "needs-review" as const,
      reason: change.reason,
    })),
    unaffectedClaimIds: ledger.claims
      .filter((claim) => !affectedIds.has(claim.id))
      .map((claim) => claim.id),
    reviewIdsRequiringRecheck: ledger.reviews
      .filter((r) => affectedIds.has(r.claimId))
      .map((r) => r.id),
    boundary:
      "依赖命中或宿主显式提供的语义影响范围；不自动判断新论文的含义。此函数只投影，调用方须持久化采用变更并阻止受影响稿件正式接受。",
  };
}
