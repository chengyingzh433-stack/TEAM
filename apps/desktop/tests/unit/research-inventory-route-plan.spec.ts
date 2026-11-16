import { expect, test } from "@playwright/test";
import {
  planResearchEntryInventory,
  type ResearchInventoryFileObservation,
  type ResearchInventoryInput,
} from "../../electron/research-group/inventory-route-plan";
import type { ImportedResearchMaterial } from "../../contracts/research-materials";
import {
  createResearchTaskGraph,
  addResearchTask,
  startResearchTask,
  markResearchTaskDispatched,
  publishResearchTaskResult,
  reviewResearchTaskArtifact,
  requestResearchDecision,
  answerResearchDecision,
} from "../../electron/research-group/task-graph";

const sha = "a".repeat(64);
function candidate(
  category?: ImportedResearchMaterial["metadata"]["category"],
): ImportedResearchMaterial {
  return {
    id: "import-1",
    name: "draft.txt",
    sha256: sha,
    bytes: 20,
    importedAt: "2026-11-07T00:00:00Z",
    original: "/materials/original.txt",
    parsed: "/materials/parsed.json",
    parserVersion: "lancer-materials/2",
    duplicate: false,
    metadata: category ? { category } : {},
    status: "ready",
    locations: [{ kind: "line", locator: "line:1", text: "实际登记文本" }],
    tables: [],
    warnings: [],
  };
}
function sourceInput(): ResearchInventoryInput {
  return {
    entry: "materials",
    goal: "design",
    evidence: {
      directory: "/study",
      sources: [
        {
          id: "source-1",
          title: "提供原文",
          authors: "未知",
          year: "未知",
          url: "用户提供",
          file: "/study/source.txt",
          sha256: sha,
          kind: "paper",
          access: "provided-text",
        },
      ],
      datasets: [],
    },
  };
}
function observed(input: ResearchInventoryInput): ResearchInventoryFileObservation[] {
  return planResearchEntryInventory(input).requiredChecks.map((check) => ({
    file: check.file,
    status: "readable",
    sha256: check.expectedSha256 ?? sha,
  }));
}

test("entry labels alone never manufacture material, manuscript or source availability", () => {
  for (const entry of ["materials", "manuscript"] as const) {
    const plan = planResearchEntryInventory({
      entry,
      goal: entry === "materials" ? "design" : "task",
      ...(entry === "manuscript"
        ? { task: { kind: "manuscript-review", scope: "审阅提供的全文" } as const }
        : {}),
    });
    expect(plan.canStart).toBe(false);
    expect(plan.reusable).toEqual([]);
    expect(plan.inventory).toBeUndefined();
    expect(plan.missing.some((item) => item.blocksStart)).toBe(true);
  }
  const single = planResearchEntryInventory({
    entry: "task",
    goal: "task",
    task: { kind: "reading", scope: "只精读指定文章" },
  });
  expect(single.canStart).toBe(false);
  expect(single.route.stageIds).toEqual(["reading"]);
});

test("registered paths require actual matching file observations and candidates still need adoption", () => {
  const input = sourceInput();
  const before = structuredClone(input);
  const unchecked = planResearchEntryInventory(input);
  expect(unchecked.status).toBe("pending-checks");
  expect(unchecked.canStart).toBe(false);
  expect(unchecked.requiredChecks).toEqual([
    { file: "/study/source.txt", kind: "source", ownerId: "source-1", expectedSha256: sha },
  ]);
  for (const observation of [
    { file: "/study/source.txt", status: "missing" as const },
    { file: "/study/source.txt", status: "readable" as const, sha256: "b".repeat(64) },
  ])
    expect(planResearchEntryInventory(input, [observation]).canStart).toBe(false);
  const valid = planResearchEntryInventory(input, observed(input));
  expect(valid.canStart).toBe(true);
  expect(valid.nextStage).toBe("reading");
  expect(valid.route.stageIds).toEqual(["reading", "synthesis", "design"]);
  expect(valid.reusable.some((item) => item.kind === "accepted-stage")).toBe(false);
  expect(input).toEqual(before);
  const pending: ResearchInventoryInput = {
    entry: "materials",
    goal: "design",
    importedMaterials: [candidate()],
  };
  expect(planResearchEntryInventory(pending, observed(pending))).toMatchObject({
    status: "needs-adoption",
    canStart: false,
  });
});

