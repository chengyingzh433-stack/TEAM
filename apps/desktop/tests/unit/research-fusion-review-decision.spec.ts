import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  RESEARCH_ROLES,
  type ResearchProject,
  type ResearchArtifact,
} from "../../contracts/research-group";
import { ensureFusionReviewDecision } from "../../electron/research-group/fusion-review-decision";
import { ensureFusionStageTasks } from "../../electron/research-group/fusion-task-runtime";
import {
  answerResearchDecision,
  researchTaskBlockers,
  researchDecisionStatus,
} from "../../electron/research-group/task-graph";
const at = "2026-11-07T10:00:00.000Z";
function project(): ResearchProject {
  return {
    id: randomUUID(),
    root: { workspaceId: "workspace", sessionId: "mentor" },
    workspacePath: "/tmp/fusion-unit",
    objective: "研究物理实验报告中的证据使用",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    currentStage: "design",
    goal: "paper",
    path: "quantitative",
    knowledge: { directory: "/tmp/course", sha256: "a".repeat(64), version: "test", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: "workspace", sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
    evidence: { directory: "/tmp", sources: [], datasets: [] },
  };
}

function held(
  p: ResearchProject,
  verdict: "hold" | "revise" = "hold",
  round = 1,
): ResearchArtifact {
  const review: ResearchArtifact = {
    id: randomUUID(),
    kind: "stage-review",
    role: "mentor",
    stage: "design",
    revision: 1,
    createdAt: at,
    content: "样本使用条件尚未充分说明，需要实际用户补充事实。",
    refs: [],
    round,
    verdict,
    toolCallId: randomUUID(),
  };
  p.artifacts.push(review);
  return review;
}
test("mentor hold blocks only its task and dependency descendants, preserving unrelated work and budget", () => {
  const p = project();
  p.memberTokenBudget = 98765;
  ensureFusionStageTasks(p, at);
  p.currentStage = "analysis";
  ensureFusionStageTasks(p, at);
  const review = held(p);
  const before = structuredClone(p.artifacts);
  const request = ensureFusionReviewDecision(p, review)!;
  expect(request.taskIds).toEqual(["v1:design:mentor"]);
  expect(request.affectedTaskIds).toContain("v1:analysis:reviewer");
  expect(
    researchTaskBlockers(p.fusion!, "v1:design:mentor").some((b) => b.kind === "decision"),
  ).toBe(true);
  expect(researchTaskBlockers(p.fusion!, "v1:design:librarian")).toEqual([]);
  expect(p.status).toBe("running");
  expect(p.memberTokenBudget).toBe(98765);
  expect(p.artifacts).toEqual(before);
  const graph = structuredClone(p.fusion);
  expect(ensureFusionReviewDecision(p, review)).toEqual(request);
  expect(p.fusion).toEqual(graph);
});
test("real confirmation releases review only; declined or deferred replies never accept academic results", () => {
  for (const optionId of ["continue-review", "keep-hold", "defer"]) {
    const p = project();
    ensureFusionStageTasks(p, at);
    const review = held(p);
    const request = ensureFusionReviewDecision(p, review)!;
    p.fusion = answerResearchDecision(p.fusion!, {
      id: randomUUID(),
      requestId: request.id,
      optionId,
      text: "用户实际补充的条件",
      at,
      evidenceRef: "user-action:actual-reply",
      origin: "new-reply",
    });
    expect(
      researchTaskBlockers(p.fusion, "v1:design:mentor").some((b) => b.kind === "decision"),
    ).toBe(optionId !== "continue-review");
    expect(review.verdict).toBe("hold");
    expect(p.fusion.artifacts.some((a) => a.reviewState === "accepted")).toBe(false);
    expect(p.fusion.tasks.find((t) => t.id === "v1:design:lead")!.inputVersion).toBe(1);
  }
});
test("another unresolved review needs a new condition version; first-round revise uses the normal revision chain", () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  expect(ensureFusionReviewDecision(p, held(p, "revise", 1))).toBeUndefined();
  const first = ensureFusionReviewDecision(p, held(p, "revise", 2))!;
  p.fusion = answerResearchDecision(p.fusion!, {
    id: randomUUID(),
    requestId: first.id,
    optionId: "continue-review",
    text: "继续核查",
    at,
    evidenceRef: "user-action:reply",
    origin: "new-reply",
  });
  const second = ensureFusionReviewDecision(p, held(p, "revise", 2))!;
  expect(second.version).toBe(first.version + 1);
  expect(researchDecisionStatus(p.fusion!, first.id)).toBe("superseded");
  expect(researchDecisionStatus(p.fusion!, second.id)).toBe("pending");
  expect(second.taskIds).toEqual(["v1:design:mentor"]);
  expect(p.fusion!.tasks.find((t) => t.role === "lead")!.continuations).toEqual([]);
});

test("accepted, superseded, old-revision and nonlatest reviews cannot create new human gates", () => {
  for (const invalid of ["accept", "superseded", "old-revision", "nonlatest"] as const) {
    const p = project();
    ensureFusionStageTasks(p, at);
    const review = held(p);
    if (invalid === "accept") review.verdict = "accept";
    if (invalid === "old-revision") review.revision = 0;
    if (invalid === "nonlatest") held(p);
    if (invalid === "superseded")
      p.fusion!.artifacts.push({
        id: review.id,
        taskId: "v1:design:mentor",
        taskVersion: 1,
        reviewState: "superseded",
      } as never);
    expect(ensureFusionReviewDecision(p, review), invalid).toBeUndefined();
    expect(p.fusion!.decisionRequests ?? []).toEqual([]);
  }
});
