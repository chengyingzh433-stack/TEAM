import { isCurrentResearchAnalysis } from "../../electron/research-group/paper-pipeline";
import { registeredAnalysisAcceptanceIssues } from "../../electron/research-group/analysis-registry-state";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RESEARCH_ROLES, type ResearchRole } from "../../contracts/research-group";
import {
  applyRegisteredAnalysisTool,
  adoptRegisteredAnalysisPlanInput,
} from "../../electron/research-group/registered-analysis-tools";
import {
  registerResearchAnalysisPlan,
  recordRegisteredAnalysisReview,
} from "../../electron/research-group/analysis-registry";
import {
  bindFusionNativeRun,
  dispatchFusionAttempt,
  prepareFusionDelivery,
} from "../../electron/research-group/fusion-task-runtime";
import { researchHash } from "../../electron/research-group/materials";
import {
  captureAnalysisNativeContext,
  reuseRegisteredResearchAnalysis,
  hasCurrentAnalysisRunAdoption,
  hasCurrentAnalysisRead,
  type AnalysisReuseProject,
  evaluateAnalysisReuse,
  recordAnalysisOperationReceipt,
  recordAnalysisReviewContext,
  hasCurrentAnalysisReviewContext,
  decodeAnalysisReuseRecords,
} from "../../electron/research-group/analysis-result-reuse";

