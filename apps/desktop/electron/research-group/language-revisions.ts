import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { diffChars } from "diff";
import {
  decodeResearchLanguageActor,
  decodeResearchLanguageActualRead,
  decodeResearchLanguageArtifact,
  decodeResearchLanguageRevisions,
  decodeResearchLanguageReviewHost,
  decodeResearchLanguageSemanticReviewRequest,
  languageObject,
  languageText,
  languageTime,
  researchLanguageActorKey,
  researchLanguageRangesCover as covers,
  type ResearchLanguageActualRead,
  type ResearchLanguageArtifact,
  type ResearchLanguageAuthorization,
  type ResearchLanguageChange,
  type ResearchLanguageFrozenAnchor,
  type ResearchLanguageIssue,
  type ResearchLanguageProgramReport,
  type ResearchLanguageRange,
  type ResearchLanguageReviewHost,
  type ResearchLanguageRevision,
  type ResearchLanguageSemanticReviewRequest,
  type ResearchLanguageSkip,
  type ResearchLanguageSpan,
} from "../../contracts/research-language-revisions";

/** CYZ's anchor-count/order concept is a reference, not a port of its CC BY-NC script.
 * Its own correlation-to-causation example can pass the automatic lock. No full semantic claim here.
 */
export const RESEARCH_LANGUAGE_BOUNDARY =
  "程序仅核对未选正文、显式冻结锚点及已识别表达；否定/因果/样本/强度提示不是完整语义理解。无词法候选的改动仍需具名A/B双稿逐段复核；模型意见不是人类审阅或伦理审批。";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const digest = (value: unknown) => sha(JSON.stringify(canonical(value)));
