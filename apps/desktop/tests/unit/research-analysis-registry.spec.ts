import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import type { ResearchDataset } from "../../contracts/research-evidence";
import type {
  RegisteredResearchAnalysisPlan,
  ResearchAnalysisRegistry,
} from "../../contracts/research-analysis-registry";
import { decodeRegisteredResearchAnalysisPlan } from "../../contracts/research-analysis-registry";
import {
  compareRegisteredAnalysisSamples,
  createResearchAnalysisRegistry,
  executeRegisteredResearchAnalysis,
  registerLegacySingleAnalysisPlan,
  registerResearchAnalysisPlan,
  researchAnalysisCapability,
  researchAnalysisRegistryReport,
  recordRegisteredAnalysisReview,
  auditResearchAnalysisPromises,
  decodeResearchAnalysisRegistry,
} from "../../electron/research-group/analysis-registry";

const csv = "x,z,y\n1,2,4\n2,1,5\n3,4,10\n4,3,11\n5,NA,14\n6,5,17\n,6,19\n8,7,22\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const dataset = { id: "observations", sha256: hash(csv), delimiter: "," as const };
const at = (seconds: number) => `2026-11-07T09:00:${String(seconds).padStart(2, "0")}.000Z`;
function plan(
  id: string,
  changes: Partial<RegisteredResearchAnalysisPlan> = {},
): RegisteredResearchAnalysisPlan {
  return {
    id,
    version: 1,
    label: id,
    purpose: "primary",
    objective: "核对合成夹具中的变量关系，非真实研究。",
    dataset: { id: dataset.id, sha256: dataset.sha256 },
    method: "ols",
    columns: ["x"],
    outcome: "y",
    parameters: { intercept: true, missingPolicy: "complete-case" },
    outputs: ["regression.coefficients", "regression.rSquared", "sample-accounting"],
    reviewPlan: "B 核对样本、计划与解释；同引擎复跑不称独立算法校验。",
    registration: {
      at: at(0),
      timing: "prospective",
      reason: "运行前明确登记的合成测试计划。",
      sourceRef: "fixture:design-before-results",
    },
    sample: { mode: "all" },
    ...changes,
  };
}
function execute(
  registry: ResearchAnalysisRegistry,
  id: string,
  seconds = 1,
  extra: Partial<Parameters<typeof executeRegisteredResearchAnalysis>[1]> = {},
) {
  return executeRegisteredResearchAnalysis(registry, {
    id: `${id}-run-${seconds}`,
    planId: id,
    planVersion: 1,
    at: at(seconds),
    actor: "researcher-A",
    dataset,
    csv,
    ...extra,
  });
}

