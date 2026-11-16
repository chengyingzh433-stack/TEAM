import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESEARCH_ROLES, type ResearchProject } from "../../contracts/research-group";
import { RESEARCH_METHOD_VERSION } from "../../contracts/research-method";
import { researchTaskControlDecisionStatus } from "../../contracts/research-task-controls";
import { decodeResearchState } from "../../electron/research-group/repository";
import {
  addResearchTask,
  createResearchTaskGraph,
  pauseResearchTasks,
  requestResearchDecision,
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
const sourceTask = "v1:design:lead",
  targetTask = "v1:design:reviewer",
  unrelatedTask = "v1:design:mentor";
function pendingGraph(projectId: string) {
  let graph = createResearchTaskGraph(projectId, RESEARCH_METHOD_VERSION);
  for (const [id, role] of [
    [sourceTask, "lead"],
    [targetTask, "reviewer"],
    [unrelatedTask, "mentor"],
  ])
    graph = addResearchTask(graph, {
      id: id!,
      role: role!,
      stage: "design",
      kind: "research",
      goal: `合成演练的 ${role} 条件核对`,
      inputs: [],
      dependencies: [],
      earlyHandoff: "初稿",
      deliverable: "核查记录",
      reviewRequired: true,
      writeScope: [id!],
    });
  for (const [id, task, question] of [
    ["exercise-source", sourceTask, "合成演练：是否继续公开材料核对？"],
    ["exercise-target", targetTask, "合成演练：本阶段核对是否按相同范围继续？"],
  ])
    graph = requestResearchDecision(graph, {
      id: id!,
      inputId: `human-condition:${id}`,
      version: 1,
      at,
      requestedBy: "fixture:mentor",
      question: question!,
      context: "仅为软件验收的合成决定，不代表真实研究许可或伦理审批。",
      impact: `仅影响 ${task} 的演练条件`,
      taskIds: [task!],
      options: [
        {
          id: "yes",
          label: "按演练范围继续",
          consequence: "只解除这项演练条件",
          outcome: "confirmed",
        },
        { id: "no", label: "不继续", consequence: "保持此条件等待", outcome: "declined" },
      ],
      recommendedOptionId: "yes",
    });
  return pauseResearchTasks(graph);
}

// E boundary: only pending requests are seeded; every confirmed choice is made through real UI/host.
// This does not establish a provider run, ethical approval or a real research authorization.
test("a real UI answer can be explicitly reused with its provenance and persists across restart", async () => {
  test.setTimeout(90_000);
  const profile = await makeUserDataDir("research-authorization-ui-");
  const workspace = await makeWorkspace("research-authorization-ui"),
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
        title: `lancer-zone:edu-research-group|授权沿用演练 ${role}`,
        userText: "合成演练历史，不是已确认选项。",
        assistantText: "本演练所有决定仍等待实际UI选择。",
      }),
    );
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      testMode: "background",
      scrubProviderEnv: true,
    });
  let harness = await launch(),
    page = await harness.firstWindow();
  const projectId = randomUUID();
  try {
    const discovered = await getDesktopState(page);
    const workspaceId = discovered.workspaces.find((item) =>
      item.sessions.some((session) => session.id === sessions[0]!.sessionId),
    )?.id;
    if (!workspaceId) throw new Error("Seeded sessions were not discovered");
    await harness.close();
    const project: ResearchProject = {
      id: projectId,
      root: { workspaceId, sessionId: sessions[0]!.sessionId },
      workspacePath: workspace,
      objective: "合成软件验收：沿用决定必须来自实际UI选择，不能从这句话生成确认。",
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
      knowledge: {
        directory: workspace,
        sha256: "fixture",
        version: "synthetic-ui-exercise",
        count: 0,
      },
      members: RESEARCH_ROLES.map((role, index) => ({
        role,
        ref: { workspaceId, sessionId: sessions[index]!.sessionId },
        status: "idle",
      })),
      artifacts: [],
      packets: [],
      events: [],
      fusion: pendingGraph(projectId),
    };
    expect(project.fusion!.decisions).toEqual([]);
    await writeFile(
      join(profile, "research-groups.json"),
      JSON.stringify(
        decodeResearchState({
          version: 1,
          config: { knowledgeDir: workspace },
          projects: [project],
        }),
      ),
    );
    harness = await launch();
    page = await harness.firstWindow();
    const current = async () =>
      (await getDesktopState(page)).researchGroups!.projects.find((item) => item.id === projectId)!;
    const open = async () => {
      await harness.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
      );
      await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
      await page
        .locator(`.research-project[data-project-id="${projectId}"] .research-project__name`)
        .click();
      const controls = page.getByTestId("research-task-controls");
      await controls.locator(":scope > summary").click();
      return controls;
    };
    let controls = await open();
    const sourceCard = controls.locator('[data-decision-id="exercise-source"]');
    await sourceCard.locator(":scope > summary").click();
    await expect(sourceCard.getByLabel("我的选择", { exact: true })).toHaveValue("");
    await expect(
      sourceCard.getByRole("button", { name: "提交我的决定", exact: true }),
    ).toBeDisabled();
    await sourceCard.getByLabel("我的选择", { exact: true }).selectOption("yes");
    await sourceCard
      .getByLabel("补充说明（选填）")
      .fill("我确认本次合成演练的公开材料核对范围，不代表伦理审批。");
    expect((await current()).fusion!.decisions).toEqual([]);
    await sourceCard.getByRole("button", { name: "提交我的决定", exact: true }).click();
    await expect.poll(async () => (await current()).fusion!.decisions.length).toBe(1);
    const first = await current(),
      actualChoice = first.fusion!.decisions[0]!;
    expect(actualChoice).toMatchObject({
      actor: "user",
      origin: "new-reply",
      requestId: "exercise-source",
      outcome: "confirmed",
      optionId: "yes",
    });
    expect(actualChoice.evidenceRef).toBe(`user-action:${actualChoice.id}`);
    expect(researchTaskControlDecisionStatus(first.fusion!, "exercise-target")).toBe("pending");
    const sourceBeforeReuse = structuredClone(
      first.fusion!.tasks.find((task) => task.id === sourceTask),
    );
    const unrelatedBeforeReuse = structuredClone(
      first.fusion!.tasks.find((task) => task.id === unrelatedTask),
    );
    expect(
      first
        .fusion!.tasks.find((task) => task.id === targetTask)!
        .blockers.some((blocker) => blocker.kind === "decision"),
    ).toBe(true);

    const targetCard = controls.locator('[data-decision-id="exercise-target"]');
    await targetCard.locator(":scope > summary").click();
    const reuse = targetCard.getByTestId("research-decision-reuse");
    await reuse.locator(":scope > summary").click();
    await expect(reuse.getByLabel("选择既有用户决定", { exact: true })).toHaveValue("");
    await expect(
      reuse.getByRole("button", { name: "明确沿用这个决定", exact: true }),
    ).toBeDisabled();
    await reuse.getByLabel("选择既有用户决定", { exact: true }).selectOption(actualChoice.id);
    await expect(reuse).toContainText(actualChoice.text);
    await expect(reuse).toContainText(actualChoice.evidenceRef);
    await expect(reuse).toContainText("原范围");
    await expect(reuse).toContainText("本次范围");
    await reuse.getByLabel("将既有决定用于本次选项", { exact: true }).selectOption("yes");
    expect((await current()).fusion!.decisions).toEqual([actualChoice]);
    expect(researchTaskControlDecisionStatus((await current()).fusion!, "exercise-target")).toBe(
      "pending",
    );
    await reuse.getByRole("button", { name: "明确沿用这个决定", exact: true }).click();
    await expect.poll(async () => (await current()).fusion!.decisions.length).toBe(2);
    const saved = await current(),
      mapping = saved.fusion!.decisions[1]!;
    expect(mapping).toMatchObject({
      actor: "user",
      origin: "prior-authorization",
      sourceDecisionId: actualChoice.id,
      requestId: "exercise-target",
      optionId: "yes",
      outcome: "confirmed",
    });
    expect(mapping.evidenceRef).toBe(`user-action:${mapping.id}`);
    expect(saved.fusion!.decisions[0]).toEqual(actualChoice);
    expect(saved.fusion!.tasks.find((task) => task.id === sourceTask)).toEqual(sourceBeforeReuse);
    expect(saved.fusion!.tasks.find((task) => task.id === unrelatedTask)).toEqual(
      unrelatedBeforeReuse,
    );
    expect(
      saved
        .fusion!.tasks.find((task) => task.id === targetTask)!
        .blockers.some((blocker) => blocker.kind === "decision"),
    ).toBe(false);
    expect(saved.status).toBe("paused");
    expect(saved.fusion!.attempts).toEqual([]);
    await expect(targetCard).toContainText("用户明确沿用既有决定");
    await expect(targetCard.getByRole("button", { name: "提交我的决定", exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: test.info().outputPath("authorization-reuse-before-restart.png"),
    });
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    await expect
      .poll(async () => (await current()).fusion!.decisions)
      .toEqual(saved.fusion!.decisions);
    controls = await open();
    const restored = controls.locator('[data-decision-id="exercise-target"]');
    await restored.locator(":scope > summary").click();
    await expect(restored).toContainText("用户明确沿用既有决定");
    await expect(restored).toContainText(actualChoice.id);
    await expect(restored).toContainText(mapping.evidenceRef);
    expect((await current()).members).toEqual(saved.members);
    expect((await current()).fusion!.attempts).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("authorization-reuse-after-restart.png"),
    });
    await writeFile(
      test.info().outputPath("authorization-reuse-evidence.json"),
      JSON.stringify(
        {
          evidenceLevel:
            "E pending fixture + real UI/new-reply/reuse action/storage/restart; synthetic exercise, not actual permission or ethical approval",
          pendingProject: project,
          originalChoice: actualChoice,
          mappedChoice: mapping,
          after: await current(),
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
});
