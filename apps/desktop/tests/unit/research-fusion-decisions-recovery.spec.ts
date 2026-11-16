import {
  RESEARCH_ROLES,
  researchStages,
  type ResearchProject,
} from "../../contracts/research-group";
import {
  ensureFusionStageTasks,
  prepareFusionDelivery,
  dispatchFusionAttempt,
  finishFusionNativeRun,
  failFusionAttempt,
  publishFusionArtifact,
  requestFusionTaskRetry,
  resumableFusionTasks,
} from "../../electron/research-group/fusion-task-runtime";
import { expect, test } from "@playwright/test";
import {
  decodeResearchTaskGraph,
  type ResearchTaskGraph,
} from "../../contracts/research-task-graph";
import {
  addResearchTask,
  answerResearchDecision,
  createResearchTaskGraph,
  finishResearchTaskAttempt,
  markResearchTaskDispatched,
  pauseResearchTasks,
  publishResearchTaskResult,
  recordResearchDecision,
  recoverResearchTasks,
  requestResearchDecision,
  requestResearchTaskRetry,
  researchDecisionStatus,
  researchTaskUsage,
  resolveResearchAttempt,
  resumeResearchTasks,
  startResearchTask,
  type NewResearchDecisionRequest,
} from "../../electron/research-group/task-graph";

const at = "2026-11-07T14:00:00.000Z";
const later = "2026-11-08T14:00:00.000Z";
function add(g: ResearchTaskGraph, id: string, dependency?: string): ResearchTaskGraph {
  return addResearchTask(g, {
    id,
    role: id,
    stage: "S6",
    kind: "research",
    goal: `完成 ${id}`,
    inputs: [],
    dependencies: dependency ? [{ taskId: dependency, requirement: "accepted" }] : [],
    earlyHandoff: "第一批",
    deliverable: "本轮成果",
    reviewRequired: true,
    writeScope: [id],
    tokenBudget: 1000,
  });
}
function setup(): ResearchTaskGraph {
  let g = createResearchTaskGraph("project-local-recovery", "fusion-2.0");
  for (const id of ["implementation", "literature", "writing"]) g = add(g, id);
  return add(g, "dependent", "implementation");
}
function run(g: ResearchTaskGraph, taskId: string, id: string): ResearchTaskGraph {
  return markResearchTaskDispatched(
    startResearchTask(g, taskId, { id, at, reservedTokens: 100 }),
    id,
    at,
  );
}
function publish(
  g: ResearchTaskGraph,
  taskId: string,
  attemptId: string,
  interim = false,
): ResearchTaskGraph {
  return publishResearchTaskResult(g, {
    projectId: g.projectId,
    id: `result-${attemptId}`,
    attemptId,
    at,
    content: `${taskId} 的已交成果`,
    interim,
    keepAttemptRunning: true,
  });
}
function request(version = 1): NewResearchDecisionRequest {
  return {
    id: `permission-${version}`,
    inputId: "material-use-confirmation",
    version,
    at,
    requestedBy: "mentor-agent",
    question: "当前材料是否已有研究使用许可？",
    context: "已有方案，但尚无实际许可记录。",
    impact: "只限制实施任务及采用其结果的任务；文献工作继续。",
    taskIds: ["implementation"],
    options: [
      {
        id: "confirmed",
        label: "已取得许可",
        consequence: "记录实际用户确认后继续相关任务。",
        outcome: "confirmed",
      },
      { id: "declined", label: "未获许可", consequence: "相关任务保持等待。", outcome: "declined" },
      {
        id: "deferred",
        label: "稍后核实",
        consequence: "不开始需要许可的工作。",
        outcome: "deferred",
      },
    ],
    recommendedOptionId: "deferred",
  };
}

test("a scoped human condition cannot be answered by elapsed time, model accept, or a negative user reply", () => {
  let g = requestResearchDecision(setup(), request());
  expect(g.tasks.find((t) => t.id === "implementation")?.state).toBe("waiting-user");
  expect(g.tasks.find((t) => t.id === "dependent")?.state).toBe("waiting-dependency");
  g = recordResearchDecision(g, {
    id: "mentor-accept",
    inputId: "material-use-confirmation",
    version: 1,
    at,
    actor: "mentor-agent",
    text: "方案通过",
    evidenceRef: "mentor-output",
  });
  g = recordResearchDecision(g, {
    id: "unstructured-user-no",
    inputId: "material-use-confirmation",
    version: 1,
    at,
    actor: "user",
    text: "不同意使用",
    evidenceRef: "user-message",
  });
  expect(researchDecisionStatus(g, "permission-1")).toBe("pending");
  g = answerResearchDecision(g, {
    id: "user-declines",
    requestId: "permission-1",
    at,
    optionId: "declined",
    text: "尚未获得许可",
    evidenceRef: "actual-user-message-2",
    origin: "new-reply",
  });
  expect(researchDecisionStatus(g, "permission-1")).toBe("declined");
  g = answerResearchDecision(g, {
    id: "user-defers",
    requestId: "permission-1",
    at: later,
    optionId: "deferred",
    text: "稍后核实",
    evidenceRef: "actual-user-message-3",
    origin: "new-reply",
  });
  g = resumeResearchTasks(recoverResearchTasks(g, "2030-01-01T00:00:00.000Z"));
  expect(researchDecisionStatus(g, "permission-1")).toBe("deferred");
  expect(() => run(g, "implementation", "forbidden")).toThrow("实际用户回复");
  g = publish(
    run(g, "literature", "independent-literature"),
    "literature",
    "independent-literature",
  );
  expect(g.artifacts).toHaveLength(1);
  expect(g.decisions.find((d) => d.id === "mentor-accept")?.actor).toBe("mentor-agent");
});

