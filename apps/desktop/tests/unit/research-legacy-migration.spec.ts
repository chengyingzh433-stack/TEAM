import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RESEARCH_STAGES,
  RESEARCH_ROLES,
  type ResearchProject,
} from "../../contracts/research-group";
import type {
  ResearchLegacyMigrationIntent,
  ResearchLegacyMigrationTarget,
} from "../../contracts/research-legacy-migration";
import {
  previewLegacyResearchMigration,
  createLegacyResearchMigration,
  decodeLegacyResearchMigrationRecord,
  restoreLegacyResearchSnapshot,
} from "../../electron/research-group/legacy-migration";
import { decodeResearchState, ResearchRepository } from "../../electron/research-group/repository";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import {
  decodeResearchLegacyMigrationCommit,
  decodeResearchLegacyMigrationIntent,
  type ResearchLegacyMigrationRecord,
} from "../../contracts/research-legacy-migration";
import type { ResearchGroupsState } from "../../contracts/research-group";

const at = "2026-11-07T05:00:00.000Z";
const model = { provider: "fixture", modelId: "project-default", thinkingLevel: "high" as const };
function legacy(count: 2 | 7 = 7): ResearchProject {
  return {
    id: randomUUID(),
    root: { workspaceId: "workspace", sessionId: "old-mentor" },
    workspacePath: "/retained-research",
    objective: "旧问题及原有限授权",
    revision: 4,
    status: "completed",
    createdAt: at,
    updatedAt: at,
    knowledge: { directory: "/retained-course", sha256: "a".repeat(64), version: "old", count: 1 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: "workspace", sessionId: `old-${role}` },
      model,
      status: "idle",
    })),
    stages: DEFAULT_RESEARCH_STAGES.slice(0, count).map((stage) => ({
      ...stage,
      title: `旧自定义 ${stage.id}`,
      goal: `不得丢失的旧目标 ${stage.id}`,
      deliverables: `旧交付 ${stage.id}`,
      models: { lead: { ...model, modelId: `old-${stage.id}`, thinkingLevel: "max" } },
    })),
    artifacts: [
      {
        id: randomUUID(),
        role: "mentor",
        kind: "review",
        revision: 4,
        round: 1,
        createdAt: at,
        content: "旧 review 的接受，只适用于旧初步方案。",
        refs: [],
        verdict: "accept",
        toolCallId: "old-call",
        stage: "review",
      },
    ],
    events: [{ id: randomUUID(), at, type: "decision", detail: "保留原裁定记录" }],
    packets: [],
    materialsDir: "/retained-materials",
    memberTokenBudget: 12345,
    finalPaper: {
      markdown: "/retained-paper.md",
      html: "/retained-paper.html",
      provenance: "/retained-paper.json",
    },
  };
}
function intent(): ResearchLegacyMigrationIntent {
  return {
    objective: "在旧方案基础上新增一项明确修改任务",
    method: {
      workflowVersion: "fusion-v2",
      entry: "materials",
      goal: "design",
      path: "quantitative",
    },
    defaultModels: Object.fromEntries(RESEARCH_ROLES.map((role) => [role, model])),
  };
}
function target(token: string): ResearchLegacyMigrationTarget {
  return {
    migrationId: randomUUID(),
    projectId: randomUUID(),
    expectedPreviewToken: token,
    root: { workspaceId: "workspace", sessionId: "new-mentor" },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: "workspace", sessionId: `new-${role}` },
      status: "idle",
    })),
    at,
    recordFile: "/retained-migrations/test.json",
  };
}