const time = (n: number) => new Date(Date.UTC(2026, 10, 8, 3, 0, n)).toISOString();
const csv = "x,z,y\n1,0,3\n2,1,5\n3,0,8\n4,1,9\n5,0,12\n6,1,12\n";
async function fixture(changedPlan = "comparison") {
  const workspace = await mkdtemp(join(tmpdir(), "analysis-reuse-unit-")),
    file = join(workspace, "synthetic.csv");
  await writeFile(file, csv);
  const model = {
    provider: "unit-provider",
    modelId: "unit-model",
    thinkingLevel: "high" as const,
  };
  const p: AnalysisReuseProject = {
    id: randomUUID(),
    root: { workspaceId: workspace, sessionId: "mentor" },
    workspacePath: workspace,
    objective: "合成单元夹具，不是真实provider或研究结论",
    revision: 1,
    status: "running",
    createdAt: time(0),
    updatedAt: time(0),
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "materials",
    goal: "paper",
    path: "quantitative",
    scope: "paper",
    currentStage: "analysis",
    knowledge: { directory: workspace, sha256: "fixture", version: "fixture", count: 0 },
    evidence: {
      directory: workspace,
      sources: [],
      datasets: [
        {
          id: "DATA",
          file,
          sha256: researchHash(csv),
          description: "合成CSV",
          sourceId: "SYNTHETIC",
          dataKind: "synthetic",
          permission: "user-authorized",
          delimiter: ",",
        },
      ],
    },
    stages: [
      {
        id: "analysis",
        title: "合成分析",
        goal: "软件证据",
        deliverables: "实际运行",
        models: Object.fromEntries(RESEARCH_ROLES.map((r) => [r, model])),
      },
    ],
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
  };
  const start = (role: ResearchRole, epoch: string, at: number) => {
    const delivery = prepareFusionDelivery(
      p,
      role,
      `${epoch}-${role}`,
      time(at),
      "单元测试native身份夹具",
    );
    expect(delivery.kind).toBe("dispatch");
    dispatchFusionAttempt(p, delivery.attemptId!, time(at));
    bindFusionNativeRun(p, role, `${epoch}-native-${role}`);
  };
  for (const role of ["lead", "reviewer"] as const) start(role, "original", 0);
  let serial = 0;
  const tool = (role: ResearchRole, input: Record<string, unknown>) =>
    applyRegisteredAnalysisTool(p, role, `original-call-${++serial}`, input, time(serial));
  for (const id of ["primary", "comparison", "describe"])
    await tool("lead", {
      operation: "register-analysis",
      plan: {
        id,
        version: 1,
        label: id,
        purpose: id === "primary" ? "primary" : id === "comparison" ? "comparison" : "descriptive",
        objective: "有限观察关联",
        dataset: { id: "DATA" },
        method: id === "describe" ? "describe" : "ols",
        columns: id === "primary" ? ["x", "z"] : id === "describe" ? ["x", "z", "y"] : ["x"],
        ...(id === "describe" ? {} : { outcome: "y" }),
        parameters: {},
        outputs:
          id === "describe"
            ? ["descriptive"]
            : ["regression.coefficients", "regression.rSquared", "regression.sampleSize"],
        reviewPlan: "B实读与解释审阅",
        registrationReason: "合成事前方案",
        timing: "prospective",
        sample: { mode: "all" },
        ...(id === "comparison"
          ? { compareWith: { planId: "primary", planVersion: 1, requireSameSample: true } }
          : {}),
      },
    });
  for (const planId of ["primary", "comparison", "describe"]) {
    await tool("lead", { operation: "run-analysis", planId, planVersion: 1 });
    const original = p.analysisRegistry!.runs.at(-1)!;
    await tool("reviewer", {
      operation: "run-analysis",
      planId,
      planVersion: 1,
      replayOf: original.id,
    });
  }
  for (const a of p.fusion!.attempts) {
    a.state = "succeeded";
    a.finishedAt = time(20);
    a.usedTokens = 10;
    p.events.push({
      id: randomUUID(),
      at: time(20),
      revision: 1,
      type: "finished",
      role: p.fusion!.tasks.find((t) => t.id === a.taskId)!.role as ResearchRole,
      runId: a.nativeRunId,
      detail: "单元夹具真实结束边界",
    });
  }
  p.analysisRegistry = recordRegisteredAnalysisReview(p.analysisRegistry!, {
    id: "old-interpretation",
    planId: "primary",
    planVersion: 1,
    runId: p.analysisRegistry!.runs.find(
      (run) => run.planId === "primary" && run.actor === "model:lead",
    )!.id,
    kind: "interpretation-review",
    at: time(21),
    actor: "model:reviewer",
    verdict: "accept",
    evidenceRef: "tool:old-interpretation",
    note: "旧模型意见，不能变成本轮审阅或human裁定",
  });
  const oldComparison = p.analysisRegistry!.plans.find((plan) => plan.id === changedPlan)!;
  p.analysisRegistry = registerResearchAnalysisPlan(p.analysisRegistry!, {
    ...oldComparison,
    version: 2,
    columns: ["z"],
    registration: {
      at: time(30),
      timing: "post-hoc",
      reason: "只改变比较模型自变量",
      sourceRef: "unit:explicit-change",
    },
  });
  p.activeAnalysisPlans = p.activeAnalysisPlans!.map((plan) =>
    plan.id === changedPlan ? { id: plan.id, version: 2 } : plan,
  );
  adoptRegisteredAnalysisPlanInput(p, changedPlan, 2, time(30));
  for (const role of ["lead", "reviewer"] as const) start(role, "current", 40);
  const run = (role: "lead" | "reviewer", id = "primary") =>
    p.analysisRegistry!.runs.find((r) => r.planId === id && r.actor === `model:${role}`)!;
  const archive = dirname(p.analyses!.find((r) => r.id === run("lead").id)!.file);
  return { p, run, file, archive, start };
}

test("explicitly reuse only an unchanged finished result while retaining immutable registry, projection and archive bytes", async () => {
  const s = await fixture(),
    before = structuredClone({
      registry: s.p.analysisRegistry,
      analyses: s.p.analyses,
      fusion: s.p.fusion,
    });
  const bytes = await readFile(join(s.archive, "registered-run.json"));
  expect(hasCurrentAnalysisRunAdoption(s.p, s.run("lead").id)).toBe(false);
  await reuseRegisteredResearchAnalysis(
    s.p,
    captureAnalysisNativeContext(s.p, "lead"),
    "reuse-main",
    s.run("lead").id,
    "仅比较模型变化，明确采用未变主分析",
    time(41),
  );
  expect(hasCurrentAnalysisRunAdoption(s.p, s.run("lead").id)).toBe(true);
  expect(hasCurrentAnalysisRunAdoption(s.p, s.run("lead", "describe").id)).toBe(false);
  expect(hasCurrentAnalysisRead(s.p, "lead", s.run("lead").id)).toBe(false);
  expect(s.p.analysisRegistry).toEqual(before.registry);
  expect(s.p.analyses).toEqual(before.analyses);
  expect(s.p.fusion).toEqual(before.fusion);
  expect(await readFile(join(s.archive, "registered-run.json"))).toEqual(bytes);
});

