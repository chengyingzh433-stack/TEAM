import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { RESEARCH_ROLES, type ResearchProject } from "../../contracts/research-group";
import type { ResearchTask, ResearchTaskAttempt } from "../../contracts/research-task-graph";
import { researchNavigationStatus } from "../../electron/research-group/navigation-status";
import { fusionDeliveryBlockReason } from "../../electron/research-group/fusion-task-runtime";
import {
  createResearchTaskGraph,
  researchTaskUsage,
} from "../../electron/research-group/task-graph";

const at = "2026-11-08T00:00:00.000Z";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture(): ResearchProject {
  const graph = createResearchTaskGraph("navigation-fixture", "2.0.0");
  for (const stage of ["reading", "synthesis", "design"]) {
    for (const role of RESEARCH_ROLES) {
      const task: ResearchTask = {
        id: `v1:${stage}:${role}`,
        stage,
        role,
        kind: "research",
        goal: "合成导航任务；全文仅由当前任务返回。".repeat(10),
        inputVersion: 2,
        inputs: Array.from({ length: 7 }, (_, index) => ({
          inputId: `source-${index}`,
          version: 1,
          requirement: "available",
        })),
        dependencies: [],
        earlyHandoff: "有用交接".repeat(10),
        deliverable: "实际交付".repeat(10),
        reviewRequired: true,
        writeScope: ["synthetic-artifact"],
        state: "pending",
        blockers: [{ kind: "decision", objectId: "decision-1", reason: "等待真实用户决定。" }],
        continuations: [
          { id: `consumed-${stage}-${role}`, at, reason: "已经派发的历史交接。", attemptId: "old" },
          { id: `pending-${stage}-${role}`, at, reason: "尚未派发的实际交接。" },
        ],
      };
      graph.tasks.push(task);
      for (let index = 0; index < 3; index++) {
        const attempt: ResearchTaskAttempt = {
          id: `${task.id}:attempt-${index}`,
          taskId: task.id,
          taskVersion: index === 0 ? 1 : 2,
          inputRefs: task.inputs.map(({ inputId, version }) => ({ inputId, version })),
          dependencyArtifactIds: ["baseline-artifact"],
          acquiredInputs: [{ inputId: "late-source", version: 1, at, evidenceRef: "source-read" }],
          acquiredArtifacts: [{ artifactId: "current-artifact", at, evidenceRef: "actual-read" }],
          state: "succeeded",
          preparedAt: at,
          dispatchedAt: at,
          finishedAt: at,
          nativeRunId: `${task.id}:native-${index}`,
          model: { provider: "synthetic", modelId: "unit", thinkingLevel: "high" },
          reservedTokens: 5000,
          usedTokens: 100,
          sessionTotalTokens: 1000 + index * 100,
        };
        graph.attempts.push(attempt);
      }
    }
  }
  const current = graph.attempts
    .filter((attempt) => attempt.taskId === "v1:synthesis:lead")
    .at(-1)!;
  current.state = "running";
  delete current.finishedAt;
  delete current.usedTokens;
  const project: ResearchProject = {
    id: graph.projectId,
    revision: 1,
    root: { workspaceId: "synthetic", sessionId: "mentor" },
    workspacePath: "/synthetic",
    objective: "导航投影单元测试，不是真实研究或原生运行。",
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    currentStage: "design",
    memberTokenBudget: 8_000_000,
    knowledge: { directory: "/synthetic", sha256: "a".repeat(64), version: "1", count: 0 },
    members: [],
    artifacts: [],
    packets: [],
    events: [],
    fusion: graph,
    methodPackageUses: graph.attempts.map((attempt, index) => ({
      id: `use-${index}`,
      projectId: graph.projectId,
      taskId: attempt.taskId,
      packageId: "fixed-package",
      packageSha256: "b".repeat(64),
      role: graph.tasks.find((task) => task.id === attempt.taskId)!.role as
        "mentor" | "lead" | "reviewer" | "librarian",
      revision: 1,
      taskInputVersion: attempt.taskVersion,
      sessionId: "synthetic-session",
      attemptId: attempt.id,
      nativeRunId: attempt.nativeRunId!,
      model: attempt.model!,
      operation: "method-package",
      callId: `call-${index}`,
      at,
    })),
  };
  return project;
}