for (const count of [2, 7] as const)
  test(`${count}-stage migration keeps recoverable original and creates a paused new task without invented acceptance`, async () => {
    const source = legacy(count),
      request = intent();
    const directory = await mkdtemp(join(tmpdir(), "research-migration-"));
    const oldFile = join(directory, "old-project.json"),
      manuscript = join(directory, "old-paper.md");
    source.finalPaper!.markdown = manuscript;
    const bytes = JSON.stringify(source, null, 2);
    await writeFile(oldFile, bytes);
    await writeFile(manuscript, "原稿正文，保留事实与数值 42。\n");
    const preview = previewLegacyResearchMigration(source, request);
    expect(preview.sourceWorkflowVersion).toBe(
      count === 2 ? "legacy-two-stage" : "legacy-seven-stage",
    );
    expect(preview.stages.map((stage) => stage.id)).toEqual([
      "scan",
      "question",
      "search",
      "reading",
      "synthesis",
      "design",
      "analysis",
      "writing",
      "audit",
    ]);
    expect(preview.stages.find((stage) => stage.id === "question")).toEqual(source.stages![0]);
    expect(preview.stages[0]!.models).toEqual(request.defaultModels);
    const oldReview = preview.mappings.find((mapping) => mapping.sourceStageId === "review")!;
    expect(oldReview).toMatchObject({
      targetStageIds: [],
      kind: "history-only",
      original: source.stages![1],
    });
    expect(oldReview.note).toContain("不表示 S2–S5 已执行或接受");
    if (count === 7) {
      for (const id of ["search", "reading", "synthesis"])
        expect(preview.stages.find((stage) => stage.id === id)!.models).toEqual(
          source.stages![2]!.models,
        );
      expect(
        preview.mappings.find((mapping) => mapping.sourceStageId === "literature")!.original,
      ).toEqual(source.stages![2]);
      for (const id of ["design", "analysis", "writing", "audit"])
        expect(preview.stages.find((stage) => stage.id === id)).toEqual(
          source.stages!.find((stage) => stage.id === id),
        );
    }
    const result = createLegacyResearchMigration(source, request, target(preview.token));
    if (result.alreadyApplied) throw new Error("first migration unexpectedly reused");
    expect(result.record.sourceSnapshot).toEqual(source);
    expect(result.project).toMatchObject({
      status: "paused",
      revision: 0,
      workflowVersion: "fusion-v2",
      artifacts: [],
      analyses: [],
      events: [],
      packets: [],
    });
    expect(result.project.fusion).toBeUndefined();
    expect(result.project.entryInventory).toBeUndefined();
    expect(result.project.finalPaper).toBeUndefined();
    expect(result.project.evidence).toBeUndefined();
    expect(result.project.materialsDir).toBeUndefined();
    expect(result.record.sourceSnapshot.materialsDir).toBe(source.materialsDir);
    expect(result.project.sharedMethod!.version).toBe(result.project.methodVersion);
    expect(result.project.knowledge).toEqual(source.knowledge);
    decodeResearchState({
      version: 1,
      config: { knowledgeDir: "" },
      projects: [source, result.project],
    });
    const recordFile = join(directory, "migration.json");
    await writeFile(recordFile, JSON.stringify(result.record, null, 2));
    const restored = restoreLegacyResearchSnapshot(JSON.parse(await readFile(recordFile, "utf8")));
    expect(restored).toEqual(source);
    restored.objective = "修改恢复副本";
    expect(source.objective).toBe("旧问题及原有限授权");
    expect(JSON.stringify(source, null, 2)).toBe(bytes);
    expect(await readFile(oldFile, "utf8")).toBe(bytes);
    expect(await readFile(manuscript, "utf8")).toBe("原稿正文，保留事实与数值 42。\n");
  });

test("missing saved configuration gets minimal mapping with explicit pending checks and supports user edits", () => {
  const source = legacy();
  delete source.stages;
  const request = { ...intent(), defaultModels: {} };
  const preview = previewLegacyResearchMigration(source, request);
  expect(preview.sourceWorkflowVersion).toBe("legacy-unspecified");
  expect(preview.mappings.every((mapping) => mapping.kind === "new-default")).toBe(true);
  expect(preview.pending.map((item) => item.id)).toEqual(
    expect.arrayContaining([
      "missing-stage-config",
      "model-selection",
      "material-availability",
      "design-gates",
      "analysis-validity",
      "human-conditions",
    ]),
  );
  const edited = structuredClone(preview.stages);
  edited[2]!.title = "新任务专用检索";
  edited[2]!.models.reviewer = { ...model, modelId: "edited-reviewer" };
  const changed = previewLegacyResearchMigration(source, { ...request, stages: edited });
  expect(changed.token).not.toBe(preview.token);
  expect(changed.stages[2]).toEqual(edited[2]);
  expect(source.stages).toBeUndefined();
});