test("registered main, comparison and descriptive plans actually execute with explicit shared derived sample and replay provenance", () => {
  const selected: RegisteredResearchAnalysisPlan["sample"] = {
    mode: "selected-rows",
    id: "common-complete-records",
    sourceLines: [2, 3, 4, 5, 7, 9],
    reason: "主模型与比较模型明确共用 x、z、y 均完整的 6 行；不是原始 8 行全样本。",
  };
  const plans = [
    plan("main", { sample: selected }),
    plan("comparison", {
      purpose: "comparison",
      columns: ["x", "z"],
      sample: selected,
      compareWith: { planId: "main", planVersion: 1, requireSameSample: true },
    }),
    plan("description", {
      purpose: "descriptive",
      method: "describe",
      columns: ["x", "z", "y"],
      outcome: undefined,
      parameters: { missingPolicy: "per-variable" },
      outputs: ["descriptive", "sample-accounting"],
    }),
    plan("unexecuted-promise"),
  ];
  let registry = plans.reduce(registerResearchAnalysisPlan, createResearchAnalysisRegistry());
  const original = structuredClone({ registry, dataset });
  const main = execute(registry, "main");
  registry = main.registry;
  const comparison = execute(registry, "comparison", 2);
  registry = comparison.registry;
  const descriptive = execute(registry, "description", 3);
  registry = descriptive.registry;
  expect(main.run.sample).toMatchObject({
    originalDataRows: 8,
    selectedSourceLines: [2, 3, 4, 5, 7, 9],
    completeSourceLines: [2, 3, 4, 5, 7, 9],
    label: "explicit-derived-sample",
    excluded: [
      { sourceLine: 6, reason: "not-selected", columns: [] },
      { sourceLine: 8, reason: "not-selected", columns: [] },
    ],
  });
  expect(main.run.result).toMatchObject({
    totalRows: 6,
    completeRows: 6,
    regression: { sampleSize: 6 },
  });
  const regression = main.run.result.regression as {
    coefficients: { intercept: number; x: number };
  };
  // Closed-form reference for these six declared points: Sxy=90, Sxx=34, mean(y)=11.5.
  expect(regression.coefficients.x).toBeCloseTo(45 / 17, 12);
  expect(regression.coefficients.intercept).toBeCloseTo(31 / 34, 12);
  expect(compareRegisteredAnalysisSamples(main.run, comparison.run).comparable).toBe(true);
  expect(descriptive.run.result).toMatchObject({
    totalRows: 8,
    descriptive: { x: { n: 7, missing: 1 }, z: { n: 7, missing: 1 }, y: { n: 8, mean: 12.75 } },
  });
  expect(descriptive.run.sample.perVariableSourceLines.x).toEqual([2, 3, 4, 5, 6, 7, 9]);
  expect(descriptive.run.sample.perVariableSourceLines.z).toEqual([2, 3, 4, 5, 7, 8, 9]);
  expect(main.run.calculationInputSha256).not.toBe(dataset.sha256);
  expect(hash(main.calculationInput)).toBe(main.run.calculationInputSha256);
  expect(main.calculationInput).toBe("x,z,y\n1,2,4\n2,1,5\n3,4,10\n4,3,11\n6,5,17\n8,7,22\n");
  expect(main.run.datasetSha256).toBe(dataset.sha256);
  expect(main.run.replay.sample).toEqual(selected);
  const replay = execute(registry, "main", 4, { actor: "researcher-B", replayOf: main.run.id });
  registry = replay.registry;
  expect(replay.run.verification).toEqual({
    level: "same-engine-replay",
    replayOf: main.run.id,
    matches: true,
  });
  expect(replay.run.result).toEqual(main.run.result);
  expect(replay.calculationInput).toBe(main.calculationInput);
  const report = researchAnalysisRegistryReport(registry, [dataset]);
  expect(report.map((item) => item.state)).toEqual([
    "executed",
    "executed",
    "executed",
    "not-executed",
  ]);
  expect(report.find((item) => item.planId === "comparison")!.comparison?.comparable).toBe(true);
  expect(original.registry.runs).toEqual([]);
  expect(dataset).toEqual(original.dataset);
  expect(hash(csv)).toBe(dataset.sha256);
  expect(JSON.stringify(decodeResearchAnalysisRegistry(JSON.parse(JSON.stringify(registry))))).toBe(
    JSON.stringify(registry),
  );
});

test("different native complete-case samples cannot be declared a same-sample model comparison", () => {
  let registry = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), plan("main"));
  registry = registerResearchAnalysisPlan(
    registry,
    plan("comparison", {
      purpose: "comparison",
      columns: ["x", "z"],
      compareWith: { planId: "main", planVersion: 1, requireSameSample: true },
    }),
  );
  const main = execute(registry, "main");
  const comparison = execute(main.registry, "comparison", 2);
  expect(main.run.sample.excluded).toEqual([
    { sourceLine: 8, reason: "missing-values", columns: ["x"] },
  ]);
  expect(comparison.run.sample.excluded).toEqual([
    { sourceLine: 6, reason: "missing-values", columns: ["z"] },
    { sourceLine: 8, reason: "missing-values", columns: ["x"] },
  ]);
  expect(compareRegisteredAnalysisSamples(main.run, comparison.run).comparable).toBe(false);
  expect(
    researchAnalysisRegistryReport(comparison.registry, [dataset])[1]!.comparison?.comparable,
  ).toBe(false);
});

