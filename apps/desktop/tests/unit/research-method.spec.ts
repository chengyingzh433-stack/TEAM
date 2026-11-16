import { expect, test } from "@playwright/test";
import {
  decodeResearchAction,
  decodeResearchRoute,
  decodeResearchStages,
  researchStages,
  RESEARCH_STAGE_IDS,
} from "../../contracts/research-group";
import {
  decodeResearchMethodConfig,
  FUSION_STAGE_IDS,
  fusionResearchStages,
  RESEARCH_METHOD_VERSION,
  researchEntryStage,
  researchExecutionRoute,
  researchGoalStage,
  researchEditorWorkflow,
  RESEARCH_ENTRIES,
  RESEARCH_GOALS,
  RESEARCH_TASK_KINDS,
} from "../../contracts/research-method";
import { CYZ_PAPER_WORKFLOW } from "../../contracts/cyz-paper-workflow";
import { recommendResearchStages } from "../../contracts/research-model-recommendations";

test("fusion maps old literature models without rewriting old custom history or CYZ", () => {
  const stages = researchStages();
  const literature = stages.find((s) => s.id === "literature")!;
  literature.title = "用户的文献阶段";
  literature.goal = "用户的特定综合目标";
  literature.models.lead = { provider: "configured", modelId: "custom", thinkingLevel: "max" };
  stages.find((s) => s.id === "review")!.goal = "旧初步审阅不能充当设计完成";
  const before = structuredClone(stages);
  const cyz = structuredClone(CYZ_PAPER_WORKFLOW);
  const next = fusionResearchStages({ stages });
  expect(next.map((s) => s.id)).toEqual(FUSION_STAGE_IDS);
  for (const id of ["search", "reading", "synthesis"])
    expect(next.find((s) => s.id === id)!.models.lead).toEqual(literature.models.lead);
  next.find((s) => s.id === "search")!.models.lead!.modelId = "new-choice";
  expect(stages).toEqual(before);
  expect(CYZ_PAPER_WORKFLOW).toEqual(cyz);
  expect(next.find((s) => s.id === "design")!.goal).not.toContain("旧初步审阅");
  expect(researchStages({ stages }).map((s) => s.id)).toEqual(RESEARCH_STAGE_IDS);
});

test("explicit nine-stage configuration survives decoding with every selected model", () => {
  const stages = fusionResearchStages();
  stages.forEach((stage, i) => {
    stage.title = `自定义 ${i}`;
    stage.models.reviewer = {
      provider: "real-provider",
      modelId: `model-${i}`,
      thinkingLevel: "high",
    };
  });
  const action = decodeResearchAction({
    kind: "configure",
    config: {
      knowledgeDir: "/fixture/knowledge",
      workflowVersion: "fusion-v2",
      methodVersion: RESEARCH_METHOD_VERSION,
      entry: "idea",
      goal: "design",
      path: "quantitative",
      memberTokenBudget: 42000,
      stages,
    },
  });
  expect(action.kind).toBe("configure");
  if (action.kind !== "configure") throw new Error("wrong action");
  expect(action.config.stages).toEqual(stages);
  expect(action.config.memberTokenBudget).toBe(42000);
  expect(researchStages(action.config)).toEqual(stages);
  expect(() => decodeResearchStages(stages)).toThrow("明确选择");
  expect(() => decodeResearchStages(stages.slice(0, 7), "fusion-v2")).toThrow();
  expect(decodeResearchStages(researchStages().slice(0, 2))).toHaveLength(2);
  for (const stage of stages)
    expect(
      decodeResearchRoute({
        role: "reviewer",
        stage,
        active: true,
        revision: 1,
        model: stage.models.reviewer,
      }).stage.id,
    ).toBe(stage.id);
});

test("method decoder rejects unsupported versions and does not silently upgrade old configuration", () => {
  expect(decodeResearchMethodConfig({ knowledgeDir: "/legacy" })).toEqual({});
  expect(() => decodeResearchMethodConfig({ workflowVersion: "fusion-v3" })).toThrow();
  expect(() => decodeResearchMethodConfig({ methodVersion: "2.0.0" })).toThrow();
  expect(() =>
    decodeResearchMethodConfig({ workflowVersion: "fusion-v2", goal: "fake" }),
  ).toThrow();
  expect(() =>
    decodeResearchMethodConfig({ workflowVersion: "fusion-v2", methodVersion: "9.0" }),
  ).toThrow();
});

test("entry selection does not expand a limited goal or invent completed stages", () => {
  expect(researchEntryStage({ entry: "discovery", goal: "direction" })).toBe("scan");
  expect(researchEntryStage({ entry: "idea", goal: "design" })).toBe("question");
  expect(researchExecutionRoute({ entry: "materials", goal: "design" })).toMatchObject({
    startStage: "question",
    needsInventory: true,
  });
  expect(
    researchEntryStage(
      { entry: "materials", goal: "design" },
      { firstMissingStage: "design", evidenceRef: "inspection:actual-material-versions" },
    ),
  ).toBe("design");
  expect(researchEntryStage({ entry: "manuscript", goal: "task" })).toBe("audit");
  expect(researchEntryStage({ entry: "task", goal: "task" })).toBe("reading");
});

