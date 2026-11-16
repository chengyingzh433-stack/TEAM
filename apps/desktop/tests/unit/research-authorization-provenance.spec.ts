import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchRepository, decodeResearchState } from "../../electron/research-group/repository";
import {
  requestResearchDecision,
  researchDecisionStatus,
} from "../../electron/research-group/task-graph";
import { decodeResearchDecisionRequestInput } from "../../contracts/research-decision-request";
import { decodeResearchInputHistory } from "../../contracts/research-input-history";
import {
  decodeResearchTaskReuseDecisionInput,
  projectResearchDecisionReuse,
  validateResearchDecisionReuse,
} from "../../contracts/research-decision-reuse";
import {
  decodeResearchTaskGraph,
  type ResearchTaskDecision,
} from "../../contracts/research-task-graph";
import { researchDecisionReplyIdentity } from "../../contracts/research-task-controls";

const at = "2026-11-07T12:00:00.000Z";
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "research-authorization-"));
  const kb = join(directory, "knowledge"),
    workspace = join(directory, "workspace");
  await Promise.all([
    mkdir(join(kb, "索引"), { recursive: true }),
    mkdir(join(kb, "溯源"), { recursive: true }),
    mkdir(workspace),
  ]);
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "AUTH-METHOD",
      title: "研究设计",
      text: "测试方法；授权上下文不等于已选择条件或伦理审批。",
      required_context_ids: [],
    }),
  );
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "fixture" }));
  const repository = new ResearchRepository(directory);
  const host: ResearchHost = {
    createMember: async (root, role, model) => ({
      role,
      model,
      ref: { workspaceId: root.workspaceId, sessionId: role },
      status: "idle",
    }),
    deliver: async () => {
      throw new Error("This paused fixture must not dispatch a provider");
    },
    cancel: async () => {},
    changed: () => {},
  };
  const coordinator = new ResearchCoordinator(repository, host);
  await coordinator.load();
  await coordinator.configure({
    knowledgeDir: kb,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "manuscript",
    goal: "design",
    path: "quantitative",
    scope: "paper",
  });
  const root = { workspaceId: workspace, sessionId: "mentor" };
  const input =
    "已授权使用本次公共二手材料进行探索，当前只审阅方案，不联系学生、不干预、不投稿；这不是伦理审批。";
  await coordinator.start(root, workspace, input);
  expect(coordinator.snapshot().projects[0]!.status).toBe("paused");
  const snapshot = () => coordinator.snapshot().projects[0]!;
  const addRequests = async () => {
    const state = coordinator.snapshot(),
      p = state.projects[0]!;
    for (const [id, role] of [
      ["source", "lead"],
      ["target", "reviewer"],
      ["other", "librarian"],
    ] as const)
      p.fusion = requestResearchDecision(p.fusion!, {
        id,
        inputId: `human-condition:${id}`,
        version: 1,
        at,
        requestedBy: "agent:mentor",
        question: `${id}具体工作是否继续？`,
        context: "独立测试条件；不得由原始任务说明自动选择。",
        impact: `仅${role}的指定任务`,
        taskIds: [`v1:design:${role}`],
        options: [
          { id: "yes", label: "按此范围继续", consequence: "只解除指定条件", outcome: "confirmed" },
          { id: "no", label: "不继续", consequence: "保持等待", outcome: "declined" },
        ],
        recommendedOptionId: "yes",
      });
    await repository.save(state);
    await coordinator.load();
  };
  return { coordinator, repository, root, workspace, input, snapshot, addRequests };
}