const ledgers = (p: AnalysisReuseProject) => ({
  analysisRunAdoptions: p.analysisRunAdoptions,
  analysisReads: p.analysisReads,
  analysisReviewContexts: p.analysisReviewContexts,
});
const adopt = async (
  s: Awaited<ReturnType<typeof fixture>>,
  role: "lead" | "reviewer" = "lead",
  id = "primary",
  callId = `adopt-${role}-${id}`,
) =>
  reuseRegisteredResearchAnalysis(
    s.p,
    captureAnalysisNativeContext(s.p, role),
    callId,
    s.run(role, id).id,
    "明确复用其他计划变更未影响的固定计算",
    time(41),
  );

test("historical reads never become current automatically; actual reads and production results require their captured current native", async () => {
  const s = await fixture(),
    lead = captureAnalysisNativeContext(s.p, "lead"),
    reviewer = captureAnalysisNativeContext(s.p, "reviewer"),
    id = s.run("lead").id;
  const historical = await recordAnalysisOperationReceipt(
    s.p,
    lead,
    "history-read",
    "read-registered-analysis",
    id,
    time(41),
  );
  expect(historical.usableForCurrentInputs).toBe(false);
  await adopt(s);
  expect(hasCurrentAnalysisRead(s.p, "lead", id)).toBe(false);
  expect(s.p.analysisReads!.find((entry) => entry.id === historical.id)).toEqual(historical);
  const actual = await recordAnalysisOperationReceipt(
    s.p,
    lead,
    "current-read",
    "read-registered-analysis",
    id,
    time(42),
  );
  expect(actual.usableForCurrentInputs).toBe(true);
  expect(actual.adoptionId).toBe(s.p.analysisRunAdoptions![0]!.id);
  expect(hasCurrentAnalysisRead(s.p, "lead", id)).toBe(true);
  expect(hasCurrentAnalysisRead(s.p, "reviewer", id)).toBe(false);
  await expect(
    recordAnalysisOperationReceipt(s.p, reviewer, "fake-execution", "run-analysis", id, time(42)),
  ).rejects.toThrow(/本次实际native/);
  await applyRegisteredAnalysisTool(
    s.p,
    "lead",
    "new-actual-run",
    { operation: "run-analysis", planId: "primary", planVersion: 1 },
    time(43),
  );
  const newId = s.p.analysisRegistry!.runs.at(-1)!.id;
  const execution = await recordAnalysisOperationReceipt(
    s.p,
    lead,
    "new-actual-run",
    "run-analysis",
    newId,
    time(43),
  );
  expect(execution.usableForCurrentInputs).toBe(true);
  expect(execution.adoptionId).toBeUndefined();
  expect(hasCurrentAnalysisRead(s.p, "lead", newId)).toBe(true);
});

test("B reuses only its own matching replay after A adoption, preserving six original runs", async () => {
  const s = await fixture();
  expect(evaluateAnalysisReuse(s.p, "reviewer", s.run("reviewer").id).eligible).toBe(false);
  await expect(
    reuseRegisteredResearchAnalysis(
      s.p,
      captureAnalysisNativeContext(s.p, "reviewer"),
      "wrong-role",
      s.run("lead").id,
      "不能借用A身份",
      time(41),
    ),
  ).rejects.toThrow();
  await adopt(s);
  await adopt(s, "reviewer");
  expect(hasCurrentAnalysisRunAdoption(s.p, s.run("reviewer").id)).toBe(true);
  expect(s.p.analysisRegistry!.runs).toHaveLength(6);
  expect(
    s.p.analysisRegistry!.runs.find((run) => run.id === s.run("reviewer").id)!.verification,
  ).toMatchObject({ level: "same-engine-replay", replayOf: s.run("lead").id });
  expect(s.p.analysisReads ?? []).toHaveLength(6);
});