test("manuscript classification uses actual category rather than name and missing raw evidence limits review without forcing earlier stages", () => {
  const input: ResearchInventoryInput = {
    entry: "manuscript",
    goal: "task",
    task: { kind: "manuscript-review", scope: "只审阅当前原稿，不改写其他材料" },
    importedMaterials: [candidate()],
  };
  expect(planResearchEntryInventory(input, observed(input)).canStart).toBe(false);
  input.importedMaterials = [candidate("manuscript")];
  const candidateOnly = planResearchEntryInventory(input, observed(input));
  expect(candidateOnly.canStart).toBe(false);
  expect(candidateOnly.missing).toContainEqual(
    expect.objectContaining({ kind: "adoption", blocksStart: true }),
  );
  input.evidence = sourceInput().evidence;
  input.evidence!.sources[0]!.kind = "manuscript";
  input.evidence!.sources[0]!.materialImportId = "import-1";
  const plan = planResearchEntryInventory(input, observed(input));
  expect(plan.canStart).toBe(true);
  expect(plan.route.stageIds).toEqual(["audit"]);
  expect(plan.missing).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "research-source", blocksStart: false }),
      expect.objectContaining({ kind: "implementation-data", blocksStart: false }),
    ]),
  );
  expect(plan.reusable).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "manuscript" })]),
  );
  input.importedMaterials[0]!.status = "failed";
  expect(planResearchEntryInventory(input, observed(input)).canStart).toBe(false);
});

test("adopted manuscript and design categories do not count as supporting literature or accepted stages", () => {
  const manuscript = sourceInput();
  manuscript.entry = "manuscript";
  manuscript.goal = "task";
  manuscript.task = { kind: "manuscript-review", scope: "只评审所提供稿件" };
  manuscript.evidence!.sources[0]!.kind = "manuscript";
  const review = planResearchEntryInventory(manuscript, observed(manuscript));
  expect(review.canStart).toBe(true);
  expect(review.route.stageIds).toEqual(["audit"]);
  expect(review.missing).toContainEqual(
    expect.objectContaining({ kind: "research-source", blocksStart: false }),
  );
  expect(review.reusable.filter((item) => item.kind === "accepted-stage")).toEqual([]);
  const design = sourceInput();
  design.evidence!.sources[0]!.kind = "design";
  const plan = planResearchEntryInventory(design, observed(design));
  expect(plan.canStart).toBe(true);
  expect(plan.nextStage).toBe("design");
  expect(plan.reusable.filter((item) => item.kind === "accepted-stage")).toEqual([]);
  design.entry = "task";
  design.goal = "task";
  design.task = { kind: "design-review", scope: "方案适配核查" };
  design.evidence!.sources[0]!.kind = "paper";
  expect(planResearchEntryInventory(design, observed(design)).canStart).toBe(false);
});

test("data provenance is not literature and actual data never skips design by itself", () => {
  const input = sourceInput();
  input.goal = "paper";
  input.evidence!.sources[0]!.kind = "dataset";
  input.evidence!.datasets.push({
    id: "data-1",
    sourceId: "source-1",
    file: "/study/data.csv",
    sha256: sha,
    description: "测试数据",
    dataKind: "synthetic",
    permission: "user-authorized",
    delimiter: ",",
  });
  const plan = planResearchEntryInventory(input, observed(input));
  expect(plan.nextStage).toBe("design");
  expect(plan.route.stageIds).toEqual(["design", "analysis", "writing", "audit"]);
  expect(plan.reusable.filter((item) => item.kind === "accepted-stage")).toEqual([]);
  const missingSource = observed(input).filter((item) => item.file !== "/study/source.txt");
  expect(planResearchEntryInventory(input, missingSource).canStart).toBe(false);
});

test("idea and discovery can start without data; future analysis waiting is not proposal failure", () => {
  expect(planResearchEntryInventory({ entry: "discovery", goal: "direction" })).toMatchObject({
    status: "not-required",
    canStart: true,
    nextStage: "scan",
  });
  const design = planResearchEntryInventory({
    entry: "idea",
    goal: "design",
    path: "quantitative",
  });
  expect(design.canStart).toBe(true);
  expect(design.missing).toEqual([]);
  expect(design.route.endStage).toBe("design");
  const paper = planResearchEntryInventory({ entry: "idea", goal: "paper", path: "quantitative" });
  expect(paper.canStart).toBe(true);
  expect(paper.missing).toContainEqual(
    expect.objectContaining({ kind: "implementation-data", stage: "analysis", blocksStart: false }),
  );
});

