import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  RESEARCH_ROLES,
  type ResearchArtifact,
  type ResearchProject,
  type ResearchRole,
} from "../../contracts/research-group";
import {
  activeFusionAttempt,
  attachFusionArtifactInputs,
  bindFusionNativeRun,
  ensureFusionStageTasks,
  publishFusionArtifact,
  resumableFusionTasks,
} from "../../electron/research-group/fusion-task-runtime";
import {
  addResearchTask,
  applyResearchChange,
  attachResearchTaskArtifact,
  attachResearchTaskInput,
  failResearchTask,
  finishResearchTaskAttempt,
  markResearchTaskDispatched,
  publishResearchTaskResult,
  requestResearchTaskContinuation,
  researchChangeImpact,
  setResearchInput,
  startResearchTask,
} from "../../electron/research-group/task-graph";

/** Pure graph L: uses production task creation/publication/read APIs, no native/E/R or files. */
function fixture() {
  let tick = 0,
    serial = 0;
  const at = () => new Date(Date.UTC(2026, 10, 8, 0, 0, ++tick)).toISOString();
  const p: ResearchProject = {
    id: "artifact-impact-fixture",
    revision: 1,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
    path: "quantitative",
    scope: "proposal",
    currentStage: "synthesis",
    status: "running",
    objective: "Pure production-shaped dependency fixture, not research evidence",
    root: { workspaceId: "fixture", sessionId: "mentor" },
    workspacePath: "/unused-graph-only",
    knowledge: { directory: "/unused-graph-only", sha256: "fixture", version: "fixture", count: 0 },
    createdAt: at(),
    updatedAt: at(),
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: "fixture", sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
  };
  ensureFusionStageTasks(p, at());
  const start = (role: ResearchRole) => {
    const id = `attempt-${role}-${++serial}`,
      stamp = at();
    p.fusion = markResearchTaskDispatched(
      startResearchTask(p.fusion!, `v1:${p.currentStage}:${role}`, {
        id,
        at: stamp,
        reservedTokens: 0,
        model: { provider: "graph-fixture", modelId: role },
      }),
      id,
      stamp,
    );
    bindFusionNativeRun(p, role, `native-${id}`);
    return id;
  };
  const publish = (
    role: ResearchRole,
    kind: ResearchArtifact["kind"],
    id: string,
    refs: string[] = [],
    verdict?: "accept",
  ) => {
    const artifact: ResearchArtifact = {
      id,
      role,
      kind,
      revision: 1,
      round: 0,
      createdAt: at(),
      content: `${id}: graph-only fixture publication, not a model/human research judgment.`,
      refs,
      toolCallId: `publish-${id}`,
      stage: p.currentStage,
      ...(verdict ? { verdict } : {}),
    };
    p.artifacts.push(artifact);
    publishFusionArtifact(p, artifact);
    return artifact;
  };
  const read = (role: ResearchRole, ...ids: string[]) =>
    attachFusionArtifactInputs(p, role, ids, at(), `fixture-read-${++serial}`);
  for (const role of RESEARCH_ROLES) start(role);
  const initial = publish("lead", "stage-draft", "s4-A-draft");
  publish("reviewer", "stage-risk", "s4-B-independent");
  read("reviewer", initial.id);
  const critique = publish("reviewer", "stage-critique", "s4-B-critique", [initial.id]);
  read("lead", critique.id);
  const revision = publish("lead", "stage-revision", "s4-A-revision", [critique.id]);
  read("reviewer", revision.id);
  const verification = publish(
    "reviewer",
    "stage-verification",
    "s4-B-verification",
    [revision.id],
    "accept",
  );
  read("mentor", revision.id, verification.id);
  publish("mentor", "stage-review", "s4-mentor-accept", [revision.id, verification.id], "accept");
  publish("librarian", "stage-material", "s4-unrelated-source-card");
  for (const role of RESEARCH_ROLES)
    p.fusion = finishResearchTaskAttempt(p.fusion!, activeFusionAttempt(p, role)!.id, { at: at() });
  p.currentStage = "design";
  ensureFusionStageTasks(p, at());
  const declaringAttemptId = start("reviewer");
  read("reviewer", revision.id);
  const addConsumer = (name: string) => {
    const taskId = `v1:audit:${name}`,
      attemptId = `${taskId}:attempt`,
      stamp = at();
    p.fusion = addResearchTask(p.fusion!, {
      id: taskId,
      stage: "audit",
      role: name,
      kind: "research",
      goal: "Independent graph fixture consumer",
      inputs: [],
      dependencies: [],
      earlyHandoff: "fixture",
      deliverable: "fixture",
      reviewRequired: false,
      writeScope: [name],
    });
    p.fusion = markResearchTaskDispatched(
      startResearchTask(p.fusion, taskId, { id: attemptId, at: stamp, reservedTokens: 0 }),
      attemptId,
      stamp,
    );
    return { taskId, attemptId };
  };
  const consume = (attemptId: string) => {
    p.fusion = attachResearchTaskArtifact(p.fusion!, attemptId, revision.id, {
      at: at(),
      evidenceRef: `actual-attach:${attemptId}`,
    });
  };
  return { p, at, revision, declaringAttemptId, addConsumer, consume };
}