test("model recommendations cover all nine stages and keep legacy recommendations available", () => {
  const available = ["gpt-6-astra", "gpt-6.1-sol", "deepseek-flash"].map((modelId) => ({
    provider: "configured",
    modelId,
  }));
  const next = recommendResearchStages(available, "balanced", "fusion-v2");
  expect(next.missing).toEqual([]);
  expect(next.stages).toHaveLength(9);
  expect(next.stages.find((s) => s.id === "synthesis")!.models.reviewer!.modelId).toBe(
    "gpt-6-astra",
  );
  const legacy = recommendResearchStages(available).stages;
  expect(legacy).toHaveLength(7);
  expect(legacy.find((s) => s.id === "question")!.models.reviewer!.modelId).toBe("gpt-6.1-sol");
  expect(legacy.find((s) => s.id === "review")!.models.reviewer!.modelId).toBe("gpt-6-astra");
  expect(next.stages.find((s) => s.id === "question")!.models.reviewer!.modelId).toBe(
    "gpt-6-astra",
  );
});

test("all maturity and goal combinations terminate at a reachable bounded endpoint", () => {
  for (const entry of RESEARCH_ENTRIES)
    for (const goal of RESEARCH_GOALS) {
      const config = { workflowVersion: "fusion-v2" as const, entry, goal };
      const route = researchExecutionRoute(config);
      expect(route.stageIds[0]).toBe(route.startStage);
      expect(route.stageIds.at(-1)).toBe(route.endStage);
      expect(route.stageIds.length).toBeGreaterThan(0);
      expect(researchGoalStage(config)).toBe(route.endStage);
      if (entry !== "discovery") expect(route.stageIds).not.toContain("scan");
    }
  expect(researchExecutionRoute({ entry: "idea", goal: "direction" })).toMatchObject({
    startStage: "question",
    endStage: "question",
    stageIds: ["question"],
  });
  expect(researchExecutionRoute({ entry: "manuscript", goal: "design" })).toMatchObject({
    startStage: "design",
    endStage: "design",
  });
  expect(researchExecutionRoute({ entry: "discovery" }).stageIds).toEqual(["scan"]);
  expect(researchExecutionRoute({ entry: "idea" }).stageIds).toEqual([
    "question",
    "search",
    "reading",
    "synthesis",
    "design",
  ]);
});

test("material entry requires evidence-backed inventory and does not invent prior completion", () => {
  const config = { entry: "materials" as const, goal: "paper" as const };
  expect(researchExecutionRoute(config).needsInventory).toBe(true);
  expect(
    researchExecutionRoute(config, { firstMissingStage: "analysis", evidenceRef: "" })
      .needsInventory,
  ).toBe(true);
  const route = researchExecutionRoute(config, {
    firstMissingStage: "analysis",
    evidenceRef: "inspections/42:proposal-v3-and-dataset-v1",
  });
  expect(route.needsInventory).toBe(false);
  expect(route.stageIds).toEqual(["analysis", "writing", "audit"]);
  expect(route).not.toHaveProperty("completedStages");
  expect(
    researchExecutionRoute(
      { entry: "materials", goal: "question" },
      { firstMissingStage: "analysis", evidenceRef: "inspection:42" },
    ).stageIds,
  ).toEqual(["question"]);
});

test("single task kinds carry nonempty scope and route only their own deliverable", () => {
  const stages = {
    reading: "reading",
    citations: "audit",
    "design-review": "design",
    "chapter-edit": "writing",
    "manuscript-review": "audit",
  };
  for (const kind of RESEARCH_TASK_KINDS) {
    const config = decodeResearchMethodConfig({
      workflowVersion: "fusion-v2",
      entry: "task",
      goal: "task",
      task: { kind, scope: " 只处理用户指定的三条引用或章节A " },
    });
    expect(config.task?.scope).toBe("只处理用户指定的三条引用或章节A");
    const route = researchExecutionRoute(config);
    expect(route.stageIds).toEqual([stages[kind]]);
    expect(route.mode).toBe("single-task");
    expect(route.blockedReasons).toEqual([]);
    expect(route.requiredRoles).not.toContain("librarian");
  }
  for (const task of [
    { kind: "reading", scope: " " },
    { kind: "unknown", scope: "paperA" },
    { kind: "reading", scope: "paperA", allowed: true },
  ])
    expect(() => decodeResearchMethodConfig({ workflowVersion: "fusion-v2", task })).toThrow();
  expect(
    researchExecutionRoute({ entry: "task", goal: "paper" }).blockedReasons.length,
  ).toBeGreaterThan(0);
  expect(
    researchExecutionRoute({ entry: "task", goal: "task" }).blockedReasons.length,
  ).toBeGreaterThan(0);
  const action = decodeResearchAction({
    kind: "configure",
    config: {
      knowledgeDir: "/fixture/knowledge",
      workflowVersion: "fusion-v2",
      entry: "task",
      goal: "task",
      task: { kind: "chapter-edit", scope: "只修改讨论章，保留其他正文" },
    },
  });
  if (action.kind !== "configure") throw new Error("wrong action");
  expect(action.config.task).toEqual({ kind: "chapter-edit", scope: "只修改讨论章，保留其他正文" });
});

test("editor distinguishes a new project from a saved legacy template", () => {
  const legacy = {
    knowledgeDir: "/legacy",
    stages: researchStages().slice(0, 2),
    memberTokenBudget: 42000,
  };
  const before = structuredClone(legacy);
  expect(researchEditorWorkflow(legacy, "saved")).toBeUndefined();
  expect(researchEditorWorkflow(legacy, "project")).toBeUndefined();
  expect(researchEditorWorkflow(legacy, "new")).toBe("fusion-v2");
  expect(legacy).toEqual(before);
  expect(researchEditorWorkflow({ workflowVersion: "fusion-v2" }, "saved")).toBe("fusion-v2");
});
