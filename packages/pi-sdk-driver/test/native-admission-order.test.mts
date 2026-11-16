import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionKey,
  type SessionDriverEvent,
  type SessionMessageInput,
} from "@lancer/session-driver";
import { SessionSupervisor } from "../dist/session-supervisor.js";

/**
 * L only. Real supervisor admission, mapping, event queue, persistence adapter and
 * emit methods; only catalog I/O and Pi session execution are synthetic. No Pi
 * runtime, provider, credential, Electron or wall-clock race is involved.
 */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function setup() {
  const oldRunId = "synthetic-prior-native";
  const saved: { status: string }[] = [];
  const delivered: { type: string; runId?: string; status?: string; runningRunId?: string }[] = [];
  const prompts: { text: string; runId: string | undefined }[] = [];
  const steers: string[] = [];
  const follows: string[] = [];
  const saveEntered = gate(),
    saveReleased = gate(),
    promptEntered = gate(),
    promptReleased = gate();
  let holdNextSave = false,
    failNextSave = false,
    holdPrompt = false;
  const storage = {
    sessions: {
      upsertSession: async (entry: { status: string }) => {
        saved.push({ status: entry.status });
        if (holdNextSave) {
          holdNextSave = false;
          saveEntered.release();
          await saveReleased.promise;
        }
        if (failNextSave) {
          failNextSave = false;
          throw new Error("Synthetic admission catalog write failed");
        }
      },
    },
    setSessionFile: async () => {},
  };
  const supervisor = new SessionSupervisor({ catalogStorage: storage as never });
  const internal = supervisor as unknown as {
    records: Map<string, unknown>;
    handleAgentEvent(record: unknown, event: unknown): void;
  };
  const session = {
    isStreaming: true,
    sessionManager: { buildSessionContext: () => ({ thinkingLevel: "off", model: null }) },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    prompt: async (text: string, options: { preflightResult?: () => void }) => {
      prompts.push({ text, runId: record.runningRunId });
      session.isStreaming = true;
      internal.handleAgentEvent(record, { type: "agent_start" });
      options.preflightResult?.();
      promptEntered.release();
      if (holdPrompt) await promptReleased.promise;
      session.isStreaming = false;
      internal.handleAgentEvent(record, {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      internal.handleAgentEvent(record, { type: "agent_settled" });
    },
    steer: async (text: string) => {
      steers.push(text);
    },
    followUp: async (text: string) => {
      follows.push(text);
    },
  };
  const record = {
    ref: { workspaceId: "synthetic-admission-workspace", sessionId: "synthetic-session" },
    workspace: { workspaceId: "synthetic-admission-workspace", path: "/synthetic/admission" },
    title: "Synthetic native admission order",
    session,
    status: "running",
    updatedAt: new Date().toISOString(),
    runningRunId: oldRunId as string | undefined,
    queuedMessages: [],
    promptStarting: false,
    abortOnRunStart: false,
    cancellationRequested: false,
    closed: false,
    listeners: new Set<(event: SessionDriverEvent) => void | Promise<void>>([
      (event) => {
        const snapshot = "snapshot" in event ? event.snapshot : undefined;
        delivered.push({
          type: event.type,
          ...(event.runId ? { runId: event.runId } : {}),
          ...(snapshot ? { status: snapshot.status, runningRunId: snapshot.runningRunId } : {}),
        });
      },
    ]),
    eventQueue: Promise.resolve(),
    sessionCommands: [],
  };
  internal.records.set(sessionKey(record.ref), record);
  const endPrior = async (holdTerminalSave = false) => {
    session.isStreaming = false;
    internal.handleAgentEvent(record, {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    await supervisor.flushSessionEvents(record.ref);
    holdNextSave = holdTerminalSave;
    internal.handleAgentEvent(record, { type: "agent_settled" });
    if (holdTerminalSave) await saveEntered.promise;
    else await supervisor.flushSessionEvents(record.ref);
  };
  const boundSteer = () => {
    const input: SessionMessageInput = {
      text: "Synthetic feedback for prior native only",
      deliverAs: "steer",
      expectedRunningRunId: oldRunId,
    };
    return supervisor.sendUserMessage(record.ref, input);
  };
  const state = () => ({
    status: record.status,
    runningRunId: record.runningRunId,
    queuedMessages: structuredClone(record.queuedMessages),
  });
  const cleanup = async (...pending: Promise<unknown>[]) => {
    saveReleased.release();
    promptReleased.release();
    await Promise.allSettled(pending);
    await supervisor.flushSessionEvents(record.ref);
  };
  return {
    supervisor,
    record,
    session,
    oldRunId,
    delivered,
    prompts,
    steers,
    follows,
    saved,
    endPrior,
    boundSteer,
    state,
    cleanup,
    saveReleased,
    promptEntered,
    emitAgent: (event: unknown) => internal.handleAgentEvent(record, event),
    holdPrompt: () => {
      holdPrompt = true;
    },
    failNextSave: () => {
      failNextSave = true;
    },
  };
}

await test("new admission cannot emit or prompt ahead of an older agent_settled persistence tail", async (t) => {
  const h = setup();
  let sending: Promise<void> | undefined;
  try {
    await h.endPrior(true);
    assert.equal(h.record.status, "idle");
    assert.equal(h.record.runningRunId, undefined);
    h.delivered.splice(0);
    sending = h.supervisor.sendUserMessage(h.record.ref, { text: "Synthetic next admission" });
    // Drain admission microtasks once while the explicit old persistence gate
    // remains closed. This is an event-loop boundary, not an elapsed-time guess.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeRelease = {
      emitted: [...h.delivered],
      prompts: [...h.prompts],
      steers: [...h.steers],
    };
    t.diagnostic(
      JSON.stringify({ boundary: "older terminal persistence still held", ...beforeRelease }),
    );
    assert.deepEqual(
      beforeRelease,
      { emitted: [], prompts: [], steers: [] },
      "new admission must await delivery of the older native boundary before emitting or starting Pi",
    );
    h.saveReleased.release();
    await sending;
    await h.supervisor.flushSessionEvents(h.record.ref);
    const oldFinished = h.delivered.findIndex(
      (event) => event.type === "runCompleted" && event.runId === h.oldRunId,
    );
    const newStarted = h.delivered.findIndex(
      (event) => event.status === "running" && event.runningRunId !== h.oldRunId,
    );
    assert.ok(oldFinished >= 0, "the actual old mapped terminal must still be delivered");
    assert.ok(newStarted > oldFinished, "new running admission must follow the old terminal");
    assert.equal(h.prompts.length, 1);
    assert.ok(h.prompts[0]!.runId);
    assert.notEqual(h.prompts[0]!.runId, h.oldRunId);
  } finally {
    await h.cleanup(...(sending ? [sending] : []));
  }
});

await test("steer bound to an ended native is rejected without a new prompt or state mutation", async () => {
  const h = setup();
  try {
    await h.endPrior();
    const before = h.state(),
      eventCount = h.delivered.length;
    await assert.rejects(
      h.boundSteer(),
      /Session finished streaming before the queued message could be delivered/,
      "an ended expectedRunningRunId cannot become a fresh turn",
    );
    assert.deepEqual(h.prompts, []);
    assert.deepEqual(h.steers, []);
    assert.deepEqual(h.follows, []);
    assert.deepEqual(h.state(), before);
    assert.equal(
      h.delivered.length,
      eventCount,
      "rejection must not emit a new running/failed native",
    );
  } finally {
    await h.cleanup();
  }
});

await test("steer bound to a prior native cannot attach to a newer admitted native", async () => {
  const h = setup();
  let fresh: Promise<void> | undefined;
  try {
    await h.endPrior();
    h.holdPrompt();
    fresh = h.supervisor.sendUserMessage(h.record.ref, { text: "Synthetic current native" });
    await h.promptEntered.promise;
    await h.supervisor.flushSessionEvents(h.record.ref);
    const before = h.state(),
      eventCount = h.delivered.length;
    assert.equal(before.status, "running");
    assert.ok(before.runningRunId);
    assert.notEqual(before.runningRunId, h.oldRunId);
    await assert.rejects(
      h.boundSteer(),
      /Session finished streaming before the queued message could be delivered/,
      "a stale expectedRunningRunId cannot steer its successor",
    );
    assert.equal(h.prompts.length, 1);
    assert.deepEqual(h.steers, []);
    assert.deepEqual(h.follows, []);
    assert.deepEqual(h.state(), before);
    assert.equal(h.delivered.length, eventCount);
  } finally {
    await h.cleanup(...(fresh ? [fresh] : []));
  }
});

await test("a stale bound handoff rejects before waiting for an unrelated new native preflight", async () => {
  const h = setup(),
    preflight = gate();
  h.session.isStreaming = false;
  h.record.runningRunId = "synthetic-unrelated-preflight-native";
  Object.assign(h.record, {
    promptAdmission: preflight.promise,
    promptReady: preflight.promise,
  });
  const before = h.state();
  let outcome = "pending",
    message = "";
  const sending = h.boundSteer().then(
    () => {
      outcome = "resolved";
    },
    (error: unknown) => {
      outcome = "rejected";
      message = String(error);
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      outcome,
      "rejected",
      "an already different native ID cannot wait on its preflight",
    );
    assert.match(
      message,
      /Session finished streaming before the queued message could be delivered/,
    );
    assert.deepEqual(h.state(), before);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.steers.length, 0);
  } finally {
    Object.assign(h.record, { promptAdmission: undefined, promptReady: undefined });
    preflight.release();
    await h.cleanup(sending);
  }
});

await test("admission persistence failure rejects without prompting and does not poison the next queued request", async () => {
  const h = setup();
  try {
    await h.endPrior();
    h.failNextSave();
    await assert.rejects(
      h.supervisor.sendUserMessage(h.record.ref, { text: "Synthetic failed admission" }),
      /Synthetic admission catalog write failed/,
    );
    assert.equal(h.prompts.length, 0);
    await h.supervisor.sendUserMessage(h.record.ref, {
      text: "Synthetic next usable admission",
    } satisfies SessionMessageInput);
    await h.supervisor.flushSessionEvents(h.record.ref);
    assert.deepEqual(
      h.prompts.map((call) => call.text),
      ["Synthetic next usable admission"],
    );
    assert.equal(h.record.status, "idle");
  } finally {
    await h.cleanup();
  }
});

await test("awaiting a same-session send inside its async listener rejects without queuing or blocking later steering", async (t) => {
  const h = setup(),
    entered = gate(),
    escape = gate();
  const observed: { state: "pending" | "resolved" | "rejected"; error?: unknown } = {
    state: "pending",
  };
  let armed = true,
    sending: Promise<void> | undefined;
  h.record.listeners.add(async () => {
    if (!armed) return;
    armed = false;
    sending = h.boundSteer();
    const settled = sending.then(
      () => {
        observed.state = "resolved";
      },
      (error: unknown) => {
        observed.state = "rejected";
        observed.error = error;
      },
    );
    entered.release();
    // The escape is cleanup only: until finally, this listener is genuinely
    // waiting for the nested send while that send waits on this event queue.
    await Promise.race([settled, escape.promise]);
  });
  try {
    const before = h.state();
    h.emitAgent({ type: "turn_start" });
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.diagnostic(
      JSON.stringify({
        boundary: "same-session listener still owns outer delivery",
        outcome: observed.state,
        queuedMessages: h.record.queuedMessages.length,
        promptCalls: h.prompts.length,
        steerCalls: h.steers.length,
      }),
    );
    assert.equal(
      observed.state,
      "rejected",
      "same-session listener reentry must reject instead of waiting for its own queue tail",
    );
    assert.match(
      String(observed.error),
      /cannot await a same-session send from its event listener/,
    );
    assert.deepEqual(
      h.state(),
      before,
      "rejected reentry must not optimistically add a queued message or change its run",
    );
    assert.equal(h.prompts.length, 0);
    assert.equal(h.steers.length, 0);
    await h.supervisor.flushSessionEvents(h.record.ref);
    await h.boundSteer();
    await h.supervisor.flushSessionEvents(h.record.ref);
    assert.deepEqual(h.steers, ["Synthetic feedback for prior native only"]);
    assert.equal(h.record.runningRunId, h.oldRunId);
  } finally {
    escape.release();
    await h.cleanup(...(sending ? [sending] : []));
  }
});

await test("an independent caller can steer while another async listener is suspended", async () => {
  const h = setup(),
    entered = gate(),
    releaseListener = gate();
  const observed: { state: "pending" | "resolved" | "rejected" } = { state: "pending" };
  let armed = true,
    sending: Promise<void> | undefined;
  h.record.listeners.add(async () => {
    if (!armed) return;
    armed = false;
    entered.release();
    await releaseListener.promise;
  });
  try {
    h.emitAgent({ type: "turn_start" });
    await entered.promise;
    // This continuation was established outside the listener's async context.
    sending = h.boundSteer();
    const settled = sending.then(
      () => {
        observed.state = "resolved";
      },
      () => {
        observed.state = "rejected";
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      observed.state,
      "pending",
      "a suspended listener must not make unrelated callers look reentrant",
    );
    assert.equal(h.steers.length, 0);
    releaseListener.release();
    await sending;
    await settled;
    await h.supervisor.flushSessionEvents(h.record.ref);
    assert.equal(observed.state, "resolved");
    assert.deepEqual(h.steers, ["Synthetic feedback for prior native only"]);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.record.runningRunId, h.oldRunId);
  } finally {
    releaseListener.release();
    await h.cleanup(...(sending ? [sending] : []));
  }
});

await test("async work derived from a returned listener can steer after its delivery context is inactive", async () => {
  const h = setup(),
    entered = gate(),
    startDescendant = gate();
  let armed = true,
    descendant: Promise<void> | undefined,
    settled: Promise<void> | undefined;
  h.record.listeners.add(async () => {
    if (!armed) return;
    armed = false;
    // A derived context retains its async ancestry, but this listener returns
    // before the send starts. Only active listener frames may reject admission.
    descendant = startDescendant.promise.then(() => h.boundSteer());
    settled = descendant.then(
      () => {},
      () => {},
    );
    entered.release();
  });
  try {
    h.emitAgent({ type: "turn_start" });
    await entered.promise;
    await h.supervisor.flushSessionEvents(h.record.ref);
    assert.equal(h.steers.length, 0);
    startDescendant.release();
    assert.ok(descendant);
    await descendant;
    await settled;
    await h.supervisor.flushSessionEvents(h.record.ref);
    assert.deepEqual(h.steers, ["Synthetic feedback for prior native only"]);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.record.runningRunId, h.oldRunId);
  } finally {
    startDescendant.release();
    await h.cleanup(...(descendant ? [descendant] : []), ...(settled ? [settled] : []));
  }
});
