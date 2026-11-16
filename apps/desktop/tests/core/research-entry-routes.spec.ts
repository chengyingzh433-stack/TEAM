import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, type ResearchMethodConfig } from "../../contracts/research-method";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";
import { writeResearchEntryProvider } from "../helpers/research-entry-provider";

interface EntryCase {
  name: string;
  entry: NonNullable<ResearchMethodConfig["entry"]>;
  goal: NonNullable<ResearchMethodConfig["goal"]>;
  stage: (typeof FUSION_STAGE_IDS)[number];
  task?: ResearchMethodConfig["task"];
  adopt?: "design" | "manuscript";
}
const cases: EntryCase[] = [
  {
    name: "no idea completes only bounded S0 direction",
    entry: "discovery",
    goal: "direction",
    stage: "scan",
  },
  {
    name: "existing title completes only S1 question",
    entry: "idea",
    goal: "question",
    stage: "question",
  },
  {
    name: "UI-adopted existing design continues at S5 without fabricated early acceptance",
    entry: "materials",
    goal: "design",
    stage: "design",
    adopt: "design",
  },
  {
    name: "exactly three citations stay in audit with three active roles",
    entry: "task",
    goal: "task",
    stage: "audit",
    task: {
      kind: "citations",
      scope:
        "只核查 ENTRY-A、ENTRY-B、ENTRY-C 三条引用；ENTRY-UNSELECTED 不在本轮范围，不读取、不修改。",
    },
  },
  {
    name: "UI-adopted manuscript completes bounded audit without CSV",
    entry: "manuscript",
    goal: "task",
    stage: "audit",
    adopt: "manuscript",
    task: {
      kind: "manuscript-review",
      scope: "仅审阅提供稿件的结构和推断边界；缺原文及数据时保留待核验，不复算数值。",
    },
  },
];

async function setup(entry: EntryCase) {
  const profile = await makeUserDataDir("research-entry-routes-"),
    workspace = await makeWorkspace("research-entry-routes");
  const agentDir = join(profile, "agent"),
    kb = join(profile, "course"),
    materials = join(profile, "materials");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"), { recursive: true });
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "ENTRY-METHOD",
      title: "研究问题 证据 边界",
      text: "合成测试方法：只完成所选范围，已有材料不代表早期阶段已经执行。",
      required_context_ids: [],
    }),
  );
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "entry-fixture" }));
  await mkdir(materials, { recursive: true });
  const ids = ["ENTRY-A", "ENTRY-B", "ENTRY-C", "ENTRY-UNSELECTED"];
  for (const id of ids)
    await writeFile(
      join(materials, `${id}.txt`),
      `合成软件验收来源 ${id}，不是真实研究。课堂论证需要原始文本；满意度不等于论证质量，关联不代表因果。`,
    );
  await writeFile(
    join(materials, "manifest.json"),
    JSON.stringify({
      version: 1,
      sources: ids.map((id) => ({
        id,
        title: `合成来源 ${id}`,
        authors: "fixture",
        year: "2026",
        url: `https://example.test/${id}`,
        file: `${id}.txt`,
        kind: "paper",
      })),
      datasets: [],
    }),
  );
  const supplied = join(workspace, `provided-${entry.adopt ?? "unused"}.txt`);
  await writeFile(
    supplied,
    "合成测试材料：课堂论证观察方案／稿件。\n研究问题、对象和材料条件仍需核查；仅审阅所提供文本，不宣称存在数据、效果或已通过早期研究。\n",
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "research-entry-fixture",
      defaultModel: "gpt-6.1-sol",
      enabledModels: ["research-entry-fixture/gpt-6.1-sol"],
      compaction: { enabled: false },
    }),
  );
  await writeResearchEntryProvider(
    workspace,
    entry.task?.kind === "citations" ? ids.slice(0, 3) : undefined,
  );
  const harness = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    testMode: "background",
    scrubProviderEnv: true,
  });
  return { harness, kb, materials, supplied };
}

