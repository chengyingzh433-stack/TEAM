import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RESEARCH_ROLES,
  researchStages,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import { formatSessionTitleForZone } from "../../contracts/lancer-zones";
import { decodeResearchState } from "../../electron/research-group/repository";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
  seedNamedTextSessionFixture,
} from "../helpers/electron-app";
import { writeResearchGroupProvider } from "../helpers/research-group-provider";

/** Credential-free configuration proof. No research/provider result is claimed by this spec. */
async function navigationFixture() {
  const profile = await makeUserDataDir("research-fusion-navigation-");
  const workspace = await makeWorkspace("research-fusion-navigation");
  const agentDir = join(profile, "agent"),
    kb = join(profile, "course-fixture");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"), { recursive: true });
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "FIXTURE-METHOD",
      title: "研究问题与证据",
      text: "合成界面测试方法，不能作为真实研究材料。",
      required_context_ids: [],
    }),
  );
  await writeFile(
    join(kb, "溯源", "来源清单.json"),
    JSON.stringify({ version: "navigation-fixture" }),
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "research-routing-fixture",
      defaultModel: "gpt-6.1-sol",
      enabledModels: [
        "research-routing-fixture/gpt-6-astra",
        "research-routing-fixture/gpt-6.1-sol",
        "research-routing-fixture/deepseek-flash",
      ],
      compaction: { enabled: false },
    }),
  );
  await writeResearchGroupProvider(workspace, profile);
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      testMode: "background",
      scrubProviderEnv: true,
    });
  return { profile, workspace, agentDir, kb, launch };
}

test("fusion configuration separates entry and goal, keeps budget, and restores all nine stage choices", async () => {
  test.setTimeout(120_000);
  const f = await navigationFixture();
  let harness = await f.launch();
  try {
    let page = await harness.firstWindow();
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 980),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    let editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await expect(editor.getByLabel("研究流程版本", { exact: true })).toHaveValue("fusion-v2");
    await expect(editor.locator("fieldset[data-stage-id]")).toHaveCount(9);
    expect(
      await editor
        .locator("fieldset[data-stage-id]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-stage-id"))),
    ).toEqual(FUSION_STAGE_IDS);
    await expect(editor.getByLabel("本轮研究目标", { exact: true })).toHaveValue("design");
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(f.kb);
    await editor.getByLabel("成员 Token 上限", { exact: true }).fill("42000");
    for (const entry of ["discovery", "idea", "materials", "manuscript", "task"]) {
      await editor.getByLabel("研究入口", { exact: true }).selectOption(entry);
      await expect(editor.getByLabel("本轮研究目标", { exact: true })).toHaveValue("design");
      await expect(editor.getByLabel("成员 Token 上限", { exact: true })).toHaveValue("42000");
    }
    for (const goal of ["direction", "question", "paper", "task", "design"]) {
      await editor.getByLabel("本轮研究目标", { exact: true }).selectOption(goal);
      await expect(editor.getByLabel("研究入口", { exact: true })).toHaveValue("task");
      await expect(editor.getByLabel("成员 Token 上限", { exact: true })).toHaveValue("42000");
    }
    await editor.getByLabel("研究入口", { exact: true }).selectOption("idea");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("direction");
    await expect(editor.getByLabel("本轮路由说明", { exact: true })).toContainText(
      /本轮方法范围：\s*S1。/,
    );
    await expect(editor.getByLabel("本轮路由说明", { exact: true })).toContainText(
      "不重新做宽泛S0",
    );
    await editor.getByLabel("研究入口", { exact: true }).selectOption("task");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("task");
    await editor.getByLabel("单项任务类型", { exact: true }).selectOption("chapter-edit");
    await editor.getByLabel("单项任务范围", { exact: true }).fill("只修改讨论章，其余正文保留");
    await expect(editor.getByLabel("本轮路由说明", { exact: true })).toContainText(
      /本轮方法范围：\s*S7。/,
    );
    await editor.getByLabel("研究入口", { exact: true }).selectOption("materials");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("design");
    await expect(editor.getByLabel("本轮路由说明", { exact: true })).toContainText(
      "先清点实际材料",
    );
    await editor.getByLabel("研究路径", { exact: true }).selectOption("theoretical");
    await expect(
      editor.getByLabel("阶段 1 导师模型", { exact: true }).locator("option"),
    ).toHaveCount(4);
    for (let index = 0; index < FUSION_STAGE_IDS.length; index++) {
      const field = editor.locator(`fieldset[data-stage-id="${FUSION_STAGE_IDS[index]}"]`);
      await field
        .getByLabel(`阶段 ${index + 1} 名称`, { exact: true })
        .fill(`自定义方法 S${index}`);
      await field
        .getByLabel(`阶段 ${index + 1} 目标`, { exact: true })
        .fill(`阶段 S${index} 的保存与恢复检查，未执行研究。`);
      await field.getByLabel(`阶段 ${index + 1} 导师模型`, { exact: true }).selectOption(
        JSON.stringify({
          provider: "research-routing-fixture",
          modelId: index % 2 ? "gpt-6.1-sol" : "gpt-6-astra",
        }),
      );
      await field
        .getByLabel(`阶段 ${index + 1} 导师思考强度`, { exact: true })
        .selectOption(index % 2 ? "low" : "high");
    }
    await page.screenshot({ path: test.info().outputPath("nine-stage-config.png") });
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.config.workflowVersion)
      .toBe("fusion-v2");
    const config = (await getDesktopState(page)).researchGroups!.config;
    expect(config).toMatchObject({
      workflowVersion: "fusion-v2",
      methodVersion: "2.0.0",
      entry: "materials",
      goal: "design",
      path: "theoretical",
      scope: "proposal",
      memberTokenBudget: 42000,
    });
    expect(config.stages?.map((stage) => stage.id)).toEqual(FUSION_STAGE_IDS);
    await harness.close();
    harness = await f.launch();
    page = await harness.firstWindow();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.config)
      .toEqual(config);
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    await page.getByRole("button", { name: "配置阶段、模型与知识库", exact: true }).click();
    editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await expect(editor.getByLabel("研究入口", { exact: true })).toHaveValue("materials");
    await expect(editor.getByLabel("本轮研究目标", { exact: true })).toHaveValue("design");
    await expect(editor.getByLabel("成员 Token 上限", { exact: true })).toHaveValue("42000");
    for (let index = 0; index < FUSION_STAGE_IDS.length; index++) {
      await expect(editor.getByLabel(`阶段 ${index + 1} 名称`, { exact: true })).toHaveValue(
        `自定义方法 S${index}`,
      );
      await expect(editor.getByLabel(`阶段 ${index + 1} 导师模型`, { exact: true })).toHaveValue(
        JSON.stringify({
          provider: "research-routing-fixture",
          modelId: index % 2 ? "gpt-6.1-sol" : "gpt-6-astra",
        }),
      );
      await expect(
        editor.getByLabel(`阶段 ${index + 1} 导师思考强度`, { exact: true }),
      ).toHaveValue(index % 2 ? "low" : "high");
    }
    await page.screenshot({ path: test.info().outputPath("nine-stage-restored.png") });
    await writeFile(
      test.info().outputPath("saved-method-config.json"),
      JSON.stringify(config, null, 2),
    );
  } finally {
    await harness.close();
  }
});

