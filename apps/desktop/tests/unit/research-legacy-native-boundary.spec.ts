import { expect, test, type TestInfo } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionDriverEvent, SessionRef } from "@lancer/session-driver";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchRepository } from "../../electron/research-group/repository";

const NOTICE =
  "L only: explicitly synthetic SessionDriverEvent inputs exercise the real legacy ResearchCoordinator and filesystem ResearchRepository. The host never starts Pi or a provider; these cases do not establish native, Electron or real-provider behavior.";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "research-legacy-native-boundary-")),
    knowledgeDir = join(directory, "synthetic-course"),
    workspace = join(directory, "workspace");
  await Promise.all([
    mkdir(join(knowledgeDir, "索引"), { recursive: true }),
    mkdir(join(knowledgeDir, "溯源"), { recursive: true }),
    mkdir(workspace),
  ]);
  await writeFile(
    join(knowledgeDir, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "SYNTHETIC-BOUNDARY",
      title: "合成生命周期测试材料",
      text: "仅用于软件事件边界测试，不是课程、研究材料或真实模型输出。",
      required_context_ids: [],
    }),
  );
  await writeFile(
    join(knowledgeDir, "溯源", "来源清单.json"),
    JSON.stringify({ version: "synthetic-native-boundary-1" }),
  );
  // Pending synthetic deliveries keep other roles available while one role ends.
  // The gate is host ownership only; no Pi runtime, model loop or timed delay exists.
  const pending = new Map<string, (() => void)[]>();
  const host: ResearchHost = {
    createMember: async (root, role, model) => ({
      role,
      model,
      ref: { workspaceId: root.workspaceId, sessionId: role },
      status: "idle",
    }),
    deliver: (ref) =>
      new Promise<void>((resolve) => {
        pending.set(ref.sessionId, [...(pending.get(ref.sessionId) ?? []), resolve]);
      }),
    cancel: async (ref) => {
      const releases = pending.get(ref.sessionId) ?? [];
      pending.delete(ref.sessionId);
      releases.forEach((release) => release());
    },
    changed: () => {},
  };
  const repository = new ResearchRepository(directory),
    coordinator = new ResearchCoordinator(repository, host),
    root = { workspaceId: workspace, sessionId: "mentor" },
    ref = { workspaceId: workspace, sessionId: "lead" };
  await coordinator.load();
  // Omitting workflowVersion is the supported persisted legacy workflow contract.
  await coordinator.configure({ knowledgeDir, scope: "proposal" });
  await coordinator.start(root, workspace, "合成测试：只验证旧流程原生事件的归属与结束记录。");
  await coordinator.flush();
  expect(coordinator.snapshot().projects[0]!.fusion).toBeUndefined();
  const snapshot = (timestamp: string, status: "running" | "idle", runId: string) => ({
    ref,
    workspace: { workspaceId: workspace, path: workspace },
    title: "Synthetic lead session; no native runtime",
    status,
    updatedAt: timestamp,
    ...(status === "running" ? { runningRunId: runId } : {}),
  });
  const running = (runId: string, timestamp: string): SessionDriverEvent => ({
    type: "sessionUpdated",
    sessionRef: ref,
    timestamp,
    runId,
    snapshot: snapshot(timestamp, "running", runId),
  });
  const completed = (runId: string, timestamp: string): SessionDriverEvent => ({
    type: "runCompleted",
    sessionRef: ref,
    timestamp,
    runId,
    snapshot: snapshot(timestamp, "idle", runId),
  });
  const emit = async (...events: SessionDriverEvent[]) => {
    events.forEach((event) => coordinator.onSessionEvent(event));
    await coordinator.flush();
  };
  const project = () => coordinator.snapshot().projects[0]!;
  const member = () => project().members.find((value) => value.role === "lead")!;
  const preparedAt = () =>
    coordinator
      .snapshot()
      .m3?.legacyExecutions?.filter(
        (a) =>
          a.projectId === project().id && a.revision === project().revision && a.role === "lead",
      )
      .at(-1)?.preparedAt ?? project().inputHistory!.at(-1)!.at;
  const time = (offset: number) => new Date(Date.parse(preparedAt()) + offset).toISOString();
  const retainAndClose = async (info: TestInfo) => {
    try {
      await coordinator.flush();
      await info.attach("synthetic-legacy-native-boundary.json", {
        body: JSON.stringify(
          { notice: NOTICE, directory, project: project(), persisted: await repository.load() },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      await coordinator.pause(root);
      await coordinator.flush();
    }
  };
  return {
    host,
    coordinator,
    repository,
    root,
    ref,
    workspace,
    running,
    completed,
    emit,
    project,
    member,
    time,
    preparedAt,
    retainAndClose,
  };
}

function lifecycle(project: ReturnType<Awaited<ReturnType<typeof setup>>["project"]>) {
  return project.events
    .filter((event) => event.role === "lead" && ["started", "finished"].includes(event.type))
    .map((event) => ({
      type: event.type,
      runId: event.runId,
      runtimeAt: event.runtimeAt,
      revision: event.revision,
    }));
}

test.describe.configure({ retries: 0 });
for (const kind of ["running snapshot", "assistantDelta", "runCompleted", "runFailed"] as const) {
  test(`legacy fresh run keeps ownership when an older ${kind} arrives late`, async ({}, info) => {
    const s = await setup();
    try {
      const oldRun = "synthetic-old-T1",
        freshRun = "synthetic-fresh-T2",
        oldAt = s.time(10),
        freshAt = s.time(20),
        finishAt = s.time(30);
      await s.emit(s.running(freshRun, freshAt));
      const base = { sessionRef: s.ref, runId: oldRun, timestamp: oldAt };
      const stale: SessionDriverEvent =
        kind === "running snapshot"
          ? s.running(oldRun, oldAt)
          : kind === "assistantDelta"
            ? { ...base, type: "assistantDelta", text: "Synthetic delayed output from T1" }
            : kind === "runCompleted"
              ? s.completed(oldRun, oldAt)
              : {
                  ...base,
                  type: "runFailed",
                  error: { message: "Synthetic stale failure from T1" },
                };
      await s.emit(stale);
      expect.soft(s.member()).toMatchObject({ status: "running", startedAt: freshAt });
      expect.soft(s.member().finishedAt).toBeUndefined();
      expect.soft(s.member().error).toBeUndefined();
      expect.soft(s.project().events.filter((event) => event.type === "error")).toEqual([]);
      await s.emit(s.completed(freshRun, finishAt));
      expect(s.member()).toMatchObject({
        status: "idle",
        startedAt: freshAt,
        finishedAt: finishAt,
      });
      expect(lifecycle(s.project())).toEqual([
        { type: "started", runId: freshRun, runtimeAt: freshAt, revision: 1 },
        { type: "finished", runId: freshRun, runtimeAt: finishAt, revision: 1 },
      ]);
      expect((await s.repository.load()).projects[0]!.members).toEqual(s.project().members);
    } finally {
      await s.retainAndClose(info);
    }
  });
}

test("legacy completed runs do not revive when their running snapshots replay within the same revision", async ({}, info) => {
  const s = await setup();
  try {
    await s.emit(s.running("synthetic-completed-T1", s.time(10)));
    await s.emit(s.completed("synthetic-completed-T1", s.time(20)));
    await s.emit(s.running("synthetic-completed-T2", s.time(30)));
    await s.emit(s.completed("synthetic-completed-T2", s.time(40)));
    const before = s.project();
    await s.emit(s.running("synthetic-completed-T1", s.time(10)));
    expect(s.member()).toEqual(before.members.find((member) => member.role === "lead"));
    expect(lifecycle(s.project())).toEqual(lifecycle(before));
    expect(s.project().revision).toBe(1);
    expect((await s.repository.load()).projects[0]!.events).toEqual(s.project().events);
  } finally {
    await s.retainAndClose(info);
  }
});

test("legacy revision two rejects prior native times before the new input even before its fresh run starts", async ({}, info) => {
  const s = await setup();
  try {
    const priorAt = s.project().inputHistory![0]!.at;
    await s.emit(s.running("synthetic-revision-one", priorAt));
    await s.emit(s.completed("synthetic-revision-one", priorAt));
    await s.coordinator.pause(s.root);
    await s.coordinator.flush();
    await s.coordinator.start(s.root, s.workspace, "合成输入版本二，仍未发布或接受任何研究稿。");
    await s.coordinator.flush();
    const before = s.project(),
      freshAt = before.inputHistory!.at(-1)!.at;
    expect(Date.parse(freshAt)).toBeGreaterThan(Date.parse(priorAt));
    await s.emit(
      s.running("synthetic-unseen-prior-native", priorAt),
      {
        type: "assistantDelta",
        sessionRef: s.ref,
        runId: "synthetic-unseen-prior-native",
        timestamp: priorAt,
        text: "Synthetic prior-revision output",
      },
      s.completed("synthetic-unseen-prior-native", priorAt),
    );
    expect.soft(s.member()).toEqual(before.members.find((member) => member.role === "lead"));
    expect
      .soft(s.project().events.filter((event) => event.revision === 2))
      .toEqual(before.events.filter((event) => event.revision === 2));
    await s.emit(s.running("synthetic-revision-two", freshAt));
    await s.emit(s.completed("synthetic-revision-two", freshAt));
    expect(s.project().revision).toBe(2);
    expect(s.project().finalPaper).toBeUndefined();
    expect(lifecycle(s.project()).filter((event) => event.revision === 2)).toEqual([
      { type: "started", runId: "synthetic-revision-two", runtimeAt: freshAt, revision: 2 },
      { type: "finished", runId: "synthetic-revision-two", runtimeAt: freshAt, revision: 2 },
    ]);
  } finally {
    await s.retainAndClose(info);
  }
});

test("new input drains an already settled native notification under its original revision", async ({}, info) => {
  const s = await setup();
  try {
    const priorAt = s.preparedAt(),
      priorRunId = "synthetic-ended-native-with-pending-notification";
    await s.emit(s.running(priorRunId, priorAt));
    await s.coordinator.pause(s.root);
    await s.coordinator.flush();
    // Pi's prompt has returned, while its genuine mapped terminal is still in
    // the driver's event queue. Draining delivery does not start/finish a model.
    s.host.flushEvents = async (ref) => {
      if (ref.sessionId === s.ref.sessionId)
        s.coordinator.onSessionEvent(s.completed(priorRunId, priorAt));
    };
    await s.coordinator.start(s.root, s.workspace, "合成输入版本二；不得丢弃上一版本已结束通知。");
    await s.coordinator.flush();
    expect(s.project().revision).toBe(2);
    expect(lifecycle(s.project()).filter((event) => event.runId === priorRunId)).toEqual([
      { type: "started", runId: priorRunId, runtimeAt: priorAt, revision: 1 },
      { type: "finished", runId: priorRunId, runtimeAt: priorAt, revision: 1 },
    ]);
    expect(s.member().status).toBe("idle");
    expect(
      s.project().events.filter((event) => event.revision === 2 && event.type === "finished"),
    ).toEqual([]);
    expect(s.project().finalPaper).toBeUndefined();
  } finally {
    await s.retainAndClose(info);
  }
});

test("legacy current-run failure remains a failure rather than being filtered as stale", async ({}, info) => {
  const s = await setup();
  try {
    const runId = "synthetic-current-failed-run",
      message = "Synthetic current provider failure must remain visible";
    await s.emit(s.running(runId, s.time(10)));
    await s.emit({
      type: "runFailed",
      sessionRef: s.ref,
      runId,
      timestamp: s.time(20),
      error: { message },
    });
    expect(s.project()).toMatchObject({ status: "needs-decision", error: message });
    expect(s.member()).toMatchObject({ status: "failed", error: message });
    expect(s.project().events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ role: "lead", detail: message, revision: 1 }),
    ]);
    expect(lifecycle(s.project()).some((event) => event.type === "finished")).toBe(false);
    expect(s.project().finalPaper).toBeUndefined();
    expect((await s.repository.load()).projects[0]!.members).toEqual(s.project().members);
  } finally {
    await s.retainAndClose(info);
  }
});