test("old semantic review cannot be rebound; current B review binds an actual read and remains model evidence after native completion", async () => {
  const s = await fixture();
  await adopt(s);
  const context = captureAnalysisNativeContext(s.p, "reviewer"),
    id = s.run("lead").id;
  expect(hasCurrentAnalysisReviewContext(s.p, "old-interpretation")).toBe(false);
  expect(() =>
    recordAnalysisReviewContext(s.p, context, "old-interpretation", "old-interpretation", time(42)),
  ).toThrow(/旧审阅|本次真实/);
  const createReview = (reviewId: string, at: number) => {
    s.p.analysisRegistry = recordRegisteredAnalysisReview(s.p.analysisRegistry!, {
      id: reviewId,
      planId: "primary",
      planVersion: 1,
      runId: id,
      kind: "interpretation-review",
      at: time(at),
      actor: "model:reviewer",
      verdict: "accept",
      evidenceRef: `tool:${reviewId}`,
      note: "本轮具名B重新解释未变结果，只支持有限关联；不是human意见。",
    });
  };
  createReview("missing-read", 42);
  expect(() =>
    recordAnalysisReviewContext(s.p, context, "missing-read", "missing-read", time(42)),
  ).toThrow(/实际取得/);
  await recordAnalysisOperationReceipt(
    s.p,
    context,
    "B-current-read",
    "read-registered-analysis",
    id,
    time(43),
  );
  createReview("new-interpretation", 44);
  const receipt = recordAnalysisReviewContext(
    s.p,
    context,
    "new-interpretation",
    "new-interpretation",
    time(44),
  );
  expect(receipt.context.role).toBe("reviewer");
  expect(hasCurrentAnalysisReviewContext(s.p, "new-interpretation")).toBe(true);
  await recordAnalysisOperationReceipt(s.p, context, "B-read-again", "read-analysis", id, time(45));
  expect(hasCurrentAnalysisReviewContext(s.p, "new-interpretation")).toBe(true);
  const attempt = s.p.fusion!.attempts.find((a) => a.id === context.attemptId)!;
  attempt.state = "succeeded";
  attempt.finishedAt = time(46);
  expect(hasCurrentAnalysisReviewContext(s.p, "new-interpretation")).toBe(true);
  expect(s.p.analysisRegistry!.reviews[0]!.at).toBe(time(21));
});

test("all six immutable archive files and the actual dataset are verified before adoption", async () => {
  const s = await fixture();
  for (const file of [
    s.file,
    ...[
      "input.csv",
      "calculation-input.csv",
      "plan.json",
      "registered-run.json",
      "result.json",
      "replay.mjs",
    ].map((file) => join(s.archive, file)),
  ]) {
    const original = await readFile(file);
    await writeFile(file, Buffer.concat([original, Buffer.from("\nTAMPERED")]));
    await expect(adopt(s)).rejects.toThrow();
    expect(s.p.analysisRunAdoptions ?? []).toEqual([]);
    await writeFile(file, original);
  }
  await adopt(s);
  expect(hasCurrentAnalysisRunAdoption(s.p, s.run("lead").id)).toBe(true);
});

test("per-call idempotence rechecks files and refuses a changed intention", async () => {
  const s = await fixture(),
    first = await adopt(s),
    context = captureAnalysisNativeContext(s.p, "lead");
  expect(await adopt(s)).toEqual(first);
  expect(s.p.analysisRunAdoptions).toHaveLength(1);
  await expect(
    reuseRegisteredResearchAnalysis(
      s.p,
      context,
      "adopt-lead-primary",
      s.run("lead").id,
      "换一个采用理由",
      time(42),
    ),
  ).rejects.toThrow(/调用身份/);
  await writeFile(join(s.archive, "replay.mjs"), "altered replay");
  await expect(adopt(s)).rejects.toThrow(/归档/);
  expect(s.p.analysisRunAdoptions).toHaveLength(1);
});

