import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
  writeProjectExtension,
} from "../helpers/electron-app";

test("CYZ mode carries research guidance through editing, model handoff and restart without installing a skill", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir();
  const agentDir = join(profile, "agent");
  const workspace = await makeWorkspace("cyz-research");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ themeMode: "light", language: "en" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "cyz-fixture",
      defaultModel: "gpt-research-a",
      enabledModels: ["cyz-fixture/gpt-research-a", "cyz-fixture/gpt-research-b"],
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(
    workspace,
    "cyz-fixture.ts",
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  pi.registerProvider("cyz-fixture", { baseUrl: "http://127.0.0.1:9/unused", apiKey: "LOCAL_FIXTURE", api: "cyz-fixture",
    models: ["gpt-research-a", "gpt-research-b"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context) {
      const users = context.messages.filter(m => m.role === "user");
      const first = JSON.stringify(users[0]?.content), last = JSON.stringify(users.at(-1)?.content);
      const text = "MODEL=" + model.id + " TURNS=" + users.length
        + " ENTRY=" + first.includes("入口识别与项目续接")
        + " CONTEXT=" + first.includes("课堂观察 CYZ-726")
        + " STAGE1=" + last.includes("# S1 · 问题打磨")
        + " MY_IDEA=" + last.includes("保留学生自己的解释")
        + " SOURCE=" + last.includes("integrity-gates.md")
        + " FINAL=" + last.includes("# S8 · 稿件审查与按需输出")
        + " SCOPED=" + last.includes("验收针对本轮实际完成的范围")
        + " RAW_SKILL=" + last.includes("## Gate S8: Finalization");
      const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: { ...message, content: [] } }); stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message }); stream.push({ type: "done", reason: "stop", message }); return stream;
    }
  });
}
`,
  );
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      testMode: "foreground",
    });
  let harness = await launch();
  const errors: string[] = [];
  try {
    let page = await harness.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 980),
    );
    await page.getByRole("button", { name: "论文查询", exact: true }).click({ button: "right" });
    let manager = page.getByRole("dialog", { name: "管理模块", exact: true });
    await manager.getByRole("button", { name: "配置阶段、模型与 Skill" }).click();
    let editor = page.getByRole("dialog", { name: "配置模块流程", exact: true });
    await expect(editor.locator("fieldset")).toHaveCount(4);
    await expect(editor.getByLabel("阶段 1 名称", { exact: true })).toHaveValue("检索论文");
    await expect(editor.getByLabel("阶段 1 目标", { exact: true })).toHaveValue("");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "CYZ 论文工作台", exact: true }).click();
    await openNewThread(page);
    await page
      .getByLabel("New thread prompt")
      .fill(
        "课堂观察 CYZ-726：学生会套公式，但不能解释公式为什么适用。已有想法，请从打磨问题开始。",
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(page.locator(".process-assistant").last()).toContainText(
      "ENTRY=true CONTEXT=true",
    );
    await expect
      .poll(async () =>
        (await getDesktopState(page)).workspaces
          .flatMap((item) => item.sessions)
          .some((item) => item.status === "running"),
      )
      .toBe(false);
    const firstState = await getDesktopState(page);
    const sessionId = firstState.selectedSessionId;
    expect(
      firstState.runtimeByWorkspace[workspace]?.skills.some(
        (skill) => skill.name === "cyz-edu-research",
      ),
    ).toBe(false);
    await expect(
      page.getByTestId("module-workflow").getByRole("button", { name: /^交接阶段/ }),
    ).toHaveCount(9);
    await page.screenshot({ path: test.info().outputPath("cyz-entry.png") });
    await page.getByLabel("设置模型交接流程").click();
    editor = page.getByRole("dialog", { name: "配置模块流程", exact: true });
    await expect(editor.locator("fieldset")).toHaveCount(9);
    await expect(editor.getByLabel("阶段 1 目标", { exact: true })).toHaveValue(
      /哪些教育研究方向值得探索/,
    );
    await expect(editor.getByLabel("阶段 2 交付物", { exact: true })).toHaveValue(
      /交付：问题卡[\s\S]+验收：/,
    );
    expect(
      await editor
        .getByLabel("阶段 1 交付物", { exact: true })
        .evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
    ).toBe(true);
    const optionalSkills = editor.locator("fieldset").first().locator("details");
    await optionalSkills.locator("summary").click();
    await expect(optionalSkills).toContainText("无需另装 CYZ 技能");
    await optionalSkills.locator("summary").click();
    await expect(editor.getByLabel("阶段 9 名称", { exact: true })).toHaveValue(
      "S8 全文审查与正式输出",
    );
    await editor
      .getByLabel("为未配置阶段选择模型", { exact: true })
      .selectOption("cyz-fixture/gpt-research-a");
    await editor
      .getByLabel("阶段 2 模型", { exact: true })
      .selectOption("cyz-fixture/gpt-research-b");
    await editor
      .getByLabel("阶段 2 目标", { exact: true })
      .fill("保留学生自己的解释，检查教学困惑能否转化为可回答的问题。");
    await page.screenshot({ path: test.info().outputPath("cyz-workflow-editor.png") });
    await editor.getByLabel("阶段 9 目标", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("cyz-final-stage.png") });
    await editor.getByRole("button", { name: "保存流程", exact: true }).click();
    await page.getByLabel("交接阶段 2：S1 实践问题与研究问题", { exact: true }).click();
    const composer = page.getByTestId("composer");
    await composer.fill("这段草稿不能被覆盖");
    await expect
      .poll(async () => (await getDesktopState(page)).composerDraft)
      .toBe("这段草稿不能被覆盖");
    await page.getByRole("button", { name: "载入任务", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("输入框已有草稿");
    await expect(composer).toHaveValue("这段草稿不能被覆盖");
    await composer.fill("");
    await expect.poll(async () => (await getDesktopState(page)).composerDraft).toBe("");
    await page.getByRole("button", { name: "载入任务", exact: true }).click();
    await expect(composer).toHaveValue(/# S1 · 问题打磨/);
    await expect(composer).toHaveValue(/保留学生自己的解释/);
    await expect(composer).not.toHaveValue(/^\/skill:/);
    await expect(composer).not.toHaveValue(/## Canonical Records/);
    await composer.press("Enter");
    await expect(page.locator(".process-assistant").last()).toContainText(
      "MODEL=gpt-research-b TURNS=2 ENTRY=true CONTEXT=true STAGE1=true MY_IDEA=true SOURCE=true",
    );
    await expect(page.locator(".process-assistant").last()).toContainText(
      "SCOPED=true RAW_SKILL=false",
    );
    await expect
      .poll(async () =>
        (await getDesktopState(page)).workspaces
          .flatMap((item) => item.sessions)
          .some((item) => item.status === "running"),
      )
      .toBe(false);
    expect((await getDesktopState(page)).selectedSessionId).toBe(sessionId);
    await expect(composer).toHaveValue("");
    await expect.poll(async () => (await getDesktopState(page)).composerDraft).toBe("");
    // Single-paper reading remains a bounded task even though the module has
    // nine stages. Loading a task is still an editable draft, not an auto-run.
    await page.getByLabel("交接阶段 4：S3 文献筛选与分级阅读", { exact: true }).click();
    await expect(
      page.getByLabel("交接阶段 4：S3 文献筛选与分级阅读", { exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "载入任务", exact: true }).click();
    await expect(composer).toHaveValue(/一次性读论文无需创建整套研究目录/);
    await expect(composer).toHaveValue(/原文能够直接阅读时即可核验/);
    await expect(page.locator(".process-assistant").last()).toContainText("TURNS=2");
    await composer.fill("");
    await expect.poll(async () => (await getDesktopState(page)).composerDraft).toBe("");
    await page.getByLabel("交接阶段 2：S1 实践问题与研究问题", { exact: true }).click();
    await expect(
      page.getByLabel("交接阶段 2：S1 实践问题与研究问题", { exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1000, 760),
    );
    await expect(page.getByLabel("设置模型交接流程")).toBeInViewport();
    await expect(composer).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("cyz-narrow.png") });
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await expect(
      page.getByLabel("交接阶段 2：S1 实践问题与研究问题", { exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect((await getDesktopState(page)).selectedSessionId).toBe(sessionId);
    await page.getByLabel("设置模型交接流程").click();
    editor = page.getByRole("dialog", { name: "配置模块流程", exact: true });
    await expect(editor.getByLabel("阶段 2 目标", { exact: true })).toHaveValue(
      /保留学生自己的解释/,
    );
    await expect(editor.getByLabel("阶段 9 模型", { exact: true })).toHaveValue(
      "cyz-fixture/gpt-research-a",
    );
    await page.keyboard.press("Escape");
    await page.getByLabel("交接阶段 9：S8 全文审查与正式输出", { exact: true }).click();
    await expect(
      page.getByLabel("交接阶段 9：S8 全文审查与正式输出", { exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("composer")).toHaveValue("");
    await page.getByRole("button", { name: "载入任务", exact: true }).click();
    await expect(page.getByTestId("composer")).toHaveValue(/# S8 · 稿件审查与按需输出/);
    await expect(page.getByTestId("composer")).toHaveValue(/局部检查不称全文通过/);
    await page.getByTestId("composer").press("Enter");
    await expect(page.locator(".process-assistant").last()).toContainText(
      "MODEL=gpt-research-a TURNS=3 ENTRY=true CONTEXT=true",
    );
    await expect(page.locator(".process-assistant").last()).toContainText("FINAL=true");
    await expect
      .poll(async () =>
        (await getDesktopState(page)).workspaces
          .flatMap((item) => item.sessions)
          .some((item) => item.status === "running"),
      )
      .toBe(false);
    await page.screenshot({ path: test.info().outputPath("cyz-restarted.png") });
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});
