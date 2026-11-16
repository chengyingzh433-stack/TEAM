import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import { ANALYSIS_ARCHIVE_FILES } from "../../contracts/research-analysis-reuse";
import { isCurrentResearchAnalysis } from "../../electron/research-group/paper-pipeline";
import { hasCurrentAnalysisReviewContext } from "../../electron/research-group/analysis-result-reuse";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import { REGISTRY_CSV, REGISTRY_PLAN_IDS } from "../helpers/research-analysis-registry-provider";
import { setupResearchAnalysisReuseFixture } from "../helpers/research-analysis-reuse-provider";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function openDetails(locator: ReturnType<Page["getByTestId"]>) {
  if (!(await locator.evaluate((element) => element.hasAttribute("open"))))
    await locator.locator(":scope > summary").click();
}
async function archiveHashes(p: ResearchProject): Promise<Record<string, Record<string, string>>> {
  const records: Record<string, Record<string, string>> = {};
  for (const run of p.analyses ?? []) {
    const files: Record<string, string> = {};
    for (const name of ANALYSIS_ARCHIVE_FILES)
      files[name] = hash(await readFile(join(dirname(run.file), name)));
    records[run.id] = files;
  }
  return records;
}

// E only: deterministic local model transport, actual Pi operations and immutable synthetic CSV files.
test("a local plan change reuses four existing results, computes only two new runs and rejects an old native before S6 acceptance", async () => {
  test.setTimeout(180_000);
  const fixture = await setupResearchAnalysisReuseFixture();
  let harness = await fixture.launch(),
    page = await harness.firstWindow();
  const nativeDiagnostics: string[] = [];
  const captureNativeDiagnostics = () =>
    harness.electronApp.process().stderr?.on("data", (chunk: Buffer) => {
      nativeDiagnostics.push(chunk.toString("utf8"));
    });
  captureNativeDiagnostics();
  const snapshots: Record<string, ResearchProject> = {};
  let rejectionProof: Record<string, unknown> | undefined;
  let beforeFiles: Awaited<ReturnType<typeof archiveHashes>> | undefined;
  const current = async () => (await getDesktopState(page)).researchGroups!.projects[0]!;
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
    await editor.getByLabel("研究入口", { exact: true }).selectOption("materials");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("paper");
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
        "局部复用合成软件验收：从S5真实登记三计划，S6首次六运行自然结束后仅修订比较计划；未变计算由A/B逐项明确采用并重新读取/解释，比较只重算两次。S7无稿停止，不宣称完整论文或真实研究结论。",
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
      .toBe("paused");
    expect((await current()).fusion!.attempts).toEqual([]);
    const group = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [fixture.design, fixture.csv],
    );
    await group.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(2);
    for (const file of [fixture.design, fixture.csv]) {
      const name = basename(file);
      const imported = (await current()).importedMaterials!.find((item) => item.name === name)!;
      const item = group.locator(`[data-material-id="${imported.id}"]`);
      await item.locator(":scope > summary").click();
      await item
        .getByLabel(`${name} 来源及提供说明`, { exact: true })
        .fill("本地人工合成的软件验收材料，不是真实观察结论；使用原始文件与缺失记录检验分析链。");
      if (file === fixture.design)
        await item.getByLabel(`${name} 材料用途`, { exact: true }).selectOption("design");
      else {
        await item.getByLabel(`${name} 材料性质`, { exact: true }).selectOption("synthetic");
        await item.getByLabel(`${name} 使用依据`, { exact: true }).selectOption("user-authorized");
      }
      await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
      await expect
        .poll(async () => (await current()).evidence!.sources.length)
        .toBe(file === fixture.design ? 1 : 2);
      await item.locator(":scope > summary").click();
    }
    await group.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect
      .poll(async () => (await current()).entryInventory?.firstMissingStage)
      .toBe("design");
    const adopted = (snapshots.adoptedBeforeExecution = await current());
    expect(adopted.entryInventory!.canStart).toBe(true);
    expect(adopted.artifacts).toEqual([]);
    expect(adopted.evidence!.datasets).toHaveLength(1);
    const dataset = adopted.evidence!.datasets[0]!;
    expect(dataset.sha256).toBe(hash(REGISTRY_CSV));
    await group.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = await current();
          const failed = p.fusion!.attempts.filter((a) => ["failed", "unknown"].includes(a.state));
          if (failed.length) throw new Error(JSON.stringify(failed));
          const runs = p.analysisRegistry?.runs ?? [];
          const source = runs.map((run) =>
            p.fusion!.attempts.find(
              (a) => a.id === p.analyses!.find((r) => r.id === run.id)?.attemptId,
            ),
          );
          const armed = (await fixture.readReuseJournal()).find(
            (event) => event.type === "late-native-armed",
          );
          return (
            runs.length === 6 &&
            source.every((a) => a?.state === "succeeded" && !!a.finishedAt) &&
            !!armed &&
            p.fusion!.attempts.some((a) => a.id === armed.attemptId && a.state === "running")
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const original = (snapshots.originalSixFinished = await current());
    expect(original.currentStage).toBe("analysis");
    expect(original.analysisRegistry!.plans).toHaveLength(3);
    expect(original.analysisRegistry!.runs).toHaveLength(6);
    expect(original.analysisRegistry!.reviews).toHaveLength(3);
    expect(
      original.artifacts.some((a) => a.stage === "analysis" && a.kind === "stage-review"),
    ).toBe(false);
    beforeFiles = await archiveHashes(original);
    const panel = page.getByTestId("research-analysis-registry-panel");
    await openDetails(panel);
    await expect(panel.locator(":scope > summary")).toContainText("6 次实际运行");
    await page.screenshot({ path: test.info().outputPath("original-six-runs-before-change.png") });
    await fixture.releaseComparisonChange();
    await expect
      .poll(
        async () => {
          const p = await current();
          const failed = p.fusion!.attempts.filter((a) => ["failed", "unknown"].includes(a.state));
          if (failed.length) throw new Error(JSON.stringify(failed));
          return (
            p.currentStage === "writing" &&
            p.status === "needs-decision" &&
            p.members.every((m) => m.status !== "running") &&
            p.fusion!.attempts.every((a) => a.state === "succeeded")
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const completed = (snapshots.localChangeAccepted = await current());
    const registry = completed.analysisRegistry!;
    expect(registry.runs).toHaveLength(8);
    expect(registry.runs.slice(0, 6)).toEqual(original.analysisRegistry!.runs);
    expect(completed.analyses!.slice(0, 6)).toEqual(original.analyses);
    const allFiles = await archiveHashes(completed);
    for (const run of original.analysisRegistry!.runs)
      expect(allFiles[run.id]).toEqual(beforeFiles[run.id]);
    expect(hash(await readFile(dataset.file))).toBe(dataset.sha256);
    expect(await readFile(fixture.csv, "utf8")).toBe(REGISTRY_CSV);
    const changed = registry.plans.find(
      (plan) => plan.id === REGISTRY_PLAN_IDS[1] && plan.version === 2,
    )!;
    expect(changed).toMatchObject({ columns: ["z"], registration: { timing: "post-hoc" } });
    expect(changed.registration.observedPriorRunIds).toEqual(
      original.analysisRegistry!.runs.map((run) => run.id),
    );
    expect(registry.runs.slice(6).map((run) => [run.planId, run.planVersion, run.actor])).toEqual([
      [REGISTRY_PLAN_IDS[1], 2, "model:lead"],
      [REGISTRY_PLAN_IDS[1], 2, "model:reviewer"],
    ]);
    expect(registry.runs[7]!.verification).toEqual({
      level: "same-engine-replay",
      replayOf: registry.runs[6]!.id,
      matches: true,
    });
    const currentRuns = completed.analyses!.filter((run) =>
      isCurrentResearchAnalysis(completed, run),
    );
    expect(currentRuns).toHaveLength(6);
    const adoptions = completed.analysisRunAdoptions!;
    expect(adoptions).toHaveLength(4);
    expect(new Set(adoptions.map((a) => `${a.pin.planId}:${a.target.role}`))).toEqual(
      new Set(
        [REGISTRY_PLAN_IDS[0], REGISTRY_PLAN_IDS[2]].flatMap((planId) =>
          ["lead", "reviewer"].map((role) => `${planId}:${role}`),
        ),
      ),
    );
    for (const adoption of adoptions) {
      const source = original.fusion!.attempts.find(
        (attempt) => attempt.id === adoption.source.attemptId,
      )!;
      const target = completed.fusion!.attempts.find(
        (attempt) => attempt.id === adoption.target.attemptId,
      )!;
      expect(source.state).toBe("succeeded");
      expect(source.nativeRunId).toBe(adoption.source.nativeRunId);
      expect(target.nativeRunId).toBe(adoption.target.nativeRunId);
      expect(target.state).toBe("succeeded");
      expect(adoption.target.taskInputVersion).toBeGreaterThan(adoption.source.taskInputVersion);
      expect(adoption.source.role).toBe(adoption.target.role);
      expect(Date.parse(source.finishedAt!)).toBeLessThan(Date.parse(changed.registration.at));
      expect(Date.parse(target.preparedAt)).toBeGreaterThanOrEqual(
        Date.parse(changed.registration.at),
      );
      for (const file of ANALYSIS_ARCHIVE_FILES)
        expect(adoption.fileHashes[file]).toBe(beforeFiles[adoption.pin.runId]![file]);
    }
    const receipts = await fixture.readReuseJournal();
    const expectedError = receipts.filter((event) => event.type === "tool-result" && event.error);
    expect(expectedError).toHaveLength(2);
    const oldNativeErrors = expectedError.filter((event) => event.callId?.endsWith("_late-reuse"));
    const expiredNumericErrors = expectedError.filter((event) =>
      event.callId?.endsWith("_expired-numeric-render"),
    );
    expect(oldNativeErrors).toHaveLength(1);
    expect(expiredNumericErrors).toHaveLength(1);
    const oldNativeError = oldNativeErrors[0]!,
      expiredNumericError = expiredNumericErrors[0]!;
    expect(oldNativeError).toMatchObject({ role: "lead", args: { operation: "reuse-analysis" } });
    expect(String(oldNativeError.result)).toContain("任务输入已变化或原生请求已结束");
    const staleAttempt = completed.fusion!.attempts.find(
      (attempt) => attempt.id === oldNativeError.attemptId,
    )!;
    expect(staleAttempt.state).toBe("succeeded");
    expect(adoptions.some((adoption) => adoption.target.attemptId === staleAttempt.id)).toBe(false);
    // This second negative must reach currentRun from an admitted CURRENT A native,
    // not merely fail the old-native admission check exercised above.
    const oldComparison = original.analysisRegistry!.runs.find(
      (run) =>
        run.planId === REGISTRY_PLAN_IDS[1] && run.planVersion === 1 && run.actor === "model:lead",
    )!;
    const newComparison = registry.runs[6]!;
    const currentProjection = completed.analyses!.find((run) => run.id === newComparison.id)!;
    const currentAttempt = completed.fusion!.attempts.find(
      (attempt) => attempt.id === currentProjection.attemptId,
    )!;
    const currentTask = completed.fusion!.tasks.find((task) => task.id === currentAttempt.taskId)!;
    expect(expiredNumericError).toMatchObject({
      role: "lead",
      attemptId: currentAttempt.id,
      nativeRunId: currentAttempt.nativeRunId,
      taskId: currentTask.id,
      taskInputVersion: currentTask.inputVersion,
      args: {
        operation: "numeric-render",
        runId: oldComparison.id,
        path: ["regression", "sampleSize"],
        quantity: "sample-size",
        unit: "",
        decimalPlaces: 0,
        rounding: "half-away-from-zero",
      },
    });
    expect(expiredNumericError.callId).toContain(currentAttempt.id);
    expect(String(expiredNumericError.result)).toContain(
      "运行不存在、未实际采用或因数据/计划/任务版本变化而过期。",
    );
    expect(String(expiredNumericError.result)).not.toContain("任务输入已变化或原生请求已结束");
    expect(currentAttempt.nativeRunId).toBeTruthy();
    expect(currentAttempt.id).not.toBe(staleAttempt.id);
    expect(currentAttempt.nativeRunId).not.toBe(staleAttempt.nativeRunId);
    expect(currentAttempt.taskVersion).toBe(currentTask.inputVersion);
    expect(currentAttempt.taskVersion).toBeGreaterThan(staleAttempt.taskVersion);
    expect(currentAttempt.state).toBe("succeeded");
    expect(Date.parse(currentAttempt.preparedAt)).toBeGreaterThanOrEqual(
      Date.parse(changed.registration.at),
    );
    expect(Date.parse(expiredNumericError.at)).toBeGreaterThanOrEqual(Date.parse(newComparison.at));
    const adoptedBeforeNegative = adoptions.filter(
      (adoption) =>
        adoption.target.attemptId === currentAttempt.id && adoption.target.role === "lead",
    );
    expect(adoptedBeforeNegative).toHaveLength(2);
    for (const adoption of adoptedBeforeNegative)
      expect(Date.parse(adoption.at)).toBeLessThanOrEqual(Date.parse(expiredNumericError.at));
    const oldN = (oldComparison.result.regression as Record<string, unknown>).sampleSize;
    const newN = (newComparison.result.regression as Record<string, unknown>).sampleSize;
    expect(typeof oldN).toBe("number");
    expect(newN).toBe(oldN); // Equal numbers do not authorize the expired plan/run identity.
    expect(
      isCurrentResearchAnalysis(
        completed,
        completed.analyses!.find((run) => run.id === oldComparison.id)!,
      ),
    ).toBe(false);
    expect(
      (completed.numericBindings ?? []).some((binding) => binding.runId === oldComparison.id),
    ).toBe(false);
    expect(
      (completed.numericFieldMetadata ?? []).some((field) => field.runId === oldComparison.id),
    ).toBe(false);
    const currentLeadOutputs = completed.artifacts.filter((artifact) =>
      completed.fusion!.artifacts.some(
        (record) => record.id === artifact.id && record.attemptId === currentAttempt.id,
      ),
    );
    const currentDraft = currentLeadOutputs.find((artifact) => artifact.kind === "stage-draft")!;
    expect(currentDraft).toBeTruthy();
    expect(Date.parse(currentDraft.createdAt)).toBeGreaterThanOrEqual(
      Date.parse(expiredNumericError.at),
    );
    expect(
      currentLeadOutputs.some((artifact) => artifact.analysisIds?.includes(oldComparison.id)),
    ).toBe(false);
    rejectionProof = {
      oldNativeError,
      currentNativeExpiredRunError: expiredNumericError,
      currentAttempt: {
        id: currentAttempt.id,
        nativeRunId: currentAttempt.nativeRunId,
        taskId: currentTask.id,
        taskInputVersion: currentTask.inputVersion,
      },
      oldComparison: {
        id: oldComparison.id,
        planVersion: oldComparison.planVersion,
        resultSha256: oldComparison.resultSha256,
      },
      newComparison: {
        id: newComparison.id,
        planVersion: newComparison.planVersion,
        resultSha256: newComparison.resultSha256,
      },
      sameSampleSize: { old: oldN, current: newN },
      boundary:
        "An admitted current A native tried the real numeric-render tool after both unchanged-result adoptions and comparison v2 execution. Expired comparison v1 is rejected before numeric read/metadata/render, even with equal n; the old-native error remains a separate negative.",
    };
    const historical = completed.artifacts.find((artifact) =>
      artifact.content.includes("LATE_OLD_INPUT_HISTORY"),
    )!;
    expect(historical).toBeTruthy();
    const historicalRecord = completed.fusion!.artifacts.find(
      (record) => record.id === historical.id,
    )!;
    const historicalTask = completed.fusion!.tasks.find(
      (task) => task.id === historicalRecord.taskId,
    )!;
    expect(historicalRecord.attemptId).toBe(staleAttempt.id);
    expect(historicalRecord.taskVersion).toBeLessThan(historicalTask.inputVersion);
    expect(historicalTask.currentArtifactId).not.toBe(historical.id);
    expect(
      completed.events.some(
        (event) => event.artifactId === historical.id && event.detail.includes("保留为历史"),
      ),
    ).toBe(true);
    for (const review of original.analysisRegistry!.reviews) {
      expect(registry.reviews.find((item) => item.id === review.id)).toEqual(review);
      expect(hasCurrentAnalysisReviewContext(completed, review.id)).toBe(false);
    }
    const accepted = completed.artifacts.find(
      (a) => a.stage === "analysis" && a.kind === "stage-review" && a.verdict === "accept",
    )!;
    expect(accepted).toBeTruthy();
    for (const planId of REGISTRY_PLAN_IDS) {
      const version = planId === REGISTRY_PLAN_IDS[1] ? 2 : 1;
      const originalRun = registry.runs.find(
        (run) => run.planId === planId && run.planVersion === version && run.actor === "model:lead",
      )!;
      const review = registry.reviews
        .filter(
          (item) => item.runId === originalRun.id && item.note.includes("CURRENT_INTERPRETATION"),
        )
        .at(-1)!;
      expect(review).toBeTruthy();
      expect(hasCurrentAnalysisReviewContext(completed, review.id)).toBe(true);
      expect(Date.parse(review.at)).toBeGreaterThan(Date.parse(changed.registration.at));
      expect(Date.parse(accepted.createdAt)).toBeGreaterThanOrEqual(Date.parse(review.at));
      const context = completed.analysisReviewContexts!.find(
        (item) => item.reviewId === review.id,
      )!;
      const read = completed.analysisReads!.find((item) => item.id === context.readId)!;
      expect(read.context.attemptId).toBe(context.context.attemptId);
      expect(read.usableForCurrentInputs).toBe(true);
    }
    expect(completed.artifacts.some((artifact) => artifact.stage === "writing")).toBe(false);
    expect(new Set(completed.artifacts.map((artifact) => artifact.stage))).toEqual(
      new Set(["design", "analysis"]),
    );
    const writing = completed.fusion!.attempts.filter((attempt) =>
      attempt.taskId.includes(":writing:"),
    );
    expect(new Set(writing.map((attempt) => attempt.taskId))).toEqual(
      new Set(RESEARCH_ROLES.map((role) => `v1:writing:${role}`)),
    );
    for (const attempt of writing)
      expect(Date.parse(attempt.preparedAt)).toBeGreaterThanOrEqual(Date.parse(accepted.createdAt));
    await openDetails(panel);
    await expect(panel.locator(":scope > summary")).toContainText("8 次实际运行");
    const adoptionUI = page.getByTestId("research-analysis-run-adoptions");
    await openDetails(adoptionUI);
    await expect(adoptionUI).toContainText("采用不增加运行次数");
    for (const adoption of adoptions) {
      const item = adoptionUI.locator(`[data-analysis-adoption-id="${adoption.id}"]`);
      await openDetails(item);
      await expect(item).toContainText(adoption.pin.runId);
      await expect(item).toContainText(adoption.source.nativeRunId);
      await expect(item).toContainText(
        `${adoption.target.model.provider}/${adoption.target.model.modelId}`,
      );
      await expect(item).toContainText("当前任务仍为此输入版本");
    }
    await adoptionUI.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("four-explicit-adoptions-eight-total-runs.png"),
    });
    await adoptionUI.locator(":scope > summary").click();
    const main = panel.locator(`[data-analysis-plan-id="${REGISTRY_PLAN_IDS[0]}"]`);
    await openDetails(main);
    const mainRun = registry.runs.find(
      (run) => run.planId === REGISTRY_PLAN_IDS[0] && run.actor === "model:lead",
    )!;
    const runUI = main.locator(`[data-analysis-run-id="${mainRun.id}"]`);
    await openDetails(runUI);
    const reviewsUI = runUI
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: "本次运行的审阅记录" }) })
      .first();
    await openDetails(reviewsUI);
    await expect(reviewsUI).toContainText("INITIAL_INTERPRETATION");
    await expect(reviewsUI).toContainText("CURRENT_INTERPRETATION");
    await reviewsUI.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("original-run-and-new-model-interpretation.png"),
    });
    const requests = await fixture.readJournal();
    await harness.close();
    harness = await fixture.launch();
    captureNativeDiagnostics();
    page = await harness.firstWindow();
    await expect.poll(async () => (await current()).status).toBe("needs-decision");
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await page
      .locator(`.research-project[data-project-id="${completed.id}"] .research-project__name`)
      .click();
    const restarted = (snapshots.restarted = await current());
    for (const field of [
      "analysisRegistry",
      "analysisRunAdoptions",
      "analysisReads",
      "analysisReviewContexts",
      "analyses",
      "artifacts",
    ] as const)
      expect(restarted[field]).toEqual(completed[field]);
    const { paused: beforePaused, tasks: beforeTasks, ...beforeGraph } = completed.fusion!;
    const { paused: restoredPaused, tasks: restoredTasks, ...restoredGraph } = restarted.fusion!;
    expect(beforePaused).toBe(false);
    expect(restoredPaused).toBe(true);
    expect(restoredGraph).toEqual(beforeGraph);
    expect(restoredTasks.map((task) => task.id)).toEqual(beforeTasks.map((task) => task.id));
    for (const task of beforeTasks) {
      const restored = restoredTasks.find((item) => item.id === task.id)!;
      const { state: oldState, blockers: oldBlockers, ...oldTask } = task;
      const { state: newState, blockers, ...newTask } = restored;
      expect(newTask).toEqual(oldTask);
      expect(newState).toBe(oldState === "pending" ? "paused" : oldState);
      expect(oldBlockers).toEqual([]);
      expect(blockers).toEqual([
        expect.objectContaining({ kind: "pause", objectId: completed.id }),
      ]);
    }
    expect(
      restarted.analyses!.filter((run) => isCurrentResearchAnalysis(restarted, run)),
    ).toHaveLength(6);
    expect(nativeDiagnostics.join("")).not.toContain("[research-group] event persistence failed");
    expect(await archiveHashes(restarted)).toEqual(allFiles);
    await openDetails(page.getByTestId("research-analysis-registry-panel"));
    await openDetails(page.getByTestId("research-analysis-run-adoptions"));
    await expect(
      page.getByTestId("research-analysis-run-adoptions").locator("[data-analysis-adoption-id]"),
    ).toHaveCount(4);
    expect(await fixture.readJournal()).toEqual(requests);
    expect(await fixture.readReuseJournal()).toEqual(receipts);
    await page.screenshot({ path: test.info().outputPath("restarted-adoption-history.png") });
  } finally {
    try {
      await writeFile(test.info().outputPath("native-diagnostics.log"), nativeDiagnostics.join(""));
      await writeFile(
        test.info().outputPath("analysis-reuse-evidence.json"),
        JSON.stringify(
          {
            evidenceLevel:
              "E actual native/tools/files with deterministic local provider and synthetic CSV; not R/C or a complete paper",
            profile: fixture.profile,
            snapshots,
            beforeFiles,
            rejectionProof,
            lastProject: await current().catch(() => undefined),
            providerJournal: await fixture.readJournal(),
            toolJournal: await fixture.readReuseJournal(),
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