test("previous user authorization is reused once and old answers cannot release a newer condition", () => {
  let g = requestResearchDecision(setup(), request());
  const answer = {
    id: "prior-user-authorization",
    requestId: "permission-1",
    at,
    optionId: "confirmed",
    text: "已有授权明确允许该材料用于本研究",
    evidenceRef: "actual-user-message-before-start",
    origin: "prior-authorization" as const,
  };
  g = answerResearchDecision(g, answer);
  expect(researchDecisionStatus(g, "permission-1")).toBe("confirmed");
  expect(g.tasks.find((t) => t.id === "implementation")?.state).toBe("pending");
  expect(requestResearchDecision(g, request())).toEqual(g);
  expect(answerResearchDecision(g, answer)).toEqual(g);
  expect(() => requestResearchDecision(g, { ...request(), id: "unnecessary-reask" })).toThrow(
    "复用原请求",
  );
  g = requestResearchDecision(g, { ...request(2), question: "新增材料的另一用途是否获得许可？" });
  expect(researchDecisionStatus(g, "permission-1")).toBe("superseded");
  expect(researchDecisionStatus(g, "permission-2")).toBe("pending");
  expect(() => answerResearchDecision(g, { ...answer, id: "late-old-reply" })).toThrow("旧条件");
  expect(g.decisions).toHaveLength(1);
  expect(decodeResearchTaskGraph(JSON.parse(JSON.stringify(g)))).toEqual(g);
});

test("a new condition isolates an old in-flight result while unrelated work remains valid", () => {
  let g = run(setup(), "implementation", "before-condition");
  g = publish(run(g, "literature", "library"), "literature", "library");
  g = requestResearchDecision(g, request());
  g = publish(g, "implementation", "before-condition");
  expect(g.artifacts.find((a) => a.id === "result-before-condition")?.reviewState).toBe(
    "superseded",
  );
  expect(g.tasks.find((t) => t.id === "implementation")?.currentArtifactId).toBeUndefined();
  expect(g.tasks.find((t) => t.id === "literature")?.currentArtifactId).toBe("result-library");
  expect(g.decisionRequests?.[0]?.affectedTaskIds.sort()).toEqual(["dependent", "implementation"]);
});

test("unknown execution requires evidence-based reconciliation; one explicit retry preserves unrelated results and unknown usage", () => {
  let g = run(setup(), "implementation", "unknown-call");
  g = publish(run(g, "literature", "saved-library"), "literature", "saved-library");
  g = finishResearchTaskAttempt(g, "saved-library", { at, usedTokens: 30 });
  g = resumeResearchTasks(recoverResearchTasks(pauseResearchTasks(g), later));
  expect(() =>
    requestResearchTaskRetry(g, {
      id: "premature",
      taskId: "implementation",
      at,
      reason: "想继续",
      evidenceRef: "user-click",
    }),
  ).toThrow("失败任务");
  expect(() => run(g, "implementation", "duplicate-call")).toThrow("未知");
  const resolution = {
    id: "verified-provider-failure",
    attemptId: "unknown-call",
    at: later,
    outcome: "failed" as const,
    actor: "provider-record" as const,
    evidenceRef: "provider-receipt-23",
    reason: "已核对服务商失败记录；服务商未给用量。",
  };
  g = resolveResearchAttempt(g, resolution);
  expect(resolveResearchAttempt(g, resolution)).toEqual(g);
  expect(g.attempts.find((a) => a.id === "unknown-call")?.usedTokens).toBeUndefined();
  expect(researchTaskUsage(g)).toEqual({
    knownTokens: 30,
    reservedTokens: 100,
    unknownAttempts: ["unknown-call"],
  });
  const retry = {
    id: "explicit-retry-1",
    taskId: "implementation",
    at: later,
    reason: "依据已核对失败只恢复本任务",
    evidenceRef: "actual-user-retry-action",
  };
  g = requestResearchTaskRetry(g, retry);
  g = run(g, "implementation", "replacement-call");
  expect(requestResearchTaskRetry(g, retry)).toEqual(g);
  expect(g.tasks.find((t) => t.id === "literature")?.state).toBe("completed");
  expect(g.artifacts.find((a) => a.id === "result-saved-library")?.content).toBe(
    "literature 的已交成果",
  );
  expect(g.attempts).toHaveLength(3);
  expect(g.tasks.find((t) => t.id === "implementation")?.tokenBudget).toBe(1000);
});

