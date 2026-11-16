import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  researchPdfFixture,
  researchOfficeFixture,
  researchDocxFixture,
  researchXlsxFixture,
} from "../helpers/research-material-fixture";
import {
  decodeImportedResearchMaterials,
  decodeMaterialRecoveryRequest,
} from "../../contracts/research-materials";
import {
  importResearchMaterials,
  recoverImportedResearchMaterial,
  type MaterialImportResult,
} from "../../electron/research-group/material-import";

const material = (result: MaterialImportResult | undefined) => {
  if (!result?.ok) throw new Error(result?.error ?? "Missing result");
  return result.material;
};

test("mixed actual files preserve originals and expose precise locations and parsing limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-import-mixed-"));
  const files: Record<string, Uint8Array | string> = {
    "notes.md": "# 课堂问题\n材料位置保留\n",
    "paper.pdf": researchPdfFixture("Research evidence on page one"),
    "scan.pdf": researchPdfFixture(),
    "draft.docx": researchOfficeFixture({
      "word/document.xml":
        '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>真实段落</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>字段</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>',
    }),
    "data.csv": 'name,score\n"学生甲",3\n"学生乙",\nwrong,4,extra\n',
    "data.tsv": "x\ty\n1\t2\n3\t4\n",
    "bad.txt": new Uint8Array([0xc3, 0x28]),
    "bad.csv": 'x,y\n"unfinished',
    "workbook.xlsx": researchOfficeFixture({
      "xl/workbook.xml": '<workbook><sheets><sheet name="课堂" r:id="r1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>成绩</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>比较</t></is></c></row><row r="2"><c r="A2"><v>12</v></c><c r="B2"><f>A2*2</f><v>24</v></c></row><row r="3"><c r="A3"><v>14</v></c><c r="B3"><f>A3*2</f></c></row></sheetData></worksheet>',
    }),
  };
  for (const [name, data] of Object.entries(files)) await writeFile(join(root, name), data);
  const requests = Object.keys(files).map((name) => ({
    file: join(root, name),
    metadata: { title: name },
  }));
  const results = await importResearchMaterials(join(root, "project"), requests);
  expect(results).toHaveLength(9);
  const parsed = Object.fromEntries(
    results.map((value) => {
      const item = material(value);
      return [item.name, item];
    }),
  );
  expect(parsed["notes.md"]?.locations[1]).toMatchObject({
    locator: "line:2",
    text: "材料位置保留",
  });
  expect(parsed["paper.pdf"]?.locations[0]).toMatchObject({
    page: 1,
    locator: "page:1",
    text: "Research evidence on page one",
  });
  expect(parsed["scan.pdf"]?.status).toBe("needs-parsing");
  expect(parsed["draft.docx"]?.locations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ locator: "paragraph:1", text: "真实段落" }),
      expect.objectContaining({ locator: "table:1/row:2/cell:1", text: "内容" }),
    ]),
  );
  expect(parsed["draft.docx"]?.warnings.join(" ")).toContain("w:drawing");
  expect(parsed["data.csv"]?.tables[0]?.rows).toHaveLength(4);
  expect(parsed["data.csv"]?.tables[0]?.errors[0]).toMatchObject({ row: 4 });
  expect(parsed["data.csv"]?.tables[0]?.columns[1]).toMatchObject({ missing: 1 });
  expect(parsed["data.tsv"]?.tables[0]?.headers).toEqual(["x", "y"]);
  expect(parsed["bad.txt"]?.status).toBe("failed");
  expect(parsed["bad.csv"]?.error).toContain("引号未闭合");
  expect(parsed["workbook.xlsx"]?.locations).toContainEqual(
    expect.objectContaining({ locator: "课堂!B2", text: "24", formula: "A2*2" }),
  );
  expect(parsed["workbook.xlsx"]?.warnings.join(" ")).toContain("缺少缓存值");
  for (const [name, source] of Object.entries(files)) {
    expect(await readFile(join(root, name))).toEqual(Buffer.from(source));
    expect(parsed[name]!.original).toMatch(new RegExp(`\\.${name.split(".").at(-1)}$`));
    expect(await readFile(parsed[name]!.original)).toEqual(Buffer.from(source));
    const persisted: unknown = JSON.parse(await readFile(parsed[name]!.parsed, "utf8"));
    expect(persisted).toEqual(parsed[name]);
    expect(decodeImportedResearchMaterials([persisted])).toEqual([parsed[name]]);
  }
});

test("duplicates retain immutable parses and same names never overwrite different content", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-import-repeat-"));
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  const a = join(root, "a", "same.txt"),
    b = join(root, "b", "same.txt");
  await writeFile(a, "first original");
  await writeFile(b, "second original");
  const output = join(root, "project");
  const results = await importResearchMaterials(output, [
    { file: a },
    { file: b },
    { file: a },
    { file: join(root, "missing.txt") },
  ]);
  const first = material(results[0]),
    second = material(results[1]),
    duplicate = material(results[2]);
  expect(first.original).not.toBe(second.original);
  expect(duplicate.original).toBe(first.original);
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.parsed).not.toBe(first.parsed);
  expect(results[3]?.ok).toBe(false);
  expect(await readFile(first.original, "utf8")).toBe("first original");
});

