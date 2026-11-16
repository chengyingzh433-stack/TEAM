import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  RESEARCH_ROLES,
  type ResearchArtifact,
  type ResearchRole,
} from "../../contracts/research-group";
import { decodeResearchContentChecks } from "../../contracts/research-content-checks";
import type { ResearchResultFieldMetadata } from "../../contracts/research-numeric-bindings";
import {
  prepareNumericAcceptance,
  requiresNumericAcceptance,
  assertNumericAcceptanceReceipt,
  type NumericAcceptanceProject,
  type NumericAcceptanceReceipt,
} from "../../electron/research-group/numeric-acceptance";
import { applyNumericBindingTool } from "../../electron/research-group/numeric-binding-tools";
import { applyRegisteredAnalysisTool } from "../../electron/research-group/registered-analysis-tools";
import {
  prepareFusionDelivery,
  dispatchFusionAttempt,
  bindFusionNativeRun,
  finishFusionNativeRun,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import { finishResearchTaskAttempt } from "../../electron/research-group/task-graph";
import { researchHash } from "../../electron/research-group/materials";
import { join } from "node:path";
import { researchAcceptanceTaskContext } from "../../electron/research-group/acceptance-context";

const at = (n: number) => new Date(Date.UTC(2026, 10, 7, 16, 0, n)).toISOString();
const csv = "x,y\n1,8\n2,6\n3,4\n4,2\n5,0\n";
async function fixture(body = "n=5；R²=1.000；β=-2.00 分/小时。参考2025。") {
  const workspace = await mkdtemp(join(tmpdir(), "numeric-acceptance-")),
    file = join(workspace, "synthetic.csv");
  await writeFile(file, csv);
  const p: NumericAcceptanceProject = {
    id: randomUUID(),
    root: { workspaceId: workspace, sessionId: "mentor" },
    workspacePath: workspace,
    objective: "合成软件门禁演练，不是实际研究许可或人类审阅。",
    revision: 1,
    status: "running",
    createdAt: at(0),
    updatedAt: at(0),
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
          description: "闭式合成关系 y=10-2x",
          sourceId: "fixture",
          dataKind: "synthetic",
          permission: "user-authorized",
          delimiter: ",",
        },
      ],
    },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
  };
  const start = (stage: string, time: number) => {
    for (const role of ["lead", "reviewer", "mentor"] as const) {
      const delivery = prepareFusionDelivery(
        p,
        role,
        `${stage}-${role}`,
        at(time),
        "合成宿主状态夹具，不代表E/R运行",
      );
      expect(delivery.kind).toBe("dispatch");
      dispatchFusionAttempt(p, delivery.attemptId!, at(time));
      bindFusionNativeRun(p, role, `native-${stage}-${role}`);
      p.fusion!.attempts.find((a) => a.id === delivery.attemptId)!.model = {
        provider: "unit-provider",
        modelId: "unit-model",
      };
    }
  };
  start("analysis", 0);
  await applyRegisteredAnalysisTool(
    p,
    "lead",
    "plan",
    {
      operation: "register-analysis",
      plan: {
        id: "main",
        version: 1,
        label: "主OLS",
        purpose: "primary",
        objective: "与闭式关系核对",
        dataset: { id: "DATA" },
        method: "ols",
        columns: ["x"],
        outcome: "y",
        parameters: {},
        outputs: ["regression.sampleSize", "regression.rSquared", "regression.coefficients"],
        reviewPlan: "核对原始结果及单位",
        registrationReason: "合成工具测试事前登记",
        timing: "prospective",
        sample: { mode: "all" },
      },
    },
    at(1),
  );
  await applyRegisteredAnalysisTool(
    p,
    "lead",
    "run",
    { operation: "run-analysis", planId: "main", planVersion: 1 },
    at(2),
  );
  const run = p.analysisRegistry!.runs[0]!;
  // Only the prior-stage graph boundary is a fixture. Registry calculation and files are real.
  const prior: ResearchArtifact = {
    id: "analysis-boundary",
    role: "mentor",
    kind: "stage-review",
    revision: 1,
    round: 1,
    createdAt: at(3),
    content: "合成前阶段边界夹具，非本测试审阅结论",
    refs: [],
    verdict: "accept",
    toolCallId: "fixture-boundary",
    stage: "analysis",
  };
  p.artifacts.push(prior);
  publishFusionArtifact(p, prior);
  for (const attempt of [...p.fusion!.attempts])
    p.fusion = finishResearchTaskAttempt(p.fusion!, attempt.id, { at: at(4), usedTokens: 1 });
  p.currentStage = "writing";
  start("writing", 5);
  const readRun = async (role: ResearchRole) => {
    const effect = await applyRegisteredAnalysisTool(
      p,
      role,
      `read-${role}`,
      { operation: "read-registered-analysis", analysisId: run.id },
      at(6),
    );
    p.events.push({
      id: randomUUID(),
      revision: 1,
      at: at(6),
      type: "analysis",
      role,
      analysisId: run.id,
      detail: effect.detail!,
    });
  };
  for (const role of ["lead", "reviewer", "mentor"] as const) await readRun(role);
  let serial = 10;
  const numeric = async (
    role: ResearchRole,
    input: Record<string, unknown>,
    callId = `number-${++serial}`,
  ) =>
    (await applyNumericBindingTool(p, role, callId, input, at(++serial))).result as Record<
      string,
      unknown
    >;
  const declaration = (
    await numeric("lead", {
      operation: "declare-result-field",
      runId: run.id,
      path: ["regression", "coefficients", "x"],
      quantity: "coefficient",
      unit: "分/小时",
      content: "合成变量x以小时计、y以分计，不能据此推断真实课题单位。",
    })
  ).metadata as ResearchResultFieldMetadata;
  const verified = (
    await numeric("reviewer", {
      operation: "review-result-field",
      metadataId: declaration.id,
      content: "实际读过合成结果，按夹具变量定义复核系数单位；模型意见。",
    })
  ).metadata as ResearchResultFieldMetadata;
  const publish = (content: string, id: string): ResearchArtifact => {
    const artifact: ResearchArtifact = {
      id,
      role: "lead",
      kind: "stage-revision",
      revision: 1,
      round: 1,
      createdAt: at(20),
      content,
      refs: [],
      analysisIds: [run.id],
      stage: "writing",
      toolCallId: `publish-${id}`,
    };
    p.artifacts.push(artifact);
    publishFusionArtifact(p, artifact);
    for (const role of ["lead", "reviewer", "mentor"] as const)
      p.events.push({
        id: randomUUID(),
        revision: 1,
        at: at(21),
        type: "read",
        role,
        artifactId: id,
        stage: "writing",
        detail: "合成夹具中宿主读取完整不可变正文",
      });
    return artifact;
  };
  const artifact = publish(body, "writing-revision");
  const request = (
    target: ResearchArtifact,
    text: string,
    field: "n" | "r2" | "beta",
    unit = field === "beta" ? "分/小时" : "",
  ) => ({
    artifactId: target.id,
    start: target.content.indexOf(text),
    end: target.content.indexOf(text) + text.length,
    runId: run.id,
    path:
      field === "n"
        ? ["regression", "sampleSize"]
        : field === "r2"
          ? ["regression", "rSquared"]
          : ["regression", "coefficients", "x"],
    ...(field === "beta" ? { fieldMetadataId: verified.id } : {}),
    quantity: field === "n" ? "sample-size" : field === "r2" ? "r-squared" : "coefficient",
    unit,
    decimalPlaces: field === "n" ? 0 : field === "r2" ? 3 : 2,
    rounding: "half-away-from-zero",
    unitSeparator: field === "beta" ? " " : "",
  });
  const bindCorrect = async (target = artifact) => {
    for (const [text, field] of [
      ["5", "n"],
      ["1.000", "r2"],
      ["-2.00 分/小时", "beta"],
    ] as const)
      await numeric("lead", { operation: "numeric-bind", binding: request(target, text, field) });
  };
  const dismissYear = async (target = artifact) =>
    numeric("reviewer", {
      operation: "numeric-candidate-review",
      artifactId: target.id,
      start: target.content.indexOf("2025"),
      end: target.content.indexOf("2025") + 4,
      classification: "non-result-number",
      reason: "明确作为参考文献出版年份，不是本研究结果。",
    });
  const input = (target = artifact, role: "reviewer" | "mentor" = "reviewer") => ({
    operation: "publish",
    kind: role === "reviewer" ? "stage-verification" : "stage-review",
    stage: "writing",
    verdict: "accept",
    content: "模型内容意见与数值程序检查分开；此处只是合成软件验收。",
    refs: [target.id],
    analysisIds: [run.id],
  });
  return { p, file, run, artifact, numeric, publish, request, bindCorrect, dismissYear, input };
}

