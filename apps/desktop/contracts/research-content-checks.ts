import {
  decodeResearchClaimActualRead,
  decodeResearchClaimReviewHost,
  decodeResearchClaimReviewRequest,
  type ResearchClaimReview,
} from "./research-claims";

/** A program check of one immutable target at a particular snapshot, never a research quality approval. */
export interface ResearchContentCheckIssue {
  code: string;
  detail: string;
  bindingId?: string;
  runId?: string;
  fieldPath?: string[];
  claimId?: string;
  reviewId?: string;
  start?: number;
  end?: number;
  exactText?: string;
}
export interface ResearchContentCheckRecord {
  id: string;
  at: string;
  kind: "numeric-acceptance" | "claim-acceptance";
  target: { artifactId: string; bodySha256: string } | null;
  program: { kind: "program"; id: "numeric-acceptance-1" | "claim-acceptance-1" };
  role: "lead" | "reviewer" | "mentor" | "librarian";
  stage: "writing" | "audit";
  issues: ResearchContentCheckIssue[];
  /** Immutable claim pins resolve dependencies in the claims ledger; no source body is copied here. */
  claimChecks?: {
    claimId: string;
    claimSha256: string;
    bodySha256: string;
    start: number;
    end: number;
    reviews: ResearchClaimReview[];
  }[];
  unboundCandidates: {
    artifactId: string;
    bodySha256: string;
    start: number;
    end: number;
    text: string;
    reason: string;
  }[];
  result: "passed-at-snapshot" | "blocked";
  snapshotToken: string;
  boundary: string;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("内容检查记录含无效或未知字段。");
  return value as Record<string, unknown>;
}
const text = (value: unknown, max = 6000) =>
  typeof value === "string" && !!value.trim() && value.length <= max && !value.includes("\0");
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function decodeResearchContentChecks(value: unknown): ResearchContentCheckRecord[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error("内容检查清单无效。");
  const ids = new Set<string>();
  return value.map((raw) => {
    const row = record(raw, [
      "id",
      "at",
      "kind",
      "target",
      "program",
      "role",
      "stage",
      "issues",
      "claimChecks",
      "unboundCandidates",
      "result",
      "snapshotToken",
      "boundary",
    ]);
    const program = record(row.program, ["kind", "id"]);
    if (
      !text(row.id, 512) ||
      ids.has(String(row.id)) ||
      typeof row.at !== "string" ||
      !Number.isFinite(Date.parse(row.at)) ||
      program.kind !== "program" ||
      !(
        (row.kind === "numeric-acceptance" && program.id === "numeric-acceptance-1") ||
        (row.kind === "claim-acceptance" && program.id === "claim-acceptance-1")
      ) ||
      !["lead", "reviewer", "mentor", "librarian"].includes(String(row.role)) ||
      !["writing", "audit"].includes(String(row.stage)) ||
      !Array.isArray(row.issues) ||
      !Array.isArray(row.unboundCandidates) ||
      !["passed-at-snapshot", "blocked"].includes(String(row.result)) ||
      !hash(row.snapshotToken) ||
      !text(row.boundary)
    )
      throw new Error("程序检查身份、目标版本或结果无效。");
    if (row.target !== null) {
      const target = record(row.target, ["artifactId", "bodySha256"]);
      if (!text(target.artifactId, 512) || !hash(target.bodySha256))
        throw new Error("检查目标必须固定真实稿件身份与SHA。");
    }
    for (const item of row.issues as unknown[]) {
      const issue = record(item, [
        "code",
        "detail",
        "bindingId",
        "runId",
        "fieldPath",
        "claimId",
        "reviewId",
        "start",
        "end",
        "exactText",
      ]);
      if (
        !text(issue.code, 100) ||
        !text(issue.detail) ||
        (issue.bindingId !== undefined && !text(issue.bindingId, 512)) ||
        (issue.runId !== undefined && !text(issue.runId, 512)) ||
        (issue.claimId !== undefined && !text(issue.claimId, 512)) ||
        (issue.reviewId !== undefined && !text(issue.reviewId, 512)) ||
        ((issue.start !== undefined || issue.end !== undefined) &&
          (!Number.isSafeInteger(issue.start) ||
            !Number.isSafeInteger(issue.end) ||
            Number(issue.start) < 0 ||
            Number(issue.end) <= Number(issue.start))) ||
        (issue.exactText !== undefined &&
          (!text(issue.exactText, 100_000) ||
            issue.start === undefined ||
            issue.end === undefined ||
            String(issue.exactText).length !== Number(issue.end) - Number(issue.start))) ||
        (issue.fieldPath !== undefined &&
          (!Array.isArray(issue.fieldPath) ||
            !issue.fieldPath.length ||
            issue.fieldPath.some((part: unknown) => !text(part, 300))))
      )
        throw new Error("确定性问题记录无效。");
    }
    if (row.kind === "claim-acceptance") {
      if (!Array.isArray(row.claimChecks) || row.claimChecks.length > 5000)
        throw new Error("主张接受检查需要有界的同稿快照。");
      if (row.result === "passed-at-snapshot" && !row.claimChecks.length)
        throw new Error("主张程序通过记录不能缺少本稿主张与B意见。");
      const claimIds = new Set<string>();
      for (const rawCheck of row.claimChecks) {
        const check = record(rawCheck, [
          "claimId",
          "claimSha256",
          "bodySha256",
          "start",
          "end",
          "reviews",
        ]);
        if (
          !text(check.claimId, 512) ||
          claimIds.has(String(check.claimId)) ||
          !hash(check.claimSha256) ||
          !hash(check.bodySha256) ||
          !Number.isSafeInteger(check.start) ||
          !Number.isSafeInteger(check.end) ||
          Number(check.start) < 0 ||
          Number(check.end) <= Number(check.start) ||
          !Array.isArray(check.reviews) ||
          check.reviews.length > 2
        )
          throw new Error("主张检查需要唯一身份、正文摘要和准确位置。");
        claimIds.add(String(check.claimId));
        for (const rawReview of check.reviews) {
          const review = record(rawReview, [
            "id",
            "at",
            "actor",
            "claimId",
            "conclusion",
            "reason",
            "resolvesReviewIds",
            "claimSha256",
            "actualReads",
            "judgment",
          ]);
          decodeResearchClaimReviewHost({ id: review.id, at: review.at, actor: review.actor });
          decodeResearchClaimReviewRequest({
            claimId: review.claimId,
            conclusion: review.conclusion,
            reason: review.reason,
            resolvesReviewIds: review.resolvesReviewIds,
          });
          if (
            review.claimId !== check.claimId ||
            !hash(review.claimSha256) ||
            review.judgment !== "model-semantic-review" ||
            !Array.isArray(review.actualReads) ||
            review.actualReads.length > 1000
          )
            throw new Error("模型主张意见快照与所核主张不符。");
          review.actualReads.forEach(decodeResearchClaimActualRead);
        }
        const reviews = check.reviews as ResearchClaimReview[];
        if (
          row.result === "passed-at-snapshot" &&
          (row.target === null ||
            check.bodySha256 !== (row.target as { bodySha256: string }).bodySha256 ||
            !reviews.some((review) => review.actor.role === "reviewer") ||
            reviews.some(
              (review) =>
                review.conclusion !== "supported" || review.claimSha256 !== check.claimSha256,
            ))
        )
          throw new Error(
            "主张程序通过记录需要同稿同主张的B支持意见，且不能留有未关闭的模型否定意见。",
          );
      }
    } else if (row.claimChecks !== undefined) throw new Error("数值检查不能混入主张审阅快照。");
    for (const item of row.unboundCandidates as unknown[]) {
      const candidate = record(item, [
        "artifactId",
        "bodySha256",
        "start",
        "end",
        "text",
        "reason",
      ]);
      if (
        !text(candidate.artifactId, 512) ||
        !hash(candidate.bodySha256) ||
        !Number.isSafeInteger(candidate.start) ||
        !Number.isSafeInteger(candidate.end) ||
        Number(candidate.start) < 0 ||
        Number(candidate.end) <= Number(candidate.start) ||
        !text(candidate.text, 1000) ||
        String(candidate.text).length !== Number(candidate.end) - Number(candidate.start) ||
        !text(candidate.reason)
      )
        throw new Error("语义候选必须保留同稿精确范围。");
    }
    if (
      row.result === "passed-at-snapshot" &&
      (row.target === null || row.issues.length || row.unboundCandidates.length)
    )
      throw new Error("有问题或缺少目标的检查不能记录为通过。");
    ids.add(String(row.id));
    return structuredClone(row) as unknown as ResearchContentCheckRecord;
  });
}
