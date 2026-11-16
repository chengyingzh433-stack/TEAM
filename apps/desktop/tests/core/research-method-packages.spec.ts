import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import { captureResearchNativeBoundary } from "../helpers/research-live-evidence";
import {
  METHOD_BOUNDARY,
  METHOD_IMAGE_PATHS,
  setupResearchMethodPackageFixture,
} from "../helpers/research-method-package-provider";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const methodRecords = (p: ResearchProject) => ({
  packages: p.methodPackages,
  uses: p.methodPackageUses,
  receipts: p.methodImageReceipts,
  readings: p.methodImageReadings,
  applications: p.methodApplications,
  opinions: p.methodContentOpinions,
  adjudications: p.methodAdjudications,
  programChecks: p.methodProgramChecks,
});
async function openMethodPanel(page: Page, project: ResearchProject) {
  const panel = page.getByTestId("research-method-packages");
  if (!(await panel.evaluate((element) => element.hasAttribute("open"))))
    await panel.locator(":scope > summary").click();
  const pkg = panel.locator(`[data-method-package-id="${project.methodPackages![0]!.id}"]`);
  if (!(await pkg.evaluate((element) => element.hasAttribute("open"))))
    await pkg.locator(":scope > summary").click();
  return { panel, pkg };
}

async function openProgramCheck(
  page: Page,
  role: "reviewer" | "mentor",
  result: "blocked" | "passed-at-snapshot",
  artifactId: string,
) {
  const records = page.getByTestId("research-method-program-checks");
  if (!(await records.evaluate((element) => element.hasAttribute("open"))))
    await records.locator(":scope > summary").click();
  const check = records
    .locator(`[data-method-check-result="${result}"][data-method-check-role="${role}"]`)
    .first();
  if (!(await check.evaluate((element) => element.hasAttribute("open"))))
    await check.locator(":scope > summary").click();
  const version = check.getByText("检查版本与定位", { exact: true });
  if (!(await version.locator("..").evaluate((element) => element.hasAttribute("open"))))
    await version.click();
  await expect(check.getByText(`稿件：${artifactId}`, { exact: true })).toBeVisible();
  await expect(check.getByText("程序版本：method-acceptance-1", { exact: true })).toBeVisible();
  await check.scrollIntoViewIfNeeded();
  return check;
}

