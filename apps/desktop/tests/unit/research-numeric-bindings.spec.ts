import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import type { RegisteredResearchAnalysisPlan } from "../../contracts/research-analysis-registry";
import {
  decodeResearchNumericBindingRequest,
  decodeResearchNumericBindings,
  decodeResearchNumericPath,
  decodeResearchNumericCandidateReviews,
  decodeResearchResultFieldMetadata,
  type ResearchNumericBinding,
  type ResearchNumericBindingRequest,
  type ResearchNumericQuantity,
  type ResearchResultFieldMetadata,
} from "../../contracts/research-numeric-bindings";
import {
  createResearchAnalysisRegistry,
  executeRegisteredResearchAnalysis,
  registerResearchAnalysisPlan,
} from "../../electron/research-group/analysis-registry";
import { calculateResearchData } from "../../electron/research-group/analysis";
import {
  createResearchNumericArtifactSnapshot,
  createResearchNumericBinding,
  createResearchNumericCandidateReview,
  rebaseResearchNumericBindings,
  renderResearchNumericValue,
  validateResearchNumericBindings,
  type ResearchNumericBindingContext,
} from "../../electron/research-group/numeric-bindings";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const at = "2026-11-07T12:00:00.000Z";
function actual(csv = "x,y\n1,8\n2,6\n3,4\n4,2\n5,0\n", describe = false, column = "x") {
  const dataset = { id: "synthetic", sha256: sha(csv), delimiter: "," as const };
  const plan: RegisteredResearchAnalysisPlan = {
    id: "plan",
    version: 1,
    label: "闭式合成算例",
    purpose: "primary",
    objective: "核对 y=10-2x；不代表真实研究。",
    dataset: { id: dataset.id, sha256: dataset.sha256 },
    method: describe ? "describe" : "ols",
    columns: [column],
    ...(describe ? {} : { outcome: "y" }),
    parameters: {},
    outputs: describe
      ? ["descriptive"]
      : ["regression.coefficients", "regression.rSquared", "regression.sampleSize"],
    reviewPlan: "使用闭式值核对工具结果。",
    registration: {
      at,
      timing: "prospective",
      reason: "合成测试事前计划",
      sourceRef: "fixture:closed-form",
    },
    sample: { mode: "all" },
  };
  const registry = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), plan);
  return {
    ...executeRegisteredResearchAnalysis(registry, {
      id: "actual-run",
      planId: plan.id,
      planVersion: 1,
      at: "2026-11-07T12:00:01.000Z",
      actor: "host:test-calculator",
      dataset,
      csv,
    }),
    dataset,
    plan,
    csv,
  };
}
function fixture(body = "β=-2.00 分/小时；n=5 人；R²=1.000。") {
  const computed = actual();
  const definitions: {
    id: string;
    path: string[];
    quantity: ResearchNumericQuantity;
    unit: string;
    text: string;
    places: number;
  }[] = [
    {
      id: "beta",
      path: ["regression", "coefficients", "x"],
      quantity: "coefficient",
      unit: "分/小时",
      text: "-2.00 分/小时",
      places: 2,
    },
    {
      id: "n",
      path: ["regression", "sampleSize"],
      quantity: "sample-size",
      unit: "人",
      text: "5 人",
      places: 0,
    },
    {
      id: "r2",
      path: ["regression", "rSquared"],
      quantity: "r-squared",
      unit: "",
      text: "1.000",
      places: 3,
    },
  ];
  const fieldMetadata: ResearchResultFieldMetadata[] = definitions.map((definition) => ({
    id: definition.id,
    runId: computed.run.id,
    runSha256: computed.run.runSha256,
    path: definition.path,
    quantity: definition.quantity,
    unit: definition.unit,
    status: "verified",
    provenance: {
      actor: "host",
      actorId: "synthetic-fixture-owner",
      at,
      sourceRef: "fixture:declared-units:x-hours:y-points",
      note: "合成夹具定义的单位，未冒称真实数据单位或人类审阅。",
    },
  }));
  const artifact = createResearchNumericArtifactSnapshot("draft-1", body);
  const context: ResearchNumericBindingContext = {
    artifacts: [artifact],
    registry: computed.registry,
    currentDatasets: [computed.dataset],
    fieldMetadata,
  };
  const requests: ResearchNumericBindingRequest[] = definitions.map((definition) => ({
    id: definition.id,
    artifactId: artifact.id,
    start: body.indexOf(definition.text),
    end: body.indexOf(definition.text) + definition.text.length,
    runId: computed.run.id,
    path: definition.path,
    fieldMetadataId: definition.id,
    quantity: definition.quantity,
    unit: definition.unit,
    decimalPlaces: definition.places,
    rounding: "half-away-from-zero",
    unitSeparator: " ",
  }));
  return {
    context,
    requests,
    computed,
    artifact,
    bindings: () => requests.map((request) => createResearchNumericBinding(context, request)),
  };
}
const codes = (context: ResearchNumericBindingContext, bindings: ResearchNumericBinding[]) =>
  validateResearchNumericBindings(context, bindings).blockers.map((blocker) => blocker.code);

