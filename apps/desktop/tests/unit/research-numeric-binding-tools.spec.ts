import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RESEARCH_ROLES,
  type ResearchArtifact,
  type ResearchRole,
} from "../../contracts/research-group";
import type { ResearchResultFieldMetadata } from "../../contracts/research-numeric-bindings";
import {
  applyNumericBindingTool,
  type NumericProject,
} from "../../electron/research-group/numeric-binding-tools";
import { applyRegisteredAnalysisTool } from "../../electron/research-group/registered-analysis-tools";
import {
  bindFusionNativeRun,
  dispatchFusionAttempt,
  prepareFusionDelivery,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import { researchHash } from "../../electron/research-group/materials";

const at = (n: number) => new Date(Date.UTC(2026, 10, 7, 15, 0, n)).toISOString();
const csv = "x,y\n1,8\n2,6\n3,4\n4,2\n5,0\n";
async function fixture(body = "β=-2.00 分/小时；参考文献2025。") {
  const workspace = await mkdtemp(join(tmpdir(), "numeric-binding-host-")),
    file = join(workspace, "synthetic.csv");
  await writeFile(file, csv);
  const p: NumericProject = {
    id: randomUUID(),
    root: { workspaceId: workspace, sessionId: "mentor" },
    workspacePath: workspace,
    objective: "合成软件数值绑定验收；非真实教育研究。",
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
          description: "闭式合成数据 y=10-2x",
          sourceId: "FIXTURE",
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
  for (const role of ["lead", "reviewer", "mentor"] as const) {
    const delivery = prepareFusionDelivery(
      p,
      role,
      `attempt-${role}`,
      at(0),
      "合成原生尝试身份夹具，不是E/R执行证明",
    );
    expect(delivery.kind).toBe("dispatch");
    dispatchFusionAttempt(p, delivery.attemptId!, at(0));
    bindFusionNativeRun(p, role, `native-${role}`);
    p.fusion!.attempts.find((a) => a.id === delivery.attemptId)!.model = {
      provider: "unit-provider",
      modelId: "unit-model",
    };
  }
  const plan = {
    id: "main",
    version: 1,
    label: "合成主模型",
    purpose: "primary",
    objective: "与闭式结果核对",
    dataset: { id: "DATA" },
    method: "ols",
    columns: ["x"],
    outcome: "y",
    parameters: {},
    outputs: ["regression.coefficients", "regression.sampleSize", "regression.rSquared"],
    reviewPlan: "B核对实际结果和单位语义",
    registrationReason: "合成测试事前计划",
    timing: "prospective",
    sample: { mode: "all" },
  };
  await applyRegisteredAnalysisTool(
    p,
    "lead",
    "register-plan",
    { operation: "register-analysis", plan },
    at(1),
  );
  await applyRegisteredAnalysisTool(
    p,
    "lead",
    "actual-run",
    { operation: "run-analysis", planId: "main", planVersion: 1 },
    at(2),
  );
  const run = p.analysisRegistry!.runs[0]!;
  expect(run.result.regression).toMatchObject({
    coefficients: { intercept: 10, x: -2 },
    sampleSize: 5,
    rSquared: 1,
  });
  const artifact: ResearchArtifact = {
    id: "current-draft",
    role: "lead",
    kind: "stage-revision",
    revision: 1,
    round: 1,
    createdAt: at(5),
    content: body,
    refs: [],
    sourceIds: [],
    analysisIds: [run.id],
    toolCallId: "publish-fixture",
    stage: "analysis",
  };
  p.artifacts.push(artifact);
  publishFusionArtifact(p, artifact);
  const readArtifact = (role: ResearchRole, target = artifact) => {
    // Host event fixture mirrors coordinator read after obtaining this immutable body's contents.
    expect(p.artifacts.find((item) => item.id === target.id)!.content).toBe(target.content);
    p.events.push({
      id: randomUUID(),
      at: at(10),
      revision: 1,
      type: "read",
      role,
      artifactId: target.id,
      stage: "analysis",
      detail: `读取 ${target.kind} · ${target.role} · 版本 1`,
    });
  };
  const readRun = async (role: ResearchRole) => {
    const effect = await applyRegisteredAnalysisTool(
      p,
      role,
      `read-run-${role}`,
      { operation: "read-registered-analysis", analysisId: run.id },
      at(8),
    );
    p.events.push({
      id: randomUUID(),
      at: at(8),
      revision: 1,
      type: "analysis",
      role,
      analysisId: effect.analysisId,
      detail: effect.detail!,
    });
  };
  for (const role of ["lead", "reviewer", "mentor"] as const) {
    await readRun(role);
    readArtifact(role);
  }
  let serial = 20;
  const tool = async (
    role: ResearchRole,
    input: Record<string, unknown>,
    callId = `numeric-call-${++serial}`,
  ) =>
    (await applyNumericBindingTool(p, role, callId, input, at(++serial))).result as Record<
      string,
      unknown
    >;
  const declare = async () =>
    (
      await tool(
        "lead",
        {
          operation: "declare-result-field",
          runId: run.id,
          path: ["regression", "coefficients", "x"],
          quantity: "coefficient",
          unit: "分/小时",
          content: "合成变量x定义为小时、y为分；系数单位为分/小时，真实研究须另核原定义。",
        },
        "declare-coefficient",
      )
    ).metadata as ResearchResultFieldMetadata;
  const verify = async (metadataId: string) =>
    (
      await tool(
        "reviewer",
        {
          operation: "review-result-field",
          metadataId,
          content:
            "已实际读取合成运行，依据夹具变量定义核对单位；这是模型语义意见，不是人类专家认证。",
        },
        "review-coefficient",
      )
    ).metadata as ResearchResultFieldMetadata;
  const binding = (metadataId: string) => ({
    artifactId: artifact.id,
    start: body.indexOf("-2.00"),
    end: body.indexOf("-2.00") + "-2.00 分/小时".length,
    runId: run.id,
    path: ["regression", "coefficients", "x"],
    fieldMetadataId: metadataId,
    quantity: "coefficient",
    unit: "分/小时",
    decimalPlaces: 2,
    rounding: "half-away-from-zero",
    unitSeparator: " ",
  });
  return { p, file, run, artifact, plan, tool, declare, verify, binding, readRun, readArtifact };
}

test("actual results and files support declared then model-reviewed units and immutable idempotent binding", async () => {
  const s = await fixture(),
    originalBody = s.artifact.content;
  const declaration = await s.declare();
  expect(declaration).toMatchObject({
    status: "declared",
    provenance: { actor: "model", actorId: "model:lead" },
  });
  await expect(
    s.tool("lead", { operation: "numeric-bind", binding: s.binding(declaration.id) }),
  ).rejects.toThrow("unit-unverified");
  const verified = await s.verify(declaration.id);
  expect(verified.id).not.toBe(declaration.id);
  expect(verified).toMatchObject({
    status: "verified",
    provenance: { actor: "model", actorId: "model:reviewer" },
  });
  expect(verified.provenance.sourceRef).toContain(`review-of:${declaration.id}`);
  expect(s.p.numericFieldMetadata![0]).toEqual(declaration);
  const first = await s.tool(
    "lead",
    { operation: "numeric-bind", binding: s.binding(verified.id) },
    "bind-slope",
  );
  const second = await s.tool(
    "lead",
    { operation: "numeric-bind", binding: s.binding(verified.id) },
    "bind-slope",
  );
  expect(second).toEqual(first);
  expect(s.p.numericBindings).toHaveLength(1);
  expect(await s.declare()).toEqual(declaration);
  expect(await s.verify(declaration.id)).toEqual(verified);
  expect(s.p.numericFieldMetadata).toHaveLength(2);
  expect(s.artifact.content).toBe(originalBody);
  const report = await s.tool("reviewer", {
    operation: "numeric-check",
    artifactId: s.artifact.id,
  });
  expect(report.deterministic).toMatchObject({ blockers: [] });
  expect(report.semantic).toMatchObject({ unbound: [{ text: "2025" }] });
  await expect(
    s.tool(
      "lead",
      {
        operation: "declare-result-field",
        runId: s.run.id,
        path: ["regression", "coefficients", "x"],
        quantity: "coefficient",
        unit: "秒",
        content: "试图改写相同工具调用",
      },
      "declare-coefficient",
    ),
  ).rejects.toThrow("同一工具调用身份");
  await expect(
    s.tool(
      "lead",
      {
        operation: "declare-result-field",
        runId: s.run.id,
        path: ["regression", "sampleSize"],
        quantity: "sample-size",
        unit: "",
        content: "跨操作重用call",
      },
      "bind-slope",
    ),
  ).rejects.toThrow("另一类");
});

test("sample count and R squared use host dimensionless metadata; render stays a suggestion and never infers coefficient units", async () => {
  const s = await fixture("n=5；R²=1.000。"),
    before = s.artifact.content;
  const base = {
    runId: s.run.id,
    path: ["regression", "sampleSize"],
    quantity: "sample-size",
    unit: "",
    decimalPlaces: 0,
    rounding: "half-even",
    unitSeparator: "",
  };
  const rendered = await s.tool("lead", { operation: "numeric-render", ...base });
  expect(rendered.renderedText).toBe("5");
  expect(rendered.metadataPersisted).toBe(false);
  expect(rendered.bindingFields).toEqual(base);
  expect(rendered.deterministicBlockers).toEqual([]);
  expect(rendered.metadata).toMatchObject({ status: "verified", provenance: { actor: "host" } });
  expect(s.p.numericFieldMetadata).toBeUndefined();
  await s.tool("lead", {
    operation: "numeric-bind",
    binding: { ...base, artifactId: s.artifact.id, start: 2, end: 3 },
  });
  await s.tool("lead", {
    operation: "numeric-bind",
    binding: {
      ...base,
      path: ["regression", "rSquared"],
      quantity: "r-squared",
      decimalPlaces: 3,
      artifactId: s.artifact.id,
      start: 7,
      end: 12,
    },
  });
  expect(
    (await s.tool("mentor", { operation: "numeric-check", artifactId: s.artifact.id }))
      .blocksFormalAcceptance,
  ).toBe(false);
  expect(s.artifact.content).toBe(before);
  await expect(
    s.tool("lead", {
      operation: "numeric-render",
      ...base,
      path: ["regression", "coefficients", "x"],
      quantity: "coefficient",
    }),
  ).rejects.toThrow("单位不能推断");
  const declaration = await s.declare();
  const proposed = await s.tool("lead", {
    operation: "numeric-render",
    ...base,
    path: declaration.path,
    fieldMetadataId: declaration.id,
    quantity: "coefficient",
    unit: declaration.unit,
    decimalPlaces: 2,
    unitSeparator: " ",
  });
  expect(proposed.renderedText).toBe("-2.00 分/小时");
  expect(proposed.deterministicBlockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "unit-unverified" })]),
  );
});

