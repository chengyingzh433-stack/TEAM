import { expect, test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RESEARCH_ROLES,
  type ResearchProject,
  type ResearchArtifact,
  type ResearchGroupsState,
} from "../../contracts/research-group";
import { ResearchCoordinator } from "../../electron/research-group/coordinator";
import { ResearchRepository } from "../../electron/research-group/repository";
import {
  activeFusionAttempt,
  ensureFusionStageTasks,
  prepareFusionDelivery,
  dispatchFusionAttempt,
  publishFusionArtifact,
  finishFusionNativeRun,
  failFusionAttempt,
  requestFusionTaskRetry,
  resumableFusionTasks,
} from "../../electron/research-group/fusion-task-runtime";
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

async function setup(p: ResearchProject, rejectFirstReviewerHandoff = false) {
  const directory = await mkdtemp(join(tmpdir(), "fusion-local-resume-"));
  p.workspacePath = directory;
  const sent: { role: string; taskId: string; stage?: string }[] = [];
  const pendingDeliveries: (() => void)[] = [];
  const repository = new ResearchRepository(directory);
  const coordinator = new ResearchCoordinator(repository, {
    createMember: async () => {
      throw new Error("seeded members must be reused");
    },
    deliver: async (ref) => {
      const state = await repository.load();
      const current = state.projects[0]!;
      const attempt = activeFusionAttempt(current, ref.sessionId as "lead")!;
      sent.push({
        role: ref.sessionId,
        taskId: attempt.taskId,
        stage: current.fusion!.tasks.find((t) => t.id === attempt.taskId)!.stage,
      });
      if (
        rejectFirstReviewerHandoff &&
        ref.sessionId === "reviewer" &&
        sent.filter((row) => row.role === "reviewer").length === 1
      )
        throw new Error(
          "Session finished streaming before the queued message could be delivered. Retry to send it as a new turn.",
        );
      if (rejectFirstReviewerHandoff && ref.sessionId === "reviewer")
        await new Promise<void>((resolve) => pendingDeliveries.push(resolve));
    },
    cancel: async () => {
      pendingDeliveries.splice(0).forEach((resolve) => resolve());
    },
    changed: () => {},
  });
  const internal = coordinator as unknown as {
    state: ResearchGroupsState;
    routePaperArtifact(p: ResearchProject, a: ResearchArtifact): Promise<void>;
  };
  internal.state = { version: 1, config: { knowledgeDir: "" }, projects: [p] };
  await repository.save(internal.state);
  return { coordinator, internal, sent };
}
function result(
  p: ResearchProject,
  role: "lead" | "reviewer",
  kind: "stage-revision" | "stage-verification",
  refs: string[] = [],
) {
  const id = `${role}-attempt`;
  prepareFusionDelivery(p, role, id, at, "本阶段任务");
  dispatchFusionAttempt(p, id, at);
  const artifact: ResearchArtifact = {
    id: randomUUID(),
    role,
    kind,
    stage: "design",
    revision: 1,
    round: 1,
    createdAt: at,
    content: "已保存成果".repeat(30),
    refs,
    toolCallId: id,
    ...(role === "reviewer" ? { verdict: "accept" as const } : {}),
  };
  p.artifacts.push(artifact);
  publishFusionArtifact(p, artifact);
  finishFusionNativeRun(p, role, undefined, at);
  return artifact;
}

test("an explicitly rolled-back handoff waits for the current native boundary instead of failing or looping", async () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  prepareFusionDelivery(p, "reviewer", "original-reviewer", at, "Original native fixture");
  dispatchFusionAttempt(p, "original-reviewer", at);
  const { coordinator, internal, sent } = await setup(p, true);
  const ref = p.members.find((member) => member.role === "reviewer")!.ref;
  const stamp = new Date().toISOString();
  const snapshot = {
    ref,
    workspace: { workspaceId: ref.workspaceId, path: p.workspacePath },
    title: "Explicit native boundary fixture",
    status: "running" as const,
    updatedAt: stamp,
  };
  coordinator.onSessionEvent({
    type: "sessionUpdated",
    sessionRef: ref,
    timestamp: stamp,
    runId: "original-native",
    snapshot,
  });
  await coordinator.flush();
  await internal.routePaperArtifact(coordinator.snapshot().projects[0]!, {
    id: "pending-revision",
    role: "lead",
    kind: "stage-revision",
    stage: "design",
    revision: 1,
    round: 1,
    refs: [],
    createdAt: stamp,
    content: "A fixture handoff whose delivery must be retained",
    toolCallId: "fixture-publication",
  });
  await expect
    .poll(() =>
      coordinator
        .snapshot()
        .projects[0]!.events.some(
          (event) =>
            event.type === "error" ||
            (event.type === "handoff" && event.detail.includes("尚未送达")),
        ),
    )
    .toBe(true);
  expect(
    coordinator.snapshot().projects[0]!.events.filter((event) => event.type === "error"),
  ).toEqual([]);
  expect(activeFusionAttempt(coordinator.snapshot().projects[0]!, "reviewer")).toMatchObject({
    id: "original-reviewer",
    nativeRunId: "original-native",
    state: "running",
  });
  expect(sent.filter((row) => row.role === "reviewer")).toHaveLength(1);
  coordinator.onSessionEvent({
    type: "sessionUpdated",
    sessionRef: ref,
    timestamp: new Date().toISOString(),
    runId: "original-native",
    snapshot,
  });
  await coordinator.flush();
  expect(sent.filter((row) => row.role === "reviewer")).toHaveLength(1);
  coordinator.onSessionEvent({
    type: "runCompleted",
    sessionRef: ref,
    timestamp: new Date().toISOString(),
    runId: "original-native",
    snapshot: { ...snapshot, status: "idle" },
  });
  await expect.poll(() => sent.filter((row) => row.role === "reviewer").length).toBe(2);
  const current = coordinator.snapshot().projects[0]!;
  expect(current.fusion!.attempts.find((row) => row.id === "original-reviewer")!.state).toBe(
    "succeeded",
  );
  expect(current.events.filter((event) => event.type === "error")).toEqual([]);
  expect(activeFusionAttempt(current, "reviewer")!.id).not.toBe("original-reviewer");
  await coordinator.pause(p.root);
});

