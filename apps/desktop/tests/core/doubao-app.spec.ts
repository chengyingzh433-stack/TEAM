import { expect, test } from "@playwright/test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";

test("Doubao App binds without a Pi model and keeps a fixed conversation across mode changes", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("doubao-ui");
  const agentDir = join(userDataDir, "agent");
  const helperPath = join(userDataDir, "doubao-fixture.mjs");
  const statePath = join(userDataDir, "doubao-fixture.json");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    statePath,
    JSON.stringify({
      messages: [
        {
          role: "assistant",
          text: "已关联测试会话，可以继续讨论项目。",
        },
      ],
      conversationId: "12345",
    }),
  );
  // Only native UI transport is replaced; renderer, IPC and binding persistence are real.
  await writeFile(
    helperPath,
    `#!${process.execPath}
import fs from 'node:fs';
const path = ${JSON.stringify(statePath)};
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
if (input.action === 'select') state.conversationId = input.conversationId;
if (input.action === 'send') state.messages.push({role:'user',text:input.text},{role:'assistant',text:'豆包实际回复 fixture'});
fs.writeFileSync(path, JSON.stringify(state));
console.log(JSON.stringify({ok:true,permission:true,title:'固定测试会话',busy:false,...state,sent:input.action === 'send'}));
`,
  );
  await chmod(helperPath, 0o755);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { PI_APP_DOUBAO_HELPER_PATH: helperPath },
  });
  try {
    const window = await harness.firstWindow();
    await openNewThread(window);
    await window.locator(".new-thread__hint .model-selector__badge").first().click();
    await window.getByTestId("choose-doubao-app").click();
    // One conversation owns one tree; workflow stages do not create extra chats.
    await expect(window.locator(".strip4 .lr")).toHaveCount(1);
    await expect(
      window.getByTestId("lancer-zone-sidebar").getByTestId("process-session-row"),
    ).toHaveCount(1);
    const transcript = window.getByTestId("doubao-app-transcript");
    await expect(transcript.getByText("固定测试会话", { exact: true })).toBeHidden();
    await expect(transcript).toContainText("已关联测试会话，可以继续讨论项目。");
    await expect(window.getByLabel("下载视频到当前项目并自动学片")).toHaveCount(0);
    const composer = window.getByTestId("doubao-app-composer");
    await composer.fill("中文输入");
    await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    const nativeState = JSON.parse(await readFile(statePath, "utf8")) as { messages: unknown[] };
    expect(nativeState.messages).toHaveLength(1);
    await window.getByTestId("doubao-app-send").click();
    await expect(transcript).toContainText("豆包实际回复 fixture");
    await window.getByRole("button", { name: "豆包 App · 切回模型" }).click();
    await expect(composer).toHaveCount(0);
    await window.locator(".composer .model-selector__badge").first().click();
    await window.getByTestId("choose-doubao-app").click();
    await expect(transcript.getByText("固定测试会话", { exact: true })).toBeHidden();
    await expect(transcript).toContainText("豆包实际回复 fixture");
    await transcript.getByText("会话连接", { exact: true }).click();
    await window.getByRole("button", { name: "刷新回复", exact: true }).click();
    await transcript.getByText("会话连接", { exact: true }).click();
    await expect(transcript).not.toContainText("豆包正在执行");
    await window.reload();
    await expect(transcript.getByText("固定测试会话", { exact: true })).toBeHidden();
    await expect(transcript).toContainText("豆包实际回复 fixture");
    await window.screenshot({ path: test.info().outputPath("doubao-bound.png") });
  } finally {
    await harness.close();
  }
});
