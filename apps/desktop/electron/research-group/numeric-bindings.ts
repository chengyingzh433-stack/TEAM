import { createHash } from "node:crypto";
import type { ResearchAnalysisRegistry } from "../../contracts/research-analysis-registry";
import {
  decodeResearchNumericBindingRequest,
  decodeResearchNumericBindings,
  decodeResearchNumericPath,
  decodeResearchNumericCandidateReviewInput,
  decodeResearchNumericCandidateReviews,
  decodeResearchResultFieldMetadata,
  type ResearchNumericArtifactSnapshot,
  type ResearchNumericBinding,
  type ResearchNumericBindingRequest,
  type ResearchNumericCandidateReview,
  type ResearchNumericCandidateReviewInput,
  type ResearchNumericQuantity,
  type ResearchNumericRounding,
  type ResearchResultFieldMetadata,
} from "../../contracts/research-numeric-bindings";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));
/** All snapshots are supplied by the host from storage/actual bytes, never from model tool arguments. */
export interface ResearchNumericBindingContext {
  artifacts: ResearchNumericArtifactSnapshot[];
  registry: ResearchAnalysisRegistry;
  currentDatasets: { id: string; sha256: string }[];
  fieldMetadata: ResearchResultFieldMetadata[];
  /** Host append-order history. New review supersedes the same snapshot/span's earlier review. */
  candidateReviews?: ResearchNumericCandidateReview[];
}
export interface ResearchNumericBindingIssue {
  bindingId: string;
  code: string;
  detail: string;
}
export const RESEARCH_NUMERIC_REVIEW_BOUNDARY =
  "仅核对明确绑定片段与实际结果的确定性一致性；单位来源保留声明者身份，不自动证明物理含义。未绑定数字、标签与论述含义、遗漏和因果解释仍需人工或模型审阅；数值零错误不等于全文审阅通过。";
