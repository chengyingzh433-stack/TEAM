import { expect, test } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RESEARCH_ROLES,
  researchStages,
  type ResearchProject,
  type ResearchStageId,
  type ResearchArtifact,
} from "../../contracts/research-group";
import { RESEARCH_METHOD_VERSION } from "../../contracts/research-method";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { decodeResearchState } from "../../electron/research-group/repository";
import { isCurrentResearchAnalysis } from "../../electron/research-group/paper-pipeline";
import {
  ensureFusionStageTasks,
  prepareFusionDelivery,
  dispatchFusionAttempt,
  publishFusionArtifact,
  finishFusionNativeRun,
} from "../../electron/research-group/fusion-task-runtime";
import { pauseResearchTasks } from "../../electron/research-group/task-graph";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  type DesktopHarness,
} from "../helpers/electron-app";
import {
  DATA_CONTINUATION_PROVIDER,
  dataContinuationGatePaths,
  writeResearchDataContinuationProvider,
} from "../helpers/research-data-continuation-provider";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function pick(harness: DesktopHarness, files: string[]) {
  await harness.electronApp.evaluate(({ dialog }, filePaths) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths };
    };
  }, files);
}
function acceptPriorStage(p: ResearchProject, stage: ResearchStageId) {
  const at = new Date().toISOString();
  p.currentStage = stage;
  ensureFusionStageTasks(p, at);
  for (const role of RESEARCH_ROLES) {
    const attemptId = `fixture-prior-${stage}-${role}`;
    prepareFusionDelivery(p, role, attemptId, at, "隔离夹具：已接受的上游成果");
    dispatchFusionAttempt(p, attemptId, at);
    const artifact: ResearchArtifact = {
      id: randomUUID(),
      role,
      kind:
        role === "mentor"
          ? "stage-review"
          : role === "lead"
            ? "stage-draft"
            : role === "reviewer"
              ? "stage-risk"
              : "stage-material",
      stage,
      revision: p.revision,
      round: 1,
      createdAt: at,
      refs: [],
      content: `隔离测试前置${stage}成果：方案范围为观察关联，保留材料获取计划；不表示真实提供商曾执行该前置研究。`,
      toolCallId: `fixture-prior-tool-${stage}-${role}`,
      ...(role === "mentor" ? { verdict: "accept" as const } : {}),
    };
    p.artifacts.push(artifact);
    publishFusionArtifact(p, artifact);
    finishFusionNativeRun(p, role, undefined, at, {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }
}

function decodeGate(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("attemptId" in value) ||
    typeof value.attemptId !== "string" ||
    !("analysisId" in value) ||
    typeof value.analysisId !== "string" ||
    !("taskVersion" in value) ||
    typeof value.taskVersion !== "number" ||
    !("datasetSha256" in value) ||
    typeof value.datasetSha256 !== "string"
  )
    throw new Error("Invalid deterministic provider gate receipt");
  return {
    attemptId: value.attemptId,
    analysisId: value.analysisId,
    taskVersion: value.taskVersion,
    datasetSha256: value.datasetSha256,
  };
}

function captureNativeState(project: ResearchProject) {
  return {
    observedAt: new Date().toISOString(),
    projectId: project.id,
    status: project.status,
    currentStage: project.currentStage,
    revision: project.revision,
    members: structuredClone(project.members),
    activeAttempts: structuredClone(
      project.fusion!.attempts.filter((attempt) =>
        ["prepared", "running", "unknown"].includes(attempt.state),
      ),
    ),
    tasks: project.fusion!.tasks.map((task) => ({
      id: task.id,
      stage: task.stage,
      role: task.role,
      state: task.state,
      inputVersion: task.inputVersion,
      currentArtifactId: task.currentArtifactId,
    })),
  };
}

// E: actual local Pi tools/OLS and UI material changes. Prior accepted work is an explicit fixture.
// The old calculation has returned; its native model request is held before publishing a draft.
// This proves late draft isolation, not a computation that was still awaiting an external result.
test("later data resumes design and actual analysis; a late native draft cannot replace new data results", async () => {
  test.setTimeout(150_000);
  const profile = await makeUserDataDir("research-data-continuation-"),
    workspace = await makeWorkspace("research-data-continuation"),
    agentDir = join(profile, "agent"),
    kb = join(profile, "knowledge");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"), { recursive: true });
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "DATA-METHOD",
      title: "研究设计 变量 分析 证据边界",
      text: "软件验收合成方法：保留已接受问题，补数据后核对字段与设计，实际计算仅支持观察关联。",
      required_context_ids: [],
    }),
  );
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "data-fixture" }));
  const knowledge = await ResearchKnowledge.open(kb);
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: DATA_CONTINUATION_PROVIDER,
      defaultModel: "gpt-6.1-sol",
      enabledModels: [`${DATA_CONTINUATION_PROVIDER}/gpt-6.1-sol`],
      compaction: { enabled: false },
    }),
  );
  await writeResearchDataContinuationProvider(workspace, profile);
  const inputs = [join(workspace, "first-data.csv"), join(workspace, "corrected-data.csv")];
  await writeFile(inputs[0]!, "x,y\n1,3\n2,5\n3,7\n4,9\n5,11\n6,13\n");
  await writeFile(inputs[1]!, "x,y\n1,9\n2,8\n3,7\n4,6\n5,5\n6,4\n");
  const originalBytes = await Promise.all(inputs.map((file) => readFile(file)));
  const sessions: Awaited<ReturnType<typeof seedNamedTextSessionFixture>>[] = [];
  for (const role of RESEARCH_ROLES)
    sessions.push(
      await seedNamedTextSessionFixture(agentDir, workspace, {
        title: `lancer-zone:edu-research-group|数据接续 ${role}`,
        userText: "前置研究历史夹具",
        assistantText: "保留的前置内容，不是本测试实际模型输出。",
      }),
    );
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      testMode: "background",
      scrubProviderEnv: true,
    });
  let harness = await launch();
  try {
    let page = await harness.firstWindow();
    const state = await getDesktopState(page);
    const workspaceId = state.workspaces.find((item) =>
      item.sessions.some((session) => session.id === sessions[0]!.sessionId),
    )?.id;
    if (!workspaceId) throw new Error("Seeded sessions were not discovered");
    await harness.close();
    const at = new Date().toISOString();
    const p: ResearchProject = {
      id: randomUUID(),
      root: { workspaceId, sessionId: sessions[0]!.sessionId },
      workspacePath: workspace,
      objective: "合成材料的软件验收：保留问题和综合，仅复核补入数据与设计的适配，真实运行OLS。",
      revision: 1,
      status: "running",
      createdAt: at,
      updatedAt: at,
      workflowVersion: "fusion-v2",
      methodVersion: RESEARCH_METHOD_VERSION,
      entry: "idea",
      goal: "paper",
      path: "quantitative",
      scope: "paper",
      memberTokenBudget: 500_000,
      knowledge: knowledge.pin,
      stages: researchStages({ workflowVersion: "fusion-v2" }).map((stage) => ({
        ...stage,
        models: Object.fromEntries(
          RESEARCH_ROLES.map((role) => [
            role,
            {
              provider: DATA_CONTINUATION_PROVIDER,
              modelId: "gpt-6.1-sol",
              thinkingLevel: "low" as const,
            },
          ]),
        ),
      })),
      members: RESEARCH_ROLES.map((role, index) => ({
        role,
        ref: { workspaceId, sessionId: sessions[index]!.sessionId },
        status: "idle",
      })),
      artifacts: [],
      packets: [],
      events: [],
      evidence: { directory: "", sources: [], datasets: [] },
      analyses: [],
      analysisPlan: { datasetId: "FUTURE-DATA", method: "ols", columns: ["x"], outcome: "y" },
    };
    for (const stage of ["question", "synthesis", "design"] as const) acceptPriorStage(p, stage);
    p.currentStage = "analysis";
    ensureFusionStageTasks(p, at);
    p.fusion = pauseResearchTasks(p.fusion!);
    p.status = "paused";
    const upstream = structuredClone(
      p.fusion.artifacts.filter((artifact) =>
        p.artifacts.some(
          (prior) =>
            prior.id === artifact.id && ["question", "synthesis"].includes(prior.stage ?? ""),
        ),
      ),
    );
    const refs = p.members.map((member) => member.ref);
    const researchFile = join(profile, "research-groups.json");
    await writeFile(
      researchFile,
      JSON.stringify(
        decodeResearchState({ version: 1, config: { knowledgeDir: kb }, projects: [p] }),
      ),
    );
    harness = await launch();
    page = await harness.firstWindow();
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    const openProject = async () => {
      await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
      await page
        .locator(`.research-project[data-project-id="${p.id}"] .research-project__name`)
        .click();
      return page.getByRole("region", { name: "教育研究课题组", exact: true });
    };
    let panel = await openProject();
    const current = async () =>
      (await getDesktopState(page)).researchGroups!.projects.find(
        (project) => project.id === p.id,
      )!;
    // Both CSVs are parsed by the real import path; only the first is adopted initially.
    await pick(harness, inputs);
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(2);
    const materials = (await current()).importedMaterials!;
    const first = materials.find((item) => item.name === "first-data.csv")!,
      corrected = materials.find((item) => item.name === "corrected-data.csv")!;
    const firstItem = panel.locator(`[data-material-id="${first.id}"]`);
    await firstItem.locator(":scope > summary").click();
    await firstItem
      .getByLabel("first-data.csv 来源及提供说明", { exact: true })
      .fill("本测试人工合成数据，只验证软件计算与版本，不作为真实观察结果。");
    await firstItem
      .getByLabel("first-data.csv 材料性质", { exact: true })
      .selectOption("synthetic");
    await firstItem
      .getByLabel("first-data.csv 使用依据", { exact: true })
      .selectOption("user-authorized");
    await expect(firstItem.getByTestId("research-material-adoption-impact")).toBeVisible();
    await expect(firstItem.getByTestId("research-material-adoption-impact")).toContainText(
      "提交时会再次核对本次展示的输入和成果",
    );
    await firstItem.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect.poll(async () => (await current()).evidence!.datasets.length).toBe(1);
    const adopted = await current();
    expect(adopted.currentStage).toBe("design");
    const firstDataset = structuredClone(adopted.evidence!.datasets[0]!);
    expect(
      adopted.fusion!.artifacts.filter((artifact) =>
        upstream.some((old) => old.id === artifact.id),
      ),
    ).toEqual(upstream);
    await panel.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    const gates = dataContinuationGatePaths(profile);
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(await readFile(gates.waiting, "utf8")) as { analysisId: string };
          } catch {
            return undefined;
          }
        },
        { timeout: 60_000 },
      )
      .toBeTruthy();
    const gate = decodeGate(JSON.parse(await readFile(gates.waiting, "utf8")));
    const beforeReplacement = await current();
    const oldRun = beforeReplacement.analyses!.find((run) => run.id === gate.analysisId)!;
    expect(oldRun.datasetSha256).toBe(firstDataset.sha256);
    expect(isCurrentResearchAnalysis(beforeReplacement, oldRun)).toBe(true);
    expect(oldRun.result).toMatchObject({
      regression: { coefficients: { intercept: expect.closeTo(1, 8), x: expect.closeTo(2, 8) } },
    });
    expect(
      beforeReplacement.fusion!.attempts.find((attempt) => attempt.id === gate.attemptId),
    ).toMatchObject({ state: "running" });
    // The held A publication is the required in-flight work. Other roles may
    // still be finishing their native turns when the user replaces the data.
    const change = panel.getByTestId("research-material-change-control");
    await change.locator(":scope > summary").click();
    await change.getByLabel("当前采用来源", { exact: true }).selectOption(firstDataset.sourceId);
    await change.getByLabel("替换候选", { exact: true }).selectOption(corrected.id);
    await change
      .getByLabel("替换材料来源及提供说明", { exact: true })
      .fill("修正的合成数据；需要重审原分析及下游，保留已接受的问题与综合。");
    await change
      .getByLabel("替换数据工作表", { exact: true })
      .selectOption(corrected.tables[0]!.name);
    await change.getByLabel("替换数据性质", { exact: true }).selectOption("synthetic");
    await change.getByLabel("替换数据使用许可", { exact: true }).selectOption("user-authorized");
    await change
      .getByLabel("材料变更原因", { exact: true })
      .fill("更正合成观察值，检验旧在途稿件不会覆盖新输入。");
    const heldAttempt = beforeReplacement.fusion!.attempts.find(
      (attempt) => attempt.id === gate.attemptId,
    )!;
    expect(heldAttempt).toMatchObject({
      state: "running",
      taskId: oldRun.taskId,
      taskVersion: gate.taskVersion,
    });
    expect(heldAttempt.nativeRunId).toBeTruthy();
    expect(heldAttempt.finishedAt).toBeUndefined();
    const assertHeldPublication = async (project: ResearchProject) => {
      expect(decodeGate(JSON.parse(await readFile(gates.waiting, "utf8")))).toEqual(gate);
      await expect(readFile(gates.release, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        project.fusion!.attempts.find((attempt) => attempt.id === gate.attemptId),
      ).toMatchObject({
        id: heldAttempt.id,
        state: "running",
        taskId: heldAttempt.taskId,
        taskVersion: heldAttempt.taskVersion,
        nativeRunId: heldAttempt.nativeRunId,
        preparedAt: heldAttempt.preparedAt,
        dispatchedAt: heldAttempt.dispatchedAt,
        model: heldAttempt.model,
      });
      expect(
        project.fusion!.attempts.find((attempt) => attempt.id === gate.attemptId)!.finishedAt,
      ).toBeUndefined();
      expect(project.members.find((member) => member.role === "lead")).toMatchObject({
        status: "running",
      });
    };
    const preview = change.getByTestId("research-material-impact-preview");
    const alertText = async () =>
      (await change.getByRole("alert").allTextContents()).join(" ").trim();
    const stalePreviewAlert =
      /^(?:Error invoking remote method 'pi-gui:research-group-action': Error: )?影响已变化，请重新查看后应用。\s*输入已保留；如影响已变化，请重新预览。$/;
    const replacementAttempts: {
      attempt: number;
      phase: "before-submit" | "after-submit";
      native: ReturnType<typeof captureNativeState>;
      alert: string;
      visiblePreview: string;
    }[] = [];
    const retainReplacementAttempt = async (
      attempt: number,
      phase: "before-submit" | "after-submit",
      project: ResearchProject,
      visiblePreview: string,
      alert: string,
    ) => {
      const receipt = {
        attempt,
        phase,
        native: captureNativeState(project),
        alert,
        visiblePreview,
      };
      replacementAttempts.push(receipt);
      await writeFile(
        test.info().outputPath(`data-replacement-attempt-${attempt}-${phase}.json`),
        JSON.stringify(receipt, null, 2),
      );
      return receipt.native;
    };
    let replacementBefore: ReturnType<typeof captureNativeState> | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // A stale scope is never resubmitted. The user explicitly reads a new UI preview.
      await change.getByRole("button", { name: "查看此次变更的具体影响", exact: true }).click();
      await expect
        .poll(async () => (await preview.isVisible()) || !!(await alertText()))
        .toBe(true);
      const previewError = await alertText();
      if (previewError) throw new Error(`Material impact preview failed: ${previewError}`);
      await expect(preview).toContainText("数据变化需要重新核对方案");
      for (const details of await preview.locator("details").all())
        if ((await details.getAttribute("open")) === null)
          await details.locator(":scope > summary").click();
      const visiblePreview = await preview.innerText();
      for (const scope of [
        "first-data.csv",
        "直接影响的任务",
        "后续受影响任务",
        "保留的任务",
        "需重审的成果与历史版本",
      ])
        expect(visiblePreview).toContain(scope);
      const beforeSubmit = await current();
      const nativeBefore = await retainReplacementAttempt(
        attempt,
        "before-submit",
        beforeSubmit,
        visiblePreview,
        await alertText(),
      );
      if (attempt === 1) {
        replacementBefore = nativeBefore;
        await writeFile(
          test.info().outputPath("data-replacement-before-native-state.json"),
          JSON.stringify(replacementBefore, null, 2),
        );
      }
      await assertHeldPublication(beforeSubmit);
      expect(isCurrentResearchAnalysis(beforeSubmit, oldRun)).toBe(true);
      await change.getByRole("button", { name: "应用以上影响并替换版本", exact: true }).click();
      let outcomeProject = beforeSubmit,
        outcomeAlert = "";
      await expect
        .poll(async () => {
          outcomeProject = await current();
          outcomeAlert = await alertText();
          return (
            !!outcomeAlert || outcomeProject.evidence!.datasets[0]!.sha256 !== firstDataset.sha256
          );
        })
        .toBe(true);
      const remainingPreview = (await preview.allTextContents()).join(" ").trim();
      await retainReplacementAttempt(
        attempt,
        "after-submit",
        outcomeProject,
        remainingPreview,
        outcomeAlert,
      );
      await assertHeldPublication(outcomeProject);
      if (!outcomeAlert) {
        expect(outcomeProject.evidence!.datasets[0]!.sha256).not.toBe(firstDataset.sha256);
        break;
      }
      await page.screenshot({
        path: test.info().outputPath(`data-replacement-attempt-${attempt}-rejected.png`),
      });
      if (!stalePreviewAlert.test(outcomeAlert))
        throw new Error(
          `Material replacement failed without a retryable stale preview: ${outcomeAlert}`,
        );
      expect(outcomeProject.evidence!.datasets[0]!.sha256).toBe(firstDataset.sha256);
      expect(isCurrentResearchAnalysis(outcomeProject, oldRun)).toBe(true);
      if (attempt === 3)
        throw new Error(
          `Material replacement was rejected after three reviewed UI submissions: ${outcomeAlert}`,
        );
    }
    const changed = await current();
    const replacementAfter = captureNativeState(changed);
    await writeFile(
      test.info().outputPath("data-replacement-after-native-state.json"),
      JSON.stringify(replacementAfter, null, 2),
    );
    expect(changed.fusion!.attempts.find((attempt) => attempt.id === gate.attemptId)).toMatchObject(
      {
        id: heldAttempt.id,
        state: "running",
        taskId: heldAttempt.taskId,
        taskVersion: heldAttempt.taskVersion,
        nativeRunId: heldAttempt.nativeRunId,
        preparedAt: heldAttempt.preparedAt,
        dispatchedAt: heldAttempt.dispatchedAt,
        model: heldAttempt.model,
      },
    );
    expect(changed.evidence!.datasets[0]!.id).toBe(firstDataset.id);
    expect(changed.evidence!.datasets[0]!.sourceId).toBe(firstDataset.sourceId);
    expect(changed.materialHistory?.flatMap((entry) => entry.evidence.datasets)).toContainEqual(
      firstDataset,
    );
    expect(isCurrentResearchAnalysis(changed, oldRun)).toBe(false);
    expect(
      changed.fusion!.tasks.find((task) => task.id === oldRun.taskId)!.inputVersion,
    ).toBeGreaterThan(gate.taskVersion);
    await page.screenshot({
      path: test.info().outputPath("new-data-old-native-request-pending.png"),
    });
    // Release the already-computed old model response only after the real UI change has persisted.
    await writeFile(gates.release, "release old native response after adoption", { flag: "wx" });
    await expect
      .poll(async () => {
        const project = await current();
        return project.artifacts.find((artifact) =>
          artifact.content.includes(`OLD_OR_CURRENT_ANALYSIS=${oldRun.id}`),
        )?.id;
      })
      .toBeTruthy();
    await expect
      .poll(
        async () => {
          const project = await current();
          return project.analyses?.filter(
            (run) =>
              run.role === "lead" &&
              run.datasetSha256 !== firstDataset.sha256 &&
              isCurrentResearchAnalysis(project, run),
          ).length;
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    const completed = await current();
    const latestRun = completed
      .analyses!.filter((run) => run.role === "lead" && run.datasetSha256 !== firstDataset.sha256)
      .at(-1)!;
    expect(isCurrentResearchAnalysis(completed, latestRun)).toBe(true);
    expect(latestRun.taskInputVersion).toBeGreaterThan(gate.taskVersion);
    expect(completed.analyses).toContainEqual(oldRun);
    expect(isCurrentResearchAnalysis(completed, oldRun)).toBe(false);
    expect(latestRun.result).toMatchObject({
      regression: { coefficients: { intercept: expect.closeTo(10, 8), x: expect.closeTo(-1, 8) } },
    });
    const lateArtifact = completed.artifacts.find((artifact) =>
      artifact.content.includes(`OLD_OR_CURRENT_ANALYSIS=${oldRun.id}`),
    )!;
    const lateRecord = completed.fusion!.artifacts.find(
      (artifact) => artifact.id === lateArtifact.id,
    )!;
    expect(lateRecord.reviewState).toBe("superseded");
    expect(
      completed.fusion!.tasks.find((task) => task.id === lateRecord.taskId)?.currentArtifactId,
    ).not.toBe(lateArtifact.id);
    expect(
      completed.artifacts.filter((artifact) => artifact.toolCallId === lateArtifact.toolCallId),
    ).toHaveLength(1);
    expect(completed.members.map((member) => member.ref)).toEqual(refs);
    expect(
      completed.fusion!.artifacts.filter((artifact) =>
        upstream.some((old) => old.id === artifact.id),
      ),
    ).toEqual(upstream);
    expect(
      completed.artifacts.filter((artifact) =>
        ["question", "synthesis"].includes(artifact.stage ?? ""),
      ),
    ).toHaveLength(upstream.length);
    expect(completed.events.filter((event) => event.type === "error")).toEqual([]);
    await panel.getByRole("button", { name: "暂停全组", exact: true }).click();
    await expect
      .poll(async () => (await current()).members.some((member) => member.status === "running"))
      .toBe(false);
    const paused = await current();
    for (let i = 0; i < inputs.length; i++)
      expect(await readFile(inputs[i]!)).toEqual(originalBytes[i]);
    expect(hash(await readFile(firstDataset.file))).toBe(firstDataset.sha256);
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    panel = await openProject();
    const restored = await current();
    expect(restored.members.map((member) => member.ref)).toEqual(refs);
    expect(restored.analyses).toEqual(paused.analyses);
    expect(restored.artifacts).toEqual(paused.artifacts);
    expect(restored.materialHistory).toEqual(paused.materialHistory);
    expect(isCurrentResearchAnalysis(restored, oldRun)).toBe(false);
    await page.screenshot({
      path: test.info().outputPath("data-version-history-after-restart.png"),
    });
    await writeFile(
      test.info().outputPath("data-continuation-evidence.json"),
      JSON.stringify(
        {
          proof:
            "Deterministic native E. OLS calculations are actual; old calculation completed before controlled late model publication. Prior upstream accepts are fixtures. No R/C/N claim.",
          gate,
          replacementBefore,
          replacementAfter,
          replacementAttempts,
          oldRun,
          latestRun,
          lateArtifact,
          restored,
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
});
