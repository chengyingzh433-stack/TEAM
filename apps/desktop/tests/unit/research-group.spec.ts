import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeResearchStudyFixture } from "../helpers/research-study-fixture";
import {
  RESEARCH_ROLES,
  decodeResearchAction,
  decodeResearchRoute,
  researchStages,
  type ResearchConfig,
  type ResearchRole,
} from "../../contracts/research-group";
import { recommendResearchStages } from "../../contracts/research-model-recommendations";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { ResearchRepository, decodeResearchState } from "../../electron/research-group/repository";

const body =
  "研究问题应匹配可获得的证据。满意度不能替代论证质量，也不能单独支持效果或因果判断。需明确研究对象、可行的比较、材料编码及其限制，并保留尚待确认的课堂条件。";
async function setup(config: Partial<ResearchConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "research-group-"));
  const kb = join(dir, "course"),
    workspace = join(dir, "workspace");
  await Promise.all([
    mkdir(join(kb, "索引"), { recursive: true }),
    mkdir(join(kb, "溯源"), { recursive: true }),
    mkdir(workspace),
  ]);
  const records = [
    { id: "METHOD", title: "研究问题 证据匹配", text: body, required_context_ids: ["BOUNDARY"] },
    { id: "BOUNDARY", title: "测量边界", text: body, required_context_ids: ["SOURCE"] },
    {
      id: "SOURCE",
      title: "出处",
      text: "单元测试合成方法条目，不是实际课程内容。",
      required_context_ids: [],
    },
  ];
  const index = join(kb, "索引", "知识块.jsonl");
  await writeFile(index, records.map((r) => JSON.stringify(r)).join("\n"));
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "fixture-1" }));
  const sent: { role: string; text: string }[] = [],
    cancelled: string[] = [],
    releases: (() => void)[] = [];
  const host: ResearchHost = {
    createMember: async (root, role, model) => ({
      role,
      model,
      ref: { workspaceId: root.workspaceId, sessionId: role },
      status: "idle",
    }),
    deliver: async (ref, text) => {
      sent.push({ role: ref.sessionId, text });
      await new Promise<void>((resolve) => releases.push(resolve));
    },
    cancel: async (ref) => {
      cancelled.push(ref.sessionId);
      releases.splice(0).forEach((r) => r());
    },
    changed: () => {},
  };
  const repository = new ResearchRepository(dir),
    coordinator = new ResearchCoordinator(repository, host);
  await coordinator.load();
  await coordinator.configure({ knowledgeDir: kb, scope: "proposal", ...config });
  const root = { workspaceId: workspace, sessionId: "mentor" };
  await coordinator.start(
    root,
    workspace,
    "AI 反馈能否改善物理实验报告？目前只有满意度调查。请打磨问题并审阅初步方案。",
  );
  // Legacy dispatch now persists admission before invoking the host. Fusion cases
  // deliberately own their prepare/pause/native boundary individually below.
  if (config.workflowVersion !== "fusion-v2") await coordinator.flush();
  const ref = (role: ResearchRole) => ({ workspaceId: workspace, sessionId: role });
  let serial = 0;
  const tool = (role: ResearchRole, args: Record<string, unknown>) =>
    coordinator.tool(ref(role), `call-${++serial}`, args);
  const publish = async (role: ResearchRole, kind: string, refs: string[] = [], verdict?: string) =>
    tool(role, {
      operation: "publish",
      revision: 1,
      kind,
      content: body + body,
      refs,
      verdict,
    }) as Promise<{ id: string }>;
  return {
    dir,
    kb,
    index,
    records,
    coordinator,
    host,
    repository,
    root,
    ref,
    tool,
    publish,
    sent,
    cancelled,
    releases,
  };
}

test("structured status does not disclose future peer checks after an earlier stage's own judgment", async () => {
  const s = await setup({
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
    path: "quantitative",
  });
  await s.coordinator.pause(s.root);
  const saved = s.coordinator.snapshot(),
    project = saved.projects[0]!,
    secret = "PRIVATE_A_MODEL_JUDGMENT_FOR_STATUS_REGRESSION";
  // A valid persisted check fixture; its body is private model work, not research evidence.
  project.contentChecks = [
    {
      id: "status-private-check-fixture",
      at: new Date().toISOString(),
      kind: "claim-acceptance",
      target: null,
      program: { kind: "program", id: "claim-acceptance-1" },
      role: "lead",
      stage: "audit",
      issues: [
        {
          code: "fixture-private-claim",
          detail: secret,
          exactText: secret,
          start: 0,
          end: secret.length,
        },
      ],
      claimChecks: [],
      unboundCandidates: [],
      result: "blocked",
      snapshotToken: "a".repeat(64),
      boundary: "Synthetic privacy regression fixture, no scientific claim.",
    },
  ];
  await s.repository.save(saved);
  const coordinator = new ResearchCoordinator(s.repository, s.host);
  await coordinator.load();
  try {
    const before = await coordinator.tool(s.ref("reviewer"), "status-before-risk", {
      operation: "status",
    });
    expect(JSON.stringify(before)).not.toContain(secret);
    await coordinator.resume(s.root);
    await expect
      .poll(() => {
        const p = coordinator.snapshot().projects[0]!;
        return p.fusion!.attempts.some(
          (attempt) =>
            ["prepared", "running"].includes(attempt.state) &&
            p.fusion!.tasks.some((task) => task.id === attempt.taskId && task.role === "reviewer"),
        );
      })
      .toBe(true);
    const timestamp = new Date().toISOString();
    coordinator.onSessionEvent({
      type: "sessionUpdated",
      sessionRef: s.ref("reviewer"),
      timestamp,
      runId: "synthetic-status-independent-reviewer",
      snapshot: {
        ref: s.ref("reviewer"),
        workspace: { workspaceId: s.root.workspaceId, path: s.root.workspaceId },
        title: "reviewer",
        status: "running",
        updatedAt: timestamp,
      },
    });
    await coordinator.flush();
    const route = await coordinator.tool(s.ref("reviewer"), "status-fixture-route", {
      operation: "route",
    });
    await coordinator.tool(s.ref("reviewer"), "status-fixture-route-applied", {
      operation: "route-applied",
      route: {
        ...(route as object),
        model: { provider: "unit-fixture", modelId: "synthetic-model" },
      },
    });
    await coordinator.tool(s.ref("reviewer"), "own-knowledge", {
      operation: "knowledge",
      query: "研究问题",
    });
    await coordinator.tool(s.ref("reviewer"), "own-independent-risk", {
      operation: "publish",
      revision: 1,
      stage: "question",
      kind: "stage-risk",
      content: body + body,
      refs: [],
      sourceIds: [],
    });
    const after = await coordinator.tool(s.ref("reviewer"), "status-after-risk", {
      operation: "status",
    });
    expect(JSON.stringify(after)).not.toContain(secret);
  } finally {
    await coordinator.pause(s.root);
  }
});

