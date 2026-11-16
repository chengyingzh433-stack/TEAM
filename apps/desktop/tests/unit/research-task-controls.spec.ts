import { expect, test } from "@playwright/test";
import type { ResearchTaskGraph, ResearchTask } from "../../contracts/research-task-graph";
import {
  decodeResearchTaskAnswerInput,
  decodeResearchTaskRetryInput,
  decodeResearchTaskResolveInput,
  parseResearchControlTokenCount,
  projectResearchTaskControls,
  researchDecisionReplyIdentity,
} from "../../contracts/research-task-controls";
import { researchDecisionStatus } from "../../electron/research-group/task-graph";
function graph(): ResearchTaskGraph {
  return {
    version: 1,
    projectId: "p",
    methodVersion: "fusion",
    paused: false,
    inputs: [],
    adoptedInputs: [{ inputId: "choice", version: 1 }],
    tasks: [
      {
        ...task("waiting", "waiting-user"),
        inputs: [{ inputId: "choice", version: 1, requirement: "user-confirmed" }],
      },
    ],
    attempts: [],
    artifacts: [],
    changes: [],
    decisions: [],
    decisionRequests: [
      {
        id: "q",
        inputId: "choice",
        version: 1,
        at: "now",
        requestedBy: "mentor",
        question: "是否继续？",
        context: "材料尚缺",
        impact: "只影响分析",
        recommendedOptionId: "yes",
        taskIds: ["waiting"],
        affectedTaskIds: ["waiting"],
        options: [
          { id: "yes", label: "继续", consequence: "执行分析", outcome: "confirmed" },
          { id: "no", label: "不继续", consequence: "保持阻塞", outcome: "declined" },
          { id: "later", label: "稍后", consequence: "等待答复", outcome: "deferred" },
        ],
      },
    ],
  };
}
function task(id: string, state: ResearchTask["state"]): ResearchTask {
  return {
    id,
    state,
    stage: "analysis",
    role: "lead",
    kind: "analysis",
    goal: id,
    inputVersion: 1,
    inputs: [],
    dependencies: [],
    earlyHandoff: "",
    deliverable: "",
    reviewRequired: true,
    writeScope: [],
    blockers: [],
    continuations: [],
  };
}
test("decision projection agrees with execution gate and never promotes model assent", () => {
  const g = graph();
  g.decisions.push({
    id: "model",
    inputId: "choice",
    version: 1,
    at: "now",
    actor: "mentor-agent",
    text: "同意",
    evidenceRef: "model",
    requestId: "q",
    outcome: "confirmed",
  });
  expect(projectResearchTaskControls(g).waiting).toHaveLength(1);
  expect(researchDecisionReplyIdentity(g.decisions[0])).toBe("导师 Agent 意见");
  for (const outcome of ["deferred", "declined", "confirmed"] as const) {
    g.decisions.push({
      ...g.decisions[0],
      id: outcome,
      actor: "user",
      outcome,
      origin: "new-reply",
    });
    expect(projectResearchTaskControls(g).decisions[0].status).toBe(researchDecisionStatus(g, "q"));
    expect(projectResearchTaskControls(g).waiting).toHaveLength(outcome === "confirmed" ? 0 : 1);
  }
  g.adoptedInputs = [{ inputId: "choice", version: 2 }];
  expect(projectResearchTaskControls(g).decisions[0].status).toBe("superseded");
  expect(projectResearchTaskControls(g).waiting).toHaveLength(0);
});
test("failed recovery excludes unknown and active attempts, preserving the graph", () => {
  const g = graph();
  g.tasks = [
    task("failure", "failed"),
    task("unknown", "failed"),
    task("active", "failed"),
    task("done", "completed"),
  ];
  g.attempts = ["unknown", "active"].map((id) => ({
    id,
    taskId: id,
    taskVersion: 1,
    inputRefs: [],
    dependencyArtifactIds: [],
    state: id === "unknown" ? "unknown" : "running",
    preparedAt: "now",
    reservedTokens: 100,
  }));
  const before = JSON.stringify(g);
  const view = projectResearchTaskControls(g);
  expect(view.failed.map((t) => t.id)).toEqual(["failure"]);
  expect(view.unknown.map((v) => v.attempt.id)).toEqual(["unknown"]);
  expect(JSON.stringify(g)).toBe(before);
});
test("narrow payloads reject identity injection and require reconciliation evidence", () => {
  const answer = { requestId: "q", optionId: "yes", text: "同意" };
  expect(decodeResearchTaskAnswerInput(answer)).toEqual(answer);
  expect(() => decodeResearchTaskAnswerInput({ ...answer, actor: "user" })).toThrow("未知字段");
  expect(() => decodeResearchTaskRetryInput({ taskId: "t", reason: " " })).toThrow();
  expect(decodeResearchTaskRetryInput({ taskId: "t", reason: "网络已恢复" }).reason).toBe(
    "网络已恢复",
  );
  const resolution = {
    attemptId: "a",
    outcome: "succeeded",
    reason: "已核实",
    evidenceRef: "session/run",
  };
  expect(decodeResearchTaskResolveInput(resolution)).not.toHaveProperty("usedTokens");
  expect(() => decodeResearchTaskResolveInput({ ...resolution, evidenceRef: "" })).toThrow();
  expect(() => decodeResearchTaskResolveInput({ ...resolution, outcome: "" })).toThrow();
  for (const usedTokens of [-1, NaN, null, "0", 1.5])
    expect(() => decodeResearchTaskResolveInput({ ...resolution, usedTokens })).toThrow();
  expect(decodeResearchTaskResolveInput({ ...resolution, usedTokens: 0 }).usedTokens).toBe(0);
  expect(parseResearchControlTokenCount(" ")).toBeUndefined();
  expect(parseResearchControlTokenCount(" 12 ")).toBe(12);
  for (const invalid of ["-1", "1e3", "1.2", "unknown", "9007199254740992"])
    expect(() => parseResearchControlTokenCount(invalid)).toThrow();
});
test("reply identity keeps existing authorization distinct from model and expert opinions", () => {
  const base = {
    id: "d",
    inputId: "choice",
    version: 1,
    at: "now",
    text: "同意",
    evidenceRef: "record",
  };
  expect(
    researchDecisionReplyIdentity({ ...base, actor: "user", origin: "prior-authorization" }),
  ).toBe("已有用户授权");
  expect(
    researchDecisionReplyIdentity({
      ...base,
      actor: "user",
      requestId: "q",
      outcome: "confirmed",
      origin: "new-reply",
    }),
  ).toBe("用户答复");
  expect(researchDecisionReplyIdentity({ ...base, actor: "user" })).toContain("未选择本次选项");
  expect(researchDecisionReplyIdentity({ ...base, actor: "external-expert" })).toBe("外部专业意见");
});