test("native identity is rechecked after real file reads, with no partial adoption or read receipt", async () => {
  const s = await fixture(),
    context = captureAnalysisNativeContext(s.p, "lead");
  let changed = false;
  await expect(
    reuseRegisteredResearchAnalysis(
      s.p,
      context,
      "racing-adopt",
      s.run("lead").id,
      "明确复用",
      time(41),
      async (file) => {
        const bytes = await readFile(file);
        if (!changed) {
          changed = true;
          s.p.fusion!.attempts.find((a) => a.id === context.attemptId)!.nativeRunId =
            "different-native";
        }
        return bytes;
      },
    ),
  ).rejects.toThrow(/身份已变化/);
  expect(s.p.analysisRunAdoptions ?? []).toEqual([]);
  expect(s.p.analysisReads ?? []).toHaveLength(6);
});

test("reuse uses the native completion time when its finished event is persisted later", async () => {
  const s = await fixture();
  const source = s.p.fusion!.attempts.find((attempt) => attempt.id === "original-lead")!;
  const finished = s.p.events.find(
    (event) => event.type === "finished" && event.runId === source.nativeRunId,
  )!;
  finished.runtimeAt = source.finishedAt;
  finished.at = time(25);
  expect(evaluateAnalysisReuse(s.p, "lead", s.run("lead").id).eligible).toBe(true);
  await adopt(s);
  expect(hasCurrentAnalysisRunAdoption(s.p, s.run("lead").id)).toBe(true);
  finished.runtimeAt = time(21);
  expect(hasCurrentAnalysisRunAdoption(s.p, s.run("lead").id)).toBe(false);
});

test("own plan and comparison-closure changes remain ineligible", async () => {
  const changedOwn = await fixture();
  expect(
    evaluateAnalysisReuse(changedOwn.p, "lead", changedOwn.run("lead", "comparison").id).eligible,
  ).toBe(false);
  const changedPrimary = await fixture("primary");
  expect(
    evaluateAnalysisReuse(changedPrimary.p, "lead", changedPrimary.run("lead", "comparison").id)
      .eligible,
  ).toBe(false);
});

for (const mode of [
  "late-finish",
  "unknown",
  "failed",
  "cancelled",
  "cross-revision",
  "unexplained-version",
  "non-plan-change",
] as const)
  test(`rejects unsafe source or epoch: ${mode}`, async () => {
    const s = await fixture(),
      source = s.p.fusion!.attempts.find((a) => a.id === "original-lead")!;
    if (mode === "late-finish") source.finishedAt = time(31);
    else if (["unknown", "failed", "cancelled"].includes(mode))
      source.state = mode as "unknown" | "failed" | "cancelled";
    else if (mode === "cross-revision") s.p.revision = 2;
    else if (mode === "unexplained-version") {
      s.p.fusion!.tasks.find((t) => t.id === "v1:analysis:lead")!.inputVersion++;
      s.p.fusion!.attempts.find((a) => a.id === "current-lead")!.taskVersion++;
    } else s.p.fusion!.changes.find((c) => c.at === time(30))!.inputId = "dataset:DATA";
    expect(evaluateAnalysisReuse(s.p, "lead", s.run("lead").id).eligible).toBe(false);
    expect(s.p.analysisRunAdoptions ?? []).toEqual([]);
  });