test("production S4 read/review chain propagates to S5 without declaring A/B cycles as task dependencies", () => {
  const f = fixture();
  const before = structuredClone(f.p.fusion!);
  const impact = researchChangeImpact(before, "counterevidence:fixture", ["v1:synthesis:lead"]);
  expect(impact.affectedTaskIds).toEqual(
    expect.arrayContaining([
      "v1:synthesis:lead",
      "v1:synthesis:reviewer",
      "v1:synthesis:mentor",
      ...RESEARCH_ROLES.map((role) => `v1:design:${role}`),
    ]),
  );
  expect(impact.affectedTaskIds).toHaveLength(7);
  expect(impact.reusableTaskIds).toEqual(["v1:synthesis:librarian"]);
  expect(f.p.fusion).toEqual(before); // Projection is read-only, including actual artifact DAGs.
  expect(
    before.tasks
      .filter((task) => task.stage === "synthesis")
      .every((task) => task.dependencies.length === 0),
  ).toBe(true);
  let graph = setResearchInput(before, {
    inputId: "counterevidence:fixture",
    version: 1,
    kind: "context",
    availability: "available",
    actual: false,
    label: "Explicit fixture counterevidence",
    sourceRef: "fixture:counter",
    digest: "fixture-counter-digest",
  });
  graph = applyResearchChange(graph, {
    id: "counter-change",
    at: f.at(),
    inputId: "counterevidence:fixture",
    fromVersion: null,
    toVersion: 1,
    reason: "Explicit related manuscript impact",
    authorizedBy: "existing-authorization",
    authorizationRef: "fixture-task",
    additionalTaskIds: ["v1:synthesis:lead"],
  });
  const attempt = graph.attempts.find((entry) => entry.id === f.declaringAttemptId)!;
  expect(attempt.state).toBe("running");
  expect(attempt.taskVersion).toBe(1);
  expect(graph.tasks.find((task) => task.id === attempt.taskId)!.inputVersion).toBe(2);
  expect(graph.tasks.find((task) => task.id === "v1:synthesis:librarian")).toEqual(
    before.tasks.find((task) => task.id === "v1:synthesis:librarian"),
  );
  f.p.fusion = graph;
  expect(resumableFusionTasks(f.p).some((task) => task.role === "reviewer")).toBe(false);
  f.p.fusion = finishResearchTaskAttempt(graph, f.declaringAttemptId, { at: f.at() });
  expect(f.p.fusion.attempts.find((entry) => entry.id === f.declaringAttemptId)!.state).toBe(
    "succeeded",
  );
  expect(
    resumableFusionTasks(f.p)
      .map((task) => task.taskId)
      .sort(),
  ).toEqual(["v1:synthesis:lead", "v1:synthesis:mentor", "v1:synthesis:reviewer"]);
});

