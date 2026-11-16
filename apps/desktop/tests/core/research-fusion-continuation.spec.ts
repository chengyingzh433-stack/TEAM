import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";
import { writeResearchFusionProvider } from "../helpers/research-fusion-provider";

async function setupFusion() {
  const profile = await makeUserDataDir("research-fusion-continuation-");
  const workspace = await makeWorkspace("research-fusion-continuation");
  const agentDir = join(profile, "agent"),
    kb = join(profile, "knowledge"),
    materials = join(profile, "materials");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"), { recursive: true });
  await mkdir(materials, { recursive: true });
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "FUSION-METHOD",
      title: "研究问题 证据 研究设计 论文写作",
      text: "仅供集成测试的合成课程方法，区分方案接受与真实材料条件。",
      required_context_ids: [],
    }),
  );
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "fusion-fixture" }));
  for (const id of ["A", "B"])
    await writeFile(
      join(materials, `${id}.txt`),
      `合成测试来源${id}，不是真实论文。材料计划不等于实际材料，满意度与论证质量不同，观察关联不等于因果。`,
    );
  await writeFile(
    join(materials, "manifest.json"),
    JSON.stringify({
      version: 1,
      sources: ["A", "B"].map((id) => ({
        id: `FUSION-${id}`,
        title: `合成测试来源${id}`,
        authors: "测试fixture",
        year: "2026",
        url: `https://example.test/fusion-${id}`,
        file: `${id}.txt`,
        kind: "paper",
      })),
      datasets: [],
    }),
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "research-fusion-fixture",
      defaultModel: "gpt-6.1-sol",
      enabledModels: [
        "research-fusion-fixture/gpt-6-astra",
        "research-fusion-fixture/gpt-6.1-sol",
        "research-fusion-fixture/deepseek-flash",
      ],
      compaction: { enabled: false },
    }),
  );
  await writeResearchFusionProvider(workspace, profile);
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      testMode: "background",
      scrubProviderEnv: true,
    });
  return { profile, workspace, kb, materials, launch };
}

function assertNativeFusionEvidence(project: ResearchProject) {
  const expected = ["question", "search", "reading", "synthesis", "design"];
  expect(
    project.artifacts
      .filter((a) => a.kind === "stage-review" && a.verdict === "accept")
      .map((a) => a.stage),
  ).toEqual(expected);
  expect(project.evidence?.datasets).toEqual([]);
  expect(project.analyses ?? []).toHaveLength(0);
  expect(project.analysisPlan).toMatchObject({ datasetId: "FUTURE-DATA", method: "ols" });
  const firstRuns = RESEARCH_ROLES.map((role) => {
    const start = project.events.find((e) => e.type === "started" && e.role === role && e.runId);
    expect(start, `${role} native start`).toBeTruthy();
    const end = project.events.find((e) => e.type === "finished" && e.runId === start!.runId);
    return {
      role,
      runId: start!.runId,
      start: Date.parse(start!.runtimeAt ?? start!.at),
      end: end ? Date.parse(end.runtimeAt ?? end.at) : Date.now(),
    };
  });
  expect(Math.max(...firstRuns.map((r) => r.start))).toBeLessThan(
    Math.min(...firstRuns.map((r) => r.end)),
  );
  for (const stage of expected) {
    for (const role of RESEARCH_ROLES)
      expect(project.packets.some((packet) => packet.stage === stage && packet.role === role)).toBe(
        true,
      );
    const batches = project.artifacts.filter(
      (a) => a.stage === stage && a.kind === "stage-material",
    );
    expect(batches).toHaveLength(2);
    const consumed = project.events.find(
      (e) =>
        e.type === "read" &&
        e.artifactId === batches[0]!.id &&
        e.role !== "librarian" &&
        e.producerRunning &&
        e.runId &&
        e.producerRunId,
    );
    expect(consumed, `${stage} actual read during producer run`).toBeTruthy();
    expect(Date.parse(consumed!.at)).toBeLessThanOrEqual(Date.parse(batches[1]!.createdAt));
    const draft = project.artifacts.find((a) => a.stage === stage && a.kind === "stage-draft")!;
    const critique = project.artifacts.find(
      (a) => a.stage === stage && a.kind === "stage-critique",
    )!;
    const revision = project.artifacts.find(
      (a) => a.stage === stage && a.kind === "stage-revision",
    )!;
    const verification = project.artifacts.find(
      (a) => a.stage === stage && a.kind === "stage-verification",
    )!;
    expect(critique.refs).toContain(draft.id);
    expect(revision.refs).toContain(critique.id);
    expect(verification.refs).toContain(revision.id);
    expect(revision.content).not.toBe(draft.content);
    expect(
      project.events.some(
        (e) => e.type === "read" && e.role === "lead" && e.artifactId === critique.id,
      ),
    ).toBe(true);
  }
  for (const artifact of project.artifacts) {
    expect(artifact.model).toEqual(
      project.stages!.find((stage) => stage.id === artifact.stage)!.models[artifact.role],
    );
    expect(artifact.content).toContain(`模型=${artifact.model!.modelId}`);
  }
  expect(project.events.filter((e) => e.type === "error")).toEqual([]);
  const runIds = project.fusion!.attempts.flatMap((attempt) =>
    attempt.nativeRunId ? [attempt.nativeRunId] : [],
  );
  expect(new Set(runIds).size).toBe(runIds.length);
  for (const attempt of project.fusion!.attempts)
    if (attempt.finishedAt)
      expect(
        Date.parse(attempt.finishedAt),
        `native completion belongs to ${attempt.id}`,
      ).toBeGreaterThanOrEqual(Date.parse(attempt.preparedAt));
  return firstRuns;
}

