import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { decodeResearchM3Action, researchSelectableTaskRanges } from "../../contracts/research-m3";
import {
  assertResearchTaskPublication,
  composeResearchScopedText,
  recordResearchScopedResult,
  setResearchTaskScope,
  scopedResearchPublicationContent,
} from "../../electron/research-group/research-task-scope";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchRepository } from "../../electron/research-group/repository";
import { finishFusionNativeRun } from "../../electron/research-group/fusion-task-runtime";
import {
  m3Activate,
  m3Artifact,
  m3Project,
  M3_BODY,
  M3_MANUSCRIPT,
  m3ReadSources,
} from "../helpers/research-m3-unit-fixture";
import { m3Coordinator } from "../helpers/research-m3-coordinator-fixture";
import { RESEARCH_TASK_KINDS, type ResearchSingleTaskKind } from "../../contracts/research-method";

async function bounded(kind: ResearchSingleTaskKind = "chapter-edit") {
  const { p, directory } = await m3Project(
    "review",
    kind === "reading"
      ? "reading"
      : kind === "design-review"
        ? "design"
        : kind === "chapter-edit"
          ? "writing"
          : "audit",
  );
  p.goal = "task";
  p.entry = "task";
  p.task = { kind, scope: kind === "chapter-edit" ? "仅讨论章" : "仅三条引用" };
  p.status = "paused";
  const source = p.evidence!.sources.find((s) => s.id === "manuscript")!;
  const choices = researchSelectableTaskRanges(M3_MANUSCRIPT, kind);
  const ranges =
    kind === "chapter-edit"
      ? choices.filter((r) => r.label === "讨论")
      : kind === "citations"
        ? choices.filter((r) => r.label.includes("引用"))
        : choices;
  const scope = await setResearchTaskScope(
    p,
    { operation: "task-scope", sourceId: source.id, sourceSha256: source.sha256, ranges },
    new Date().toISOString(),
  );
  return { p, directory, source, scope };
}
test("chapter edits preserve every unselected byte including Unicode before the selection", async () => {
  const { scope } = await bounded();
  const selected = scope.ranges[0]!;
  const result = composeResearchScopedText(scope, [
    { start: selected.start, end: selected.end, replacement: "## 讨论\n更新的限定讨论😀。\n\n" },
  ]);
  expect(result.slice(0, selected.start)).toBe(M3_MANUSCRIPT.slice(0, selected.start));
  expect(result.endsWith(M3_MANUSCRIPT.slice(selected.end))).toBe(true);
  expect(result).toContain("保留引言😀");
  expect(result).toContain("保留方法");
  expect(result).toContain("保留结论");
  expect(() =>
    composeResearchScopedText(scope, [
      { start: selected.start - 1, end: selected.end, replacement: "越界" },
    ]),
  ).toThrow("只能替换");
  expect(() =>
    composeResearchScopedText(scope, [
      { ...selected, replacement: "a" },
      { ...selected, replacement: "b" },
    ]),
  ).toThrow();
});
test("fixed scope rejects overlapping selections, source changes, cross-project IDs and post-execution changes", async () => {
  expect(() =>
    decodeResearchM3Action({
      operation: "task-scope",
      sourceId: "x",
      sourceSha256: "a".repeat(64),
      ranges: [
        { start: 0, end: 10, label: "a" },
        { start: 9, end: 12, label: "b" },
      ],
    }),
  ).toThrow("重叠");
  const { p, source, scope } = await bounded();
  await expect(
    setResearchTaskScope(
      p,
      {
        operation: "task-scope",
        sourceId: "another-project",
        sourceSha256: source.sha256,
        ranges: scope.ranges,
      },
      new Date().toISOString(),
    ),
  ).rejects.toThrow("不存在");
  await writeFile(source.file, "different original bytes");
  await expect(
    setResearchTaskScope(
      p,
      {
        operation: "task-scope",
        sourceId: source.id,
        sourceSha256: source.sha256,
        ranges: scope.ranges,
      },
      new Date().toISOString(),
    ),
  ).rejects.toThrow("已变化");
});
test("citation checking covers exactly the three selected references, including insufficient-material conclusions", async () => {
  const { p, scope } = await bounded("citations");
  expect(scope.ranges).toHaveLength(3);
  const report = {
    kind: "stage-draft",
    sourceIds: ["manuscript"],
    scopeFindings: scope.ranges.map((_, rangeIndex) => ({
      rangeIndex,
      conclusion: "insufficient-material",
      reason: M3_BODY,
    })),
  };
  expect(() => assertResearchTaskPublication(p, report)).not.toThrow();
  expect(() =>
    assertResearchTaskPublication(p, {
      ...report,
      scopeFindings: report.scopeFindings.slice(0, 2),
    }),
  ).toThrow("逐项覆盖");
  expect(() =>
    assertResearchTaskPublication(p, {
      ...report,
      scopeFindings: [...report.scopeFindings, report.scopeFindings[0]],
    }),
  ).toThrow("逐项覆盖");
  expect(() =>
    assertResearchTaskPublication(p, {
      ...report,
      scopeFindings: report.scopeFindings.map((f) => ({ ...f, rangeIndex: 0 })),
    }),
  ).toThrow("唯一范围");
});
test("adopting an accepted scoped result writes a new source and never rewrites the original", async () => {
  const { p, directory, source, scope } = await bounded();
  p.status = "running";
  m3Activate(p, "lead");
  const a = m3Artifact(p, "lead", "stage-draft", { sourceIds: [source.id, "paper-a"] });
  const edits = scope.ranges.map((r) => ({
    start: r.start,
    end: r.end,
    replacement: "## 讨论\n限定的新讨论。\n\n",
  }));
  a.content = scopedResearchPublicationContent(p, {
    kind: a.kind,
    content: a.content,
    sourceIds: [source.id],
    scopeEdits: edits,
  });
  const graphArtifact = p.fusion!.artifacts.find((row) => row.id === a.id)!;
  graphArtifact.content = a.content;
  recordResearchScopedResult(p, a, { scopeEdits: edits }, new Date().toISOString());
  m3Activate(p, "mentor");
  m3Artifact(p, "mentor", "stage-review", { refs: [a.id], verdict: "accept" });
  for (const role of ["lead", "mentor"] as const)
    finishFusionNativeRun(p, role, undefined, new Date().toISOString(), {
      input: 50,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    });
  p.status = "completed";
  const repository = new ResearchRepository(directory);
  await repository.save({ version: 1, config: { knowledgeDir: "" }, projects: [p] });
  const host: ResearchHost = {
    createMember: async () => {
      throw new Error("no new members");
    },
    deliver: async () => {
      throw new Error("no model requests");
    },
    cancel: async () => {},
    changed: () => {},
  };
  const c = new ResearchCoordinator(repository, host);
  await c.load();
  const resultId = p.m3!.results![0]!.id;
  await c.applyM3Action(p.root, {
    operation: "adopt-task-result",
    resultId,
    reason: "测试显式采用，原稿保留。",
  });
  await c.applyM3Action(p.root, {
    operation: "adopt-task-result",
    resultId,
    reason: "再次点击不得重复采用。",
  });
  const after = await repository.load();
  const project = after.projects[0]!;
  const adopted = project.evidence!.sources.filter((s) => s.id.startsWith("task-result-"));
  expect(adopted).toHaveLength(1);
  expect(await readFile(source.file, "utf8")).toBe(M3_MANUSCRIPT);
  expect(await readFile(adopted[0]!.file, "utf8")).toContain("限定的新讨论");
  const tampered = structuredClone(after);
  tampered.projects[0]!.m3!.results![0]!.fullText += "extra";
  await expect(repository.save(tampered)).rejects.toThrow("单项结果");
  expect((await repository.load()).projects[0]!.m3!.results![0]!.fullText).not.toContain("extra");
  expect(project.artifacts.find((row) => row.id === a.id)!.content).toBe(a.content);
  const next = structuredClone(after);
  next.projects[0]!.revision = 2;
  next.projects[0]!.status = "paused";
  next.projects[0]!.evidence!.sources = next.projects[0]!.evidence!.sources.filter(
    (s) => !s.id.startsWith("task-result-"),
  );
  await repository.save(next);
  await c.load();
  await c.applyM3Action(p.root, {
    operation: "adopt-task-result",
    resultId,
    reason: "在后续输入版本重新核对并采用同一独立报告。",
  });
  const reused = (await repository.load()).projects[0]!;
  expect(reused.evidence!.sources.filter((s) => s.id.startsWith("task-result-"))).toHaveLength(1);
  expect(reused.m3!.results![0]!.adoptions?.map((a) => a.revision)).toEqual([1, 2]);
  await writeFile(
    source.file.replace("manuscript.txt", "paper-a.txt"),
    "supporting paper changed after acceptance",
  );
  await expect(
    c.applyM3Action(p.root, {
      operation: "adopt-task-result",
      resultId,
      reason: "不能只核对原稿而忽略支持材料。",
    }),
  ).rejects.toThrow("已变化");
});
for (const kind of RESEARCH_TASK_KINDS)
  test(`coordinator ${kind} publishes the exact bounded deliverable and persists its reusable report`, async () => {
    const { p, scope, source } = await bounded(kind);
    m3ReadSources(p, "lead");
    p.packets.push({
      id: "fixed-logic-method",
      stage: p.currentStage,
      revision: 1,
      role: "lead",
      query: "unit fixture",
      ids: ["M3-FIXTURE"],
      at: new Date().toISOString(),
      records: [{ id: "M3-FIXTURE", text: M3_BODY }],
    });
    const setup = await m3Coordinator([p]);
    await setup.c.resume(p.root);
    await expect
      .poll(() =>
        setup.sent.some(
          (s) => s.ref.sessionId === p.members.find((m) => m.role === "lead")!.ref.sessionId,
        ),
      )
      .toBe(true);
    await setup.native(p.id, "lead", "start");
    const lead = p.members.find((m) => m.role === "lead")!;
    const edits = scope.ranges.map((r) => ({
      start: r.start,
      end: r.end,
      replacement: "## 讨论\n只改变这段讨论的实际正文。\n\n",
    }));
    const scopeFindings =
      kind === "citations"
        ? scope.ranges.map((_, rangeIndex) => ({
            rangeIndex,
            conclusion: "insufficient-material",
            reason: M3_BODY,
          }))
        : undefined;
    await setup.c.tool(lead.ref, "compose-publication", {
      operation: "publish",
      revision: 1,
      stage: p.currentStage,
      kind: "stage-draft",
      content: M3_BODY + M3_BODY,
      refs: [],
      sourceIds: [source.id],
      ...(kind === "chapter-edit" ? { scopeEdits: edits } : {}),
      ...(scopeFindings ? { scopeFindings } : {}),
    });
    const project = setup.c.snapshot().projects[0]!;
    const a = project.artifacts.find((a) => a.toolCallId === "compose-publication")!;
    const result = project.m3!.results![0]!;
    expect(a.content).toBe(result.fullText);
    if (kind === "chapter-edit") {
      expect(a.content).toBe(composeResearchScopedText(scope, edits));
      expect(a.content).toContain("保留引言😀");
      expect(a.content).toContain("保留结论");
    }
    if (kind === "citations") {
      expect(a.scopeFindings).toEqual(scopeFindings);
      expect(result.findings).toEqual(scopeFindings);
      expect(a.content).toContain("材料不足，不能核验");
    }
    expect(result.kind).toBe(kind);
    expect(await readFile(source.file, "utf8")).toBe(M3_MANUSCRIPT);
    expect((await setup.repository.load()).projects[0]!.m3!.results![0]).toEqual(result);
    expect(project.fusion!.artifacts.find((row) => row.id === a.id)!.content).toBe(a.content);
  });
