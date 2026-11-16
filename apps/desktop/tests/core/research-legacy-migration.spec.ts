import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RESEARCH_ROLES,
  researchStages,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import { snapshotSharedResearchMethod } from "../../contracts/shared-research-method";
import { formatSessionTitleForZone } from "../../contracts/lancer-zones";
import { decodeResearchState } from "../../electron/research-group/repository";
import { decodeLegacyResearchMigrationRecord } from "../../electron/research-group/legacy-migration";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
} from "../helpers/electron-app";
import { writeResearchGroupProvider } from "../helpers/research-group-provider";

// E: explicit legacy fixtures, then actual UI preview/commit, native session creation and restart.
// No research execution or existing user project is represented by the seeded history.
test("two and seven stage legacy projects create separate paused fusion tasks through reviewed migration", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("research-legacy-migration-"),
    workspace = await makeWorkspace("research-legacy-migration"),
    agentDir = join(profile, "agent"),
    kb = join(profile, "knowledge");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"), { recursive: true });
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "MIGRATION-METHOD",
      title: "研究方法",
      text: "迁移界面验收夹具，不是研究证据。",
      required_context_ids: [],
    }),
  );
  await writeFile(
    join(kb, "溯源", "来源清单.json"),
    JSON.stringify({ version: "migration-fixture" }),
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "research-routing-fixture",
      defaultModel: "gpt-6.1-sol",
      enabledModels: [
        "research-routing-fixture/gpt-6.1-sol",
        "research-routing-fixture/gpt-6-astra",
      ],
      compaction: { enabled: false },
    }),
  );
  // Registers selectable models only. Migration must never start provider requests.
  await writeResearchGroupProvider(workspace, profile);
  const seeds: {
    count: number;
    members: { role: (typeof RESEARCH_ROLES)[number]; sessionId: string }[];
  }[] = [];
  for (const count of [2, 7]) {
    const members = [];
    for (const role of RESEARCH_ROLES) {
      const session = await seedNamedTextSessionFixture(agentDir, workspace, {
        title: formatSessionTitleForZone("edu-research-group", `迁移旧${count}阶段-${role}`),
        userText: `旧${count}阶段的${role}原始输入`,
        assistantText: `旧${count}阶段的${role}原始内容；明确的迁移测试夹具。`,
      });
      members.push({ role, sessionId: session.sessionId });
    }
    seeds.push({ count, members });
  }
  const originalFile = join(workspace, "legacy-original.txt");
  const originalBytes = "旧项目原始材料与正文，迁移只保存引用，不能覆写或宣称已在新任务核验。\n";
  await writeFile(originalFile, originalBytes);
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      scrubProviderEnv: true,
      testMode: "background",
    });
  let harness = await launch();
  try {
    let page = await harness.firstWindow();
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).workspaces.flatMap((item) => item.sessions).length,
      )
      .toBe(8);
    const workspaceId = (await getDesktopState(page)).workspaces.find((item) =>
      item.sessions.some((session) => session.id === seeds[0]!.members[0]!.sessionId),
    )!.id;
    await harness.close();
    const pin = (await ResearchKnowledge.open(kb)).pin;
    const defaults = Object.fromEntries(
      RESEARCH_ROLES.map((role) => [
        role,
        {
          provider: "research-routing-fixture",
          modelId: "gpt-6.1-sol",
          thinkingLevel: "high" as const,
        },
      ]),
    );
    const projects: ResearchProject[] = seeds.map(({ count, members }) => {
      const stages = researchStages()
        .slice(0, count)
        .map((stage, index) => ({
          ...stage,
          title: `旧${count}阶段自定义${index + 1}`,
          goal: `保留旧${count}阶段的目标${index + 1}`,
          models: {
            ...defaults,
            reviewer: {
              provider: "research-routing-fixture",
              modelId: "gpt-6-astra",
              thinkingLevel: "max" as const,
            },
          },
        }));
      const ref = (sessionId: string) => ({ workspaceId, sessionId });
      return {
        id: randomUUID(),
        root: ref(members[0]!.sessionId),
        workspacePath: workspace,
        objective: `旧${count}阶段完整原文，仅明确新任务操作才迁移。`,
        revision: 3,
        status: "completed",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        knowledge: pin,
        stages,
        scope: count === 2 ? "proposal" : "paper",
        memberTokenBudget: 37000 + count,
        currentStage: count === 2 ? "review" : "audit",
        members: members.map(({ role, sessionId }) => ({
          role,
          ref: ref(sessionId),
          status: "idle",
        })),
        artifacts: [
          {
            id: randomUUID(),
            role: "mentor",
            kind: count === 2 ? "review" : "stage-review",
            stage: count === 2 ? "review" : "audit",
            revision: 3,
            round: 1,
            createdAt: "2026-11-01T00:00:00.000Z",
            content: `旧${count}阶段模型接受的原文；不代表新目标已经接受。`,
            refs: [],
            verdict: "accept",
            toolCallId: `fixture-old-${count}`,
          },
        ],
        packets: [],
        events: [],
        evidence: {
          directory: workspace,
          sources: [
            {
              id: `OLD-${count}`,
              title: `旧${count}阶段原件`,
              authors: "测试",
              year: "2026",
              url: "",
              file: originalFile,
              sha256: createHash("sha256").update(originalBytes).digest("hex"),
              kind: "manuscript",
              access: "provided-text",
            },
          ],
          datasets: [],
        },
      };
    });
    await writeFile(
      join(profile, "research-groups.json"),
      JSON.stringify(
        decodeResearchState({
          version: 1,
          config: { knowledgeDir: kb, models: defaults },
          projects,
        }),
      ),
    );
    harness = await launch();
    page = await harness.firstWindow();
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    const migrated: ResearchProject[] = [];
    const recoveryFiles: { file: string; bytes: string }[] = [];
    for (const [index, source] of projects.entries()) {
      const count = seeds[index]!.count;
      await page
        .locator(`.research-project[data-project-id="${source.id}"] .research-project__name`)
        .click();
      const panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
      await expect(panel).toContainText("旧研究流程 · 原阶段配置与历史保留");
      const control = panel.getByTestId("research-legacy-migration");
      await control.locator(":scope > summary").click();
      const objective = `新${count}阶段接续任务：复核原方案的证据边界，不自动沿用旧接受。`;
      await control.getByLabel("新修改任务目标", { exact: true }).fill(objective);
      await control.getByLabel("接续入口", { exact: true }).selectOption("materials");
      await control.getByLabel("接续目标", { exact: true }).selectOption("design");
      await control.getByLabel("接续研究路径", { exact: true }).selectOption("quantitative");
      await expect(control.getByTestId("research-legacy-migration-preview")).toHaveCount(0);
      await control.getByRole("button", { name: "查看阶段映射与待核查项", exact: true }).click();
      const preview = control.getByTestId("research-legacy-migration-preview");
      await expect(preview).toContainText("源输入版本 3 · 映射 legacy-to-fusion-1");
      await expect(preview).toContainText(
        count === 2 ? "review → 历史保留" : "literature → search、reading、synthesis",
      );
      await expect(preview).toContainText("旧终审仅对旧稿有效");
      await expect(preview).toContainText("本操作不会启动模型请求");
      await preview.getByText("查看九阶段配置（新任务建立后可编辑）", { exact: true }).click();
      await expect(preview.locator("details > div")).toHaveCount(9);
      await expect(preview).toContainText("research-routing-fixture/gpt-6-astra · max");
      const before = await getDesktopState(page);
      expect(before.researchGroups!.projects).toHaveLength(2 + index);
      expect(before.researchGroups!.projects.find((project) => project.id === source.id)).toEqual(
        source,
      );
      await page.screenshot({
        path: test.info().outputPath(`legacy-${count}-migration-preview.png`),
      });
      await control.getByRole("button", { name: "保存恢复快照并建立新任务", exact: true }).click();
      await expect
        .poll(async () => (await getDesktopState(page)).researchGroups!.projects.length)
        .toBe(3 + index);
      const state = await getDesktopState(page);
      const created = state.researchGroups!.projects.find(
        (project) => project.legacyMigration?.sourceProjectId === source.id,
      )!;
      expect(created).toMatchObject({
        objective,
        workflowVersion: "fusion-v2",
        revision: 0,
        status: "paused",
        entry: "materials",
        goal: "design",
        path: "quantitative",
        artifacts: [],
        analyses: [],
        packets: [],
        events: [],
      });
      expect(created.stages!.map((stage) => stage.id)).toEqual(FUSION_STAGE_IDS);
      expect(created.sharedMethod).toEqual(snapshotSharedResearchMethod());
      expect(created.fusion?.attempts ?? []).toEqual([]);
      expect(created.evidence).toBeUndefined();
      expect(created.root).toEqual(created.members.find((member) => member.role === "mentor")!.ref);
      expect(new Set(created.members.map((member) => member.ref.sessionId)).size).toBe(4);
      const previousIds = new Set(
        [...projects, ...migrated].flatMap((project) =>
          project.members.map((member) => member.ref.sessionId),
        ),
      );
      expect(
        created.members.every(
          (member) => member.status === "idle" && !previousIds.has(member.ref.sessionId),
        ),
      ).toBe(true);
      expect(state.workspaces.flatMap((item) => item.sessions)).toHaveLength(12 + index * 4);
      expect(
        state.workspaces
          .flatMap((item) => item.sessions)
          .some((session) => session.status === "running"),
      ).toBe(false);
      for (const old of projects)
        expect(state.researchGroups!.projects.find((project) => project.id === old.id)).toEqual(
          old,
        );
      const file = created.legacyMigration!.recordFile;
      const bytes = await readFile(file, "utf8");
      const recovery = decodeLegacyResearchMigrationRecord(JSON.parse(bytes));
      expect(recovery.sourceSnapshot).toEqual(source);
      expect(recovery.createdProject).toEqual(created);
      expect(recovery.preview.sourceWorkflowVersion).toBe(
        count === 2 ? "legacy-two-stage" : "legacy-seven-stage",
      );
      expect(recovery.intent.objective).toBe(objective);
      migrated.push(structuredClone(created));
      recoveryFiles.push({ file, bytes });
      await page
        .locator(`.research-project[data-project-id="${created.id}"] .research-project__name`)
        .click();
      await expect(
        page.getByRole("region", { name: "教育研究课题组", exact: true }),
      ).toHaveAttribute("data-status", "paused");
      await page.screenshot({
        path: test.info().outputPath(`legacy-${count}-new-paused-project.png`),
      });
    }
    expect(await readFile(originalFile, "utf8")).toBe(originalBytes);
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    const restored = await getDesktopState(page);
    expect(restored.researchGroups!.projects).toHaveLength(4);
    for (const project of [...projects, ...migrated])
      expect(restored.researchGroups!.projects.find((item) => item.id === project.id)).toEqual(
        project,
      );
    expect(restored.workspaces.flatMap((item) => item.sessions)).toHaveLength(16);
    for (const recovery of recoveryFiles)
      expect(await readFile(recovery.file, "utf8")).toBe(recovery.bytes);
    expect(await readFile(originalFile, "utf8")).toBe(originalBytes);
    for (const project of migrated) {
      await page
        .locator(`.research-project[data-project-id="${project.id}"] .research-project__name`)
        .click();
      await expect(
        page.getByRole("region", { name: "教育研究课题组", exact: true }),
      ).toHaveAttribute("data-status", "paused");
    }
    await page.screenshot({ path: test.info().outputPath("legacy-migrations-after-restart.png") });
    await writeFile(
      test.info().outputPath("legacy-migration-evidence.json"),
      JSON.stringify(
        {
          proof:
            "Core Electron UI preview/commit and native session creation; legacy history is explicit fixture, no research requests. Duplicate migration identity is covered by unit tests, not simulated by this UI test.",
          sources: projects,
          migrated,
          recoveryFiles: recoveryFiles.map(({ file }) => file),
          restored: restored.researchGroups,
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
});