test("unsupported methods, parameters and promised p-values or intervals stay unsupported instead of substituting an OLS result", () => {
  const unsupported = [
    plan("anova", { method: "anova" }),
    plan("pvalues", { outputs: ["regression.coefficients", "p-values"] }),
    plan("ci", { outputs: ["confidence-interval"] }),
    plan("no-intercept", { parameters: { intercept: false } }),
  ];
  const registry = unsupported.reduce(
    registerResearchAnalysisPlan,
    createResearchAnalysisRegistry(),
  );
  for (const item of unsupported) {
    expect(researchAnalysisCapability(item).supported).toBe(false);
    expect(() => execute(registry, item.id)).toThrow("需要方法扩展");
  }
  expect(registry.runs).toEqual([]);
  expect(
    researchAnalysisRegistryReport(registry, [dataset]).every(
      (item) => item.state === "needs-method-extension",
    ),
  ).toBe(true);
});

test("post-result additions and revisions retain post-hoc reasons; old versions and old results cannot masquerade as current", () => {
  const registered = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), plan("main"));
  const computed = execute(registered, "main");
  expect(() =>
    registerResearchAnalysisPlan(
      computed.registry,
      plan("exploration", { purpose: "exploratory" }),
    ),
  ).toThrow("时间");
  expect(() =>
    registerResearchAnalysisPlan(
      computed.registry,
      plan("exploration", {
        purpose: "exploratory",
        registration: { ...plan("x").registration, at: at(2) },
      }),
    ),
  ).toThrow("事后");
  const exploration = plan("exploration", {
    purpose: "exploratory",
    method: "correlation",
    columns: ["x", "z"],
    outcome: undefined,
    parameters: { missingPolicy: "complete-case" },
    outputs: ["correlations"],
    registration: {
      at: at(2),
      timing: "post-hoc",
      reason: "见到主模型后追加检查共变；保留探索身份。",
      sourceRef: "fixture:after-main",
    },
  });
  const amended = registerResearchAnalysisPlan(computed.registry, exploration);
  const correlation = execute(amended, "exploration", 3);
  expect(correlation.run.result.correlations).toBeDefined();
  const revision = plan("main", {
    version: 2,
    columns: ["z"],
    registration: {
      at: at(4),
      timing: "post-hoc",
      reason: "实际见到结果后改变量，不能回写原设计。",
      sourceRef: "fixture:revision",
    },
  });
  const revised = registerResearchAnalysisPlan(correlation.registry, revision);
  expect(revised.plans.filter((item) => item.id === "main")).toHaveLength(2);
  expect(revised.plans[0]).toEqual(registered.plans[0]);
  expect(
    researchAnalysisRegistryReport(revised, [dataset]).find((item) => item.planId === "main")!
      .state,
  ).toBe("not-executed");
  expect(() => execute(revised, "main", 5)).toThrow("旧计划版本");
  expect(execute(revised, "main", 5, { replayOf: computed.run.id }).run.verification.level).toBe(
    "same-engine-replay",
  );
  expect(
    researchAnalysisRegistryReport(computed.registry, [{ ...dataset, sha256: "b".repeat(64) }])[0]!
      .state,
  ).toBe("stale");
  expect(() =>
    registerResearchAnalysisPlan(registered, plan("main", { objective: "偷改同一版本" })),
  ).toThrow("不可改写");
});

test("legacy single-plan import preserves original spec without manufacturing timing, data, or executed status", () => {
  const old = { datasetId: "future", method: "ols" as const, columns: ["x"], outcome: "y" };
  const before = structuredClone(old);
  const registry = registerLegacySingleAnalysisPlan(createResearchAnalysisRegistry(), old, {
    id: "legacy",
    observedAt: at(0),
    sourceRef: "old-project:analysisPlan",
  });
  expect(registry.plans[0]!.registration.timing).toBe("legacy-unknown");
  expect(registry.runs).toEqual([]);
  expect(researchAnalysisRegistryReport(registry, [])[0]!.state).toBe("not-executed");
  expect(() => execute(registry, "legacy")).toThrow("尚未锁定实际数据");
  expect(old).toEqual(before);
});

