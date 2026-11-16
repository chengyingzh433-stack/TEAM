import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchProject } from "../../contracts/research-group";
import { importResearchMaterials } from "../../electron/research-group/material-import";
import { adoptImportedResearchMaterial } from "../../electron/research-group/material-adoption";
import { inspectResearchInventory } from "../../electron/research-group/inspect-inventory";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "lancer-inspect-inventory-"));
  const file = join(directory, "user-draft.txt");
  await writeFile(
    file,
    "题目：课堂论证观察\n方法：只评审现有稿件的论证结构，真实数据和支持原文尚缺。\n",
  );
  const [imported] = await importResearchMaterials(join(directory, "imports"), [{ file }]);
  if (!imported?.ok) throw new Error("Could not import isolated manuscript fixture");
  const material = imported.material;
  const adopted = await adoptImportedResearchMaterial(join(directory, "adopted"), material, {
    category: "manuscript",
    sourceDescription: "用户明确提供的隔离测试稿件；只做范围内审阅。",
  });
  const project: ResearchProject = {
    id: randomUUID(),
    root: { workspaceId: directory, sessionId: "mentor" },
    workspacePath: directory,
    objective: "对所提供文本做有边界审阅，不宣称实证结论已核实。",
    revision: 1,
    status: "paused",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    knowledge: { directory, sha256: "a".repeat(64), version: "fixture", count: 0 },
    members: [],
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "manuscript",
    goal: "task",
    path: "quantitative",
    task: { kind: "manuscript-review", scope: "仅审阅提供稿件的结构与推断边界" },
    importedMaterials: [material],
    evidence: { directory, sources: [adopted.source], datasets: [] },
    artifacts: [],
    events: [],
    packets: [],
  };
  return { project, material, adopted, directory };
}

test("actual adopted manuscript bytes permit bounded review without CSV or fabricated earlier acceptance", async () => {
  const { project, material } = await setup();
  expect(material.metadata.category).toBeUndefined();
  const before = structuredClone(project);
  const snapshot = await inspectResearchInventory(project);
  expect(snapshot.canStart).toBe(true);
  expect(snapshot.firstMissingStage).toBe("audit");
  expect(snapshot.missing.join("\n")).toContain("数值结果暂不能复算");
  expect(snapshot.missing.join("\n")).toContain("支持原文");
  expect(snapshot.reusable.join("\n")).toContain("有边界审阅");
  expect(snapshot.reusable.join("\n")).not.toContain("已经接受");
  expect(project).toEqual(before);
  expect(project.artifacts).toEqual([]);
  expect(project.fusion).toBeUndefined();
});

test("a registered manuscript whose working source is missing cannot start", async () => {
  const { project, directory } = await setup();
  project.evidence!.sources[0]!.file = join(directory, "missing-working-source.txt");
  const snapshot = await inspectResearchInventory(project);
  expect(snapshot.canStart).toBe(false);
  expect(snapshot.pending.length).toBeGreaterThan(0);
  expect(snapshot.missing.join("\n")).toContain("开始前需补齐");
});

test("changed original bytes invalidate the linked adopted manuscript even when the working source is intact", async () => {
  const { project, material, adopted } = await setup();
  const working = await readFile(adopted.source.file, "utf8");
  await writeFile(material.original, "隔离夹具故意改动的原件版本，旧摘要不能证明此内容有效。");
  expect((await inspectResearchInventory(project)).canStart).toBe(false);
  expect(await readFile(adopted.source.file, "utf8")).toBe(working);
});

test("readable parse JSON with different registered content cannot provide manuscript availability", async () => {
  const { project, material } = await setup();
  const modified = structuredClone(material);
  modified.locations[0]!.text = "未登记的新解析正文";
  await writeFile(material.parsed, JSON.stringify(modified));
  const snapshot = await inspectResearchInventory(project);
  expect(snapshot.canStart).toBe(false);
  expect(snapshot.pending.join("\n")).toContain("解析副本尚待实际读取核对");
});
