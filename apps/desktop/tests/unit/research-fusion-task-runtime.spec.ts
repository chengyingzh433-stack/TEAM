import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ResearchProject } from "../../contracts/research-group";
import { RESEARCH_ROLES } from "../../contracts/research-group";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { decodeResearchState, ResearchRepository } from "../../electron/research-group/repository";
import {
  activeFusionAttempt,
  bindFusionNativeRun,
  dispatchFusionAttempt,
  ensureFusionStageTasks,
  finishFusionNativeRun,
  fusionRoleStage,
  fusionDeliveryBlockReason,
  prepareFusionDelivery,
  publishFusionArtifact,
  resumeCancelledFusionTasks,
  failFusionAttempt,
  resumableFusionTasks,
  reconcileUnstartedFusionEntry,
} from "../../electron/research-group/fusion-task-runtime";
import {
  pauseResearchTasks,
  resumeResearchTasks,
  requestResearchTaskContinuation,
} from "../../electron/research-group/task-graph";
import { planFusionContinuations } from "../../electron/research-group/fusion-resume-plan";

const at = "2026-11-07T10:00:00.000Z";
function project(): ResearchProject {
  return {
    id: randomUUID(),
    root: { workspaceId: "workspace", sessionId: "mentor" },
    workspacePath: "/tmp/fusion-unit",
    objective: "研究物理实验报告中的证据使用",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    currentStage: "design",
    goal: "paper",
    path: "quantitative",
    knowledge: { directory: "/tmp/course", sha256: "a".repeat(64), version: "test", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: "workspace", sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
    evidence: { directory: "/tmp", sources: [], datasets: [] },
  };
}

test("mailbox readiness preserves the original per-member cap and unknown reservations without mutating history", () => {
  const p = project();
  p.memberTokenBudget = 8_000_000;
  const first = prepareFusionDelivery(p, "reviewer", "budget-original", at, "原始独立判断");
  dispatchFusionAttempt(p, first.attemptId!, at);
  bindFusionNativeRun(p, "reviewer", "budget-original-native");
  finishFusionNativeRun(p, "reviewer", "budget-original-native", at, {
    input: 2_000_000,
    output: 1_000,
    cacheRead: 5_999_000,
    cacheWrite: 0,
  });
  const before = structuredClone(p);
  expect(fusionDeliveryBlockReason(p, "reviewer", "新稿请复核")).toContain("剩余额度不足");
  expect(p).toEqual(before);
  expect(prepareFusionDelivery(p, "reviewer", "blocked-new", at, "新稿请复核")).toMatchObject({
    kind: "blocked",
    reason: expect.stringContaining("剩余额度不足"),
  });
  expect(p.fusion!.attempts).toEqual(before.fusion!.attempts);
  expect(p.fusion!.tasks.find((task) => task.role === "reviewer")!.continuations).toEqual([]);
  const unresolved = project();
  unresolved.memberTokenBudget = 8_000_000;
  const pending = prepareFusionDelivery(unresolved, "reviewer", "unknown-original", at, "原请求");
  dispatchFusionAttempt(unresolved, pending.attemptId!, at);
  unresolved.fusion!.attempts[0]!.state = "unknown";
  const prior = structuredClone(unresolved);
  expect(fusionDeliveryBlockReason(unresolved, "reviewer", "不能重放")).toContain("结果未知");
  expect(unresolved).toEqual(prior);
});

test("explicit resume can continue a known successful native turn with no published artifact, without automatic replay", () => {
  const p = project();
  p.goal = "design";
  ensureFusionStageTasks(p, at);
  const first = prepareFusionDelivery(p, "lead", "finished-without-publish", at, "交付方案");
  dispatchFusionAttempt(p, first.attemptId!, at);
  bindFusionNativeRun(p, "lead", "native-without-publish");
  finishFusionNativeRun(p, "lead", "native-without-publish", at);
  const taskId = "v1:design:lead";
  expect(p.fusion!.attempts.find((attempt) => attempt.id === first.attemptId)!.state).toBe(
    "succeeded",
  );
  expect(p.fusion!.tasks.find((task) => task.id === taskId)!.state).toBe("pending");
  expect(p.fusion!.artifacts).toEqual([]);
  expect(resumableFusionTasks(p).some((task) => task.taskId === taskId)).toBe(false);
  p.fusion = resumeResearchTasks(pauseResearchTasks(p.fusion!));
  const before = structuredClone(p);
  const plans = planFusionContinuations(p);
  expect(plans).toEqual([
    expect.objectContaining({
      taskId,
      role: "lead",
      stage: "design",
      id: expect.stringContaining(first.attemptId!),
      reason: expect.stringContaining("用户显式恢复"),
    }),
  ]);
  const reloaded = decodeResearchState(
    JSON.parse(JSON.stringify({ version: 1, config: { knowledgeDir: "" }, projects: [p] })),
  );
  expect(planFusionContinuations(reloaded.projects[0]!)).toEqual(plans);
  expect(p).toEqual(before);
  for (const plan of plans)
    p.fusion = requestResearchTaskContinuation(p.fusion!, plan.taskId, {
      id: plan.id,
      at,
      reason: plan.reason,
    });
  expect(planFusionContinuations(p)).toEqual([]);
  expect(resumableFusionTasks(p).some((task) => task.taskId === taskId)).toBe(true);
  const resumed = prepareFusionDelivery(p, "lead", "explicit-next-turn", at, "显式恢复未交付工作");
  expect(resumed.kind).toBe("dispatch");
  expect(p.fusion!.tasks.find((task) => task.id === taskId)!.continuations).toEqual([
    { id: plans[0]!.id, at, reason: plans[0]!.reason, attemptId: resumed.attemptId },
  ]);
  expect(planFusionContinuations(p)).toEqual([]);
  dispatchFusionAttempt(p, resumed.attemptId!, at);
  bindFusionNativeRun(p, "lead", "native-second-empty");
  finishFusionNativeRun(p, "lead", "native-second-empty", at);
  expect(resumableFusionTasks(p).some((task) => task.taskId === taskId)).toBe(false);
  expect(planFusionContinuations(p)[0]!.id).not.toBe(plans[0]!.id);
  expect(p.fusion!.artifacts).toEqual([]);
});

test("empty-turn resume rejects obsolete inputs, unsettled execution and existing delivery", () => {
  const original = project();
  original.goal = "design";
  ensureFusionStageTasks(original, at);
  const first = prepareFusionDelivery(original, "lead", "empty-turn", at, "交付方案");
  dispatchFusionAttempt(original, first.attemptId!, at);
  bindFusionNativeRun(original, "lead", "native-empty");
  finishFusionNativeRun(original, "lead", "native-empty", at);
  expect(planFusionContinuations(original)).toHaveLength(1);
  for (const invalid of [
    "old-revision",
    "old-version",
    "unadopted-input",
    "changed-input",
    "acquired-input",
    "prepared",
    "running",
    "unknown",
    "failed",
    "cancelled",
    "task-failed",
    "task-cancelled",
    "role-active",
    "delivery",
    "completed-project",
  ] as const) {
    const p = structuredClone(original);
    const graph = p.fusion!;
    const task = graph.tasks.find((t) => t.id === "v1:design:lead")!;
    const attempt = graph.attempts.find((a) => a.id === first.attemptId)!;
    if (invalid === "old-revision") p.revision++;
    else if (invalid === "old-version") task.inputVersion++;
    else if (invalid === "unadopted-input") graph.adoptedInputs = [];
    else if (invalid === "changed-input") attempt.inputRefs = [];
    else if (invalid === "acquired-input")
      attempt.acquiredInputs = [
        { inputId: "withdrawn", version: 1, at, evidenceRef: "read:withdrawn" },
      ];
    else if (invalid === "task-failed") task.state = "failed";
    else if (invalid === "task-cancelled") task.state = "cancelled";
    else if (invalid === "completed-project") p.status = "completed";
    else if (invalid === "role-active") {
      graph.tasks.push({ ...structuredClone(task), id: "v0:design:lead" });
      graph.attempts.push({
        ...structuredClone(attempt),
        id: "other-running",
        taskId: "v0:design:lead",
        state: "running",
      });
    } else if (invalid === "delivery") {
      graph.artifacts.push({
        id: "existing-delivery",
        taskId: task.id,
        taskVersion: task.inputVersion,
        attemptId: attempt.id,
        createdAt: at,
        content: "实际交付",
        inputRefs: attempt.inputRefs,
        dependencyArtifactIds: [],
        interim: false,
        reviewState: "accepted",
        reviews: [],
      });
      task.currentArtifactId = "existing-delivery";
    } else attempt.state = invalid;
    const before = structuredClone(p);
    expect(planFusionContinuations(p), invalid).toEqual([]);
    expect(p, invalid).toEqual(before);
  }
});

test("fusion dispatch freezes a role stage while other members can enter the next accepted stage", () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  const old = prepareFusionDelivery(p, "librarian", "library-run", at, "继续提供材料");
  expect(old.kind).toBe("dispatch");
  dispatchFusionAttempt(p, old.attemptId!, at);
  bindFusionNativeRun(p, "librarian", "native-library");
  const mentor = prepareFusionDelivery(p, "mentor", "mentor-run", at, "裁定方案");
  dispatchFusionAttempt(p, mentor.attemptId!, at);
  publishFusionArtifact(p, {
    id: "design-accept",
    role: "mentor",
    kind: "stage-review",
    revision: 1,
    round: 0,
    createdAt: at,
    content: "方案可接受；数据尚待提供。",
    refs: [],
    verdict: "accept",
    stage: "design",
    toolCallId: "tool-accept",
  });
  p.currentStage = "analysis";
  expect(fusionRoleStage(p, "librarian")).toBe("design");
  expect(prepareFusionDelivery(p, "librarian", "next-library", at, "下一阶段材料").kind).toBe(
    "blocked",
  );
  expect(prepareFusionDelivery(p, "lead", "analysis-run", at, "实际计算")).toMatchObject({
    kind: "blocked",
  });
  expect(
    prepareFusionDelivery(p, "reviewer", "reviewer-preflight", at, "先核查分析方案").kind,
  ).toBe("dispatch");
  finishFusionNativeRun(p, "librarian", "native-library", at, {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 0,
  });
  expect(activeFusionAttempt(p, "librarian")).toBeUndefined();
  expect(prepareFusionDelivery(p, "librarian", "next-library", at, "下一阶段材料").kind).toBe(
    "dispatch",
  );
  expect(p.fusion?.attempts.find((a) => a.id === "library-run")).toMatchObject({
    usedTokens: 60,
    sessionTotalTokens: 60,
    nativeRunId: "native-library",
  });
});

