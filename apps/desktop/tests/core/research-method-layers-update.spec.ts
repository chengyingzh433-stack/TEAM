import { expect, test, type Page } from "@playwright/test";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import { researchTaskControlDecisionStatus } from "../../contracts/research-task-controls";
import { getDesktopState, openNewThread, type DesktopHarness } from "../helpers/electron-app";
import { captureResearchNativeBoundary } from "../helpers/research-live-evidence";
import {
  AI_SUGGESTION_ID,
  COURSE_CASE_ID,
  METHOD_LAYERS_BOUNDARY,
  METHOD_LAYERS_DECISION,
  METHOD_LAYERS_OPTION,
  METHOD_V2_MARKER,
  UNINDEXED_ADMIN_MARKERS,
  setupResearchMethodLayersFixture,
} from "../helpers/research-method-layers-provider";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const privateRecords = (p: ResearchProject) => ({
  packages: p.methodPackages,
  applications: p.methodApplications,
  opinions: p.methodContentOpinions,
  readings: p.methodImageReadings,
  knowledge: p.knowledge,
  sharedMethod: p.sharedMethod,
  members: p.members.map((member) => ({ role: member.role, ref: member.ref })),
});
async function openDetails(locator: ReturnType<Page["locator"]>) {
  if (!(await locator.evaluate((element) => element.hasAttribute("open"))))
    await locator.locator(":scope > summary").click();
}
async function chooseFiles(harness: DesktopHarness, files: string[]) {
  // Fixture only for the OS chooser result. Import, parse, declarations and adoption remain UI actions.
  await harness.electronApp.evaluate(({ dialog }, filePaths) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths };
    };
  }, files);
}

/**
 * New E preparation only; it must be scheduled after the root's current R/build ownership ends.
 * Existing method-packages Core already covers per-project image/app/opinion gates. This adds
 * cross-project same-pin identity, cache privacy, explicit new-KB/new-project adoption and an
 * actual unfinished-project restart/resume and new native cached read while the original KB is offline.
 * It proves fixture-backed Electron mechanics, not true model judgment, original-data findings,
 * global semantic filtering of arbitrary KB records, or independent human/content C acceptance.
 */
