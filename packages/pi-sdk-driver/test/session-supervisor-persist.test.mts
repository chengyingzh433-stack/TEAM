import test from "node:test";
import assert from "node:assert/strict";
import { SessionSupervisor } from "../dist/session-supervisor.js";
import { sessionKey } from "@lancer/session-driver";

/**
 * Guards the call site, not the predicate: these drive the real
 * handleAgentEvent -> queueDriverEvents -> persistSnapshot path with a counting
 * catalog, so deleting the shouldPersistSnapshotForAgentEvent call in
 * handleAgentEvent fails them.
 */

function makeCountingCatalog() {
  const calls: string[] = [];
  return {
    calls,
    sessions: {
      upsertSession: async (entry: { title: string }) => {
        calls.push(entry.title);
      },
    },
    setSessionFile: async () => undefined,
  };
}

function makeRecord() {
  const emitted: Array<{ type: string }> = [];
  const record = {
    ref: { workspaceId: "ws-1", sessionId: "sess-1" },
    workspace: { workspaceId: "ws-1", path: "/tmp/ws-1", displayName: "ws-1" },
    title: "persist probe",
    runtime: undefined,
    session: undefined,
    sessionFile: undefined,
    status: "running",
    updatedAt: new Date().toISOString(),
    archivedAt: undefined,
    preview: undefined,
    config: undefined,
    runningRunId: "run-1",
    queuedMessages: [],
    closed: false,
    listeners: new Set<(event: { type: string }) => void | Promise<void>>([
      (event: { type: string }) => {
        emitted.push(event);
      },
    ]),
    eventQueue: Promise.resolve(),
    unsubscribeAgent: undefined,
    pendingHostUiRequests: new Map(),
    extensionUiState: { dialogs: [], notices: [] },
    bindingExtensions: false,
    sessionCommands: [],
    leasePath: undefined,
    transcriptDiskMtimeMs: undefined,
  };
  return { record, emitted };
}

async function drive(event: unknown) {
  const catalog = makeCountingCatalog();
  const supervisor = new SessionSupervisor({
    catalogStorage: catalog as never,
  }) as unknown as {
    handleAgentEvent: (record: unknown, event: unknown) => void;
  };
  const { record, emitted } = makeRecord();
  supervisor.handleAgentEvent(record, event);
  await record.eventQueue;
  return { catalogWrites: catalog.calls.length, emitted };
}

const assistantDelta = {
  type: "message_update",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  assistantMessageEvent: { type: "text_delta", delta: "hello" },
};

await test("a streaming partial emits its driver events without writing the catalog", async () => {
  const { catalogWrites, emitted } = await drive(assistantDelta);

  // The event still reaches the UI...
  assert.ok(
    emitted.some((event) => event.type === "assistantDelta"),
    `expected an assistantDelta, got ${JSON.stringify(emitted.map((e) => e.type))}`,
  );
  // ...but costs no durable catalog write. This is the whole fix: without it
  // every streamed token queues an fsync ahead of every other session
  // operation.
  assert.equal(catalogWrites, 0);
});

await test("a discrete agent event still writes the catalog", async () => {
  const { catalogWrites, emitted } = await drive({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  });

  assert.ok(emitted.length > 0, "expected the discrete event to emit");
  assert.equal(catalogWrites, 1);
});

await test("native updates queued before Stop cannot resurrect the running status after its idle update", async () => {
  const catalog = makeCountingCatalog();
  const supervisor = new SessionSupervisor({ catalogStorage: catalog as never });
  const internal = supervisor as unknown as {
    records: Map<string, unknown>;
    queueDriverEvents(
      record: unknown,
      events: unknown[],
      options: { persistSnapshot: boolean },
    ): void;
  };
  let entered!: () => void, release!: () => void, idle!: () => void;
  const entering = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const idleSeen = new Promise<void>((r) => {
    idle = r;
  });
  const statuses: string[] = [];
  const base = makeRecord().record;
  const record = {
    ...base,
    session: { abort: async () => undefined, clearQueue: () => undefined },
    listeners: new Set<(event: { snapshot: { status: string } }) => unknown>(),
  };
  record.listeners.add(async (event: { snapshot: { status: string } }) => {
    statuses.push(event.snapshot.status);
    if (statuses.length === 1) {
      entered();
      await gate;
    }
    if (event.snapshot.status === "idle") idle();
  });
  internal.records.set(sessionKey(record.ref), record);
  const snapshot = {
    ref: record.ref,
    workspace: record.workspace,
    title: record.title,
    status: "running",
    updatedAt: "2026-11-01T00:00:00.000Z",
    runningRunId: "run-1",
  };
  const event = {
    type: "sessionUpdated",
    sessionRef: record.ref,
    timestamp: snapshot.updatedAt,
    snapshot,
  };
  internal.queueDriverEvents(record, [event, structuredClone(event)], { persistSnapshot: false });
  await entering;
  const stopping = supervisor.cancelCurrentRun(record.ref);
  await idleSeen;
  release();
  await Promise.all([stopping, record.eventQueue]);
  assert.equal(statuses.at(-1), "idle", JSON.stringify(statuses));
  assert.equal(record.status, "idle");
});

await test("flushSessionEvents waits for pending delivery and tails appended while waiting", async () => {
  const supervisor = new SessionSupervisor({ catalogStorage: makeCountingCatalog() as never });
  const internal = supervisor as unknown as {
    records: Map<string, unknown>;
    queueDriverEvents(
      record: unknown,
      events: unknown[],
      options: { persistSnapshot: boolean },
    ): void;
    flushSessionEvents(ref: { workspaceId: string; sessionId: string }): Promise<void>;
  };
  assert.equal(typeof internal.flushSessionEvents, "function");
  const record = { ...makeRecord().record, session: {} };
  internal.records.set(sessionKey(record.ref), record);
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let firstEntered!: () => void;
  let secondEntered!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const firstSeen = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const secondSeen = new Promise<void>((resolve) => {
    secondEntered = resolve;
  });
  const delivered: string[] = [];
  record.listeners.clear();
  record.listeners.add(async (event: { type: string }) => {
    if (event.type === "first") {
      firstEntered();
      await firstGate;
    } else {
      secondEntered();
      await secondGate;
    }
    delivered.push(event.type);
  });
  const enqueue = (type: string) =>
    internal.queueDriverEvents(record, [{ type }], { persistSnapshot: false });
  enqueue("first");
  await firstSeen;
  let flushed = false;
  const flushing = internal.flushSessionEvents(record.ref).then(() => {
    flushed = true;
  });
  // Let flush capture the initial tail before another native event is queued.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(flushed, false);
  enqueue("second");
  releaseFirst();
  await secondSeen;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(flushed, false, "flush must wait for the appended tail too");
  releaseSecond();
  await flushing;
  assert.deepEqual(delivered, ["first", "second"]);
  await internal.flushSessionEvents(record.ref);
});