test("single design review creates only the required role tasks at its bounded stage", () => {
  const p = project();
  p.entry = "task";
  p.goal = "task";
  p.task = { kind: "design-review", scope: "只核查既有方案的G3定义，不启动全研究。" };
  ensureFusionStageTasks(p, at);
  expect(p.fusion!.tasks.map((task) => task.role).sort()).toEqual(["lead", "mentor", "reviewer"]);
  expect(p.fusion!.tasks.every((task) => task.stage === "design")).toBe(true);
  expect(p.members).toHaveLength(4);
});

test("actual inventory can relocate an unstarted materials entry without dispatching or accepting obsolete question placeholders", () => {
  const p = project();
  p.entry = "materials";
  p.goal = "design";
  p.currentStage = "question";
  ensureFusionStageTasks(p, at);
  p.entryInventory = {
    revision: 1,
    checkedAt: at,
    firstMissingStage: "design",
    canStart: true,
    evidenceRef: "actual-inventory:fixture",
    reusable: ["实际方案"],
    pending: [],
    missing: [],
    limitations: [],
  };
  p.currentStage = "design";
  reconcileUnstartedFusionEntry(p);
  ensureFusionStageTasks(p, at);
  expect(
    p
      .fusion!.tasks.filter((task) => task.stage === "question")
      .every((task) => task.state === "cancelled"),
  ).toBe(true);
  expect(resumableFusionTasks(p).map((task) => task.stage)).toEqual([
    "design",
    "design",
    "design",
    "design",
  ]);
  expect(p.fusion!.artifacts).toEqual([]);
  expect(p.fusion!.attempts).toEqual([]);
  // A later real inventory can restore a never-dispatched placeholder; no accepted history is manufactured.
  p.entryInventory.firstMissingStage = "question";
  p.currentStage = "question";
  reconcileUnstartedFusionEntry(p);
  ensureFusionStageTasks(p, at);
  expect(
    p
      .fusion!.tasks.filter((task) => task.stage === "question")
      .every((task) => task.state === "pending"),
  ).toBe(true);
});

