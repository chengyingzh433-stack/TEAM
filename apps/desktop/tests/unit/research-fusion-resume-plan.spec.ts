import { expect, test } from "@playwright/test";
import type {
  ResearchArtifact,
  ResearchArtifactKind,
  ResearchProject,
} from "../../contracts/research-group";
import { planFusionContinuations } from "../../electron/research-group/fusion-resume-plan";

function project(): ResearchProject {
  return {
    workflowVersion: "fusion-v2",
    revision: 1,
    currentStage: "reading",
    status: "paused",
    artifacts: [],
    events: [],
    fusion: {
      tasks: ["lead", "reviewer", "mentor", "librarian"].map((role) => ({
        id: `v1:reading:${role}`,
        role,
        stage: "reading",
        state: "completed",
        inputVersion: 1,
        continuations: [],
      })),
      attempts: [],
      artifacts: [],
    },
  } as unknown as ResearchProject;
}
function artifact(
  p: ResearchProject,
  kind: ResearchArtifactKind,
  refs: string[] = [],
  verdict?: ResearchArtifact["verdict"],
) {
  const a: ResearchArtifact = {
    id: `${kind}-${p.artifacts.length}`,
    kind,
    role: "lead",
    revision: 1,
    stage: "reading",
    round: 1,
    refs,
    verdict,
    createdAt: "2026-11-07T00:00:00.000Z",
    content: kind,
    toolCallId: kind,
  };
  p.artifacts.push(a);
  return a;
}
function chain() {
  const p = project();
  artifact(p, "stage-risk");
  const draft = artifact(p, "stage-draft");
  return { p, draft };
}

test("recovers each missing handoff from persisted refs without mutating the project", () => {
  const { p, draft } = chain();
  const before = structuredClone(p);
  expect(planFusionContinuations(p)).toMatchObject([
    { role: "reviewer", id: expect.stringContaining(draft.id) },
  ]);
  expect(p).toEqual(before);
  const critique = artifact(p, "stage-critique", [draft.id]);
  expect(planFusionContinuations(p)).toMatchObject([
    { role: "lead", id: expect.stringContaining(critique.id) },
  ]);
  const revision = artifact(p, "stage-revision", [critique.id]);
  expect(planFusionContinuations(p)).toMatchObject([
    { role: "reviewer", id: expect.stringContaining(revision.id) },
  ]);
  const verification = artifact(p, "stage-verification", [revision.id], "accept");
  expect(planFusionContinuations(p)).toMatchObject([
    { role: "mentor", id: expect.stringContaining(verification.id) },
  ]);
  artifact(p, "stage-review", [revision.id, verification.id], "accept");
  expect(planFusionContinuations(p)).toEqual([]);
});

test("does not invent material batches, replay completed chains or duplicate continuation ids", () => {
  const p = project();
  artifact(p, "stage-material");
  expect(planFusionContinuations(p)).toEqual([]);
  artifact(p, "stage-draft");
  expect(planFusionContinuations(p)).toEqual([]);
  artifact(p, "stage-risk");
  const plan = planFusionContinuations(p)[0]!;
  p.fusion!.tasks.find((t) => t.id === plan.taskId)!.continuations.push({
    id: plan.id,
    reason: plan.reason,
    at: "now",
  });
  expect(planFusionContinuations(p)).toEqual([]);
});

test("active, unknown and failed executions require explicit recovery; pending tasks need no continuation", () => {
  for (const state of ["prepared", "running", "unknown", "failed", "cancelled"] as const) {
    const { p } = chain();
    p.fusion!.attempts.push({ taskId: "v1:reading:reviewer", state } as never);
    expect(planFusionContinuations(p), state).toEqual([]);
  }
  for (const state of [
    "pending",
    "failed",
    "cancelled",
    "waiting-dependency",
    "waiting-user",
  ] as const) {
    const { p } = chain();
    p.fusion!.tasks.find((t) => t.role === "reviewer")!.state = state;
    expect(planFusionContinuations(p), state).toEqual([]);
  }
});

test("ignores old stage/revision and superseded or changed-input artifacts", () => {
  for (const invalid of ["stage", "revision", "superseded", "version"] as const) {
    const { p, draft } = chain();
    if (invalid === "stage") draft.stage = "search";
    else if (invalid === "revision") draft.revision = 0;
    else
      p.fusion!.artifacts.push({
        id: draft.id,
        taskId: "v1:reading:lead",
        taskVersion: invalid === "version" ? 0 : 1,
        reviewState: invalid === "superseded" ? "superseded" : "unreviewed",
      } as never);
    expect(planFusionContinuations(p), invalid).toEqual([]);
  }
});

test("a revise verdict requests its own response and stale verification cannot review a new revision", () => {
  const { p, draft } = chain();
  const critique = artifact(p, "stage-critique", [draft.id]);
  const first = artifact(p, "stage-revision", [critique.id]);
  const rejected = artifact(p, "stage-verification", [first.id], "revise");
  expect(planFusionContinuations(p)).toMatchObject([
    { role: "lead", id: expect.stringContaining(rejected.id) },
  ]);
  const second = artifact(p, "stage-revision", [rejected.id]);
  expect(planFusionContinuations(p)).toMatchObject([
    { role: "reviewer", id: expect.stringContaining(second.id) },
  ]);
});

test("second failed verification resumes mentor adjudication, never a third revision", () => {
  const { p, draft } = chain();
  const critique = artifact(p, "stage-critique", [draft.id]);
  const revision = artifact(p, "stage-revision", [critique.id]);
  revision.round = 2;
  const verification = artifact(p, "stage-verification", [revision.id], "revise");
  verification.round = 2;
  expect(planFusionContinuations(p)).toMatchObject([
    { role: "mentor", id: expect.stringContaining(verification.id) },
  ]);
  const review = artifact(p, "stage-review", [revision.id, verification.id], "revise");
  review.round = 2;
  expect(planFusionContinuations(p)).toEqual([]);
  p.events.push({
    type: "decision",
    stage: "reading",
    revision: 1,
    artifactId: review.id,
  } as never);
  expect(planFusionContinuations(p)).toMatchObject([
    { role: "lead", id: expect.stringContaining(review.id) },
  ]);
});

test("ready selection does not replay a successful waiting turn without a new handoff", async () => {
  const { resumableFusionTasks } =
    await import("../../electron/research-group/fusion-task-runtime");
  const p = project();
  for (const t of p.fusion!.tasks) t.state = "completed";
  const task = p.fusion!.tasks.find((t) => t.role === "mentor")!;
  Object.assign(task, { state: "pending", inputs: [], dependencies: [], kind: "research" });
  p.fusion!.attempts.push({ taskId: task.id, taskVersion: 1, state: "succeeded" } as never);
  expect(resumableFusionTasks(p)).toEqual([]);
  task.continuations.push({ id: "verification-arrived", at: "now", reason: "new result" });
  expect(resumableFusionTasks(p)).toMatchObject([{ taskId: task.id }]);
  task.continuations = [];
  task.inputVersion = 2;
  expect(resumableFusionTasks(p)).toMatchObject([{ taskId: task.id }]);
});