test("stale previews, running sources, reused sessions and fusion inputs fail before modifying source", () => {
  const source = legacy(),
    request = intent();
  const preview = previewLegacyResearchMigration(source, request),
    destination = target(preview.token);
  expect(() =>
    createLegacyResearchMigration({ ...source, objective: "预览之后改过" }, request, destination),
  ).toThrow("重新预览");
  expect(() =>
    createLegacyResearchMigration(source, { ...request, objective: "另一任务" }, destination),
  ).toThrow("重新预览");
  expect(() => previewLegacyResearchMigration({ ...source, status: "running" }, request)).toThrow(
    "暂停",
  );
  expect(() =>
    previewLegacyResearchMigration({ ...source, workflowVersion: "fusion-v2" }, request),
  ).toThrow();
  expect(() =>
    createLegacyResearchMigration(source, request, { ...destination, root: source.root }),
  ).toThrow("不能复用旧会话");
  expect(() =>
    createLegacyResearchMigration(source, request, { ...destination, projectId: source.id }),
  ).toThrow("独立");
  expect(source.status).toBe("completed");
  expect(source.artifacts[0]!.verdict).toBe("accept");
});

test("same migration retry returns persisted identity without returning a project that could overwrite progressed work", () => {
  const source = legacy(),
    request = intent();
  const destination = target(previewLegacyResearchMigration(source, request).token);
  const first = createLegacyResearchMigration(source, request, destination);
  const record = decodeLegacyResearchMigrationRecord(JSON.parse(JSON.stringify(first.record)));
  const retry = createLegacyResearchMigration(
    source,
    request,
    { ...destination, at: "2026-11-08T00:00:00Z" },
    record,
  );
  expect(retry).toEqual({ alreadyApplied: true, record });
  expect("project" in retry).toBe(false);
  expect(() =>
    createLegacyResearchMigration(
      source,
      request,
      { ...destination, projectId: randomUUID() },
      record,
    ),
  ).toThrow("不同请求");
  expect(() =>
    createLegacyResearchMigration(
      source,
      { ...request, objective: "另一任务" },
      destination,
      record,
    ),
  ).toThrow("不同请求");
});

test("damaged persisted recovery records fail closed instead of yielding empty or relabeled source state", () => {
  const source = legacy(),
    request = intent();
  const { record } = createLegacyResearchMigration(
    source,
    request,
    target(previewLegacyResearchMigration(source, request).token),
  );
  const broken = structuredClone(record);
  broken.sourceSnapshot.artifacts[0]!.content = "篡改原正文";
  expect(() => restoreLegacyResearchSnapshot(broken)).toThrow("摘要不一致");
  const changedMapping = structuredClone(record);
  changedMapping.preview.stages[0]!.title = "篡改映射";
  expect(() => decodeLegacyResearchMigrationRecord(changedMapping)).toThrow("摘要不一致");
  expect(() => restoreLegacyResearchSnapshot({ version: 1 })).toThrow();
  expect(restoreLegacyResearchSnapshot(record)).toEqual(source);
});

class FailingMigrationRepository extends ResearchRepository {
  failRecord = false;
  failRegistration = false;
  saves = 0;
  override async save(state: ResearchGroupsState): Promise<void> {
    this.saves += 1;
    if (this.failRegistration) throw new Error("fixture project registration failed");
    await super.save(state);
  }
  override async saveLegacyMigration(record: ResearchLegacyMigrationRecord): Promise<string> {
    if (this.failRecord) throw new Error("fixture recovery record failed");
    return super.saveLegacyMigration(record);
  }
}

