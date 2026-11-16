import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { reportResearchLiteratureSearch } from "../../electron/research-group/literature-search";
import { researchHash } from "../../electron/research-group/materials";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import { captureResearchNativeBoundary } from "../helpers/research-live-evidence";
import {
  LITERATURE_CORE_NOTICE,
  LITERATURE_CORE_RECORDS,
  setupResearchLiteratureProcessFixture,
} from "../helpers/research-literature-process-provider";

const records = (p: ResearchProject) => ({
  search: p.literatureSearch,
  operations: p.literatureToolOperations,
  reads: p.literatureRecordReads,
  imported: p.importedMaterials,
});

test("local native literature imports preserve originals, depth, independent judgments and strategy history across restart", async () => {
  test.setTimeout(180_000);
  const fixture = await setupResearchLiteratureProcessFixture();
  const originalGood = await readFile(fixture.goodFile),
    originalBad = await readFile(fixture.badFile);
  let harness = await fixture.launch(),
    page = await harness.firstWindow();
  const snapshots: Record<string, ResearchProject> = {},
    rendererErrors: string[] = [];
  const current = async () => (await getDesktopState(page)).researchGroups!.projects[0]!;
  try {
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(fixture.kb);
    await editor.getByLabel("研究材料目录", { exact: true }).fill(fixture.materials);
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("研究入口", { exact: true }).selectOption("discovery");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("direction");
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    await editor.getByLabel("成员 Token 上限", { exact: true }).fill("500000");
    for (let index = 0; index < FUSION_STAGE_IDS.length; index++)
      for (const role of RESEARCH_ROLES) {
        await editor
          .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}模型`, { exact: true })
          .selectOption(
            JSON.stringify({ provider: "research-recovery-fixture", modelId: "gpt-6.1-sol" }),
          );
        await editor
          .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}思考强度`, { exact: true })
          .selectOption("low");
      }
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await page
      .getByLabel("New thread prompt")
      .fill(
        `${LITERATURE_CORE_NOTICE} 仅S0候选方向，不替用户定题。资料员等待UI导入原件，先交可读批次；A/B独立读取后继续，不等第二批。计划未执行不能计检索；坏JSON保留失败，v2不覆盖v1。`,
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(
        async () =>
          !!(await getDesktopState(page)).researchGroups?.projects[0]?.fusion?.attempts.length,
      )
      .toBe(true);
    // Only OS chooser response is supplied; the visible import button and host parser are real.
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [fixture.goodFile, fixture.badFile],
    );
    const group = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await group.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(2);
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(page),
            p = state.researchGroups!.projects[0]!;
          const failed = p.fusion!.attempts.filter((attempt) =>
            ["failed", "unknown"].includes(attempt.state),
          );
          if (state.researchGroups?.error || p.status === "paused" || failed.length)
            throw new Error(
              JSON.stringify({ error: state.researchGroups?.error ?? p.error, failed }),
            );
          return (
            p.status === "completed" &&
            captureResearchNativeBoundary(state, p).activeNativeAtCapture.length === 0
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const completed = (snapshots.completed = await current()),
      ledger = completed.literatureSearch!;
    expect(researchExecutionRoute(completed).stageIds).toEqual(["scan"]);
    expect(researchExecutionRoute(completed).requiredRoles).toEqual([...RESEARCH_ROLES]);
    expect(ledger.strategies.map((strategy) => strategy.version)).toEqual([1, 2]);
    expect(
      ledger.batches.map((batch) => [batch.origin, batch.strategyVersion, batch.status]),
    ).toEqual([
      ["import", 1, "succeeded"],
      ["import", 2, "failed"],
      ["import", 2, "succeeded"],
    ]);
    const report = reportResearchLiteratureSearch(ledger);
    expect(report.successfulSearches).toBe(0);
    expect(report.returnedRecords).toBe(0);
    expect(report.importedRecords).toBe(8);
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map((entry) => entry.recordIds.length)).toEqual([4, 4]);
    expect(ledger.accesses).toEqual([]);
    for (const batch of ledger.batches) {
      expect(batch.query).toBeNull();
      expect(batch.endpoint).toBeNull();
      expect(batch.original.available).toBe(true);
      const bytes = batch.status === "failed" ? originalBad : originalGood;
      expect(batch.original.text).toBe(bytes.toString("utf8"));
      expect(batch.original.sha256).toBe(researchHash(bytes));
      expect(batch.host.actor.kind).toBe("model");
      if (batch.status === "failed") {
        expect(batch.failure).toBeTruthy();
        expect(batch.recordIds).toEqual([]);
      } else
        expect(
          ledger.records
            .filter((record) => record.batchId === batch.id)
            .map((record): unknown => JSON.parse(record.rawJson)),
        ).toEqual(LITERATURE_CORE_RECORDS);
    }
    expect(ledger.screenings.map((screen) => screen.depth)).toEqual(["abstract", "metadata"]);
    expect(
      ledger.screenings.every(
        (screen) => screen.decision === "undecided" && screen.readings.length === 0,
      ),
    ).toBe(true);
    expect(ledger.stops.map((stop) => stop.strategyVersion)).toEqual([1, 2]);
    for (const stop of ledger.stops) expect(stop.remainingLimitations.length).toBeGreaterThan(0);
    const journal = await fixture.readLiteratureJournal(),
      results = journal.filter((entry) => entry.type === "result");
    expect(results.filter((entry) => entry.isError)).toHaveLength(1);
    expect(results.find((entry) => entry.isError)).toMatchObject({
      args: { operation: "literature-screen", requiredDepth: "full-text" },
    });
    expect(
      journal.some((entry) =>
        ["literature-search", "literature-fetch", "source-search", "source-fetch"].includes(
          String(entry.args?.operation),
        ),
      ),
    ).toBe(false);
    for (const role of ["lead", "reviewer"]) {
      const before = results.find(
        (entry) => entry.role === role && entry.callId.endsWith("_context-before"),
      )!.result!;
      expect(before).toMatchObject({ independentJudgmentsHidden: true, screenings: [], stops: [] });
      expect((before.records as unknown[]).length).toBeGreaterThan(0);
      const after = results.find(
        (entry) => entry.role === role && entry.callId.endsWith("_context-after"),
      )!.result!;
      expect(after.independentJudgmentsHidden).toBe(false);
      expect((after.screenings as unknown[]).length).toBeGreaterThan(0);
      expect((after.stops as unknown[]).length).toBeGreaterThan(0);
    }
    const materials = completed.artifacts.filter((artifact) => artifact.kind === "stage-material");
    expect(materials).toHaveLength(2);
    for (const role of ["lead", "reviewer"] as const) {
      const independent = completed.artifacts.find(
        (artifact) =>
          artifact.role === role &&
          artifact.kind === (role === "lead" ? "stage-draft" : "stage-risk"),
      )!;
      expect(independent.createdAt < ledger.batches[1]!.startedAt).toBe(true);
      expect(independent.refs).toContain(materials[0]!.id);
      expect(
        completed.events.some(
          (event) =>
            event.type === "read" &&
            event.role === role &&
            event.artifactId === materials[0]!.id &&
            event.at <= independent.createdAt,
        ),
      ).toBe(true);
      expect(
        completed.literatureRecordReads!.some(
          (read) =>
            read.host.actor.sessionId ===
              completed.members.find((member) => member.role === role)!.ref.sessionId &&
            read.host.at <= independent.createdAt,
        ),
      ).toBe(true);
    }
    for (const op of completed.literatureToolOperations!) {
      expect(op.scope.model.provider).toBe("research-recovery-fixture");
      expect(
        completed.fusion!.attempts.some(
          (attempt) =>
            attempt.id === op.scope.attemptId &&
            attempt.nativeRunId === op.scope.nativeRunId &&
            attempt.taskVersion === op.scope.taskVersion,
        ),
      ).toBe(true);
    }
    const panel = page.getByTestId("research-literature-process");
    await panel.locator(":scope > summary").click();
    await expect(panel).toContainText("0 次查询记录");
    for (const batch of ledger.batches) {
      const card = panel.locator(`[data-literature-batch-id="${batch.id}"]`);
      await expect(card).toHaveAttribute("data-literature-batch-status", batch.status);
      await card.locator(":scope > summary").click();
    }
    await page.screenshot({ path: test.info().outputPath("literature-import-batches.png") });
    await panel
      .locator("summary")
      .filter({ hasText: /^重复候选/ })
      .click();
    await panel
      .locator("summary")
      .filter({ hasText: /^候选与逐条筛选/ })
      .click();
    await panel.locator(`[data-literature-record-id="${ledger.records[0]!.id}"] > summary`).click();
    await panel
      .locator("summary")
      .filter({ hasText: /^停止记录与剩余限制/ })
      .click();
    await panel
      .locator(`[data-literature-record-id="${ledger.records[0]!.id}"]`)
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("literature-duplicates-screenings-stops.png"),
    });
    await panel
      .locator("summary")
      .filter({ hasText: /^重复候选/ })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("literature-duplicate-groups.png") });
    await panel
      .locator("summary")
      .filter({ hasText: /^停止记录与剩余限制/ })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("literature-stop-history.png") });
    const requestCount = journal.filter((entry) => entry.type === "request").length;
    await harness.close();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await expect.poll(async () => (await current())?.status).toBe("completed");
    const restarted = (snapshots.restarted = await current());
    expect(records(restarted)).toEqual(records(completed));
    expect(restarted.artifacts).toEqual(completed.artifacts);
    expect(restarted.fusion!.attempts).toEqual(completed.fusion!.attempts);
    expect(
      (await fixture.readLiteratureJournal()).filter((entry) => entry.type === "request"),
    ).toHaveLength(requestCount);
    for (const material of restarted.importedMaterials!)
      expect(researchHash(await readFile(material.original))).toBe(material.sha256);
    expect(await readFile(fixture.goodFile)).toEqual(originalGood);
    expect(await readFile(fixture.badFile)).toEqual(originalBad);
    expect(rendererErrors).toEqual([]);
  } finally {
    try {
      const state = await getDesktopState(page).catch(() => undefined);
      await writeFile(
        test.info().outputPath("literature-process-core-evidence.json"),
        JSON.stringify(
          {
            boundary: LITERATURE_CORE_NOTICE,
            profile: fixture.profile,
            workspace: fixture.workspace,
            snapshots,
            lastProject: state?.researchGroups?.projects[0],
            journal: await fixture.readLiteratureJournal(),
            rendererErrors,
            originalGoodSha256: researchHash(originalGood),
            originalBadSha256: researchHash(originalBad),
            ...(state?.researchGroups?.projects[0]
              ? captureResearchNativeBoundary(state, state.researchGroups.projects[0])
              : {}),
          },
          null,
          2,
        ),
      );
    } finally {
      await harness.close();
    }
  }
});
