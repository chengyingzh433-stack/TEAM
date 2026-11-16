import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  captureDesktopScreenshot,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

test("slash menu rows contain their text without overlap at desktop and compact sizes", async () => {
  const profile = await makeUserDataDir();
  const agentDir = join(profile, "agent");
  const workspace = await makeWorkspace("responsive-layout");
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
    // An empty persisted session is a layout fixture; no model request is made.
    await createNamedThread(page, "Responsive layout");
    for (const size of [
      { width: 1440, height: 900, zoom: 1 },
      { width: 560, height: 600, zoom: 1 },
      { width: 1280, height: 800, zoom: 1.5 },
    ]) {
      await app.electronApp.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("/index.html"),
        )!;
        window.setContentSize(size.width, size.height);
        window.webContents.setZoomFactor(size.zoom);
      }, size);
      await page.getByTestId("composer").fill("/");
      const menu = page.getByTestId("slash-menu");
      await expect(menu).toBeVisible();
      await captureDesktopScreenshot(
        app,
        test.info().outputPath(`slash-${size.width}-${size.height}-${size.zoom}.png`),
      );
      const rows = await menu.locator(".slash-menu__item").evaluateAll((items) =>
        items.map((item) => {
          const box = item.getBoundingClientRect();
          const text = Array.from(
            item.querySelectorAll(
              ".slash-menu__title, .slash-menu__description, .slash-menu__command",
            ),
          )
            .filter((el) => el.getClientRects().length)
            .map((el) => ({
              text: el.textContent,
              top: el.getBoundingClientRect().top,
              bottom: el.getBoundingClientRect().bottom,
            }));
          return { title: item.textContent, top: box.top, bottom: box.bottom, text };
        }),
      );
      await writeFile(
        test.info().outputPath(`slash-${size.width}-${size.height}-${size.zoom}.json`),
        JSON.stringify(rows, null, 2),
      );
      for (const row of rows) {
        for (const text of row.text) {
          expect
            .soft(text.top, `${size.width}: ${text.text} starts inside its row`)
            .toBeGreaterThanOrEqual(row.top - 1);
          expect
            .soft(text.bottom, `${size.width}: ${text.text} ends inside its row`)
            .toBeLessThanOrEqual(row.bottom + 1);
        }
      }
      await page.getByTestId("composer").fill("");
    }
  } finally {
    await app.close();
  }
});