test("semantic review requires actual current read and cannot cover real binding errors", async () => {
  const s = await fixture(),
    declaration = await s.declare(),
    verified = await s.verify(declaration.id);
  await s.tool("lead", { operation: "numeric-bind", binding: s.binding(verified.id) });
  const input = {
    operation: "numeric-candidate-review",
    artifactId: s.artifact.id,
    start: s.artifact.content.indexOf("2025"),
    end: s.artifact.content.indexOf("2025") + 4,
    classification: "non-result-number",
    reason: "此处明确是参考文献年份，不是本研究数值结果。",
  };
  s.p.events = s.p.events.filter((event) => !(event.role === "reviewer" && event.type === "read"));
  await expect(s.tool("reviewer", input)).rejects.toThrow("先实际 read");
  s.readArtifact("reviewer");
  const first = await s.tool("reviewer", input, "year-review");
  expect(await s.tool("reviewer", input, "year-review")).toEqual(first);
  expect(s.p.numericCandidateReviews).toHaveLength(1);
  expect(s.p.numericCandidateReviews![0]!.provenance).toMatchObject({
    actor: "model",
    actorId: "model:reviewer",
  });
  s.p.numericBindings![0]!.unit = "秒"; // Corrupted persisted binding must stay a deterministic blocker.
  const report = await s.tool("mentor", { operation: "numeric-check", artifactId: s.artifact.id });
  expect(report.deterministic).toMatchObject({
    blockers: expect.arrayContaining([expect.objectContaining({ code: "unit-mismatch" })]),
  });
  expect(report.semantic).toMatchObject({
    reviewedNonResults: [expect.objectContaining({ text: "2025" })],
  });
  expect(report.blocksFormalAcceptance).toBe(true);
  await expect(s.tool("lead", input)).rejects.toThrow("由B/导师");
});

