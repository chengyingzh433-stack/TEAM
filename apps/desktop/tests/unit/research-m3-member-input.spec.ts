import { expect, test } from "@playwright/test";
import { sessionKey, type SessionRef } from "@lancer/session-driver";
import { createConversationOwner } from "../../electron/conversation/app-store-composer";
import { createResearchGroupExtension } from "../../electron/research-group/runtime-extension";
import { researchExecutionCount } from "../../electron/research-group/research-execution-policy";
import { m3Coordinator } from "../helpers/research-m3-coordinator-fixture";
import { m3Project, M3_BODY } from "../helpers/research-m3-unit-fixture";
import { assertResearchMemberInputsHandled } from "../../electron/research-group/research-member-input";

async function admittedLeadDraft() {
  const p = (await m3Project("review", "question")).p;
  p.m3 = { defaultModels: { lead: { provider: "fixture", modelId: "logic-only" } } };
  p.packets.push({
    id: "fixture-method",
    role: "lead",
    revision: 1,
    stage: "question",
    query: "synthetic fixture",
    ids: ["M3-FIXTURE"],
    at: new Date().toISOString(),
    records: [{ id: "M3-FIXTURE", text: M3_BODY }],
  });
  const s = await m3Coordinator([p], 4);
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(4);
  const ref = p.members.find((m) => m.role === "lead")!.ref;
  await s.native(p.id, "lead", "start");
  const route = await s.c.tool(ref, "actual-route", { operation: "route" });
  await s.c.tool(ref, "actual-route-applied", { operation: "route-applied", route });
  await s.c.tool(ref, "initial-draft", {
    operation: "publish",
    stage: "question",
    revision: 1,
    kind: "stage-draft",
    refs: [],
    content: M3_BODY + M3_BODY,
  });
  return {
    p,
    s,
    ref,
    draft: s.c.snapshot().projects[0]!.artifacts.find((a) => a.toolCallId === "initial-draft")!,
  };
}