test("only current artifacts and active same-version reads extend impact; old completed/failed/stale attempts do not", () => {
  const f = fixture();
  const active = f.addConsumer("active-reader");
  f.consume(active.attemptId);
  const completed = f.addConsumer("completed-old-reader");
  f.consume(completed.attemptId);
  f.p.fusion = finishResearchTaskAttempt(f.p.fusion!, completed.attemptId, { at: f.at() });
  const failed = f.addConsumer("failed-old-reader");
  f.consume(failed.attemptId);
  f.p.fusion = failResearchTask(f.p.fusion!, failed.attemptId, {
    at: f.at(),
    reason: "Known fixture failure, no adopted artifact",
    outcome: "failed",
  });
  const stale = f.addConsumer("stale-active-reader");
  f.consume(stale.attemptId);
  f.p.fusion = setResearchInput(f.p.fusion!, {
    inputId: "fixture-local-refresh",
    version: 1,
    kind: "context",
    availability: "available",
    actual: false,
    label: "Independent version refresh",
    sourceRef: "fixture:refresh",
    digest: "refresh",
  });
  f.p.fusion = applyResearchChange(f.p.fusion, {
    id: "local-refresh",
    at: f.at(),
    inputId: "fixture-local-refresh",
    fromVersion: null,
    toVersion: 1,
    reason: "Old reader is not the current task version",
    authorizedBy: "existing-authorization",
    authorizationRef: "fixture",
    additionalTaskIds: [stale.taskId],
  });
  const replaced = f.addConsumer("replaced-current-artifact");
  f.consume(replaced.attemptId);
  f.p.fusion = publishResearchTaskResult(f.p.fusion!, {
    id: "old-dependent-artifact",
    projectId: f.p.id,
    attemptId: replaced.attemptId,
    at: f.at(),
    content: "Historical adopted fixture artifact consuming S4",
  });
  f.p.fusion = requestResearchTaskContinuation(f.p.fusion, replaced.taskId, {
    id: "new-independent-work",
    at: f.at(),
    reason: "New independent publication with no old artifact read",
  });
  f.p.fusion = markResearchTaskDispatched(
    startResearchTask(f.p.fusion, replaced.taskId, {
      id: "new-independent-attempt",
      at: f.at(),
      reservedTokens: 0,
    }),
    "new-independent-attempt",
    f.at(),
  );
  f.p.fusion = publishResearchTaskResult(f.p.fusion, {
    id: "new-independent-artifact",
    projectId: f.p.id,
    attemptId: "new-independent-attempt",
    at: f.at(),
    content: "Current independent fixture artifact",
  });
  const impact = researchChangeImpact(f.p.fusion, "counterevidence:fixture", ["v1:synthesis:lead"]);
  expect(impact.affectedTaskIds).toContain(active.taskId);
  for (const task of [completed, failed, stale, replaced]) {
    expect(impact.affectedTaskIds).not.toContain(task.taskId);
    expect(impact.reusableTaskIds).toContain(task.taskId);
  }
});

test("late source host-read pins participate in withdrawal impact while unrelated work stays intact", () => {
  const f = fixture(),
    reader = f.addConsumer("late-source-reader"),
    untouched = structuredClone(f.p.fusion!.tasks.filter((task) => task.id !== reader.taskId));
  const inputId = "source:late-provided-fixture",
    body = "Synthetic source text for host-read dependency L only",
    digest = createHash("sha256").update(body).digest("hex");
  f.p.fusion = setResearchInput(f.p.fusion!, {
    inputId,
    version: 1,
    kind: "material",
    availability: "available",
    actual: true,
    label: "Late source fixture",
    sourceRef: "fixture:late-source",
    digest,
  });
  f.p.fusion = applyResearchChange(f.p.fusion, {
    id: "adopt-late-fixture",
    at: f.at(),
    inputId,
    fromVersion: null,
    toVersion: 1,
    reason: "Actually supplied fixture dependency",
    authorizedBy: "existing-authorization",
    authorizationRef: "fixture",
  });
  expect(researchChangeImpact(f.p.fusion, inputId).affectedTaskIds).toEqual([]);
  f.p.fusion = attachResearchTaskInput(
    f.p.fusion,
    reader.attemptId,
    { inputId, version: 1 },
    { at: f.at(), evidenceRef: "host-source-read-fixture" },
  );
  expect(researchChangeImpact(f.p.fusion, inputId).affectedTaskIds).toEqual([reader.taskId]);
  f.p.fusion = setResearchInput(f.p.fusion, {
    inputId,
    version: 2,
    kind: "material",
    availability: "withdrawn",
    actual: false,
    label: "Withdrawn late source fixture",
    sourceRef: "fixture:late-source",
    digest: "withdrawn-fixture",
  });
  f.p.fusion = applyResearchChange(f.p.fusion, {
    id: "withdraw-late-fixture",
    at: f.at(),
    inputId,
    fromVersion: 1,
    toVersion: 2,
    reason: "Explicit withdrawal",
    authorizedBy: "existing-authorization",
    authorizationRef: "fixture",
  });
  expect(f.p.fusion.tasks.find((task) => task.id === reader.taskId)!.inputVersion).toBe(2);
  expect(f.p.fusion.tasks.filter((task) => task.id !== reader.taskId)).toEqual(untouched);
});
