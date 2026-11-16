import { expect, test } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
import { writeResearchStudyFixture } from "../helpers/research-study-fixture";

test("seven-stage paper pipeline performs native concurrent handoffs, real analysis and persistent export", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("research-paper-pipeline-"),
    workspace = await makeWorkspace("research-paper-pipeline"),
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
  await writeResearchGroupProvider(workspace, profile, { pauseAtAnalysis: true });
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
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 980),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(kb);
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("legacy");
    await editor.getByLabel("研究运行范围", { exact: true }).selectOption("paper");
    const materials = join(profile, "study-inputs");
    await writeResearchStudyFixture(materials);
    await editor.getByLabel("研究材料目录", { exact: true }).fill(materials);
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
          return (
            p?.currentStage === "analysis" &&
            p.members.some((m) => m.stage === "analysis" && m.status === "running")
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.getByRole("button", { name: "暂停全组", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
      .toBe("paused");
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).workspaces
            .flatMap((w) => w.sessions)
            .filter((s) => s.status === "running").length,
      )
      .toBe(0);
    const paused = (await getDesktopState(page)).researchGroups!.projects[0]!;
    expect((await getDesktopState(page)).lastError).toBeUndefined();
    await page.screenshot({ path: test.info().outputPath("paper-analysis-paused.png") });
    await harness.close();
    await writeFile(join(workspace, "analysis-release"), "resume");
    harness = await launch();
    page = await harness.firstWindow();
    const restored = (await getDesktopState(page)).researchGroups!.projects[0]!;
    expect(restored.status).toBe("paused");
    expect(restored.currentStage).toBe("analysis");
    expect(restored.artifacts).toEqual(paused.artifacts);
    expect(restored.members.map((m) => m.ref)).toEqual(paused.members.map((m) => m.ref));
    await page.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = (await getDesktopState(page)).researchGroups?.projects[0];
          if (p?.error) throw new Error(p.error);
          return p?.status;
        },
        { timeout: 60_000 },
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
    expect(project.scope).toBe("paper");
    expect(project.artifacts.filter((a) => a.kind === "stage-review").map((a) => a.stage)).toEqual([
      "literature",
      "design",
      "analysis",
      "writing",
      "audit",
    ]);
    for (const stage of ["literature", "design", "analysis", "writing", "audit"])
      expect(
        project.events.some(
          (e) =>
            e.type === "read" &&
            e.producerRunning &&
            project.artifacts.find((a) => a.id === e.artifactId)?.stage === stage &&
            e.role !== "librarian",
        ),
      ).toBe(true);
    expect(project.analyses?.map((a) => a.role).sort()).toEqual(["lead", "reviewer"]);
    expect(project.analyses![0]!.sha256).toBe(project.analyses![1]!.sha256);
    expect(project.finalPaper).toBeTruthy();
    const exported = project.finalPaper!;
    const acceptedManuscript = project.artifacts
      .filter(
        (a) =>
          a.role === "lead" &&
          a.stage === "audit" &&
          ["stage-draft", "stage-revision"].includes(a.kind),
      )
      .at(-1)!;
    const [markdown, html, provenanceText] = await Promise.all([
      readFile(exported.markdown, "utf8"),
      readFile(exported.html, "utf8"),
      readFile(exported.provenance, "utf8"),
    ]);
    const provenance = JSON.parse(provenanceText) as Record<string, unknown>;
    expect(markdown).toBe(acceptedManuscript.content + "\n");
    expect(html).toContain(`输入版本 ${project.revision}`);
    expect(provenance.manuscriptId).toBe(acceptedManuscript.id);
    expect(provenance.revision).toBe(project.revision);
    expect(provenance.manuscriptSha256).toBe(
      createHash("sha256").update(acceptedManuscript.content).digest("hex"),
    );
    expect(exported.markdown).toContain(`paper-v${project.revision}-${acceptedManuscript.id}`);
    expect(await page.getByRole("button", { name: "打开论文终稿", exact: true }).isVisible()).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath("same-session-model-transition.png") });
    await writeFile(
      test.info().outputPath("paper-pipeline-proof.json"),
      JSON.stringify(project, null, 2),
    );
    const firstGroup = page.locator(`[data-project-id="${project.id}"]`);
    await expect(firstGroup.locator(".session-row")).toHaveCount(4);
    await expect(firstGroup).toContainText("导师 · 课题主线");
    await expect(firstGroup).toContainText("研究者 A · 推进");
    await openNewThread(page);
    await page
      .getByLabel("New thread prompt")
      .fill("第二个独立课题：合成数据中的课堂反馈与学习表现。");
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(
        async () => {
          const projects = (await getDesktopState(page)).researchGroups!.projects;
          return projects.length === 2 && projects.every((p) => p.status === "completed");
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const twoProjects = (await getDesktopState(page)).researchGroups!.projects;
    const second = twoProjects.find((p) => p.id !== project.id)!;
    expect(twoProjects.find((p) => p.id === project.id)!.members.map((m) => m.ref)).toEqual(
      project.members.map((m) => m.ref),
    );
    expect(new Set(twoProjects.flatMap((p) => p.members.map((m) => m.ref.sessionId))).size).toBe(8);
    await expect(page.locator(".research-project")).toHaveCount(2);
    const secondGroup = page.locator(`[data-project-id="${second.id}"]`);
    await expect(secondGroup.locator(".session-row")).toHaveCount(4);
    const firstB = project.members.find((m) => m.role === "reviewer")!.ref.sessionId;
    await firstGroup
      .locator(`[data-session-id="${firstB}"] [data-testid="process-session-row"]`)
      .click();
    await expect.poll(async () => (await getDesktopState(page)).selectedSessionId).toBe(firstB);
    const secondA = second.members.find((m) => m.role === "lead")!.ref.sessionId;
    await secondGroup
      .locator(`[data-session-id="${secondA}"] [data-testid="process-session-row"]`)
      .click();
    await expect.poll(async () => (await getDesktopState(page)).selectedSessionId).toBe(secondA);
    await firstGroup.locator(".research-project__toggle").click();
    await expect(firstGroup.locator(".session-row")).toHaveCount(0);
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    await expect(page.locator(".research-project")).toHaveCount(2);
    const restoredFirst = page.locator(`[data-project-id="${project.id}"]`);
    await expect(restoredFirst.locator(".research-project__toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(restoredFirst.locator(".session-row")).toHaveCount(0);
    await restoredFirst.locator(".research-project__toggle").click();
    await restoredFirst.locator(".research-project__name").click();
    await expect
      .poll(async () => (await getDesktopState(page)).selectedSessionId)
      .toBe(project.root.sessionId);
    await expect(restoredFirst.locator(".session-row")).toHaveCount(4);
    await page.screenshot({
      path: test.info().outputPath("two-research-projects-member-conversations.png"),
    });
  } finally {
    await harness.close();
  }
});