test("real submits preserve separate immutable input contexts without confirming a condition", async () => {
  const s = await setup(),
    first = s.snapshot().inputHistory![0]!;
  expect(first).toMatchObject({
    revision: 1,
    text: s.input,
    source: { kind: "explicit-submit", actionRef: `user-input:${first.id}` },
  });
  expect(s.snapshot().fusion!.decisions).toEqual([]);
  const next = "补充：仅修改已有方案的变量说明，仍然没有实际数据。";
  await s.coordinator.start(s.root, s.workspace, next);
  expect(s.snapshot().inputHistory).toHaveLength(2);
  expect(s.snapshot().inputHistory![0]).toEqual(first);
  expect(s.snapshot().inputHistory![1]).toMatchObject({
    revision: 2,
    text: next,
    source: { kind: "explicit-submit" },
  });
  expect(s.snapshot().inputHistory![1]!.text).not.toContain(s.input);
  await s.coordinator.load();
  expect(s.snapshot().inputHistory![0]).toEqual(first);
  expect(s.snapshot().fusion!.decisions).toEqual([]);
  expect(() => decodeResearchInputHistory([{ ...first, outcome: "confirmed" }])).toThrow();
  expect(() =>
    decodeResearchInputHistory([{ ...first, source: { kind: "model-summary" } }]),
  ).toThrow();
});

test("resuming a prepared migration traces its existing intent instead of inventing a fresh user submit", async () => {
  const s = await setup(),
    state = s.coordinator.snapshot(),
    p = state.projects[0]!;
  p.revision = 0;
  p.fusion = undefined;
  p.inputHistory = undefined;
  p.legacyMigration = {
    id: "migration-fixture",
    sourceProjectId: "11111111-1111-4111-8111-111111111111",
    recordFile: join(s.workspace, "migration-record.json"),
  };
  await writeFile(
    p.legacyMigration.recordFile,
    JSON.stringify({ fixture: true, intent: { objective: p.objective } }),
  );
  await s.repository.save(state);
  await s.coordinator.load();
  await s.coordinator.resume(s.root);
  expect(s.snapshot().inputHistory).toHaveLength(1);
  expect(s.snapshot().inputHistory![0]!.source).toEqual({
    kind: "existing-migration",
    migrationId: "migration-fixture",
    recordFile: p.legacyMigration.recordFile,
  });
  expect(s.snapshot().fusion!.decisions).toEqual([]);
  expect(() =>
    decodeResearchState({
      ...s.coordinator.snapshot(),
      projects: [{ ...s.snapshot(), legacyMigration: { ...p.legacyMigration, id: "other" } }],
    }),
  ).toThrow("迁移出处");
});

test("host maps an actual confirmed user choice with a distinct action and preserves its source", async () => {
  const s = await setup();
  await s.addRequests();
  expect(projectResearchDecisionReuse(s.snapshot().fusion!, "target").candidates).toEqual([]);
  await s.coordinator.answerDecision(s.root, {
    requestId: "source",
    optionId: "yes",
    text: "我确认只进行这项公开材料核查。",
  });
  const original = structuredClone(s.snapshot().fusion!.decisions[0]!);
  const view = projectResearchDecisionReuse(s.snapshot().fusion!, "target");
  expect(view.candidates.map((item) => item.decision.id)).toEqual([original.id]);
  expect(researchDecisionStatus(s.snapshot().fusion!, "target")).toBe("pending");
  await s.coordinator.reuseDecision(s.root, {
    requestId: "target",
    optionId: "yes",
    sourceDecisionId: original.id,
    expectedContextToken: view.token,
  });
  const after = s.snapshot().fusion!,
    mapped = after.decisions.at(-1)!;
  expect(after.decisions[0]).toEqual(original);
  expect(mapped).toMatchObject({
    actor: "user",
    origin: "prior-authorization",
    sourceDecisionId: original.id,
    requestId: "target",
    optionId: "yes",
    outcome: "confirmed",
  });
  expect(mapped.id).not.toBe(original.id);
  expect(mapped.evidenceRef).toBe(`user-action:${mapped.id}`);
  expect(researchDecisionReplyIdentity(mapped)).toBe("用户明确沿用既有决定");
  expect(researchDecisionStatus(after, "target")).toBe("confirmed");
  expect(researchDecisionStatus(after, "other")).toBe("pending");
  await s.coordinator.load();
  expect(s.snapshot().fusion!.decisions).toEqual(after.decisions);
  expect(
    projectResearchDecisionReuse(s.snapshot().fusion!, "other").candidates.map(
      (item) => item.decision.id,
    ),
  ).toEqual([original.id, mapped.id]);
  const corrupted = structuredClone(after);
  corrupted.decisions.at(-1)!.sourceDecisionId = "missing-origin";
  expect(() => decodeResearchTaskGraph(corrupted)).toThrow("在先用户选择");
  const originalRequest = after.decisionRequests!.find((item) => item.id === "source")!;
  const { affectedTaskIds: _affected, ...request } = originalRequest;
  const changed = requestResearchDecision(after, {
    ...request,
    id: "source-new-condition",
    version: 2,
  });
  // Historical mappings survive, but a superseded source cannot authorize another mapping.
  expect(decodeResearchTaskGraph(changed).decisions).toEqual(after.decisions);
  expect(projectResearchDecisionReuse(changed, "other").candidates).toEqual([]);
});