test("binds actual registered OLS output to closed-form slope, sample size and R squared with declared units", () => {
  const f = fixture(),
    original = structuredClone(f.context);
  expect(f.computed.run.result.regression).toMatchObject({
    coefficients: { intercept: 10, x: -2 },
    sampleSize: 5,
    rSquared: 1,
  });
  expect(calculateResearchData(f.computed.csv, ",", f.computed.run.spec)).toEqual(
    f.computed.run.result,
  );
  const bindings = f.bindings(),
    report = validateResearchNumericBindings(f.context, bindings);
  expect(report.blockers).toEqual([]);
  expect(report.unbound).toEqual([]);
  expect(report.blocksFormalAcceptance).toBe(false);
  expect(report.requiresContentReview).toBe(true);
  expect(report.checks.map((check) => check.expected)).toEqual(["-2.00 分/小时", "5 人", "1.000"]);
  expect(report.checks[0]!.unitProvenance?.actor).toBe("host");
  expect(f.context).toEqual(original);
});

test("actual descriptive result 1.005 obeys explicitly selected decimal tie rounding without binary tolerance", () => {
  const computed = actual("x\n1.005\n", true);
  expect(computed.run.result.descriptive).toEqual({
    x: { n: 1, missing: 0, mean: 1.005, sd: null, median: 1.005, min: 1.005, max: 1.005 },
  });
  const value = (computed.run.result.descriptive as Record<string, { mean: number }>).x!.mean;
  expect(renderResearchNumericValue(value, 2, "half-away-from-zero")).toBe("1.01");
  expect(renderResearchNumericValue(value, 2, "half-even")).toBe("1.00");
  expect(renderResearchNumericValue(-value, 2, "half-away-from-zero")).toBe("-1.01");
  expect(renderResearchNumericValue(-value, 2, "truncate")).toBe("-1.00");
  expect(renderResearchNumericValue(1.015, 2, "half-even")).toBe("1.02");
  expect(renderResearchNumericValue(-0.0001, 2, "truncate")).toBe("-0.00");
  const metadata: ResearchResultFieldMetadata = {
    id: "mean",
    runId: computed.run.id,
    runSha256: computed.run.runSha256,
    path: ["descriptive", "x", "mean"],
    quantity: "other",
    unit: "",
    status: "verified",
    provenance: {
      actor: "model",
      actorId: "reviewer-model",
      at,
      sourceRef: "fixture:dimensionless-variable",
      note: "模型核对合成变量声明，不是人类审阅。",
    },
  };
  const context: ResearchNumericBindingContext = {
    artifacts: [createResearchNumericArtifactSnapshot("rounding", "均值=1.01")],
    registry: computed.registry,
    currentDatasets: [computed.dataset],
    fieldMetadata: [metadata],
  };
  const request: ResearchNumericBindingRequest = {
    id: "mean",
    artifactId: "rounding",
    start: 3,
    end: 7,
    runId: computed.run.id,
    path: metadata.path,
    fieldMetadataId: metadata.id,
    quantity: "other",
    unit: "",
    decimalPlaces: 2,
    rounding: "half-away-from-zero",
    unitSeparator: "",
  };
  expect(
    validateResearchNumericBindings(context, [createResearchNumericBinding(context, request)])
      .blockers,
  ).toEqual([]);
  expect(() =>
    createResearchNumericBinding(context, { ...request, rounding: "half-even" }),
  ).toThrow("display-mismatch");
});