test("storage symlink and hostile archive are rejected without changing source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-import-security-"));
  const outside = join(root, "outside"),
    project = join(root, "project");
  await mkdir(outside);
  await mkdir(project);
  await symlink(outside, join(project, "originals"));
  const source = join(root, "source.txt");
  await writeFile(source, "preserve me");
  const linked = await importResearchMaterials(project, [{ file: source }]);
  expect(linked[0]).toMatchObject({ ok: false, error: expect.stringContaining("越界") });
  const hostile = join(root, "hostile.docx");
  await writeFile(
    hostile,
    researchOfficeFixture({
      "word/document.xml":
        '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><w:document>&secret;</w:document>',
    }),
  );
  const imported = material(
    (await importResearchMaterials(join(root, "safe"), [{ file: hostile }]))[0],
  );
  expect(imported.status).toBe("failed");
  expect(imported.error).toContain("外部实体");
  expect(await readFile(source, "utf8")).toBe("preserve me");
});

test("delimiter and header choices reparse the same bytes without erasing prior failed previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-import-choices-"));
  const source = join(root, "semicolon.csv");
  await writeFile(source, 'title;\nname;score\n"multi\nline";7\n"quoted ""name""";9\n');
  const output = join(root, "project");
  const initial = material((await importResearchMaterials(output, [{ file: source }]))[0]);
  expect(initial.status).toBe("failed");
  const corrected = material(
    (await importResearchMaterials(output, [{ file: source, delimiter: ";", headerRow: 2 }]))[0],
  );
  expect(corrected.duplicate).toBe(true);
  expect(corrected.tables[0]?.headers).toEqual(["name", "score"]);
  expect(corrected.tables[0]?.rows[2]).toEqual(["multi\nline", "7"]);
  expect(corrected.tables[0]?.rows[3]).toEqual(['quoted "name"', "9"]);
  expect(corrected.tables[0]?.rowLocations[3]).toBe("line:5");
  expect(await readFile(initial.parsed, "utf8")).toContain('"status": "failed"');
  const utf16 = join(root, "utf16.txt");
  await writeFile(
    utf16,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文编码\n第二行", "utf16le")]),
  );
  const decoded = material((await importResearchMaterials(output, [{ file: utf16 }]))[0]);
  expect(decoded.locations[1]?.text).toBe("第二行");
});

test("XLSX selected sheet retains physical row and cell identity including gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-import-sheets-"));
  const source = join(root, "sheets.xlsx");
  await writeFile(
    source,
    researchOfficeFixture({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="A" r:id="r1"/><sheet name="B" r:id="r2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="r1" Target="worksheets/a.xml"/><Relationship Id="r2" Target="worksheets/b.xml"/></Relationships>',
      "xl/worksheets/a.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>unselected</t></is></c></row></sheetData></worksheet>',
      "xl/worksheets/b.xml":
        '<worksheet><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>value</t></is></c></row><row r="4"><c r="A4"><v>17</v></c></row></sheetData></worksheet>',
    }),
  );
  const selected = material(
    (
      await importResearchMaterials(join(root, "project"), [
        { file: source, sheet: "B", headerRow: 2 },
      ])
    )[0],
  );
  expect(selected.tables.map((preview) => preview.name)).toEqual(["B"]);
  expect(selected.tables[0]?.rows).toEqual([[""], ["value"], [""], ["17"]]);
  expect(selected.tables[0]?.rowLocations[3]).toBe("B!4");
  expect(selected.locations).toContainEqual(
    expect.objectContaining({ locator: "B!A4", text: "17" }),
  );
});

test("persisted material validation preserves failed originals and rejects damaged identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-import-decode-"));
  const source = join(root, "bad.txt");
  await writeFile(source, new Uint8Array([0xff]));
  const failed = material(
    (await importResearchMaterials(join(root, "project"), [{ file: source }]))[0],
  );
  expect(failed.status).toBe("failed");
  expect(decodeImportedResearchMaterials([failed])[0]?.original).toBe(failed.original);
  expect(() => decodeImportedResearchMaterials([{ ...failed, sha256: "not-a-digest" }])).toThrow(
    "摘要",
  );
  expect(() => decodeImportedResearchMaterials([{ ...failed, error: undefined }])).toThrow(
    "失败原因",
  );
  expect(() => decodeImportedResearchMaterials([failed, failed])).toThrow("ID 重复");
  expect(() => decodeImportedResearchMaterials([{ ...failed, unknownFutureField: true }])).toThrow(
    "未知字段",
  );
});

