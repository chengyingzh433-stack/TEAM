import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import {
  REGISTRY_CSV,
  REGISTRY_PLAN_IDS,
  setupResearchAnalysisRegistryFixture,
} from "../helpers/research-analysis-registry-provider";

const execute = promisify(execFile);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function inspectRegistryUI(page: Page, project: ResearchProject) {
  const panel = page.getByTestId("research-analysis-registry-panel");
  if (!(await panel.evaluate((element) => element.hasAttribute("open"))))
    await panel.locator(":scope > summary").click();
  await expect(panel.locator(":scope > summary")).toContainText("3 项计划");
  await expect(panel.locator(":scope > summary")).toContainText("6 次实际运行");
  await expect(panel).toContainText("不提供 p 值、置信区间或因果识别");
  for (const plan of project.analysisRegistry!.plans) {
    const item = panel.locator(`[data-analysis-plan-id="${plan.id}"]`);
    await item.locator(":scope > summary").click();
    await expect(item.locator(":scope > summary")).toContainText(plan.label);
    await expect(item.locator(":scope > summary")).toContainText("事前登记");
    await expect(item.locator(":scope > summary")).toContainText("已执行 2 次");
    if (plan.compareWith) await expect(item).toContainText("要求相同样本");
    for (const run of project.analysisRegistry!.runs.filter((r) => r.planId === plan.id)) {
      const execution = item.locator(`[data-analysis-run-id="${run.id}"]`);
      await execution.locator(":scope > summary").click();
      await expect(execution).toContainText(`执行记录身份：${run.actor}`);
      const table = execution.getByRole("table", { name: "本次实际样本记录", exact: true });
      await expect(table.getByRole("row").filter({ hasText: "原始数据记录" })).toContainText("8");
      await expect(
        table.getByRole("row").filter({ hasText: "所需变量完整的原始行" }),
      ).toContainText("6");
      await expect(execution).toContainText(
        run.planId === REGISTRY_PLAN_IDS[0] ? "原始全部记录入口" : "明确派生样本入口",
      );
      if (run.actor === "model:reviewer") {
        const replay = execution
          .locator("details")
          .filter({ has: page.locator("summary", { hasText: "同引擎复跑记录" }) })
          .first();
        await replay.locator(":scope > summary").click();
        await expect(replay).toContainText("与所引用运行一致");
        await expect(replay).toContainText("不能据此声称独立算法验证通过");
      } else {
        const reviews = execution
          .locator("details")
          .filter({ has: page.locator("summary", { hasText: "本次运行的审阅记录" }) })
          .first();
        await reviews.locator(":scope > summary").click();
        await expect(reviews).toContainText("结果解释审阅");
        await expect(reviews).toContainText("记录身份：model:reviewer");
      }
      await execution.locator(":scope > summary").click();
    }
    await item.locator(":scope > summary").click();
  }
}

