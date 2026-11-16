import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LANCER_ASSISTANTS } from "../../contracts/lancer-assistants";
import { DEFAULT_LANCER_MODULES } from "../../contracts/lancer-modules";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
} from "../helpers/electron-app";

test("retired modules disappear on upgrade and their conversations remain readable after restart", async () => {
  const profile = await makeUserDataDir();
  const workspace = await makeWorkspace("retired-module-history");
  const agentDir = join(profile, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const retired = [
    { id: "video", label: "视频复刻" },
    { id: "research", label: "竞品调研" },
    { id: "xhs", label: "小红书" },
  ];
  for (const module of retired) {
    await seedNamedTextSessionFixture(agentDir, workspace, {
      title: `lancer-zone:${module.id}|保留的 ${module.id} 会话`,
      userText: `原始提问 ${module.id}`,
      assistantText: `保留的原始回复 ${module.id}`,
    });
  }
  const original =
    JSON.stringify(
      {
        ...DEFAULT_LANCER_ASSISTANTS,
        modules: [
          ...DEFAULT_LANCER_MODULES,
          ...retired.map((module) => ({ ...module, color: "#334455", description: "" })),
        ],
      },
      null,
      2,
    ) + "\n";
  await writeFile(join(profile, "assistants.json"), original);
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
    for (let run = 0; run < 2; run++) {
      const page = await harness.firstWindow();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const modules = page.getByRole("navigation", { name: "模块" });
      await expect(modules.getByRole("button", { name: "论文查询", exact: true })).toBeVisible();
      await expect(modules.getByRole("button", { name: "GitHub 研究", exact: true })).toBeVisible();
      await expect(modules.getByRole("button", { name: "Lancer 自举", exact: true })).toBeVisible();
      for (const module of retired) {
        await expect(modules.getByRole("button", { name: module.label, exact: true })).toHaveCount(
          0,
        );
        await selectSession(page, `保留的 ${module.id} 会话`);
        await expect(page.locator(".process-assistant").last()).toContainText(
          `保留的原始回复 ${module.id}`,
        );
        await expect(page.getByTestId("module-workflow")).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath(`history-${module.id}-${run}.png`) });
      }
      expect(
        await page.evaluate(() => {
          const api = window.piApp!;
          return [
            "videoLearnRun",
            "videoLearnStatus",
            "animationCreate",
            "animationRead",
            "animationExport",
            "doubaoAppOpenVideo",
          ].filter((name) => name in api);
        }),
      ).toEqual([]);
      await expect(page.getByTestId("video-learn-bar")).toHaveCount(0);
      expect(await readFile(join(profile, "assistants.json"), "utf8")).toBe(original);
      if (run === 0) {
        await harness.close();
        harness = await launch();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await harness.close();
  }
});
