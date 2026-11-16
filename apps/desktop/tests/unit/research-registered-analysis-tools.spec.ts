import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RESEARCH_ROLES,
  type ResearchProject,
  type ResearchArtifact,
  type ResearchRole,
} from "../../contracts/research-group";
import { applyRegisteredAnalysisTool } from "../../electron/research-group/registered-analysis-tools";
import { registeredAnalysisAcceptanceIssues } from "../../electron/research-group/analysis-registry-state";
import { isCurrentResearchAnalysis } from "../../electron/research-group/paper-pipeline";
import {
  bindFusionNativeRun,
  dispatchFusionAttempt,
  prepareFusionDelivery,
  ensureFusionStageTasks,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import { ResearchRepository, decodeResearchState } from "../../electron/research-group/repository";
import { researchHash } from "../../electron/research-group/materials";

const runNode = promisify(execFile);
const csv = "x,z,y\n1,0,8\n2,1,7\n3,0,4\n4,1,3\n5,0,0\n6,1,-1\n7,NA,-4\n";
const time = (n: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, n)).toISOString();
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "registered-analysis-host-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const file = join(workspace, "observed-fixture.csv");
  await writeFile(file, csv);
  const p: ResearchProject = {
    id: randomUUID(),
    root: { workspaceId: workspace, sessionId: "mentor" },
    workspacePath: workspace,
    objective: "明确标识的合成软件计算演练，不是已实施教育研究。",
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
          description: "合成数据",
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
  for (const role of ["lead", "reviewer"] as const) {
    const delivery = prepareFusionDelivery(
      p,
      role,
      `attempt-${role}`,
      time(0),
      "合成软件验收的原生尝试身份夹具",
    );
    expect(delivery.kind).toBe("dispatch");
    dispatchFusionAttempt(p, delivery.attemptId!, time(0));
    bindFusionNativeRun(p, role, `native-${role}`);
    p.fusion!.attempts.find((a) => a.id === delivery.attemptId)!.model = {
      provider: "unit-provider",
      modelId: "unit-model",
    };
  }
  let serial = 0;
  const tool = async (
    role: ResearchRole,
    input: Record<string, unknown>,
    callId = `call-${++serial}`,
  ) => {
    const effect = await applyRegisteredAnalysisTool(p, role, callId, input, time(++serial));
    if (effect.detail)
      p.events.push({
        id: randomUUID(),
        at: time(serial),
        revision: p.revision,
        type: "analysis",
        role,
        analysisId: effect.analysisId,
        detail: effect.detail,
      });
    return effect.result;
  };
  const plan = (id: string) => ({
    id,
    version: 1,
    label: id,
    purpose: id === "main" ? "primary" : id === "comparison" ? "comparison" : "descriptive",
    objective: "核查方法与实际样本的一致性。",
    dataset: { id: "DATA" },
    method: id === "describe" ? "describe" : "ols",
    columns: id === "main" ? ["x", "z"] : id === "describe" ? ["x", "z", "y"] : ["x"],
    ...(id !== "describe" ? { outcome: "y" } : {}),
    parameters: {},
    outputs:
      id === "describe"
        ? ["descriptive"]
        : ["regression.coefficients", "regression.rSquared", "regression.sampleSize"],
    reviewPlan: "B 实际读取并同引擎复跑，另给解释意见。",
    registrationReason: "软件验收预先计划，非外部预注册。",
    timing: "prospective",
    sample:
      id === "main"
        ? { mode: "all" }
        : {
            mode: "selected-rows",
            id: "common-six",
            sourceLines: [2, 3, 4, 5, 6, 7],
            reason: "与主模型完整案例一致。",
          },
    ...(id === "comparison"
      ? { compareWith: { planId: "main", planVersion: 1, requireSameSample: true } }
      : {}),
  });
  const currentIds = () =>
    p.analyses?.filter((run) => isCurrentResearchAnalysis(p, run)).map((run) => run.id) ?? [];
  return { p, tool, plan, directory, file, currentIds };
}

