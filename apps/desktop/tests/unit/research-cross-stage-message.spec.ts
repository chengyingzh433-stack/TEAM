import { expect, test, type TestInfo } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RESEARCH_ROLES,
  researchStages,
  type ResearchConfig,
  type ResearchProject,
  type ResearchRole,
} from "../../contracts/research-group";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchRepository } from "../../electron/research-group/repository";
import {
  activeFusionAttempt,
  bindFusionNativeRun,
  dispatchFusionAttempt,
  ensureFusionStageTasks,
  finishFusionNativeRun,
  prepareFusionDelivery,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import {
  pauseResearchTasks,
  requestResearchTaskContinuation,
} from "../../electron/research-group/task-graph";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function setup(options: { futureCaller?: boolean; reviewerOtherOwner?: boolean } = {}) {
  // L only. Synthetic persisted local reopening and native events, real repository,
  // resume/message/prepare/dispatch. No Pi, provider or accepted research is simulated.
  const directory = await mkdtemp(join(tmpdir(), "research-cross-stage-message-")),
    kb = join(directory, "course");
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"));
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "SYNTHETIC",
      title: "合成交接测试",
      text: "仅验证任务归属，不是课程或学术结论。",
      required_context_ids: [],
    }),
  );
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "synthetic-1" }));
  const knowledge = await ResearchKnowledge.open(kb),
    at = new Date().toISOString();
  const config: ResearchConfig = {
    knowledgeDir: kb,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
    scope: "proposal",
    models: Object.fromEntries(
      RESEARCH_ROLES.map((role) => [role, { provider: "synthetic-host", modelId: role }]),
    ),
  };
  const project: ResearchProject = {
    id: randomUUID(),
    root: { workspaceId: directory, sessionId: "mentor" },
    workspacePath: directory,
    objective: "合成局部重开：导航S5、当前工作S4v2",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
    scope: "proposal",
    currentStage: "synthesis",
    knowledge: knowledge.pin,
    stages: researchStages(config),
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: directory, sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
    evidence: { directory, sources: [], datasets: [] },
  };
  ensureFusionStageTasks(project, at);
  project.currentStage = "design";
  ensureFusionStageTasks(project, at);
  // Valid synthetic persisted input-v2 tasks; no earlier acceptance is invented.
  for (const task of project.fusion!.tasks) task.inputVersion = 2;
  for (const role of ["lead", "reviewer", "librarian"] as const) {
    const attemptId = `synthetic-prior-${role}`;
    const prepared = prepareFusionDelivery(
      project,
      role,
      attemptId,
      at,
      "合成S4 v2独立交付",
      `v1:synthesis:${role}`,
    );
    expect(prepared.kind).toBe("dispatch");
    dispatchFusionAttempt(project, attemptId, at);
    bindFusionNativeRun(project, role, `native-${attemptId}`);
    const artifact = {
      id: randomUUID(),
      role,
      kind:
        role === "lead"
          ? ("stage-draft" as const)
          : role === "reviewer"
            ? ("stage-risk" as const)
            : ("stage-material" as const),
      revision: 1,
      round: 0,
      createdAt: at,
      content: "合成独立交付：当前S4输入版本二，只核查交接归属。",
      refs: [],
      toolCallId: `publish-${role}`,
      stage: "synthesis" as const,
    };
    project.artifacts.push(artifact);
    publishFusionArtifact(project, artifact);
    finishFusionNativeRun(project, role, `native-${attemptId}`, at);
  }
  project.fusion = requestResearchTaskContinuation(project.fusion!, "v1:synthesis:lead", {
    id: "synthetic-source-continuation",
    at,
    reason: "明确继续同版S4工作",
  });
  // Separate control: an independently eligible other-stage owner is retained.
  if (options.futureCaller)
    project.fusion.tasks.find((task) => task.id === "v1:design:librarian")!.dependencies = [];
  if (options.reviewerOtherOwner)
    project.fusion.tasks.find((task) => task.id === "v1:design:reviewer")!.dependencies = [];
  project.status = "paused";
  project.fusion = pauseResearchTasks(project.fusion);
  const repository = new ResearchRepository(directory);
  await repository.save({ version: 1, config, projects: [project] });
  const delivered: {
      role: string;
      taskId?: string;
      attemptId?: string;
      expectedRunningRunId?: string;
      text: string;
    }[] = [],
    releases: (() => void)[] = [];
  const flushEntered = gate(),
    flushReleased = gate();
  let holdReviewerFlush = false;
  let coordinator!: ResearchCoordinator;
  const host: ResearchHost = {
    createMember: async () => {
      throw new Error("Synthetic existing member must not be replaced");
    },
    flushEvents: async (ref) => {
      if (ref.sessionId === "reviewer" && holdReviewerFlush) {
        holdReviewerFlush = false;
        flushEntered.release();
        await flushReleased.promise;
      }
    },
    deliver: async (ref, text, expectedRunningRunId) => {
      const p = coordinator.snapshot().projects[0]!,
        role = ref.sessionId as ResearchRole,
        attempt = activeFusionAttempt(p, role)!;
      delivered.push({
        role,
        taskId: attempt?.taskId,
        attemptId: attempt?.id,
        expectedRunningRunId,
        text,
      });
      const timestamp = new Date().toISOString();
      coordinator.onSessionEvent({
        type: "sessionUpdated",
        sessionRef: ref,
        timestamp,
        runId: attempt.nativeRunId ?? `synthetic-native-${attempt.id}`,
        snapshot: {
          ref,
          workspace: { workspaceId: directory, path: directory },
          title: "Synthetic native",
          status: "running",
          updatedAt: timestamp,
        },
      });
      await new Promise<void>((resolve) => releases.push(resolve));
    },
    cancel: async () => {
      releases.splice(0).forEach((release) => release());
    },
    changed: () => {},
  };
  coordinator = new ResearchCoordinator(repository, host);
  await coordinator.load();
  await coordinator.resume(project.root);
  await expect.poll(() => delivered.some((row) => row.role === "lead")).toBe(true);
  if (options.futureCaller)
    await expect
      .poll(() =>
        delivered.some((row) => row.role === "librarian" && row.taskId === "v1:design:librarian"),
      )
      .toBe(true);
  if (options.reviewerOtherOwner)
    await expect
      .poll(() =>
        delivered.some((row) => row.role === "reviewer" && row.taskId === "v1:design:reviewer"),
      )
      .toBe(true);
  await coordinator.flush();
  const current = () => coordinator.snapshot().projects[0]!;
  const send = (role: ResearchRole, content: string) =>
    coordinator.tool({ workspaceId: directory, sessionId: role }, `synthetic-message-${content}`, {
      operation: "message",
      to: "reviewer",
      content,
    });
  const close = async (info: TestInfo) => {
    flushReleased.release();
    await coordinator.flush();
    await info.attach("synthetic-cross-stage-message.json", {
      body: JSON.stringify({
        directory,
        delivered,
        project: current(),
        persisted: await repository.load(),
      }),
      contentType: "application/json",
    });
    await coordinator.pause(project.root);
    await coordinator.flush();
  };
  return {
    coordinator,
    current,
    delivered,
    send,
    close,
    flushEntered,
    flushReleased,
    holdReviewerFlush: () => {
      holdReviewerFlush = true;
    },
  };
}

