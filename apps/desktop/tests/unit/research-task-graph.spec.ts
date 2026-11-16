import { expect, test } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decodeResearchTaskGraph,
  type ResearchTaskGraph,
  type ResearchTaskInput,
} from "../../contracts/research-task-graph";
import {
  addResearchTask,
  applyResearchChange,
  createResearchTaskGraph,
  failResearchTask,
  finishResearchTaskAttempt,
  requestResearchTaskContinuation,
  markResearchTaskDispatched,
  pauseResearchTasks,
  publishResearchTaskResult,
  recordResearchDecision,
  recoverResearchTasks,
  researchChangeImpact,
  researchTaskUsage,
  resumeResearchTasks,
  retryResearchTask,
  reviewResearchTaskArtifact,
  setResearchInput,
  startResearchTask,
} from "../../electron/research-group/task-graph";
import { writeFileAtomicQueued } from "../../electron/persistence/atomic-file-write";

const at = "2026-11-07T09:00:00.000Z";
const later = "2026-11-07T09:01:00.000Z";
const input = (id: string, version = 1, actual = true): ResearchTaskInput => ({
  inputId: id,
  version,
  kind: "material",
  availability: "available",
  actual,
  label: id,
  sourceRef: `materials/${id}/v${version}`,
  digest: `digest-${id}-${version}`,
});
function adopt(g: ResearchTaskGraph, i: ResearchTaskInput): ResearchTaskGraph {
  const previous = g.adoptedInputs.find((r) => r.inputId === i.inputId);
  return applyResearchChange(setResearchInput(g, i), {
    id: `change-${i.inputId}-${i.version}`,
    at,
    inputId: i.inputId,
    fromVersion: previous?.version ?? null,
    toVersion: i.version,
    reason: "应用已指定的新材料，保留其他成果。",
    authorizedBy: "existing-authorization",
    authorizationRef: "user-request-1",
  });
}
function add(
  g: ResearchTaskGraph,
  id: string,
  options: {
    kind?: "proposal" | "analysis" | "research";
    inputs?: string[];
    dependency?: string;
    published?: boolean;
    tokenBudget?: number;
  } = {},
): ResearchTaskGraph {
  return addResearchTask(g, {
    id,
    stage: options.kind === "analysis" ? "S6" : "S5",
    role: id === "literature" ? "librarian" : "lead",
    kind: options.kind ?? "research",
    goal: `完成 ${id}`,
    inputs: (options.inputs ?? []).map((inputId) => ({
      inputId,
      version: g.adoptedInputs.find((i) => i.inputId === inputId)!.version,
      requirement: "available",
    })),
    dependencies: options.dependency
      ? [{ taskId: options.dependency, requirement: options.published ? "published" : "accepted" }]
      : [],
    earlyHandoff: "第一批可追溯材料",
    deliverable: "有依据的成果",
    reviewRequired: true,
    writeScope: [`artifacts/${id}`],
    ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
  });
}
function run(g: ResearchTaskGraph, taskId: string, attemptId = `run-${taskId}`): ResearchTaskGraph {
  return markResearchTaskDispatched(
    startResearchTask(g, taskId, { id: attemptId, at, reservedTokens: 100 }),
    attemptId,
    at,
  );
}
function publish(
  g: ResearchTaskGraph,
  taskId: string,
  interim = false,
  attemptId = `run-${taskId}`,
  artifactId = `artifact-${taskId}`,
): ResearchTaskGraph {
  return publishResearchTaskResult(g, {
    projectId: g.projectId,
    id: artifactId,
    attemptId,
    at: later,
    content: `可核查成果 ${artifactId}`,
    interim,
    ...(interim ? {} : { usedTokens: 25 }),
  });
}
function accept(g: ResearchTaskGraph, artifactId: string): ResearchTaskGraph {
  return reviewResearchTaskArtifact(g, artifactId, {
    id: `review-${artifactId}`,
    at: later,
    actor: "model",
    reviewer: "reviewer-independent-session",
    verdict: "accepted",
    reason: "独立逐项核对现有材料与结论边界。",
  });
}