test("physical CSV provenance survives quoted multiline cells and blank records; bad selections and changed bytes fail explicitly", () => {
  const original = '\uFEFFx,y,note\r\n1,3,"two\r\nlines"\r\n\r\n2,5,plain\r\n3,7,last\r\n';
  const pinned = { ...dataset, sha256: hash(original) };
  const registered = registerResearchAnalysisPlan(
    createResearchAnalysisRegistry(),
    plan("trace", { dataset: { id: pinned.id, sha256: pinned.sha256 } }),
  );
  const result = execute(registered, "trace", 1, { csv: original, dataset: pinned });
  expect(result.run.sample.selectedSourceLines).toEqual([2, 5, 6]);
  expect(result.run.sample.excluded).toContainEqual({
    sourceLine: 4,
    reason: "empty-record",
    columns: [],
  });
  expect(result.run.sample.originalDataRows).toBe(4);
  expect(
    decodeResearchAnalysisRegistry(JSON.parse(JSON.stringify(result.registry))).runs[0]!.sample,
  ).toEqual(result.run.sample);
  expect(result.run.result).toMatchObject({
    totalRows: 3,
    regression: { sampleSize: 3, rSquared: 1 },
  });
  expect(() =>
    execute(registered, "trace", 1, { csv: original + "4,9,new\n", dataset: pinned }),
  ).toThrow("摘要不符");
  const invalid = registerResearchAnalysisPlan(
    createResearchAnalysisRegistry(),
    plan("inside-multiline", {
      dataset: { id: pinned.id, sha256: pinned.sha256 },
      sample: {
        mode: "selected-rows",
        id: "invalid",
        sourceLines: [3, 5, 6],
        reason: "错误的多行字段内部定位",
      },
    }),
  );
  expect(() => execute(invalid, "inside-multiline", 1, { csv: original, dataset: pinned })).toThrow(
    "多行字段内部",
  );
  expect(() =>
    decodeRegisteredResearchAnalysisPlan(
      plan("duplicates", {
        sample: { mode: "selected-rows", id: "bad", sourceLines: [2, 2], reason: "重复" },
      }),
    ),
  ).toThrow("唯一");
});

test("actual review identity remains separate from execution and explicit promises locate missing or damaged results", () => {
  const planned = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), plan("main"));
  const reviewed = recordRegisteredAnalysisReview(planned, {
    id: "plan-review",
    planId: "main",
    planVersion: 1,
    kind: "plan-review",
    at: at(0),
    actor: "reviewer-B",
    verdict: "accept",
    evidenceRef: "fixture:actual-plan-review",
    note: "认可计划作为方案，未声称执行。",
  });
  expect(researchAnalysisRegistryReport(reviewed, [dataset])[0]).toMatchObject({
    state: "not-executed",
    verification: "unreviewed",
  });
  expect(
    auditResearchAnalysisPromises(
      reviewed,
      [
        { locator: "方法段第1句", planId: "main" },
        { locator: "结果段第2句", planId: "never-registered" },
      ],
      [dataset],
    ).map((item) => item.state),
  ).toEqual(["not-executed", "not-registered"]);
  const executed = execute(reviewed, "main");
  const interpretation = recordRegisteredAnalysisReview(executed.registry, {
    id: "interpretation",
    planId: "main",
    planVersion: 1,
    runId: executed.run.id,
    kind: "interpretation-review",
    at: at(2),
    actor: "reviewer-B",
    verdict: "revise",
    evidenceRef: "fixture:actual-result-review",
    note: "计算完成但推断需收窄；内容审阅不等于独立算法校验。",
  });
  expect(researchAnalysisRegistryReport(interpretation, [dataset])[0]!.reviews).toHaveLength(2);
  expect(researchAnalysisRegistryReport(interpretation, [dataset])[0]!.verification).toBe(
    "unreviewed",
  );
  const corrupted = structuredClone(executed.registry);
  corrupted.runs[0]!.sample.completeSourceLines.pop();
  expect(researchAnalysisRegistryReport(corrupted, [dataset])[0]!.state).toBe("stale");
  expect(compareRegisteredAnalysisSamples(executed.run, corrupted.runs[0]!).comparable).toBe(false);
  expect(() => execute(corrupted, "main", 3, { replayOf: executed.run.id })).toThrow("实际运行");
  const wrongResult = structuredClone(executed.registry);
  wrongResult.runs[0]!.result.totalRows = 999;
  expect(
    auditResearchAnalysisPromises(
      wrongResult,
      [{ locator: "表1样本数", planId: "main" }],
      [dataset],
    )[0]!.state,
  ).toBe("stale");
});