test("message records and delivers the sender's active S4 v2 stage while global navigation remains S5", async ({}, info) => {
  const s = await setup();
  try {
    expect(s.current().currentStage).toBe("design");
    expect(activeFusionAttempt(s.current(), "lead")).toMatchObject({
      taskId: "v1:synthesis:lead",
      taskVersion: 2,
      state: "running",
    });
    await s.send("lead", "S4新稿请本人复核");
    await expect
      .poll(() => s.delivered.filter((row) => row.role === "reviewer").map((row) => row.taskId))
      .toEqual(["v1:synthesis:reviewer"]);
    expect(activeFusionAttempt(s.current(), "reviewer")).toMatchObject({
      taskId: "v1:synthesis:reviewer",
      taskVersion: 2,
      state: "running",
    });
    expect(
      s
        .current()
        .events.find(
          (event) => event.type === "message" && event.role === "lead" && event.to === "reviewer",
        )?.stage,
    ).toBe("synthesis");
    expect(s.current().currentStage).toBe("design");
  } finally {
    await s.close(info);
  }
});

test("a future S5 handoff awaiting its flush cannot strand a newly queued ready S4 message", async ({}, info) => {
  const s = await setup({ futureCaller: true });
  try {
    s.holdReviewerFlush();
    await s.send("librarian", "未来S5资料通知，不得代替当前S4复核");
    await s.flushEntered.promise;
    await s.send("lead", "当前S4回应已经发布，请复核当前稿");
    s.flushReleased.release();
    await expect
      .poll(() => s.delivered.filter((row) => row.role === "reviewer").map((row) => row.taskId))
      .toEqual(["v1:synthesis:reviewer"]);
    expect(activeFusionAttempt(s.current(), "reviewer")).toMatchObject({
      taskId: "v1:synthesis:reviewer",
      taskVersion: 2,
    });
    expect(s.current().fusion!.tasks.find((task) => task.id === "v1:design:reviewer")!.state).toBe(
      "waiting-dependency",
    );
  } finally {
    await s.close(info);
  }
});

test("an S4 message does not steer or replace a reviewer already owning a different stage", async ({}, info) => {
  const s = await setup({ reviewerOtherOwner: true });
  try {
    const before = activeFusionAttempt(s.current(), "reviewer")!;
    expect(before.taskId).toBe("v1:design:reviewer");
    await s.send("lead", "S4消息等待另阶段现有native自然边界");
    await s.coordinator.flush();
    expect(activeFusionAttempt(s.current(), "reviewer")).toEqual(before);
    expect(s.delivered.filter((row) => row.role === "reviewer")).toHaveLength(1);
    expect(
      s.delivered.filter((row) => row.role === "reviewer" && row.expectedRunningRunId),
    ).toEqual([]);
  } finally {
    await s.close(info);
  }
});