test("four incorrect numeric declarations are rejected and formal acceptance retains a blocked program record", async () => {
  const s = await fixture("n=6；R²=0.900；β=2.00 分/小时；单位=-2.00 秒。参考2025。");
  for (const [fragment, field, unit] of [
    ["6", "n", ""],
    ["0.900", "r2", ""],
    ["2.00 分/小时", "beta", "分/小时"],
    ["-2.00 秒", "beta", "秒"],
  ] as const)
    await expect(
      s.numeric("lead", {
        operation: "numeric-bind",
        binding: s.request(s.artifact, fragment, field, unit),
      }),
    ).rejects.toThrow(/display-mismatch|unit-mismatch/);
  expect(s.p.numericBindings ?? []).toEqual([]);
  const result = await prepareNumericAcceptance(s.p, "reviewer", "accept-bad", s.input(), at(40));
  expect(result).toMatchObject({ required: true, blocked: true });
  expect(result.receipt).toBeUndefined();
  expect(s.p.contentChecks).toHaveLength(1);
  const check = s.p.contentChecks![0]!;
  expect(check.program).toEqual({ kind: "program", id: "numeric-acceptance-1" });
  expect(check.target!.artifactId).toBe(s.artifact.id);
  expect(check.result).toBe("blocked");
  expect(
    check.issues.filter((issue) => issue.code === "required-primary-field-unbound"),
  ).toHaveLength(3);
  expect(check.unboundCandidates.map((candidate) => candidate.text)).toEqual([
    "6",
    "0.900",
    "2.00",
    "-2.00",
    "2025",
  ]);
  expect(decodeResearchContentChecks(s.p.contentChecks)).toEqual(s.p.contentChecks);
  expect(() =>
    decodeResearchContentChecks([{ ...check, program: { kind: "human", id: "reviewer" } }]),
  ).toThrow("程序检查身份");
  expect(() => decodeResearchContentChecks([{ ...check, result: "passed-at-snapshot" }])).toThrow(
    "不能记录为通过",
  );
});