test("wrong sign, sample count, R squared, precision and unit are deterministic blockers", () => {
  for (const [id, text] of [
    ["beta", "2.00 分/小时"],
    ["n", "6 人"],
    ["r2", "0.900"],
    ["beta", "-2.0 分/小时"],
    ["beta", "-2.00 秒"],
  ]) {
    const f = fixture(),
      old = f.bindings().find((binding) => binding.id === id)!;
    const body = f.artifact.body.slice(0, old.start) + text + f.artifact.body.slice(old.end);
    const changed = createResearchNumericArtifactSnapshot("changed", body);
    expect(() =>
      createResearchNumericBinding(
        { ...f.context, artifacts: [changed] },
        {
          ...f.requests.find((request) => request.id === id)!,
          artifactId: changed.id,
          end: old.start + text!.length,
        },
      ),
    ).toThrow("display-mismatch");
  }
  const f = fixture(),
    binding = f.bindings()[0]!;
  expect(codes(f.context, [{ ...binding, unit: "秒" }])).toContain("unit-mismatch");
  expect(codes(f.context, [{ ...binding, quantity: "sample-size" }])).toContain(
    "quantity-mismatch",
  );
  expect(codes(f.context, [{ ...f.bindings()[1]!, decimalPlaces: 2 }])).toContain(
    "sample-size-format",
  );
});

test("missing or changed actual run, plan version and actual dataset bytes invalidate prior bindings", () => {
  const f = fixture(),
    bindings = f.bindings();
  const missing = structuredClone(f.context);
  missing.registry.runs = [];
  expect(codes(missing, bindings)).toContain("run-missing");
  const changed = structuredClone(f.context);
  changed.registry.runs[0]!.result.totalRows = 100;
  expect(codes(changed, bindings)).toContain("run-integrity");
  const nonfinite = structuredClone(f.context);
  nonfinite.registry.runs[0]!.result.regression = { rSquared: Infinity };
  expect(codes(nonfinite, bindings)).toContain("value-unavailable");
  expect(codes(nonfinite, bindings)).toContain("run-integrity");
  const data = structuredClone(f.context);
  data.currentDatasets[0]!.sha256 = sha("changed bytes");
  expect(codes(data, bindings)).toContain("dataset-stale");
  const plan = structuredClone(f.context);
  plan.registry = registerResearchAnalysisPlan(plan.registry, {
    ...f.computed.plan,
    version: 2,
    registration: {
      ...f.computed.plan.registration,
      at: "2026-11-07T12:00:02.000Z",
      timing: "post-hoc",
      reason: "新增计划版本",
    },
  });
  expect(codes(plan, bindings)).toContain("plan-stale");
  const tamperedPlan = structuredClone(f.context);
  tamperedPlan.registry.plans[0]!.objective = "silently changed";
  expect(codes(tamperedPlan, bindings)).toContain("plan-stale");
  expect(codes(f.context, [{ ...bindings[0]!, runSha256: sha("another run") }])).toContain(
    "run-integrity",
  );
});

test("units require separate pinned metadata and preserve identity; unknown units never pass as verified", () => {
  const f = fixture(),
    bindings = f.bindings();
  for (const status of ["unknown", "declared"] as const) {
    const context = structuredClone(f.context);
    context.fieldMetadata[0]!.status = status;
    expect(codes(context, bindings)).toContain("unit-unverified");
    expect(() => createResearchNumericBinding(context, f.requests[0]!)).toThrow("unit-unverified");
  }
  const missing = { ...f.context, fieldMetadata: [] };
  expect(codes(missing, bindings)).toContain("field-metadata-stale");
  expect(() =>
    decodeResearchResultFieldMetadata([
      { ...f.context.fieldMetadata[0], provenance: { actor: "human-approved" } },
    ]),
  ).toThrow();
  const modified = structuredClone(f.context);
  modified.fieldMetadata[0]!.provenance.actor = "model";
  expect(codes(modified, bindings)).toContain("field-metadata-stale");
  expect(() =>
    decodeResearchNumericBindingRequest({ ...f.requests[0], run: f.computed.run }),
  ).toThrow("未知");
});