function assertBoundedExecution(project: ResearchProject, entry: EntryCase) {
  const roles = entry.goal === "task" ? ["lead", "reviewer", "mentor"] : [...RESEARCH_ROLES];
  expect(project.status).toBe("completed");
  expect(project.currentStage).toBe(entry.stage);
  expect(project.evidence?.datasets).toEqual([]);
  expect(project.analyses ?? []).toEqual([]);
  expect(new Set(project.artifacts.map((artifact) => artifact.stage))).toEqual(
    new Set([entry.stage]),
  );
  expect(
    new Set(project.events.filter((event) => event.type === "started").map((event) => event.role)),
  ).toEqual(new Set(roles));
  const attempts = project.fusion!.attempts;
  expect(attempts.length).toBeGreaterThan(0);
  for (const attempt of attempts)
    expect(project.fusion!.tasks.find((task) => task.id === attempt.taskId)?.stage).toBe(
      entry.stage,
    );
  if (entry.goal === "task")
    expect(
      new Set(
        project
          .fusion!.tasks.filter((task) => task.id.startsWith(`v${project.revision}:`))
          .map((task) => task.role),
      ),
    ).toEqual(new Set(roles));
  for (const kind of [
    "stage-draft",
    "stage-risk",
    "stage-critique",
    "stage-revision",
    "stage-verification",
    "stage-review",
  ])
    expect(project.artifacts.some((artifact) => artifact.kind === kind)).toBe(true);
  const revised = project.artifacts.find((artifact) => artifact.kind === "stage-revision")!;
  const verification = project.artifacts.find(
    (artifact) => artifact.kind === "stage-verification",
  )!;
  const accepted = project.artifacts.find(
    (artifact) => artifact.kind === "stage-review" && artifact.verdict === "accept",
  )!;
  expect(verification.refs).toContain(revised.id);
  expect(accepted.refs).toEqual(expect.arrayContaining([revised.id, verification.id]));
  expect(
    project.events.some(
      (event) =>
        event.type === "read" && event.role === "reviewer" && event.artifactId === revised.id,
    ),
  ).toBe(true);
  expect(
    project.events.some(
      (event) =>
        event.type === "read" && event.role === "mentor" && event.artifactId === verification.id,
    ),
  ).toBe(true);
  const expectedSources =
    entry.task?.kind === "citations"
      ? ["ENTRY-A", "ENTRY-B", "ENTRY-C"]
      : project.evidence!.sources.map((source) => source.id);
  for (const role of roles)
    expect(
      new Set(
        project.events
          .filter((event) => event.type === "source-read" && event.role === role)
          .map((event) => event.sourceId),
      ),
    ).toEqual(new Set(expectedSources));
  expect(new Set(revised.sourceIds)).toEqual(new Set(expectedSources));
  if (entry.task?.kind === "citations")
    expect(project.events.some((event) => event.sourceId === "ENTRY-UNSELECTED")).toBe(false);
}