test("correct declared rounding and individual year review pass with a private snapshot receipt, without a new run", async () => {
  const s = await fixture();
  await s.bindCorrect();
  const runs = structuredClone(s.p.analysisRegistry!.runs);
  const pending = await prepareNumericAcceptance(
    s.p,
    "reviewer",
    "accept-year-pending",
    s.input(),
    at(40),
  );
  expect(pending.blocked).toBe(true);
  expect(s.p.contentChecks![0]!.issues).toEqual([]);
  expect(s.p.contentChecks![0]!.unboundCandidates.map((candidate) => candidate.text)).toEqual([
    "2025",
  ]);
  await s.dismissYear();
  const pass = await prepareNumericAcceptance(s.p, "reviewer", "accept-correct", s.input(), at(41));
  expect(pass).toMatchObject({ required: true, blocked: false });
  expect(pass.receipt).toBeTruthy();
  await assertNumericAcceptanceReceipt(s.p, "reviewer", s.input(), pass.receipt);
  expect(s.p.contentChecks!.at(-1)!.result).toBe("passed-at-snapshot");
  expect(s.p.analysisRegistry!.runs).toEqual(runs);
  const count = s.p.contentChecks!.length;
  await prepareNumericAcceptance(s.p, "reviewer", "accept-correct", s.input(), at(42));
  expect(s.p.contentChecks).toHaveLength(count);
  await expect(
    assertNumericAcceptanceReceipt(s.p, "reviewer", s.input(), {} as NumericAcceptanceReceipt),
  ).rejects.toThrow("非宿主生成");
  await expect(
    assertNumericAcceptanceReceipt(
      s.p,
      "reviewer",
      { ...s.input(), content: "改写接受内容" },
      pass.receipt,
    ),
  ).rejects.toThrow("上下文已变化");
  const mentorInput = s.input(s.artifact, "mentor");
  const mentor = await prepareNumericAcceptance(
    s.p,
    "mentor",
    "mentor-accept",
    mentorInput,
    at(43),
  );
  expect(mentor.blocked).toBe(false);
  await assertNumericAcceptanceReceipt(s.p, "mentor", mentorInput, mentor.receipt);
  await expect(
    assertNumericAcceptanceReceipt(s.p, "mentor", mentorInput, pass.receipt),
  ).rejects.toThrow("非宿主生成");
});