async function migrationCoordinator() {
  const directory = await mkdtemp(join(tmpdir(), "research-migration-coordinator-"));
  const source = legacy();
  const repository = new FailingMigrationRepository(directory);
  await repository.save({ version: 1, config: { knowledgeDir: "" }, projects: [source] });
  const counts = { roots: 0, members: 0, deliveries: 0 };
  const host: ResearchHost = {
    createProjectRoot: async (root) => ({
      workspaceId: root.workspaceId,
      sessionId: `migration-root-${++counts.roots}`,
    }),
    createMember: async (root, role, chosenModel) => {
      counts.members += 1;
      return {
        role,
        ref: role === "mentor" ? root : { ...root, sessionId: `${root.sessionId}-${role}` },
        model: chosenModel,
        status: "idle",
      };
    },
    deliver: async () => {
      counts.deliveries += 1;
    },
    cancel: async () => {},
    changed: () => {},
  };
  const coordinator = new ResearchCoordinator(repository, host);
  await coordinator.load();
  const request = intent();
  const preview = await coordinator.previewLegacyMigration(source.root, request);
  const commit = {
    migrationId: randomUUID(),
    expectedPreviewToken: preview.token,
    intent: request,
  };
  return { source, directory, repository, host, coordinator, counts, commit };
}

test("record save failure and unavailable root creation preserve original disk bytes without dispatch", async () => {
  const f = await migrationCoordinator();
  const file = join(f.directory, "research-groups.json"),
    bytes = await readFile(file, "utf8");
  const missingHost = new ResearchCoordinator(f.repository, {
    ...f.host,
    createProjectRoot: undefined,
  });
  await missingHost.load();
  await expect(missingHost.applyLegacyMigration(f.source.root, f.commit)).rejects.toThrow(
    "尚未提供",
  );
  expect(f.counts.roots).toBe(0);
  f.repository.failRecord = true;
  await expect(f.coordinator.applyLegacyMigration(f.source.root, f.commit)).rejects.toThrow(
    "recovery record failed",
  );
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect(f.coordinator.snapshot().projects).toEqual([f.source]);
  expect(await f.repository.loadLegacyMigration(f.commit.migrationId)).toBeUndefined();
  expect(f.counts.deliveries).toBe(0);
});

test("durable record recovers a failed registration after restart and repeated apply preserves progressed target", async () => {
  const f = await migrationCoordinator();
  const file = join(f.directory, "research-groups.json"),
    original = await readFile(file, "utf8");
  f.repository.failRegistration = true;
  await expect(f.coordinator.applyLegacyMigration(f.source.root, f.commit)).rejects.toThrow(
    "registration failed",
  );
  expect(await readFile(file, "utf8")).toBe(original);
  const record = (await f.repository.loadLegacyMigration(f.commit.migrationId))!;
  expect(restoreLegacyResearchSnapshot(record)).toEqual(f.source);
  const recordFile = f.repository.legacyMigrationRecordFile(record.id),
    recordBytes = await readFile(recordFile, "utf8");
  f.repository.failRegistration = false;
  const restarted = new ResearchCoordinator(f.repository, f.host);
  await restarted.load();
  const root = await restarted.applyLegacyMigration(f.source.root, f.commit);
  expect(root).toEqual(record.createdProject.root);
  expect(f.counts).toEqual({ roots: 1, members: 4, deliveries: 0 });
  const saved = await f.repository.load();
  expect(saved.projects[0]).toEqual(f.source);
  expect(saved.projects[1]).toEqual(record.createdProject);
  saved.projects[1]!.revision = 2;
  saved.projects[1]!.objective = "新项目已经后续修改，不可被初始快照覆盖";
  await f.repository.save(saved);
  const resumed = new ResearchCoordinator(f.repository, f.host);
  await resumed.load();
  const saves = f.repository.saves,
    progressedBytes = await readFile(file, "utf8");
  expect(await resumed.applyLegacyMigration(f.source.root, f.commit)).toEqual(root);
  expect(f.repository.saves).toBe(saves);
  expect(await readFile(file, "utf8")).toBe(progressedBytes);
  expect(await readFile(recordFile, "utf8")).toBe(recordBytes);
  expect(JSON.stringify((await f.repository.load()).projects[0])).toBe(JSON.stringify(f.source));
  expect(f.counts.deliveries).toBe(0);
});

