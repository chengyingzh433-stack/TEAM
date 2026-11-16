import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";
import { writeResearchGroupProvider } from "../helpers/research-group-provider";

test("native Pi changes a member's model at its own stage boundary while other members continue", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("research-stage-routing-"),
    workspace = await makeWorkspace("research-stage-routing"),
    agentDir = join(profile, "agent"),
    kb = join(profile, "course-fixture");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"), { recursive: true });
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "FIXTURE-METHOD",
      title: "研究问题 证据 研究设计 论文写作",
      text: "合成测试知识。问题与证据对应，说明方法与结论的限制。",
      required_context_ids: [],
    }),
  );
  await writeFile(
    join(kb, "溯源", "来源清单.json"),
    JSON.stringify({ version: "routing-fixture" }),
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
  const harness = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    testMode: "background",
    scrubProviderEnv: true,
  });
  try {
    const page = await harness.firstWindow();
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 980),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(kb);
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("legacy");
    await editor.getByLabel("研究运行范围", { exact: true }).selectOption("proposal");
    await expect(
      editor.getByLabel("阶段 1 导师模型", { exact: true }).locator("option"),
    ).toHaveCount(4);
    await editor.getByRole("button", { name: "应用推荐配模", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("recommended-stage-models.png") });
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.config.knowledgeDir)
      .toBe(kb);
    await page
      .getByLabel("New thread prompt")
      .fill("合成演练：AI反馈与实验报告论证质量，打磨问题并审阅初步方案。");
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = (await getDesktopState(page)).researchGroups?.projects[0];
          if (p?.error) throw new Error(p.error);
          return p?.status;
        },
        { intervals: [100, 200] },
      )
      .toBe("completed");
    const project = (await getDesktopState(page)).researchGroups!.projects[0]!;
    const assessment = project.artifacts.find((a) => a.kind === "assessment")!,
      critique = project.artifacts.find((a) => a.kind === "critique")!;
    expect(assessment.content).toContain("模型=gpt-6.1-sol");
    expect(critique.content).toContain("模型=gpt-6-astra");
    expect(assessment).toMatchObject({
      stage: "question",
      model: {
        provider: "research-routing-fixture",
        modelId: "gpt-6.1-sol",
        thinkingLevel: "high",
      },
    });
    expect(critique).toMatchObject({
      stage: "review",
      model: {
        provider: "research-routing-fixture",
        modelId: "gpt-6-astra",
        thinkingLevel: "high",
      },
    });
    expect(new Set(project.members.map((m) => m.ref.sessionId)).size).toBe(4);
    expect(
      project.events.some(
        (e) =>
          e.type === "read" &&
          e.producerRunning &&
          project.artifacts.find((a) => a.id === e.artifactId)?.role !== e.role,
      ),
    ).toBe(true);
    expect(project.artifacts.find((a) => a.kind === "review")?.refs).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath("same-session-model-transition.png") });
    await writeFile(
      test.info().outputPath("stage-routing-proof.json"),
      JSON.stringify(project, null, 2),
    );
  } finally {
    await harness.close();
  }
});