test("navigation keeps actual ownership and actionable state while removing repeated history bodies", () => {
  const project = fixture(),
    before = structuredClone(project);
  const result = researchNavigationStatus(project, "lead");
  const task = project.fusion!.tasks.find((entry) => entry.id === "v1:synthesis:lead")!;
  const attempt = project.fusion!.attempts.filter((entry) => entry.taskId === task.id).at(-1)!;
  expect(result.currentTask).toEqual(task);
  expect(result.currentAttempt).toEqual(attempt);
  expect(result.currentTask!.stage).toBe("synthesis");
  expect(result.tasks).toHaveLength(project.fusion!.tasks.length);
  for (const [index, summary] of result.tasks!.entries()) {
    const original = project.fusion!.tasks[index]!;
    const { goal, earlyHandoff, deliverable, writeScope, inputs, continuations, ...retained } =
      original;
    expect(summary).toMatchObject(retained);
    for (const key of ["goal", "earlyHandoff", "deliverable", "writeScope", "inputs"])
      expect(summary).not.toHaveProperty(key);
    expect(summary.inputCount).toBe(inputs.length);
    expect(summary.inputPinsSha256).toBe(digest(inputs));
    expect(summary.continuationCount).toBe(continuations.length);
    expect(summary.continuations).toEqual(continuations.filter((entry) => !entry.attemptId));
  }
  for (const [index, summary] of result.attempts!.entries()) {
    const original = project.fusion!.attempts[index]!;
    const { inputRefs, acquiredInputs, acquiredArtifacts, ...retained } = original;
    expect(summary).toMatchObject(retained);
    for (const key of ["inputRefs", "acquiredInputs", "acquiredArtifacts"])
      expect(summary).not.toHaveProperty(key);
    expect(summary.inputRefCount).toBe(inputRefs.length);
    expect(summary.inputRefsSha256).toBe(digest(inputRefs));
    expect(summary.acquiredInputCount).toBe(acquiredInputs!.length);
    expect(summary.acquiredInputsSha256).toBe(digest(acquiredInputs));
    expect(summary.acquiredArtifactCount).toBe(acquiredArtifacts!.length);
    expect(summary.acquiredArtifactsSha256).toBe(digest(acquiredArtifacts));
  }
  expect(result.methodPackageUses![0]).toMatchObject({
    id: "use-0",
    packageId: "fixed-package",
    packageSha256: "b".repeat(64),
    taskId: "v1:reading:mentor",
    taskInputVersion: 1,
    role: "mentor",
    attemptId: "v1:reading:mentor:attempt-0",
    nativeRunId: "v1:reading:mentor:native-0",
    operation: "method-package",
    at,
    callId: "call-0",
  });
  for (const key of ["projectId", "revision", "sessionId", "model"])
    expect(result.methodPackageUses![0]).not.toHaveProperty(key);
  const full = {
    tasks: project.fusion!.tasks,
    attempts: project.fusion!.attempts,
    methodPackageUses: project.methodPackageUses,
  };
  expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(full).length * 0.8);
  expect(project).toEqual(before);
});

test("equal-size input and read-receipt changes alter navigation hashes", () => {
  const project = fixture(),
    before = researchNavigationStatus(project, "reviewer");
  project.fusion!.tasks[0]!.inputs[0]!.version++;
  project.fusion!.attempts[0]!.inputRefs[0]!.version++;
  project.fusion!.attempts[0]!.acquiredInputs![0]!.evidenceRef = "different-read";
  project.fusion!.attempts[0]!.acquiredArtifacts![0]!.artifactId = "different-artifact";
  const after = researchNavigationStatus(project, "reviewer");
  expect(after.tasks![0]!.inputCount).toBe(before.tasks![0]!.inputCount);
  expect(after.tasks![0]!.inputPinsSha256).not.toBe(before.tasks![0]!.inputPinsSha256);
  for (const key of ["inputRefsSha256", "acquiredInputsSha256", "acquiredArtifactsSha256"] as const)
    expect(after.attempts![0]![key]).not.toBe(before.attempts![0]![key]);
});

test("known usage and unknown reservations survive projection and cannot reopen an exhausted budget", () => {
  const project = fixture();
  const leadTask = project.fusion!.tasks.find((task) => task.id === "v1:reading:lead")!;
  project.fusion!.tasks = [leadTask];
  leadTask.blockers = [];
  leadTask.inputs = [];
  project.fusion!.attempts = project.fusion!.attempts.filter(
    (attempt) => attempt.taskId === leadTask.id,
  );
  project.fusion!.attempts[0]!.usedTokens = 8_000_001;
  const unknown = {
    ...project.fusion!.attempts[1]!,
    id: "unknown-native",
    state: "unknown" as const,
  };
  delete unknown.usedTokens;
  project.fusion!.attempts.push(unknown);
  const unknownResult = researchNavigationStatus(project, "lead");
  const usage = unknownResult.budget.roles.find((entry) => entry.role === "lead")!;
  expect(usage).toEqual({ role: "lead", ...researchTaskUsage(project.fusion!) });
  expect(unknownResult.budget.memberTokenBudget).toBe(8_000_000);
  expect(usage.knownTokens).toBe(8_000_201);
  expect(usage.reservedTokens).toBe(5000);
  expect(usage.unknownAttempts).toEqual(["unknown-native"]);
  expect(unknownResult.attempts!.find((entry) => entry.id === unknown.id)).not.toHaveProperty(
    "usedTokens",
  );
  expect(fusionDeliveryBlockReason(project, "lead", "继续", leadTask.id)).toContain("未知");
  project.fusion!.attempts = project.fusion!.attempts.filter(
    (attempt) => attempt.id !== unknown.id,
  );
  const before = structuredClone(project);
  const reason = fusionDeliveryBlockReason(project, "lead", "继续", leadTask.id);
  researchNavigationStatus(project, "lead");
  expect(fusionDeliveryBlockReason(project, "lead", "继续", leadTask.id)).toBe(reason);
  expect(reason).toContain("成员剩余额度不足");
  expect(project).toEqual(before);
});

test("no graph does not invent a native owner or an unlimited budget", () => {
  const project = fixture();
  delete project.fusion;
  delete project.memberTokenBudget;
  const result = researchNavigationStatus(project, "lead");
  expect(result.currentTask).toBeUndefined();
  expect(result.currentAttempt).toBeUndefined();
  expect(result.tasks).toBeUndefined();
  expect(result.attempts).toBeUndefined();
  expect(result.budget.memberTokenBudget).toBeUndefined();
  expect(result.budget.roles).toEqual(
    RESEARCH_ROLES.map((role) => ({
      role,
      knownTokens: 0,
      reservedTokens: 0,
      unknownAttempts: [],
    })),
  );
});
