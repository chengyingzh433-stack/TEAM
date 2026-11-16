import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importResearchMaterials } from "../../electron/research-group/material-import";
import { adoptImportedResearchMaterial } from "../../electron/research-group/material-adoption";
import {
  readPinnedResearchFile,
  openResearchEvidence,
} from "../../electron/research-group/materials";
import { decodeMaterialAdoptionDeclaration } from "../../contracts/research-materials";
import { calculateResearchData } from "../../electron/research-group/analysis";

async function imported(root: string, name: string, text: string) {
  const file = join(root, name);
  await writeFile(file, text);
  const [result] = await importResearchMaterials(join(root, "imports"), [{ file }]);
  if (!result?.ok) throw new Error("Fixture import failed");
  return result.material;
}

test("declared abstract scope survives actual import and manifest loading without becoming a full-text read", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-source-scope-"));
  const material = await imported(
    root,
    "abstract.txt",
    "Abstract: This supplied paragraph is only an abstract.\n",
  );
  const adoption = await adoptImportedResearchMaterial(join(root, "adopted"), material, {
    category: "paper",
    sourceDescription: "单元软件验收，仅有摘要。",
    textScope: "abstract",
  });
  expect(adoption.source.textScope).toBe("abstract");
  const source = {
    id: "ABSTRACT",
    file: "abstract.txt",
    title: "Scope fixture",
    authors: "Fixture",
    year: "2026",
    url: "urn:fixture:abstract",
    kind: "paper",
    textScope: "abstract",
  };
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({ version: 1, sources: [source], datasets: [] }),
  );
  expect((await openResearchEvidence(root)).sources[0]!.textScope).toBe("abstract");
  await expect(
    adoptImportedResearchMaterial(join(root, "fragment"), material, {
      category: "paper",
      sourceDescription: "只选一段",
      textScope: "full-text",
      locators: ["line:1"],
    }),
  ).rejects.toThrow("文本片段");
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      version: 1,
      sources: [{ ...source, textScope: "verified-by-model" }],
      datasets: [],
    }),
  );
  await expect(openResearchEvidence(root)).rejects.toThrow("文本范围");
  expect(await readFile(material.original, "utf8")).toBe(
    "Abstract: This supplied paragraph is only an abstract.\n",
  );
});

test("adopting actual CSV keeps every row and an original location map, and supports real calculation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-adopt-data-"));
  const material = await imported(root, "sample.csv", "x,y\n1,3\n2,5\n3,7\n4,9\n");
  const adoption = await adoptImportedResearchMaterial(join(root, "adopted"), material, {
    category: "data",
    sourceDescription: "隔离测试合成数据，验证计算与行映射",
    dataKind: "synthetic",
    permission: "user-authorized",
  });
  expect(adoption.dataset).toMatchObject({
    dataKind: "synthetic",
    permission: "user-authorized",
    sourceId: adoption.source.id,
  });
  const csv = await readPinnedResearchFile(adoption.dataset!);
  const calculation = calculateResearchData(csv, ",", {
    datasetId: adoption.dataset!.id,
    method: "ols",
    columns: ["x"],
    outcome: "y",
  });
  expect(calculation).toMatchObject({ regression: { rSquared: 1 } });
  const rows: unknown = JSON.parse(await readFile(adoption.rowMapFile!, "utf8"));
  expect(rows).toMatchObject({
    importId: material.id,
    originalSha256: material.sha256,
    rows: [
      { outputRow: 1, original: "line:1", cells: ["x", "y"] },
      { outputRow: 2, original: "line:2", cells: ["1", "3"] },
      { outputRow: 3, original: "line:3", cells: ["2", "5"] },
      { outputRow: 4, original: "line:4", cells: ["3", "7"] },
      { outputRow: 5, original: "line:5", cells: ["4", "9"] },
    ],
  });
  expect(await readFile(material.original, "utf8")).toBe(csv);
  expect(await readFile(adoption.provenanceFile, "utf8")).toContain(
    "user-declaration-not-independent-verification",
  );
});

test("unknown permission and malformed rows cannot become analysis evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-adopt-invalid-"));
  const material = await imported(root, "bad.csv", "x,y\n1,2,extra\n");
  const declaration = {
    category: "data" as const,
    sourceDescription: "测试来源说明",
    dataKind: "synthetic" as const,
  };
  await expect(
    adoptImportedResearchMaterial(join(root, "adopted"), material, declaration),
  ).rejects.toThrow("许可");
  await expect(
    adoptImportedResearchMaterial(join(root, "adopted"), material, {
      ...declaration,
      permission: "user-authorized",
    }),
  ).rejects.toThrow("错误行");
});

test("source adoption keeps explicit unknown metadata and selected locators, rejects modified originals or parses", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-adopt-source-"));
  const material = await imported(root, "paper.txt", "第一段证据\n第二段限制\n第三段未选范围\n");
  const declaration = {
    category: "paper" as const,
    sourceDescription: "用户提供的测试原文",
    locators: ["line:1", "line:2"],
  };
  const adoption = await adoptImportedResearchMaterial(
    join(root, "adopted"),
    material,
    declaration,
  );
  expect(adoption.source).toMatchObject({
    authors: "未知作者（未提供）",
    year: "未知年份（未提供）",
    access: "provided-text",
  });
  const text = await readPinnedResearchFile(adoption.source);
  expect(text).toContain("【line:2】\n第二段限制");
  expect(text).not.toContain("第三段未选范围");
  await expect(
    adoptImportedResearchMaterial(join(root, "adopted"), material, {
      ...declaration,
      locators: ["line:999"],
    }),
  ).rejects.toThrow("定位");
  const saved = await readFile(material.parsed, "utf8");
  await writeFile(material.parsed, saved.replace("第一段证据", "伪造证据"));
  await expect(
    adoptImportedResearchMaterial(join(root, "adopted"), material, declaration),
  ).rejects.toThrow("解析副本");
  await writeFile(material.original, "changed");
  await expect(
    adoptImportedResearchMaterial(join(root, "adopted"), material, declaration),
  ).rejects.toThrow("原件已变化");
});

test("adoption IPC declaration rejects unknown fields, missing permission, invalid enums and oversized scope", () => {
  const valid = { category: "paper", sourceDescription: "真实提供说明", locators: ["line:1"] };
  expect(decodeMaterialAdoptionDeclaration(valid)).toEqual(valid);
  expect(() =>
    decodeMaterialAdoptionDeclaration({ ...valid, injectedPath: "/etc/passwd" }),
  ).toThrow("未知字段");
  expect(() =>
    decodeMaterialAdoptionDeclaration({
      category: "data",
      sourceDescription: "来源",
      dataKind: "observed",
    }),
  ).toThrow("许可");
  expect(() => decodeMaterialAdoptionDeclaration({ ...valid, category: "unknown" })).toThrow(
    "类别",
  );
  expect(() =>
    decodeMaterialAdoptionDeclaration({ ...valid, locators: ["line:1", "line:1"] }),
  ).toThrow("重复");
  expect(() => decodeMaterialAdoptionDeclaration({ ...valid, year: "x".repeat(41) })).toThrow(
    "文本字段",
  );
});