for (const role of ["reviewer", "mentor"] as const) {
  test(`numeric ${role} acceptance survives another producer finishing its native turn after prepare`, async () => {
    const s = await fixture();
    await s.bindCorrect();
    await s.dismissYear();
    for (const currentRole of ["lead", role])
      s.p.members.find((member) => member.role === currentRole)!.status = "running";
    const input = s.input(s.artifact, role);
    const evidence = () => ({
      artifacts: s.p.artifacts,
      graphArtifacts: s.p.fusion!.artifacts,
      sources: s.p.evidence,
      registry: s.p.analysisRegistry,
      analyses: s.p.analyses,
      activePlans: s.p.activeAnalysisPlans,
      analysisReads: s.p.analysisReads,
      adoptions: s.p.analysisRunAdoptions,
      reviewContexts: s.p.analysisReviewContexts,
      bindings: s.p.numericBindings,
      metadata: s.p.numericFieldMetadata,
      candidateReviews: s.p.numericCandidateReviews,
      inputs: s.p.fusion!.inputs,
      adoptedInputs: s.p.fusion!.adoptedInputs,
      decisions: s.p.fusion!.decisions,
      acceptingAttempt: s.p.fusion!.attempts.find((attempt) => attempt.id === `writing-${role}`),
      acceptingTask: s.p.fusion!.tasks.find((task) => task.id === `v1:writing:${role}`),
    });
    const unchanged = structuredClone(evidence());
    const prepared = await prepareNumericAcceptance(s.p, role, "finish-other", input, at(40));
    expect(prepared).toMatchObject({ required: true, blocked: false });
    expect(prepared.receipt).toBeTruthy();
    const contextBefore = structuredClone(researchAcceptanceTaskContext(s.p, role));
    expect(s.p.fusion!.attempts.find((attempt) => attempt.id === "writing-lead")).toMatchObject({
      state: "running",
      nativeRunId: "native-writing-lead",
    });
    finishFusionNativeRun(s.p, "lead", "native-writing-lead", at(41), {
      input: 20,
      output: 10,
      cacheRead: 3,
      cacheWrite: 1,
    });
    const producer = s.p.members.find((member) => member.role === "lead")!;
    producer.status = "idle";
    producer.finishedAt = at(41);
    s.p.updatedAt = at(41);
    s.p.events.push({
      id: randomUUID(),
      at: at(41),
      runtimeAt: at(41),
      revision: s.p.revision,
      type: "finished",
      role: "lead",
      runId: "native-writing-lead",
      detail: "合成L夹具：生产者正常结束；接受者仍持同一原生执行和实际结果读取。",
    });
    expect(s.p.fusion!.attempts.find((attempt) => attempt.id === "writing-lead")).toMatchObject({
      state: "succeeded",
      finishedAt: at(41),
      // Earlier fixture calls have no counters: the session total is known,
      // but this attempt must not absorb their unknown consumption.
      sessionTotalTokens: 34,
    });
    expect(
      s.p.fusion!.attempts.find((attempt) => attempt.id === "writing-lead")!.usedTokens,
    ).toBeUndefined();
    expect(s.p.fusion!.tasks.find((task) => task.id === "v1:writing:lead")!.state).toBe(
      "completed",
    );
    expect(evidence()).toEqual(unchanged);
    await test.info().attach("acceptance-task-context-before-after", {
      body: JSON.stringify(
        { before: contextBefore, after: researchAcceptanceTaskContext(s.p, role) },
        null,
        2,
      ),
      contentType: "application/json",
    });
    await expect(
      assertNumericAcceptanceReceipt(s.p, role, input, prepared.receipt),
    ).resolves.toBeUndefined();
    expect(s.p.contentChecks).toHaveLength(1);
  });
}