function persistedRegistryFixture() {
  const planned = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), plan("main"));
  const first = execute(planned, "main");
  const replay = execute(first.registry, "main", 2, {
    replayOf: first.run.id,
    actor: "researcher-B",
  });
  const reviewed = recordRegisteredAnalysisReview(replay.registry, {
    id: "persisted-review",
    planId: "main",
    planVersion: 1,
    runId: replay.run.id,
    kind: "interpretation-review",
    at: at(3),
    actor: "reviewer-B",
    verdict: "accept",
    evidenceRef: "fixture:review-transcript",
    note: "本次内容审阅身份，非独立算法。",
  });
  return registerLegacySingleAnalysisPlan(
    reviewed,
    { datasetId: "future-data", method: "describe", columns: ["future-column"] },
    { id: "unexecuted-future", observedAt: at(4), sourceRef: "fixture:planned-no-data" },
  );
}

test("persistence decoder preserves actual execution, replay, review and no-data plans through JSON roundtrip without changing hashes", () => {
  const original = persistedRegistryFixture();
  const bytes = JSON.stringify(original);
  const decoded = decodeResearchAnalysisRegistry(JSON.parse(bytes));
  expect(JSON.stringify(decoded)).toBe(bytes);
  expect(decoded.runs.map((run) => run.runSha256)).toEqual(
    original.runs.map((run) => run.runSha256),
  );
  expect(decoded.plans.at(-1)!.dataset.sha256).toBeUndefined();
  decoded.runs[0]!.sample.completeSourceLines.pop();
  expect(JSON.stringify(original)).toBe(bytes);
  expect(decodeResearchAnalysisRegistry(createResearchAnalysisRegistry())).toEqual(
    createResearchAnalysisRegistry(),
  );
});

test("persistence decoder rejects malformed fields, tampered data and broken references without repairing the input", () => {
  const original = persistedRegistryFixture();
  const cases: { name: string; mutate: (registry: ResearchAnalysisRegistry) => void }[] = [
    {
      name: "result bytes",
      mutate: (r) => {
        r.runs[0]!.result.totalRows = 999;
      },
    },
    {
      name: "run hash",
      mutate: (r) => {
        r.runs[0]!.runSha256 = "a".repeat(64);
      },
    },
    {
      name: "result hash",
      mutate: (r) => {
        r.runs[0]!.resultSha256 = "b".repeat(64);
      },
    },
    {
      name: "plan reference",
      mutate: (r) => {
        r.runs[0]!.planId = "missing";
      },
    },
    {
      name: "replay reference",
      mutate: (r) => {
        r.runs[1]!.verification = {
          level: "same-engine-replay",
          replayOf: "missing",
          matches: true,
        };
      },
    },
    {
      name: "review reference",
      mutate: (r) => {
        r.reviews[0]!.runId = "missing";
      },
    },
    {
      name: "duplicate run",
      mutate: (r) => {
        r.runs.push(structuredClone(r.runs[0]!));
      },
    },
    {
      name: "duplicate plan",
      mutate: (r) => {
        r.plans.push(structuredClone(r.plans[0]!));
      },
    },
    {
      name: "forged timing",
      mutate: (r) => {
        r.plans.at(-1)!.registration.timing = "prospective";
      },
    },
  ];
  for (const item of cases) {
    const broken = structuredClone(original);
    item.mutate(broken);
    const bytes = JSON.stringify(broken);
    expect(() => decodeResearchAnalysisRegistry(broken), item.name).toThrow();
    expect(JSON.stringify(broken), item.name).toBe(bytes);
  }
  for (const value of [
    null,
    [],
    {},
    { version: 1, plans: [], runs: [], reviews: [], injected: true },
    { version: 1, plans: [null], runs: [], reviews: [] },
  ])
    expect(() => decodeResearchAnalysisRegistry(value)).toThrow();
});