// AC25: proposal completion and actual implementation have different gates.
test("an accepted no-data proposal completes while actual analysis waits and literature continues", () => {
  let g = adopt(createResearchTaskGraph("project-1", "fusion-1.0"), {
    ...input("data", 1, false),
    availability: "planned",
  });
  g = add(g, "proposal", { kind: "proposal" });
  g = add(g, "analysis", { kind: "analysis", inputs: ["data"], dependency: "proposal" });
  g = add(g, "literature");
  g = publish(run(g, "proposal"), "proposal");
  expect(g.tasks.find((t) => t.id === "proposal")?.state).toBe("completed");
  expect(g.artifacts[0]?.reviewState).toBe("pending-review");
  g = accept(g, "artifact-proposal");
  expect(g.tasks.find((t) => t.id === "analysis")).toMatchObject({ state: "waiting-dependency" });
  expect(() => run(g, "analysis")).toThrow("方案或计划不能代替材料");
  g = publish(run(g, "literature"), "literature");
  g = adopt(g, input("data", 2));
  expect(g.tasks.find((t) => t.id === "proposal")?.currentArtifactId).toBe("artifact-proposal");
  expect(g.tasks.find((t) => t.id === "literature")?.currentArtifactId).toBe("artifact-literature");
  expect(g.tasks.find((t) => t.id === "analysis")?.state).toBe("pending");
  g = publish(run(g, "analysis"), "analysis");
  expect(g.artifacts.at(-1)?.inputRefs).toEqual([{ inputId: "data", version: 2 }]);
});

// AC04: durable late results cannot satisfy a dependency or overwrite a new version.
test("data replacement invalidates only dependent work and quarantines late results across persistence", async () => {
  let g = adopt(createResearchTaskGraph("project-2", "fusion-1.0"), input("data"));
  g = add(g, "analysis", { kind: "analysis", inputs: ["data"] });
  g = add(g, "writing", { dependency: "analysis" });
  g = add(g, "literature");
  g = accept(publish(run(g, "literature"), "literature"), "artifact-literature");
  g = run(g, "analysis", "old-analysis");
  const original = structuredClone(g);
  g = setResearchInput(g, input("data", 2));
  expect(g.tasks).toEqual(original.tasks); // Candidate registration is not adoption.
  expect(researchChangeImpact(g, "data")).toEqual({
    affectedTaskIds: ["analysis", "writing"],
    reusableTaskIds: ["literature"],
  });
  const change = {
    id: "apply-data-2",
    at,
    inputId: "data",
    fromVersion: 1,
    toVersion: 2,
    reason: "用户替换数据",
    authorizedBy: "user" as const,
    authorizationRef: "message-2",
  };
  g = applyResearchChange(g, change);
  expect(applyResearchChange(g, change)).toEqual(g);
  const dir = await mkdtemp(join(tmpdir(), "lancer-task-graph-")),
    file = join(dir, "graph.json");
  await writeFileAtomicQueued(file, JSON.stringify(g), decodeResearchTaskGraph);
  g = decodeResearchTaskGraph(JSON.parse(await readFile(file, "utf8")));
  g = publish(g, "analysis", false, "old-analysis", "old-result");
  expect(g.artifacts.find((a) => a.id === "old-result")?.reviewState).toBe("superseded");
  expect(g.tasks.find((t) => t.id === "analysis")?.currentArtifactId).toBeUndefined();
  expect(g.tasks.find((t) => t.id === "writing")?.state).toBe("waiting-dependency");
  expect(g.artifacts.find((a) => a.id === "artifact-literature")?.reviewState).toBe("accepted");
  expect(() => accept(g, "old-result")).toThrow("旧稿审阅");
  g = accept(
    publish(run(g, "analysis", "new-analysis"), "analysis", false, "new-analysis", "new-result"),
    "new-result",
  );
  expect(g.tasks.find((t) => t.id === "writing")?.state).toBe("pending");
  expect(original.tasks.find((t) => t.id === "analysis")?.inputVersion).toBe(1);
  expect(() =>
    publishResearchTaskResult(g, {
      projectId: "different-project",
      id: "foreign",
      attemptId: "new-analysis",
      at,
      content: "cross-project",
    }),
  ).toThrow("不属于本课题");
});

// AC05/26: partial publication is useful before producer completion; failure is local.
test("a consumer uses the first batch while its producer runs, and retains it after producer failure", () => {
  let g = add(createResearchTaskGraph("project-3", "fusion-1.0"), "literature");
  g = add(g, "synthesis", { dependency: "literature", published: true });
  g = run(g, "literature");
  g = publish(g, "literature", true);
  expect(g.tasks.find((t) => t.id === "literature")?.state).toBe("running");
  g = run(g, "synthesis");
  expect(g.attempts.find((a) => a.id === "run-synthesis")?.dependencyArtifactIds).toEqual([
    "artifact-literature",
  ]);
  g = failResearchTask(g, "run-literature", {
    at: later,
    reason: "后续批次服务错误",
    outcome: "failed",
    usedTokens: 70,
  });
  g = publish(g, "synthesis");
  expect(g.tasks.find((t) => t.id === "literature")?.state).toBe("failed");
  expect(g.tasks.find((t) => t.id === "synthesis")?.state).toBe("completed");
  expect(g.artifacts.find((a) => a.id === "artifact-literature")?.content).toContain("可核查成果");
  g = retryResearchTask(g, "literature");
  expect(g.tasks.find((t) => t.id === "synthesis")?.state).toBe("completed");
  expect(g.tasks.find((t) => t.id === "literature")?.currentArtifactId).toBe("artifact-literature");
});