test("semantic exclusions cannot waive required primary OLS fields or actual binding errors", async () => {
  const s = await fixture();
  for (const fragment of ["5", "1.000", "-2.00", "2025"])
    await s.numeric("reviewer", {
      operation: "numeric-candidate-review",
      artifactId: s.artifact.id,
      start: s.artifact.content.indexOf(fragment),
      end: s.artifact.content.indexOf(fragment) + fragment.length,
      classification: "non-result-number",
      reason: "合成滥用测试：语义排除不得代替主OLS必要字段绑定。",
    });
  const blocked = await prepareNumericAcceptance(
    s.p,
    "reviewer",
    "waive-required",
    s.input(),
    at(40),
  );
  expect(blocked.blocked).toBe(true);
  expect(s.p.contentChecks![0]!.unboundCandidates).toEqual([]);
  expect(
    s.p.contentChecks![0]!.issues.filter(
      (issue) => issue.code === "required-primary-field-unbound",
    ),
  ).toHaveLength(3);
  await s.bindCorrect();
  s.p.numericBindings!.find((binding) => binding.quantity === "coefficient")!.unit = "秒";
  const invalid = await prepareNumericAcceptance(
    s.p,
    "reviewer",
    "binding-corrupted",
    s.input(),
    at(41),
  );
  expect(invalid.blocked).toBe(true);
  expect(s.p.contentChecks!.at(-1)!.issues.some((issue) => issue.code === "unit-mismatch")).toBe(
    true,
  );
});

test("receipts reject changed bindings, reviews, metadata, plans, target and current native status", async () => {
  const s = await fixture();
  await s.bindCorrect();
  await s.dismissYear();
  const pass = await prepareNumericAcceptance(
      s.p,
      "reviewer",
      "receipt-context",
      s.input(),
      at(40),
    ),
    baseline = structuredClone(s.p);
  const changes = [
    (p: NumericAcceptanceProject) => {
      p.analysisReads = [];
    },
    (p: NumericAcceptanceProject) => {
      p.analysisRunAdoptions = [];
    },
    (p: NumericAcceptanceProject) => {
      p.analysisReviewContexts = [];
    },
    (p: NumericAcceptanceProject) => {
      p.numericBindings![0]!.decimalPlaces = 1;
    },
    (p: NumericAcceptanceProject) => {
      p.numericCandidateReviews![0]!.reason += "变更";
    },
    (p: NumericAcceptanceProject) => {
      p.numericFieldMetadata![0]!.provenance.note += "变更";
    },
    (p: NumericAcceptanceProject) => {
      p.activeAnalysisPlans![0]!.version = 2;
    },
    (p: NumericAcceptanceProject) => {
      p.artifacts.find((artifact) => artifact.id === s.artifact.id)!.content += "新文字";
    },
    (p: NumericAcceptanceProject) => {
      p.fusion!.attempts.find((attempt) => attempt.id === "writing-reviewer")!.state = "cancelled";
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(baseline);
    change(changed);
    await expect(
      assertNumericAcceptanceReceipt(changed, "reviewer", s.input(), pass.receipt),
    ).rejects.toThrow("上下文已变化");
  }
});

test("changed actual bytes are persisted as a blocked check and are also rejected between prepare and publish", async () => {
  const s = await fixture();
  await s.bindCorrect();
  await s.dismissYear();
  const pass = await prepareNumericAcceptance(
    s.p,
    "reviewer",
    "prepare-before-file-change",
    s.input(),
    at(40),
  );
  await writeFile(s.file, csv.replace("1,8", "1,9"));
  await expect(
    assertNumericAcceptanceReceipt(s.p, "reviewer", s.input(), pass.receipt),
  ).rejects.toThrow("实际文件");
  const result = await prepareNumericAcceptance(
    s.p,
    "reviewer",
    "check-modified-file",
    s.input(),
    at(41),
  );
  expect(result.blocked).toBe(true);
  expect(s.p.contentChecks!.at(-1)!.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "actual-numeric-check-failed",
        detail: expect.stringContaining("数据已变化"),
      }),
    ]),
  );
  expect(s.p.contentChecks![0]!.result).toBe("passed-at-snapshot");
});

