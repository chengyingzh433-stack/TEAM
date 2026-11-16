import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { RESEARCH_SYNTHESIS_COLUMNS } from "../../contracts/research-synthesis";
import { researchTaskControlDecisionStatus } from "../../contracts/research-task-controls";
import { readPinnedResearchFile, researchHash } from "../../electron/research-group/materials";
import {
  assertResearchSynthesisAcceptance,
  validateResearchSynthesisProject,
} from "../../electron/research-group/synthesis-tools";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import {
  COUNTEREVIDENCE_AFTER,
  COUNTEREVIDENCE_BEFORE,
  COUNTEREVIDENCE_BOUNDARY,
  COUNTEREVIDENCE_CHECKPOINT,
  COUNTEREVIDENCE_OPTION,
  COUNTEREVIDENCE_SOURCES,
  setupResearchCounterevidenceFixture,
} from "../helpers/research-counterevidence-provider";
import {
  captureResearchNativeBoundary,
  researchNativeCallLedger,
} from "../helpers/research-live-evidence";

async function openDetails(locator: ReturnType<Page["getByTestId"]>) {
  if (!(await locator.evaluate((element) => element.hasAttribute("open"))))
    await locator.locator(":scope > summary").click();
}

function assertBoundedRoute(project: ResearchProject) {
  expect(project.entry).toBe("materials");
  expect(project.goal).toBe("design");
  for (const task of project.fusion!.tasks) {
    if (["reading", "synthesis", "design"].includes(task.stage)) continue;
    // An empty materials entry retains cancelled, never-dispatched placeholders
    // when ordinary inventory later locates S3. They are not completed research.
    expect(task.state).toBe("cancelled");
    expect(task.currentArtifactId).toBeUndefined();
    expect(project.fusion!.attempts.filter((attempt) => attempt.taskId === task.id)).toEqual([]);
    expect(project.fusion!.artifacts.filter((artifact) => artifact.taskId === task.id)).toEqual([]);
  }
  for (const artifact of project.artifacts)
    expect(["reading", "synthesis", "design"]).toContain(artifact.stage);
  for (const event of project.events.filter((event) =>
    ["started", "published"].includes(event.type),
  ))
    expect(["reading", "synthesis", "design"]).toContain(event.stage);
  expect(project.evidence!.datasets).toEqual([]);
  expect(project.analyses ?? []).toEqual([]);
  expect(project.finalPaper).toBeUndefined();
}

