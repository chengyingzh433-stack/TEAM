import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { ResearchAnalysisRun } from "../../contracts/research-evidence";
import {
  RESEARCH_ROLES,
  type ResearchArtifact,
  type ResearchProject,
  type ResearchRole,
} from "../../contracts/research-group";
import { decodeResearchTaskGraph } from "../../contracts/research-task-graph";
import {
  applyResearchChange,
  researchChangeImpact,
  setResearchInput,
} from "../../electron/research-group/task-graph";
import {
  activeFusionAttempt,
  attachFusionAnalysisInput,
  attachFusionArtifactInputs,
  attachFusionSourceInputs,
  captureFusionAnalysisBinding,
  dispatchFusionAttempt,
  ensureFusionStageTasks,
  finishFusionNativeRun,
  prepareFusionDelivery,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import {
  isCurrentResearchAnalysis,
  validatePaperArtifact,
} from "../../electron/research-group/paper-pipeline";
import { researchHash } from "../../electron/research-group/materials";

const at = "2026-11-07T12:00:00.000Z";
function project(stage: ResearchProject["currentStage"] = "reading"): ResearchProject {
  return {
    id: randomUUID(),
    root: { workspaceId: "fixture", sessionId: "mentor" },
    workspacePath: "/tmp/fusion-version-unit",
    objective: "确定性版本测试；不代表真实研究运行",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    currentStage: stage,
    goal: "paper",
    path: "quantitative",
    knowledge: { directory: "/tmp/course", sha256: "a".repeat(64), version: "fixture", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: "fixture", sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
    evidence: { directory: "/tmp", sources: [], datasets: [] },
  };
}
function source(id = "paper", sha256 = "a".repeat(64)) {
  return {
    id,
    sha256,
    file: `/tmp/${id}.txt`,
    title: "单元测试来源",
    authors: "fixture",
    year: "2026",
    url: "https://example.org/paper",
    kind: "paper" as const,
    access: "provided-text" as const,
  };
}
test("bounded manuscript review reads the actual target without fabricating quantitative prerequisites", () => {
  const p = project("audit");
  p.goal = "task";
  p.entry = "manuscript";
  p.task = { kind: "manuscript-review", scope: "仅审阅已提供稿件的论证与结构，数字待原始数据核验" };
  p.evidence!.sources = [{ ...source("draft"), kind: "manuscript" }];
  const baseline = "单元夹具的已选稿件";
  p.m3 = {
    scopes: [
      {
        id: "provided-manuscript-scope",
        revision: 1,
        sourceId: "draft",
        sourceSha256: p.evidence!.sources[0]!.sha256,
        baseline,
        bodySha256: researchHash(baseline),
        ranges: [{ start: 0, end: baseline.length, label: "限定稿件" }],
        at,
      },
    ],
  };
  const draft = {
    stage: "audit",
    kind: "stage-draft",
    refs: [],
    sourceIds: ["draft"],
    content: "有边界的稿件审阅",
  };
  expect(() => validatePaperArtifact(p, "lead", draft)).toThrow("实际读取");
  p.events.push({
    id: "read-current",
    at,
    type: "source-read",
    revision: 1,
    role: "lead",
    sourceId: "draft",
    sourceSha256: "a".repeat(64),
    detail: "实际读取当前稿件",
  });
  expect(validatePaperArtifact(p, "lead", draft)).toMatchObject({
    sourceIds: ["draft"],
    analysisIds: [],
  });
  expect(() => validatePaperArtifact(p, "lead", { ...draft, sourceIds: [] })).toThrow("对应稿件");
  p.goal = "paper";
  p.entry = "idea";
  expect(() => validatePaperArtifact(p, "lead", draft)).toThrow("实际分析结果");
});

test("an old source-read event cannot authorize citation after the same source identity is replaced", () => {
  const p = project();
  p.evidence!.sources = [source("paper", "b".repeat(64))];
  p.events.push({
    id: "read-old",
    at,
    type: "source-read",
    revision: 1,
    role: "lead",
    sourceId: "paper",
    sourceSha256: "a".repeat(64),
    detail: "只读过旧原文",
  });
  const draft = { stage: "reading", kind: "stage-draft", refs: [], sourceIds: ["paper"] };
  expect(() => validatePaperArtifact(p, "lead", draft)).toThrow("实际读取");
  p.events.push({ ...p.events[0]!, id: "read-replacement", sourceSha256: "b".repeat(64) });
  expect(validatePaperArtifact(p, "lead", draft).sourceIds).toEqual(["paper"]);
});
function run(p: ResearchProject, role: ResearchRole, id: string): void {
  const prepared = prepareFusionDelivery(p, role, id, at, "本轮任务");
  expect(prepared.kind).toBe("dispatch");
  dispatchFusionAttempt(p, id, at);
}
function artifact(
  p: ResearchProject,
  role: ResearchRole,
  kind: ResearchArtifact["kind"],
  id: string,
  refs: string[] = [],
  verdict?: ResearchArtifact["verdict"],
): ResearchArtifact {
  const a: ResearchArtifact = {
    id,
    role,
    kind,
    revision: 1,
    round: kind === "stage-revision" ? 1 : 0,
    createdAt: at,
    content: `版本测试成果：${id}`,
    refs,
    toolCallId: `tool-${id}`,
    stage: p.currentStage,
    ...(verdict ? { verdict } : {}),
  };
  publishFusionArtifact(p, a);
  p.artifacts.push(a);
  return a;
}

test("sources acquired during a run affect later snapshots and actual consumers without rewriting earlier artifacts", () => {
  const p = project();
  ensureFusionStageTasks(p, at);
  run(p, "librarian", "library");
  run(p, "lead", "lead");
  run(p, "mentor", "mentor");
  artifact(p, "librarian", "stage-material", "batch-before-source");
  const oldSnapshot = structuredClone(p.fusion!.artifacts[0]);
  p.evidence!.sources.push(source());
  attachFusionSourceInputs(p, "librarian", ["paper"], at, "actual-source-read:call-1");
  artifact(p, "librarian", "stage-material", "batch-with-source");
  attachFusionArtifactInputs(p, "lead", ["batch-with-source"], at, "actual-artifact-read:call-2");
  artifact(p, "lead", "stage-revision", "synthesis-with-source", ["batch-with-source"]);
  attachFusionArtifactInputs(
    p,
    "mentor",
    ["synthesis-with-source"],
    at,
    "actual-artifact-read:call-3",
  );
  artifact(p, "mentor", "stage-review", "accepted-reading", ["synthesis-with-source"], "accept");
  expect(p.fusion!.artifacts[0]).toEqual(oldSnapshot);
  expect(p.fusion!.artifacts.find((a) => a.id === "batch-with-source")?.inputRefs).toContainEqual({
    inputId: "source:paper",
    version: 1,
  });
  expect(
    p.fusion!.artifacts.find((a) => a.id === "accepted-reading")?.dependencyArtifactIds,
  ).toContain("synthesis-with-source");
  expect(activeFusionAttempt(p, "librarian")?.state).toBe("running");
  const impacts = researchChangeImpact(p.fusion!, "source:paper");
  expect(impacts.affectedTaskIds.sort()).toEqual([
    "v1:reading:lead",
    "v1:reading:librarian",
    "v1:reading:mentor",
  ]);
  expect(impacts.reusableTaskIds).toContain("v1:reading:reviewer");
  expect(decodeResearchTaskGraph(JSON.parse(JSON.stringify(p.fusion)))).toEqual(p.fusion);
  expect(p.events.filter((e) => e.type === "source-read")).toHaveLength(0); // Dependency inheritance does not fabricate source-reading events.
});

test("fusion numeric evidence rejects changed data, changed task inputs, changed plans and unpinned historical runs", () => {
  const p = project("analysis");
  p.evidence!.datasets.push({
    id: "data",
    sha256: "b".repeat(64),
    file: "/tmp/data.csv",
    description: "fixture",
    sourceId: "data-source",
    permission: "public",
    dataKind: "observed",
    delimiter: ",",
  });
  p.analysisPlan = { datasetId: "data", method: "ols", columns: ["x"], outcome: "y" };
  run(p, "lead", "compute");
  const binding = captureFusionAnalysisBinding(p, "lead", p.analysisPlan);
  const result: ResearchAnalysisRun = {
    id: "result",
    revision: 1,
    role: "lead",
    createdAt: at,
    spec: structuredClone(p.analysisPlan),
    datasetSha256: "b".repeat(64),
    engine: "fixture",
    result: {},
    sha256: "c".repeat(64),
    file: "/tmp/result.json",
    ...binding,
  };
  expect(isCurrentResearchAnalysis(p, result)).toBe(true);
  const legacyResult = {
    ...result,
    taskId: undefined,
    taskInputVersion: undefined,
    attemptId: undefined,
  };
  expect(isCurrentResearchAnalysis(p, legacyResult)).toBe(false);
  expect(isCurrentResearchAnalysis({ ...p, workflowVersion: undefined }, legacyResult)).toBe(true);
  const changedData = structuredClone(p);
  changedData.evidence!.datasets[0]!.sha256 = "d".repeat(64);
  expect(isCurrentResearchAnalysis(changedData, result)).toBe(false);
  const changedPlan = structuredClone(p);
  changedPlan.analysisPlan!.columns = ["z"];
  expect(isCurrentResearchAnalysis(changedPlan, result)).toBe(false);
  const changedTask = structuredClone(p);
  changedTask.fusion!.tasks.find((t) => t.id === result.taskId)!.inputVersion++;
  expect(isCurrentResearchAnalysis(changedTask, result)).toBe(false);
  expect(isCurrentResearchAnalysis(p, { ...result, attemptId: "unrelated-attempt" })).toBe(false);
  run(p, "reviewer", "independent-compute");
  expect(() => captureFusionAnalysisBinding(p, "reviewer", p.analysisPlan!)).toThrow(
    "尚未按本次实际读取版本绑定",
  );
  attachFusionAnalysisInput(p, "reviewer", "data", at, "actual-analysis:reviewer-call");
  expect(captureFusionAnalysisBinding(p, "reviewer", p.analysisPlan!)?.attemptId).toBe(
    "independent-compute",
  );
  p.currentStage = "writing";
  p.analyses = [legacyResult];
  p.events.push({
    id: "read-old-result",
    at,
    type: "analysis",
    role: "lead",
    analysisId: "result",
    revision: 1,
    detail: "读过旧记录不代表当前数值有效",
  });
  expect(() =>
    validatePaperArtifact(p, "lead", {
      stage: "writing",
      kind: "stage-draft",
      refs: [],
      analysisIds: ["result"],
    }),
  ).toThrow("分析引用需要实际运行或读取结果");
});

test("a new task-input version cannot reuse the old critique or inherit its exhausted revision quota", () => {
  const p = project("design");
  p.evidence!.sources.push(source());
  run(p, "lead", "old-lead");
  run(p, "reviewer", "old-reviewer");
  artifact(p, "reviewer", "stage-critique", "old-critique");
  artifact(p, "lead", "stage-revision", "old-revision-1", ["old-critique"]);
  artifact(p, "lead", "stage-revision", "old-revision-2", ["old-critique"]);
  p.evidence!.sources[0] = source("paper", "e".repeat(64));
  const oldInput = p.fusion!.inputs.find((i) => i.inputId === "source:paper")!;
  p.fusion = setResearchInput(p.fusion!, { ...oldInput, version: 2, digest: "e".repeat(64) });
  p.fusion = applyResearchChange(p.fusion, {
    id: "new-source-version",
    at,
    inputId: "source:paper",
    fromVersion: 1,
    toVersion: 2,
    reason: "新材料要求设计复核",
    authorizedBy: "user",
    authorizationRef: "user-adoption",
  });
  finishFusionNativeRun(p, "lead", undefined, at);
  finishFusionNativeRun(p, "reviewer", undefined, at);
  p.events.push({
    id: "adoption",
    at,
    type: "decision",
    revision: 1,
    stage: "design",
    detail: "采用材料；没有历史artifactId",
  });
  expect(() =>
    validatePaperArtifact(p, "lead", {
      stage: "design",
      kind: "stage-revision",
      refs: ["old-critique"],
    }),
  ).toThrow("缺少最新前置成果");
  run(p, "reviewer", "new-reviewer");
  artifact(p, "reviewer", "stage-critique", "new-critique");
  const checked = validatePaperArtifact(p, "lead", {
    stage: "design",
    kind: "stage-revision",
    refs: ["new-critique"],
  });
  expect(checked.round).toBe(1);
});