test("another task depending on an existing condition waits without duplicating its request or answer", async () => {
  const s = await setup({
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
    path: "quantitative",
  });
  try {
    const decision = {
      conditionId: "shared-public-scope",
      question: "本轮最终材料范围是否限于公共材料？",
      context: "软件测试条件，不代表伦理审批。",
      impact: "仅等待实际依赖本条件的工作。",
      taskIds: ["v1:question:lead"],
      recommendedOptionId: "public-only",
      options: [
        {
          id: "public-only",
          label: "公共材料",
          consequence: "按此范围继续。",
          outcome: "confirmed",
        },
        { id: "later", label: "暂缓", consequence: "相关工作等待。", outcome: "deferred" },
      ],
    };
    await s.tool("mentor", { operation: "request-decision", decision });
    const original = structuredClone(s.coordinator.snapshot().projects[0]!.fusion!),
      first = original.decisionRequests![0]!;
    await s.tool("reviewer", {
      operation: "request-decision",
      decision: { ...decision, taskIds: ["v1:question:reviewer"] },
    });
    const waiting = s.coordinator.snapshot().projects[0]!.fusion!;
    expect(waiting.decisionRequests).toHaveLength(1);
    expect(waiting.decisionRequests![0]!.id).toBe(first.id);
    expect(waiting.decisions).toEqual([]);
    expect(waiting.tasks.find((t) => t.role === "reviewer")!.blockers).toContainEqual({
      kind: "decision",
      objectId: first.inputId,
      reason: "等待该版本条件的实际用户回复。",
    });
    expect(waiting.tasks.find((t) => t.role === "librarian")).toEqual(
      original.tasks.find((t) => t.role === "librarian"),
    );
    await s.coordinator.answerDecision(s.root, {
      requestId: first.id,
      optionId: "public-only",
      text: "测试操作者选择现有公共材料范围。",
    });
    const answered = structuredClone(s.coordinator.snapshot().projects[0]!.fusion!);
    await s.tool("mentor", {
      operation: "request-decision",
      decision: { ...decision, taskIds: ["v1:question:mentor"] },
    });
    const continued = s.coordinator.snapshot().projects[0]!.fusion!;
    expect(continued.decisionRequests).toHaveLength(1);
    expect(continued.decisions).toEqual(answered.decisions);
    expect(continued.tasks.find((t) => t.role === "mentor")!.inputs).toContainEqual({
      inputId: first.inputId,
      version: first.version,
      requirement: "user-confirmed",
    });
    expect(
      continued.tasks.find((t) => t.role === "mentor")!.blockers.some((b) => b.kind === "decision"),
    ).toBe(false);
    const beforeRepeat = structuredClone(continued);
    await s.tool("reviewer", {
      operation: "request-decision",
      decision: { ...decision, taskIds: ["v1:question:reviewer"] },
    });
    const afterRepeat = s.coordinator.snapshot().projects[0]!.fusion!;
    expect(afterRepeat.decisionRequests).toEqual(beforeRepeat.decisionRequests);
    expect(afterRepeat.decisions).toEqual(beforeRepeat.decisions);
    expect(
      afterRepeat.tasks.map(({ id, inputVersion, inputs }) => ({ id, inputVersion, inputs })),
    ).toEqual(
      beforeRepeat.tasks.map(({ id, inputVersion, inputs }) => ({ id, inputVersion, inputs })),
    );
    await s.coordinator.flush();
    const stored = decodeResearchState(
      JSON.parse(await readFile(join(s.dir, "research-groups.json"), "utf8")),
    );
    expect(stored.projects[0]!.fusion!.decisionRequests).toEqual(beforeRepeat.decisionRequests);
    expect(stored.projects[0]!.fusion!.decisions).toEqual(beforeRepeat.decisions);
  } finally {
    await s.coordinator.pause(s.root);
  }
});

test("rewording a known condition preserves the user's answer; actual changes create a scoped pending version", async () => {
  const s = await setup({
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
    path: "quantitative",
  });
  try {
    const decision = {
      conditionId: "research-material-use",
      question: "本轮是否仅使用公共材料？",
      context: "公共材料用途需要明确。",
      impact: "仅设计判断依赖此条件。",
      taskIds: ["v1:question:lead"],
      recommendedOptionId: "public-only",
      options: [
        {
          id: "public-only",
          label: "只用公共材料",
          consequence: "在公共资料范围继续。",
          outcome: "confirmed",
        },
        { id: "later", label: "暂缓", consequence: "相关任务继续等待。", outcome: "deferred" },
      ],
    };
    await s.tool("mentor", { operation: "request-decision", decision });
    const original = s.coordinator.snapshot().projects[0]!.fusion!.decisionRequests![0]!;
    await s.coordinator.answerDecision(s.root, {
      requestId: original.id,
      optionId: "public-only",
      text: "本轮只分析公共二手资料，不联系参与者。",
    });
    const confirmed = structuredClone(s.coordinator.snapshot().projects[0]!.fusion!);
    await s.tool("mentor", {
      operation: "request-decision",
      decision: {
        ...decision,
        question: "是否确认使用公开资料？",
        context: "换一种措辞重新询问。",
        recommendedOptionId: "later",
      },
    });
    const repeated = s.coordinator.snapshot().projects[0]!.fusion!;
    expect(repeated.decisionRequests).toEqual(confirmed.decisionRequests);
    expect(repeated.decisions).toEqual(confirmed.decisions);
    expect(repeated.adoptedInputs).toEqual(confirmed.adoptedInputs);
    await expect(
      s.tool("mentor", {
        operation: "request-decision",
        decision: {
          ...decision,
          supersedesRequestId: "wrong-request",
          changedCondition: "新增非公开访谈资料。",
        },
      }),
    ).rejects.toThrow("最新版本");
    await s.tool("mentor", {
      operation: "request-decision",
      decision: {
        ...decision,
        question: "新增非公开访谈是否已取得研究许可？",
        supersedesRequestId: original.id,
        changedCondition: "新增材料为非公开访谈，超出原公共资料范围。",
      },
    });
    const changed = s.coordinator.snapshot().projects[0]!.fusion!;
    expect(changed.decisionRequests).toHaveLength(2);
    expect(changed.decisionRequests![1]!.version).toBe(2);
    expect(changed.decisions).toEqual(confirmed.decisions);
    expect(changed.decisions.some((d) => d.requestId === changed.decisionRequests![1]!.id)).toBe(
      false,
    );
    expect(changed.tasks.find((t) => t.id === "v1:question:librarian")!.blockers).toEqual(
      confirmed.tasks.find((t) => t.id === "v1:question:librarian")!.blockers,
    );
    expect(changed.decisionRequests![1]!.affectedTaskIds).not.toContain("v1:question:librarian");
    expect(s.coordinator.snapshot().projects[0]!.events.at(-1)!.detail).toContain(
      "新增材料为非公开访谈",
    );
  } finally {
    await s.coordinator.pause(s.root);
  }
});