// E only: normal renderer actions, local deterministic provider, real Pi tools and repository.
// Nothing seeds an accepted artifact, task graph, native state or research result.
test("a UI-adopted synthetic paper reopens only its accepted gap and persists the A B mentor counterevidence chain", async () => {
  test.setTimeout(180_000);
  const fixture = await setupResearchCounterevidenceFixture();
  let harness = await fixture.launch(),
    page = await harness.firstWindow();
  const snapshots: Record<string, ResearchProject> = {},
    rendererErrors: string[] = [],
    nativeDiagnostics: string[] = [];
  const originalArtifactHashes: Record<string, string> = {};
  let lastState: DesktopAppState | undefined, failure: string | undefined;
  const diagnostics = () => {
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    harness.electronApp
      .process()
      .stderr?.on("data", (chunk: Buffer) => nativeDiagnostics.push(chunk.toString("utf8")));
  };
  diagnostics();
  const current = async () => {
    lastState = await getDesktopState(page);
    if (lastState.researchGroups?.error) throw new Error(lastState.researchGroups.error);
    return lastState.researchGroups!.projects[0]!;
  };
  const healthy = async () => {
    const project = await current();
    const failed = project.fusion!.attempts.filter((attempt) =>
      ["failed", "unknown", "cancelled"].includes(attempt.state),
    );
    if (failed.length || project.events.some((event) => event.type === "error"))
      throw new Error(
        `Actual deterministic Pi chain failed: ${JSON.stringify({ failed, error: project.error })}`,
      );
    return project;
  };
  const pendingCheckpoint = (project: ResearchProject) =>
    project.fusion!.decisionRequests?.find(
      (request) =>
        request.question === COUNTEREVIDENCE_CHECKPOINT &&
        researchTaskControlDecisionStatus(project.fusion!, request.id) === "pending",
    );
  const allSettled = (state: DesktopAppState, project: ResearchProject) => {
    const graph = project.fusion!;
    return (
      captureResearchNativeBoundary(state, project).activeNativeAtCapture.length === 0 &&
      graph.attempts.every(
        (attempt) => attempt.state === "succeeded" && !!attempt.finishedAt && !!attempt.nativeRunId,
      ) &&
      graph.tasks
        .filter((task) => task.stage === "reading")
        .every(
          (task) =>
            task.state === "completed" &&
            !task.blockers.some((blocker) => blocker.kind === "attempt") &&
            task.continuations.every((continuation) => !!continuation.attemptId),
        )
    );
  };
  const importPaper = async (
    file: string,
    expectedCount: number,
    beforeAdopt?: () => Promise<void>,
  ) => {
    // The picker result is the sole OS-boundary fixture. Import, declaration,
    // impact preview and adoption use the actual renderer and application code.
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [file],
    );
    const group = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await group.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(expectedCount);
    const name = basename(file),
      material = (await current()).importedMaterials!.find((entry) => entry.name === name)!;
    const card = group.locator(`[data-material-id="${material.id}"]`);
    await openDetails(card);
    await card.getByLabel(`${name} 材料用途`, { exact: true }).selectOption("paper");
    await card
      .getByLabel(`${name} 来源及提供说明`, { exact: true })
      .fill(
        `${COUNTEREVIDENCE_BOUNDARY} 测试操作者提供此新编文字供软件验收；未知作者和年份不补造。原文、提供声明、模型解释和UI顺序选择分别保留。`,
      );
    await card.getByLabel(`${name} 提供文本范围`, { exact: true }).selectOption("partial-text");
    await beforeAdopt?.();
    await card.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect
      .poll(async () =>
        (await current()).evidence!.sources.some(
          (source) => source.materialImportId === material.id,
        ),
      )
      .toBe(true);
    await card.locator(":scope > summary").click();
    const adopted = await current(),
      source = adopted.evidence!.sources.find((entry) => entry.materialImportId === material.id)!;
    expect(material.sha256).toBe(researchHash(await readFile(file)));
    expect(researchHash(await readFile(material.original))).toBe(material.sha256);
    expect(researchHash(await readFile(source.file))).toBe(source.sha256);
    return { material, source };
  };
  try {
    await writeFile(
      test.info().outputPath("run-plan.json"),
      JSON.stringify(
        {
          boundary: COUNTEREVIDENCE_BOUNDARY,
          profile: fixture.profile,
          workspace: fixture.workspace,
          timeoutMs: 180_000,
          entry: "materials",
          goal: "design",
          stages: ["reading", "synthesis", "design"],
          unexecutedStages: ["scan", "question", "search", "analysis", "writing", "audit"],
          inputs: Object.fromEntries(
            Object.entries(COUNTEREVIDENCE_SOURCES).map(([key, body]) => [
              key,
              { sha256: researchHash(body), bytes: Buffer.byteLength(body), synthetic: true },
            ]),
          ),
          pickerBoundary:
            "OS chooser result fixture; import and adoption are actual ordinary UI actions",
        },
        null,
        2,
      ),
    );
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
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("design");
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
        `${COUNTEREVIDENCE_BOUNDARY} 本轮问题是合成甲镇两校缺勤与数学等级关系的已提供材料范围。从materials入口执行S3→S4→S5；S1/S2未执行。先接受真实工具形成的初始七列矩阵与pending候选缺口，后由操作者普通UI加入第二篇合成paper，B本人读取并声明明确反证，A新稿收窄，B重新核查、导师处理。只给有限方案，不扩展全篇或统计计算。`,
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
      .toBe("paused");
    const empty = (snapshots.emptyProject = await current());
    expect(empty.artifacts).toEqual([]);
    expect(empty.fusion!.attempts).toEqual([]);
    expect(empty.evidence!.sources).toEqual([]);
    const initial = await importPaper(fixture.initial, 1);
    const group = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await group.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect
      .poll(async () => (await current()).entryInventory?.firstMissingStage)
      .toBe("reading");
    const inventory = (snapshots.actualEntry = await current());
    expect(inventory.entryInventory!.canStart).toBe(true);
    expect(inventory.artifacts).toEqual([]);
    expect(inventory.evidence!.sources.map((source) => source.id)).toEqual([initial.source.id]);
    expect(researchExecutionRoute(inventory, inventory.entryInventory)).toMatchObject({
      startStage: "reading",
      endStage: "design",
      stageIds: ["reading", "synthesis", "design"],
      needsInventory: false,
      blockedReasons: [],
    });
    await group.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    await expect
      .poll(
        async () => {
          const project = await healthy();
          const ready =
            !!pendingCheckpoint(project) &&
            project.synthesis?.gaps.some(
              (gap) =>
                gap.id === "ac24-gap-before" &&
                project.fusion!.artifacts.some(
                  (artifact) =>
                    artifact.id === gap.artifactId && artifact.reviewState === "accepted",
                ),
            ) &&
            allSettled(lastState!, project);
          if (ready) snapshots.acceptedBeforeNewPaper = structuredClone(project);
          return ready;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const baseline = snapshots.acceptedBeforeNewPaper!;
    assertBoundedRoute(baseline);
    expect(baseline.currentStage).toBe("design");
    expect(baseline.events.find((event) => event.type === "started")?.stage).toBe("reading");
    expect(baseline.evidence!.sources).toHaveLength(1);
    expect(baseline.importedMaterials).toHaveLength(1);
    expect(baseline.synthesis!.counterevidence).toEqual([]);
    const oldGap = baseline.synthesis!.gaps.find((gap) => gap.id === "ac24-gap-before")!,
      oldMatrix = baseline.synthesis!.matrices.find(
        (matrix) => matrix.id === "ac24-matrix-before",
      )!,
      oldDraft = baseline.artifacts.find((artifact) => artifact.id === oldGap.artifactId)!;
    expect(oldGap).toMatchObject({
      statement: COUNTEREVIDENCE_BEFORE,
      state: "pending-validation",
      searchPins: [],
      host: { owner: { role: "lead", stage: "synthesis" } },
    });
    expect(Object.keys(oldMatrix.rows[0]!.cells).sort()).toEqual(
      [...RESEARCH_SYNTHESIS_COLUMNS].sort(),
    );
    expect(oldDraft.kind).toBe("stage-draft");
    expect(oldDraft.content).toContain(COUNTEREVIDENCE_BEFORE);
    for (const artifact of baseline.artifacts) {
      const file = join(
        baseline.workspacePath,
        ".lancer",
        "research-groups",
        baseline.id,
        `${artifact.id}.md`,
      );
      originalArtifactHashes[file] = researchHash(await readFile(file));
    }
    expect(
      baseline.artifacts.some(
        (artifact) =>
          artifact.stage === "synthesis" &&
          ["stage-critique", "stage-revision"].includes(artifact.kind),
      ),
    ).toBe(false);
    await assertResearchSynthesisAcceptance(baseline, oldDraft.id);
    await page.screenshot({ path: test.info().outputPath("accepted-gap-before-new-paper.png") });

    const adopted = await importPaper(fixture.added, 2, async () => {
      await expect
        .poll(
          async () => {
            const project = await healthy();
            if (!allSettled(lastState!, project)) return false;
            expect(pendingCheckpoint(project)).toBeDefined();
            expect(project.evidence!.sources).toHaveLength(1);
            expect(project.evidence!.sources).toEqual(baseline.evidence!.sources);
            expect(project.synthesis!.counterevidence).toEqual([]);
            expect(project.synthesis!.gaps.find((gap) => gap.id === oldGap.id)).toEqual(oldGap);
            expect(
              project.fusion!.artifacts.find((artifact) => artifact.id === oldDraft.id)!
                .reviewState,
            ).toBe("accepted");
            expect(project.artifacts).toEqual(baseline.artifacts);
            snapshots.beforeNewPaperAdoption = structuredClone(project);
            return true;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    });
    const beforeAdoption = snapshots.beforeNewPaperAdoption!;
    const afterAdoption = (snapshots.newPaperAdopted = await current());
    expect(afterAdoption.revision).toBe(baseline.revision);
    if (!afterAdoption.synthesis?.counterevidence.length)
      expect(
        afterAdoption.fusion!.artifacts.find((artifact) => artifact.id === oldDraft.id)!
          .reviewState,
      ).toBe("accepted");
    await expect
      .poll(async () => (await healthy()).synthesis?.counterevidence.length, { timeout: 30_000 })
      .toBe(1);
    const reopened = (snapshots.counterevidenceReopened = await current()),
      counter = reopened.synthesis!.counterevidence[0]!;
    expect(counter).toMatchObject({
      id: "ac24-counter",
      gapIds: [oldGap.id],
      materialChange: true,
      source: { sourceId: adopted.source.id, sourceSha256: adopted.source.sha256 },
      host: { owner: { role: "reviewer", stage: "design" } },
    });
    expect(counter.target).toEqual(oldGap.draft);
    expect(counter.source.exactText).toContain(COUNTEREVIDENCE_SOURCES.added);
    expect(counter.impact.directTaskIds).toEqual([oldGap.draft.taskId]);
    expect(counter.impact.affectedTaskIds.length).toBeGreaterThan(1);
    expect(
      reopened.fusion!.artifacts.find((artifact) => artifact.id === oldDraft.id)!.reviewState,
    ).not.toBe("accepted");
    const checkpoint = pendingCheckpoint(reopened)!;
    expect(checkpoint).toBeDefined();
    const controls = page.getByTestId("research-task-controls");
    await openDetails(controls);
    const decisionCard = controls.locator(`[data-decision-id="${checkpoint.id}"]`);
    await openDetails(decisionCard);
    await decisionCard.getByLabel("我的选择", { exact: true }).selectOption(COUNTEREVIDENCE_OPTION);
    await decisionCard
      .getByLabel("补充说明（选填）")
      .fill(
        "新增合成论文已普通UI采用。此操作只解除软件验收的材料先后顺序条件，不接受模型结论，不改变研究对象，不授权真实研究或采集。",
      );
    await decisionCard.getByRole("button", { name: "提交我的决定", exact: true }).click();
    await expect
      .poll(
        async () => {
          const project = await healthy();
          return (
            project.status === "completed" &&
            captureResearchNativeBoundary(lastState!, project).activeNativeAtCapture.length === 0 &&
            project.fusion!.attempts.every(
              (attempt) => attempt.state === "succeeded" && !!attempt.finishedAt,
            )
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const final = (snapshots.completed = await current());
    assertBoundedRoute(final);
    validateResearchSynthesisProject(final);
    expect(final.currentStage).toBe("design");
    expect(final.revision).toBe(baseline.revision);
    expect(final.synthesis!.counterevidence).toHaveLength(1);
    expect(final.synthesis!.responses).toHaveLength(1);
    expect(final.synthesis!.reviews).toHaveLength(1);
    expect(final.synthesis!.resolutions).toHaveLength(1);
    expect(final.synthesis!.gaps.find((gap) => gap.id === oldGap.id)).toEqual(oldGap);
    expect(final.synthesis!.matrices.find((matrix) => matrix.id === oldMatrix.id)).toEqual(
      oldMatrix,
    );
    expect(final.artifacts.find((artifact) => artifact.id === oldDraft.id)).toEqual(oldDraft);
    const response = final.synthesis!.responses[0]!,
      review = final.synthesis!.reviews[0]!,
      resolution = final.synthesis!.resolutions[0]!,
      newGap = final.synthesis!.gaps.find((gap) => gap.id === "ac24-gap-after")!,
      newDraft = final.artifacts.find((artifact) => artifact.id === response.artifactId)!;
    expect(newDraft.id).not.toBe(oldDraft.id);
    expect(newDraft.content).toContain(COUNTEREVIDENCE_AFTER);
    expect(newDraft.content).not.toContain(COUNTEREVIDENCE_BEFORE);
    expect(response).toMatchObject({
      id: "ac24-response",
      counterevidenceId: counter.id,
      gapReplacements: [{ beforeId: oldGap.id, afterId: newGap.id }],
      host: { owner: { role: "lead", stage: "synthesis" } },
    });
    expect(response.exactText).toBe(newDraft.content.slice(response.start, response.end));
    expect(response.exactText).toBe(COUNTEREVIDENCE_AFTER);
    expect(newGap).toMatchObject({
      artifactId: newDraft.id,
      supersedesId: oldGap.id,
      state: "weakened-or-rejected",
      statement: COUNTEREVIDENCE_AFTER,
    });
    expect(
      final.synthesis!.matrices.find((matrix) => matrix.artifactId === newDraft.id),
    ).toMatchObject({ supersedesId: oldMatrix.id });
    expect(response.draft.taskVersion).toBeGreaterThan(oldGap.draft.taskVersion);
    expect(review).toMatchObject({
      responseId: response.id,
      conclusion: "addressed",
      host: { owner: { role: "reviewer", stage: "synthesis" } },
    });
    expect(resolution).toMatchObject({
      reviewId: review.id,
      decision: "close",
      direction: "narrow",
      host: { owner: { role: "mentor", stage: "synthesis" } },
    });
    expect(
      final.fusion!.artifacts.find((artifact) => artifact.id === newDraft.id)!.reviewState,
    ).toBe("accepted");
    for (const role of ["reviewer", "mentor"])
      expect(
        final.methodProgramChecks?.some(
          (check) =>
            check.role === role &&
            check.target?.artifactId === newDraft.id &&
            check.result === "passed-at-snapshot",
        ),
      ).toBe(true);
    expect(
      final.artifacts.some(
        (artifact) =>
          artifact.stage === "synthesis" &&
          artifact.kind === "stage-review" &&
          artifact.verdict === "accept" &&
          artifact.refs.includes(newDraft.id) &&
          Date.parse(artifact.createdAt) > Date.parse(resolution.host.at),
      ),
    ).toBe(true);
    await assertResearchSynthesisAcceptance(final, newDraft.id);
    const unrelated = beforeAdoption.fusion!.tasks.filter((task) => task.stage === "reading");
    expect(unrelated.length).toBeGreaterThan(0);
    for (const task of unrelated) {
      expect(counter.impact.affectedTaskIds).not.toContain(task.id);
      expect(final.fusion!.tasks.find((entry) => entry.id === task.id)).toEqual(task);
      expect(final.fusion!.artifacts.filter((artifact) => artifact.taskId === task.id)).toEqual(
        beforeAdoption.fusion!.artifacts.filter((artifact) => artifact.taskId === task.id),
      );
    }
    for (const taskId of counter.impact.affectedTaskIds) {
      const beforeTask = beforeAdoption.fusion!.tasks.find((task) => task.id === taskId)!;
      expect(final.fusion!.tasks.find((task) => task.id === taskId)!.inputVersion).toBeGreaterThan(
        beforeTask.inputVersion,
      );
    }
    const bindings = [response, review, resolution];
    for (const record of bindings) {
      const owner = record.host.owner,
        attempt = final.fusion!.attempts.find((entry) => entry.id === owner.attemptId)!;
      expect(attempt).toMatchObject({
        taskId: owner.taskId,
        taskVersion: owner.taskVersion,
        nativeRunId: owner.nativeRunId,
        state: "succeeded",
        model: owner.model,
      });
      expect(record.source.sourceSha256).toBe(adopted.source.sha256);
      for (const readId of record.source.readIds) {
        const read = final.synthesis!.reads.find((entry) => entry.id === readId)!;
        expect(read.owner).toMatchObject({
          role: owner.role,
          attemptId: owner.attemptId,
          nativeRunId: owner.nativeRunId,
        });
      }
      expect(
        final.events.some(
          (event) =>
            event.type === "read" &&
            event.role === owner.role &&
            event.runId === owner.nativeRunId &&
            event.artifactId === newDraft.id &&
            Date.parse(event.at) < Date.parse(record.host.at),
        ),
      ).toBe(true);
    }
    const tools = await fixture.readCounterevidenceJournal();
    expect(tools.filter((event) => event.type === "failure" || event.error)).toEqual([]);
    const initialA = tools.find(
        (event) =>
          event.type === "tool-result" &&
          event.args?.operation === "publish" &&
          event.args.kind === "stage-draft" &&
          (event.result as { id?: string })?.id === oldDraft.id,
      )!,
      initialB = tools.find(
        (event) =>
          event.type === "tool-result" &&
          event.role === "reviewer" &&
          event.taskId === "v1:synthesis:reviewer" &&
          event.args?.operation === "publish" &&
          event.args.kind === "stage-risk",
      )!;
    expect(initialA).toBeDefined();
    expect(initialB).toBeDefined();
    for (const independent of [initialA, initialB])
      expect(
        tools
          .slice(0, tools.indexOf(independent))
          .filter(
            (event) =>
              event.type === "tool-result" &&
              event.attemptId === independent.attemptId &&
              event.args?.operation === "read",
          )
          .filter((event) =>
            final.artifacts.some(
              (artifact) =>
                artifact.id === event.args!.artifactId &&
                artifact.stage === "synthesis" &&
                ["lead", "reviewer"].includes(artifact.role) &&
                artifact.role !== independent.role,
            ),
          ),
      ).toEqual([]);
    for (const role of ["lead", "reviewer", "mentor"])
      expect(
        tools.some(
          (event) =>
            event.type === "tool-result" &&
            event.role === role &&
            event.args?.operation === "source-read" &&
            event.args.sourceId === adopted.source.id,
        ),
      ).toBe(true);
    const native = await researchNativeCallLedger(fixture.profile, final);
    expect(
      native
        .flatMap((member) => member.calls)
        .filter((call) => call.name !== "research_group" || call.isError),
    ).toEqual([]);
    for (const operation of [
      "synthesis-matrix",
      "synthesis-gap",
      "synthesis-counterevidence",
      "synthesis-respond",
      "synthesis-review",
      "synthesis-resolve",
    ])
      expect(
        native.some((member) =>
          member.calls.some((call) => call.operation === operation && !call.isError),
        ),
      ).toBe(true);
    expect(await readPinnedResearchFile(adopted.source)).toContain(COUNTEREVIDENCE_SOURCES.added);
    expect(researchHash(await readFile(fixture.initial))).toBe(
      researchHash(COUNTEREVIDENCE_SOURCES.initial),
    );
    expect(researchHash(await readFile(fixture.added))).toBe(
      researchHash(COUNTEREVIDENCE_SOURCES.added),
    );
    const panel = page.getByTestId("research-synthesis-panel");
    await openDetails(panel);
    const counterCard = panel
      .locator(":scope > details")
      .filter({ has: page.locator("summary", { hasText: "新增反证" }) })
      .last();
    await openDetails(counterCard);
    await expect(counterCard.getByText(response.reason, { exact: false })).toBeVisible();
    await expect(counterCard.getByText("B 的具名复核", { exact: true })).toBeVisible();
    await expect(counterCard.getByText("导师 Agent 处理", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("closed-counterevidence-chain.png") });
    await writeFile(
      test.info().outputPath("actual-native-tool-ledger.json"),
      JSON.stringify(native, null, 2),
    );

    const retained = structuredClone({
      synthesis: final.synthesis,
      fusion: final.fusion,
      artifacts: final.artifacts,
      sourceReads: final.sourceReads,
      inputHistory: final.inputHistory,
      evidence: final.evidence,
      importedMaterials: final.importedMaterials,
      methodPackages: final.methodPackages,
      methodPackageUses: final.methodPackageUses,
      methodApplications: final.methodApplications,
      methodContentOpinions: final.methodContentOpinions,
      methodAdjudications: final.methodAdjudications,
    });
    await harness.close();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    diagnostics();
    const restarted = (snapshots.restarted = await current());
    expect(restarted.status).toBe("completed");
    // Recovery adds only the documented pause controls. Compare all durable
    // research records exactly, and assert those controls separately.
    const recoveredGraph = structuredClone(restarted.fusion!);
    expect(final.fusion!.paused).toBe(false);
    expect(recoveredGraph.paused).toBe(true);
    for (const task of recoveredGraph.tasks) {
      expect(task.blockers.filter((blocker) => blocker.kind === "pause")).toEqual([
        { kind: "pause", objectId: restarted.id, reason: "全组暂停，不派发新请求。" },
      ]);
      task.blockers = task.blockers.filter((blocker) => blocker.kind !== "pause");
    }
    recoveredGraph.paused = final.fusion!.paused;
    expect({
      synthesis: restarted.synthesis,
      fusion: recoveredGraph,
      artifacts: restarted.artifacts,
      sourceReads: restarted.sourceReads,
      inputHistory: restarted.inputHistory,
      evidence: restarted.evidence,
      importedMaterials: restarted.importedMaterials,
      methodPackages: restarted.methodPackages,
      methodPackageUses: restarted.methodPackageUses,
      methodApplications: restarted.methodApplications,
      methodContentOpinions: restarted.methodContentOpinions,
      methodAdjudications: restarted.methodAdjudications,
    }).toEqual(retained);
    validateResearchSynthesisProject(restarted);
    expect(captureResearchNativeBoundary(lastState!, restarted).activeNativeAtCapture).toEqual([]);
    for (const [file, sha256] of Object.entries(originalArtifactHashes))
      expect(researchHash(await readFile(file))).toBe(sha256);
    expect(rendererErrors).toEqual([]);
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    try {
      await writeFile(
        test.info().outputPath("run-outcome.json"),
        JSON.stringify(
          {
            boundary: COUNTEREVIDENCE_BOUNDARY,
            result: failure ? "failed" : "deterministic-E-completed",
            failure,
            snapshots,
            originalArtifactHashes,
            lastState: await getDesktopState(page).catch(() => lastState),
            journal: await fixture.readCounterevidenceJournal(),
            rendererErrors,
            nativeDiagnostics,
            limitations: [
              "Synthetic deterministic provider; no external-provider R or scientific content C",
              "OS picker result is a fixture",
              "Only S3-S5; no S1/S2 acceptance, CSV analysis or complete paper is claimed",
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