test("full quantitative acceptance requires adopted current analysis while S6, legacy and limited reviews keep existing routes", async () => {
  const s = await fixture();
  expect(requiresNumericAcceptance(s.p, "reviewer", s.input())).toBe(true);
  const noRuns = structuredClone(s.p);
  noRuns.analysisRegistry = undefined;
  noRuns.activeAnalysisPlans = [];
  expect(
    (await prepareNumericAcceptance(noRuns, "reviewer", "missing-registry", s.input(), at(40)))
      .blocked,
  ).toBe(true);
  expect(
    noRuns
      .contentChecks!.at(-1)!
      .issues.some((issue) => issue.code === "registered-analysis-required"),
  ).toBe(true);
  for (const changes of [
    { workflowVersion: undefined },
    { entry: "task" as const, goal: "task" as const },
    { entry: "manuscript" as const },
    { path: "qualitative" as const },
    { scope: "proposal" as const },
    { goal: "design" as const },
  ]) {
    const p = { ...structuredClone(s.p), ...changes };
    expect(requiresNumericAcceptance(p, "reviewer", s.input())).toBe(false);
    expect(
      await prepareNumericAcceptance(p, "reviewer", "outside-gate", s.input(), at(40)),
    ).toMatchObject({ required: false, blocked: false });
    expect(p.contentChecks).toBeUndefined();
  }
  const s6 = structuredClone(s.p);
  s6.currentStage = "analysis";
  s6.fusion!.attempts = s6.fusion!.attempts.filter((attempt) => !attempt.id.startsWith("writing-"));
  expect(
    (
      await prepareNumericAcceptance(
        s6,
        "reviewer",
        "s6",
        { ...s.input(), stage: "analysis" },
        at(40),
      )
    ).required,
  ).toBe(false);
  const oldFusion = structuredClone(s.p);
  oldFusion.goal = undefined;
  expect(
    (await prepareNumericAcceptance(oldFusion, "reviewer", "old-full-paper", s.input(), at(40)))
      .required,
  ).toBe(true);
  const spoof = await prepareNumericAcceptance(
    s.p,
    "reviewer",
    "model-receipt",
    { ...s.input(), receipt: {} },
    at(40),
  );
  expect(spoof.blocked).toBe(true);
  expect(
    s.p.contentChecks!.at(-1)!.issues.some((issue) => issue.code === "host-private-receipt"),
  ).toBe(true);
});

test("unbound manuscripts still verify actual registered files and retain failures before any binding exists", async () => {
  const s = await fixture();
  await writeFile(s.p.analyses![0]!.file, JSON.stringify({ replaced: true }));
  const result = await prepareNumericAcceptance(
    s.p,
    "reviewer",
    "unbound-files",
    s.input(),
    at(40),
  );
  expect(result.blocked).toBe(true);
  expect(s.p.numericBindings).toBeUndefined();
  expect(s.p.contentChecks!.at(-1)!.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "actual-numeric-check-failed",
        detail: expect.stringContaining("实际归档"),
      }),
    ]),
  );
});
