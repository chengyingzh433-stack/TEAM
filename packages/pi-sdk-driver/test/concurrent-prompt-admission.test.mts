import assert from "node:assert/strict";
import test from "node:test";
import { SessionSupervisor } from "../dist/session-supervisor.js";

await test("a handoff during initial persistence keeps the admitted run ID and enters Pi as a steer", async () => {
  const supervisor = new SessionSupervisor();
  const internal = supervisor as unknown as {
    ensureRecord(): Promise<unknown>;
    persistSnapshot(): Promise<void>;
    emit(): Promise<void>;
    mapAgentEvent(record: unknown, event: unknown): unknown;
  };
  let releaseSave!: () => void, enteredSave!: () => void, finish!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saveEntered = new Promise<void>((resolve) => {
    enteredSave = resolve;
  });
  const runGate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const prompts: string[] = [],
    steers: string[] = [];
  const session = {
    isStreaming: false,
    sessionManager: { buildSessionContext: () => ({ thinkingLevel: "off", model: null }) },
    prompt: async (text: string, options: { preflightResult?: (status: string) => void }) => {
      prompts.push(text);
      session.isStreaming = true;
      internal.mapAgentEvent(record, { type: "agent_start" });
      options.preflightResult?.("started");
      await runGate;
      session.isStreaming = false;
    },
    steer: async (text: string) => {
      steers.push(text);
    },
  };
  const record = {
    ref: { workspaceId: "workspace", sessionId: "session" },
    workspace: { workspaceId: "workspace", path: "/tmp/admission-probe" },
    title: "admission",
    session,
    status: "idle",
    updatedAt: new Date().toISOString(),
    runningRunId: undefined as string | undefined,
    promptStarting: false,
    abortOnRunStart: false,
    cancellationRequested: false,
    queuedMessages: [],
    listeners: new Set(),
    sessionCommands: [],
    eventQueue: Promise.resolve(),
  };
  internal.ensureRecord = async () => record;
  let saves = 0;
  internal.persistSnapshot = async () => {
    if (++saves === 1) {
      enteredSave();
      await saveGate;
    }
  };
  internal.emit = async () => {};
  const first = supervisor.sendUserMessage(record.ref, { text: "original", deliverAs: "steer" });
  await saveEntered;
  const admittedId = record.runningRunId;
  assert.ok(admittedId);
  const second = supervisor.sendUserMessage(record.ref, { text: "feedback", deliverAs: "steer" });
  let duringSettle: Promise<void> | undefined;
  try {
    // A turn of the event loop drains both calls' admission microtasks, with the
    // first save deliberately still pending. No elapsed-time/race assertion.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      record.runningRunId,
      admittedId,
      "the second admission must not overwrite the first run",
    );
    assert.deepEqual(prompts, [], "neither native prompt may precede the admitted save");
    releaseSave();
    await second;
    assert.deepEqual(prompts, ["original"]);
    assert.deepEqual(steers, ["feedback"]);
    assert.equal(record.runningRunId, admittedId);
    // Pi clears isStreaming before its awaited agent_settled hooks finish. A
    // late handoff must wait for that native boundary before minting a new ID.
    session.isStreaming = false;
    duringSettle = supervisor.sendUserMessage(record.ref, {
      text: "after-settle",
      deliverAs: "steer",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(record.runningRunId, admittedId, "settling the old native run still owns its ID");
    assert.deepEqual(prompts, ["original"]);
    finish();
    await Promise.all([first, duringSettle]);
    assert.deepEqual(prompts, ["original", "after-settle"]);
  } finally {
    releaseSave();
    finish();
    await Promise.allSettled([first, second, ...(duringSettle ? [duringSettle] : [])]);
  }
});