export function createResearchNumericArtifactSnapshot(
  id: string,
  body: string,
): ResearchNumericArtifactSnapshot {
  if (!id.trim() || !body || body.length > 5_000_000)
    throw new Error("数值审阅需要明确且有界的正文快照。");
  return { id, body, bodySha256: sha(body) };
}
function field(result: unknown, path: string[]): number | undefined {
  let value = result;
  for (const key of decodeResearchNumericPath(path)) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function boundary(text: string, offset: number): boolean {
  if (offset < 0 || offset > text.length) return false;
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!)
  );
}
/** Exact decimal rounding of Number.toString(), not binary multiplication or an epsilon tolerance. */
export function renderResearchNumericValue(
  value: number,
  decimalPlaces: number,
  rounding: ResearchNumericRounding,
): string {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0 ||
    decimalPlaces > 12 ||
    !["half-away-from-zero", "half-even", "truncate"].includes(rounding)
  )
    throw new Error("无法渲染非有限数值或未支持的精度声明。");
  const negative = value < 0 || Object.is(value, -0);
  const [mantissa, exponent = "0"] = Math.abs(value).toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const coefficient = BigInt(whole! + fraction),
    power = Number(exponent) - fraction.length + decimalPlaces;
  let rounded: bigint;
  if (power >= 0) rounded = coefficient * 10n ** BigInt(power);
  else {
    const denominator = 10n ** BigInt(-power),
      quotient = coefficient / denominator,
      remainder = coefficient % denominator;
    const up =
      rounding !== "truncate" &&
      (remainder * 2n > denominator ||
        (remainder * 2n === denominator &&
          (rounding === "half-away-from-zero" || quotient % 2n === 1n)));
    rounded = quotient + (up ? 1n : 0n);
  }
  const digits = rounded.toString().padStart(decimalPlaces + 1, "0");
  return `${negative ? "-" : ""}${decimalPlaces ? `${digits.slice(0, -decimalPlaces)}.${digits.slice(-decimalPlaces)}` : digits}`;
}
function canonicalQuantity(path: string[]): ResearchNumericQuantity | undefined {
  if (JSON.stringify(path) === JSON.stringify(["regression", "rSquared"])) return "r-squared";
  if (
    (path.length === 2 && path[0] === "regression" && path[1] === "sampleSize") ||
    (path.length === 3 && path[0] === "descriptive" && path[2] === "n") ||
    (path.length === 1 && ["totalRows", "completeRows", "excludedRows"].includes(path[0]!))
  )
    return "sample-size";
  if (path.length === 3 && path[0] === "regression" && path[1] === "coefficients")
    return "coefficient";
  return undefined;
}
function inspect(context: ResearchNumericBindingContext, binding: ResearchNumericBinding) {
  const blockers: ResearchNumericBindingIssue[] = [];
  const fail = (code: string, detail: string) =>
    blockers.push({ bindingId: binding.id, code, detail });
  const artifacts = context.artifacts.filter((item) => item.id === binding.artifactId),
    artifact = artifacts[0];
  if (
    artifacts.length !== 1 ||
    !artifact ||
    sha(artifact.body) !== artifact.bodySha256 ||
    binding.bodySha256 !== artifact.bodySha256
  )
    fail("artifact-snapshot-stale", "正文身份或SHA已改变；提交明确编辑映射或重新绑定。");
  if (
    artifact &&
    (!boundary(artifact.body, binding.start) ||
      !boundary(artifact.body, binding.end) ||
      artifact.body.slice(binding.start, binding.end) !== binding.exactText)
  )
    fail("fragment-changed", "绑定的UTF16范围或精确片段已改变。");
  const runs = context.registry.runs.filter((item) => item.id === binding.runId),
    run = runs[0];
  if (runs.length !== 1 || !run) fail("run-missing", "没有唯一的实际注册运行。");
  else {
    const { runSha256, ...contents } = run;
    if (
      runSha256 !== binding.runSha256 ||
      digest(contents) !== runSha256 ||
      digest(run.result) !== run.resultSha256
    )
      fail("run-integrity", "实际运行或结果摘要不符。");
    const plans = context.registry.plans.filter((plan) => plan.id === run.planId);
    const plan = plans.find((item) => item.version === run.planVersion);
    if (
      !plan ||
      plans.some((item) => item.version > run.planVersion) ||
      digest(plan) !== run.replay.planSha256
    )
      fail("plan-stale", "运行引用的计划已改变或有新版本。");
    const datasets = context.currentDatasets.filter((item) => item.id === run.datasetId);
    if (
      datasets.length !== 1 ||
      datasets[0]!.sha256 !== run.datasetSha256 ||
      plan?.dataset.sha256 !== run.datasetSha256 ||
      plan?.dataset.id !== run.datasetId
    )
      fail("dataset-stale", "实际当前数据SHA或登记数据身份不符。");
  }
  const metadata = context.fieldMetadata.find((item) => item.id === binding.fieldMetadataId);
  if (
    !metadata ||
    digest(metadata) !== binding.fieldMetadataSha256 ||
    metadata.runId !== binding.runId ||
    metadata.runSha256 !== binding.runSha256 ||
    JSON.stringify(metadata.path) !== JSON.stringify(binding.path)
  )
    fail("field-metadata-stale", "独立字段元数据不存在、已改变或不属于此运行字段。");
  if (metadata) {
    if (metadata.status !== "verified")
      fail("unit-unverified", `单位状态为${metadata.status}，仍待有出处的核对。`);
    if (metadata.unit !== binding.unit)
      fail("unit-mismatch", "正文声明单位与独立字段元数据不符；不自动转换单位。");
    if (
      metadata.quantity !== binding.quantity ||
      (canonicalQuantity(binding.path) && canonicalQuantity(binding.path) !== metadata.quantity)
    )
      fail("quantity-mismatch", "样本量/R²/系数的字段身份与声明不符。");
  }
  const value = run ? field(run.result, binding.path) : undefined;
  let expected: string | undefined;
  if (value === undefined)
    fail("value-unavailable", "结果字段不存在、非有限数值或未定义；不得替换为0。");
  else {
    if (
      binding.quantity === "sample-size" &&
      (!Number.isSafeInteger(value) || value < 0 || binding.decimalPlaces !== 0)
    )
      fail("sample-size-format", "样本量必须是非负安全整数且不用小数舍入。");
    if (binding.quantity === "r-squared" && (value < 0 || value > 1))
      fail("r-squared-range", "当前OLS R²字段不在0–1范围。");
    expected =
      renderResearchNumericValue(value, binding.decimalPlaces, binding.rounding) +
      (binding.unit ? binding.unitSeparator + binding.unit : "");
    if (expected !== binding.exactText)
      fail("display-mismatch", `精确片段应为${expected}；值、符号、单位或精度不符。`);
  }
  return {
    bindingId: binding.id,
    valid: blockers.length === 0,
    value,
    expected,
    blockers,
    unitProvenance: metadata?.provenance,
  };
}
/** Narrow integration entry: request references only; hashes/text are derived from host snapshots. */
export function createResearchNumericBinding(
  context: ResearchNumericBindingContext,
  raw: ResearchNumericBindingRequest,
): ResearchNumericBinding {
  const request = decodeResearchNumericBindingRequest(raw);
  const artifact = context.artifacts.find((item) => item.id === request.artifactId),
    run = context.registry.runs.find((item) => item.id === request.runId),
    metadata = context.fieldMetadata.find((item) => item.id === request.fieldMetadataId);
  if (!artifact || !run || !metadata) throw new Error("缺少正文、实际运行或独立字段元数据。");
  const binding = {
    ...request,
    bodySha256: artifact.bodySha256,
    exactText: artifact.body.slice(request.start, request.end),
    runSha256: run.runSha256,
    fieldMetadataSha256: digest(metadata),
  };
  const report = validateResearchNumericBindings(context, [binding]);
  if (report.blockers.length)
    throw new Error(report.blockers.map((item) => `${item.code}: ${item.detail}`).join("；"));
  return structuredClone(binding);
}
export function scanUnboundResearchNumbers(
  artifact: ResearchNumericArtifactSnapshot,
  bindings: ResearchNumericBinding[],
) {
  const result: { start: number; end: number; text: string; reason: string }[] = [];
  // Deliberately lexical. Years, identifiers, citations, superscripts and dates may need dismissal.
  for (const match of artifact.body.matchAll(
    /[+\-−]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+\-]?\d+)?(?:%|％)?/g,
  )) {
    const start = match.index!,
      end = start + match[0].length;
    if (
      !bindings.some(
        (binding) =>
          binding.artifactId === artifact.id &&
          binding.bodySha256 === artifact.bodySha256 &&
          binding.start <= start &&
          binding.end >= end,
      )
    )
      result.push({
        start,
        end,
        text: match[0],
        reason: "疑似未绑定数字：需判断是否结果、年份、编号或引用；词法扫描不证明全文数字完整性。",
      });
  }
  return result;
}
export function validateResearchNumericBindings(
  context: ResearchNumericBindingContext,
  raw: unknown,
) {
  const bindings = decodeResearchNumericBindings(raw);
  decodeResearchResultFieldMetadata(context.fieldMetadata);
  const candidateReviews = decodeResearchNumericCandidateReviews(context.candidateReviews ?? []);
  const checks = bindings.map((binding) => inspect(context, binding));
  const blockers = checks.flatMap((check) => check.blockers);
  for (let index = 0; index < bindings.length; index++)
    for (const other of bindings.slice(index + 1)) {
      const binding = bindings[index]!;
      if (
        binding.artifactId === other.artifactId &&
        binding.start < other.end &&
        other.start < binding.end
      )
        blockers.push({
          bindingId: binding.id,
          code: "overlapping-bindings",
          detail: `与${other.id}重叠，不能用多个解释覆盖同一片段。`,
        });
    }
  const candidates = context.artifacts.flatMap((artifact) =>
    scanUnboundResearchNumbers(
      artifact,
      bindings.filter((binding) => checks.find((check) => check.bindingId === binding.id)?.valid),
    ).map((item) => ({ artifactId: artifact.id, bodySha256: artifact.bodySha256, ...item })),
  );
  const candidateReviewChecks = candidateReviews.map((review) => {
    const artifact = context.artifacts.find((item) => item.id === review.artifactId);
    const current =
      artifact &&
      sha(artifact.body) === artifact.bodySha256 &&
      artifact.bodySha256 === review.bodySha256 &&
      artifact.body.slice(review.start, review.end) === review.exactText;
    const candidate =
      current &&
      candidates.find(
        (item) =>
          item.artifactId === review.artifactId &&
          item.start === review.start &&
          item.end === review.end &&
          item.text === review.exactText,
      );
    return {
      review,
      status: !current
        ? ("stale" as const)
        : !candidate
          ? ("not-a-candidate" as const)
          : ("applicable" as const),
    };
  });
  const reviewedCandidates = candidates.map((candidate) => {
    const review = candidateReviewChecks
      .filter(
        (check) =>
          check.status === "applicable" &&
          check.review.artifactId === candidate.artifactId &&
          check.review.start === candidate.start &&
          check.review.end === candidate.end,
      )
      .at(-1)?.review;
    return {
      ...candidate,
      review,
      disposition:
        review?.classification === "non-result-number"
          ? ("reviewed-non-result" as const)
          : ("requires-binding-or-review" as const),
    };
  });
  const unbound = reviewedCandidates.filter(
    (candidate) => candidate.disposition !== "reviewed-non-result",
  );
  const reviewedNonResults = reviewedCandidates.filter(
    (candidate) => candidate.disposition === "reviewed-non-result",
  );
  return {
    checks,
    blockers,
    unbound,
    reviewedNonResults,
    candidateReviewChecks,
    blocksFormalAcceptance: blockers.length > 0 || unbound.length > 0,
    requiresContentReview: true as const,
    boundary: RESEARCH_NUMERIC_REVIEW_BOUNDARY,
    candidateReviewBoundary:
      "非结果数字的解除来自有身份、有理由的语义审阅，不是程序证明；只对同稿同片段有效，不覆盖任何实际绑定错误。",
  };
}
/** Identity and sourceRef are supplied separately by the host, never accepted in a model request. */
export function createResearchNumericCandidateReview(
  artifact: ResearchNumericArtifactSnapshot,
  raw: ResearchNumericCandidateReviewInput,
  provenance: ResearchNumericCandidateReview["provenance"],
): ResearchNumericCandidateReview {
  const input = decodeResearchNumericCandidateReviewInput(raw);
  if (
    sha(artifact.body) !== artifact.bodySha256 ||
    !scanUnboundResearchNumbers(artifact, []).some(
      (candidate) => candidate.start === input.start && candidate.end === input.end,
    )
  )
    throw new Error("只能复核当前正文中一个精确的词法数字候选，不能整体豁免。");
  return decodeResearchNumericCandidateReviews([
    {
      ...input,
      artifactId: artifact.id,
      bodySha256: artifact.bodySha256,
      exactText: artifact.body.slice(input.start, input.end),
      provenance,
    },
  ])[0]!;
}
/** Explicit editor edit map only. No fuzzy relocation; touching a bound span requires rebinding. */
export function rebaseResearchNumericBindings(
  before: ResearchNumericArtifactSnapshot,
  after: ResearchNumericArtifactSnapshot,
  raw: unknown,
  edits: { start: number; end: number; text: string }[],
) {
  const bindings = decodeResearchNumericBindings(raw);
  if (
    before.id === after.id ||
    sha(before.body) !== before.bodySha256 ||
    sha(after.body) !== after.bodySha256
  )
    throw new Error("重绑需要两个不同身份的不可变正文快照。");
  let cursor = 0,
    rendered = "";
  for (const edit of edits) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < cursor ||
      edit.end < edit.start ||
      !boundary(before.body, edit.start) ||
      !boundary(before.body, edit.end) ||
      typeof edit.text !== "string"
    )
      throw new Error("编辑映射须按原文UTF16范围排序、互不重叠。");
    rendered += before.body.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  rendered += before.body.slice(cursor);
  if (rendered !== after.body) throw new Error("编辑映射不能精确重建新正文。");
  const carried: ResearchNumericBinding[] = [],
    requiresRebind: string[] = [];
  for (const binding of bindings) {
    if (
      binding.artifactId !== before.id ||
      binding.bodySha256 !== before.bodySha256 ||
      before.body.slice(binding.start, binding.end) !== binding.exactText
    )
      throw new Error("旧绑定不属于指定原始正文。");
    if (
      edits.some(
        (edit) =>
          (edit.start < binding.end && edit.end > binding.start) ||
          (edit.start === edit.end && edit.start > binding.start && edit.start < binding.end),
      )
    ) {
      requiresRebind.push(binding.id);
      continue;
    }
    const shift = edits
      .filter((edit) => edit.end <= binding.start)
      .reduce((sum, edit) => sum + edit.text.length - (edit.end - edit.start), 0);
    const moved = {
      ...binding,
      id: `${binding.id}@${after.id}`,
      artifactId: after.id,
      bodySha256: after.bodySha256,
      start: binding.start + shift,
      end: binding.end + shift,
    };
    if (after.body.slice(moved.start, moved.end) !== binding.exactText)
      throw new Error("编辑后片段不能精确保留。");
    carried.push(moved);
  }
  return {
    bindings: decodeResearchNumericBindings(carried),
    requiresRebind,
    previousBindings: structuredClone(bindings),
    mapping: carried.map((binding) => ({
      bindingId: binding.id,
      previousBindingId: binding.id.slice(0, -(after.id.length + 1)),
    })),
  };
}