test("read-only retrieval recursively includes required context and detects a changed source", async () => {
  const s = await setup();
  const before = await readFile(s.index);
  const kb = await ResearchKnowledge.open(s.kb);
  expect(kb.retrieve("", "lead", ["METHOD"]).map((r) => r.id)).toEqual([
    "METHOD",
    "BOUNDARY",
    "SOURCE",
  ]);
  expect(await readFile(s.index)).toEqual(before);
  await writeFile(s.index, before.toString() + "\n");
  await expect(kb.assertPinned(kb.pin)).rejects.toThrow("已变化");
  await s.coordinator.pause(s.root);
  await s.coordinator.start(s.root, s.root.workspaceId, "补充：已确定报告任务，但审批仍待确认。");
  const continued = s.coordinator.snapshot().projects[0]!;
  expect(continued.revision).toBe(2);
  expect(continued.objective).toContain("AI 反馈能否改善物理实验报告");
  expect(continued.objective).toContain("审批仍待确认");
  expect(continued.members.map((m) => m.ref.sessionId)).toEqual([...RESEARCH_ROLES]);
  await s.coordinator.pause(s.root);
});

test("mid-run handoff, independent initial judgments and reciprocal review require actual reads", async () => {
  const s = await setup();
  expect(s.sent.map((m) => m.role)).toEqual([...RESEARCH_ROLES]);
  for (const role of RESEARCH_ROLES) {
    s.coordinator.onSessionEvent({
      type: "sessionUpdated",
      sessionRef: s.ref(role),
      timestamp: new Date().toISOString(),
      runId: `${role}-run`,
      snapshot: {
        ref: s.ref(role),
        workspace: { workspaceId: s.root.workspaceId, path: s.root.workspaceId },
        title: role,
        status: "running",
        updatedAt: new Date().toISOString(),
      },
    });
    s.coordinator.onSessionEvent({
      type: "assistantDelta",
      sessionRef: s.ref(role),
      timestamp: new Date().toISOString(),
      runId: `${role}-run`,
      text: "开始独立判断",
    });
  }
  await s.coordinator.flush();
  for (const role of RESEARCH_ROLES)
    await s.tool(role, { operation: "knowledge", ids: ["METHOD"] });
  const material = await s.publish("librarian", "material");
  await s.tool("lead", { operation: "read", artifactId: material.id });
  expect(
    s.coordinator
      .snapshot()
      .projects[0]!.events.some(
        (e) => e.type === "read" && e.artifactId === material.id && e.producerRunning,
      ),
  ).toBe(true);
  expect(s.sent.some((m) => m.role === "lead" && m.text.includes(material.id))).toBe(true);
  expect(
    s.coordinator.snapshot().projects[0]!.events.filter((e) => e.type === "finished"),
  ).toHaveLength(0);
  const proposal = await s.publish("lead", "proposal");
  await expect(s.tool("reviewer", { operation: "read", artifactId: proposal.id })).rejects.toThrow(
    "独立",
  );
  await s.publish("reviewer", "assessment");
  await expect(s.publish("reviewer", "critique", [proposal.id])).rejects.toThrow("实际读取");
  await s.tool("reviewer", { operation: "read", artifactId: proposal.id });
  const critique = await s.publish("reviewer", "critique", [proposal.id]);
  await expect(s.publish("lead", "revision", [critique.id])).rejects.toThrow("实际读取");
  await s.tool("lead", { operation: "read", artifactId: critique.id });
  const revision = await s.publish("lead", "revision", [critique.id]);
  await expect(
    s.tool("lead", { operation: "publish", revision: 0, kind: "revision", content: body + body }),
  ).rejects.toThrow("版本过期");
  await s.tool("reviewer", { operation: "read", artifactId: revision.id });
  const verification = await s.publish("reviewer", "verification", [revision.id], "accept");
  await s.publish("mentor", "plan");
  await expect(
    s.publish("mentor", "review", [revision.id, verification.id], "accept"),
  ).rejects.toThrow("实际读取");
  await s.tool("mentor", { operation: "read", artifactId: revision.id });
  await s.tool("mentor", { operation: "read", artifactId: verification.id });
  await s.publish("mentor", "review", [revision.id, verification.id], "accept");
  expect(s.coordinator.snapshot().projects[0]!.status).toBe("completed");
  await s.coordinator.pause(s.root);
});

test("mentor cannot override a failed review; two revisions end in a decision instead of automatic acceptance", async () => {
  const s = await setup();
  for (const role of RESEARCH_ROLES)
    await s.tool(role, { operation: "knowledge", ids: ["METHOD"] });
  await s.publish("mentor", "plan");
  const proposal = await s.publish("lead", "proposal");
  await s.publish("reviewer", "assessment");
  await s.tool("reviewer", { operation: "read", artifactId: proposal.id });
  let blocker = await s.publish("reviewer", "critique", [proposal.id]);
  let revision: { id: string } = proposal;
  for (let round = 0; round < 2; round++) {
    await s.tool("lead", { operation: "read", artifactId: blocker.id });
    revision = await s.publish("lead", "revision", [blocker.id]);
    await s.tool("reviewer", { operation: "read", artifactId: revision.id });
    blocker = await s.publish("reviewer", "verification", [revision.id], "revise");
  }
  await s.tool("mentor", { operation: "read", artifactId: revision.id });
  await s.tool("mentor", { operation: "read", artifactId: blocker.id });
  await expect(s.publish("mentor", "review", [revision.id, blocker.id], "accept")).rejects.toThrow(
    "不能标记通过",
  );
  await s.publish("mentor", "review", [revision.id, blocker.id], "revise");
  expect(s.coordinator.snapshot().projects[0]!.status).toBe("needs-decision");
  await s.coordinator.pause(s.root);
});

test("restart retains role sessions and artifacts, pauses unknown runs, and never replays requests", async () => {
  const s = await setup();
  await s.tool("lead", { operation: "knowledge", ids: ["METHOD"] });
  const proposal = await s.publish("lead", "proposal");
  await s.coordinator.flush();
  let sends = 0;
  const c = new ResearchCoordinator(s.repository, {
    createMember: async () => {
      throw new Error("unexpected member creation");
    },
    deliver: async () => {
      sends++;
    },
    cancel: async () => {},
    changed: () => {},
  });
  await c.load();
  expect(c.snapshot().projects[0]).toMatchObject({
    status: "paused",
    artifacts: [{ id: proposal.id }],
  });
  expect(c.snapshot().projects[0]!.members.map((m) => m.ref)).toEqual(
    s.coordinator.snapshot().projects[0]!.members.map((m) => m.ref),
  );
  expect(sends).toBe(0);
  await writeFile(s.index, (await readFile(s.index, "utf8")) + "\n");
  await expect(c.resume(s.root)).rejects.toThrow("已变化");
  await s.coordinator.pause(s.root);
});

