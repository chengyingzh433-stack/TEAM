import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createNamedThread,
  captureDesktopScreenshot,
  desktopShortcut,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openScheduledTasks,
  openSettingsSection,
  seedAgentDir,
  type DesktopHarness,
} from "../helpers/electron-app";

const sizes = [
  { width: 1920, height: 1080, zoom: 1 },
  { width: 1440, height: 900, zoom: 1.25 },
  { width: 1280, height: 720, zoom: 1 },
  { width: 1024, height: 768, zoom: 1.5 },
  { width: 560, height: 600, zoom: 1 },
  { width: 560, height: 600, zoom: 1.5 },
];
async function resize(app: DesktopHarness, page: Page, size: (typeof sizes)[number]) {
  await app.electronApp.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("/index.html"),
    )!;
    window.setContentSize(size.width, size.height);
    window.webContents.setZoomFactor(size.zoom);
  }, size);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function capture(app: DesktopHarness, page: Page, surface: Locator, name: string) {
  await expect(surface).toBeVisible();
  const geometry = await surface.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const controls = Array.from(
      el.querySelectorAll("input:not([type=hidden]), select, textarea, button"),
    ).filter((el) => el.getClientRects().length);
    return {
      viewport: [innerWidth, innerHeight],
      box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom },
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
      overflowingControls: controls
        .filter((el) => {
          // xterm intentionally keeps its invisible keyboard input offscreen.
          if (el.matches(".xterm-helper-textarea")) return false;
          if (
            el.closest(
              ".secondary-surface__nav, .model-catalog__families, .module-workflow__steps, .workbench__tabs",
            )
          )
            return false;
          const r = el.getBoundingClientRect();
          return r.left < box.left - 1 || r.right > box.right + 1;
        })
        .map((el) => ({
          text: el.getAttribute("aria-label") ?? el.textContent,
          x: el.getBoundingClientRect().x,
          right: el.getBoundingClientRect().right,
        })),
    };
  });
  await writeFile(test.info().outputPath(`${name}.json`), JSON.stringify(geometry, null, 2));
  await captureDesktopScreenshot(app, test.info().outputPath(`${name}.png`));
  expect.soft(geometry.box.x, name).toBeGreaterThanOrEqual(-1);
  expect.soft(geometry.box.y, name).toBeGreaterThanOrEqual(-1);
  expect.soft(geometry.box.right, name).toBeLessThanOrEqual(geometry.viewport[0]! + 1);
  expect.soft(geometry.box.bottom, name).toBeLessThanOrEqual(geometry.viewport[1]! + 1);
  expect
    .soft(geometry.scrollWidth, `${name}: no horizontal clipping`)
    .toBeLessThanOrEqual(geometry.width + 1);
  expect.soft(geometry.overflowingControls, `${name}: controls stay within surface`).toEqual([]);
}