test("reviewing field units requires B/mentor current actual receipt, not a legacy event or claimed identity", async () => {
  const s = await fixture(),
    declaration = await s.declare();
  s.p.events = s.p.events.filter(
    (event) => !(event.role === "reviewer" && event.type === "analysis"),
  );
  s.p.analysisReads = s.p.analysisReads!.filter((read) => read.context.role !== "reviewer");
  s.p.events.push({
    id: "execution-only",
    revision: 1,
    at: at(9),
    role: "reviewer",
    type: "analysis",
    analysisId: s.run.id,
    detail: "实际执行登记分析 main v1",
  });
  await expect(s.verify(declaration.id)).rejects.toThrow("先实际 read-analysis");
  await s.readRun("reviewer");
  await s.verify(declaration.id);
  await expect(
    s.tool("lead", {
      operation: "review-result-field",
      metadataId: declaration.id,
      content: "A不能自我复核单位",
    }),
  ).rejects.toThrow("只有B/导师");
  for (const forbidden of [
    { actor: "user" },
    { run: s.run },
    { verified: true },
    { sha256: s.run.runSha256 },
    { sourceRef: "human-approval" },
  ])
    await expect(
      s.tool("reviewer", {
        operation: "review-result-field",
        metadataId: declaration.id,
        content: "禁止伪造身份",
        ...forbidden,
      }),
    ).rejects.toThrow("由宿主生成");
  await expect(
    s.tool("librarian", { operation: "numeric-check", artifactId: s.artifact.id }),
  ).rejects.toThrow("A/B/导师");
});