test("missing/null/non-numeric fields and prototype paths cannot masquerade as actual numeric output", () => {
  const f = fixture();
  for (const path of [["regression", "pValue"], ["method"], ["notes"]]) {
    const context = structuredClone(f.context);
    context.fieldMetadata[0]!.path = path;
    context.fieldMetadata[0]!.quantity = "other";
    expect(() =>
      createResearchNumericBinding(context, { ...f.requests[0]!, path, quantity: "other" }),
    ).toThrow("value-unavailable");
  }
  for (const key of ["__proto__", "prototype", "constructor"])
    expect(() => decodeResearchNumericPath([key])).toThrow("安全");
  const computed = actual("x,y\n1,2\n2,2\n3,2\n4,2\n");
  expect((computed.run.result.regression as Record<string, unknown>).rSquared).toBeNull();
  const context = structuredClone(f.context);
  context.registry = computed.registry;
  context.currentDatasets = [computed.dataset];
  context.fieldMetadata[2]!.runSha256 = computed.run.runSha256;
  expect(() => createResearchNumericBinding(context, f.requests[2]!)).toThrow("value-unavailable");
});

test("explicit UTF16 edits carry only untouched fragments to a new immutable snapshot", () => {
  const f = fixture("🔎β=-2.00 分/小时；n=5 人；R²=1.000。"),
    bindings = f.bindings(),
    original = structuredClone(bindings);
  const beta = bindings[0]!,
    edits = [
      { start: 0, end: 0, text: "新增引言。" },
      { start: beta.start, end: beta.end, text: "-3.00 分/小时" },
    ];
  const nextBody =
    "新增引言。" +
    f.artifact.body.slice(0, beta.start) +
    "-3.00 分/小时" +
    f.artifact.body.slice(beta.end);
  const next = createResearchNumericArtifactSnapshot("draft-2", nextBody);
  const rebased = rebaseResearchNumericBindings(f.artifact, next, bindings, edits);
  expect(rebased.requiresRebind).toEqual(["beta"]);
  expect(rebased.bindings.map((binding) => binding.exactText)).toEqual(["5 人", "1.000"]);
  expect(rebased.previousBindings).toEqual(original);
  expect(bindings).toEqual(original);
  expect(
    validateResearchNumericBindings(
      { ...f.context, artifacts: [next] },
      rebased.bindings,
    ).checks.every((check) => check.valid),
  ).toBe(true);
  expect(
    validateResearchNumericBindings(
      { ...f.context, artifacts: [next] },
      rebased.bindings,
    ).unbound.map((item) => item.text),
  ).toContain("-3.00");
  expect(codes({ ...f.context, artifacts: [next] }, bindings)).toContain("artifact-snapshot-stale");
  expect(() => rebaseResearchNumericBindings(f.artifact, next, bindings, [])).toThrow("重建");
  expect(() =>
    rebaseResearchNumericBindings(f.artifact, next, bindings, [
      { start: 1, end: 1, text: "split surrogate" },
    ]),
  ).toThrow("UTF16");
});

test("unbound candidates remain review items and overlaps block", () => {
  const f = fixture(),
    bindings = f.bindings();
  const report = validateResearchNumericBindings(f.context, bindings.slice(0, 2));
  expect(report.unbound.map((candidate) => candidate.text)).toEqual(["1.000"]);
  expect(report.blocksFormalAcceptance).toBe(true);
  expect(codes(f.context, [...bindings, { ...bindings[0]!, id: "overlap" }])).toContain(
    "overlapping-bindings",
  );
  expect(() => decodeResearchNumericBindings([bindings[0], bindings[0]])).toThrow("唯一");
  expect(decodeResearchNumericPath(["descriptive", "exam.score", "mean"])).toEqual([
    "descriptive",
    "exam.score",
    "mean",
  ]);
  expect(() => decodeResearchNumericBindings([{ ...bindings[0], actor: "user" }])).toThrow("未知");
});