test("recovery rejects changed source authorization and occupied target without creating more sessions", async () => {
  const f = await migrationCoordinator();
  f.repository.failRegistration = true;
  await expect(f.coordinator.applyLegacyMigration(f.source.root, f.commit)).rejects.toThrow();
  f.repository.failRegistration = false;
  const record = (await f.repository.loadLegacyMigration(f.commit.migrationId))!;
  const state = await f.repository.load();
  state.projects[0]!.objective = "实际用户后来修改了旧授权";
  await f.repository.save(state);
  const stale = new ResearchCoordinator(f.repository, f.host);
  await stale.load();
  await expect(stale.applyLegacyMigration(f.source.root, f.commit)).rejects.toThrow("重新预览");
  expect((await f.repository.load()).projects).toHaveLength(1);
  state.projects[0] = f.source;
  const unrelated = structuredClone(record.createdProject);
  delete unrelated.legacyMigration;
  unrelated.objective = "其他项目占用同一目标身份";
  state.projects.push(unrelated);
  await f.repository.save(state);
  const occupied = new ResearchCoordinator(f.repository, f.host);
  await occupied.load();
  const bytes = await readFile(join(f.directory, "research-groups.json"), "utf8");
  await expect(occupied.applyLegacyMigration(f.source.root, f.commit)).rejects.toThrow(
    "已被其他课题占用",
  );
  expect(await readFile(join(f.directory, "research-groups.json"), "utf8")).toBe(bytes);
  expect(f.counts).toEqual({ roots: 1, members: 4, deliveries: 0 });
});

test("renderer-safe migration decoders reject unchecked objectives, path identities and unexpected fields", () => {
  expect(decodeResearchLegacyMigrationIntent(intent())).toEqual(intent());
  expect(() => decodeResearchLegacyMigrationIntent({ ...intent(), objective: " " })).toThrow();
  expect(() =>
    decodeResearchLegacyMigrationCommit({
      migrationId: "../escape",
      expectedPreviewToken: "a".repeat(64),
      intent: intent(),
    }),
  ).toThrow();
  expect(() =>
    decodeResearchLegacyMigrationCommit({
      migrationId: "valid",
      expectedPreviewToken: "a".repeat(64),
      intent: intent(),
      projectId: "injected",
    }),
  ).toThrow();
});