test("current accepted design resumes at analysis without inventing early history; stale review cannot supply that shortcut", () => {
  const at = "2026-11-07T00:00:00Z";
  let graph = createResearchTaskGraph("inventory-test", "2.0.0");
  graph = addResearchTask(graph, {
    id: "v1:design:mentor",
    stage: "design",
    role: "mentor",
    kind: "proposal",
    goal: "确认无数据方案",
    inputs: [],
    dependencies: [],
    earlyHandoff: "先交方案",
    deliverable: "方案及缺失条件",
    reviewRequired: true,
    writeScope: ["design"],
  });
  const request = {
    id: "condition-1",
    inputId: "design-scope",
    version: 1,
    at,
    requestedBy: "mentor-agent",
    question: "是否按所给范围继续设计评审？",
    context: "仍无实施数据。",
    impact: "仅约束设计导师。",
    taskIds: ["v1:design:mentor"],
    recommendedOptionId: "later",
    options: [
      {
        id: "yes",
        label: "继续设计评审",
        consequence: "不代表学术接受",
        outcome: "confirmed" as const,
      },
      { id: "later", label: "稍后决定", consequence: "继续等待", outcome: "deferred" as const },
    ],
  };
  graph = requestResearchDecision(graph, request);
  graph = answerResearchDecision(graph, {
    id: "actual-reply",
    requestId: request.id,
    at,
    optionId: "yes",
    text: "只评审方案",
    evidenceRef: "user-action:reply",
    origin: "new-reply",
  });
  graph = markResearchTaskDispatched(
    startResearchTask(graph, "v1:design:mentor", { id: "attempt-design", at, reservedTokens: 1 }),
    "attempt-design",
    at,
  );
  graph = publishResearchTaskResult(graph, {
    projectId: graph.projectId,
    id: "accepted-design",
    attemptId: "attempt-design",
    at,
    content: "有效方案，未来采集数据",
    usedTokens: 1,
  });
  graph = reviewResearchTaskArtifact(graph, "accepted-design", {
    id: "review-design",
    at,
    actor: "model",
    reviewer: "independent-reviewer",
    verdict: "accepted",
    reason: "仅方案通过，数据仍未到位",
  });
  const input: ResearchInventoryInput = {
    entry: "materials",
    goal: "paper",
    path: "quantitative",
    revision: 1,
    fusion: graph,
  };
  const plan = planResearchEntryInventory(input);
  expect(plan.nextStage).toBe("analysis");
  expect(plan.canStart).toBe(false);
  expect(plan.missing).toContainEqual(
    expect.objectContaining({ kind: "implementation-data", blocksStart: true }),
  );
  expect(graph.tasks).toHaveLength(1);
  const proposal = planResearchEntryInventory({ ...input, goal: "design" });
  expect(proposal.goalSatisfied).toBe(true);
  expect(proposal.missing).toEqual([]);
  expect(graph.inputs.find((item) => item.inputId === "design-scope")?.availability).toBe(
    "missing",
  );
  for (const outcome of ["declined", "deferred"] as const) {
    const unanswered = structuredClone(graph);
    unanswered.decisions[0]!.outcome = outcome;
    expect(
      planResearchEntryInventory({ ...input, fusion: unanswered }).reusable.filter(
        (item) => item.kind === "accepted-stage",
      ),
    ).toEqual([]);
  }
  const changedCondition = requestResearchDecision(graph, {
    ...request,
    id: "condition-2",
    version: 2,
  });
  expect(
    planResearchEntryInventory({ ...input, fusion: changedCondition }).reusable.filter(
      (item) => item.kind === "accepted-stage",
    ),
  ).toEqual([]);
  const changedObjective = planResearchEntryInventory({ ...input, revision: 2 });
  expect(changedObjective.reusable.filter((item) => item.kind === "accepted-stage")).toEqual([]);
  expect(changedObjective.inventory).toBeUndefined();
  graph.artifacts[0]!.interim = true;
  expect(
    planResearchEntryInventory(input).reusable.filter((item) => item.kind === "accepted-stage"),
  ).toEqual([]);
  graph.artifacts[0]!.interim = false;
  graph.artifacts[0]!.reviewState = "needs-review";
  const stale = planResearchEntryInventory(input);
  expect(stale.inventory).toBeUndefined();
  expect(stale.canStart).toBe(false);
  expect(stale.reusable.filter((item) => item.kind === "accepted-stage")).toEqual([]);
});

test("nonquantitative routes have no CSV gate and adopted imported sources require their original and parse checks", () => {
  const input = sourceInput();
  input.goal = "paper";
  input.path = "review";
  input.importedMaterials = [candidate("paper")];
  input.evidence!.sources[0]!.materialImportId = "import-1";
  const incomplete = observed(input).filter((item) => item.file !== "/materials/parsed.json");
  expect(planResearchEntryInventory(input, incomplete).canStart).toBe(false);
  const plan = planResearchEntryInventory(input, observed(input));
  expect(plan.canStart).toBe(true);
  expect(plan.missing.some((item) => item.kind === "implementation-data")).toBe(false);
});
