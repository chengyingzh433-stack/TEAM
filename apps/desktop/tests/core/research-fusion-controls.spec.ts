import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESEARCH_ROLES, type ResearchProject } from "../../contracts/research-group";
import { RESEARCH_METHOD_VERSION } from "../../contracts/research-method";
import { decodeResearchState } from "../../electron/research-group/repository";
import {
  addResearchTask,
  createResearchTaskGraph,
  failResearchTask,
  markResearchTaskDispatched,
  pauseResearchTasks,
  publishResearchTaskResult,
  requestResearchDecision,
  startResearchTask,
} from "../../electron/research-group/task-graph";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
} from "../helpers/electron-app";

const at = "2026-11-07T12:00:00.000Z";
const ids = {
  decision: "v1:design:mentor",
  retry: "v1:design:lead",
  untouched: "v1:design:reviewer",
  unknown: "v1:reading:lead",
  done: "v1:reading:librarian",
};
function fixtureGraph(projectId: string) {
  let graph = createResearchTaskGraph(projectId, RESEARCH_METHOD_VERSION);
  for (const [name, id] of Object.entries(ids)) {
    graph = addResearchTask(graph, {
      id,
      stage: id.split(":")[1]!,
      role: id.split(":")[2]!,
      kind: "research",
      goal: `隔离测试任务 ${name}`,
      inputs: [],
      dependencies: [],
      earlyHandoff: "初步材料",
      deliverable: "可核对成果",
      reviewRequired: true,
      writeScope: [name],
      tokenBudget: 1000,
    });
  }
  for (const name of ["retry", "untouched", "unknown", "done"] as const) {
    const attemptId = `attempt-${name}`;
    graph = markResearchTaskDispatched(
      startResearchTask(graph, ids[name], { id: attemptId, at, reservedTokens: 100 }),
      attemptId,
      at,
    );
    if (name === "done")
      graph = publishResearchTaskResult(graph, {
        projectId,
        id: "preserved-result",
        attemptId,
        at,
        content: "已交成果必须保留，不重放。",
        usedTokens: 45,
      });
    else
      graph = failResearchTask(graph, attemptId, {
        at,
        reason: `隔离夹具：${name}`,
        outcome: name === "unknown" ? "unknown" : "failed",
        ...(name === "unknown" ? {} : { usedTokens: 20 }),
      });
  }
  graph = requestResearchDecision(graph, {
    id: "human-scope",
    inputId: "user-permission",
    version: 1,
    at,
    requestedBy: "mentor",
    question: "是否继续核查这个研究问题？",
    context: "现有材料只够完成设计，分析仍需真实数据。",
    impact: "只解锁指定设计任务，不改变已经完成的资料成果。",
    options: [
      { id: "yes", label: "按当前范围继续", consequence: "允许继续设计核查", outcome: "confirmed" },
      { id: "no", label: "不接受当前范围", consequence: "保持该任务阻塞", outcome: "declined" },
      { id: "later", label: "稍后决定", consequence: "等待新的明确答复", outcome: "deferred" },
    ],
    recommendedOptionId: "yes",
    taskIds: [ids.decision],
  });
  return pauseResearchTasks(graph);
}