test("host tools execute all adopted plans, separate replay from interpretation, persist and replay actual files", async () => {
  const s = await fixture();
  for (const id of ["main", "comparison", "describe"])
    await s.tool("lead", { operation: "register-analysis", plan: s.plan(id) });
  expect(
    s.p.analysisRegistry!.plans.every((plan) => plan.dataset.sha256 === researchHash(csv)),
  ).toBe(true);
  expect(
    registeredAnalysisAcceptanceIssues(s.p, s.currentIds()).some((issue) =>
      issue.includes("not-executed"),
    ),
  ).toBe(true);
  for (const ref of s.p.activeAnalysisPlans!) {
    const a = (await s.tool("lead", {
      operation: "run-analysis",
      planId: ref.id,
      planVersion: 1,
    })) as { id: string };
    const count = s.p.analysisRegistry!.runs.length;
    await expect(
      s.tool("reviewer", {
        operation: "review-analysis",
        planId: ref.id,
        planVersion: 1,
        analysisId: a.id,
        verdict: "accept",
        content: "未读结果的空口确认。",
      }),
    ).rejects.toThrow("实际读取");
    await s.tool("reviewer", { operation: "read-registered-analysis", analysisId: a.id });
    const b = (await s.tool("reviewer", {
      operation: "run-analysis",
      planId: ref.id,
      planVersion: 1,
      replayOf: a.id,
    })) as { id: string };
    expect(s.p.analysisRegistry!.runs.length).toBe(count + 1);
    const run = s.p.analysisRegistry!.runs.find((entry) => entry.id === b.id)!;
    expect(run.verification).toEqual({
      level: "same-engine-replay",
      replayOf: a.id,
      matches: true,
    });
    expect(
      registeredAnalysisAcceptanceIssues(s.p, s.currentIds()).some((issue) =>
        issue.includes("B 针对当前结果"),
      ),
    ).toBe(true);
    await s.tool("reviewer", {
      operation: "review-analysis",
      planId: ref.id,
      planVersion: 1,
      analysisId: b.id,
      verdict: "accept",
      content:
        "已逐项核查固定计划、实际原始行、缺失处理与样本比较。结果只支持合成软件演练，不是因果证据。",
    });
  }
  expect(registeredAnalysisAcceptanceIssues(s.p, s.currentIds())).toEqual([]);
  const main = s.p.analysisRegistry!.runs.find(
    (run) => run.planId === "main" && run.actor === "model:lead",
  )!;
  expect(main.result.regression).toMatchObject({
    coefficients: { intercept: expect.any(Number), x: expect.any(Number), z: expect.any(Number) },
    sampleSize: 6,
  });
  const coefficients = (main.result.regression as { coefficients: Record<string, number> })
    .coefficients;
  expect(coefficients.intercept).toBeCloseTo(10, 10);
  expect(coefficients.x).toBeCloseTo(-2, 10);
  expect(coefficients.z).toBeCloseTo(1, 10);
  const repo = new ResearchRepository(s.directory);
  await repo.save({ version: 1, config: { knowledgeDir: "" }, projects: [s.p] });
  const loaded = (await repo.load()).projects[0]!;
  expect(loaded.analysisRegistry).toEqual(s.p.analysisRegistry);
  expect(loaded.activeAnalysisPlans).toEqual(s.p.activeAnalysisPlans);
  for (const run of loaded.analyses!) {
    const output = await runNode(process.execPath, [join(dirname(run.file), "replay.mjs")]);
    expect(JSON.parse(output.stdout)).toMatchObject({
      verification: "same-engine-replay",
      result: run.result,
    });
  }
  const projection = loaded.analyses![0]!;
  await writeFile(join(dirname(projection.file), "calculation-input.csv"), "changed\n");
  await expect(
    runNode(process.execPath, [join(dirname(projection.file), "replay.mjs")]),
  ).rejects.toThrow("Analysis input changed");
});

test("unexecuted and unsupported promises block acceptance; post-result additions remain post-hoc", async () => {
  const s = await fixture();
  await s.tool("lead", { operation: "register-analysis", plan: s.plan("main") });
  await s.tool("lead", { operation: "run-analysis", planId: "main", planVersion: 1 });
  await s.tool("lead", {
    operation: "register-analysis",
    plan: {
      ...s.plan("later"),
      purpose: "exploratory",
      method: "logistic",
      outputs: ["p-value"],
      registrationReason: "看结果后提出的探索承诺。",
    },
  });
  expect(s.p.analysisRegistry!.plans.at(-1)!.registration.timing).toBe("post-hoc");
  expect(s.p.analysisRegistry!.plans.at(-1)!.registration.observedPriorRunIds).toHaveLength(1);
  expect(
    registeredAnalysisAcceptanceIssues(s.p, s.currentIds()).some((issue) =>
      issue.includes("needs-method-extension"),
    ),
  ).toBe(true);
  await expect(
    s.tool("lead", { operation: "run-analysis", planId: "later", planVersion: 1 }),
  ).rejects.toThrow("方法扩展");
  expect(s.p.analysisRegistry!.runs).toHaveLength(1);
  await expect(
    s.tool("lead", {
      operation: "register-analysis",
      plan: {
        ...s.plan("forged"),
        registration: { at: time(0), timing: "prospective", sourceRef: "human" },
      },
    }),
  ).rejects.toThrow("宿主登记");
});