// AC06/15: saved results survive notification loss; external uncertainty never becomes zero.
test("pause and restart preserve unknown calls and saved results without duplicate publication or usage", () => {
  let g = createResearchTaskGraph("project-4", "fusion-1.0");
  for (const id of ["prepared", "in-flight", "saved", "independent"]) g = add(g, id);
  g = startResearchTask(g, "prepared", { id: "run-prepared", at, reservedTokens: 100 });
  g = run(g, "in-flight");
  g = publish(run(g, "saved"), "saved");
  g = pauseResearchTasks(g);
  expect(() => run(g, "independent")).toThrow("全组暂停");
  g = recoverResearchTasks(decodeResearchTaskGraph(JSON.parse(JSON.stringify(g))), later);
  expect(g.attempts.find((a) => a.id === "run-prepared")).toMatchObject({
    state: "cancelled",
    usedTokens: 0,
  });
  expect(g.attempts.find((a) => a.id === "run-in-flight")).toMatchObject({ state: "unknown" });
  expect(g.attempts.find((a) => a.id === "run-in-flight")?.usedTokens).toBeUndefined();
  expect(g.tasks.find((t) => t.id === "saved")?.currentArtifactId).toBe("artifact-saved");
  expect(publish(g, "saved")).toEqual(g);
  expect(researchTaskUsage(g)).toEqual({
    knownTokens: 25,
    reservedTokens: 100,
    unknownAttempts: ["run-in-flight"],
  });
  g = resumeResearchTasks(g);
  expect(() => run(g, "in-flight", "duplicate-run")).toThrow("未知");
  g = publish(run(g, "independent"), "independent");
  g = publish(g, "in-flight"); // A positively identified late result resolves the same attempt.
  expect(g.tasks.find((t) => t.id === "in-flight")?.state).toBe("completed");
  expect(researchTaskUsage(g)).toEqual({ knownTokens: 75, reservedTokens: 0, unknownAttempts: [] });
});

// AC30: model verdicts cannot turn an unanswered human condition into consent.
test("human decisions unblock only their dependents and model approval is never human confirmation", () => {
  let g = adopt(createResearchTaskGraph("project-5", "fusion-1.0"), {
    ...input("permission", 1, false),
    kind: "decision",
    availability: "missing",
  });
  g = addResearchTask(g, {
    id: "implementation",
    stage: "S6",
    role: "lead",
    kind: "research",
    goal: "实施准备",
    inputs: [{ inputId: "permission", version: 1, requirement: "user-confirmed" }],
    dependencies: [],
    earlyHandoff: "",
    deliverable: "实施材料",
    reviewRequired: true,
    writeScope: ["implementation"],
  });
  g = add(g, "literature");
  const decision = {
    id: "model-decision",
    inputId: "permission",
    version: 1,
    at,
    actor: "mentor-agent" as const,
    text: "建议按方案继续",
    evidenceRef: "mentor-turn-1",
  };
  g = recordResearchDecision(g, decision);
  expect(g.tasks.find((t) => t.id === "implementation")?.state).toBe("waiting-user");
  expect(g.tasks.find((t) => t.id === "literature")?.state).toBe("pending");
  g = recordResearchDecision(g, {
    ...decision,
    id: "actual-user-reply",
    actor: "user",
    text: "已按说明取得使用许可",
    evidenceRef: "user-message-20",
  });
  expect(g.tasks.find((t) => t.id === "implementation")?.state).toBe("pending");
  expect(g.decisions[0]?.actor).toBe("mentor-agent");
});

test("input adoption retains old accepted text and rejects stale or conflicting changes", () => {
  let g = adopt(createResearchTaskGraph("project-6", "fusion-1.0"), input("source"));
  g = add(g, "synthesis", { inputs: ["source"] });
  g = accept(publish(run(g, "synthesis"), "synthesis"), "artifact-synthesis");
  g = setResearchInput(g, input("source", 2));
  expect(() =>
    applyResearchChange(g, {
      id: "unapproved",
      at,
      inputId: "source",
      fromVersion: 1,
      toVersion: 2,
      reason: "替换",
      authorizedBy: "routine",
      authorizationRef: "automatic",
    }),
  ).toThrow("已接受成果");
  g = adopt(g, input("source", 2));
  expect(g.artifacts[0]).toMatchObject({
    content: "可核查成果 artifact-synthesis",
    reviewState: "needs-review",
  });
  expect(g.artifacts[0]?.reviews[0]?.verdict).toBe("accepted");
  expect(() => setResearchInput(g, { ...input("source", 1), digest: "tampered" })).toThrow(
    "不可改写",
  );
  expect(() =>
    applyResearchChange(g, {
      id: "stale",
      at,
      inputId: "source",
      fromVersion: 1,
      toVersion: 2,
      reason: "旧通知",
      authorizedBy: "user",
      authorizationRef: "old",
    }),
  ).toThrow("重新查看影响");
});