test("strict saved records roundtrip; changed hash, forged host identity and broken adoption links are rejected", async () => {
  const s = await fixture();
  await adopt(s);
  await recordAnalysisOperationReceipt(
    s.p,
    captureAnalysisNativeContext(s.p, "lead"),
    "actual-read",
    "read-analysis",
    s.run("lead").id,
    time(42),
  );
  const raw: unknown = JSON.parse(JSON.stringify(ledgers(s.p)));
  expect(decodeAnalysisReuseRecords(raw, s.p)).toEqual(ledgers(s.p));
  const altered = structuredClone(ledgers(s.p));
  altered.analysisRunAdoptions![0]!.reason = "tampered reason";
  expect(() => decodeAnalysisReuseRecords(altered, s.p)).toThrow(/integrity/);
  const broken = structuredClone(ledgers(s.p));
  broken.analysisReads![0]!.adoptionId = "missing-adoption";
  expect(() => decodeAnalysisReuseRecords(broken, s.p)).toThrow();
  const forged = structuredClone(ledgers(s.p));
  forged.analysisRunAdoptions![0]!.target.nativeRunId = "invented";
  const { integritySha256: ignored, ...body } = forged.analysisRunAdoptions![0]!;
  void ignored;
  forged.analysisRunAdoptions![0]!.integritySha256 = researchHash(JSON.stringify(body));
  expect(() => decodeAnalysisReuseRecords(forged, s.p)).toThrow(/断引用/);
  expect(() =>
    decodeAnalysisReuseRecords({ ...(raw as object), humanConfirmed: true }, s.p),
  ).toThrow();
});

test("a later independent plan change expires adoption, actual reads and B context without rewriting their history", async () => {
  const s = await fixture();
  await adopt(s);
  const b = captureAnalysisNativeContext(s.p, "reviewer"),
    id = s.run("lead").id;
  await recordAnalysisOperationReceipt(s.p, b, "B-read", "read-analysis", id, time(42));
  s.p.analysisRegistry = recordRegisteredAnalysisReview(s.p.analysisRegistry!, {
    id: "current-review",
    planId: "primary",
    planVersion: 1,
    runId: id,
    kind: "interpretation-review",
    actor: "model:reviewer",
    at: time(43),
    evidenceRef: "tool:current-review",
    verdict: "accept",
    note: "本轮实际解释有限结果",
  });
  recordAnalysisReviewContext(s.p, b, "current-review", "current-review", time(43));
  const before = structuredClone(ledgers(s.p));
  for (const attempt of s.p.fusion!.attempts.filter((a) => a.state === "running")) {
    attempt.state = "succeeded";
    attempt.finishedAt = time(45);
  }
  const original = s.p.analysisRegistry!.plans.find((plan) => plan.id === "describe")!;
  s.p.analysisRegistry = registerResearchAnalysisPlan(s.p.analysisRegistry!, {
    ...original,
    version: 2,
    columns: ["z"],
    registration: {
      at: time(50),
      timing: "post-hoc",
      sourceRef: "unit:second-change",
      reason: "仅描述计划变化",
    },
  });
  s.p.activeAnalysisPlans = s.p.activeAnalysisPlans!.map((plan) =>
    plan.id === "describe" ? { id: plan.id, version: 2 } : plan,
  );
  adoptRegisteredAnalysisPlanInput(s.p, "describe", 2, time(50));
  for (const role of ["lead", "reviewer"] as const) s.start(role, "third", 60);
  expect(hasCurrentAnalysisRunAdoption(s.p, id)).toBe(false);
  expect(hasCurrentAnalysisRead(s.p, "reviewer", id)).toBe(false);
  expect(hasCurrentAnalysisReviewContext(s.p, "current-review")).toBe(false);
  expect(decodeAnalysisReuseRecords(ledgers(s.p), s.p)).toEqual(before);
  expect(evaluateAnalysisReuse(s.p, "lead", id).eligible).toBe(true);
  expect(s.p.analysisRegistry!.runs).toHaveLength(6);
});

test("backdated operations and reconstructed forged receipt ids fail strictly", async () => {
  const s = await fixture(),
    context = captureAnalysisNativeContext(s.p, "lead");
  await expect(
    reuseRegisteredResearchAnalysis(
      s.p,
      context,
      "backdated",
      s.run("lead").id,
      "明确复用",
      time(39),
    ),
  ).rejects.toThrow(/时间/);
  await adopt(s);
  const forged = structuredClone(ledgers(s.p));
  forged.analysisRunAdoptions![0]!.id = "invented-adoption-id";
  const { integritySha256: ignored, ...body } = forged.analysisRunAdoptions![0]!;
  void ignored;
  forged.analysisRunAdoptions![0]!.integritySha256 = researchHash(JSON.stringify(body));
  expect(() => decodeAnalysisReuseRecords(forged, s.p)).toThrow(/ID/);
  const invalidTime = structuredClone(ledgers(s.p));
  invalidTime.analysisRunAdoptions![0]!.at = time(39);
  const { integritySha256: ignoredTime, ...datedBody } = invalidTime.analysisRunAdoptions![0]!;
  void ignoredTime;
  invalidTime.analysisRunAdoptions![0]!.integritySha256 = researchHash(JSON.stringify(datedBody));
  expect(() => decodeAnalysisReuseRecords(invalidTime, s.p)).toThrow(/时间/);
});