test("a period in a real executed variable name is one field key, never a dotted-path expression", () => {
  const computed = actual("exam.score\n1\n3\n", true, "exam.score");
  const artifact = createResearchNumericArtifactSnapshot("dot-key", "均值=2.00 分");
  const metadata: ResearchResultFieldMetadata = {
    id: "dot-mean",
    runId: computed.run.id,
    runSha256: computed.run.runSha256,
    path: ["descriptive", "exam.score", "mean"],
    quantity: "other",
    unit: "分",
    status: "verified",
    provenance: {
      actor: "host",
      actorId: "fixture-owner",
      at,
      sourceRef: "fixture:exam-score-unit",
      note: "合成变量单位定义",
    },
  };
  const context: ResearchNumericBindingContext = {
    artifacts: [artifact],
    registry: computed.registry,
    currentDatasets: [computed.dataset],
    fieldMetadata: [metadata],
  };
  const request: ResearchNumericBindingRequest = {
    id: "dot-mean",
    artifactId: artifact.id,
    start: 3,
    end: artifact.body.length,
    runId: computed.run.id,
    path: metadata.path,
    fieldMetadataId: metadata.id,
    quantity: "other",
    unit: "分",
    decimalPlaces: 2,
    rounding: "half-even",
    unitSeparator: " ",
  };
  const binding = createResearchNumericBinding(context, request);
  expect(validateResearchNumericBindings(context, [binding]).checks[0]!.value).toBe(2);
  expect(validateResearchNumericBindings(context, [binding]).blocksFormalAcceptance).toBe(false);
});

const candidateReviewer = {
  actor: "model" as const,
  actorId: "reviewer-B-model",
  at,
  sourceRef: "review-session:actual-host-recorded-tool-call",
};
test("same-snapshot semantic reviews dismiss only specifically reviewed years and numbers with retained identity", () => {
  const f = fixture(),
    artifact = createResearchNumericArtifactSnapshot("references", "参考文献（2025），条目 1。"),
    context = { ...f.context, artifacts: [artifact] };
  const before = validateResearchNumericBindings(context, []);
  expect(before.unbound.map((candidate) => candidate.text)).toEqual(["2025", "1"]);
  const reviews = before.unbound.map((candidate, index) =>
    createResearchNumericCandidateReview(
      artifact,
      {
        id: `review-${index}`,
        start: candidate.start,
        end: candidate.end,
        classification: "non-result-number",
        reason:
          index === 0 ? "这是参考文献出版年份，不是本研究实算结果。" : "这是条目编号，不是样本量。",
      },
      candidateReviewer,
    ),
  );
  const partial = validateResearchNumericBindings(
    { ...context, candidateReviews: reviews.slice(0, 1) },
    [],
  );
  expect(partial.unbound.map((candidate) => candidate.text)).toEqual(["1"]);
  expect(partial.blocksFormalAcceptance).toBe(true);
  const reviewed = validateResearchNumericBindings({ ...context, candidateReviews: reviews }, []);
  expect(reviewed.unbound).toEqual([]);
  expect(reviewed.reviewedNonResults).toHaveLength(2);
  expect(reviewed.reviewedNonResults[0]!.review!.provenance.actor).toBe("model");
  expect(reviewed.blocksFormalAcceptance).toBe(false);
  expect(reviewed.requiresContentReview).toBe(true);
  expect(reviewed.candidateReviewBoundary).toContain("不是程序证明");
  const reconsider = createResearchNumericCandidateReview(
    artifact,
    {
      id: "review-reconsider",
      start: reviews[0]!.start,
      end: reviews[0]!.end,
      classification: "requires-binding",
      reason: "复核发现此处实际被用作结果数量，需要字段绑定。",
    },
    {
      ...candidateReviewer,
      actor: "user",
      actorId: "actual-ui-user-action",
      sourceRef: "user-action:reconsider",
    },
  );
  expect(
    validateResearchNumericBindings(
      { ...context, candidateReviews: [...reviews, reconsider] },
      [],
    ).unbound.map((candidate) => candidate.text),
  ).toEqual(["2025"]);
});