for (const goal of ["design", "paper"] as const)
  test(`fusion native tools reach an accepted no-data design${goal === "paper" ? " and keep analysis waiting while independent prechecks execute" : " and finish the requested goal"}`, async () => {
    test.setTimeout(150_000);
    const fixture = await setupFusion();
    let harness = await fixture.launch();
    try {
      let page = await harness.firstWindow();
      await harness.electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setSize(1480, 980),
      );
      await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
      await openNewThread(page);
      const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
      await expect(editor.getByLabel("研究流程版本", { exact: true })).toHaveValue("fusion-v2");
      await editor.getByLabel("课程知识库目录", { exact: true }).fill(fixture.kb);
      await editor.getByLabel("研究材料目录", { exact: true }).fill(fixture.materials);
      await editor.getByLabel("研究入口", { exact: true }).selectOption("idea");
      await editor.getByLabel("本轮研究目标", { exact: true }).selectOption(goal);
      await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
      // Explicit fixture allowance, no external-provider calls or billing.
      await editor.getByLabel("成员 Token 上限", { exact: true }).fill("500000");
      for (let index = 0; index < FUSION_STAGE_IDS.length; index++)
        for (const role of RESEARCH_ROLES) {
          const modelId =
            role === "librarian"
              ? "deepseek-flash"
              : role === "mentor"
                ? "gpt-6-astra"
                : index % 2
                  ? "gpt-6.1-sol"
                  : "gpt-6-astra";
          await editor
            .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}模型`, { exact: true })
            .selectOption(JSON.stringify({ provider: "research-fusion-fixture", modelId }));
          await editor
            .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}思考强度`, { exact: true })
            .selectOption(role === "librarian" ? "low" : "high");
        }
      await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
      await expect(editor).toBeHidden();
      await page
        .getByLabel("New thread prompt")
        .fill(
          `仅为确定性软件验收：已有实验报告评价想法，当前只有合成原文而没有CSV。请完成研究方案；${goal === "paper" ? "完整论文目标在真实材料缺失处等待，独立核查继续。" : "本轮到方案结束，不虚构分析结果。"}`,
        );
      await page.getByRole("button", { name: "Start thread", exact: true }).click();
      await expect
        .poll(async () => (await getDesktopState(page)).researchGroups?.projects.length)
        .toBe(1);
      const originalMembers = (
        await getDesktopState(page)
      ).researchGroups!.projects[0]!.members.map((m) => m.ref);
      await expect
        .poll(
          async () => {
            const project = (await getDesktopState(page)).researchGroups?.projects[0];
            const errors = project?.events.filter((e) => e.type === "error") ?? [];
            if (errors.length && !(goal === "paper" && project?.currentStage === "analysis"))
              throw new Error(errors.map((e) => e.detail).join("\n"));
            if (goal === "design") return project?.status === "completed";
            return (
              project?.currentStage === "analysis" &&
              project.fusion?.tasks.some(
                (task) =>
                  task.stage === "analysis" &&
                  task.role === "lead" &&
                  task.state === "waiting-dependency",
              ) &&
              project.artifacts.some((a) => a.stage === "analysis" && a.kind === "stage-risk") &&
              project.artifacts.filter((a) => a.stage === "analysis" && a.kind === "stage-material")
                .length === 2
            );
          },
          { timeout: 100_000 },
        )
        .toBe(true);
      if (goal === "paper") {
        await page.getByRole("button", { name: "暂停全组", exact: true }).click();
        await expect
          .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
          .toBe("paused");
      }
      const project = (await getDesktopState(page)).researchGroups!.projects[0]!;
      expect(project.members.map((m) => m.ref)).toEqual(originalMembers);
      const firstRuns = assertNativeFusionEvidence(project);
      expect(project.stages?.map((stage) => stage.id)).toEqual(FUSION_STAGE_IDS);
      expect(project.finalPaper).toBeUndefined();
      if (goal === "design")
        expect(project).toMatchObject({
          status: "completed",
          currentStage: "design",
          goal: "design",
        });
      else
        expect(
          project.artifacts.filter((a) => a.stage === "analysis" && a.role === "lead"),
        ).toHaveLength(0);
      await writeFile(
        test.info().outputPath("fusion-native-proof.json"),
        JSON.stringify(
          {
            evidenceLevel:
              "E: deterministic local provider with real Pi sessions and tools, not R or C",
            project,
            firstRuns,
            originalMembers,
          },
          null,
          2,
        ),
      );
      await page.screenshot({ path: test.info().outputPath("fusion-no-data-result.png") });
      await harness.close();
      harness = await fixture.launch();
      page = await harness.firstWindow();
      await expect
        .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
        .toBe(goal === "design" ? "completed" : "paused");
      const restored = (await getDesktopState(page)).researchGroups!.projects[0]!;
      expect(restored.artifacts).toEqual(project.artifacts);
      expect(restored.members.map((m) => m.ref)).toEqual(originalMembers);
      expect(restored.events.filter((e) => e.type === "started")).toEqual(
        project.events.filter((e) => e.type === "started"),
      );
      await page.screenshot({ path: test.info().outputPath("fusion-no-data-restarted.png") });
    } finally {
      try {
        const current = (await getDesktopState(await harness.firstWindow())).researchGroups;
        await writeFile(
          test.info().outputPath("fusion-state-on-exit.json"),
          JSON.stringify(current, null, 2),
        );
      } finally {
        await harness.close();
      }
    }
  });