test("an actual read rejects a native change during archive verification", async () => {
  const s = await fixture();
  await adopt(s);
  const context = captureAnalysisNativeContext(s.p, "reviewer");
  let changed = false;
  await expect(
    recordAnalysisOperationReceipt(
      s.p,
      context,
      "racing-read",
      "read-analysis",
      s.run("lead").id,
      time(42),
      async (file) => {
        const bytes = await readFile(file);
        if (!changed) {
          changed = true;
          s.p.fusion!.attempts.find((a) => a.id === context.attemptId)!.nativeRunId =
            "late-other-run";
        }
        return bytes;
      },
    ),
  ).rejects.toThrow(/身份已变化/);
  expect(s.p.analysisReads ?? []).toHaveLength(6);
});

test("decoder rejects a forged archive hash even when its outer integrity hash was recomputed", async () => {
  const s = await fixture();
  await adopt(s);
  const forged = structuredClone(ledgers(s.p));
  forged.analysisRunAdoptions![0]!.fileHashes["replay.mjs"] = "f".repeat(64);
  const { integritySha256: ignored, ...body } = forged.analysisRunAdoptions![0]!;
  void ignored;
  forged.analysisRunAdoptions![0]!.integritySha256 = researchHash(JSON.stringify(body));
  expect(() => decodeAnalysisReuseRecords(forged, s.p)).toThrow();
});

test("the source record pins the exact saved replay bytes for readers from another build", async () => {
  const s = await fixture();
  const run = s.p.analyses![0]!;
  const script = await readFile(join(dirname(run.file), "replay.mjs"));
  expect(run).toHaveProperty("replayScriptSha256", researchHash(script));
  const saved = JSON.parse(await readFile(run.file, "utf8")) as Record<string, unknown>;
  expect(saved.replayScriptSha256).toBe(researchHash(script));
  await adopt(s);
  expect(hasCurrentAnalysisRunAdoption(s.p, run.id)).toBe(true);
});

test("real tool reuse restores only unchanged runs and requires new B interpretation", async () => {
  const s = await fixture();
  const before = structuredClone({ runs: s.p.analysisRegistry!.runs, projections: s.p.analyses });
  const effect = await applyRegisteredAnalysisTool(
    s.p,
    "lead",
    "tool-reuse-A",
    {
      operation: "reuse-analysis",
      analysisId: s.run("lead").id,
      reason: "仅比较模型变化，采用原主分析",
    },
    time(41),
  );
  expect(effect.analysisId).toBe(s.run("lead").id);
  expect(hasCurrentAnalysisRunAdoption(s.p, s.run("lead").id)).toBe(true);
  expect(hasCurrentAnalysisRead(s.p, "lead", s.run("lead").id)).toBe(false);
  await applyRegisteredAnalysisTool(
    s.p,
    "reviewer",
    "tool-reuse-B",
    {
      operation: "reuse-analysis",
      analysisId: s.run("reviewer").id,
      reason: "本人原主分析复跑仍未变化",
    },
    time(42),
  );
  await expect(
    applyRegisteredAnalysisTool(
      s.p,
      "reviewer",
      "too-early-review",
      {
        operation: "review-analysis",
        planId: "primary",
        planVersion: 1,
        analysisId: s.run("lead").id,
        verdict: "accept",
        content: "不能借旧读取恢复解释",
      },
      time(43),
    ),
  ).rejects.toThrow(/实际读取/);
  await applyRegisteredAnalysisTool(
    s.p,
    "reviewer",
    "actual-new-read",
    {
      operation: "read-registered-analysis",
      analysisId: s.run("lead").id,
    },
    time(44),
  );
  const review = await applyRegisteredAnalysisTool(
    s.p,
    "reviewer",
    "actual-new-review",
    {
      operation: "review-analysis",
      planId: "primary",
      planVersion: 1,
      analysisId: s.run("lead").id,
      verdict: "accept",
      content: "本轮重新审阅实际样本及结果，仅作有限关联解释",
    },
    time(45),
  );
  expect(hasCurrentAnalysisReviewContext(s.p, (review.result as { id: string }).id)).toBe(true);
  expect(s.p.analysisRegistry!.runs).toEqual(before.runs);
  expect(s.p.analyses).toEqual(before.projections);
});