test("superseded or changed immutable drafts and updated plan versions reject new numeric actions", async () => {
  const s = await fixture();
  const newer = {
    ...s.artifact,
    id: "next-draft",
    createdAt: at(11),
    content: s.artifact.content + "补充说明",
    toolCallId: "new-publish",
  };
  s.p.artifacts.push(newer);
  publishFusionArtifact(s.p, newer);
  await expect(
    s.tool("reviewer", { operation: "numeric-check", artifactId: s.artifact.id }),
  ).rejects.toThrow("当前不可变成果");
  const s2 = await fixture();
  s2.artifact.content += "被原位改写";
  await expect(
    s2.tool("reviewer", { operation: "numeric-check", artifactId: s2.artifact.id }),
  ).rejects.toThrow("当前不可变成果");
  const s3 = await fixture();
  await applyRegisteredAnalysisTool(
    s3.p,
    "lead",
    "plan-v2",
    {
      operation: "register-analysis",
      plan: {
        ...s3.plan,
        version: 2,
        timing: "post-hoc",
        registrationReason: "真实已有计算后修改计划",
      },
    },
    at(12),
  );
  await expect(s3.declare()).rejects.toThrow(/过期|当前输入版本/);
});

test("every registered archive file and dataset must match before numeric sidecars are saved", async () => {
  for (const target of [
    "dataset",
    "input.csv",
    "calculation-input.csv",
    "plan.json",
    "registered-run.json",
    "result.json",
    "replay.mjs",
  ]) {
    const s = await fixture(),
      projection = s.p.analyses![0]!;
    const file = target === "dataset" ? s.file : join(dirname(projection.file), target);
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("\nCHANGED")]));
    await expect(s.declare()).rejects.toThrow(target === "dataset" ? "数据已变化" : "实际归档");
    expect(s.p.numericFieldMetadata).toBeUndefined();
    expect(s.p.numericBindings).toBeUndefined();
  }
});

test("an intact saved run from an obsolete engine cannot supply current numeric metadata", async () => {
  const s = await fixture();
  s.run.engine = "obsolete-test-engine";
  const contents = { ...s.run };
  const { runSha256: previousHash, ...hashed } = contents;
  expect(previousHash).toHaveLength(64);
  s.run.runSha256 = researchHash(JSON.stringify(hashed));
  const projection = s.p.analyses![0]!;
  await writeFile(join(dirname(projection.file), "registered-run.json"), JSON.stringify(s.run));
  await expect(s.declare()).rejects.toThrow("过期");
  expect(s.p.numericFieldMetadata).toBeUndefined();
});