test("stale scope and invalid sources reject before host mutation; another user's actual answer remains", async () => {
  const s = await setup();
  await s.addRequests();
  await s.coordinator.answerDecision(s.root, {
    requestId: "source",
    optionId: "yes",
    text: "确认原范围。",
  });
  const source = s.snapshot().fusion!.decisions[0]!,
    view = projectResearchDecisionReuse(s.snapshot().fusion!, "target");
  const input = {
    requestId: "target",
    optionId: "yes",
    sourceDecisionId: source.id,
    expectedContextToken: view.token,
  };
  await s.coordinator.answerDecision(s.root, {
    requestId: "other",
    optionId: "no",
    text: "另一范围暂不允许。",
  });
  const before = s.snapshot();
  await expect(s.coordinator.reuseDecision(s.root, input)).rejects.toThrow("已变化");
  expect(s.snapshot()).toEqual(before);
  const fresh = {
    ...input,
    expectedContextToken: projectResearchDecisionReuse(before.fusion!, "target").token,
  };
  await expect(
    s.coordinator.reuseDecision(s.root, { ...fresh, sourceDecisionId: "invented-user-approval" }),
  ).rejects.toThrow("来源");
  await expect(s.coordinator.reuseDecision(s.root, { ...fresh, optionId: "no" })).rejects.toThrow(
    "明确允许继续",
  );
  expect(s.snapshot()).toEqual(before);
});

test("model statements, raw user text, superseded choices and unproven old authorizations are not reusable", async () => {
  const s = await setup();
  await s.addRequests();
  await s.coordinator.answerDecision(s.root, {
    requestId: "source",
    optionId: "yes",
    text: "明确确认。",
  });
  const graph = s.snapshot().fusion!;
  const variants: Partial<ResearchTaskDecision>[] = [
    { actor: "mentor-agent" },
    { outcome: "declined" },
    { origin: undefined },
    { origin: "prior-authorization", sourceDecisionId: undefined },
    { requestId: undefined, optionId: undefined },
    { version: 9 },
    { evidenceRef: "model-quoted-user-sentence" },
  ];
  for (const patch of variants) {
    const changed = structuredClone(graph);
    Object.assign(changed.decisions[0]!, patch);
    expect(projectResearchDecisionReuse(changed, "target").candidates).toEqual([]);
  }
  const oldRequest = graph.decisionRequests!.find((item) => item.id === "source")!;
  const { affectedTaskIds: _affected, ...fields } = oldRequest;
  const changed = requestResearchDecision(graph, {
    ...fields,
    id: "source-v2",
    version: 2,
    question: "发生实际范围变化后是否允许？",
  });
  expect(projectResearchDecisionReuse(changed, "target").candidates).toEqual([]);
  const view = projectResearchDecisionReuse(graph, "target");
  expect(() =>
    validateResearchDecisionReuse(changed, {
      requestId: "target",
      optionId: "yes",
      sourceDecisionId: graph.decisions[0]!.id,
      expectedContextToken: view.token,
    }),
  ).toThrow("已变化");
  expect(() =>
    decodeResearchTaskReuseDecisionInput({
      requestId: "target",
      optionId: "yes",
      sourceDecisionId: graph.decisions[0]!.id,
      expectedContextToken: view.token,
      actor: "user",
    }),
  ).toThrow("未知字段");
  expect(() =>
    decodeResearchDecisionRequestInput({
      conditionId: "model-cannot-reuse",
      ...fields,
      sourceDecisionId: graph.decisions[0]!.id,
    }),
  ).toThrow("越权字段");
  expect(decodeResearchTaskGraph(graph)).toEqual(graph);
});