test("old manuscript or changed fragment reviews never dismiss current numeric candidates", () => {
  const f = fixture(),
    old = createResearchNumericArtifactSnapshot("old-reference", "文献2025"),
    review = createResearchNumericCandidateReview(
      old,
      {
        id: "year-review",
        start: 2,
        end: 6,
        classification: "non-result-number",
        reason: "该处为文献出版年份。",
      },
      candidateReviewer,
    );
  for (const artifact of [
    createResearchNumericArtifactSnapshot("new-reference", old.body),
    createResearchNumericArtifactSnapshot(old.id, "文献2026"),
    createResearchNumericArtifactSnapshot(old.id, "文献2025。补充说明"),
  ]) {
    const report = validateResearchNumericBindings(
      { ...f.context, artifacts: [artifact], candidateReviews: [review] },
      [],
    );
    expect(report.unbound).toHaveLength(1);
    expect(report.blocksFormalAcceptance).toBe(true);
    expect(report.candidateReviewChecks[0]!.status).toBe("stale");
  }
  const repeated = createResearchNumericArtifactSnapshot("repeat", "2025，2025"),
    first = createResearchNumericCandidateReview(
      repeated,
      {
        id: "first-year-only",
        start: 0,
        end: 4,
        classification: "non-result-number",
        reason: "第一处为年份；未审第二处。",
      },
      candidateReviewer,
    );
  expect(
    validateResearchNumericBindings(
      { ...f.context, artifacts: [repeated], candidateReviews: [first] },
      [],
    ).unbound.map((candidate) => candidate.start),
  ).toEqual([5]);
});

test("whole-document, empty-reason and injected identity waivers are rejected and semantic reviews cannot clear real binding errors", () => {
  const f = fixture(),
    bindings = f.bindings(),
    artifact = f.artifact;
  const base = {
    id: "candidate-review",
    start: bindings[0]!.start,
    end: bindings[0]!.start + "-2.00".length,
    classification: "non-result-number" as const,
    reason: "测试：即使对词法候选给出审阅，也不能覆盖已存在的字段错误。",
  };
  expect(() =>
    createResearchNumericCandidateReview(
      artifact,
      { ...base, start: 0, end: artifact.body.length },
      candidateReviewer,
    ),
  ).toThrow("不能整体豁免");
  expect(() =>
    createResearchNumericCandidateReview(artifact, { ...base, reason: "  " }, candidateReviewer),
  ).toThrow("非空理由");
  expect(() =>
    createResearchNumericCandidateReview(
      artifact,
      { ...base, actor: "user" } as typeof base,
      candidateReviewer,
    ),
  ).toThrow("未知");
  const review = createResearchNumericCandidateReview(artifact, base, candidateReviewer);
  expect(() =>
    decodeResearchNumericCandidateReviews([{ ...review, classification: "accept-all" }]),
  ).toThrow();
  expect(() =>
    decodeResearchNumericCandidateReviews([
      { ...review, provenance: { ...review.provenance, sourceRef: "" } },
    ]),
  ).toThrow("出处");
  const incorrect = [{ ...bindings[0]!, unit: "秒" }, ...bindings.slice(1)];
  const report = validateResearchNumericBindings(
    { ...f.context, candidateReviews: [review] },
    incorrect,
  );
  expect(report.reviewedNonResults).toHaveLength(1);
  expect(report.blockers.map((blocker) => blocker.code)).toContain("unit-mismatch");
  expect(report.blocksFormalAcceptance).toBe(true);
  const forgedWideReview = {
    ...review,
    start: 0,
    end: artifact.body.length,
    exactText: artifact.body,
  };
  const broadReport = validateResearchNumericBindings(
    { ...f.context, candidateReviews: [forgedWideReview] },
    [],
  );
  expect(broadReport.reviewedNonResults).toEqual([]);
  expect(broadReport.candidateReviewChecks[0]!.status).toBe("not-a-candidate");
  expect(broadReport.blocksFormalAcceptance).toBe(true);
});
