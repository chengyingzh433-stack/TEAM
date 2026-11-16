import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESEARCH_ROLES, type ResearchProject } from "../../contracts/research-group";
import { RESEARCH_METHOD_VERSION } from "../../contracts/research-method";
import { decodeResearchState } from "../../electron/research-group/repository";
import { ensureFusionStageTasks } from "../../electron/research-group/fusion-task-runtime";
import {
  attachResearchTaskInput,
  markResearchTaskDispatched,
  pauseResearchTasks,
  publishResearchTaskResult,
  resumeResearchTasks,
  startResearchTask,
} from "../../electron/research-group/task-graph";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  type DesktopHarness,
} from "../helpers/electron-app";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function chooseFiles(harness: DesktopHarness, files: string[]) {
  // Only the OS picker result is stubbed: these assertions establish application handling, not N.
  await harness.electronApp.evaluate(({ dialog }, filePaths) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths };
    };
  }, files);
}

/** Seed past consumption, not provider execution: the visible changes below remain real UI actions. */
function seedSavedConsumers(p: ResearchProject, sourceId: string): void {
  let graph = resumeResearchTasks(p.fusion!);
  const input = graph.adoptedInputs.find((item) => item.inputId === `source:${sourceId}`)!;
  const at = new Date().toISOString();
  for (const role of ["lead", "librarian"] as const) {
    const attemptId = `fixture-consumer-${role}`;
    graph = markResearchTaskDispatched(
      startResearchTask(graph, `v1:reading:${role}`, { id: attemptId, at, reservedTokens: 100 }),
      attemptId,
      at,
    );
    if (role === "lead")
      graph = attachResearchTaskInput(graph, attemptId, input, {
        at,
        evidenceRef: "fixture-only:prior-consumption",
      });
    graph = publishResearchTaskResult(graph, {
      projectId: p.id,
      id: `fixture-result-${role}`,
      attemptId,
      at,
      content: role === "lead" ? "依赖原文版本的旧判断。" : "不依赖该原文的独立方法整理。",
      usedTokens: 25,
    });
  }
  p.fusion = pauseResearchTasks(graph);
}