// E: pre-existing isolated project fixture + real Electron controls/IPC/storage/restart.
// No provider requests (R), native UI, or resumed model execution is established here.
test("fusion controls require explicit human input, reconcile unknown without retry, and persist local recovery", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("fusion-controls-"),
    workspace = await makeWorkspace("fusion-controls"),
    agentDir = join(profile, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light" }),
  );
  const sessions: Awaited<ReturnType<typeof seedNamedTextSessionFixture>>[] = [];
  for (const role of RESEARCH_ROLES)
    sessions.push(
      await seedNamedTextSessionFixture(agentDir, workspace, {
        title: `lancer-zone:edu-research-group|决定与恢复 ${role}`,
        userText: "隔离测试历史",
        assistantText: "保留的历史，不代表真实研究结果。",
      }),
    );
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      testMode: "background",
      scrubProviderEnv: true,
    });
  let harness = await launch();
  try {
    let page = await harness.firstWindow();
    const initial = await getDesktopState(page);
    const workspaceId = initial.workspaces.find((w) =>
      w.sessions.some((s) => s.id === sessions[0]!.sessionId),
    )?.id;
    if (!workspaceId) throw new Error("Fixture sessions were not discovered");
    await harness.close();
    const projectId = randomUUID();
    const project: ResearchProject = {
      id: projectId,
      root: { workspaceId, sessionId: sessions[0]!.sessionId },
      workspacePath: workspace,
      objective: "隔离夹具：人工决定与局部恢复",
      revision: 1,
      status: "paused",
      createdAt: at,
      updatedAt: at,
      workflowVersion: "fusion-v2",
      methodVersion: RESEARCH_METHOD_VERSION,
      entry: "idea",
      goal: "design",
      currentStage: "design",
      scope: "paper",
      knowledge: { directory: workspace, sha256: "fixture", version: "isolated-fixture", count: 0 },
      members: RESEARCH_ROLES.map((role, index) => ({
        role,
        ref: { workspaceId, sessionId: sessions[index]!.sessionId },
        status: "idle",
      })),
      artifacts: [],
      packets: [],
      events: [],
      fusion: fixtureGraph(projectId),
    };
    const researchFile = join(profile, "research-groups.json");
    const state = decodeResearchState({
      version: 1,
      config: { knowledgeDir: workspace },
      projects: [project],
    });
    await writeFile(researchFile, JSON.stringify(state));
    harness = await launch();
    page = await harness.firstWindow();
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    const openControls = async () => {
      await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
      await page
        .locator(`.research-project[data-project-id="${projectId}"] .research-project__name`)
        .click();
      const controls = page.getByTestId("research-task-controls");
      await expect(controls).toBeVisible();
      await controls.locator(":scope > summary").click();
      return controls;
    };
    const current = async () =>
      (await getDesktopState(page)).researchGroups!.projects.find((p) => p.id === projectId)!;
    let controls = await openControls();
    const baseline = structuredClone((await current()).fusion!);
    const decision = controls.locator('[data-decision-id="human-scope"]');
    await decision.locator("summary").click();
    await expect(decision).toContainText("分析仍需真实数据");
    await expect(decision).toContainText("不改变已经完成的资料成果");
    await expect(decision.getByLabel("我的选择", { exact: true })).toHaveValue("");
    await expect(decision.getByRole("button", { name: "提交我的决定" })).toBeDisabled();
    await decision.getByLabel("我的选择", { exact: true }).selectOption("later");
    expect((await current()).fusion!.decisions).toEqual([]);
    await decision.getByRole("button", { name: "提交我的决定" }).click();
    await expect
      .poll(async () => (await current()).fusion!.decisions.at(-1)?.outcome)
      .toBe("deferred");
    await expect(decision).toContainText("用户答复");
    await expect(decision.getByRole("button", { name: "提交我的决定" })).toBeEnabled();
    await decision.getByLabel("我的选择", { exact: true }).selectOption("yes");
    await decision.getByLabel("补充说明（选填）").fill("我确认只继续设计核查，分析仍等待数据。");
    await decision.getByRole("button", { name: "提交我的决定" }).click();
    await expect
      .poll(async () => (await current()).fusion!.decisions.at(-1)?.outcome)
      .toBe("confirmed");
    const answers = (await current()).fusion!.decisions;
    expect(answers.map((d) => [d.actor, d.origin, d.outcome])).toEqual([
      ["user", "new-reply", "deferred"],
      ["user", "new-reply", "confirmed"],
    ]);
    expect(answers.at(-1)!.text).toBe("我确认只继续设计核查，分析仍等待数据。");
    await expect(decision.getByRole("button", { name: "提交我的决定" })).toHaveCount(0);

    const unknown = controls.locator('[data-attempt-id="attempt-unknown"]');
    await unknown.locator("summary").click();
    await expect(unknown.getByLabel("核实的执行结果", { exact: true })).toHaveValue("");
    await expect(unknown.getByRole("button", { name: "登记核对结果" })).toBeDisabled();
    await expect(controls.locator(`[data-task-id="${ids.unknown}"]`)).toHaveCount(0);
    await unknown.getByLabel("核实的执行结果", { exact: true }).selectOption("failed");
    await unknown
      .getByLabel("核对说明", { exact: true })
      .fill("核对会话记录，确认请求失败；用量未提供。");
    await expect(unknown.getByRole("button", { name: "登记核对结果" })).toBeDisabled();
    await unknown
      .getByLabel("核对依据（会话、记录位置或凭据编号）")
      .fill("fixture-session/run-unknown/failure");
    expect((await current()).fusion!.attemptResolutions ?? []).toEqual([]);
    await unknown.getByRole("button", { name: "登记核对结果" }).click();
    await expect.poll(async () => (await current()).fusion!.attemptResolutions?.length).toBe(1);
    const reconciled = (await current()).fusion!;
    expect(reconciled.attemptResolutions![0]).toMatchObject({
      actor: "user",
      outcome: "failed",
      evidenceRef: "fixture-session/run-unknown/failure",
    });
    expect(reconciled.attemptResolutions![0]).not.toHaveProperty("usedTokens");
    expect(reconciled.attempts.find((a) => a.id === "attempt-unknown")).toMatchObject({
      state: "failed",
      reservedTokens: 100,
    });
    expect(reconciled.attempts.find((a) => a.id === "attempt-unknown")).not.toHaveProperty(
      "usedTokens",
    );
    expect(reconciled.retryRequests ?? []).toEqual([]);
    expect(reconciled.attempts).toHaveLength(baseline.attempts.length);

    const retry = controls.locator(`[data-task-id="${ids.retry}"]`);
    await retry.locator("summary").click();
    await expect(retry.getByRole("button", { name: "只恢复这项任务" })).toBeDisabled();
    await retry
      .getByLabel("恢复说明", { exact: true })
      .fill("仅恢复研究者 A，其他失败任务保留供核查。");
    await retry.getByRole("button", { name: "只恢复这项任务" }).click();
    await expect.poll(async () => (await current()).fusion!.retryRequests?.length).toBe(1);
    const saved = await current();
    expect(saved.fusion!.retryRequests![0].taskId).toBe(ids.retry);
    expect(saved.fusion!.tasks.find((t) => t.id === ids.retry)!.state).toBe("paused");
    expect(saved.fusion!.tasks.find((t) => t.id === ids.untouched)!.state).toBe("failed");
    expect(saved.fusion!.tasks.find((t) => t.id === ids.unknown)!.state).toBe("failed");
    expect(saved.fusion!.artifacts).toEqual(baseline.artifacts);
    expect(saved.fusion!.attempts).toHaveLength(baseline.attempts.length);
    expect(saved.status).toBe("paused");
    await page.screenshot({ path: test.info().outputPath("fusion-controls-before-restart.png") });
    expect(
      decodeResearchState(JSON.parse(await readFile(researchFile, "utf8"))).projects[0]!.fusion,
    ).toEqual(saved.fusion);
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    await expect.poll(async () => (await current()).fusion).toEqual(saved.fusion);
    controls = await openControls();
    const restoredDecision = controls.locator('[data-decision-id="human-scope"]');
    await restoredDecision.locator("summary").click();
    await expect(restoredDecision).toContainText("用户答复");
    await expect(restoredDecision).toContainText("我确认只继续设计核查");
    await expect(restoredDecision.getByRole("button", { name: "提交我的决定" })).toHaveCount(0);
    await expect(controls.locator('[data-attempt-id="attempt-unknown"]')).toHaveCount(0);
    await expect(controls.locator(`[data-task-id="${ids.untouched}"]`)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("fusion-controls-after-restart.png") });
    await writeFile(
      test.info().outputPath("fusion-controls-evidence.json"),
      JSON.stringify(
        {
          evidenceLayer:
            "E: isolated pre-existing state, real UI/IPC/storage/restart; paused retries queued only; no provider (R) claim",
          projectId,
          before: baseline,
          after: (await current()).fusion,
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
});