test("persistence decoding validates spec, row accounting and replay claims even when a malformed record has internally matching hashes", () => {
  const original = persistedRegistryFixture();
  const edits: ((registry: ResearchAnalysisRegistry) => void)[] = [
    (r) => {
      r.runs[0]!.spec.columns = ["z"];
    },
    (r) => {
      r.runs[0]!.sample.selectedSourceLines.push(2);
    },
    (r) => {
      r.runs[0]!.sample.completeSourceLines.pop();
    },
    (r) => {
      r.runs[0]!.sample.perVariableSourceLines.x = [];
    },
    (r) => {
      r.runs[0]!.sample.excluded = [];
    },
    (r) => {
      r.runs[0]!.sample.originalDataRows += 1;
    },
    (r) => {
      r.runs[0]!.parameters.intercept = false;
    },
    (r) => {
      r.runs[0]!.replay.dataset.sha256 = "c".repeat(64);
    },
    (r) => {
      r.runs[0]!.result = { ...r.runs[0]!.result, pValues: { x: 0.001 } };
    },
    (r) => {
      r.runs[0]!.result.regression = { coefficients: { intercept: 1, x: 2 } };
    },
    (r) => {
      r.runs[1]!.verification = {
        level: "same-engine-replay",
        replayOf: r.runs[0]!.id,
        matches: false,
      };
    },
  ];
  for (const edit of edits) {
    const broken = structuredClone(original);
    edit(broken);
    for (const run of broken.runs) {
      // Adversarial test construction only: the production decoder must never do this repair.
      run.resultSha256 = hash(JSON.stringify(run.result));
      const { runSha256: _old, ...contents } = run;
      run.runSha256 = hash(JSON.stringify(contents));
    }
    expect(() => decodeResearchAnalysisRegistry(broken)).toThrow();
  }
});

test("executing with a full host dataset preserves a reloadable three-field replay reference", () => {
  const fullDataset: ResearchDataset = {
    ...dataset,
    file: "/fixture/original.csv",
    description: "合成测试数据，原件位置不属于可复跑计算身份。",
    sourceId: "fixture-source",
    dataKind: "synthetic",
    permission: "public",
  };
  const before = structuredClone(fullDataset);
  const planned = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), plan("main"));
  const executed = execute(planned, "main", 1, { dataset: fullDataset });
  const restored = decodeResearchAnalysisRegistry(JSON.parse(JSON.stringify(executed.registry)));
  expect(restored.runs[0]!.replay.dataset).toEqual(dataset);
  expect(restored.runs[0]!.runSha256).toBe(executed.run.runSha256);
  expect(fullDataset).toEqual(before);
});

test("same-millisecond post-result registration cannot be relabeled prospective while an earlier same-time plan remains valid", () => {
  const original = plan("main", {
    registration: { ...plan("main").registration, at: at(1) },
  });
  const first = execute(
    registerResearchAnalysisPlan(createResearchAnalysisRegistry(), original),
    "main",
    1,
  );
  const additional = plan("after-result", {
    registration: {
      at: at(1),
      timing: "post-hoc",
      reason: "见到本次结果后补充，时钟仍在同一毫秒。",
      sourceRef: "fixture:observed-result",
    },
  });
  const registered = registerResearchAnalysisPlan(first.registry, additional);
  expect(decodeResearchAnalysisRegistry(JSON.parse(JSON.stringify(registered)))).toEqual(
    registered,
  );
  const forged = structuredClone(registered);
  forged.plans[1]!.registration.timing = "prospective";
  const bytes = JSON.stringify(forged);
  expect(() => decodeResearchAnalysisRegistry(forged)).toThrow("事前");
  expect(JSON.stringify(forged)).toBe(bytes);
  expect(registerResearchAnalysisPlan(registered, original)).toEqual(registered);
});

