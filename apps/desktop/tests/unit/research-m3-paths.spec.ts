import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  decodeResearchPathRecord,
  type ResearchPathRecordInput,
} from "../../contracts/research-m3";
import {
  applyResearchPathTool,
  assertNonNumericPublication,
  changeResearchPath,
  currentResearchPathRecord,
} from "../../electron/research-group/research-paths";
import { validatePaperArtifact } from "../../electron/research-group/paper-pipeline";
import { decodeResearchState } from "../../electron/research-group/repository";
import { ensureFusionStageTasks } from "../../electron/research-group/fusion-task-runtime";
import {
  requestResearchDecision,
  researchTaskBlockers,
  researchDecisionStatus,
} from "../../electron/research-group/task-graph";
import {
  m3Activate,
  m3Artifact,
  m3Project,
  m3ReadSources,
  M3_BODY,
} from "../helpers/research-m3-unit-fixture";

function record(path: "review" | "qualitative" | "theoretical"): ResearchPathRecordInput {
  const common = {
    path,
    scope: "测试材料集",
    approach: "明确且有限的分析取向",
    limitations: "合成材料仅用于代码逻辑检查，不代表真实研究。",
    evidence: ["paper-a", "paper-b"].map((sourceId, i) => ({
      id: `e${i}`,
      sourceId,
      locatorId: `text:${sourceId}`,
      start: 0,
      end: 20,
      interpretation: "片段支持有边界的解释，仍需考虑反例。",
    })),
  };
  if (path === "review")
    return {
      ...common,
      review: {
        inclusionCriteria: "仅纳入这两份合成材料",
        qualityAssessment: "不能从合成材料判断真实研究质量",
        selectionLimitations: "不是系统综述",
      },
    };
  if (path === "qualitative")
    return {
      ...common,
      qualitative: {
        approach: "reflexive-thematic-analysis",
        researcherPosition: "研究者主动解释文本而非发现唯一客观编码",
        codes: [
          {
            id: "c1",
            label: "解释的分歧",
            evidenceIds: ["e0"],
            interpretation: "明确区分描述和研究者解释",
          },
        ],
        themes: [
          {
            id: "t1",
            label: "证据解释的张力",
            codeIds: ["c1"],
            claim: "存在解释张力",
            counterEvidenceIds: ["e1"],
          },
        ],
        negativeCaseSearch: "检查第二片段中不符合主题的叙述",
        reflexivity: "研究者立场影响编码和主题形成",
      },
    };
  return {
    ...common,
    theoretical: {
      concepts: [
        {
          id: "definition",
          definition: "证据解释是对材料意义作出的有条件论断",
          evidenceIds: ["e0"],
        },
      ],
      arguments: [
        {
          id: "argument",
          proposition: "应保留竞争解释",
          premiseIds: ["definition"],
          steps: ["先澄清解释的条件", "再检验是否存在其他可接受前提"],
          evidenceIds: ["e1"],
          competingExplanation: "解释也可能源于情境差异",
          counterexample: "同一材料可出现稳定但错误的解释",
        },
      ],
    },
  };
}
for (const path of ["review", "qualitative", "theoretical"] as const) {
  test(`${path}: no CSV prerequisite, pinned text analysis and same-draft review are required`, async () => {
    const { p } = await m3Project(path);
    const lead = m3Activate(p, "lead");
    m3ReadSources(p, "lead");
    expect(
      p
        .fusion!.tasks.find((t) => t.role === "lead")!
        .inputs.some((r) => r.inputId === "implementation-material"),
    ).toBe(false);
    const saved = (await applyResearchPathTool(
      p,
      "lead",
      { operation: "path-record", record: record(path) },
      new Date().toISOString(),
    )) as { id: string };
    expect(saved.id).toBeTruthy();
    expect(() =>
      validatePaperArtifact(p, "lead", {
        kind: "stage-draft",
        stage: "analysis",
        refs: [],
        sourceIds: ["paper-a", "paper-b"],
        analysisIds: [],
        pathRecordId: saved.id,
        content: M3_BODY,
      }),
    ).not.toThrow();
    const a = m3Artifact(p, "lead", "stage-draft", {
      pathRecordId: saved.id,
      sourceIds: ["paper-a", "paper-b"],
    });
    const reviewer = m3Activate(p, "reviewer");
    await expect(
      applyResearchPathTool(
        p,
        "reviewer",
        { operation: "path-read", recordId: saved.id },
        new Date().toISOString(),
      ),
    ).rejects.toThrow("独立判断");
    m3Artifact(p, "reviewer", "stage-risk");
    await applyResearchPathTool(
      p,
      "reviewer",
      { operation: "path-read", recordId: saved.id },
      new Date().toISOString(),
    );
    p.events.push({
      id: "reviewer-current-read",
      at: new Date().toISOString(),
      type: "read",
      role: "reviewer",
      artifactId: a.id,
      runId: reviewer.nativeRunId,
      detail: "read same draft",
      revision: 1,
    });
    await expect(
      applyResearchPathTool(
        p,
        "reviewer",
        {
          operation: "path-review",
          recordId: saved.id,
          artifactId: a.id,
          verdict: "limited",
          reason: M3_BODY,
        },
        new Date().toISOString(),
      ),
    ).rejects.toThrow("本人实际读取");
    m3ReadSources(p, "reviewer");
    await applyResearchPathTool(
      p,
      "reviewer",
      {
        operation: "path-review",
        recordId: saved.id,
        artifactId: a.id,
        verdict: "limited",
        reason: M3_BODY,
      },
      new Date().toISOString(),
    );
    expect(() =>
      assertNonNumericPublication(p, "mentor", { kind: "stage-review", verdict: "accept" }),
    ).not.toThrow();
    const stored = decodeResearchState({ version: 1, config: { knowledgeDir: "" }, projects: [p] });
    expect(stored.projects[0]!.m3!.pathRecords![0]!.attemptId).toBe(lead.id);
    p.fusion!.tasks.find((t) => t.id === reviewer.taskId)!.inputVersion++;
    expect(() =>
      assertNonNumericPublication(p, "mentor", { kind: "stage-review", verdict: "accept" }),
    ).toThrow("有效具名复核");
  });
}
test("path records reject unread, abstract-only, stale-byte and invented locations", async () => {
  const { p } = await m3Project("review");
  m3Activate(p, "lead");
  await expect(
    applyResearchPathTool(
      p,
      "lead",
      { operation: "path-record", record: record("review") },
      new Date().toISOString(),
    ),
  ).rejects.toThrow("本人已读");
  m3ReadSources(p, "lead");
  p.sourceReads!.forEach((r) => (r.depth = "abstract"));
  await expect(
    applyResearchPathTool(
      p,
      "lead",
      { operation: "path-record", record: record("review") },
      new Date().toISOString(),
    ),
  ).rejects.toThrow("摘要");
  p.sourceReads!.forEach((r) => (r.depth = "full-text"));
  const bad = record("review");
  bad.evidence[0]!.end = 900000;
  await expect(
    applyResearchPathTool(
      p,
      "lead",
      { operation: "path-record", record: bad },
      new Date().toISOString(),
    ),
  ).rejects.toThrow("定位");
  await writeFile(p.evidence!.sources[0]!.file, "changed actual bytes");
  await expect(
    applyResearchPathTool(
      p,
      "lead",
      { operation: "path-record", record: record("review") },
      new Date().toISOString(),
    ),
  ).rejects.toThrow("已变化");
});
test("qualitative themes require existing codes, explicit approach and counterexample search", () => {
  const input = record("qualitative");
  input.qualitative!.themes[0]!.codeIds = ["invented-code"];
  expect(() => decodeResearchPathRecord(input)).toThrow("缺失");
  input.qualitative!.themes[0]!.codeIds = ["c1"];
  input.qualitative!.negativeCaseSearch = "";
  expect(() => decodeResearchPathRecord(input)).toThrow("非空");
});
test("theoretical arguments require real premises, derivation and competing explanation", () => {
  const input = record("theoretical");
  input.theoretical!.arguments[0]!.premiseIds = ["missing"];
  expect(() => decodeResearchPathRecord(input)).toThrow("缺失");
  input.theoretical!.arguments[0]!.premiseIds = ["definition"];
  input.theoretical!.arguments[0]!.steps = [];
  expect(() => decodeResearchPathRecord(input)).toThrow("列表");
});
test("changing path preserves old content and invalidates the old analysis rather than reusing acceptance", async () => {
  const { p } = await m3Project("review");
  m3Activate(p, "lead");
  m3ReadSources(p, "lead");
  const r = (await applyResearchPathTool(
    p,
    "lead",
    { operation: "path-record", record: record("review") },
    new Date().toISOString(),
  )) as { id: string };
  const artifact = m3Artifact(p, "lead", "stage-draft", { pathRecordId: r.id });
  expect(() => changeResearchPath(p, "theoretical", new Date().toISOString())).toThrow("在途");
  p.fusion!.attempts.forEach((a) => {
    a.state = "succeeded";
    a.finishedAt = new Date().toISOString();
    a.usedTokens = 100;
  });
  p.status = "paused";
  changeResearchPath(p, "theoretical", new Date().toISOString());
  expect(p.artifacts.find((a) => a.id === artifact.id)!.content).toBe(artifact.content);
  expect(() => currentResearchPathRecord(p, r.id)).toThrow("过期");
  expect(p.fusion!.artifacts.find((a) => a.id === artifact.id)!.reviewState).toBe("needs-review");
});
test("switching an existing S6 task in both directions recalculates numeric prerequisites and keeps attempt pins", async () => {
  const { p } = await m3Project("quantitative");
  const before = structuredClone(p.fusion!.tasks.find((t) => t.role === "lead")!);
  expect(before.kind).toBe("analysis");
  expect(before.inputs.some((i) => i.inputId === "implementation-material")).toBe(true);
  p.fusion = requestResearchDecision(p.fusion!, {
    id: "csv-permission",
    inputId: "condition:csv-permission",
    version: 1,
    at: new Date().toISOString(),
    requestedBy: "lead",
    question: "是否取得CSV分析许可",
    context: "旧量化路径实际缺少数据和使用许可",
    impact: "阻塞旧S6",
    taskIds: [before.id],
    options: [
      { id: "yes", label: "已取得", consequence: "开展实际分析", outcome: "confirmed" },
      { id: "later", label: "尚未", consequence: "等待", outcome: "deferred" },
    ],
    recommendedOptionId: "later",
  });
  p.status = "paused";
  for (const path of ["review", "qualitative", "theoretical"] as const) {
    changeResearchPath(p, path, new Date().toISOString());
    p.currentStage = "analysis";
    ensureFusionStageTasks(p, new Date().toISOString());
    const task = p.fusion!.tasks.find((t) => t.id === before.id)!;
    expect(task.kind).toBe("research");
    expect(
      task.inputs.some(
        (i) => i.inputId === "implementation-material" || i.inputId.startsWith("dataset:"),
      ),
    ).toBe(false);
    expect(task.inputs.some((i) => i.inputId === "source:paper-a")).toBe(true);
    expect(task.inputs.some((i) => i.requirement === "user-confirmed")).toBe(false);
    expect(researchTaskBlockers(p.fusion!, task.id).some((b) => b.kind === "decision")).toBe(false);
    expect(researchDecisionStatus(p.fusion!, "csv-permission")).toBe("superseded");
    expect(p.fusion!.decisions).toEqual([]);
    expect(p.fusion!.decisionRequests).toHaveLength(1);
    expect(p.status).toBe("paused");
  }
  changeResearchPath(p, "quantitative", new Date().toISOString());
  const restored = p.fusion!.tasks.find((t) => t.id === before.id)!;
  expect(restored.kind).toBe("analysis");
  expect(restored.inputs.some((i) => i.inputId === "implementation-material")).toBe(true);
  expect(() =>
    decodeResearchState({ version: 1, config: { knowledgeDir: "" }, projects: [p] }),
  ).not.toThrow();
});