test("explicit initial start creates v1 in the four migrated sessions and preserves actual adopted evidence and objective", async () => {
  for (const mode of ["resume", "composer-addition"] as const) {
    const f = await migrationCoordinator();
    const course = join(f.directory, "course");
    await mkdir(join(course, "索引"), { recursive: true });
    await mkdir(join(course, "溯源"), { recursive: true });
    await writeFile(
      join(course, "索引", "知识块.jsonl"),
      JSON.stringify({
        id: "method",
        title: "隔离测试方法",
        text: "只审阅已提供稿件，不把缺数据写成已证实结论。",
        required_context_ids: [],
      }) + "\n",
    );
    await writeFile(join(course, "溯源", "来源清单.json"), JSON.stringify({ version: "fixture" }));
    const state = await f.repository.load();
    state.projects[0]!.workspacePath = f.directory;
    state.projects[0]!.knowledge = (await ResearchKnowledge.open(course)).pin;
    // The global template deliberately has no course/materials: the prepared task owns its pins.
    await f.repository.save(state);
    const pending: (() => void)[] = [];
    const coordinator = new ResearchCoordinator(f.repository, {
      ...f.host,
      deliver: async () => {
        f.counts.deliveries += 1;
        await new Promise<void>((resolve) => pending.push(resolve));
      },
      cancel: async () => {
        pending.splice(0).forEach((resolve) => resolve());
      },
    });
    await coordinator.load();
    const request: ResearchLegacyMigrationIntent = {
      ...intent(),
      method: {
        workflowVersion: "fusion-v2",
        entry: "manuscript",
        goal: "task",
        task: { kind: "manuscript-review", scope: "仅审阅所提供稿件的结构和推断边界" },
      },
    };
    const preview = await coordinator.previewLegacyMigration(f.source.root, request);
    const root = await coordinator.applyLegacyMigration(f.source.root, {
      migrationId: randomUUID(),
      expectedPreviewToken: preview.token,
      intent: request,
    });
    expect(coordinator.projectFor(root)!.revision).toBe(0);
    const manuscript = join(f.directory, `supplied-${mode}.txt`);
    await writeFile(
      manuscript,
      "题目：课堂论证观察\n本稿只提出研究方案，尚无原始数据和支持原文；请审阅结构与推断边界。\n",
    );
    await coordinator.importMaterials(root, [manuscript]);
    const imported = coordinator.projectFor(root)!.importedMaterials![0]!;
    await coordinator.adoptMaterial(root, imported.id, {
      category: "manuscript",
      sourceDescription: "用户实际提供的隔离测试稿件，允许本次范围内审阅。",
    });
    await coordinator.inspectMaterials(root);
    const before = structuredClone(coordinator.projectFor(root)!);
    expect(before.evidence!.directory).toBe("");
    expect(before.evidence!.sources).toHaveLength(1);
    expect(before.fusion).toBeUndefined();
    expect(f.counts).toEqual({ roots: 1, members: 4, deliveries: 0 });
    try {
      if (mode === "resume") await coordinator.resume(root);
      else await coordinator.start(root, f.directory, "启动补充：保持题目不变，只检查方法段。");
      const started = coordinator.projectFor(root)!;
      expect(started.revision).toBe(1);
      expect(started.members.map((member) => member.ref)).toEqual(
        before.members.map((member) => member.ref),
      );
      expect(started.evidence).toEqual(before.evidence);
      expect(started.entryInventory?.canStart).toBe(true);
      expect(started.artifacts).toEqual([]);
      expect(started.objective).toBe(
        mode === "resume"
          ? request.objective
          : `${request.objective}\n\n新修改任务启动时的补充（以新要求为准）：\n启动补充：保持题目不变，只检查方法段。`,
      );
      // M3 blocks a single-task launch until the user pins the actual supplied text.
      expect(f.counts.deliveries).toBe(0);
      await coordinator.pause(root);
      const source = coordinator.projectFor(root)!.evidence!.sources[0]!;
      await coordinator.applyM3Action(root, {
        operation: "preview-task-source",
        sourceId: source.id,
      });
      const body = coordinator.projectFor(root)!.m3!.scopePreview!.body;
      await coordinator.applyM3Action(root, {
        operation: "task-scope",
        sourceId: source.id,
        sourceSha256: source.sha256,
        ranges: [{ start: 0, end: body.length, label: "已提供稿件的有限审阅" }],
      });
      await coordinator.resume(root);
      await expect.poll(() => f.counts.deliveries).toBeGreaterThan(0);
      expect(
        coordinator
          .projectFor(root)!
          .fusion!.attempts.every((attempt) => attempt.taskId.startsWith("v1:")),
      ).toBe(true);
      await expect(coordinator.resume(root)).rejects.toThrow("只有暂停");
      expect(coordinator.projectFor(root)!.revision).toBe(1);
      expect(f.counts.roots).toBe(1);
      expect(f.counts.members).toBe(4);
    } finally {
      await coordinator.pause(root);
    }
  }
});