test("host registration derives prior-run witnesses and decoding rejects missing, non-prefix and future witnesses", () => {
  const main = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), plan("main"));
  const first = execute(main, "main", 1);
  const requested = plan("additional", {
    registration: {
      at: at(2),
      timing: "post-hoc",
      reason: "结果后增加",
      sourceRef: "fixture:after",
      observedPriorRunIds: ["model-invented-run"],
    },
  });
  const requestBefore = structuredClone(requested);
  const registered = registerResearchAnalysisPlan(first.registry, requested);
  expect(registered.plans[0]!.registration.observedPriorRunIds).toEqual([]);
  expect(registered.plans[1]!.registration.observedPriorRunIds).toEqual(["main-run-1"]);
  expect(requested).toEqual(requestBefore);
  const laterRun = execute(registered, "main", 3, { replayOf: first.run.id });
  expect(registerResearchAnalysisPlan(laterRun.registry, requested)).toEqual(laterRun.registry);
  expect(registerResearchAnalysisPlan(laterRun.registry, registered.plans[1]!)).toEqual(
    laterRun.registry,
  );
  for (const observed of [
    undefined,
    [],
    ["missing"],
    ["main-run-3"],
    ["main-run-1", "main-run-3"],
    ["main-run-1", "main-run-1"],
  ]) {
    const broken = structuredClone(laterRun.registry);
    if (observed === undefined) delete broken.plans[1]!.registration.observedPriorRunIds;
    else broken.plans[1]!.registration.observedPriorRunIds = observed;
    const bytes = JSON.stringify(broken);
    expect(() => decodeResearchAnalysisRegistry(broken)).toThrow();
    expect(JSON.stringify(broken)).toBe(bytes);
  }
  for (const timing of ["prospective", "legacy-unknown"] as const) {
    const old = {
      version: 1,
      plans: [plan("old", { registration: { ...plan("old").registration, timing } })],
      runs: [],
      reviews: [],
    };
    const bytes = JSON.stringify(old);
    expect(() => decodeResearchAnalysisRegistry(old)).toThrow("缺少在先运行见证");
    expect(JSON.stringify(old)).toBe(bytes);
  }
});

test("standalone CR inside quoted CSV fields preserves physical row selection and rejects an interior line", () => {
  const original = 'x,y,note\r1,3,"two\rlines"\r2,5,plain\r3,7,last\r';
  const pinned = { ...dataset, sha256: hash(original) };
  const description = plan("physical", {
    dataset: { id: pinned.id, sha256: pinned.sha256 },
    method: "describe",
    outcome: undefined,
    columns: ["x"],
    parameters: { missingPolicy: "per-variable" },
    outputs: ["descriptive"],
  });
  const registered = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), description);
  const result = execute(registered, "physical", 1, { csv: original, dataset: pinned });
  expect(result.run.sample.selectedSourceLines).toEqual([2, 4, 5]);
  expect(result.calculationInput).toContain('"two\rlines"');
  expect(decodeResearchAnalysisRegistry(JSON.parse(JSON.stringify(result.registry)))).toEqual(
    result.registry,
  );
  const selection = (line: number) =>
    registerResearchAnalysisPlan(createResearchAnalysisRegistry(), {
      ...description,
      sample: {
        mode: "selected-rows",
        id: "one-record",
        sourceLines: [line],
        reason: "按原件物理行明确选择",
      },
    });
  expect(() => execute(selection(3), "physical", 1, { csv: original, dataset: pinned })).toThrow(
    "多行字段内部",
  );
  const selected = execute(selection(4), "physical", 1, { csv: original, dataset: pinned });
  expect(selected.run.sample.selectedSourceLines).toEqual([4]);
  expect(selected.run.result.descriptive).toEqual({
    x: { n: 1, missing: 0, mean: 2, sd: null, median: 2, min: 2, max: 2 },
  });
});