const span = (body: string, start: number, end: number): ResearchLanguageSpan => ({
  start,
  end,
  exactText: body.slice(start, end),
});
/** Host passes actually obtained text; no path traversal, file writes, native calls or read claims. */
export function createResearchLanguageArtifact(id: string, body: string): ResearchLanguageArtifact {
  return decodeResearchLanguageArtifact({ id, body, bodySha256: sha(body) });
}
interface Segment {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
  changed: boolean;
}
function segments(before: string, after: string): Segment[] | undefined {
  // Deterministic work bound; a large rewrite returns an explicit blocker, never a best-effort pass.
  const parts = diffChars(before, after, { maxEditLength: 4000 });
  if (!parts) return undefined;
  const result: Segment[] = [];
  let b = 0,
    a = 0;
  for (const part of parts) {
    const changed = !!(part.added || part.removed),
      length = part.value.length;
    const next = {
      beforeStart: b,
      beforeEnd: b + (part.added ? 0 : length),
      afterStart: a,
      afterEnd: a + (part.removed ? 0 : length),
      changed,
    };
    const previous = result.at(-1);
    if (changed && previous?.changed) {
      previous.beforeEnd = next.beforeEnd;
      previous.afterEnd = next.afterEnd;
    } else result.push(next);
    b = next.beforeEnd;
    a = next.afterEnd;
  }
  return result;
}
function mapped(steps: Segment[], position: number, side: "left" | "right") {
  const values = steps
    .filter((step) => position >= step.beforeStart && position <= step.beforeEnd)
    .flatMap((step) =>
      step.changed
        ? [step.afterStart, step.afterEnd]
        : [step.afterStart + position - step.beforeStart],
    );
  return values.length ? (side === "left" ? Math.min(...values) : Math.max(...values)) : 0;
}
const scalar = "[-+−]?(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const recognizedAnchors: [string, RegExp][] = [
  ["number", new RegExp(`(?<![\\p{L}\\p{N}_.])${scalar}(?:%|‰)?`, "gu")],
  ["symbol", /[+−±=<>≤≥×÷]/gu],
  [
    "unit",
    new RegExp(
      `${scalar}\\s*(?:kg|mg|μg|cm|mm|km|ms|mL|Hz|kHz|MHz|g|m|s|h|L|%|‰|名|人|例|班|所|次|分|秒|分钟|小时|天|周|月|年)(?![A-Za-z])`,
      "gu",
    ),
  ],
  [
    "citation",
    /https?:\/\/[^\s<>，。；]+|\b10\.\d{4,9}\/[^\s<>，。；]+|\[\d+(?:\s*[-–—,，;；]\s*\d+)*\]|[（(][^（）()\n]{0,100}(?:19|20)\d{2}[a-z]?[^（）()\n]{0,60}[）)]/giu,
  ],
];
const semanticHints: [string, RegExp][] = [
  [
    "negation",
    /未(?:发现|观察到|显示|支持|证明)?|不是|不代表|不能|不可|没有|并非|无显著|不显著|\b(?:not|never|no|without)\b/giu,
  ],
  [
    "causality",
    /相关|关联|有关|导致|造成|促进|因果|引起|使得|\b(?:correlat\w*|associat\w*|caus\w*|leads? to|results? in)\b/giu,
  ],
  [
    "uncertainty",
    /可能|或许|也许|似乎|提示|尚不|尚未|不确定|不能确定|\b(?:may|might|could|possibly|uncertain\w*|suggest\w*)\b/giu,
  ],
  [
    "sample-scope",
    /本研究样本|本样本|样本(?:中|内)?|所有(?:学生|人|学校)|全部|全国|普遍|对象仅为|不代表|仅在|仅限|\b(?:sample|participants?|all students|every|population|nationwide)\b/giu,
  ],
  [
    "claim-strength",
    /显著|充分证实|证实|证明|必然|确定|一致|有效|提高|增强|\b(?:significant\w*|prove\w*|definit\w*|certain\w*|effective\w*)\b/giu,
  ],
];
function tokens(body: string, part: ResearchLanguageSpan, expression: RegExp) {
  return [...part.exactText.matchAll(new RegExp(expression.source, expression.flags))].map(
    (match) => span(body, part.start + match.index, part.start + match.index + match[0].length),
  );
}
function differences(
  before: ResearchLanguageSpan[],
  after: ResearchLanguageSpan[],
  fallback: ResearchLanguageChange,
) {
  const result: { baseline: ResearchLanguageSpan; target: ResearchLanguageSpan }[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++)
    if (before[i]?.exactText !== after[i]?.exactText)
      result.push({
        baseline: before[i] ?? {
          start: fallback.baseline.end,
          end: fallback.baseline.end,
          exactText: "",
        },
        target: after[i] ?? { start: fallback.target.end, end: fallback.target.end, exactText: "" },
      });
  return result;
}
function derive(
  input: Pick<
    ResearchLanguageRevision,
    "baseline" | "target" | "ranges" | "frozenAnchors" | "createdAt"
  >,
  programVersion: ResearchLanguageProgramReport["programVersion"] = "language-revisions-2",
): ResearchLanguageProgramReport {
  const { baseline, target } = input,
    steps = segments(baseline.body, target.body);
  const report: Omit<ResearchLanguageProgramReport, "sha256"> = {
    programVersion,
    at: input.createdAt,
    baselineSha256: baseline.bodySha256,
    targetSha256: target.bodySha256,
    changes: [],
    units: [],
    hardIssues: [],
    semanticCandidates: [],
    boundary: RESEARCH_LANGUAGE_BOUNDARY,
  };
  const issue = (
    category: string,
    reason: string,
    before: ResearchLanguageSpan,
    after: ResearchLanguageSpan,
  ) => ({
    id: `issue:${digest([category, before, after])}`,
    category,
    reason,
    baseline: before,
    target: after,
  });
  if (!steps)
    report.hardIssues.push(
      issue(
        "diff-limit",
        "改写超过确定性差异工作上限；请拆分已授权章节，不能视为已检查。",
        span(baseline.body, 0, baseline.body.length),
        span(target.body, 0, target.body.length),
      ),
    );
  else {
    report.changes = steps
      .filter((step) => step.changed)
      .map((step) => ({
        id: `change:${digest(step)}`,
        baseline: span(baseline.body, step.beforeStart, step.beforeEnd),
        target: span(target.body, step.afterStart, step.afterEnd),
      }));
    for (const change of report.changes)
      if (!covers(input.ranges, change.baseline.start, change.baseline.end))
        report.hardIssues.push(
          issue(
            "unselected-body",
            "实际改动超出宿主授权范围；未选正文必须逐字保持。",
            change.baseline,
            change.target,
          ),
        );
    const gaps: { start: number; end: number }[] = [];
    let previous = 0;
    for (const range of input.ranges) {
      if (previous < range.start) gaps.push({ start: previous, end: range.start });
      previous = range.end;
    }
    if (previous < baseline.body.length) gaps.push({ start: previous, end: baseline.body.length });
    for (const gap of gaps) {
      const before = span(baseline.body, gap.start, gap.end),
        after = span(
          target.body,
          mapped(steps, gap.start, "right"),
          mapped(steps, gap.end, "left"),
        );
      if (before.exactText !== after.exactText)
        report.hardIssues.push(
          issue("unselected-body", "未选正文间隙与基线不一致。", before, after),
        );
    }
    for (const anchor of input.frozenAnchors) {
      const touched = report.changes.some((change) =>
        change.baseline.start === change.baseline.end
          ? change.baseline.start > anchor.start && change.baseline.start < anchor.end
          : change.baseline.start < anchor.end && change.baseline.end > anchor.start,
      );
      const after = span(
        target.body,
        mapped(steps, anchor.start, touched ? "left" : "right"),
        mapped(steps, anchor.end, touched ? "right" : "left"),
      );
      if (touched || after.exactText !== anchor.exactText)
        report.hardIssues.push(
          issue(
            `frozen-${anchor.kind}`,
            `宿主固定的${anchor.kind}锚点 ${anchor.id} 被改变；语义复核不能豁免。`,
            span(baseline.body, anchor.start, anchor.end),
            after,
          ),
        );
    }
    for (const range of input.ranges) {
      const endpoints = [...range.exactText.matchAll(/\n[ \t]*\n/g)].map(
        (match) => range.start + match.index + match[0].length,
      );
      if (endpoints.at(-1) !== range.end) endpoints.push(range.end);
      let start = range.start;
      for (const end of endpoints) {
        if (
          report.changes.some((change) =>
            change.baseline.start === change.baseline.end
              ? change.baseline.start >= start && change.baseline.start <= end
              : change.baseline.start < end && change.baseline.end > start,
          )
        ) {
          const before = span(baseline.body, start, end),
            after = span(target.body, mapped(steps, start, "left"), mapped(steps, end, "right"));
          report.units.push({
            id: `paragraph:${digest([range.id, before, after])}`,
            rangeId: range.id,
            baseline: before,
            target: after,
          });
        }
        start = end;
      }
    }
    for (const unit of report.units) {
      for (const [category, expression] of recognizedAnchors)
        for (const delta of differences(
          tokens(baseline.body, unit.baseline, expression),
          tokens(target.body, unit.target, expression),
          unit,
        ))
          report.hardIssues.push(
            issue(
              category,
              `已识别${category}表达的值、数量或顺序变化；不属于自动允许的纯语言修改。`,
              delta.baseline,
              delta.target,
            ),
          );
      for (const [category, currentExpression] of semanticHints) {
        // Historical v1 reports retain their exact algorithm and digest; new checks use v2.
        const expression =
          programVersion !== "language-revisions-1"
            ? currentExpression
            : category === "negation"
              ? /未(?:发现|观察到|显示|支持|证明)?|不能|不可|没有|并非|无显著|不显著|\b(?:not|never|no|without)\b/giu
              : category === "sample-scope"
                ? /本研究样本|本样本|样本(?:中|内)?|所有(?:学生|人|学校)|全部|全国|普遍|仅在|仅限|\b(?:sample|participants?|all students|every|population|nationwide)\b/giu
                : currentExpression;
        for (const delta of differences(
          tokens(baseline.body, unit.baseline, expression),
          tokens(target.body, unit.target, expression),
          unit,
        ))
          report.semanticCandidates.push({
            ...issue(
              category,
              "词法线索变化，需具名双稿段落复核；不是程序已判定语义改变。",
              delta.baseline,
              delta.target,
            ),
            unitId: unit.id,
          });
      }
    }
  }
  report.hardIssues = [...new Map(report.hardIssues.map((row) => [row.id, row])).values()];
  return { ...report, sha256: digest(report) };
}
function intact(value: ResearchLanguageRevision) {
  const revision = decodeResearchLanguageRevisions([value])[0]!;
  for (const artifact of [revision.baseline, revision.target])
    if (sha(artifact.body) !== artifact.bodySha256) throw new Error("实际正文SHA与固定稿件不符。");
  if (
    !isDeepStrictEqual(
      derive(revision, revision.programReport.programVersion),
      revision.programReport,
    )
  )
    throw new Error("程序检查内容、位置或摘要已变化。");
  for (const review of revision.semanticReviews)
    assertReadCoverage(revision, review.coverage, review.actualReads);
  return revision;
}
function assertCurrent(
  revision: ResearchLanguageRevision,
  artifacts: readonly ResearchLanguageArtifact[],
) {
  for (const expected of [revision.baseline, revision.target]) {
    const actual = artifacts.find((artifact) => artifact.id === expected.id);
    if (
      !actual ||
      actual.bodySha256 !== expected.bodySha256 ||
      sha(actual.body) !== expected.bodySha256 ||
      actual.body !== expected.body
    )
      throw new Error("当前基线或改写稿版本已变化；需新建修订并重新检查/复核。");
  }
}
export function createResearchLanguageRevision(
  input: {
    id: string;
    baseline: ResearchLanguageArtifact;
    target: ResearchLanguageArtifact;
    ranges: ResearchLanguageRange[];
  },
  host: {
    at: string;
    authorization: ResearchLanguageAuthorization;
    frozenAnchors?: ResearchLanguageFrozenAnchor[];
  },
): ResearchLanguageRevision {
  languageObject(input, ["id", "baseline", "target", "ranges"]);
  languageObject(host, ["at", "authorization", "frozenAnchors"]);
  languageText(input.id, 1024);
  languageTime(host.at);
  const body = {
    id: input.id,
    createdAt: host.at,
    baseline: decodeResearchLanguageArtifact(input.baseline),
    target: decodeResearchLanguageArtifact(input.target),
    authorization: structuredClone(host.authorization),
    ranges: structuredClone(input.ranges),
    frozenAnchors: structuredClone(host.frozenAnchors ?? []),
  };
  const revision = { ...body, programReport: derive(body), semanticReviews: [] };
  return intact(revision);
}
export function checkResearchLanguageRevision(
  revision: ResearchLanguageRevision,
  currentArtifacts: readonly ResearchLanguageArtifact[],
) {
  const current = intact(revision);
  assertCurrent(current, currentArtifacts);
  return current.programReport;
}
function assertReadCoverage(
  revision: ResearchLanguageRevision,
  coverage: ResearchLanguageSemanticReviewRequest["coverage"],
  reads: ResearchLanguageActualRead[],
) {
  for (const item of coverage)
    for (const side of ["baseline", "target"] as const) {
      const artifact = revision[side],
        covered = reads.filter(
          (read) => read.artifactId === artifact.id && read.bodySha256 === artifact.bodySha256,
        );
      if (!covers(covered, item[side].start, item[side].end))
        throw new Error("复核缺少本人实际双稿完整段落读取覆盖。");
    }
}
export function recordResearchLanguageSemanticReview(
  value: ResearchLanguageRevision,
  raw: ResearchLanguageSemanticReviewRequest,
  actualHost: ResearchLanguageReviewHost,
  context: {
    artifacts: readonly ResearchLanguageArtifact[];
    reads: readonly ResearchLanguageActualRead[];
  },
): ResearchLanguageRevision {
  const revision = intact(value),
    request = decodeResearchLanguageSemanticReviewRequest(raw),
    host = decodeResearchLanguageReviewHost(actualHost);
  assertCurrent(revision, context.artifacts);
  if (request.revisionId !== revision.id) throw new Error("语义复核修订ID不符。");
  const actualReads = host.readIds.map((id) => {
    const read = context.reads.find((item) => item.id === id);
    if (!read) throw new Error("实际读取凭据不存在。");
    return decodeResearchLanguageActualRead(read);
  });
  if (
    actualReads.some(
      (read) =>
        researchLanguageActorKey(read.actor) !== researchLanguageActorKey(host.actor) ||
        Date.parse(read.at) > Date.parse(host.at),
    )
  )
    throw new Error("不能借他人或未来读取凭据。");
  assertReadCoverage(revision, request.coverage, actualReads);
  const review = {
    ...request,
    ...host,
    baselineSha256: revision.baseline.bodySha256,
    targetSha256: revision.target.bodySha256,
    programReportSha256: revision.programReport.sha256,
    actualReads,
    judgment: "attributed-semantic-review-not-program-proof" as const,
  };
  const prior = revision.semanticReviews.find((item) => item.id === review.id);
  if (prior) {
    if (!isDeepStrictEqual(prior, review)) throw new Error("同一实际复核ID不能改变内容。");
    return revision;
  }
  revision.semanticReviews.push(review);
  return intact(revision);
}
export function recordResearchLanguageSkip(
  value: ResearchLanguageRevision,
  input: Pick<ResearchLanguageSkip, "classification" | "reason">,
  host: Omit<ResearchLanguageReviewHost, "readIds">,
): ResearchLanguageRevision {
  const revision = intact(value);
  languageObject(input, ["classification", "reason"]);
  languageObject(host, ["id", "at", "actor", "evidenceRef"]);
  languageText(input.reason);
  languageText(host.id, 1024);
  languageTime(host.at);
  languageText(host.evidenceRef);
  decodeResearchLanguageActor(host.actor);
  const skip = {
    ...host,
    ...input,
    baselineSha256: revision.baseline.bodySha256,
    targetSha256: revision.target.bodySha256,
  };
  if (revision.skip && !isDeepStrictEqual(revision.skip, skip))
    throw new Error("实际跳过记录不能被覆盖。");
  revision.skip = skip;
  return intact(revision);
}
export function reportResearchLanguageRevision(
  value: ResearchLanguageRevision,
  currentArtifacts: readonly ResearchLanguageArtifact[],
) {
  const revision = intact(value);
  let current = true;
  try {
    assertCurrent(revision, currentArtifacts);
  } catch {
    current = false;
  }
  const requiresContentReview = revision.semanticReviews.some(
    (review) => review.classification === "substantive-change",
  );
  const pending = revision.programReport.units.flatMap((unit) =>
    (["lead", "reviewer"] as const)
      .filter((role) => {
        const latest = revision.semanticReviews
          .filter(
            (review) =>
              review.actor.kind === "model" &&
              review.actor.role === role &&
              review.coverage.some((item) => item.unitId === unit.id),
          )
          .at(-1);
        return latest?.classification !== "meaning-preserved";
      })
      .map((role) => ({ unitId: unit.id, role })),
  );
  const status = !current
    ? "stale"
    : revision.programReport.hardIssues.length
      ? "blocked"
      : requiresContentReview
        ? "content-review-required"
        : revision.skip
          ? "skipped"
          : pending.length
            ? "needs-review"
            : !revision.programReport.changes.length
              ? "unchanged"
              : "reviewed-meaning-preserved";
  return {
    status,
    current,
    automaticSemanticProof: false as const,
    requiresContentReview,
    pending,
    hardIssues: revision.programReport.hardIssues,
    semanticCandidates: revision.programReport.semanticCandidates,
    skip: revision.skip,
    downstream: {
      targetArtifactId: revision.target.id,
      targetSha256: revision.target.bodySha256,
      claimsAndNumericBindings: "must-reference-current-artifact" as const,
      contentReviewRequired: requiresContentReview,
      rerunAnalysis: false as const,
    },
    boundary: RESEARCH_LANGUAGE_BOUNDARY,
  };
}