test("conversation, navigation, dialogs, settings and workbench fit the window and zoom", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir(),
    agentDir = join(profile, "agent"),
    workspace = await makeWorkspace("responsive-surfaces");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  await writeFile(join(profile, "ui-state.json"), JSON.stringify({ language: "en" }));
  const app = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const page = await app.firstWindow();
    // The empty thread is a layout fixture, with no provider requests.
    await createNamedThread(page, "Responsive surfaces");
    const collapsed = (await getDesktopState(page)).sidebarCollapsed;
    for (const size of sizes) {
      await resize(app, page, size);
      const prefix = `${size.width}-${size.height}-${size.zoom}`;
      await capture(app, page, page.locator(".body.ml"), `${prefix}-conversation`);
      const topbar = await page.getByTestId("topbar").evaluate((el) => {
        const reel = el.querySelector(".reel")!.getBoundingClientRect();
        const actions = el.querySelector(".topbar__actions")!.getBoundingClientRect();
        return { right: reel.right, left: actions.left };
      });
      expect.soft(topbar.right).toBeLessThanOrEqual(topbar.left + 1);
      await page.locator(".model-catalog__families button").first().click();
      await capture(
        app,
        page,
        page.locator(".model-catalog__popover:popover-open"),
        `${prefix}-model-picker`,
      );
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("composer")).toBeInViewport();
      await page.getByTestId("composer").fill("unsent layout draft");
      const sidebar = page.locator(".shell-sidebar");
      if (!(await sidebar.isVisible())) await page.getByTestId("sidebar-toggle").click();
      await capture(app, page, sidebar, `${prefix}-sidebar`);
      await page.getByRole("button", { name: "管理模块", exact: true }).click();
      const manager = page.getByRole("dialog", { name: "管理模块", exact: true });
      await manager
        .getByLabel("选择模块", { exact: true })
        .selectOption({ label: "CYZ 论文工作台" });
      await capture(app, page, manager, `${prefix}-module-manager`);
      await manager.getByRole("button", { name: "配置阶段、模型与 Skill" }).click();
      const workflow = page.getByRole("dialog", { name: "配置模块流程" });
      await capture(app, page, workflow, `${prefix}-workflow`);
      await workflow
        .getByRole("button", { name: "保存流程", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        workflow.getByRole("button", { name: "保存流程", exact: true }),
      ).toBeInViewport();
      await capture(app, page, workflow, `${prefix}-workflow-footer`);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "添加 AI 助手", exact: true }).click();
      await capture(
        app,
        page,
        page.getByRole("dialog", { name: "添加 AI 助手" }),
        `${prefix}-assistant`,
      );
      await page.keyboard.press("Escape");
      if (await page.getByRole("button", { name: "关闭导航", exact: true }).isVisible())
        await page.getByRole("button", { name: "关闭导航", exact: true }).click();
      if (await page.getByRole("button", { name: "会话图", exact: true }).isVisible()) {
        await page.getByRole("button", { name: "会话图", exact: true }).click();
        await capture(
          app,
          page,
          page.getByTestId("session-trajectory-panel"),
          `${prefix}-trajectory`,
        );
        await page.keyboard.press("Escape");
      }
      await page.getByTestId("launch-parallel-tasks").click();
      await capture(app, page, page.locator("dialog[open]"), `${prefix}-parallel-tasks`);
      await page.keyboard.press("Escape");
      await page.keyboard.press(desktopShortcut("K"));
      await capture(app, page, page.getByTestId("command-palette"), `${prefix}-palette`);
      await page.keyboard.press("Escape");
      await page.locator('.topbar__actions [data-testid="toggle-side-panel"]').click();
      await capture(app, page, page.getByTestId("workbench"), `${prefix}-workbench`);
      for (const tool of ["Files", "Terminal", "Review"]) {
        await page.getByTestId("workbench-add-tab").click();
        await page
          .getByTestId("workbench-chooser")
          .getByRole("button", { name: tool, exact: true })
          .click();
        await expect(page.getByRole("tab", { name: tool, exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await capture(app, page, page.getByTestId("workbench"), `${prefix}-tool-${tool}`);
      }
      await page.locator('.topbar__actions [data-testid="toggle-side-panel"]').click();
      await expect(page.getByTestId("composer")).toHaveValue("unsent layout draft");
      for (const section of [
        "General",
        "Appearance",
        "Notifications",
        "Models",
        "Providers",
        "Keyboard shortcuts",
        "Skills",
        "Extensions",
      ]) {
        await openSettingsSection(page, section);
        if (section !== "Skills" && section !== "Extensions")
          await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
        await capture(
          app,
          page,
          page.locator(".secondary-surface__content"),
          `${prefix}-settings-${section}`,
        );
      }
      await page.getByRole("button", { name: "Back to app", exact: true }).click();
      await page.getByTestId("composer").fill("");
    }
    expect((await getDesktopState(page)).sidebarCollapsed).toBe(collapsed);
    await openScheduledTasks(page);
    await capture(app, page, page.getByTestId("scheduled-tasks-view"), "compact-scheduled-tasks");
    await page.getByTestId("scheduled-task-create").click();
    await page.getByTestId("scheduled-task-setup-manually").click();
    await capture(app, page, page.getByTestId("scheduled-task-editor"), "compact-scheduled-editor");
  } finally {
    await app.close();
  }
});
