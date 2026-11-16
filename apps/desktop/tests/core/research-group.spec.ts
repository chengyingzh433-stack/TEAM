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
  writeProjectExtension,
} from "../helpers/electron-app";

test("independent research mode connects a local library, opens four native sessions, pauses all and restores without replay", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("research-ui-"),
    workspace = await makeWorkspace("research-ui"),
    agentDir = join(profile, "agent"),
    kb = join(profile, "course-fixture");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await Promise.all([
    mkdir(join(kb, "索引"), { recursive: true }),
    mkdir(join(kb, "溯源"), { recursive: true }),
  ]);
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "UI-METHOD",
      title: "研究问题与证据",
      text: "合成的界面测试资料，不包含真实课程。",
      required_context_ids: [],
    }),
  );
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "ui-fixture" }));
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "team-fixture",
      defaultModel: "gpt-6.1-sol",
      enabledModels: [
        "team-fixture/gpt-6-astra",
        "team-fixture/gpt-6.1-sol",
        "team-fixture/deepseek-flash",
      ],
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(
    workspace,
    "team-fixture.ts",
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  pi.registerProvider("team-fixture", { baseUrl: "http://127.0.0.1:9/unused", apiKey: "LOCAL_FIXTURE", api: "team-fixture", models: ["gpt-6-astra","gpt-6.1-sol","deepseek-flash"].map(id=>({id,name:id,reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}})),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message = { role:"assistant",content:[{type:"text",text:"独立会话正在处理界面测试任务。"}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now() };
      let done=false;
      const finish = () => { if(done)return;done=true;clearTimeout(timer);stream.push({type:"done",reason:"stop",message}); };
      const timer=setTimeout(finish,10000);
      options?.signal?.addEventListener("abort",finish,{once:true});
      stream.push({type:"start",partial:{...message,content:[]}});stream.push({type:"text_delta",contentIndex:0,delta:message.content[0].text,partial:message});return stream;
    }
  });
}`,
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
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 980),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await expect(panel).toBeVisible();
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(kb);
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("legacy");
    await editor.getByLabel("研究运行范围", { exact: true }).selectOption("proposal");
    await expect(editor.getByLabel("课程知识库目录", { exact: true })).toHaveValue(kb);
    await editor.getByLabel("阶段 1 名称", { exact: true }).fill("我的问题打磨");
    await editor
      .getByLabel("阶段 1 目标", { exact: true })
      .fill("保留独立判断，先澄清论证质量，再核对证据。");
    await expect(
      editor.getByLabel("阶段 1 导师模型", { exact: true }).locator("option"),
    ).toHaveCount(4);
    await editor.getByRole("button", { name: "应用推荐配模", exact: true }).click();
    await expect(editor.getByLabel("阶段 1 名称", { exact: true })).toHaveValue("我的问题打磨");
    await expect(editor.getByLabel("阶段 1 研究者 B · 复核模型", { exact: true })).toHaveValue(
      JSON.stringify({ provider: "team-fixture", modelId: "gpt-6.1-sol" }),
    );
    await expect(editor.getByLabel("阶段 2 研究者 B · 复核模型", { exact: true })).toHaveValue(
      JSON.stringify({ provider: "team-fixture", modelId: "gpt-6-astra" }),
    );
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.config.knowledgeDir)
      .toBe(kb);
    await page
      .getByLabel("New thread prompt")
      .fill("演练：AI 反馈与高中物理实验报告论证质量。先打磨问题，再审阅初步方案。");
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).researchGroups?.projects[0]?.members.filter(
            (m) => m.status === "running",
          ).length,
      )
      .toBe(4);
    const state = await getDesktopState(page),
      project = state.researchGroups!.projects[0]!;
    expect(new Set(project.members.map((m) => m.ref.sessionId)).size).toBe(4);
    expect(state.orchestrationChildren).toHaveLength(0);
    expect(
      state.assistants?.workflows?.[`${project.root.workspaceId}:${project.root.sessionId}`],
    ).toBeUndefined();
    await expect(page.getByTestId("module-workflow")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("research-four-sessions.png") });
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
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
      .toBe("paused");
    const restored = (await getDesktopState(page)).researchGroups!.projects[0]!;
    expect(restored.members.map((m) => m.ref)).toEqual(project.members.map((m) => m.ref));
    expect(restored.stages?.[0]?.title).toBe("我的问题打磨");
    expect(restored.stages?.[1]?.models.reviewer?.modelId).toBe("gpt-6-astra");
    await page
      .getByRole("button", { name: "教育研究课题组", exact: true })
      .click({ button: "right" });
    const manager = page.getByRole("dialog", { name: "管理模块", exact: true });
    await manager.getByRole("button", { name: "配置阶段、角色与模型", exact: true }).click();
    const reopened = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await expect(reopened.getByLabel("阶段 1 目标", { exact: true })).toHaveValue(
      "保留独立判断，先澄清论证质量，再核对证据。",
    );
    await reopened.getByRole("button", { name: "取消", exact: true }).click();
    await manager.getByRole("button", { name: "取消", exact: true }).click();
    expect(restored.events.filter((e) => e.type === "started")).toHaveLength(4);
    await expect(page.getByRole("button", { name: "恢复未完成工作", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("research-restored.png") });
    await page.getByRole("button", { name: "CYZ 论文工作台", exact: true }).click();
    await openNewThread(page);
    await expect(page.getByRole("region", { name: "教育研究课题组", exact: true })).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