test("explicit resume continues confirmed cancellation with saved partial work, leaving failed and unknown executions alone", () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  for (const role of RESEARCH_ROLES) {
    const prepared = prepareFusionDelivery(p, role, `attempt-${role}`, at, "未完成任务");
    expect(prepared.kind).toBe("dispatch");
    dispatchFusionAttempt(p, prepared.attemptId!, at);
    bindFusionNativeRun(p, role, `native-${role}`);
  }
  publishFusionArtifact(p, {
    id: "partial",
    role: "lead",
    kind: "stage-draft",
    revision: 1,
    round: 0,
    createdAt: at,
    content: "取消前已交初稿，后续修订尚未完成。",
    refs: [],
    stage: "design",
    toolCallId: "partial-call",
  });
  const saved = structuredClone(p.fusion!.artifacts);
  p.fusion = pauseResearchTasks(p.fusion!);
  finishFusionNativeRun(p, "lead", "native-lead", at, undefined, true);
  failFusionAttempt(p, "reviewer", "真实提供商错误，需单项恢复", at);
  finishFusionNativeRun(p, "librarian", "native-librarian", at);
  // A still-running mentor is deliberately unresolved, not assumed cancelled by the UI action.
  p.fusion = resumeResearchTasks(p.fusion!);
  expect(resumableFusionTasks(p).some((task) => task.role === "lead")).toBe(false);
  resumeCancelledFusionTasks(p, at, "user-resume:fixture");
  expect(resumableFusionTasks(p).some((task) => task.role === "lead")).toBe(true);
  expect(p.fusion!.tasks.find((task) => task.role === "reviewer")!.state).toBe("failed");
  expect(p.fusion!.attempts.find((attempt) => attempt.id === "attempt-mentor")!.state).toBe(
    "running",
  );
  expect(p.fusion!.retryRequests).toHaveLength(1);
  expect(p.fusion!.artifacts).toEqual(saved);
  const once = structuredClone(p.fusion);
  resumeCancelledFusionTasks(p, "2026-11-07T11:00:00.000Z", "user-resume:fixture-again");
  expect(p.fusion).toEqual(once);
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "lancer-fusion-runtime-"));
  const knowledgeDir = join(directory, "knowledge"),
    workspace = join(directory, "workspace");
  await Promise.all([
    mkdir(join(knowledgeDir, "索引"), { recursive: true }),
    mkdir(join(knowledgeDir, "溯源"), { recursive: true }),
    mkdir(workspace),
  ]);
  await writeFile(
    join(knowledgeDir, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "M1",
      title: "研究方法",
      text: "单元测试方法条目，不代表真实课程。",
      required_context_ids: [],
    }) + "\n",
  );
  await writeFile(
    join(knowledgeDir, "溯源", "来源清单.json"),
    JSON.stringify({ version: "fixture" }),
  );
  const sent: string[] = [],
    cancelled: string[] = [],
    release = new Map<string, () => void>();
  const repository = new ResearchRepository(directory);
  const host: ResearchHost = {
    createMember: async (root, role, model) => ({
      role,
      model,
      status: "idle",
      ref: { workspaceId: root.workspaceId, sessionId: role },
    }),
    deliver: async (ref) => {
      // Observe real persisted bytes before the host is allowed to execute.
      const persisted = await repository.load();
      const attempt = activeFusionAttempt(persisted.projects[0]!, ref.sessionId as "lead");
      expect(attempt?.state).toBe("running");
      expect(attempt?.dispatchedAt).toBeTruthy();
      sent.push(ref.sessionId);
      await new Promise<void>((resolve) => release.set(ref.sessionId, resolve));
    },
    cancel: async (ref) => {
      cancelled.push(ref.sessionId);
      release.get(ref.sessionId)?.();
    },
    changed: () => {},
  };
  const coordinator = new ResearchCoordinator(repository, host);
  await coordinator.load();
  await coordinator.configure({
    knowledgeDir,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
    path: "quantitative",
    memberTokenBudget: 100_000,
  });
  const root = { workspaceId: workspace, sessionId: "mentor" };
  await coordinator.start(
    root,
    workspace,
    "研究真实课堂实验报告中的论证表现，只完成方案。测试材料不表示真实课堂数据。",
  );
  await expect.poll(() => sent.length).toBe(4);
  return { directory, coordinator, repository, root, host, sent, cancelled, release };
}