test("a changed dataset leaves old results readable as historical but cannot release the current plan", async () => {
  const s = await fixture();
  await s.tool("lead", { operation: "register-analysis", plan: s.plan("main") });
  const run = (await s.tool("lead", {
    operation: "run-analysis",
    planId: "main",
    planVersion: 1,
  })) as { id: string };
  s.p.evidence!.datasets[0]!.sha256 = researchHash(csv + "8,0,-6\n");
  expect(s.currentIds()).toEqual([]);
  const history = (await s.tool("reviewer", {
    operation: "read-registered-analysis",
    analysisId: run.id,
  })) as { validForCurrentInputs: boolean };
  expect(history.validForCurrentInputs).toBe(false);
  expect(
    registeredAnalysisAcceptanceIssues(s.p, s.currentIds()).some((issue) =>
      issue.includes("stale"),
    ),
  ).toBe(true);
  await expect(
    s.tool("lead", { operation: "run-analysis", planId: "main", planVersion: 1 }),
  ).rejects.toThrow();
  expect(s.p.analysisRegistry!.runs).toHaveLength(1);
  expect(await readFile(s.file, "utf8")).toBe(csv);
});

test("replaying a prior registration receipt cannot adopt an older plan version", async () => {
  const s = await fixture();
  const first = { operation: "register-analysis", plan: s.plan("main") };
  await s.tool("lead", first, "register-v1");
  await s.tool(
    "lead",
    {
      operation: "register-analysis",
      plan: { ...s.plan("main"), version: 2, registrationReason: "修订计划说明，仍未计算。" },
    },
    "register-v2",
  );
  const active = structuredClone(s.p.activeAnalysisPlans),
    graph = structuredClone(s.p.fusion);
  await s.tool("lead", first, "register-v1");
  expect(s.p.activeAnalysisPlans).toEqual(active);
  expect(s.p.fusion).toEqual(graph);
  expect(s.p.analysisRegistry!.plans).toHaveLength(2);
});

test("a late registration from an invalidated native attempt cannot pin the replacement data", async () => {
  const s = await fixture();
  s.p.evidence!.datasets[0]!.sha256 = researchHash("new replacement bytes");
  ensureFusionStageTasks(s.p, time(1));
  const before = structuredClone(s.p);
  await expect(
    s.tool("lead", { operation: "register-analysis", plan: s.plan("main") }),
  ).rejects.toThrow("任务输入已变化");
  expect(s.p).toEqual(before);
});

test("a tampered legacy projection cannot bypass the canonical registered result", async () => {
  const s = await fixture();
  await s.tool("lead", { operation: "register-analysis", plan: s.plan("main") });
  await s.tool("lead", { operation: "run-analysis", planId: "main", planVersion: 1 });
  const projection = s.p.analyses![0]!;
  (projection.result.regression as Record<string, unknown>).rSquared = 0;
  expect(isCurrentResearchAnalysis(s.p, projection)).toBe(false);
  expect(() =>
    decodeResearchState({ version: 1, config: { knowledgeDir: "" }, projects: [s.p] }),
  ).toThrow(/登记分析投影|projection不一致/);
});

test("actual analysis status withholds B interpretation until A publishes a current graph-backed independent draft", async () => {
  const s = await fixture(),
    note = "B_PRIVATE_INTERPRETATION_DO_NOT_PRIME_A";
  const registration = { operation: "register-analysis", plan: s.plan("main") };
  await s.tool("lead", registration, "register-shared");
  const run = (await s.tool("lead", {
    operation: "run-analysis",
    planId: "main",
    planVersion: 1,
  })) as { id: string };
  await s.tool("reviewer", { operation: "read-registered-analysis", analysisId: run.id });
  await s.tool("reviewer", {
    operation: "review-analysis",
    planId: "main",
    planVersion: 1,
    analysisId: run.id,
    verdict: "accept",
    content: note,
  });
  const status = () => s.tool("lead", { operation: "analysis-registry" });
  expect(JSON.stringify(await status())).not.toContain(note);
  expect(JSON.stringify(await s.tool("lead", registration, "register-shared"))).not.toContain(note);
  expect(JSON.stringify(await s.tool("reviewer", { operation: "analysis-registry" }))).toContain(
    note,
  );
  const draft: ResearchArtifact = {
    id: "A-independent",
    role: "lead",
    kind: "stage-draft",
    stage: "analysis",
    revision: 1,
    round: 0,
    createdAt: time(20),
    content: "A先独立分析原始数字并说明有限解释。",
    refs: [],
    toolCallId: "A-independent",
  };
  s.p.artifacts.push(draft);
  expect(JSON.stringify(await status())).not.toContain(note); // A projection alone is not a real graph delivery.
  publishFusionArtifact(s.p, draft);
  expect(JSON.stringify(await status())).toContain(note);
  const record = s.p.fusion!.artifacts.find((entry) => entry.id === draft.id)!;
  record.content += " altered";
  expect(JSON.stringify(await status())).not.toContain(note);
  record.content = draft.content;
  s.p.fusion!.tasks.find((task) => task.id === record.taskId)!.inputVersion++;
  expect(JSON.stringify(await status())).not.toContain(note); // Old independent work cannot unlock a new input epoch.
});