test("a recovered saved result is not replayed, while completed calls without results require an explicit retry", () => {
  let g = publish(
    run(setup(), "implementation", "saved-before-notification"),
    "implementation",
    "saved-before-notification",
  );
  g = run(g, "writing", "completed-without-artifact");
  g = recoverResearchTasks(g, later);
  g = resolveResearchAttempt(g, {
    id: "found-saved-result",
    attemptId: "saved-before-notification",
    at: later,
    outcome: "succeeded",
    actor: "native-session-record",
    evidenceRef: "native-turn-finished",
    reason: "本地会话与已保存成果一致",
    usedTokens: 50,
  });
  expect(g.tasks.find((t) => t.id === "implementation")?.state).toBe("completed");
  expect(() =>
    requestResearchTaskRetry(g, {
      id: "replay-saved",
      taskId: "implementation",
      at: later,
      reason: "恢复",
      evidenceRef: "user",
    }),
  ).toThrow("已交成果不会重跑");
  g = resolveResearchAttempt(g, {
    id: "finished-no-artifact",
    attemptId: "completed-without-artifact",
    at: later,
    outcome: "succeeded",
    actor: "native-session-record",
    evidenceRef: "native-output-has-no-artifact",
    reason: "确认模型调用完成，但没有研究成果",
  });
  g = resumeResearchTasks(g);
  expect(g.tasks.find((t) => t.id === "writing")?.state).toBe("failed");
  expect(() => run(g, "writing", "automatic-retry")).toThrow("明确的修订或重试");
  const forged = {
    ...g,
    attemptResolutions: [{ ...g.attemptResolutions![0]!, actor: "mentor-agent" }],
  };
  expect(() => decodeResearchTaskGraph(forged)).toThrow("核对身份");
});

test("resume omits delivered tasks and targeted retry uses its original stage and model", () => {
  const p: ResearchProject = {
    id: "project-targeted-retry",
    root: { workspaceId: "workspace", sessionId: "mentor" },
    workspacePath: "/tmp/local-recovery-fixture",
    objective: "本地恢复契约测试",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    currentStage: "reading",
    knowledge: { directory: "/tmp/course", sha256: "a".repeat(64), version: "fixture", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: "workspace", sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
  };
  p.stages = researchStages(p).map((stage) => ({
    ...stage,
    models: { librarian: { provider: "fixture-provider", modelId: `model-${stage.id}` } },
  }));
  ensureFusionStageTasks(p, at);
  prepareFusionDelivery(p, "lead", "delivered-lead", at, "已交工作");
  dispatchFusionAttempt(p, "delivered-lead", at);
  publishFusionArtifact(p, {
    id: "saved-lead",
    role: "lead",
    kind: "stage-draft",
    revision: 1,
    round: 0,
    createdAt: at,
    content: "已可靠保存的工作",
    refs: [],
    stage: "reading",
    toolCallId: "saved-lead-call",
  });
  finishFusionNativeRun(p, "lead", undefined, at, {
    input: 20,
    output: 30,
    cacheRead: 0,
    cacheWrite: 0,
  });
  prepareFusionDelivery(p, "librarian", "failed-library", at, "资料批次");
  dispatchFusionAttempt(p, "failed-library", at);
  failFusionAttempt(p, "librarian", "单个服务故障", at);
  p.currentStage = "synthesis";
  ensureFusionStageTasks(p, later);
  expect(resumableFusionTasks(p).some((task) => task.taskId === "v1:reading:lead")).toBe(false);
  expect(resumableFusionTasks(p).some((task) => task.taskId === "v1:reading:librarian")).toBe(
    false,
  );
  requestFusionTaskRetry(p, {
    id: "retry-library-only",
    taskId: "v1:reading:librarian",
    at: later,
    reason: "只恢复失败资料批次",
    evidenceRef: "actual-user-retry",
  });
  const ready = resumableFusionTasks(p).find((task) => task.role === "librarian");
  expect(ready).toEqual({ taskId: "v1:reading:librarian", role: "librarian", stage: "reading" });
  const result = prepareFusionDelivery(
    p,
    "librarian",
    "retried-library",
    later,
    "继续已指定失败批次",
    ready!.taskId,
  );
  expect(result.kind).toBe("dispatch");
  expect(p.fusion!.attempts.find((a) => a.id === "retried-library")?.model?.modelId).toBe(
    "model-reading",
  );
  expect(p.fusion!.artifacts.find((a) => a.id === "saved-lead")?.content).toBe("已可靠保存的工作");
  expect(p.fusion!.attempts.filter((a) => a.taskId === "v1:reading:lead")).toHaveLength(1);
});
