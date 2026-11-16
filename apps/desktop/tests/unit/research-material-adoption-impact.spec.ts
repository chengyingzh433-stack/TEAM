import { expect, test } from "@playwright/test";
import type { ResearchProject } from "../../contracts/research-group";
import type { ResearchTask, ResearchTaskGraph } from "../../contracts/research-task-graph";
import { projectResearchMaterialAdoptionImpact } from "../../contracts/research-material-adoption-impact";

const at = "2026-11-07T00:00:00Z";
function fixture(): ResearchProject {
  const tasks: ResearchTask[] = [
    "question",
    "literature",
    "design",
    "analysis",
    "writing",
    "audit",
  ].map((stage) => ({
    id: `v2:${stage}:lead`,
    stage,
    role: "lead",
    kind: "research",
    goal: stage,
    inputVersion: 1,
    inputs:
      stage === "analysis"
        ? [{ inputId: "implementation-material", version: 1, requirement: "available" }]
        : [],
    dependencies: [],
    earlyHandoff: "初稿",
    deliverable: "全文",
    reviewRequired: true,
    writeScope: [stage],
    state: "completed",
    blockers: [],
    continuations: [],
    currentArtifactId: `artifact-${stage}`,
  }));
  const fusion: ResearchTaskGraph = {
    version: 1,
    paused: false,
    projectId: "project",
    methodVersion: "2.0.0",
    inputs: [
      {
        inputId: "implementation-material",
        version: 1,
        kind: "material",
        actual: false,
        availability: "missing",
        label: "待提供实际数据",
        sourceRef: "waiting",
        digest: "empty-dataset-list",
      },
    ],
    adoptedInputs: [{ inputId: "implementation-material", version: 1 }],
    tasks,
    attempts: [],
    changes: [],
    decisions: [],
    artifacts: tasks.map((task) => ({
      id: task.currentArtifactId!,
      taskId: task.id,
      taskVersion: 1,
      attemptId: `attempt-${task.stage}`,
      createdAt: at,
      content: task.stage,
      inputRefs: [],
      dependencyArtifactIds: [],
      interim: false,
      reviewState: "accepted",
      reviews: [],
    })),
  };
  return {
    id: "project",
    revision: 2,
    root: { workspaceId: "w", sessionId: "s" },
    workspacePath: "/tmp",
    objective: "研究",
    workflowVersion: "fusion-v2",
    currentStage: "audit",
    status: "completed",
    createdAt: at,
    updatedAt: at,
    knowledge: { directory: "/tmp", sha256: "hash", version: "1", count: 0 },
    members: [],
    artifacts: [],
    packets: [],
    events: [],
    fusion,
    evidence: { directory: "/tmp", sources: [], datasets: [] },
    finalPaper: { markdown: "/paper.md", html: "/paper.html", provenance: "/provenance.json" },
  };
}

test("first actual data adoption exposes design fit and existing downstream artifacts, preserving question and literature", () => {
  const p = fixture(),
    before = structuredClone(p);
  const impact = projectResearchMaterialAdoptionImpact(p, "data");
  expect(impact.affectedTaskIds).toEqual([
    "v2:design:lead",
    "v2:analysis:lead",
    "v2:writing:lead",
    "v2:audit:lead",
  ]);
  expect(impact.affectedArtifactIds).toEqual([
    "artifact-design",
    "artifact-analysis",
    "artifact-writing",
    "artifact-audit",
  ]);
  expect(impact.reusableTaskIds).toEqual(["v2:question:lead", "v2:literature:lead"]);
  expect(impact.reusableArtifactIds).toEqual(["artifact-question", "artifact-literature"]);
  expect(impact.requiresDesignReview).toBe(true);
  expect(impact.supersedesExport).toBe(true);
  expect(p).toEqual(before);
});