test("coordinator persists attempts before delivery and a member failure leaves other roles running", async () => {
  const s = await setup();
  // A native failure belongs to the actual run admitted after this attempt, not an
  // arbitrary old timestamp/run ID (which the stale-event guard must reject).
  for (const member of s.coordinator.snapshot().projects[0]!.members) {
    const timestamp = new Date().toISOString();
    s.coordinator.onSessionEvent({
      type: "sessionUpdated",
      sessionRef: member.ref,
      timestamp,
      runId: `native-${member.role}`,
      snapshot: {
        ref: member.ref,
        workspace: { workspaceId: s.root.workspaceId, path: s.root.workspaceId },
        title: member.role,
        status: "running",
        updatedAt: timestamp,
      },
    });
  }
  await s.coordinator.flush();
  s.coordinator.onSessionEvent({
    type: "runFailed",
    sessionRef: { ...s.root, sessionId: "librarian" },
    timestamp: new Date().toISOString(),
    runId: "native-librarian",
    error: { message: "deterministic local failure" },
  });
  await s.coordinator.flush();
  const p = s.coordinator.snapshot().projects[0]!;
  expect(p.status).toBe("running");
  expect(p.fusion?.tasks.find((t) => t.role === "librarian")?.state).toBe("failed");
  expect(p.fusion?.attempts.filter((a) => a.state === "running")).toHaveLength(3);
  expect(s.cancelled).toHaveLength(0);
  expect(p.fusion?.attempts.find((a) => a.state === "failed")?.usedTokens).toBeUndefined();
  await s.coordinator.pause(s.root);
});