test("corrupt saved state is retained and blocks writes instead of creating an empty project list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "research-corrupt-"));
  const path = join(dir, "research-groups.json");
  const bytes = '{"version":1,"broken":';
  await writeFile(path, bytes);
  const c = new ResearchCoordinator(new ResearchRepository(dir), {
    createMember: async () => {
      throw new Error("unexpected");
    },
    deliver: async () => {},
    cancel: async () => {},
    changed: () => {},
  });
  await c.load();
  expect(c.snapshot().error).toContain("损坏");
  await expect(c.pause({ workspaceId: "w", sessionId: "s" })).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test("idle members without required artifacts are not mistaken for an active or accepted review", async () => {
  const s = await setup();
  for (const role of RESEARCH_ROLES) {
    const snapshot = {
      ref: s.ref(role),
      workspace: { workspaceId: s.root.workspaceId, path: s.root.workspaceId },
      title: role,
      status: "running" as const,
      updatedAt: new Date().toISOString(),
    };
    s.coordinator.onSessionEvent({
      type: "sessionUpdated",
      sessionRef: s.ref(role),
      timestamp: new Date().toISOString(),
      runId: role,
      snapshot,
    });
    s.coordinator.onSessionEvent({
      type: "runCompleted",
      sessionRef: s.ref(role),
      timestamp: new Date().toISOString(),
      runId: role,
      snapshot: { ...snapshot, status: "idle" },
    });
  }
  await s.coordinator.flush();
  s.releases.splice(0).forEach((resolve) => resolve());
  await expect.poll(() => s.coordinator.snapshot().projects[0]!.status).toBe("needs-decision");
  expect(s.coordinator.snapshot().projects[0]!.error).toContain("审阅链尚未闭合");
  await s.coordinator.resume(s.root);
  await s.coordinator.flush();
  expect(s.sent).toHaveLength(8);
  expect(s.coordinator.snapshot().projects[0]!.members.map((m) => m.ref.sessionId)).toEqual([
    ...RESEARCH_ROLES,
  ]);
  await s.coordinator.pause(s.root);
});

test("a matching native failure after pause remains a known failure and can be explicitly retried", async () => {
  const s = await setup({
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
  });
  try {
    await expect.poll(() => s.sent.some((item) => item.role === "lead")).toBe(true);
    const at = new Date().toISOString(),
      ref = s.ref("lead");
    s.coordinator.onSessionEvent({
      type: "sessionUpdated",
      sessionRef: ref,
      timestamp: at,
      runId: "pause-failure-run",
      snapshot: {
        ref,
        workspace: { workspaceId: ref.workspaceId, path: ref.workspaceId },
        title: "lead",
        status: "running",
        updatedAt: at,
      },
    });
    await s.coordinator.flush();
    await expect
      .poll(
        () =>
          s.coordinator
            .snapshot()
            .projects[0]!.fusion!.attempts.find((a) => a.nativeRunId === "pause-failure-run")
            ?.state,
      )
      .toBe("running");
    const attempt = s.coordinator
      .snapshot()
      .projects[0]!.fusion!.attempts.find((a) => a.nativeRunId === "pause-failure-run")!;
    await s.coordinator.pause(s.root);
    s.coordinator.onSessionEvent({
      type: "runFailed",
      sessionRef: ref,
      timestamp: new Date().toISOString(),
      runId: "pause-failure-run",
      error: { message: "service failed while cancellation was settling" },
    });
    await s.coordinator.flush();
    const failed = s.coordinator.snapshot().projects[0]!;
    expect(failed.status).toBe("paused");
    expect(failed.fusion!.attempts.find((a) => a.id === attempt.id)!.state).toBe("failed");
    expect(failed.fusion!.tasks.find((t) => t.id === attempt.taskId)!.state).toBe("failed");
    const sent = s.sent.length;
    await s.coordinator.retryTask(s.root, {
      taskId: attempt.taskId,
      reason: "已核查服务错误，用户明确重试此任务。",
    });
    expect(s.coordinator.snapshot().projects[0]!.fusion!.retryRequests).toHaveLength(1);
    expect(s.sent.length).toBe(sent);
    expect(s.coordinator.snapshot().projects[0]!.status).toBe("paused");
    const stored = decodeResearchState(
      JSON.parse(await readFile(join(s.dir, "research-groups.json"), "utf8")),
    );
    expect(stored.projects[0]!.fusion!.attempts.find((a) => a.id === attempt.id)!.state).toBe(
      "failed",
    );
  } finally {
    await s.coordinator.pause(s.root);
  }
});

test("stage configuration preserves legacy member models and rejects unknown phases and thinking levels", () => {
  const legacy = { provider: "fixture", modelId: "fast" };
  expect(researchStages({ models: { lead: legacy } }).map((s) => s.models.lead)).toEqual(
    Array(7).fill(legacy),
  );
  const stages = researchStages({ models: { lead: legacy } });
  stages[1]!.models = {};
  expect(researchStages({ models: { lead: legacy }, stages })[1]!.models.lead).toBeUndefined();
  const config = { knowledgeDir: "/course", stages };
  expect(
    decodeResearchAction({
      kind: "configure",
      config,
      target: { workspaceId: "w", sessionId: "s" },
    }),
  ).toMatchObject({ config: { stages }, target: { sessionId: "s" } });
  expect(() =>
    decodeResearchAction({
      kind: "configure",
      config: { ...config, stages: [stages[0], stages[0]] },
    }),
  ).toThrow("阶段");
  expect(() =>
    decodeResearchAction({ kind: "configure", config: { ...config, stages: null } }),
  ).toThrow("阶段");
  expect(() =>
    decodeResearchAction({
      kind: "configure",
      config: { ...config, models: { lead: { ...legacy, thinkingLevel: "invented" } } },
    }),
  ).toThrow("思考");
});

test("recommended models use enabled choices, preserve provider identity and disclose missing choices", () => {
  const available = [
    { provider: "openai-codex", modelId: "gpt-6-astra" },
    { provider: "openai-codex", modelId: "gpt-6.1-sol" },
    { provider: "deepseek", modelId: "deepseek-flash" },
  ];
  const recommendation = recommendResearchStages(available);
  expect(recommendation.missing).toEqual([]);
  expect(recommendation.stages[0]!.models.reviewer).toMatchObject({
    modelId: "gpt-6.1-sol",
    thinkingLevel: "high",
  });
  expect(recommendation.stages[1]!.models.reviewer).toMatchObject({
    modelId: "gpt-6-astra",
    thinkingLevel: "high",
  });
  expect(recommendation.stages[1]!.models.librarian).toMatchObject({
    modelId: "deepseek-flash",
    thinkingLevel: "low",
  });
  expect(recommendResearchStages(available.slice(2)).missing).toEqual(
    expect.arrayContaining(["gpt-6-astra", "gpt-6.1-sol"]),
  );
});

test("each role changes stage when its dependency arrives, records its actual model and keeps its session", async () => {
  const stages = researchStages();
  for (const stage of stages)
    for (const role of RESEARCH_ROLES)
      stage.models[role] = {
        provider: "fixture",
        modelId: stage.id === "question" ? "fast" : "deep",
        thinkingLevel: stage.id === "question" ? "low" : "high",
      };
  const s = await setup({ stages });
  const initialRefs = s.coordinator.snapshot().projects[0]!.members.map((m) => m.ref);
  const apply = async (role: ResearchRole) => {
    const route = decodeResearchRoute(await s.tool(role, { operation: "route" }));
    await s.tool(role, { operation: "route-applied", route });
    return route;
  };
  for (const role of RESEARCH_ROLES) {
    await apply(role);
    await s.tool(role, { operation: "knowledge", ids: ["METHOD"] });
  }
  const proposal = await s.publish("lead", "proposal");
  expect(decodeResearchRoute(await s.tool("reviewer", { operation: "route" })).stage.id).toBe(
    "question",
  );
  await s.publish("reviewer", "assessment");
  expect((await apply("reviewer")).stage.id).toBe("review");
  expect(decodeResearchRoute(await s.tool("librarian", { operation: "route" })).stage.id).toBe(
    "question",
  );
  await s.tool("reviewer", { operation: "read", artifactId: proposal.id });
  await expect(
    s.tool("reviewer", {
      operation: "publish",
      revision: 1,
      kind: "critique",
      content: body + body,
      refs: [proposal.id],
      executionModel: { provider: "fixture", modelId: "fast", thinkingLevel: "low" },
    }),
  ).rejects.toThrow("尚未由本阶段指定的模型生成");
  await s.publish("reviewer", "critique", [proposal.id]);
  expect((await apply("lead")).model?.modelId).toBe("deep");
  expect(s.coordinator.snapshot().projects[0]!.members.map((m) => m.ref)).toEqual(initialRefs);
  const critique = s.coordinator
    .snapshot()
    .projects[0]!.artifacts.find((a) => a.kind === "critique")!;
  expect(critique).toMatchObject({
    stage: "review",
    model: { modelId: "deep", thinkingLevel: "high" },
  });
  expect(
    s.coordinator
      .snapshot()
      .projects[0]!.events.some(
        (e) => e.type === "handoff" && e.to === "lead" && e.artifactId === critique.id,
      ),
  ).toBe(true);
  await s.coordinator.pause(s.root);
});

test("a failed stage model stops the group with its evidence preserved instead of using a fallback", async () => {
  const s = await setup();
  await s.tool("lead", { operation: "knowledge", ids: ["METHOD"] });
  const proposal = await s.publish("lead", "proposal");
  const refs = s.coordinator.snapshot().projects[0]!.members.map((m) => m.ref);
  await s.tool("reviewer", {
    operation: "route-failed",
    error: "阶段模型认证不可用，请检查配置。",
  });
  await expect.poll(() => s.cancelled.length).toBe(4);
  const p = s.coordinator.snapshot().projects[0]!;
  expect(p.status).toBe("needs-decision");
  expect(p.error).toContain("认证不可用");
  expect(p.artifacts.map((a) => a.id)).toContain(proposal.id);
  expect(p.members.map((m) => m.ref)).toEqual(refs);
  await expect(s.publish("lead", "proposal")).rejects.toThrow("不能继续写入");
});

test("applying phase settings to a stopped project preserves artifacts and does not start requests", async () => {
  const s = await setup();
  await s.tool("lead", { operation: "knowledge", ids: ["METHOD"] });
  const proposal = await s.publish("lead", "proposal");
  await expect(
    s.coordinator.configure({ knowledgeDir: s.kb, stages: researchStages() }, s.root),
  ).rejects.toThrow("暂停");
  await s.coordinator.pause(s.root);
  const stages = researchStages();
  stages[0]!.title = "我的问题打磨";
  const sent = s.sent.length;
  await s.coordinator.configure({ knowledgeDir: s.kb, stages }, s.root);
  expect(s.sent).toHaveLength(sent);
  expect(s.coordinator.snapshot().projects[0]).toMatchObject({
    stages,
    artifacts: [{ id: proposal.id }],
  });
  const restored = new ResearchCoordinator(s.repository, {
    createMember: async () => {
      throw new Error("unexpected");
    },
    deliver: async () => {
      throw new Error("unexpected");
    },
    cancel: async () => {},
    changed: () => {},
  });
  await restored.load();
  expect(restored.snapshot().projects[0]!.stages).toEqual(stages);
});

async function completeProposal(s: Awaited<ReturnType<typeof setup>>) {
  for (const role of RESEARCH_ROLES)
    await s.tool(role, { operation: "knowledge", ids: ["METHOD"] });
  await s.publish("mentor", "plan");
  const proposal = await s.publish("lead", "proposal");
  await s.publish("reviewer", "assessment");
  await s.tool("reviewer", { operation: "read", artifactId: proposal.id });
  const critique = await s.publish("reviewer", "critique", [proposal.id]);
  await s.tool("lead", { operation: "read", artifactId: critique.id });
  const revision = await s.publish("lead", "revision", [critique.id]);
  await s.tool("reviewer", { operation: "read", artifactId: revision.id });
  const verification = await s.publish("reviewer", "verification", [revision.id], "accept");
  for (const id of [revision.id, verification.id])
    await s.tool("mentor", { operation: "read", artifactId: id });
  return s.publish("mentor", "review", [revision.id, verification.id], "accept");
}

test("seven phases retain four sessions, require independent reads and real recomputation, and export a complete traceable paper", async () => {
  const materials = await mkdtemp(join(tmpdir(), "research-full-materials-"));
  await writeResearchStudyFixture(materials);
  const s = await setup({ scope: "paper", materialsDir: materials }),
    initial = s.coordinator.snapshot().projects[0]!.members.map((m) => m.ref);
  await completeProposal(s);
  const plan = { datasetId: "FIXTURE-DATA", method: "ols", columns: ["x"], outcome: "y" };
  let analysisId = "";
  const get = () => s.coordinator.snapshot().projects[0]!;
  const read = async (role: ResearchRole, id: string) =>
    s.tool(role, { operation: "read", artifactId: id });
  for (const stage of ["literature", "design", "analysis", "writing", "audit"]) {
    expect(get().currentStage).toBe(stage);
    const previous = get()
      .artifacts.filter((a) => ["review", "stage-review"].includes(a.kind))
      .at(-1)!;
    for (const role of RESEARCH_ROLES) {
      await read(role, previous.id);
      for (const sourceId of ["FIXTURE-A", "FIXTURE-B"])
        await s.tool(role, { operation: "source-read", sourceId });
    }
    if (stage === "analysis") {
      await expect(
        s.tool("lead", {
          operation: "publish",
          revision: 1,
          kind: "stage-draft",
          stage,
          refs: [previous.id],
          content: body + body,
        }),
      ).rejects.toThrow("实际执行已冻结");
      const hold = (await s.tool("mentor", {
        operation: "publish",
        revision: 1,
        kind: "stage-review",
        stage,
        refs: [previous.id],
        content: body + body,
        verdict: "hold",
      })) as { id: string };
      expect(get().status).toBe("needs-decision");
      await expect(s.coordinator.resume(s.root)).rejects.toThrow("本轮导师已暂缓");
      const retained = structuredClone(get().artifacts);
      await s.coordinator.reconsider(
        s.root,
        "用户补充条件：接受已披露的工具限制，维持原数据和冻结主分析，完成计算、修订和复核后再裁定。",
      );
      expect(get().status).toBe("running");
      expect(get().artifacts).toEqual(retained);
      expect(get().events.at(-1)).toMatchObject({
        type: "decision",
        artifactId: hold.id,
        stage: "analysis",
      });
      for (const role of RESEARCH_ROLES) await read(role, hold.id);
      const a = (await s.tool("lead", { operation: "analyze", ...plan })) as {
        id: string;
        sha256: string;
        file: string;
        result: unknown;
      };
      analysisId = a.id;
      await expect(
        s.tool("lead", { operation: "analyze", ...plan, columns: ["y"], outcome: "x" }),
      ).rejects.toThrow("遵循导师已通过");
      for (const role of ["lead", "reviewer"] as const)
        await s.tool(role, {
          operation: "analyze",
          datasetId: plan.datasetId,
          method: "describe",
          columns: ["x", "y"],
        });
      const replay = await promisify(execFile)(process.execPath, [
        join(a.file, "..", "replay.mjs"),
      ]);
      expect(JSON.parse(replay.stdout)).toEqual(a.result);
    }
    if (analysisId)
      for (const role of RESEARCH_ROLES)
        await s.tool(role, { operation: "read-analysis", analysisId });
    const meta = {
      stage,
      sourceIds: ["FIXTURE-A", "FIXTURE-B"],
      analysisIds: analysisId ? [analysisId] : [],
    };
    const publish = async (
      role: ResearchRole,
      kind: string,
      refs: string[],
      extra: Record<string, unknown> = {},
    ) =>
      s.tool(role, {
        operation: "publish",
        revision: 1,
        kind,
        content: body + body,
        refs,
        ...meta,
        ...extra,
      }) as Promise<{ id: string }>;
    const draft = await publish("lead", "stage-draft", [previous.id]);
    await expect(read("reviewer", draft.id)).rejects.toThrow("本阶段独立判断");
    await publish("reviewer", "stage-risk", [previous.id]);
    await read("reviewer", draft.id);
    const critique = await publish("reviewer", "stage-critique", [draft.id]);
    await read("lead", critique.id);
    const manuscript = `# 合成数据演练论文\n\n## 摘要\n这是软件验收用的合成数据论文，不是真实学校研究。[SRC:FIXTURE-A] [SRC:FIXTURE-B]\n\n## 方法\n六行演练数据，预先选定 x 与 y，实际最小二乘回归。[ANALYSIS:${analysisId}]\n\n## 结果\n截距约1，斜率约2，样本数6。\n\n## 讨论\n${(body + "此稿只证明协作与计算路径，不构成真实教育结论。").repeat(10)}\n\n## 参考文献\n[ SRC ] 两份合成来源，https://example.test/A 和 https://example.test/B。`;
    const revision = await publish("lead", "stage-revision", [critique.id], {
      ...(stage === "design" ? { analysisPlan: plan } : {}),
      ...(stage === "audit" ? { content: manuscript } : {}),
    });
    await read("reviewer", revision.id);
    const verification = await publish("reviewer", "stage-verification", [revision.id], {
      verdict: "accept",
    });
    for (const id of [revision.id, verification.id]) await read("mentor", id);
    if (stage === "analysis") {
      await expect(
        publish("mentor", "stage-review", [revision.id, verification.id], { verdict: "accept" }),
      ).rejects.toThrow("同引擎复跑");
      const b = (await s.tool("reviewer", { operation: "analyze", ...plan })) as { sha256: string };
      expect(b.sha256).toBe(get().analyses!.find((a) => a.id === analysisId)!.sha256);
    }
    await publish("mentor", "stage-review", [revision.id, verification.id], { verdict: "accept" });
  }
  expect(get().status).toBe("completed");
  expect(get().members.map((m) => m.ref)).toEqual(initial);
  expect(
    get()
      .artifacts.filter((a) => a.kind === "stage-review" && a.verdict === "accept")
      .map((a) => a.stage),
  ).toEqual(["literature", "design", "analysis", "writing", "audit"]);
  expect(await readFile(get().finalPaper!.markdown, "utf8")).toContain("合成数据演练论文");
  expect(await readFile(get().finalPaper!.html, "utf8")).toContain("论文目录");
  const provenance = JSON.parse(await readFile(get().finalPaper!.provenance, "utf8")) as {
    analyses: unknown[];
    sources: unknown[];
  };
  expect(provenance.analyses).toHaveLength(4);
  expect(provenance.sources).toHaveLength(2);
  const acceptedFiles = get().finalPaper!;
  const acceptedMarkdown = await readFile(acceptedFiles.markdown, "utf8");
  await s.coordinator.pause(s.root);
  await s.coordinator.start(
    s.root,
    s.root.workspaceId,
    "新版本只修改结论表述并重新核验重要主张，保留第一版导出供对照。",
  );
  expect(get().revision).toBe(2);
  expect(get().finalPaper).toBeUndefined();
  expect(get().supersededExports).toContainEqual(expect.objectContaining({ files: acceptedFiles }));
  expect(await readFile(acceptedFiles.markdown, "utf8")).toBe(acceptedMarkdown);
  await expect(
    s.tool("mentor", {
      operation: "publish",
      revision: 1,
      stage: "audit",
      kind: "stage-review",
      verdict: "accept",
      refs: [],
      content: body + body,
    }),
  ).rejects.toThrow(/过期/);
  await s.coordinator.pause(s.root);
});

test("missing research sources cannot be invented and mentor can explicitly hold the full pipeline", async () => {
  const s = await setup({ scope: "paper" });
  await completeProposal(s);
  const p = s.coordinator.snapshot().projects[0]!,
    previous = p.artifacts.at(-1)!;
  await s.tool("lead", { operation: "read", artifactId: previous.id });
  await expect(
    s.tool("lead", {
      operation: "publish",
      revision: 1,
      stage: "literature",
      kind: "stage-draft",
      content: body + body,
      refs: [previous.id],
      sourceIds: ["INVENTED-A", "INVENTED-B"],
    }),
  ).rejects.toThrow("实际读取");
  await s.tool("mentor", { operation: "read", artifactId: previous.id });
  await s.tool("mentor", {
    operation: "publish",
    revision: 1,
    stage: "literature",
    kind: "stage-review",
    content: body + body,
    refs: [previous.id],
    verdict: "hold",
  });
  expect(s.coordinator.snapshot().projects[0]!.status).toBe("needs-decision");
  expect(s.coordinator.snapshot().projects[0]!.finalPaper).toBeUndefined();
  await expect(s.coordinator.resume(s.root)).rejects.toThrow("暂缓");
  await s.coordinator.pause(s.root);
});

test("fusion accepts a bounded design review without a dataset", async () => {
  const goal = "design";
  {
    const s = await setup({
      workflowVersion: "fusion-v2",
      methodVersion: "2.0.0",
      entry: "manuscript",
      goal,
      path: "quantitative",
      scope: "paper",
    });
    const initial = s.coordinator.snapshot().projects[0]!;
    expect(initial.status).toBe("paused");
    expect(s.sent).toHaveLength(0);
    const manuscript = join(s.root.workspaceId, "provided-design.txt");
    await writeFile(manuscript, body + body);
    await s.coordinator.importMaterials(s.root, [manuscript]);
    const candidate = s.coordinator.snapshot().projects[0]!.importedMaterials![0]!;
    await s.coordinator.adoptMaterial(s.root, candidate.id, {
      category: "manuscript",
      sourceDescription: "本测试实际提供的方案文本；合成测试内容，不代表真实研究事实。",
    });
    await s.coordinator.resume(s.root);
    await expect.poll(() => s.sent.length).toBe(4);
    // This coordinator-only host does not launch Pi. Supply its explicit synthetic
    // native lifecycle before testing source reads; missing identities must not be invented by product code.
    for (const role of RESEARCH_ROLES) {
      const timestamp = new Date().toISOString();
      s.coordinator.onSessionEvent({
        type: "sessionUpdated",
        sessionRef: s.ref(role),
        timestamp,
        runId: `synthetic-design-${role}`,
        snapshot: {
          ref: s.ref(role),
          workspace: { workspaceId: s.root.workspaceId, path: s.root.workspaceId },
          title: role,
          status: "running",
          updatedAt: timestamp,
        },
      });
      await s.coordinator.flush();
      const route = await s.tool(role, { operation: "route" });
      await s.tool(role, {
        operation: "route-applied",
        route: {
          ...(route as object),
          model: { provider: "unit-fixture", modelId: "synthetic-model" },
        },
      });
    }
    const sourceId = s.coordinator.snapshot().projects[0]!.evidence!.sources[0]!.id;
    expect(initial.currentStage).toBe("design");
    expect(initial.stages).toHaveLength(9);
    expect(initial.evidence?.datasets).toHaveLength(0);
    for (const role of RESEARCH_ROLES)
      await s.tool(role, { operation: "knowledge", query: "研究问题" });
    const publish = async (
      role: ResearchRole,
      kind: string,
      refs: string[] = [],
      verdict?: string,
    ) => {
      await s.tool(role, { operation: "source-read", sourceId });
      for (const artifactId of refs) await s.tool(role, { operation: "read", artifactId });
      return (await s.tool(role, {
        operation: "publish",
        revision: 1,
        stage: "design",
        kind,
        content: body + body,
        refs,
        verdict,
        sourceIds: [sourceId],
      })) as { id: string };
    };
    const draft = await publish("lead", "stage-draft");
    await expect(s.tool("reviewer", { operation: "read", artifactId: draft.id })).rejects.toThrow(
      "独立",
    );
    await publish("reviewer", "stage-risk");
    const critique = await publish("reviewer", "stage-critique", [draft.id]);
    await expect(publish("reviewer", "stage-verification", [draft.id], "accept")).rejects.toThrow(
      /修订链/,
    );
    const revision = await publish("lead", "stage-revision", [critique.id]);
    const verification = await publish("reviewer", "stage-verification", [revision.id], "accept");
    await publish("mentor", "stage-review", [revision.id, verification.id], "accept");
    const current = s.coordinator.snapshot().projects[0]!;
    expect(current.status).toBe(goal === "design" ? "completed" : "running");
    expect(current.currentStage).toBe(goal === "design" ? "design" : "analysis");
    expect(current.analyses).toHaveLength(0);
    expect(current.artifacts.filter((a) => a.stage === "design")).toHaveLength(6);
    expect(current.finalPaper).toBeUndefined();
    await s.coordinator.pause(s.root);
  }
});

test("fusion can accept a sound first draft after independent B judgment and actual review without a forced revision", async () => {
  const s = await setup({
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "question",
  });
  const publish = (role: ResearchRole, kind: string, refs: string[] = [], verdict?: string) =>
    s.tool(role, {
      operation: "publish",
      revision: 1,
      stage: "question",
      kind,
      content: body + body,
      refs,
      ...(verdict ? { verdict } : {}),
    }) as Promise<{ id: string }>;
  try {
    for (const role of RESEARCH_ROLES)
      await s.tool(role, { operation: "knowledge", query: "研究问题 证据" });
    const draft = await publish("lead", "stage-draft");
    await expect(s.tool("reviewer", { operation: "read", artifactId: draft.id })).rejects.toThrow(
      /独立判断/,
    );
    await publish("reviewer", "stage-risk");
    await s.tool("reviewer", { operation: "read", artifactId: draft.id });
    const verification = await publish("reviewer", "stage-verification", [draft.id], "accept");
    await s.tool("mentor", { operation: "read", artifactId: draft.id });
    await s.tool("mentor", { operation: "read", artifactId: verification.id });
    await publish("mentor", "stage-review", [draft.id, verification.id], "accept");
    const p = s.coordinator.snapshot().projects[0]!;
    expect(p.status).toBe("completed");
    expect(p.artifacts.some((a) => ["stage-critique", "stage-revision"].includes(a.kind))).toBe(
      false,
    );
    expect(p.artifacts.filter((a) => a.kind === "stage-verification")[0]!.refs).toEqual([draft.id]);
  } finally {
    await s.coordinator.pause(s.root);
  }
});

test("a real state-file write failure is visible and stops further dispatch without replacing last confirmed state", async () => {
  const s = await setup();
  await s.coordinator.pause(s.root);
  const before = s.coordinator.snapshot();
  const file = join(s.dir, "research-groups.json");
  const retained = join(s.dir, "research-groups.before-storage-failure.json");
  await rename(file, retained);
  await mkdir(file);
  await expect(
    s.coordinator.configure({ ...before.config, memberTokenBudget: 12345 }, s.root),
  ).rejects.toThrow();
  expect(s.coordinator.snapshot().error).toContain("保存失败");
  expect(s.coordinator.snapshot().projects).toEqual(before.projects);
  expect(decodeResearchState(JSON.parse(await readFile(retained, "utf8"))).projects).toEqual(
    before.projects,
  );
  const dispatches = s.sent.length;
  await expect(s.coordinator.resume(s.root)).rejects.toThrow("保存失败");
  expect(s.sent).toHaveLength(dispatches);
});

test("a resumed inherited model records actual provenance again even when the member's selection is unchanged", async () => {
  const s = await setup({
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "question",
  });
  const role = "lead";
  let coordinator = s.coordinator;
  const model = { provider: "unit-fixture", modelId: "inherited-model", thinkingLevel: "high" };
  const snapshot = {
    ref: s.ref(role),
    workspace: { workspaceId: s.root.workspaceId, path: s.root.workspaceId },
    title: role,
    status: "running" as const,
    updatedAt: new Date().toISOString(),
  };
  const apply = async (runId: string) => {
    coordinator.onSessionEvent({
      type: "sessionUpdated",
      sessionRef: s.ref(role),
      timestamp: new Date().toISOString(),
      runId,
      snapshot,
    });
    await coordinator.flush();
    const route = await coordinator.tool(s.ref(role), `route-${runId}`, { operation: "route" });
    await coordinator.tool(s.ref(role), `applied-${runId}`, {
      operation: "route-applied",
      route: { ...(route as object), model },
    });
  };
  try {
    await expect.poll(() => s.sent.filter((sent) => sent.role === role).length).toBe(1);
    await apply("synthetic-inherited-first");
    s.coordinator.onSessionEvent({
      type: "runCompleted",
      sessionRef: s.ref(role),
      timestamp: new Date().toISOString(),
      runId: "synthetic-inherited-first",
      snapshot: { ...snapshot, status: "idle" },
    });
    await s.coordinator.flush();
    await s.coordinator.pause(s.root);
    coordinator = new ResearchCoordinator(s.repository, s.host);
    await coordinator.load();
    await coordinator.resume(s.root);
    await expect.poll(() => s.sent.filter((sent) => sent.role === role).length).toBe(2);
    await apply("synthetic-inherited-second");
    const p = coordinator.snapshot().projects[0]!;
    const attempts = p.fusion!.attempts.filter(
      (attempt) => p.fusion!.tasks.find((task) => task.id === attempt.taskId)?.role === role,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.nativeRunId).toBe("synthetic-inherited-second");
    expect(attempts[1]!.model).toEqual(model);
    expect(p.members.find((member) => member.role === role)!.model).toEqual(model);
  } finally {
    await coordinator.pause(s.root);
  }
});

test("delayed native events cannot bind an older run to a new fusion attempt or end its current run", async () => {
  const s = await setup({
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "question",
  });
  await s.coordinator.flush();
  const role = "lead";
  const snapshot = {
    ref: s.ref(role),
    workspace: { workspaceId: s.root.workspaceId, path: s.root.workspaceId },
    title: role,
    status: "running" as const,
    updatedAt: new Date().toISOString(),
  };
  const start = (runId: string, timestamp: string) =>
    s.coordinator.onSessionEvent({
      type: "sessionUpdated",
      sessionRef: s.ref(role),
      timestamp,
      runId,
      snapshot,
    });
  start("old-run", "2026-01-01T00:00:00.000Z");
  await s.coordinator.flush();
  const attempt = () =>
    s.coordinator.snapshot().projects[0]!.fusion!.attempts.find((a) => a.taskId.endsWith(":lead"))!;
  expect(attempt().nativeRunId).toBeUndefined();
  start("current-run", new Date().toISOString());
  await s.coordinator.flush();
  expect(attempt().nativeRunId).toBe("current-run");
  s.coordinator.onSessionEvent({
    type: "runCompleted",
    sessionRef: s.ref(role),
    timestamp: "2026-01-01T00:00:01.000Z",
    runId: "old-run",
    snapshot: { ...snapshot, status: "idle" },
  });
  s.coordinator.onSessionEvent({
    type: "runFailed",
    sessionRef: s.ref(role),
    timestamp: "2026-01-01T00:00:02.000Z",
    runId: "old-run",
    error: { message: "old failure" },
  });
  await s.coordinator.flush();
  expect(attempt().state).toBe("running");
  expect(s.coordinator.snapshot().projects[0]!.members.find((m) => m.role === role)!.status).toBe(
    "running",
  );
  expect(
    s.coordinator.snapshot().projects[0]!.events.filter((e) => e.type === "error"),
  ).toHaveLength(0);
  await s.coordinator.pause(s.root);
});

test("an unadmitted native start cannot steal a bound attempt or hide its completion while events are queued", async () => {
  const s = await setup({
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "question",
  });
  await s.coordinator.flush();
  const ref = s.ref("lead");
  const snapshot = {
    ref,
    workspace: { workspaceId: s.root.workspaceId, path: s.root.workspaceId },
    title: "lead",
    status: "running" as const,
    updatedAt: new Date().toISOString(),
  };
  const start = (runId: string) =>
    s.coordinator.onSessionEvent({
      type: "sessionUpdated",
      sessionRef: ref,
      runId,
      timestamp: new Date().toISOString(),
      snapshot,
    });
  // Both native notifications can arrive before the first durable state write completes.
  start("admitted-run");
  start("unadmitted-late-run");
  s.coordinator.onSessionEvent({
    type: "runCompleted",
    sessionRef: ref,
    runId: "admitted-run",
    timestamp: new Date().toISOString(),
    snapshot: { ...snapshot, status: "idle" },
  });
  await s.coordinator.flush();
  const p = s.coordinator.snapshot().projects[0]!;
  const attempt = p.fusion!.attempts.find((a) => a.taskId.endsWith(":lead"))!;
  expect(attempt.nativeRunId).toBe("admitted-run");
  expect(attempt.state).toBe("succeeded");
  expect(p.members.find((m) => m.role === "lead")!.status).toBe("idle");
  expect(
    p.events.filter((event) => event.type === "started" && event.role === "lead"),
  ).toHaveLength(1);
  await s.coordinator.pause(s.root);
});

test("M4 saved publication repairs failed projection and schedules each missing handoff only once", async () => {
  const s = await setup();
  try {
    await s.tool("lead", { operation: "knowledge", ids: ["METHOD"] });
    const project = s.coordinator.snapshot().projects[0]!;
    const projection = join(
      project.workspacePath,
      ".lancer",
      "research-groups",
      project.id,
      "project.json",
    );
    await rename(projection, projection + ".retained-before-failure");
    await mkdir(projection);
    const input = {
      operation: "publish",
      revision: 1,
      kind: "proposal",
      content: body + body,
      refs: [],
    };
    await expect(
      s.coordinator.tool(s.ref("lead"), "m4-fixed-publication", input),
    ).rejects.toThrow();
    const durable = (await s.repository.load()).projects[0]!;
    const artifact = durable.artifacts.find((a) => a.toolCallId === "m4-fixed-publication")!;
    expect(artifact).toBeTruthy();
    expect(
      durable.events.filter((e) => e.type === "handoff" && e.artifactId === artifact.id),
    ).toHaveLength(0);
    expect(
      await readFile(
        join(project.workspacePath, ".lancer", "research-groups", project.id, `${artifact.id}.md`),
        "utf8",
      ),
    ).toContain(body);
    await rename(projection, projection + ".retained-failed-directory");
    await rename(projection + ".retained-before-failure", projection);
    await s.coordinator.tool(s.ref("lead"), "m4-fixed-publication", input);
    await s.coordinator.tool(s.ref("lead"), "m4-fixed-publication", input);
    await s.coordinator.flush();
    const after = (await s.repository.load()).projects[0]!;
    expect(after.artifacts.filter((a) => a.toolCallId === "m4-fixed-publication")).toHaveLength(1);
    expect(
      after.events.filter(
        (e) => e.type === "handoff" && e.artifactId === artifact.id && e.to === "reviewer",
      ),
    ).toHaveLength(1);
    expect(JSON.parse(await readFile(projection, "utf8"))).toMatchObject({
      artifacts: after.artifacts,
    });
  } finally {
    await s.coordinator.pause(s.root);
  }
});