// FR05 E: real Pi tools and engine on UI-adopted synthetic CSV. No external provider or paper-quality proof.
test("three registered analyses use auditable common samples, actual B replay and interpretation review before S7, and survive restart", async () => {
  test.setTimeout(150_000);
  const fixture = await setupResearchAnalysisRegistryFixture();
  let harness = await fixture.launch();
  let page = await harness.firstWindow();
  const snapshots: Record<string, ResearchProject> = {};
  const diskReplays: { runId: string; resultSha256: string; stdout: string; stderr: string }[] = [];
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
        "FR05合成软件验收：采用已有方案与CSV，从S5开始登记主OLS、比较OLS和共同样本描述；S6实际计算、B复跑并解释审阅。S7不交稿，不宣称完整论文、独立算法或真实研究结论。",
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
          return (
            p.currentStage === "writing" &&
            p.status === "needs-decision" &&
            p.members.every((m) => m.status !== "running") &&
            p.fusion!.attempts.every((a) => a.state === "succeeded")
          );
        },
        { timeout: 75_000 },
      )
      .toBe(true);
    const completed = (snapshots.analysisAcceptedAtWritingBoundary = await current());
    const registry = completed.analysisRegistry!;
    expect(registry.plans.map((plan) => plan.id)).toEqual(REGISTRY_PLAN_IDS);
    expect(registry.runs).toHaveLength(6);
    expect(registry.reviews).toHaveLength(3);
    expect(completed.status).toBe("needs-decision");
    expect(completed.artifacts.some((a) => a.stage === "writing")).toBe(false);
    expect(new Set(completed.artifacts.map((a) => a.stage))).toEqual(
      new Set(["design", "analysis"]),
    );
    const accepted = completed.artifacts.find(
      (a) => a.stage === "analysis" && a.kind === "stage-review",
    )!;
    expect(accepted.verdict).toBe("accept");
    for (const review of registry.reviews)
      expect(Date.parse(accepted.createdAt)).toBeGreaterThanOrEqual(Date.parse(review.at));
    const writingAttempts = completed.fusion!.attempts.filter((attempt) =>
      attempt.taskId.startsWith("v1:writing:"),
    );
    expect(new Set(writingAttempts.map((attempt) => attempt.taskId))).toEqual(
      new Set(RESEARCH_ROLES.map((role) => `v1:writing:${role}`)),
    );
    for (const attempt of writingAttempts)
      expect(Date.parse(attempt.preparedAt)).toBeGreaterThanOrEqual(Date.parse(accepted.createdAt));
    for (const plan of registry.plans) {
      expect(plan.dataset.sha256).toBe(dataset.sha256);
      expect(plan.registration).toMatchObject({
        timing: "prospective",
        sourceRef: expect.stringMatching(/^tool:/),
        observedPriorRunIds: [],
      });
      const runs = registry.runs.filter((run) => run.planId === plan.id);
      expect(runs).toHaveLength(2);
      const original = runs.find((run) => run.actor === "model:lead")!;
      const replay = runs.find((run) => run.actor === "model:reviewer")!;
      expect(original.sample.originalDataRows).toBe(8);
      expect(original.sample.completeSourceLines).toEqual([2, 3, 4, 5, 6, 7]);
      expect(original.sample.excluded.map((row) => row.sourceLine)).toEqual([8, 9]);
      expect(original.sample.label).toBe(
        plan.purpose === "primary" ? "original-all-records" : "explicit-derived-sample",
      );
      expect(original.sample.excluded.map((row) => row.reason)).toEqual(
        plan.purpose === "primary"
          ? ["missing-values", "missing-values"]
          : ["not-selected", "not-selected"],
      );
      expect(replay.verification).toEqual({
        level: "same-engine-replay",
        replayOf: original.id,
        matches: true,
      });
      expect(replay.resultSha256).toBe(original.resultSha256);
      expect(replay.sample).toEqual(original.sample);
      expect(registry.reviews.filter((review) => review.planId === plan.id)).toEqual([
        expect.objectContaining({
          runId: original.id,
          actor: "model:reviewer",
          kind: "interpretation-review",
          verdict: "accept",
          evidenceRef: expect.stringMatching(/^tool:/),
        }),
      ]);
      for (const run of runs) {
        expect(Date.parse(accepted.createdAt)).toBeGreaterThanOrEqual(Date.parse(run.at));
        const projection = completed.analyses!.find((a) => a.id === run.id)!;
        const attempt = completed.fusion!.attempts.find((a) => a.id === projection.attemptId)!;
        expect(attempt.nativeRunId).toBeTruthy();
        expect(attempt.state).toBe("succeeded");
        expect(projection.taskId).toBe(`v1:analysis:${run.actor.split(":")[1]}`);
        const directory = dirname(projection.file);
        expect(await readFile(join(directory, "input.csv"), "utf8")).toBe(REGISTRY_CSV);
        expect(hash(await readFile(join(directory, "calculation-input.csv")))).toBe(
          run.calculationInputSha256,
        );
        const stored: unknown = JSON.parse(
          await readFile(join(directory, "registered-run.json"), "utf8"),
        );
        expect(stored).toEqual(run);
        const result = await execute(process.execPath, [join(directory, "replay.mjs")], {
          timeout: 10_000,
        });
        const actual: unknown = JSON.parse(result.stdout);
        expect(actual).toEqual({ verification: "same-engine-replay", result: run.result });
        if (!actual || typeof actual !== "object" || !("result" in actual))
          throw new Error("Disk replay did not return its actual result");
        const resultSha256 = hash(JSON.stringify(actual.result));
        expect(resultSha256).toBe(run.resultSha256);
        diskReplays.push({
          runId: run.id,
          resultSha256,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
    }
    expect(await readFile(fixture.csv, "utf8")).toBe(REGISTRY_CSV);
    expect(hash(await readFile(dataset.file))).toBe(dataset.sha256);
    await inspectRegistryUI(page, completed);
    await page.screenshot({ path: test.info().outputPath("registry-actual-analysis.png") });
    const requests = await fixture.readJournal();
    for (const operation of [
      "register-analysis",
      "run-analysis",
      "read-registered-analysis",
      "review-analysis",
      "analysis-registry",
    ])
      expect(
        requests.some((event) => event.type === "request" && event.operation === operation),
        operation,
      ).toBe(true);
    await harness.close();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    await expect.poll(async () => (await current()).status).toBe("needs-decision");
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await page
      .locator(`.research-project[data-project-id="${completed.id}"] .research-project__name`)
      .click();
    const restarted = (snapshots.restarted = await current());
    expect(restarted.analysisRegistry).toEqual(registry);
    expect(restarted.fusion!.attempts).toEqual(completed.fusion!.attempts);
    expect(restarted.artifacts).toEqual(completed.artifacts);
    await inspectRegistryUI(page, restarted);
    expect(await fixture.readJournal()).toEqual(requests);
  } finally {
    try {
      await writeFile(
        test.info().outputPath("analysis-registry-evidence.json"),
        JSON.stringify(
          {
            evidenceLevel:
              "E deterministic provider/native tools/actual same-engine CSV replay; synthetic inputs, no R or complete-paper claim",
            profile: fixture.profile,
            snapshots,
            diskReplays,
            lastProject: await current().catch(() => undefined),
            providerJournal: await fixture.readJournal(),
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