test("composer, direct, background and queued member inputs all enter the real persisted admission owner", async () => {
  const a = (await m3Project("review", "question")).p;
  const b = (await m3Project("review", "question")).p;
  const s = await m3Coordinator([a, b], 1);
  await s.c.resume(a.root);
  await s.c.resume(b.root);
  await expect.poll(() => s.sent.length).toBe(1);
  const ref = b.members.find((m) => m.role === "lead")!.ref;
  const key = sessionKey(ref);
  const raw: string[] = [];
  let status: "idle" | "running" = "idle";
  const cached = new Map([[key, []]]);
  const queue = [
    {
      id: "old-queued",
      text: "USER_QUEUED",
      attachments: [],
      mode: "followUp",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  // Transport-only host: the real coordinator and filesystem repository above own
  // every managed input. No Electron or provider is started by this adapter.
  const owner = createConversationOwner({
    submitManagedMessage: async (
      target: SessionRef,
      text: string,
      _attachments: unknown[],
      delivery?: "steer" | "followUp",
    ) => {
      await s.c.submitMemberInput(target, text, delivery);
      return true;
    },
    conversationState: {
      transcriptCache: cached,
      activeAssistantMessageBySession: new Map(),
      sessionErrorsBySession: new Map(),
      composerDraftsBySession: new Map(),
      composerAttachmentsBySession: new Map(),
      sessionCommandsBySession: new Map(),
      loadedTranscriptKeys: new Set([key]),
    },
    driver: {
      compactSession: async () => {
        raw.push("compact");
      },
      sendUserMessage: async () => {
        raw.push("send");
      },
      replaceQueuedMessages: async (_ref: SessionRef, messages: unknown[]) => {
        if (messages.length) raw.push("queue-paid-input");
      },
    },
    initialize: async () => {},
    ensureSessionReady: async () => {},
    runtimeForWorkspace: () => undefined,
    sessionFromState: () => ({
      status,
      title: "unit managed member",
      updatedAt: new Date().toISOString(),
    }),
    getQueuedComposerEditState: () => undefined,
    setQueuedComposerEditState: () => {},
    getQueuedComposerMessages: () => queue,
    recordUserMessageRecency: () => true,
    persistComposerAttachments: async () => {},
    refreshState: async () => ({}),
    withSessionError: (_ref: SessionRef, error: unknown) => {
      throw error;
    },
  } as never);
  await owner.submitComposerToSession(ref, "USER_COMPOSER_IDLE", []);
  status = "running";
  await owner.submitComposerToSession(ref, "USER_COMPOSER_RUNNING", [], { deliverAs: "followUp" });
  await owner.sendMessageToSession(ref, "USER_DIRECT", []);
  await owner.deliverBackgroundInstruction(ref, "USER_BACKGROUND");
  await owner.steerQueuedComposerMessage(ref, "old-queued");
  await expect(owner.submitComposerToSession(ref, "/compact", [])).rejects.toThrow("手动压缩");
  await s.c.flush();
  expect(raw).toEqual([]);
  expect(s.sent).toHaveLength(1);
  const saved = await s.repository.load();
  const inputs = saved.projects.find((p) => p.id === b.id)!.m3!.memberInputs!;
  expect(inputs.map((input) => input.text)).toEqual([
    "USER_COMPOSER_IDLE",
    "USER_COMPOSER_RUNNING",
    "USER_DIRECT",
    "USER_BACKGROUND",
    "USER_QUEUED",
  ]);
  expect(
    inputs.every((input) => input.revision === 1 && input.actor === "lead" && !input.attemptId),
  ).toBe(true);
  expect(saved.projects.reduce((n, p) => n + researchExecutionCount(p, saved), 0)).toBe(1);
  expect(saved.projects.find((p) => p.id === a.id)!.m3?.memberInputs).toBeUndefined();
});

test("member steering into an admitted native keeps the same attempt and delivers the persisted user text", async () => {
  const p = (await m3Project("review", "question")).p;
  const s = await m3Coordinator([p], 4);
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(4);
  const member = p.members.find((m) => m.role === "lead")!;
  await s.native(p.id, "lead", "start");
  const original = s.c
    .snapshot()
    .projects[0]!.fusion!.attempts.find((a) => a.taskId === "v1:question:lead")!;
  await s.c.submitMemberInput(member.ref, "USER_CURRENT_NATIVE：仅核对现有问题的证据边界", "steer");
  await expect
    .poll(() => s.sent.some((call) => call.text.includes("USER_CURRENT_NATIVE")))
    .toBe(true);
  const current = s.c.snapshot().projects[0]!;
  expect(current.fusion!.attempts).toHaveLength(4);
  expect(current.fusion!.attempts.filter((a) => a.taskId === original.taskId)).toHaveLength(1);
  expect(current.m3!.memberInputs![0]!.attemptId).toBe(original.id);
  expect(researchExecutionCount(current)).toBe(4);
});

test("follow-up waits for the native boundary and old-draft acceptance waits for its actual handling", async () => {
  const { p, s, ref, draft } = await admittedLeadDraft();
  await s.c.submitMemberInput(ref, "USER_FOLLOWUP_ONLY：下一轮补充本稿的限制说明", "followUp");
  await s.c.flush();
  expect(s.sent.some((call) => call.text.includes("USER_FOLLOWUP_ONLY"))).toBe(false);
  expect(
    s.c.snapshot().projects[0]!.fusion!.attempts.filter((a) => a.taskId === "v1:question:lead"),
  ).toHaveLength(1);
  let current = s.c.snapshot().projects[0]!;
  expect(current.m3!.memberInputs![0]!.attemptId).toBeUndefined();
  expect(() =>
    assertResearchMemberInputsHandled(current, "mentor", { verdict: "accept" }, draft),
  ).toThrow("不能接受旧稿");
  await s.native(p.id, "lead", "completed", 100);
  await expect
    .poll(
      () =>
        s.c.snapshot().projects[0]!.fusion!.attempts.filter((a) => a.taskId === "v1:question:lead")
          .length,
    )
    .toBe(2);
  await expect
    .poll(() => s.sent.some((call) => call.text.includes("USER_FOLLOWUP_ONLY")))
    .toBe(true);
  await s.native(p.id, "lead", "start");
  current = s.c.snapshot().projects[0]!;
  const input = current.m3!.memberInputs![0]!;
  await s.c.tool(ref, "read-current-draft", { operation: "read", artifactId: draft.id });
  await s.c.tool(ref, "user-revision", {
    operation: "publish",
    stage: "question",
    revision: 1,
    kind: "stage-revision",
    memberInputIds: [input.id],
    refs: [draft.id],
    content: M3_BODY + M3_BODY + "本次限制说明仅针对当前材料。",
  });
  current = s.c.snapshot().projects[0]!;
  const revised = current.artifacts.find((a) => a.toolCallId === "user-revision")!;
  expect(revised.memberInputIds).toEqual([input.id]);
  expect(current.artifacts.some((a) => a.kind === "stage-critique")).toBe(false);
  expect(() =>
    assertResearchMemberInputsHandled(current, "mentor", { verdict: "accept" }, revised),
  ).not.toThrow();
  expect(
    (await s.repository.load()).projects[0]!.artifacts.find((a) => a.id === revised.id)!
      .memberInputIds,
  ).toEqual([input.id]);
  await s.c.submitMemberInput(
    ref,
    "USER_SECOND_REVISION：在第一份修改基础上再补充可推广范围",
    "steer",
  );
  await expect.poll(() => s.c.snapshot().projects[0]!.m3!.memberInputs![1]!.attemptId).toBeTruthy();
  const secondInput = s.c.snapshot().projects[0]!.m3!.memberInputs![1]!;
  await s.c.tool(ref, "read-revision-one", { operation: "read", artifactId: revised.id });
  await s.c.tool(ref, "second-user-revision", {
    operation: "publish",
    stage: "question",
    revision: 1,
    kind: "stage-revision",
    memberInputIds: [secondInput.id],
    refs: [revised.id],
    content: revised.content + "进一步限定可推广范围，保留上一轮限制。",
  });
  current = s.c.snapshot().projects[0]!;
  const twice = current.artifacts.find((a) => a.toolCallId === "second-user-revision")!;
  expect(twice.memberInputIds).toEqual([secondInput.id]);
  expect(() =>
    assertResearchMemberInputsHandled(current, "mentor", { verdict: "accept" }, twice),
  ).not.toThrow();
});

test("an explicit no-change model response is bound to actual current-draft reading and cannot pass a changed draft", async () => {
  const { s, ref, draft } = await admittedLeadDraft();
  await s.c.submitMemberInput(
    ref,
    "USER_EXPLANATION：解释本稿为何保留这些限制，不要求扩大改写",
    "steer",
  );
  await expect.poll(() => s.c.snapshot().projects[0]!.m3!.memberInputs![0]!.attemptId).toBeTruthy();
  const input = s.c.snapshot().projects[0]!.m3!.memberInputs![0]!;
  const response = {
    operation: "member-input-response",
    memberInputId: input.id,
    artifactId: draft.id,
    memberInputDisposition: "no-manuscript-change",
    content: M3_BODY + M3_BODY,
  };
  await expect(s.c.tool(ref, "unread-response", response)).rejects.toThrow("实际读取");
  await s.c.tool(ref, "read-for-response", { operation: "read", artifactId: draft.id });
  await s.c.tool(ref, "read-response", response);
  const current = s.c.snapshot().projects[0]!;
  expect(current.m3!.memberInputs![0]!.responses![0]!.kind).toBe("model");
  expect(() =>
    assertResearchMemberInputsHandled(current, "mentor", { verdict: "accept" }, draft),
  ).not.toThrow();
  expect(() =>
    assertResearchMemberInputsHandled(
      current,
      "mentor",
      { verdict: "accept" },
      { ...draft, content: draft.content + " changed" },
    ),
  ).toThrow("不能接受旧稿");
  await s.c.submitMemberInput(ref, "USER_NEW_DRAFT：在解释之后明确补充本稿边界", "followUp");
  await s.native(s.c.snapshot().projects[0]!.id, "lead", "completed", 100);
  await expect
    .poll(
      () =>
        s.c.snapshot().projects[0]!.fusion!.attempts.filter((a) => a.taskId === "v1:question:lead")
          .length,
    )
    .toBe(2);
  await s.native(s.c.snapshot().projects[0]!.id, "lead", "start");
  const nextInput = s.c.snapshot().projects[0]!.m3!.memberInputs![1]!;
  await s.c.tool(ref, "reread-for-new-draft", { operation: "read", artifactId: draft.id });
  await s.c.tool(ref, "revision-after-explanation", {
    operation: "publish",
    stage: "question",
    revision: 1,
    kind: "stage-revision",
    memberInputIds: [nextInput.id],
    refs: [draft.id],
    content: draft.content + "本轮进一步说明材料与推断边界。",
  });
  const revised = s.c
    .snapshot()
    .projects[0]!.artifacts.find((a) => a.toolCallId === "revision-after-explanation")!;
  expect(() =>
    assertResearchMemberInputsHandled(
      s.c.snapshot().projects[0]!,
      "mentor",
      { verdict: "accept" },
      revised,
    ),
  ).toThrow("不能接受旧稿");
  await s.c.tool(ref, "read-revised-for-response", { operation: "read", artifactId: revised.id });
  await s.c.tool(ref, "reassess-old-input", { ...response, artifactId: revised.id });
  expect(s.c.snapshot().projects[0]!.m3!.memberInputs![0]!.responses).toHaveLength(2);
  expect(() =>
    assertResearchMemberInputsHandled(
      s.c.snapshot().projects[0]!,
      "mentor",
      { verdict: "accept" },
      revised,
    ),
  ).not.toThrow();
});

test("a known undelivered user steering message is unbound durably and survives restart for the next attempt", async () => {
  const { p, s, ref } = await admittedLeadDraft();
  const original = s.c
    .snapshot()
    .projects[0]!.fusion!.attempts.find((a) => a.taskId === "v1:question:lead")!;
  const deliver = s.host.deliver;
  s.host.deliver = async (target, text) => {
    if (target.sessionId === ref.sessionId && text.includes("USER_MISSED")) {
      await s.c.pause(p.root);
      throw new Error("Session finished streaming before the queued message could be delivered");
    }
    return deliver(target, text);
  };
  await s.c.submitMemberInput(ref, "USER_MISSED：仅下一次实际收到后处理", "steer");
  await expect
    .poll(() =>
      s.c.snapshot().projects[0]!.events.some((e) => e.detail.includes("撤回本次投送绑定")),
    )
    .toBe(true);
  expect(s.c.snapshot().projects[0]!.m3!.memberInputs![0]!.attemptId).toBeUndefined();
  await s.c.load();
  await s.c.resolveAttempt(p.root, {
    attemptId: original.id,
    outcome: "succeeded",
    evidenceRef: "unit-driver-ended-boundary",
    reason: "原生记录确认原请求已结束，补充明确未送达。",
    usedTokens: 100,
  });
  s.host.deliver = deliver;
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.some((call) => call.text.includes("USER_MISSED"))).toBe(true);
  const current = s.c.snapshot().projects[0]!;
  expect(current.m3!.memberInputs![0]!.attemptId).not.toBe(original.id);
});

test("a specialist user question before the first opinion is saved outside independent context, then queued for discussion", async () => {
  const p = (await m3Project("review", "synthesis")).p;
  const s = await m3Coordinator([p], 1);
  await s.c.applyM3Action(p.root, {
    operation: "add-specialist",
    kind: "method",
    label: "输入隔离专项",
    objective: "独立核对方法边界",
    deliverable: "具体方法意见",
    exitCondition: "交付后待整合",
    integrator: "lead",
    sourceIds: ["paper-a"],
    artifactIds: [],
    model: { provider: "fixture", modelId: "independent" },
  });
  await s.c.resume(p.root);
  const specialist = s.c.snapshot().projects[0]!.m3!.specialists![0]!;
  await s.c.submitMemberInput(
    specialist.ref,
    "PRIVATE_USER_LATER_QUESTION：初判完成后再检查新增争论",
  );
  await expect
    .poll(async () => {
      const current = s.c.snapshot().projects[0]!;
      if (current.fusion!.attempts.some((a) => a.taskId === specialist.taskId)) return true;
      const active = current.fusion!.attempts.find((a) => a.state === "running");
      if (active) {
        const role = current.fusion!.tasks.find((t) => t.id === active.taskId)!.role as "lead";
        await s.native(p.id, role, "start");
        await s.native(p.id, role, "completed", 100);
      }
      return false;
    })
    .toBe(true);
  expect(
    s.sent.find((call) => call.ref.sessionId === specialist.ref.sessionId)!.text,
  ).not.toContain("PRIVATE_USER_LATER_QUESTION");
  await s.native(p.id, { specialistId: specialist.id }, "start");
  expect(
    JSON.stringify(
      await s.c.tool(specialist.ref, "before-context", { operation: "specialist-context" }),
    ),
  ).not.toContain("PRIVATE_USER_LATER_QUESTION");
  for (const input of [
    { operation: "source-read", sourceId: "paper-a" },
    { operation: "method-package" },
    { operation: "specialist-submit", content: M3_BODY + M3_BODY },
  ])
    await s.c.tool(specialist.ref, input.operation, input);
  const current = s.c.snapshot().projects[0]!;
  expect(current.m3!.specialists![0]!.initialOpinion).toBeTruthy();
  expect(current.m3!.specialists![0]!.discussionOpenedAt).toBeTruthy();
  expect(
    JSON.stringify(
      await s.c.tool(specialist.ref, "after-context", { operation: "specialist-context" }),
    ),
  ).toContain("PRIVATE_USER_LATER_QUESTION");
  await s.native(p.id, { specialistId: specialist.id }, "completed", 100);
  await expect
    .poll(
      () =>
        s.c.snapshot().projects[0]!.fusion!.attempts.filter((a) => a.taskId === specialist.taskId)
          .length,
    )
    .toBe(2);
  await s.native(p.id, { specialistId: specialist.id }, "start");
  const second = s.c
    .snapshot()
    .projects[0]!.fusion!.attempts.filter((a) => a.taskId === specialist.taskId)
    .at(-1)!;
  await s.c.submitMemberInput(specialist.ref, "QUESTION_DURING_FOLLOWUP_ONE：等待下次讨论");
  await s.c.submitMemberInput(specialist.ref, "QUESTION_DURING_FOLLOWUP_TWO：保留第二条问题");
  await s.c.tool(specialist.ref, "followup-two", {
    operation: "specialist-submit",
    content: M3_BODY + M3_BODY + "首次讨论的后续意见。",
  });
  expect(s.c.snapshot().projects[0]!.m3!.specialists![0]!.state).toBe("pending");
  expect(
    s.c
      .snapshot()
      .projects[0]!.m3!.memberInputs!.filter((input) => input.text.includes("QUESTION_DURING"))
      .every((input) => !input.attemptId),
  ).toBe(true);
  await s.native(p.id, { specialistId: specialist.id }, "completed", 150);
  await expect
    .poll(
      () =>
        s.c.snapshot().projects[0]!.fusion!.attempts.filter((a) => a.taskId === specialist.taskId)
          .length,
    )
    .toBe(3);
  const third = s.c
    .snapshot()
    .projects[0]!.fusion!.attempts.filter((a) => a.taskId === specialist.taskId)
    .at(-1)!;
  expect(third.id).not.toBe(second.id);
  expect(
    s.c
      .snapshot()
      .projects[0]!.m3!.memberInputs!.filter((input) => input.text.includes("QUESTION_DURING"))
      .every((input) => input.attemptId === third.id),
  ).toBe(true);
  await s.native(p.id, { specialistId: specialist.id }, "start");
  await s.c.tool(specialist.ref, "followup-three", {
    operation: "specialist-submit",
    content: M3_BODY + M3_BODY + "逐项回应两条新问题。",
  });
  await s.native(p.id, { specialistId: specialist.id }, "completed", 200);
  expect(s.c.snapshot().projects[0]!.m3!.specialists![0]!.state).toBe("submitted");
  expect(
    s.c
      .snapshot()
      .projects[0]!.fusion!.tasks.find((t) => t.id === specialist.taskId)!
      .continuations.every((c) => c.attemptId),
  ).toBe(true);
});

test("a route failure explicitly aborts the native startup instead of relying on a swallowed extension error", async () => {
  const p = (await m3Project("review", "question")).p;
  const s = await m3Coordinator([p], 1);
  await s.c.applyM3Action(p.root, {
    operation: "task-model",
    taskId: "v1:question:mentor",
    model: { provider: "missing", modelId: "unavailable" },
  });
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(1);
  let before:
    | ((event: { systemPromptOptions: Record<string, unknown> }, ctx: unknown) => Promise<unknown>)
    | undefined;
  let aborted = false;
  const extension = createResearchGroupExtension((_ctx, callId, input) =>
    s.c.tool(p.root, callId, input),
  );
  await extension({
    on: (event: string, callback: typeof before) => {
      if (event === "before_agent_start") before = callback;
    },
    getThinkingLevel: () => "high",
    setModel: async () => {
      throw new Error("missing models cannot silently use another model");
    },
    registerTool: () => {},
  } as never);
  const context = {
    model: { provider: "fixture", id: "previous-model" },
    sessionManager: { getSessionId: () => p.root.sessionId },
    modelRegistry: { find: () => undefined },
    abort: () => {
      aborted = true;
    },
  };
  await expect(before!({ systemPromptOptions: {} }, context)).rejects.toThrow("模型或认证不可用");
  expect(aborted).toBe(true);
  expect(s.c.snapshot().projects[0]!.error).toContain("unavailable");
});
test("scope transport failures abort and block other tools while an explicit unmanaged scope stays ordinary", async () => {
  let before:
    | ((event: { systemPromptOptions: Record<string, unknown> }, ctx: unknown) => Promise<unknown>)
    | undefined;
  let tool: ((event: { toolName: string }, ctx: unknown) => Promise<unknown>) | undefined;
  let unavailable = true,
    aborts = 0;
  const extension = createResearchGroupExtension(async () => {
    if (unavailable) throw new Error("scope unavailable");
    return { scope: "none" };
  });
  await extension({
    on: (event: string, callback: unknown) => {
      if (event === "before_agent_start") before = callback as typeof before;
      if (event === "tool_call") tool = callback as typeof tool;
    },
    registerTool: () => {},
  } as never);
  const context = {
    abort: () => {
      aborts++;
    },
  };
  await expect(before!({ systemPromptOptions: {} }, context)).rejects.toThrow("scope unavailable");
  expect(await tool!({ toolName: "read" }, context)).toMatchObject({ block: true });
  expect(aborts).toBe(2);
  unavailable = false;
  expect(await before!({ systemPromptOptions: {} }, context)).toBeUndefined();
  expect(await tool!({ toolName: "read" }, context)).toBeUndefined();
  expect(aborts).toBe(2);
});