for (const category of ["paper", "method", "manuscript", "design"] as const)
  test(`additive ${category} source does not replace existing adopted identities or invalidate export`, () => {
    const p = fixture(),
      impact = projectResearchMaterialAdoptionImpact(p, category);
    expect(impact.affectedTaskIds).toEqual([]);
    expect(impact.affectedArtifactIds).toEqual([]);
    expect(impact.reusableTaskIds).toHaveLength(6);
    expect(impact.reusableArtifactIds).toHaveLength(6);
    expect(impact.requiresDesignReview).toBe(false);
    expect(impact.supersedesExport).toBe(false);
  });

test("early-stage data updates existing implementation consumers without forcing design review or revoking export", () => {
  const p = fixture();
  p.currentStage = "question";
  const impact = projectResearchMaterialAdoptionImpact(p, "data");
  expect(impact.affectedTaskIds).toEqual(["v2:analysis:lead", "v2:writing:lead", "v2:audit:lead"]);
  expect(impact.reusableTaskIds).toContain("v2:design:lead");
  expect(impact.requiresDesignReview).toBe(false);
  expect(impact.supersedesExport).toBe(false);
});

test("dependency propagation includes nonstandard stages and reports historical consumers separately", () => {
  const p = fixture(),
    graph = p.fusion!;
  graph.tasks[0]!.dependencies.push({ taskId: "v2:analysis:lead", requirement: "accepted" });
  graph.tasks.push({
    ...structuredClone(graph.tasks[3]!),
    id: "v1:analysis:lead",
    currentArtifactId: undefined,
  });
  const impact = projectResearchMaterialAdoptionImpact(p, "data");
  expect(impact.directTaskIds).not.toContain("v2:question:lead");
  expect(impact.affectedTaskIds).toContain("v2:question:lead");
  expect(impact.affectedTaskIds).not.toContain("v1:analysis:lead");
  expect(impact.historicalAffectedTaskIds).toEqual(["v1:analysis:lead"]);
});

test("without a previous aggregate input, early adoption does not invalidate unrelated future tasks", () => {
  const p = fixture();
  p.currentStage = "question";
  p.fusion!.inputs = [];
  p.fusion!.adoptedInputs = [];
  p.fusion!.tasks[3]!.inputs = [];
  expect(projectResearchMaterialAdoptionImpact(p, "data").affectedTaskIds).toEqual([]);
});

test("snapshot token is stable across object property order, but changes when displayed impact or adoption state changes", () => {
  const p = fixture(),
    baseline = projectResearchMaterialAdoptionImpact(p, "data").token;
  const reordered = {
    ...p,
    finalPaper: { provenance: "/provenance.json", html: "/paper.html", markdown: "/paper.md" },
  };
  expect(projectResearchMaterialAdoptionImpact(reordered, "data").token).toBe(baseline);
  expect(projectResearchMaterialAdoptionImpact(p, "paper").token).not.toBe(baseline);
  for (const mutate of [
    (q: ResearchProject) => {
      q.fusion!.tasks[0]!.inputVersion++;
    },
    (q: ResearchProject) => {
      q.fusion!.artifacts[0]!.reviewState = "needs-review";
    },
    (q: ResearchProject) => {
      q.currentStage = "question";
    },
    (q: ResearchProject) => {
      q.finalPaper = undefined;
    },
    (q: ResearchProject) => {
      q.revision++;
    },
  ]) {
    const changed = structuredClone(p);
    mutate(changed);
    expect(projectResearchMaterialAdoptionImpact(changed, "data").token).not.toBe(baseline);
  }
});

test("legacy projects and projects with no existing graph have no fabricated affected tasks", () => {
  const p = fixture();
  p.workflowVersion = undefined;
  expect(projectResearchMaterialAdoptionImpact(p, "data").affectedTaskIds).toEqual([]);
  p.workflowVersion = "fusion-v2";
  p.fusion = undefined;
  const impact = projectResearchMaterialAdoptionImpact(p, "data");
  expect(impact.affectedTaskIds).toEqual([]);
  expect(impact.reusableTaskIds).toEqual([]);
  expect(impact.requiresDesignReview).toBe(true);
});
