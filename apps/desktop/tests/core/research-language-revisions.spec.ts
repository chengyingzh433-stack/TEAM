import { test, expect } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import { captureResearchNativeBoundary } from "../helpers/research-live-evidence";
import {
  LANGUAGE_BASE,
  LANGUAGE_TARGET,
  setupResearchLanguageFixture,
} from "../helpers/research-language-provider";

for (const mode of ["first-draft", "language", "language-inherit"] as const) {
  test(
    mode === "first-draft"
      ? "qualified first draft completes actual independent Electron reviews without a manufactured critique or revision"
      : mode === "language-inherit"
        ? "inherited model records each native continuation before language reads and survives restart"
        : "user selects actual language paragraphs and native A/B dual reads guard acceptance and survive restart",
    async () => {
      test.setTimeout(150_000);
      const fixture = await setupResearchLanguageFixture(mode);
      let harness = await fixture.launch(),
        page = await harness.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const current = async (): Promise<ResearchProject> =>
        (await getDesktopState(page)).researchGroups!.projects[0]!;
      try {
        await harness.electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
        );
        await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
        await openNewThread(page);
        const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
        await editor.getByLabel("课程知识库目录", { exact: true }).fill(fixture.kb);
        await editor.getByLabel("研究材料目录", { exact: true }).fill("");
        await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
        await editor
          .getByLabel("研究入口", { exact: true })
          .selectOption(mode !== "first-draft" ? "task" : "idea");
        await editor
          .getByLabel("本轮研究目标", { exact: true })
          .selectOption(mode !== "first-draft" ? "task" : "question");
        if (mode !== "first-draft") {
          await editor.getByLabel("单项任务类型", { exact: true }).selectOption("chapter-edit");
          await editor
            .getByLabel("单项任务范围", { exact: true })
            .fill("仅讨论正文；保留数值、限制和AI说明。以实际选段授权为界。");
        }
        await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
        await editor.getByLabel("成员 Token 上限", { exact: true }).fill("500000");
        for (let index = 0; mode !== "language-inherit" && index < FUSION_STAGE_IDS.length; index++)
          for (const role of RESEARCH_ROLES) {
            await editor
              .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}模型`, { exact: true })
              .selectOption(
                JSON.stringify({ provider: "research-recovery-fixture", modelId: "gpt-6.1-sol" }),
              );
            await editor
              .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}思考强度`, {
                exact: true,
              })
              .selectOption("low");
          }
        await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
        await expect(editor).toBeHidden();
        await page
          .getByLabel("New thread prompt")
          .fill(
            "合成软件流程验收：只处理本轮范围，独立判断后可有理由支持合格首稿；语言修改须实际选段、双稿及本人读取，不代表真实语义C。",
          );
        await page.getByRole("button", { name: "Start thread", exact: true }).click();
        const group = page.getByRole("region", { name: "教育研究课题组", exact: true });
        if (mode !== "first-draft") {
          await expect.poll(async () => (await current())?.status).toBe("paused");
          await harness.electronApp.evaluate(({ dialog }, file) => {
            const original = dialog.showOpenDialog;
            dialog.showOpenDialog = async () => {
              dialog.showOpenDialog = original;
              return { canceled: false, filePaths: [file] };
            };
          }, fixture.manuscript);
          await group.getByRole("button", { name: "导入研究材料", exact: true }).click();
          await expect.poll(async () => (await current()).importedMaterials?.length).toBe(1);
          const imported = (await current()).importedMaterials![0]!;
          const item = group.locator(`[data-material-id="${imported.id}"]`),
            name = basename(fixture.manuscript);
          await item.locator(":scope > summary").click();
          await item.getByLabel(`${name} 材料用途`, { exact: true }).selectOption("manuscript");
          await item
            .getByLabel(`${name} 来源及提供说明`, { exact: true })
            .fill("操作者实际提供的合成讨论章，用于软件范围/双稿验收，不是原始实证来源。");
          await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
          await expect.poll(async () => (await current()).evidence?.sources.length).toBe(1);
          await group.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
          await expect
            .poll(
              async () =>
                (await current()).artifacts.filter((a) => a.kind === "stage-draft").length,
            )
            .toBe(1);
          const panel = group.getByTestId("research-language-panel");
          await panel.locator(":scope > summary").click();
          await panel.getByText("选定正文范围", { exact: true }).click();
          await panel.getByRole("checkbox").nth(1).check();
          await panel.getByLabel("语言保护词", { exact: true }).fill("学习支持");
          await page.screenshot({
            path: test.info().outputPath("selected-language-paragraph.png"),
            fullPage: true,
          });
          await panel.getByRole("button", { name: "保存语言修改范围", exact: true }).click();
          await expect.poll(async () => (await current()).languageScopes?.length).toBe(1);
        }
        await expect
          .poll(
            async () => {
              const state = await getDesktopState(page),
                p = state.researchGroups?.projects[0];
              if (
                state.researchGroups?.error ||
                p?.members.some((member) => member.status === "failed")
              )
                throw new Error(
                  state.researchGroups?.error ?? p?.error ?? JSON.stringify(p?.members),
                );
              return (
                p?.status === "completed" &&
                captureResearchNativeBoundary(state, p).activeNativeAtCapture.length === 0
              );
            },
            { timeout: 90_000 },
          )
          .toBe(true);
        const completed = await current(),
          ledger = await fixture.readLanguageJournal();
        expect(errors).toEqual([]);
        expect(completed.artifacts.some((a) => a.kind === "stage-critique")).toBe(false);
        expect(completed.fusion!.attempts.every((a) => a.state === "succeeded")).toBe(true);
        const failed = ledger.filter((row) => row.type === "result" && row.isError);
        expect(
          failed.some(
            (row) => row.callId.endsWith("_probe-independent") && row.text?.includes("独立判断"),
          ),
        ).toBe(true);
        expect(
          failed.every(
            (row) =>
              row.callId.endsWith("_probe-independent") ||
              row.callId.endsWith("_probe-language-gate"),
          ),
        ).toBe(true);
        if (mode === "first-draft") {
          expect(completed.artifacts.some((a) => a.kind === "stage-revision")).toBe(false);
          const draft = completed.artifacts.find((a) => a.kind === "stage-draft")!;
          expect(completed.artifacts.find((a) => a.kind === "stage-verification")!.refs).toEqual([
            draft.id,
          ]);
          await page.screenshot({
            path: test.info().outputPath("qualified-first-draft-accepted.png"),
            fullPage: true,
          });
        } else {
          expect(completed.languageRevisions).toHaveLength(1);
          const revision = completed.languageRevisions![0]!;
          expect(revision.baseline.body).toBe(LANGUAGE_BASE);
          expect(revision.target.body).toBe(LANGUAGE_TARGET);
          expect(revision.programReport.hardIssues).toEqual([]);
          expect(
            revision.semanticReviews
              .map((review) => (review.actor.kind === "model" ? review.actor.role : "invalid"))
              .sort(),
          ).toEqual(["lead", "reviewer"]);
          for (const review of revision.semanticReviews) expect(review.actualReads).toHaveLength(2);
          expect(completed.languageReads).toHaveLength(4);
          if (mode === "language-inherit") {
            const attempts = completed.fusion!.attempts.filter(
              (attempt) =>
                completed.fusion!.tasks.find((task) => task.id === attempt.taskId)?.role === "lead",
            );
            expect(attempts.length).toBeGreaterThan(1);
            expect(
              attempts.every((attempt) => attempt.model?.provider === "research-recovery-fixture"),
            ).toBe(true);
          }
          expect(
            failed.some(
              (row) =>
                row.callId.endsWith("_probe-language-gate") && row.text?.includes("needs-review"),
            ),
          ).toBe(true);
          expect(await readFile(fixture.manuscript, "utf8")).toBe(LANGUAGE_BASE);
          await page.screenshot({
            path: test.info().outputPath("language-double-review-completed.png"),
            fullPage: true,
          });
          await harness.close();
          harness = await fixture.launch();
          page = await harness.firstWindow();
          await expect.poll(async () => (await current()).languageRevisions?.length).toBe(1);
          const restarted = await current();
          expect(restarted.languageScopes).toEqual(completed.languageScopes);
          expect(restarted.languageRevisions).toEqual(completed.languageRevisions);
          expect(restarted.languageReads).toEqual(completed.languageReads);
          expect(restarted.artifacts).toEqual(completed.artifacts);
          expect((await fixture.readLanguageJournal()).length).toBe(ledger.length);
          await page.screenshot({
            path: test.info().outputPath("restarted-language-history.png"),
            fullPage: true,
          });
        }
        await writeFile(
          test.info().outputPath("proof.json"),
          JSON.stringify(
            {
              mode,
              completed,
              ledger,
              errors,
              boundary:
                "Fixture-backed Electron and actual Pi tools; synthetic prose and predetermined opinions are not real-provider semantic proof.",
            },
            null,
            2,
          ),
        );
      } finally {
        const state = await getDesktopState(page).catch(() => undefined);
        if (state?.researchGroups?.projects[0])
          await writeFile(
            test.info().outputPath("state-at-teardown.json"),
            JSON.stringify(state.researchGroups.projects[0], null, 2),
          );
        await writeFile(
          test.info().outputPath("native-ledger-at-teardown.json"),
          JSON.stringify(await fixture.readLanguageJournal(), null, 2),
        );
        await harness.close();
      }
    },
  );
}