// E only: actual Electron/Pi tools, local deterministic provider, synthetic method text/pixels.
test("method images reach the native provider before observations, and formal acceptance requires current application reviews", async () => {
  test.setTimeout(180_000);
  const fixture = await setupResearchMethodPackageFixture();
  let harness = await fixture.launch(),
    page = await harness.firstWindow();
  const snapshots: Record<string, ResearchProject> = {},
    rendererErrors: string[] = [];
  const current = async () => (await getDesktopState(page)).researchGroups!.projects[0]!;
  const healthy = (p: ResearchProject) => {
    const failures = p.fusion!.attempts.filter((a) => ["failed", "unknown"].includes(a.state));
    if (failures.length) throw new Error(JSON.stringify(failures));
  };
  try {
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(fixture.kb);
    await editor.getByLabel("研究材料目录", { exact: true }).fill("");
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("研究入口", { exact: true }).selectOption("task");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("task");
    await editor.getByLabel("单项任务类型", { exact: true }).selectOption("design-review");
    await editor
      .getByLabel("单项任务范围", { exact: true })
      .fill(
        "仅核查合成方案的课程方法包、四张合成图片、部分指标适用边界与模型审阅，不扩为全文或数据分析。",
      );
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
        `${METHOD_BOUNDARY} 对待导入方案做设计单项审阅：EDU-N02-2-5及其必要上下文、四张明确合成的PNG；实际取得包、读图、记录有限应用，B独立初判/意见、导师有限裁定。没有CSV或真实评分。`,
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
      .toBe("paused");
    expect((await current()).fusion!.attempts).toEqual([]);
    const group = page.getByRole("region", { name: "教育研究课题组", exact: true });
    // Stub only the OS chooser response; importing/parsing/adoption use the ordinary UI.
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [fixture.design],
    );
    await group.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(1);
    const material = (await current()).importedMaterials![0]!,
      name = basename(fixture.design);
    const item = group.locator(`[data-material-id="${material.id}"]`);
    await item.locator(":scope > summary").click();
    await item.getByLabel(`${name} 来源及提供说明`, { exact: true }).fill(METHOD_BOUNDARY);
    await item.getByLabel(`${name} 材料用途`, { exact: true }).selectOption("design");
    await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect.poll(async () => (await current()).evidence!.sources.length).toBe(1);
    await item.locator(":scope > summary").click();
    await group.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect.poll(async () => (await current()).entryInventory?.canStart).toBe(true);
    snapshots.adopted = await current();
    expect(snapshots.adopted.entryInventory!.firstMissingStage).toBe("design");
    expect(snapshots.adopted.artifacts).toEqual([]);
    await group.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = await current();
          healthy(p);
          return (
            p.methodProgramChecks?.some((c) => c.role === "reviewer" && c.result === "blocked") &&
            (await fixture.readMethodJournal()).some(
              (e) => e.type === "result" && e.callId.endsWith("_probe-verification") && e.isError,
            )
          );
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    const blocked = (snapshots.blockedMissingImagesAndOpinion = await current());
    const pkg = blocked.methodPackages![0]!,
      application = blocked.methodApplications![0]!;
    const revision = blocked.artifacts.find((a) => a.kind === "stage-revision")!;
    expect(blocked.methodPackages).toHaveLength(1);
    expect(blocked.packets).toEqual([]);
    expect(pkg.rootIds).toEqual(["EDU-N02-2-5"]);
    expect(pkg.records.map((r) => r.id).sort()).toEqual(["EDU-N02-2-4", "EDU-N02-2-5"]);
    expect(pkg.records.find((r) => r.id === "EDU-N02-2-5")!.requiredContextIds).toEqual([
      "EDU-N02-2-4",
    ]);
    expect(pkg.images.map((i) => i.path).sort()).toEqual([...METHOD_IMAGE_PATHS].sort());
    expect(pkg.images.every((i) => i.state === "bytes-readable")).toBe(true);
    expect(blocked.methodImageReceipts ?? []).toEqual([]);
    expect(blocked.methodImageReadings ?? []).toEqual([]);
    expect(blocked.methodContentOpinions ?? []).toEqual([]);
    expect(blocked.methodAdjudications ?? []).toEqual([]);
    expect(blocked.methodApplications).toHaveLength(1);
    expect(application.scoringClaim).toBe("partial-indicators-only");
    expect(blocked.artifacts.some((a) => a.kind === "stage-verification")).toBe(false);
    const firstCheck = blocked.methodProgramChecks!.find(
      (c) => c.role === "reviewer" && c.result === "blocked",
    )!;
    expect(firstCheck).toMatchObject({
      programVersion: "method-acceptance-1",
      target: { artifactId: revision.id, bodySha256: hash(revision.content) },
    });
    expect(firstCheck.issues.join("\n")).toContain("未记录实际图像阅读");
    expect(firstCheck.packages.every((pkg) => pkg.opinionIds.length === 0)).toBe(true);
    expect(firstCheck.issues.join("\n")).toMatch(/B.*支持意见/);
    const early = await fixture.readMethodJournal();
    const guess = early.find((e) => e.type === "result" && e.callId.endsWith("_probe-guess"))!;
    expect(guess.isError).toBe(true);
    expect(guess.args).toMatchObject({ operation: "method-check", applicationId: application.id });
    expect(guess.text).toContain("独立初判");
    expect(early.find((e) => e.type === "request" && e.callId === guess.callId)!.before!.risk).toBe(
      false,
    );
    expect(
      early.find((e) => e.type === "result" && e.callId.endsWith("_probe-full-score")),
    ).toMatchObject({
      isError: true,
      args: { operation: "method-apply", scoringClaim: "full-score" },
    });
    const firstUI = await openMethodPanel(page, blocked);
    await expect(firstUI.panel).toContainText("方法依据与应用");
    await expect(firstUI.pkg).toContainText("0 次图片返回 · 0 条读图观察");
    const blockedUI = await openProgramCheck(page, "reviewer", "blocked", revision.id);
    await expect(blockedUI).toContainText("未记录实际图像阅读");
    await page.screenshot({ path: test.info().outputPath("method-program-blocked.png") });
    await fixture.release("images");
    await expect
      .poll(
        async () => {
          const p = await current();
          healthy(p);
          return (
            p.methodImageReceipts?.length === 1 &&
            (await fixture.readMethodJournal()).some(
              (e) =>
                e.type === "result" &&
                e.args?.operation === "method-read-image" &&
                e.images?.length === 1,
            )
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const delivered = (snapshots.imageDeliveredBeforeObservation = await current());
    expect(delivered.methodImageReadings ?? []).toEqual([]);
    const firstReceipt = delivered.methodImageReceipts![0]!;
    expect(firstReceipt).toMatchObject({
      path: fixture.images[0]!.path,
      imageSha256: fixture.images[0]!.sha256,
      bytes: fixture.images[0]!.bytes.length,
      mimeType: "image/png",
      sessionId: delivered.members.find((m) => m.role === "lead")!.ref.sessionId,
    });
    const deliveredEvent = (await fixture.readMethodJournal()).find(
      (e) => e.type === "result" && e.callId === firstReceipt.callId,
    )!;
    expect(deliveredEvent.images).toEqual([
      {
        sha256: fixture.images[0]!.sha256,
        bytes: fixture.images[0]!.bytes.length,
        mimeType: "image/png",
      },
    ]);
    expect(deliveredEvent.modelInput).toContain("image");
    expect(deliveredEvent.textOrDetailsContainsImageData).toBe(false);
    expect(deliveredEvent.text).not.toContain(fixture.images[0]!.bytes.toString("base64"));
    const imageUI = await openMethodPanel(page, delivered);
    const imageSummary = imageUI.pkg.locator("summary").filter({ hasText: METHOD_IMAGE_PATHS[0]! });
    await expect(imageSummary).toContainText("1 次图片返回 · 0 条读图观察");
    await imageSummary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("method-image-before-observation.png") });
    await fixture.release("observations");
    await expect
      .poll(
        async () => {
          const p = await current();
          healthy(p);
          return (
            p.methodProgramChecks?.some((c) => c.role === "mentor" && c.result === "blocked") &&
            (await fixture.readMethodJournal()).some(
              (e) => e.type === "result" && e.callId.endsWith("_probe-adjudication") && e.isError,
            )
          );
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    const awaiting = (snapshots.blockedMissingAdjudication = await current());
    expect(awaiting.methodImageReceipts).toHaveLength(8);
    expect(awaiting.methodImageReadings).toHaveLength(8);
    expect(awaiting.methodContentOpinions).toHaveLength(1);
    expect(awaiting.methodContentOpinions![0]!.verdict).toBe("support");
    expect(awaiting.methodAdjudications ?? []).toEqual([]);
    expect(awaiting.artifacts.find((a) => a.kind === "stage-verification")!.verdict).toBe("accept");
    expect(awaiting.artifacts.some((a) => a.kind === "stage-review")).toBe(false);
    const mentorBlock = awaiting.methodProgramChecks!.find(
      (c) => c.role === "mentor" && c.result === "blocked",
    )!;
    expect(mentorBlock.packages.every((pkg) => pkg.adjudicationIds.length === 0)).toBe(true);
    expect(mentorBlock.issues.join("\n")).toMatch(/导师.*B支持.*接受裁定/);
    expect(mentorBlock.packages[0]!.imageReadings.every((i) => i.readingIds.length === 1)).toBe(
      true,
    );
    const beforeAdjudicationUI = await openMethodPanel(page, awaiting);
    const mentorBlockedUI = await openProgramCheck(page, "mentor", "blocked", revision.id);
    await expect(mentorBlockedUI).toContainText(/导师.*B支持.*接受裁定/);
    await page.screenshot({ path: test.info().outputPath("method-program-mentor-blocked.png") });
    const applicationUI = beforeAdjudicationUI.pkg.locator(
      `[data-method-application-id="${application.id}"]`,
    );
    await applicationUI.locator(":scope > summary").click();
    await expect(applicationUI).toContainText("仅部分指标，不能作为完整工具总分");
    await expect(applicationUI).toContainText("研究者 B Agent · 支持");
    await expect(applicationUI).not.toContainText("导师 Agent · 接受");
    await applicationUI.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("method-application-b-before-mentor.png"),
    });
    await fixture.release("adjudication");
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(page),
            p = state.researchGroups!.projects[0]!;
          healthy(p);
          return (
            p.status === "completed" &&
            captureResearchNativeBoundary(state, p).activeNativeAtCapture.length === 0
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const completed = (snapshots.completed = await current());
    expect(researchExecutionRoute(completed).stageIds).toEqual(["design"]);
    expect(researchExecutionRoute(completed).requiredRoles).toEqual(["lead", "reviewer", "mentor"]);
    expect(completed.evidence!.datasets).toEqual([]);
    expect(completed.analyses ?? []).toEqual([]);
    expect(completed.analysisRegistry?.runs ?? []).toEqual([]);
    expect(completed.fusion!.attempts.every((a) => a.state === "succeeded")).toBe(true);
    expect(completed.artifacts.filter((a) => a.kind === "stage-revision")).toHaveLength(1);
    expect(completed.artifacts.every((a) => a.stage === "design")).toBe(true);
    expect(completed.methodApplications).toHaveLength(1);
    expect(completed.packets).toEqual([]);
    expect(completed.methodAdjudications).toHaveLength(1);
    expect(completed.methodAdjudications![0]).toMatchObject({
      applicationId: application.id,
      opinionIds: [completed.methodContentOpinions![0]!.id],
      verdict: "accept",
      actor: { kind: "model", id: "model:mentor" },
    });
    expect(completed.methodProgramChecks!.filter((c) => c.result === "blocked")).toHaveLength(2);
    const passed = completed.methodProgramChecks!.filter((c) => c.result === "passed-at-snapshot");
    expect(passed.map((c) => c.role).sort()).toEqual(["mentor", "reviewer"]);
    for (const check of passed) {
      expect(check.target).toEqual({ artifactId: revision.id, bodySha256: hash(revision.content) });
      expect(check.issues).toEqual([]);
      expect(check.model).toEqual({
        provider: "research-recovery-fixture",
        modelId: "gpt-6.1-sol",
        thinkingLevel: "low",
      });
    }
    for (const role of ["lead", "reviewer"])
      for (const image of fixture.images) {
        const receipt = completed.methodImageReceipts!.find(
            (r) => r.path === image.path && r.actor.id === `model:${role}`,
          )!,
          reading = completed.methodImageReadings!.find(
            (r) => r.path === image.path && r.actor.id === `model:${role}`,
          )!;
        expect(receipt.imageSha256).toBe(image.sha256);
        expect(reading.imageSha256).toBe(image.sha256);
        expect(reading.actor).toMatchObject({ kind: "model", id: `model:${role}` });
        expect(reading.observations).toContain("不是课程视觉C");
        expect(Date.parse(reading.at)).toBeGreaterThanOrEqual(Date.parse(receipt.at));
        expect(reading.id).not.toBe(receipt.id);
        const provenance: unknown = JSON.parse(
          reading.actor.evidenceRef.slice("host-method:".length),
        );
        expect(provenance).toMatchObject({
          attemptId: receipt.attemptId,
          nativeRunId: receipt.nativeRunId,
          sessionId: receipt.sessionId,
        });
      }
    expect(new Set(fixture.images.map((i) => i.sha256)).size).toBe(4);
    const journal = await fixture.readMethodJournal(),
      results = journal.filter((e) => e.type === "result");
    expect(results.filter((e) => e.isError)).toHaveLength(4);
    const imageResults = results.filter((e) => e.args?.operation === "method-read-image");
    expect(imageResults).toHaveLength(8);
    for (const event of imageResults) {
      const expected = fixture.images.find((i) => i.path === event.args!.path)!;
      expect(event.images).toEqual([
        { sha256: expected.sha256, bytes: expected.bytes.length, mimeType: "image/png" },
      ]);
      expect(event.textOrDetailsContainsImageData).toBe(false);
      expect(event.text).not.toContain(expected.bytes.toString("base64"));
    }
    expect(
      journal.filter(
        (e) =>
          e.type === "request" &&
          e.args &&
          ["knowledge", "analyze", "run-analysis"].includes(String(e.args.operation)),
      ),
    ).toEqual([]);
    for (const use of completed.methodPackageUses!) {
      expect(use.model.provider).toBe("research-recovery-fixture");
      expect(
        completed.fusion!.attempts.some(
          (a) =>
            a.id === use.attemptId &&
            a.nativeRunId === use.nativeRunId &&
            a.taskVersion === use.taskInputVersion,
        ),
      ).toBe(true);
    }
    const finalUI = await openMethodPanel(page, completed);
    const passedUI = await openProgramCheck(page, "mentor", "passed-at-snapshot", revision.id);
    await expect(passedUI).toContainText("方法判断仍由具名模型负责");
    await page.screenshot({ path: test.info().outputPath("method-program-passed.png") });
    for (const image of fixture.images) {
      const summary = finalUI.pkg.locator("summary").filter({ hasText: image.path });
      await expect(summary).toContainText("2 次图片返回 · 2 条读图观察");
      await summary.click();
      await expect(summary.locator("..")).toContainText("不是课程视觉C");
    }
    await finalUI.pkg
      .locator("summary")
      .filter({ hasText: fixture.images[0]!.path })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("method-four-image-observations.png") });
    const finalApp = finalUI.pkg.locator(`[data-method-application-id="${application.id}"]`);
    if (!(await finalApp.evaluate((element) => element.hasAttribute("open"))))
      await finalApp.locator(":scope > summary").click();
    await expect(finalApp).toContainText("研究者 B Agent · 支持");
    await expect(finalApp).toContainText("导师 Agent · 接受");
    await finalApp.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("method-application-b-mentor-accepted.png"),
    });
    const requestCount = journal.filter((e) => e.type === "request").length;
    await harness.close();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
      .toBe("completed");
    const restarted = (snapshots.restarted = await current());
    expect(methodRecords(restarted)).toEqual(methodRecords(completed));
    expect(restarted.artifacts).toEqual(completed.artifacts);
    expect(restarted.fusion!.attempts).toEqual(completed.fusion!.attempts);
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openMethodPanel(page, restarted);
    expect(
      captureResearchNativeBoundary(await getDesktopState(page), restarted).activeNativeAtCapture,
    ).toEqual([]);
    expect((await fixture.readMethodJournal()).filter((e) => e.type === "request")).toHaveLength(
      requestCount,
    );
    expect(rendererErrors).toEqual([]);
  } finally {
    try {
      const state = await getDesktopState(page).catch(() => undefined);
      await writeFile(
        test.info().outputPath("method-package-evidence.json"),
        JSON.stringify(
          {
            boundary: METHOD_BOUNDARY,
            profile: fixture.profile,
            workspace: fixture.workspace,
            snapshots,
            lastProject: state?.researchGroups?.projects[0],
            journal: await fixture.readMethodJournal(),
            imageFixtures: fixture.images.map(({ path, sha256, bytes }) => ({
              path,
              sha256,
              bytes: bytes.length,
            })),
            rendererErrors,
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
