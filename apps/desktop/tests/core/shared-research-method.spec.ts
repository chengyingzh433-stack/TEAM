import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CYZ_PAPER_MODULE_ID } from "../../contracts/cyz-paper-workflow";
import { DEFAULT_LANCER_MODULES } from "../../contracts/lancer-modules";
import { RESEARCH_ROLES, RESEARCH_ROLE_LABELS } from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import {
  SHARED_RESEARCH_METHOD,
  snapshotSharedResearchMethod,
} from "../../contracts/shared-research-method";
import { LancerAssistantStore } from "../../electron/application/lancer-assistant-store";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
  writeProjectExtension,
} from "../helpers/electron-app";

// E: both tasks are created through the UI with a deterministic native provider.
// The isolated CYZ template update below is resource setup, NOT a method-editing UI flow.
// Fusion uses a compiled method constant; this does not claim a same-build fusion update API.
test("CYZ and fusion pin the same method; resource updates affect only new CYZ tasks across restart", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("shared-method-core-"),
    workspace = await makeWorkspace("shared-method-core"),
    agentDir = join(profile, "agent"),
    kb = join(profile, "knowledge");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"), { recursive: true });
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "METHOD-FIXTURE",
      title: "研究设计 证据边界",
      text: "软件验收方法资料，不是真实研究证据。",
      required_context_ids: [],
    }),
  );
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "method-fixture" }));
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "shared-method-fixture",
      defaultModel: "gpt-6.1-sol",
      enabledModels: ["shared-method-fixture/gpt-6.1-sol"],
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(
    workspace,
    "shared-method-fixture.ts",
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
export default function(pi) {
  pi.registerProvider("shared-method-fixture", {baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"shared-method-fixture",models:[{id:"gpt-6.1-sol",name:"Shared method fixture",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple(model,context) {
      const supplied=JSON.stringify(context);
      const version=supplied.match(/共享教育研究方法 (\\d+\\.\\d+\\.\\d+)/)?.[1]??"missing";
      const role=supplied.match(/你是教育研究课题组的([^，]+)，持续独立 Pi 会话/)?.[1]??null;
      appendFileSync(${JSON.stringify(join(profile, "method-receipts.jsonl"))}, JSON.stringify({role,version,originalRule:supplied.includes(${JSON.stringify(SHARED_RESEARCH_METHOD.rules[0]!.text)}),updatedRule:supplied.includes("隔离模板的新方法标记 METHOD-NEW-ONLY")})+"\\n");
      const text="SHARED_METHOD_RECEIPT version="+version+" updated_rule="+supplied.includes("隔离模板的新方法标记 METHOD-NEW-ONLY")+"。仅为方法快照接收验收，不生成研究成果。";
      const message={role:"assistant",content:[{type:"text",text}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
      const stream=createAssistantMessageEventStream();stream.push({type:"start",partial:{...message,content:[]}});stream.push({type:"text_delta",contentIndex:0,delta:text,partial:message});stream.push({type:"done",reason:"stop",message});return stream;
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
      testMode: "background",
    });
  let harness = await launch();
  try {
    let page = await harness.firstWindow();
    const resize = () =>
      harness.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
      );
    await resize();
    const waitIdle = async () => {
      await expect
        .poll(async () =>
          (await getDesktopState(page)).workspaces
            .flatMap((item) => item.sessions)
            .some((session) => session.status === "running"),
        )
        .toBe(false);
    };
    const createCyz = async (prompt: string, version: string, updated: boolean) => {
      await page.getByRole("button", { name: "CYZ 论文工作台", exact: true }).click();
      await openNewThread(page);
      await page.getByLabel("New thread prompt").fill(prompt);
      await page.getByRole("button", { name: "Start thread", exact: true }).click();
      await expect(page.locator(".process-assistant").last()).toContainText(
        `SHARED_METHOD_RECEIPT version=${version} updated_rule=${updated}`,
      );
      await waitIdle();
      await expect(
        page.getByTestId("module-workflow").getByTitle("本会话创建时固定的共享方法规则"),
      ).toHaveText(`方法 ${version}`);
      const state = await getDesktopState(page);
      const owner = state.workspaces.find((item) =>
        item.sessions.some((session) => session.id === state.selectedSessionId),
      )!;
      return { workspaceId: owner.id, sessionId: state.selectedSessionId };
    };
    const original = snapshotSharedResearchMethod();
    const oldCyz = await createCyz(
      "METHOD-OLD：仅确认本轮方法快照，不开展研究。",
      original.version,
      false,
    );
    const oldKey = `${oldCyz.workspaceId}:${oldCyz.sessionId}`;
    const oldWorkflow = structuredClone(
      (await getDesktopState(page)).assistants!.workflows![oldKey]!,
    );
    expect(oldWorkflow.method).toEqual(original);
    await page.screenshot({ path: test.info().outputPath("cyz-original-method.png") });

    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    // Entering an unconfigured research zone opens its setup dialog before New thread.
    await expect(editor).toBeVisible();
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(kb);
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("研究入口", { exact: true }).selectOption("idea");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("design");
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    for (let index = 0; index < FUSION_STAGE_IDS.length; index++)
      for (const role of RESEARCH_ROLES)
        await editor
          .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}模型`, { exact: true })
          .selectOption(
            JSON.stringify({ provider: "shared-method-fixture", modelId: "gpt-6.1-sol" }),
          );
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await openNewThread(page);
    await page
      .getByLabel("New thread prompt")
      .fill("METHOD-FUSION：仅检查创建时固定的方法规则，不声称实际研究完成。");
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects.length)
      .toBe(1);
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).researchGroups!.projects[0]!.events.filter(
            (event) => event.type === "finished",
          ).length,
      )
      .toBe(4);
    await waitIdle();
    let panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await expect(panel.locator(".research-group-source").first()).toContainText(
      `方法 ${original.version}`,
    );
    // This provider acknowledges the method but publishes no reviewed research.
    // Natural quiescence therefore enters needs-decision, with no running work to pause.
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups!.projects[0]!.status)
      .toBe("needs-decision");
    await expect(panel).toContainText("成员运行已结束，但审阅链尚未闭合");
    const fusion = structuredClone((await getDesktopState(page)).researchGroups!.projects[0]!);
    expect(fusion.sharedMethod).toEqual(original);
    expect(fusion.members).toHaveLength(4);
    const receipts = (await readFile(join(profile, "method-receipts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            role: string | null;
            version: string;
            originalRule: boolean;
            updatedRule: boolean;
          },
      );
    for (const role of RESEARCH_ROLES)
      expect(receipts).toContainEqual({
        role: RESEARCH_ROLE_LABELS[role],
        version: original.version,
        originalRule: true,
        updatedRule: false,
      });
    await page.screenshot({ path: test.info().outputPath("fusion-original-method.png") });
    await harness.close();

    // No method-rule editor exists. Change only the isolated template resource with the app closed.
    // Existing workflows and research project JSON are never rewritten by this fixture.
    const store = new LancerAssistantStore(profile);
    await store.load();
    const module = (store.snapshot().modules ?? DEFAULT_LANCER_MODULES).find(
      (item) => item.id === CYZ_PAPER_MODULE_ID,
    )!;
    const updated = snapshotSharedResearchMethod({
      ...SHARED_RESEARCH_METHOD,
      version: "2.1.0",
      rules: [
        { id: "scope", text: "隔离模板的新方法标记 METHOD-NEW-ONLY；只应用到此后创建的新任务。" },
      ],
    });
    await store.change({
      kind: "save-module",
      module: { ...module, workflow: { ...module.workflow!, method: updated } },
    });
    expect(store.snapshot().workflows![oldKey]).toEqual(oldWorkflow);

    harness = await launch();
    page = await harness.firstWindow();
    await resize();
    let restored = await getDesktopState(page);
    expect(restored.assistants!.workflows![oldKey]).toEqual(oldWorkflow);
    expect(restored.researchGroups!.projects[0]!.sharedMethod).toEqual(fusion.sharedMethod);
    expect(restored.researchGroups!.projects[0]!.members.map((member) => member.ref)).toEqual(
      fusion.members.map((member) => member.ref),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await page
      .locator(`.research-project[data-project-id="${fusion.id}"] .research-project__name`)
      .click();
    panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await expect(panel.locator(".research-group-source").first()).toContainText(
      `方法 ${original.version}`,
    );
    await page.getByRole("button", { name: "CYZ 论文工作台", exact: true }).click();
    await page.locator(`[data-session-id="${oldCyz.sessionId}"]`).first().click();
    await expect(
      page.getByTestId("module-workflow").getByTitle("本会话创建时固定的共享方法规则"),
    ).toHaveText(`方法 ${original.version}`);
    const newCyz = await createCyz(
      "METHOD-NEW：仅确认新模板的方法快照，不开展研究。",
      updated.version,
      true,
    );
    const newKey = `${newCyz.workspaceId}:${newCyz.sessionId}`;
    restored = await getDesktopState(page);
    expect(newCyz.sessionId).not.toBe(oldCyz.sessionId);
    expect(restored.assistants!.workflows![newKey]!.method).toEqual(updated);
    expect(restored.assistants!.workflows![oldKey]).toEqual(oldWorkflow);
    expect(restored.researchGroups!.projects[0]!.sharedMethod).toEqual(original);
    await page.screenshot({ path: test.info().outputPath("new-cyz-updated-method.png") });
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    restored = await getDesktopState(page);
    expect(restored.assistants!.workflows![newKey]!.method).toEqual(updated);
    expect(restored.assistants!.workflows![oldKey]).toEqual(oldWorkflow);
    expect(restored.researchGroups!.projects[0]!.sharedMethod).toEqual(original);
    await writeFile(
      test.info().outputPath("shared-method-evidence.json"),
      JSON.stringify(
        {
          proof:
            "Core deterministic native provider + UI creation and restart. CYZ template resource update is explicit fixture setup, not a method-editing user flow. Fusion compiled-template updates are not exercised.",
          oldCyz,
          newCyz,
          receipts,
          original,
          updated,
          workflows: restored.assistants!.workflows,
          fusion: {
            id: fusion.id,
            sharedMethod: restored.researchGroups!.projects[0]!.sharedMethod,
            members: restored.researchGroups!.projects[0]!.members.map((member) => member.ref),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
});