test("decoder rejects schema skew, cycles, forged acceptance and broken current-version pointers", () => {
  let g = add(createResearchTaskGraph("project-7", "fusion-1.0"), "a");
  g = add(g, "b", { dependency: "a" });
  expect(() => decodeResearchTaskGraph({ ...g, silentlyLostField: true })).toThrow("未知字段");
  const cycle = structuredClone(g);
  cycle.tasks[0]!.dependencies = [{ taskId: "b", requirement: "accepted" }];
  expect(() => decodeResearchTaskGraph(cycle)).toThrow("循环");
  g = publish(run(g, "a"), "a");
  const forged = structuredClone(g);
  forged.artifacts[0]!.reviewState = "accepted";
  expect(() => decodeResearchTaskGraph(forged)).toThrow("缺审阅依据");
  const stale = structuredClone(g);
  stale.tasks[0]!.inputVersion++;
  expect(() => decodeResearchTaskGraph(stale)).toThrow("当前成果版本不一致");
  const foreign = structuredClone(g);
  foreign.artifacts[0]!.attemptId = "missing";
  expect(() => decodeResearchTaskGraph(foreign)).toThrow("关联不一致");
});

test("unknown failed consumption keeps its reservation and known usage cannot be counted twice", () => {
  let g = add(createResearchTaskGraph("project-8", "fusion-1.0"), "a", { tokenBudget: 150 });
  g = run(g, "a");
  g = failResearchTask(g, "run-a", { at: later, reason: "提供商未给用量", outcome: "failed" });
  expect(researchTaskUsage(g)).toEqual({
    knownTokens: 0,
    reservedTokens: 100,
    unknownAttempts: ["run-a"],
  });
  g = retryResearchTask(g, "a");
  expect(() => run(g, "a", "new-attempt")).toThrow("预算不足");
  expect(g.attempts).toHaveLength(1);
});

// Pi publications and native run completion have separate durable boundaries.
test("one role can publish, finish its native call, then execute an explicitly requested revision", () => {
  let g = add(createResearchTaskGraph("native-turns", "fusion-1.0"), "lead-draft");
  g = run(g, "lead-draft");
  g = publishResearchTaskResult(g, {
    projectId: g.projectId,
    id: "draft-1",
    attemptId: "run-lead-draft",
    at: later,
    content: "首稿",
    keepAttemptRunning: true,
  });
  expect(g.tasks[0]?.state).toBe("running");
  expect(g.attempts[0]?.state).toBe("running");
  expect(g.artifacts[0]?.reviewState).toBe("pending-review");
  g = finishResearchTaskAttempt(g, "run-lead-draft", { at: later, usedTokens: 75 });
  expect(g.tasks[0]?.state).toBe("completed");
  const request = { id: "b-critique-1", at: later, reason: "B 指出主张过强，需要收窄" };
  g = requestResearchTaskContinuation(g, "lead-draft", request);
  expect(g.tasks[0]?.state).toBe("pending");
  expect(requestResearchTaskContinuation(g, "lead-draft", request)).toEqual(g);
  g = run(g, "lead-draft", "run-revision");
  expect(g.tasks[0]?.continuations[0]?.attemptId).toBe("run-revision");
  g = publishResearchTaskResult(g, {
    projectId: g.projectId,
    id: "draft-2",
    attemptId: "run-revision",
    at: later,
    content: "修订稿：只说明相关关系",
    keepAttemptRunning: true,
  });
  g = finishResearchTaskAttempt(g, "run-revision", { at: later, usedTokens: 30 });
  expect(g.tasks[0]?.currentArtifactId).toBe("draft-2");
  expect(g.artifacts[0]?.content).toBe("首稿");
  expect(researchTaskUsage(g).knownTokens).toBe(105);
  expect(finishResearchTaskAttempt(g, "run-revision", { at: later, usedTokens: 30 })).toEqual(g);
  expect(requestResearchTaskContinuation(g, "lead-draft", request)).toEqual(g);
  expect(() => run(g, "lead-draft", "unrequested-third-turn")).toThrow("重复派发");
  expect(() => accept(g, "draft-1")).toThrow("旧稿审阅");
  g = accept(g, "draft-2");
  expect(g.artifacts.at(-1)?.reviewState).toBe("accepted");
});