test("opening legacy two and seven stage projects and saving a fusion template preserves old records", async () => {
  test.setTimeout(120_000);
  const f = await navigationFixture();
  // These are explicit upgrade fixtures, not newly executed research or simulated user approvals.
  const sessions = [];
  for (const count of [2, 7]) {
    const members = [];
    for (const role of RESEARCH_ROLES) {
      const seeded = await seedNamedTextSessionFixture(f.agentDir, f.workspace, {
        title: formatSessionTitleForZone("edu-research-group", `旧${count}阶段-${role}`),
        userText: `旧${count}阶段 ${role} 原始输入`,
        assistantText: `旧${count}阶段 ${role} 原始成果，请保留。`,
      });
      members.push({ role, sessionId: seeded.sessionId });
    }
    sessions.push({ count, members });
  }
  let harness = await f.launch();
  try {
    let page = await harness.firstWindow();
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).workspaces.find((w) => w.path === f.workspace)?.sessions
            .length,
      )
      .toBe(8);
    const workspaceId = (await getDesktopState(page)).workspaces.find(
      (w) => w.path === f.workspace,
    )!.id;
    await harness.close();
    const pin = (await ResearchKnowledge.open(f.kb)).pin;
    const projects: ResearchProject[] = sessions.map(({ count, members }) => {
      const stages = researchStages().slice(0, count);
      stages.forEach((stage, index) => {
        stage.title = `旧${count}阶段自定义${index + 1}`;
        stage.models.reviewer = {
          provider: "research-routing-fixture",
          modelId: "gpt-6-astra",
          thinkingLevel: "max",
        };
      });
      const ref = (sessionId: string) => ({ workspaceId, sessionId });
      return {
        id: randomUUID(),
        root: ref(members[0]!.sessionId),
        workspacePath: f.workspace,
        objective: `旧${count}阶段课题原文，不能自动重跑或迁移。`,
        revision: 1,
        status: "completed",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        knowledge: pin,
        members: members.map(({ role, sessionId }) => ({
          role,
          ref: ref(sessionId),
          status: "idle",
        })),
        stages,
        scope: count === 2 ? "proposal" : "paper",
        memberTokenBudget: 37000 + count,
        currentStage: count === 2 ? "review" : "audit",
        artifacts: [
          {
            id: randomUUID(),
            role: "mentor",
            kind: count === 2 ? "review" : "stage-review",
            stage: count === 2 ? "review" : "audit",
            revision: 1,
            round: 1,
            createdAt: "2026-11-01T00:00:00.000Z",
            content: `旧${count}阶段模型裁定原文；本记录是升级测试fixture。`,
            refs: [],
            verdict: "accept",
            toolCallId: `legacy-${count}-review`,
          },
        ],
        packets: [],
        events: [],
      };
    });
    // Validate fixture shapes with the same decoder used by actual startup.
    expect(
      decodeResearchState({ version: 1, config: { knowledgeDir: f.kb }, projects }).projects,
    ).toEqual(projects);
    const researchFile = join(f.profile, "research-groups.json");
    await writeFile(
      researchFile,
      JSON.stringify(
        {
          version: 1,
          config: {
            knowledgeDir: f.kb,
            stages: researchStages().slice(0, 2),
            scope: "paper",
            memberTokenBudget: 38000,
          },
          projects,
        },
        null,
        2,
      ),
    );
    harness = await f.launch();
    page = await harness.firstWindow();
    await page
      .getByRole("button", { name: "教育研究课题组", exact: true })
      .click({ button: "right" });
    const manager = page.getByRole("dialog", { name: "管理模块", exact: true });
    await manager.getByRole("button", { name: "配置阶段、角色与模型", exact: true }).click();
    const savedEditor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await expect(savedEditor.getByLabel("研究流程版本", { exact: true })).toHaveValue("legacy");
    await expect(savedEditor.locator("fieldset[data-stage-id]")).toHaveCount(2);
    await expect(savedEditor.getByLabel("成员 Token 上限", { exact: true })).toHaveValue("38000");
    await savedEditor
      .getByRole("button", { name: "检查并保存连接与阶段配置", exact: true })
      .click();
    await expect(savedEditor).toBeHidden();
    const retainedTemplate = (await getDesktopState(page)).researchGroups!.config;
    expect(retainedTemplate.workflowVersion).toBeUndefined();
    expect(retainedTemplate.stages).toEqual(researchStages().slice(0, 2));
    expect(retainedTemplate.memberTokenBudget).toBe(38000);
    await manager.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    for (const project of projects) {
      const group = page.locator(`[data-project-id="${project.id}"]`);
      await expect(group).toBeVisible();
      await group.locator(".research-project__name").click();
      await expect(page.getByRole("region", { name: "教育研究课题组", exact: true })).toContainText(
        "旧研究流程",
      );
      await page.getByRole("button", { name: "配置阶段、模型与知识库", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
      await expect(editor.getByLabel("研究流程版本", { exact: true })).toHaveCount(0);
      await expect(editor.getByLabel("研究运行范围", { exact: true })).toHaveValue(project.scope!);
      await expect(editor.getByLabel("阶段 1 名称", { exact: true })).toHaveValue(
        project.stages![0]!.title,
      );
      await expect(editor.getByLabel("成员 Token 上限", { exact: true })).toHaveValue(
        String(project.memberTokenBudget),
      );
      await editor.getByRole("button", { name: "取消", exact: true }).click();
    }
    expect((await getDesktopState(page)).researchGroups!.projects).toEqual(projects);
    await openNewThread(page);
    await page.getByRole("button", { name: "配置阶段、模型与知识库", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await expect(editor.getByLabel("研究流程版本", { exact: true })).toHaveValue("fusion-v2");
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    expect((await getDesktopState(page)).researchGroups!.projects).toEqual(projects);
    await harness.close();
    harness = await f.launch();
    page = await harness.firstWindow();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects)
      .toEqual(projects);
    const persisted: unknown = JSON.parse(await readFile(researchFile, "utf8"));
    expect(persisted).toMatchObject({ projects });
    await writeFile(
      test.info().outputPath("legacy-records-preserved.json"),
      JSON.stringify(
        {
          fixture: true,
          projects,
          restored: (await getDesktopState(page)).researchGroups!.projects,
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: test.info().outputPath("legacy-projects-after-restart.png") });
  } finally {
    await harness.close();
  }
});
