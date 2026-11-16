import { mkdir, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
} from "../helpers/electron-app";

test("message documents open locally, reveal in Finder and report missing files", async () => {
  const profile = await makeUserDataDir();
  const agentDir = join(profile, "agent");
  const workspace = await makeWorkspace("document-links");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  await mkdir(join(workspace, "精读资料"));
  const relative = "精读资料/完整 文档.html";
  await writeFile(join(workspace, relative), "<h1>Local document</h1>");
  const outside = join(profile, "outside.txt");
  await writeFile(outside, "outside the workspace");
  await symlink(outside, join(workspace, "outside.txt"));
  await seedNamedTextSessionFixture(agentDir, workspace, {
    title: "Document links",
    userText: "Show the output files",
    assistantText: `[带目录网页版](<${relative}>)\n\n[绝对路径](<${join(workspace, relative)}>)\n\n[文件网址](${pathToFileURL(join(workspace, relative)).href})\n\n[缺失文档](精读资料/missing.docx)\n\n[越界链接](outside.txt)`,
  });
  const app = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const page = await app.firstWindow();
    await selectSession(page, "Document links");
    // Capture the native boundary here; a separate foreground check proves Finder itself.
    await app.electronApp.evaluate(({ shell }) => {
      const calls: string[] = [];
      Object.assign(globalThis, { documentShellCalls: calls });
      shell.openPath = async (path) => {
        calls.push(`open:${path}`);
        return "";
      };
      shell.showItemInFolder = (path) => {
        calls.push(`reveal:${path}`);
      };
    });
    await page
      .getByTestId("workspace-document-link")
      .filter({ hasText: "带目录网页版" })
      .getByRole("button", { name: "带目录网页版", exact: true })
      .click();
    await page
      .getByTestId("workspace-document-link")
      .filter({ hasText: "带目录网页版" })
      .getByRole("button", { name: /访达|Finder/ })
      .click();
    await expect
      .poll(() =>
        app.electronApp.evaluate(
          () =>
            (globalThis as typeof globalThis & { documentShellCalls: string[] }).documentShellCalls,
        ),
      )
      .toEqual([`open:${join(workspace, relative)}`, `reveal:${join(workspace, relative)}`]);
    for (const name of ["绝对路径", "文件网址"])
      await page.getByRole("button", { name, exact: true }).click();
    await expect
      .poll(() =>
        app.electronApp.evaluate(
          () =>
            (globalThis as typeof globalThis & { documentShellCalls: string[] }).documentShellCalls,
        ),
      )
      .toHaveLength(4);
    await page.getByRole("button", { name: "缺失文档", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(/文件|file/i);
    await page.getByRole("button", { name: "越界链接", exact: true }).click();
    await expect(
      page
        .getByTestId("workspace-document-link")
        .filter({ hasText: "越界链接" })
        .getByRole("alert"),
    ).toContainText("Path escapes workspace");
    await app.electronApp.evaluate(({ shell }) => {
      shell.openPath = async () => "No application available";
    });
    await page.getByRole("button", { name: "带目录网页版", exact: true }).click();
    await expect(
      page
        .getByTestId("workspace-document-link")
        .filter({ hasText: "带目录网页版" })
        .getByRole("alert"),
    ).toContainText("No application available");
    await expect(page.getByTestId("transcript")).toContainText("带目录网页版");
  } finally {
    await app.close();
  }
});