test("an old-stage handoff retains its recipient task instead of using current navigation", async () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  // Other roles already ended their initial turns; only this missing handoff is new work.
  for (const role of ["mentor", "reviewer", "librarian"] as const) {
    const attemptId = `settled-${role}`;
    prepareFusionDelivery(p, role, attemptId, at, "已完成初轮等待交接");
    dispatchFusionAttempt(p, attemptId, at);
    finishFusionNativeRun(p, role, undefined, at);
  }
  p.currentStage = "analysis";
  ensureFusionStageTasks(p, at);
  const { internal, sent } = await setup(p);
  await internal.routePaperArtifact(p, {
    id: "design-critique",
    role: "reviewer",
    kind: "stage-critique",
    stage: "design",
    revision: 1,
    round: 0,
    refs: [],
    createdAt: at,
    content: "需修改",
    toolCallId: "critique",
  });
  await expect
    .poll(() => sent)
    .toEqual([{ role: "lead", taskId: "v1:design:lead", stage: "design" }]);
});

test("accepting an upstream old-stage result wakes newly ready downstream tasks", async () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  const revision = result(p, "lead", "stage-revision");
  const verification = result(p, "reviewer", "stage-verification", [revision.id]);
  prepareFusionDelivery(p, "mentor", "mentor-attempt", at, "审阅旧阶段");
  dispatchFusionAttempt(p, "mentor-attempt", at);
  p.packets.push({
    id: "mentor-method",
    role: "mentor",
    stage: "design",
    revision: 1,
    query: "method",
    ids: [],
    at,
    records: [],
  });
  for (const artifactId of [revision.id, verification.id])
    p.events.push({
      id: `read-${artifactId}`,
      type: "read",
      role: "mentor",
      artifactId,
      at,
      detail: "已读取",
    });
  p.currentStage = "analysis";
  ensureFusionStageTasks(p, at);
  const { coordinator, sent } = await setup(p);
  await coordinator.tool(p.root, "accept-design", {
    operation: "publish",
    kind: "stage-review",
    stage: "design",
    revision: 1,
    content: "方案通过，相关下游可以接续。".repeat(10),
    refs: [revision.id, verification.id],
    verdict: "accept",
  });
  await expect.poll(() => sent.filter((s) => s.taskId === "v1:analysis:reviewer").length).toBe(1);
  expect(sent.some((s) => s.taskId === "v1:analysis:lead")).toBe(false);
  expect(sent.some((s) => s.taskId === "v1:design:lead")).toBe(false);
});

test("explicit retry after a published result creates one continuation and preserves that result", () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  prepareFusionDelivery(p, "reviewer", "risk-attempt", at, "先交风险再核查");
  dispatchFusionAttempt(p, "risk-attempt", at);
  const artifact: ResearchArtifact = {
    id: randomUUID(),
    role: "reviewer",
    kind: "stage-risk",
    stage: "design",
    revision: 1,
    round: 0,
    createdAt: at,
    content: "已交风险判断".repeat(20),
    refs: [],
    toolCallId: "risk",
  };
  p.artifacts.push(artifact);
  publishFusionArtifact(p, artifact);
  failFusionAttempt(p, "reviewer", "provider disconnected after publishing", at);
  const request = {
    id: "explicit-risk-retry",
    taskId: "v1:design:reviewer",
    at,
    reason: "继续尚未完成的核查",
    evidenceRef: "user-action:retry",
  };
  requestFusionTaskRetry(p, request);
  expect(resumableFusionTasks(p).some((t) => t.taskId === request.taskId)).toBe(true);
  const task = p.fusion!.tasks.find((t) => t.id === request.taskId)!;
  expect(task.continuations).toHaveLength(1);
  expect(task.continuations[0]!.id).toBe(`retry:${request.id}`);
  expect(p.artifacts).toEqual([artifact]);
  const unchanged = structuredClone(p.fusion);
  requestFusionTaskRetry(p, request);
  expect(p.fusion).toEqual(unchanged);
});