test("coordinator restart retains unknown attempts and explicit resume does not replay their requests", async () => {
  const s = await setup();
  await s.coordinator.pause(s.root);
  const restored = new ResearchCoordinator(s.repository, s.host);
  await restored.load();
  expect(
    restored.snapshot().projects[0]?.fusion?.attempts.every((a) => a.state === "unknown"),
  ).toBe(true);
  await restored.resume(s.root);
  await restored.flush();
  await restored.flush();
  expect(s.sent).toHaveLength(4);
  const graph = restored.snapshot().projects[0]!.fusion!;
  expect(graph.attempts).toHaveLength(4);
  expect(graph.tasks.every((t) => t.blockers.some((b) => b.kind === "attempt"))).toBe(true);
  const persisted = JSON.parse(
    await readFile(join(s.directory, "research-groups.json"), "utf8"),
  ) as { projects: ResearchProject[] };
  expect(persisted.projects[0]?.fusion?.attempts.every((a) => a.usedTokens === undefined)).toBe(
    true,
  );
  await restored.pause(s.root);
});

test("model decision requests remain local, reuse actual answers and reject forged authorization", async () => {
  const s = await setup();
  try {
    const decision = {
      conditionId: "classroom-material-use",
      question: "这份课堂材料是否获准用于本研究？",
      context: "仅有待确认的材料用途，不代表已经获准。",
      impact: "仅限制研究者A的相关任务；其他成员继续。",
      taskIds: ["v1:question:lead"],
      options: [
        { id: "yes", label: "已获准", consequence: "记录答复后继续", outcome: "confirmed" },
        { id: "later", label: "稍后核实", consequence: "继续等待", outcome: "deferred" },
      ],
      recommendedOptionId: "later",
    };
    await s.coordinator.tool(s.root, "request-condition", {
      operation: "request-decision",
      decision,
    });
    const before = s.coordinator.snapshot().projects[0]!.fusion!;
    const request = before.decisionRequests![0]!;
    expect(request.requestedBy).toBe("agent:mentor");
    expect(before.decisions).toHaveLength(0);
    expect(before.tasks.find((task) => task.role === "lead")?.state).toBe("waiting-user");
    expect(
      before.tasks.filter((task) => task.role !== "lead").every((task) => task.state === "running"),
    ).toBe(true);
    await expect(
      s.coordinator.tool(s.root, "forged-answer", {
        operation: "request-decision",
        decision: { ...decision, actor: "user" },
      }),
    ).rejects.toThrow("越权字段");
    await s.coordinator.answerDecision(s.root, {
      requestId: request.id,
      optionId: "later",
      text: "尚未确认",
    });
    await s.coordinator.tool(s.root, "request-again", { operation: "request-decision", decision });
    const after = s.coordinator.snapshot().projects[0]!.fusion!;
    expect(after.decisionRequests).toHaveLength(1);
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]).toMatchObject({
      actor: "user",
      outcome: "deferred",
      origin: "new-reply",
    });
    expect(s.sent).toHaveLength(4);
    await expect(
      s.coordinator.tool(s.root, "foreign-task", {
        operation: "request-decision",
        decision: { ...decision, taskIds: ["v99:question:lead"] },
      }),
    ).rejects.toThrow("当前输入");
    const persisted = await s.repository.load();
    expect(persisted.projects[0]!.fusion!.decisions).toEqual(after.decisions);
  } finally {
    await s.coordinator.pause(s.root);
  }
});

