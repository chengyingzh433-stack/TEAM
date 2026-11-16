import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESEARCH_ROLES, type ResearchProject } from "../../contracts/research-group";
import { RESEARCH_METHOD_VERSION } from "../../contracts/research-method";
import { decodeResearchState } from "../../electron/research-group/repository";
import {
  createResearchTaskGraph,
  pauseResearchTasks,
} from "../../electron/research-group/task-graph";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
} from "../helpers/electron-app";

// E: an isolated existing paused project plus real renderer, parser, file checks and persistence.
// The OS picker result is stubbed; this does not establish native picker behavior or provider runs.
test("manuscript entry inventory checks real adopted files, preserves review limits and detects missing files across restart", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("research-entry-inventory-"),
    workspace = await makeWorkspace("research-entry-inventory"),
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
        title: `lancer-zone:edu-research-group|材料清点 ${role}`,
        userText: "隔离测试的已有稿件审阅任务",
        assistantText: "仅保留历史，不是研究成果或早期阶段执行证明。",
      }),
    );
  const manuscriptFile = join(workspace, "provided-manuscript.txt");
  const manuscriptText =
    "题目：课堂论证观察的设计说明\n方法：对提供文本进行结构与推断边界核查。\n限制：没有原始观察数据和支持论文原文，不能复算数字或确认引文正确。\n";
  await writeFile(manuscriptFile, manuscriptText);
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
    const first = await getDesktopState(page);
    const workspaceId = first.workspaces.find((item) =>
      item.sessions.some((session) => session.id === sessions[0]!.sessionId),
    )?.id;
    if (!workspaceId) throw new Error("Isolated research sessions were not discovered");
    await harness.close();
    const projectId = randomUUID(),
      at = new Date().toISOString();
    const project: ResearchProject = {
      id: projectId,
      root: { workspaceId, sessionId: sessions[0]!.sessionId },
      workspacePath: workspace,
      objective: "只审阅提供稿件的结构和推断边界，缺原文与数据的判断须保留待核验。",
      revision: 1,
      status: "paused",
      createdAt: at,
      updatedAt: at,
      workflowVersion: "fusion-v2",
      methodVersion: RESEARCH_METHOD_VERSION,
      entry: "manuscript",
      goal: "task",
      path: "quantitative",
      task: { kind: "manuscript-review", scope: "仅审阅当前提供稿件，不重写未选材料" },
      currentStage: "audit",
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
      fusion: pauseResearchTasks(createResearchTaskGraph(projectId, RESEARCH_METHOD_VERSION)),
    };
    const stateFile = join(profile, "research-groups.json");
    await writeFile(
      stateFile,
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
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    const openProject = async () => {
      await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
      await page
        .locator(`.research-project[data-project-id="${projectId}"] .research-project__name`)
        .click();
      return page.getByRole("region", { name: "教育研究课题组", exact: true });
    };
    const current = async () =>
      (await getDesktopState(page)).researchGroups!.projects.find((item) => item.id === projectId)!;
    let panel = await openProject();
    await panel.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect.poll(async () => (await current()).entryInventory?.canStart).toBe(false);
    let inventory = panel.getByTestId("research-entry-inventory");
    await expect(inventory).toContainText("入口条件待补齐");
    expect((await current()).fusion!.attempts).toEqual([]);

    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [manuscriptFile],
    );
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(1);
    const candidate = (await current()).importedMaterials![0]!;
    const item = panel.locator(`[data-material-id="${candidate.id}"]`);
    await item.locator(":scope > summary").click();
    await item
      .getByLabel("provided-manuscript.txt 材料用途", { exact: true })
      .selectOption("manuscript");
    await item
      .getByLabel("provided-manuscript.txt 来源及提供说明", { exact: true })
      .fill("用户提供的隔离测试稿件，允许进行约定范围内审阅，不作为研究文献或真实观察数据。");
    await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect.poll(async () => (await current()).evidence?.sources[0]?.kind).toBe("manuscript");
    await item.locator(":scope > summary").click();
    await panel.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect.poll(async () => (await current()).entryInventory?.canStart).toBe(true);
    inventory = panel.getByTestId("research-entry-inventory");
    if (!(await inventory.evaluate((element) => element.hasAttribute("open"))))
      await inventory.locator(":scope > summary").click();
    await expect(inventory.getByText(/缺少已核实可用的支持原文/)).toBeVisible();
    await expect(inventory.getByText(/数值结果暂不能复算/)).toBeVisible();
    await expect(inventory).toContainText("可按范围继续");
    const available = await current();
    expect(available.entryInventory!.firstMissingStage).toBe("audit");
    expect(available.artifacts).toEqual([]);
    expect(available.fusion!.artifacts).toEqual([]);
    expect(available.fusion!.attempts).toEqual([]);
    expect(available.fusion!.tasks.every((task) => task.stage === "audit")).toBe(true);
    expect(available.evidence!.datasets).toEqual([]);
    expect(await readFile(candidate.original, "utf8")).toBe(manuscriptText);
    await page.screenshot({ path: test.info().outputPath("bounded-manuscript-inventory.png") });

    const source = available.evidence!.sources[0]!;
    const retainedSource = `${source.file}.retained-missing-file-test`;
    await rename(source.file, retainedSource);
    await panel.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect.poll(async () => (await current()).entryInventory?.canStart).toBe(false);
    await expect(inventory).toContainText("入口条件待补齐");
    await expect(inventory.getByText(/已登记来源尚未核对文件/)).toBeVisible();
    const missing = await current();
    expect(missing.status).toBe("paused");
    expect(missing.fusion!.attempts).toEqual([]);
    expect(missing.artifacts).toEqual([]);
    const saved = decodeResearchState(JSON.parse(await readFile(stateFile, "utf8")));
    expect(saved.projects[0]!.entryInventory).toEqual(missing.entryInventory);
    await page.screenshot({ path: test.info().outputPath("missing-manuscript-inventory.png") });
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    panel = await openProject();
    inventory = panel.getByTestId("research-entry-inventory");
    await expect(inventory).toContainText("入口条件待补齐");
    const restored = await current();
    expect(restored.entryInventory).toEqual(missing.entryInventory);
    expect(restored.evidence).toEqual(missing.evidence);
    expect(restored.artifacts).toEqual([]);
    expect(restored.fusion!.attempts).toEqual([]);
    expect(await readFile(manuscriptFile, "utf8")).toBe(manuscriptText);
    expect(await readFile(candidate.original, "utf8")).toBe(manuscriptText);
    expect((await readFile(retainedSource, "utf8")).length).toBeGreaterThan(0);
    await writeFile(
      test.info().outputPath("entry-inventory-evidence.json"),
      JSON.stringify(
        {
          lane: "E, fixture-backed Electron; stubbed OS picker; no provider request",
          projectId,
          available: available.entryInventory,
          missing: missing.entryInventory,
          restored: restored.entryInventory,
          retainedSource,
          artifacts: restored.artifacts.length,
          attempts: restored.fusion!.attempts.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
});