test("replaced source metadata leaves archived registered runs viewable without current authority", async () => {
  const s = await fixture();
  s.p.evidence!.datasets = [];
  s.p.activeAnalysisPlans = [];
  const result = await applyRegisteredAnalysisTool(
    s.p,
    "reviewer",
    "historical-only",
    {
      operation: "read-registered-analysis",
      analysisId: s.run("lead").id,
    },
    time(41),
  );
  expect(result.result).toMatchObject({ id: s.run("lead").id, validForCurrentInputs: false });
  expect(hasCurrentAnalysisRead(s.p, "reviewer", s.run("lead").id)).toBe(false);
});

test("a single comparison change performs only two new runs while unchanged plans require explicit adoption and fresh B reviews", async () => {
  const s = await fixture(),
    originalRuns = structuredClone(s.p.analysisRegistry!.runs),
    originalProjections = structuredClone(s.p.analyses);
  const originalFiles = await Promise.all(
    s.p.analyses!.map(async (run) => [run.file, await readFile(run.file)] as const),
  );
  let serial = 41;
  const tool = (role: ResearchRole, input: Record<string, unknown>) =>
    applyRegisteredAnalysisTool(s.p, role, `local-change-${serial}`, input, time(serial++));
  const currentIds = () =>
    s.p.analyses!.filter((run) => isCurrentResearchAnalysis(s.p, run)).map((run) => run.id);
  for (const planId of ["primary", "describe"]) {
    for (const role of ["lead", "reviewer"] as const)
      await tool(role, {
        operation: "reuse-analysis",
        analysisId: s.run(role, planId).id,
        reason: "计划闭包、数据和引擎未变，明确采用本人结果",
      });
    expect(
      registeredAnalysisAcceptanceIssues(s.p, currentIds()).some(
        (issue) => issue.startsWith(planId) && issue.includes("接受意见"),
      ),
    ).toBe(true);
    await tool("reviewer", {
      operation: "read-registered-analysis",
      analysisId: s.run("lead", planId).id,
    });
    await tool("reviewer", {
      operation: "review-analysis",
      planId,
      planVersion: 1,
      analysisId: s.run("lead", planId).id,
      verdict: "accept",
      content: "本轮实际读取后重新解释；仅支持合成结果的有限关系",
    });
  }
  const a = await tool("lead", { operation: "run-analysis", planId: "comparison", planVersion: 2 });
  const b = await tool("reviewer", {
    operation: "run-analysis",
    planId: "comparison",
    planVersion: 2,
    replayOf: a.analysisId,
  });
  await tool("reviewer", {
    operation: "review-analysis",
    planId: "comparison",
    planVersion: 2,
    analysisId: b.analysisId,
    verdict: "accept",
    content: "本轮比较模型重新实算和复跑，解释限定于该样本",
  });
  expect(s.p.analysisRegistry!.runs).toHaveLength(8);
  expect(currentIds()).toHaveLength(6);
  expect(registeredAnalysisAcceptanceIssues(s.p, currentIds())).toEqual([]);
  expect(s.p.analysisRegistry!.runs.slice(0, 6)).toEqual(originalRuns);
  expect(s.p.analyses!.slice(0, 6)).toEqual(originalProjections);
  for (const [file, bytes] of originalFiles) expect(await readFile(file)).toEqual(bytes);
});