test("new implementation material invalidates all analysis roles and downstream reviews but preserves design", () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  const mentor = prepareFusionDelivery(p, "mentor", "accepted-design", at, "审阅方案");
  dispatchFusionAttempt(p, mentor.attemptId!, at);
  publishFusionArtifact(p, {
    id: "accepted-plan",
    role: "mentor",
    kind: "stage-review",
    revision: 1,
    round: 0,
    createdAt: at,
    content: "方案接受，实施等待实际材料。",
    refs: [],
    verdict: "accept",
    stage: "design",
    toolCallId: "accepted-plan-tool",
  });
  p.currentStage = "analysis";
  ensureFusionStageTasks(p, at);
  const versions = p.fusion!.tasks.filter((t) => t.stage === "analysis").map((t) => t.inputVersion);
  p.currentStage = "writing";
  ensureFusionStageTasks(p, at);
  const writingVersions = p
    .fusion!.tasks.filter((t) => t.stage === "writing")
    .map((t) => t.inputVersion);
  p.evidence!.datasets.push({
    id: "observations",
    description: "公开观察数据",
    sourceId: "public-source",
    file: "/tmp/observations.csv",
    sha256: "b".repeat(64),
    delimiter: ",",
    permission: "public",
    dataKind: "observed",
  });
  ensureFusionStageTasks(p, at);
  expect(p.fusion!.tasks.filter((t) => t.stage === "analysis").map((t) => t.inputVersion)).toEqual(
    versions.map((v) => v + 1),
  );
  expect(p.fusion!.tasks.filter((t) => t.stage === "writing").map((t) => t.inputVersion)).toEqual(
    writingVersions.map((v) => v + 1),
  );
  expect(p.fusion!.tasks.find((t) => t.id === "v1:design:mentor")?.currentArtifactId).toBe(
    "accepted-plan",
  );
  expect(p.fusion!.artifacts.find((a) => a.id === "accepted-plan")?.reviewState).toBe("accepted");
});