test("material replacement and withdrawal apply reviewed impact, preserve originals and survive restart", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("research-material-change-"),
    workspace = await makeWorkspace("research-material-change"),
    agentDir = join(profile, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light" }),
  );
  const files = [join(workspace, "original-study.txt"), join(workspace, "corrected-study.txt")];
  await writeFile(
    files[0]!,
    "合成测试原文：现有观察发现相关关系。\n没有随机分配，不能据此判断因果效果。\n",
  );
  await writeFile(
    files[1]!,
    "合成测试修正版：原先相关关系在控制已有差异后减弱。\n需要重审此前解释，仍不能判断因果效果。\n",
  );
  const originalBytes = await Promise.all(files.map((file) => readFile(file)));
  const sessions: Awaited<ReturnType<typeof seedNamedTextSessionFixture>>[] = [];
  for (const role of RESEARCH_ROLES)
    sessions.push(
      await seedNamedTextSessionFixture(agentDir, workspace, {
        title: `lancer-zone:edu-research-group|材料版本 ${role}`,
        userText: "隔离材料变更测试历史",
        assistantText: "保留的测试记录，不代表实际研究执行。",
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
    const workspaceId = initial.workspaces.find((item) =>
      item.sessions.some((session) => session.id === sessions[0]!.sessionId),
    )?.id;
    if (!workspaceId) throw new Error("Fixture sessions were not discovered");
    await harness.close();
    const at = new Date().toISOString();
    const project: ResearchProject = {
      id: randomUUID(),
      root: { workspaceId, sessionId: sessions[0]!.sessionId },
      workspacePath: workspace,
      objective: "材料替换与撤回的隔离界面测试，不运行真实研究。",
      revision: 1,
      status: "paused",
      createdAt: at,
      updatedAt: at,
      workflowVersion: "fusion-v2",
      methodVersion: RESEARCH_METHOD_VERSION,
      entry: "idea",
      goal: "design",
      currentStage: "reading",
      knowledge: { directory: workspace, sha256: "fixture", version: "isolated-fixture", count: 0 },
      members: RESEARCH_ROLES.map((role, index) => ({
        role,
        ref: { workspaceId, sessionId: sessions[index]!.sessionId },
        status: "idle",
      })),
      artifacts: [],
      packets: [],
      events: [],
    };
    ensureFusionStageTasks(project, at);
    project.fusion = pauseResearchTasks(project.fusion!);
    const researchFile = join(profile, "research-groups.json");
    await writeFile(
      researchFile,
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
    const openProject = async () => {
      await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
      await page
        .locator(`.research-project[data-project-id="${project.id}"] .research-project__name`)
        .click();
      return page.getByRole("region", { name: "教育研究课题组", exact: true });
    };
    const current = async () =>
      (await getDesktopState(page)).researchGroups!.projects.find(
        (item) => item.id === project.id,
      )!;
    let panel = await openProject();
    await chooseFiles(harness, [files[0]!]);
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(1);
    const firstImport = (await current()).importedMaterials![0]!;
    const original = panel.locator(`[data-material-id="${firstImport.id}"]`);
    await original.locator(":scope > summary").click();
    await original
      .getByLabel("original-study.txt 来源及提供说明", { exact: true })
      .fill("自行编制的隔离测试文本，不作为实际研究原文。");
    await original.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect.poll(async () => (await current()).evidence?.sources.length).toBe(1);
    const adopted = structuredClone((await current()).evidence!.sources[0]!);
    const beforeFixture = await current();
    await harness.close();
    // Add only prior dependency/results to the paused fixture between processes. Import and adoption above were UI-driven.
    seedSavedConsumers(beforeFixture, adopted.id);
    const fixtureState = decodeResearchState(JSON.parse(await readFile(researchFile, "utf8")));
    fixtureState.projects = [beforeFixture];
    await writeFile(researchFile, JSON.stringify(fixtureState));
    harness = await launch();
    page = await harness.firstWindow();
    panel = await openProject();
    const unrelatedBefore = structuredClone(
      (await current()).fusion!.tasks.find((task) => task.id === "v1:reading:librarian"),
    );
    await chooseFiles(harness, [files[1]!]);
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(2);
    const replacement = (await current()).importedMaterials!.find(
      (item) => item.name === "corrected-study.txt",
    )!;
    expect((await current()).evidence!.sources[0]).toEqual(adopted);
    const control = panel.getByTestId("research-material-change-control");
    await control.locator(":scope > summary").click();
    await control.getByLabel("当前采用来源", { exact: true }).selectOption(adopted.id);
    await control.getByLabel("替换候选", { exact: true }).selectOption(replacement.id);
    await control
      .getByLabel("替换材料来源及提供说明", { exact: true })
      .fill("同一合成测试原文的修正版，保留原版本以核对影响。");
    await control
      .getByLabel("材料变更原因", { exact: true })
      .fill("修正版削弱原先解释，需要重新核对相关判断。");
    await control.getByRole("button", { name: "查看此次变更的具体影响", exact: true }).click();
    await expect(control.getByTestId("research-material-impact-preview")).toBeVisible();
    expect((await current()).materialHistory ?? []).toHaveLength(0);
    expect((await current()).evidence!.sources[0]).toEqual(adopted);
    await page.screenshot({ path: test.info().outputPath("replacement-impact-before-apply.png") });
    await control.getByRole("button", { name: "应用以上影响并替换版本", exact: true }).click();
    await expect.poll(async () => (await current()).materialHistory?.length).toBe(1);
    const replaced = await current();
    expect(replaced.evidence!.sources).toHaveLength(1);
    expect(replaced.evidence!.sources[0]!.id).toBe(adopted.id);
    expect(replaced.evidence!.sources[0]!.sha256).not.toBe(adopted.sha256);
    expect(replaced.evidence!.sources[0]!.materialImportId).toBe(replacement.id);
    expect(replaced.materialHistory![0]!.evidence.sources).toEqual([adopted]);
    expect(
      replaced.fusion!.artifacts.find((item) => item.id === "fixture-result-lead")!.reviewState,
    ).toBe("needs-review");
    expect(replaced.fusion!.tasks.find((task) => task.id === "v1:reading:librarian")).toEqual(
      unrelatedBefore,
    );
    expect(digest(await readFile(adopted.file))).toBe(adopted.sha256);
    await control.getByLabel("变更方式", { exact: true }).selectOption("withdraw");
    await control
      .getByLabel("材料变更原因", { exact: true })
      .fill("不再将该原文用于本轮判断，保留旧稿和原件。");
    await control.getByRole("button", { name: "查看此次变更的具体影响", exact: true }).click();
    await expect(control.getByTestId("research-material-impact-preview")).toBeVisible();
    await control.getByRole("button", { name: "应用以上影响并撤回使用", exact: true }).click();
    await expect.poll(async () => (await current()).evidence!.sources.length).toBe(0);
    const withdrawn = await current();
    expect(withdrawn.materialHistory).toHaveLength(2);
    expect(withdrawn.materialHistory![1]!.evidence.sources).toEqual(replaced.evidence!.sources);
    const sourceVersion = withdrawn.fusion!.adoptedInputs.find(
      (input) => input.inputId === `source:${adopted.id}`,
    )!;
    expect(
      withdrawn.fusion!.inputs.find(
        (input) =>
          input.inputId === sourceVersion.inputId && input.version === sourceVersion.version,
      )?.availability,
    ).toBe("withdrawn");
    expect(withdrawn.fusion!.tasks.find((task) => task.id === "v1:reading:librarian")).toEqual(
      unrelatedBefore,
    );
    await expect(panel.getByTestId("research-material-change-control")).toHaveCount(0);
    const saved = decodeResearchState(JSON.parse(await readFile(researchFile, "utf8")))
      .projects[0]!;
    expect(saved.materialHistory).toEqual(withdrawn.materialHistory);
    for (let i = 0; i < files.length; i++)
      expect(await readFile(files[i]!)).toEqual(originalBytes[i]);
    for (const imported of withdrawn.importedMaterials!)
      expect(digest(await readFile(imported.original))).toBe(imported.sha256);
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    panel = await openProject();
    const restored = await current();
    expect(restored.evidence).toEqual(withdrawn.evidence);
    expect(restored.materialHistory).toEqual(withdrawn.materialHistory);
    expect(restored.fusion).toEqual(withdrawn.fusion);
    expect(restored.importedMaterials).toEqual(withdrawn.importedMaterials);
    await expect(panel.getByTestId("research-material-change-control")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("withdrawn-materials-after-restart.png"),
    });
    await writeFile(
      test.info().outputPath("material-change-evidence.json"),
      JSON.stringify(
        {
          proof:
            "E: real UI/IPC/persistence with stubbed picker; prior dependency/results are fixtures, no R or native picker claim",
          projectId: project.id,
          sourceId: adopted.id,
          originalHash: adopted.sha256,
          replacementHash: replaced.evidence!.sources[0]!.sha256,
          materialHistory: restored.materialHistory,
          effectiveSources: restored.evidence!.sources,
          graph: restored.fusion,
          originalFiles: files.map((file, i) => ({ file, sha256: digest(originalBytes[i]!) })),
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
});