test("method layers and fixed cache survive explicit new-project KB updates without private-record leakage", async () => {
  test.setTimeout(240_000); // Three short local deterministic projects; never expand to hide failure.
  const fixture = await setupResearchMethodLayersFixture();
  let harness = await fixture.launch(),
    page = await harness.firstWindow();
  const snapshots: Record<string, ResearchProject> = {},
    rendererErrors: string[] = [];
  let failure: string | undefined,
    offlineDirectory: string | undefined,
    offlineRestartAt: string | undefined;
  const current = async (id: string) =>
    (await getDesktopState(page)).researchGroups!.projects.find((project) => project.id === id)!;
  const healthy = (p: ResearchProject) => {
    const bad = p.fusion?.attempts.filter((attempt) =>
      ["failed", "unknown"].includes(attempt.state),
    );
    if (bad?.length) throw new Error(`Unexpected native fixture failure: ${JSON.stringify(bad)}`);
  };
  const select = async (p: ResearchProject) => {
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await page
      .locator(`.research-project[data-project-id="${p.id}"] .research-project__name`)
      .click();
  };
  const configure = async (kb: string) => {
    const before = await getDesktopState(page),
      previousProjects = structuredClone(before.researchGroups!.projects),
      selectedProject = previousProjects.find((project) =>
        [project.root, ...project.members.map((member) => member.ref)].some(
          (ref) =>
            ref.workspaceId === before.selectedWorkspaceId &&
            ref.sessionId === before.selectedSessionId,
        ),
      );
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    if (!(await editor.isVisible()))
      await page.getByRole("button", { name: "配置阶段、模型与知识库", exact: true }).click();
    const applyCurrent = editor.getByRole("checkbox", {
      name: "同时用于当前课题的后续运行",
      exact: true,
    });
    if (await applyCurrent.count()) {
      if (await applyCurrent.isChecked()) await applyCurrent.uncheck();
      await expect(applyCurrent).not.toBeChecked();
    }
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(kb);
    await editor.getByLabel("研究材料目录", { exact: true }).fill("");
    const workflow = editor.getByLabel("研究流程版本", { exact: true });
    if (await workflow.count()) {
      await workflow.selectOption("fusion-v2");
    } else {
      // Existing projects retain their workflow. With applyCurrent unchecked this
      // edits the future-project template; hiding the conversion selector is expected.
      expect(
        selectedProject,
        "A hidden workflow selector must belong to an existing fusion project",
      ).toBeTruthy();
      expect(selectedProject?.workflowVersion).toBe("fusion-v2");
      expect(before.researchGroups!.config.workflowVersion).toBe("fusion-v2");
    }
    await editor.getByLabel("研究入口", { exact: true }).selectOption("task");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("task");
    await editor.getByLabel("单项任务类型", { exact: true }).selectOption("design-review");
    await editor
      .getByLabel("单项任务范围", { exact: true })
      .fill(
        "只核查明确合成方案的课程/案例/AI建议层与原始来源、合成数据、真实UI决定的分离；不计算、不声称研究结论。新连接只用于此后新项目。",
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
    const saved = (await getDesktopState(page)).researchGroups!;
    expect(saved.config).toMatchObject({
      workflowVersion: "fusion-v2",
      knowledgeDir: kb,
      entry: "task",
      goal: "task",
      task: { kind: "design-review" },
    });
    for (const prior of previousProjects) {
      const retained = saved.projects.find((project) => project.id === prior.id)!;
      expect(retained.workflowVersion).toBe(prior.workflowVersion);
      expect(retained).toEqual(prior);
    }
  };
  const createProject = async (
    marker: "old" | "peer" | "new",
    kb: string,
    extraSources: boolean,
  ) => {
    await configure(kb);
    await openNewThread(page);
    await page
      .getByLabel("New thread prompt")
      .fill(
        `AC29_PROJECT=${marker} ${METHOD_LAYERS_BOUNDARY} 只审合成方案，实际取得EDU-N02-2-5及递归上下文，保留课程/案例/AI建议层；不把它们称为当前课题论文或观察数据。使用本项目固定KB版本，不改变旧项目。`,
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    let id: string | undefined;
    await expect
      .poll(async () => {
        const p = (await getDesktopState(page)).researchGroups?.projects.find((project) =>
          project.objective.includes(`AC29_PROJECT=${marker}`),
        );
        id = p?.id;
        return p?.status;
      })
      .toBe("paused");
    const created = await current(id!);
    expect(created.workflowVersion).toBe("fusion-v2");
    expect(created.fusion!.attempts).toEqual([]);
    const files = extraSources ? [fixture.design, fixture.paper, fixture.csv] : [fixture.design];
    const panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await chooseFiles(harness, files);
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect
      .poll(async () => (await current(id!)).importedMaterials?.length)
      .toBe(files.length);
    for (const file of files) {
      const name = basename(file),
        material = (await current(id!)).importedMaterials!.find((entry) => entry.name === name)!;
      const detail = panel.locator(`[data-material-id="${material.id}"]`);
      await openDetails(detail);
      const category =
        file === fixture.design ? "design" : file === fixture.paper ? "paper" : "data";
      await detail.getByLabel(`${name} 材料用途`, { exact: true }).selectOption(category);
      await detail
        .getByLabel(`${name} 来源及提供说明`, { exact: true })
        .fill(
          category === "paper"
            ? "真实已取得原文：Yueying Wang (2025), Artificial intelligence in student management systems to enhance academic performance monitoring and intervention, https://www.nature.com/articles/s41598-025-19159-4 。软件验收仅验证来源层与实际读取；不预先确认论文观点，不声称原图/表全核验。"
            : METHOD_LAYERS_BOUNDARY,
        );
      if (category === "paper")
        await detail
          .getByLabel(`${name} 提供文本范围`, { exact: true })
          .selectOption("partial-text");
      if (category === "data") {
        await detail.getByLabel(`${name} 材料性质`, { exact: true }).selectOption("synthetic");
        await detail
          .getByLabel(`${name} 使用依据`, { exact: true })
          .selectOption("user-authorized");
      }
      await detail.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
      await expect
        .poll(async () =>
          (await current(id!)).evidence?.sources.some(
            (source) => source.materialImportId === material.id,
          ),
        )
        .toBe(true);
      await detail.locator(":scope > summary").click();
    }
    await panel.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect.poll(async () => (await current(id!)).entryInventory?.canStart).toBe(true);
    await panel.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    return id!;
  };
  const waitCompleted = async (id: string) => {
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(page),
            p = state.researchGroups!.projects.find((entry) => entry.id === id)!;
          healthy(p);
          return (
            p.status === "completed" &&
            captureResearchNativeBoundary(state, p).activeNativeAtCapture.length === 0
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    return current(id);
  };
  try {
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    const oldId = await createProject("old", fixture.kb, true);
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(page),
            p = state.researchGroups!.projects.find((entry) => entry.id === oldId)!;
          healthy(p);
          return (
            p.methodContentOpinions?.some((opinion) => opinion.verdict === "support") &&
            p.artifacts.some(
              (artifact) => artifact.kind === "stage-verification" && artifact.verdict === "accept",
            ) &&
            p.fusion!.decisionRequests?.some(
              (request) =>
                request.question === METHOD_LAYERS_DECISION &&
                researchTaskControlDecisionStatus(p.fusion!, request.id) === "pending",
            ) &&
            captureResearchNativeBoundary(state, p).activeNativeAtCapture.length === 0
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const old = (snapshots.oldBeforeUpdate = structuredClone(await current(oldId))),
      oldPackage = old.methodPackages![0]!;
    expect(old.status).toBe("running");
    expect(old.methodPackages).toHaveLength(1);
    expect(oldPackage.records.map((record) => record.id).sort()).toEqual(
      ["EDU-N02-2-5", "EDU-N02-2-4", COURSE_CASE_ID, AI_SUGGESTION_ID].sort(),
    );
    expect(
      oldPackage.records.find((record) => record.id === COURSE_CASE_ID)!.contentLayers,
    ).toEqual(["course_case"]);
    expect(
      oldPackage.records.find((record) => record.id === AI_SUGGESTION_ID)!.contentLayers,
    ).toEqual(["ai_suggestion"]);
    expect(old.evidence!.sources.map((source) => source.kind).sort()).toEqual([
      "dataset",
      "design",
      "paper",
    ]);
    expect(old.evidence!.datasets).toHaveLength(1);
    expect(old.evidence!.datasets[0]!).toMatchObject({
      dataKind: "synthetic",
      permission: "user-authorized",
    });
    expect(old.analyses ?? []).toEqual([]);
    expect(old.analysisRegistry?.runs ?? []).toEqual([]);
    for (const record of oldPackage.records)
      expect(old.evidence!.sources.some((source) => source.id === record.id)).toBe(false);
    const paperImport = old.importedMaterials!.find(
      (material) => material.name === basename(fixture.paper),
    )!;
    expect(paperImport.sha256).toBe(fixture.paperSha256);
    expect(sha(await readFile(paperImport.original))).toBe(fixture.paperSha256);
    const cacheDirectory = join(
        fixture.workspace,
        ".lancer",
        "research-method-packages",
        oldPackage.packageSha256,
      ),
      cacheFile = join(cacheDirectory, "package.json");
    const oldCache = await readFile(cacheFile),
      oldCacheImage = await readFile(join(cacheDirectory, "images", fixture.images[0]!.path));
    const oldKnowledge = await readFile(fixture.index);
    expect(sha(oldKnowledge)).toBe(old.knowledge.sha256);
    expect(sha(oldCacheImage)).toBe(fixture.images[0]!.sha256);
    expect(
      old.methodPackageUses!.filter((use) => use.packageId === oldPackage.id).length,
    ).toBeGreaterThanOrEqual(2);
    const panel = page.getByTestId("research-method-packages");
    await openDetails(panel);
    const pkg = panel.locator(`[data-method-package-id="${oldPackage.id}"]`);
    await openDetails(pkg);
    const fixed = pkg
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^固定版本与必要上下文$/ }) })
      .first();
    await openDetails(fixed);
    for (const id of [COURSE_CASE_ID, AI_SUGGESTION_ID])
      await openDetails(
        fixed
          .locator("details")
          .filter({ has: page.locator("summary", { hasText: id }) })
          .first(),
      );
    await expect(panel).toContainText("课程知识、原始研究证据和本课题决定分别保存");
    await expect(pkg).toContainText("course_case");
    await expect(pkg).toContainText("ai_suggestion");
    const evidence = page
      .getByRole("region", { name: "教育研究课题组", exact: true })
      .locator("details")
      .filter({ has: page.locator("summary", { hasText: /^研究原文与数据/ }) })
      .first();
    await openDetails(evidence);
    await expect(evidence).toContainText("AC29-real-paper-SMS2025.txt");
    await expect(evidence).toContainText("合成演练数据");
    await expect(evidence).not.toContainText(COURSE_CASE_ID);
    await expect(evidence).not.toContainText(AI_SUGGESTION_ID);
    await page.screenshot({
      path: test.info().outputPath("old-project-separated-method-paper-data-layers.png"),
    });

    const peerId = await createProject("peer", fixture.kb, false),
      peer = (snapshots.peerSamePin = structuredClone(await waitCompleted(peerId)));
    expect(peer.methodPackages).toHaveLength(1);
    expect(peer.methodPackages![0]).toEqual(oldPackage);
    expect(peer.methodApplications!.every((application) => application.projectId === peer.id)).toBe(
      true,
    );
    expect(peer.methodContentOpinions!.every((opinion) => opinion.projectId === peer.id)).toBe(
      true,
    );
    expect(
      peer.methodApplications!.some((application) =>
        old.methodApplications!.some((prior) => prior.id === application.id),
      ),
    ).toBe(false);
    expect(
      peer.methodContentOpinions!.some((opinion) =>
        old.methodContentOpinions!.some((prior) => prior.id === opinion.id),
      ),
    ).toBe(false);
    expect(peer.fusion!.decisions).toEqual([]);
    expect(peer.evidence!.datasets).toEqual([]);
    expect(peer.evidence!.sources).toHaveLength(1);
    expect(await readFile(cacheFile)).toEqual(oldCache);
    expect(await readFile(fixture.index)).toEqual(oldKnowledge);
    expect(privateRecords(await current(oldId))).toEqual(privateRecords(old));
    const journal = await fixture.readMethodJournal();
    const peerNativeRuns = new Set(peer.methodPackageUses!.map((use) => use.nativeRunId));
    expect(
      journal.some(
        (entry) =>
          entry.type === "result" &&
          peerNativeRuns.has(entry.nativeRunId) &&
          entry.args?.operation === "method-package" &&
          /"reused"\s*:\s*true/.test(entry.text ?? ""),
      ),
    ).toBe(true);

    // The new KB is a separate fixture resource. Its explicit connection is performed below in UI.
    offlineDirectory = `${fixture.kb}-offline-retained`;
    await rename(fixture.kb, offlineDirectory);
    await expect(stat(fixture.kb)).rejects.toMatchObject({ code: "ENOENT" });
    const newId = await createProject("new", fixture.newerKb, false),
      newer = (snapshots.newExplicitKb = structuredClone(await waitCompleted(newId)));
    expect(newer.knowledge.directory).toBe(fixture.newerKb);
    expect(newer.knowledge.sha256).not.toBe(old.knowledge.sha256);
    expect(newer.methodPackages![0]!.id).not.toBe(oldPackage.id);
    expect(newer.methodPackages![0]!.packageSha256).not.toBe(oldPackage.packageSha256);
    expect(JSON.stringify(newer.methodPackages)).toContain(METHOD_V2_MARKER);
    expect(JSON.stringify(old.methodPackages)).not.toContain(METHOD_V2_MARKER);
    expect(privateRecords(await current(oldId))).toEqual(privateRecords(old));
    expect(privateRecords(await current(peerId))).toEqual(privateRecords(peer));
    expect(await readFile(cacheFile)).toEqual(oldCache);
    expect(await readFile(join(cacheDirectory, "images", fixture.images[0]!.path))).toEqual(
      oldCacheImage,
    );

    const pendingBeforeRestart = (snapshots.oldPendingBeforeOfflineRestart = structuredClone(
      await current(oldId),
    ));
    const originalRequest = pendingBeforeRestart.fusion!.decisionRequests!.find(
      (entry) => entry.question === METHOD_LAYERS_DECISION,
    )!;
    expect(
      researchTaskControlDecisionStatus(pendingBeforeRestart.fusion!, originalRequest.id),
    ).toBe("pending");
    expect(pendingBeforeRestart.fusion!.decisions).toEqual([]);
    expect(
      pendingBeforeRestart.artifacts.some(
        (artifact) => artifact.kind === "stage-review" && artifact.verdict === "accept",
      ),
    ).toBe(false);
    const beforeRestartState = await getDesktopState(page);
    expect(
      captureResearchNativeBoundary(beforeRestartState, pendingBeforeRestart).activeNativeAtCapture,
    ).toEqual([]);
    // Restart before answering the real pending condition. An in-memory KB adapter
    // cannot make this pass; the original directory remains renamed/offline.
    await harness.close();
    offlineRestartAt = new Date().toISOString();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    const offlineRestarted = (snapshots.oldOfflineRestartedBeforeResume = structuredClone(
      await current(oldId),
    ));
    expect(offlineRestarted.status).toBe("paused");
    expect(privateRecords(offlineRestarted)).toEqual(privateRecords(old));
    expect(privateRecords(await current(peerId))).toEqual(privateRecords(peer));
    expect(privateRecords(await current(newId))).toEqual(privateRecords(newer));
    expect(researchTaskControlDecisionStatus(offlineRestarted.fusion!, originalRequest.id)).toBe(
      "pending",
    );
    expect(offlineRestarted.fusion!.decisions).toEqual([]);
    await expect(stat(fixture.kb)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(cacheFile)).toEqual(oldCache);
    expect(await readFile(join(cacheDirectory, "images", fixture.images[0]!.path))).toEqual(
      oldCacheImage,
    );
    await select(offlineRestarted);
    await page
      .getByRole("region", { name: "教育研究课题组", exact: true })
      .getByRole("button", { name: "恢复未完成工作", exact: true })
      .click();
    await expect.poll(async () => (await current(oldId)).status).toBe("running");
    const resumed = (snapshots.oldOfflineResumedBeforeDecision = structuredClone(
      await current(oldId),
    ));
    healthy(resumed);
    expect(resumed.knowledge).toEqual(old.knowledge);
    expect(resumed.methodPackages).toEqual(old.methodPackages);
    expect(resumed.fusion!.decisions).toEqual([]);
    expect(researchTaskControlDecisionStatus(resumed.fusion!, originalRequest.id)).toBe("pending");
    expect(
      resumed.artifacts.some(
        (artifact) => artifact.kind === "stage-review" && artifact.verdict === "accept",
      ),
    ).toBe(false);
    const controls = page.getByTestId("research-task-controls");
    await openDetails(controls);
    const request = (await current(oldId)).fusion!.decisionRequests!.find(
      (entry) => entry.question === METHOD_LAYERS_DECISION,
    )!;
    expect(request).toEqual(originalRequest);
    const card = controls.locator(`[data-decision-id="${request.id}"]`);
    await openDetails(card);
    expect((await current(oldId)).fusion!.decisions).toEqual([]);
    await card.getByLabel("我的选择", { exact: true }).selectOption(METHOD_LAYERS_OPTION);
    const userDecisionText =
      "AC29_UI_DECISION_PRIVATE：只继续旧项目已固定缓存，保持其旧课程pin；这是软件流程的真实UI选择，不代表真实量表核验、研究伦理或人类学术审阅。";
    await card.getByLabel("补充说明（选填）").fill(userDecisionText);
    await card.getByRole("button", { name: "提交我的决定", exact: true }).click();
    const retained = (snapshots.oldCompletedWithOfflineCache = structuredClone(
      await waitCompleted(oldId),
    ));
    expect(privateRecords(retained)).toEqual(privateRecords(old));
    expect(retained.methodAdjudications![0]!.actor.kind).toBe("model");
    expect(retained.fusion!.decisions).toHaveLength(1);
    expect(retained.fusion!.decisions[0]).toMatchObject({
      actor: "user",
      requestId: request.id,
      optionId: METHOD_LAYERS_OPTION,
      outcome: "confirmed",
      text: userDecisionText,
    });
    const mentorUse = retained.methodPackageUses!.filter((use) => use.role === "mentor").at(-1)!;
    expect(mentorUse.packageId).toBe(oldPackage.id);
    expect(mentorUse.packageSha256).toBe(oldPackage.packageSha256);
    expect(
      old.fusion!.attempts.some((attempt) => attempt.nativeRunId === mentorUse.nativeRunId),
    ).toBe(false);
    expect(Date.parse(mentorUse.at)).toBeGreaterThanOrEqual(Date.parse(offlineRestartAt));
    const offlineRead = retained.methodImageReceipts!.find(
      (receipt) =>
        receipt.nativeRunId === mentorUse.nativeRunId && receipt.actor.id === "model:mentor",
    )!;
    expect(offlineRead).toMatchObject({
      packageId: oldPackage.id,
      imageSha256: fixture.images[0]!.sha256,
    });
    const offlineJournal = (await fixture.readMethodJournal()).filter(
      (entry) =>
        entry.type === "result" &&
        entry.role === "mentor" &&
        !entry.isError &&
        entry.attemptId === mentorUse.attemptId &&
        entry.nativeRunId === mentorUse.nativeRunId &&
        entry.callId.includes(mentorUse.attemptId),
    );
    const cachedPackageResult = offlineJournal.find(
      (entry) =>
        entry.args?.operation === "method-package" && entry.args.packageId === oldPackage.id,
    );
    expect(cachedPackageResult).toBeTruthy();
    expect(cachedPackageResult!.text).toContain(oldPackage.id);
    expect(cachedPackageResult!.text).toContain(oldPackage.packageSha256);
    const cachedImageResult = offlineJournal.find(
      (entry) =>
        entry.args?.operation === "method-read-image" &&
        entry.args.packageId === oldPackage.id &&
        entry.args.path === fixture.images[0]!.path,
    );
    expect(cachedImageResult).toBeTruthy();
    expect(cachedImageResult!.images).toEqual([
      {
        sha256: fixture.images[0]!.sha256,
        bytes: fixture.images[0]!.bytes.length,
        mimeType: "image/png",
      },
    ]);
    expect(cachedImageResult!.textOrDetailsContainsImageData).toBe(false);
    expect(retained.knowledge).toEqual(old.knowledge);
    expect(await readFile(cacheFile)).toEqual(oldCache);
    expect(await readFile(join(cacheDirectory, "images", fixture.images[0]!.path))).toEqual(
      oldCacheImage,
    );
    await expect(stat(fixture.kb)).rejects.toMatchObject({ code: "ENOENT" });
    const shared = oldCache.toString();
    for (const p of [old, peer, newer, retained]) {
      for (const value of [
        p.id,
        ...p.members.map((member) => member.ref.sessionId),
        ...(p.methodApplications ?? []).flatMap((application) => [
          application.id,
          application.methodSelection,
        ]),
        ...(p.methodContentOpinions ?? []).flatMap((opinion) => [opinion.id, opinion.note]),
      ])
        expect(shared).not.toContain(value);
    }
    expect(shared).not.toContain(userDecisionText);
    expect(shared).not.toContain("PRIVATE-APPLICATION-");
    expect(shared).not.toContain("AC29-new-synthetic-data.csv");
    expect(shared).not.toContain("AC29-real-paper-SMS2025.txt");
    for (const marker of UNINDEXED_ADMIN_MARKERS) expect(shared).not.toContain(marker);
    await expect(card).toContainText(userDecisionText);
    await page.screenshot({
      path: test.info().outputPath("old-project-offline-cache-and-separate-user-decision.png"),
    });
    const finalPrivate = Object.fromEntries(
      (await getDesktopState(page)).researchGroups!.projects.map((p) => [p.id, privateRecords(p)]),
    );
    await harness.close();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const restarted = await getDesktopState(page);
    expect(
      Object.fromEntries(restarted.researchGroups!.projects.map((p) => [p.id, privateRecords(p)])),
    ).toEqual(finalPrivate);
    for (const p of restarted.researchGroups!.projects)
      expect(captureResearchNativeBoundary(restarted, p).activeNativeAtCapture).toEqual([]);
    expect(rendererErrors).toEqual([]);
    snapshots.oldRestarted = restarted.researchGroups!.projects.find((p) => p.id === oldId)!;
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    try {
      await writeFile(
        test.info().outputPath("method-layers-update-evidence.json"),
        JSON.stringify(
          {
            boundary: METHOD_LAYERS_BOUNDARY,
            result: failure ? "failed" : "fixture-E-awaiting-independent-C",
            failure,
            snapshots,
            lastState: await getDesktopState(page).catch(() => undefined),
            rendererErrors,
            originalKb: fixture.kb,
            offlineRetainedKb: offlineDirectory,
            offlineRestartAt,
            explicitlyConnectedNewKb: fixture.newerKb,
            paperSha256: fixture.paperSha256,
            journal: await fixture.readMethodJournal(),
            limitations: [
              "No external-model R or independent C is performed by this fixture",
              "Data is explicitly synthetic, not original observed CSV",
              "Only unindexed fixture administrative files are excluded; this is not a semantic filter for arbitrary indexed content",
              "New KB connection plus new project is the update boundary; no old project pin is rewritten",
              "Native chooser interaction is not exercised; picker result is a fixture",
            ],
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