for (const entry of cases)
  test(`AC20 ${entry.name}`, async () => {
    test.setTimeout(120_000);
    const f = await setup(entry),
      page = await f.harness.firstWindow();
    const current = async () => (await getDesktopState(page)).researchGroups?.projects[0];
    try {
      await f.harness.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
      );
      await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
      await openNewThread(page);
      const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
      await editor.getByLabel("课程知识库目录", { exact: true }).fill(f.kb);
      await editor.getByLabel("研究材料目录", { exact: true }).fill(entry.adopt ? "" : f.materials);
      await editor.getByLabel("研究入口", { exact: true }).selectOption(entry.entry);
      await editor.getByLabel("本轮研究目标", { exact: true }).selectOption(entry.goal);
      if (entry.task) {
        await editor.getByLabel("单项任务类型", { exact: true }).selectOption(entry.task.kind);
        await editor.getByLabel("单项任务范围", { exact: true }).fill(entry.task.scope);
      }
      await editor.getByLabel("成员 Token 上限", { exact: true }).fill("500000");
      for (let index = 0; index < FUSION_STAGE_IDS.length; index++)
        for (const role of RESEARCH_ROLES)
          await editor
            .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}模型`, { exact: true })
            .selectOption(
              JSON.stringify({ provider: "research-entry-fixture", modelId: "gpt-6.1-sol" }),
            );
      await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
      await expect(editor).toBeHidden();
      await page
        .getByLabel("New thread prompt")
        .fill(
          `确定性软件验收：${entry.name}。${entry.task?.scope ?? "仅完成所选本轮目标；不执行后续阶段，不虚构早期已接受成果。"}`,
        );
      await page.getByRole("button", { name: "Start thread", exact: true }).click();
      await expect.poll(async () => (await current())?.revision).toBe(1);
      const panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
      if (entry.adopt) {
        await expect.poll(async () => (await current())?.status).toBe("paused");
        expect((await current())!.fusion!.attempts).toEqual([]);
        await f.harness.electronApp.evaluate(
          ({ dialog }, filePaths) => {
            const original = dialog.showOpenDialog;
            dialog.showOpenDialog = async () => {
              dialog.showOpenDialog = original;
              return { canceled: false, filePaths };
            };
          },
          [f.supplied],
        );
        await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
        await expect.poll(async () => (await current())?.importedMaterials?.length).toBe(1);
        const material = (await current())!.importedMaterials![0]!,
          item = panel.locator(`[data-material-id="${material.id}"]`);
        await item.locator(":scope > summary").click();
        await item
          .getByLabel(`${basename(f.supplied)} 材料用途`, { exact: true })
          .selectOption(entry.adopt);
        await item
          .getByLabel(`${basename(f.supplied)} 来源及提供说明`, { exact: true })
          .fill("用户提供的合成软件验收材料；仅用于限定范围审阅，不是真实研究来源或数据。");
        await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
        await expect
          .poll(async () => (await current())?.evidence?.sources[0]?.kind)
          .toBe(entry.adopt);
        await item.locator(":scope > summary").click();
        await panel.getByRole("button", { name: "清点实际材料", exact: true }).click();
        await expect
          .poll(async () => (await current())?.entryInventory?.firstMissingStage)
          .toBe(entry.stage);
        expect((await current())!.entryInventory!.canStart).toBe(true);
        expect((await current())!.artifacts).toEqual([]);
        if (entry.adopt === "manuscript") {
          const inventory = panel.getByTestId("research-entry-inventory");
          if (!(await inventory.evaluate((element) => element.hasAttribute("open"))))
            await inventory.locator(":scope > summary").click();
          await expect(inventory).toContainText("数值结果暂不能复算");
          await expect(inventory).toContainText("支持原文");
        }
        await page.screenshot({
          path: test.info().outputPath("adopted-entry-before-execution.png"),
        });
        await panel.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
      }
      await expect
        .poll(
          async () => {
            const project = await current();
            const errors = project?.events.filter((event) => event.type === "error") ?? [];
            if (errors.length) throw new Error(errors.map((event) => event.detail).join("\n"));
            return project?.status;
          },
          { timeout: 75_000 },
        )
        .toBe("completed");
      const project = (await current())!;
      assertBoundedExecution(project, entry);
      await expect(panel).toContainText("本轮审阅完成");
      await page.screenshot({ path: test.info().outputPath("bounded-entry-completed.png") });
      await writeFile(
        test.info().outputPath("entry-route-evidence.json"),
        JSON.stringify(
          {
            evidenceLevel:
              "E: actual UI, native Pi tools, deterministic local provider; synthetic sources are not R/C content truth",
            entry,
            project,
          },
          null,
          2,
        ),
      );
    } finally {
      try {
        await writeFile(
          test.info().outputPath("entry-route-exit-state.json"),
          JSON.stringify((await current()) ?? null, null, 2),
        );
      } finally {
        await f.harness.close();
      }
    }
  });