test("recovery redecodes retained bytes, keeps failed versions, and records manual page extraction without verifying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-import-recovery-")),
    output = join(root, "project");
  const encoded = join(root, "gbk.txt");
  await writeFile(encoded, new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]));
  const failed = material((await importResearchMaterials(output, [{ file: encoded }]))[0]);
  expect(failed.status).toBe("failed");
  const decoded = await recoverImportedResearchMaterial(output, failed, {
    kind: "reparse",
    encoding: "gb18030",
  });
  expect(decoded.locations[0]?.text).toBe("中文");
  expect(decoded).toMatchObject({
    name: "gbk.txt",
    original: failed.original,
    sha256: failed.sha256,
    recovery: { fromImportId: failed.id, kind: "reparse" },
    parseOptions: { encoding: "gb18030" },
  });
  expect(decoded.id).not.toBe(failed.id);
  expect(await readFile(failed.parsed, "utf8")).toContain('"status": "failed"');
  const scanned = join(root, "scan.pdf");
  await writeFile(scanned, researchPdfFixture());
  const scan = material((await importResearchMaterials(output, [{ file: scanned }]))[0]);
  const supplement = await recoverImportedResearchMaterial(output, scan, {
    kind: "supplement",
    locator: "page:1",
    text: "用户提供的定位文本（测试）",
    description: "手工抄录；原图内容未独立核验",
  });
  expect(supplement.locations[0]).toMatchObject({ page: 1, text: "用户提供的定位文本（测试）" });
  expect(supplement.status).toBe("partial");
  expect(supplement.warnings.join(" ")).toContain("尚未自动核验原图");
  await expect(
    recoverImportedResearchMaterial(output, scan, {
      kind: "supplement",
      locator: "page:9",
      text: "不在原件中的页",
      description: "测试",
    }),
  ).rejects.toThrow("已存在");
  expect(decodeImportedResearchMaterials([supplement])[0]).toEqual(supplement);
});

test("recovery changes delimiter and header selection, replaces corrupt CSV without losing originals, and refuses table text substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-table-recovery-")),
    output = join(root, "project");
  const source = join(root, "semicolon.csv");
  await writeFile(source, "说明;\nx;y\n1;2\n3;4\n");
  const initial = material((await importResearchMaterials(output, [{ file: source }]))[0]);
  const recovered = await recoverImportedResearchMaterial(output, initial, {
    kind: "reparse",
    delimiter: ";",
    headerRow: 2,
  });
  expect(recovered.tables[0]?.headers).toEqual(["x", "y"]);
  expect(recovered.tables[0]?.rowLocations).toEqual(["line:1", "line:2", "line:3", "line:4"]);
  await expect(
    recoverImportedResearchMaterial(output, recovered, {
      kind: "supplement",
      locator: "line:3",
      text: "99;99",
      description: "不应绕过数据修正",
    }),
  ).rejects.toThrow("表格材料");
  const wrong = join(root, "wrong.csv");
  await writeFile(wrong, "x,y\n1,2,extra\n");
  const bad = material((await importResearchMaterials(output, [{ file: wrong }]))[0]);
  const corrected = join(root, "corrected.csv");
  await writeFile(corrected, "x,y\n1,2\n");
  const replacement = await recoverImportedResearchMaterial(
    output,
    bad,
    { kind: "replace" },
    corrected,
  );
  expect(replacement.name).toBe("corrected.csv");
  expect(replacement.sha256).not.toBe(bad.sha256);
  expect(replacement.recovery).toEqual({ kind: "replace", fromImportId: bad.id });
  expect(replacement.tables[0]?.errors).toEqual([]);
  expect(await readFile(bad.original, "utf8")).toBe("x,y\n1,2,extra\n");
  await expect(
    recoverImportedResearchMaterial(output, bad, { kind: "reparse" }, corrected),
  ).rejects.toThrow("只有替换");
  expect(() => decodeMaterialRecoveryRequest({ kind: "replace", file: "/private" })).toThrow(
    "未知字段",
  );
});

test("complete Office fixtures parse real DOCX and XLSX packages and recover the selected physical header", async () => {
  const root = await mkdtemp(join(tmpdir(), "lancer-office-recovery-")),
    output = join(root, "project");
  const docx = join(root, "real.docx"),
    xlsx = join(root, "real.xlsx");
  await writeFile(docx, researchDocxFixture());
  await writeFile(xlsx, researchXlsxFixture());
  const results = await importResearchMaterials(output, [{ file: docx }, { file: xlsx }]);
  const document = material(results[0]),
    workbook = material(results[1]);
  expect(document.locations).toContainEqual(
    expect.objectContaining({ locator: "table:1/row:2/cell:2", text: "需要原始证据" }),
  );
  expect(workbook.tables.map((table) => table.name)).toEqual(["成绩", "说明"]);
  expect(workbook.tables[0]?.errors.length).toBeGreaterThan(0);
  const recovered = await recoverImportedResearchMaterial(output, workbook, {
    kind: "reparse",
    sheet: "成绩",
    headerRow: 2,
  });
  expect(recovered.tables).toHaveLength(1);
  expect(recovered.tables[0]).toMatchObject({ name: "成绩", headers: ["x", "y"], errors: [] });
  expect(recovered.locations).toContainEqual(
    expect.objectContaining({ locator: "成绩!B3", text: "2", formula: "A3*2" }),
  );
  const allSheets = await recoverImportedResearchMaterial(output, recovered, {
    kind: "reparse",
    sheet: "",
    headerRow: 1,
  });
  expect(allSheets.tables.map((table) => table.name)).toEqual(["成绩", "说明"]);
});
