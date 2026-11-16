import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ResearchDataset, ResearchSource } from "../../contracts/research-evidence";
import {
  decodeImportedResearchMaterials,
  decodeMaterialAdoptionDeclaration,
  type ImportedResearchMaterial,
  type MaterialAdoptionDeclaration,
} from "../../contracts/research-materials";

export type { MaterialAdoptionDeclaration } from "../../contracts/research-materials";
export interface AdoptedResearchMaterial {
  source: ResearchSource;
  dataset?: ResearchDataset;
  provenanceFile: string;
  rowMapFile?: string;
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const csvCell = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
function required(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8000)
    throw new Error(`请补充有效的${field}，不能用模型推断替代使用声明。`);
  return value.trim();
}
async function write(file: string, content: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Creates working copies only; the coordinator owns impact approval and evidence adoption. */
export async function adoptImportedResearchMaterial(
  directory: string,
  material: ImportedResearchMaterial,
  declaration: MaterialAdoptionDeclaration,
): Promise<AdoptedResearchMaterial> {
  declaration = decodeMaterialAdoptionDeclaration(declaration);
  decodeImportedResearchMaterials([material]);
  if (["failed", "needs-parsing"].includes(material.status))
    throw new Error("此材料尚无可用解析，请先处理解析失败或补入可定位文本。");
  if (declaration.textScope === "full-text" && material.status !== "ready")
    throw new Error("材料仅部分可用，不能声明为完整文字来源；请选择实际提供范围。");
  if (declaration.textScope === "full-text" && declaration.locators?.length)
    throw new Error("选取的文本片段不能声明为完整文字来源；请保留部分文本范围。");
  const sourceDescription = declaration.sourceDescription;
  for (const [field, limit] of [
    ["title", 1000],
    ["authors", 2000],
    ["year", 40],
    ["url", 4000],
  ] as const) {
    const value = declaration[field] ?? material.metadata[field];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > limit || value.includes("\0"))
    )
      throw new Error(`材料 ${field} 字段无效或超出 ${limit} 字符上限。`);
  }
  if (digest(await readFile(material.original)) !== material.sha256)
    throw new Error("导入原件已变化，停止采用；请重新导入并查看影响。");
  const persisted: unknown = JSON.parse(await readFile(material.parsed, "utf8"));
  if (
    !isDeepStrictEqual(
      decodeImportedResearchMaterials([persisted])[0],
      decodeImportedResearchMaterials([material])[0],
    )
  )
    throw new Error("解析副本与已登记版本不一致，停止采用并保留原文件。");
  const sourceId = `SRC-${randomUUID()}`;
  let text = "",
    csv: string | undefined,
    rows: { outputRow: number; original: string; cells: string[] }[] | undefined;
  if (declaration.category === "data") {
    const candidates = material.tables.filter(
      (table) => !declaration.tableName || table.name === declaration.tableName,
    );
    if (candidates.length !== 1)
      throw new Error("请选择一个确切的工作表，不能静默合并或选择多个工作表。");
    const table = candidates[0]!;
    if (table.errors.length)
      throw new Error(
        `此表仍有错误行或字段，不能进入分析：${table.errors.map((error) => `${error.row}: ${error.reason}`).join("；")}`,
      );
    const formulas = material.locations.filter(
      (location) => location.sheet === table.name && location.formula !== undefined,
    );
    if (formulas.length) {
      required(declaration.formulaValueBasis, "公式缓存取值核实依据");
      if (formulas.some((location) => !location.text.trim()))
        throw new Error(
          "所选表含缺少缓存结果的公式，必须先补齐并重新导入；不会将未知公式结果当作缺失观察值。",
        );
    }
    const selectedRows = table.rows.slice(table.headerRow - 1);
    csv = selectedRows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
    if (Buffer.byteLength(csv) > 10_000_000)
      throw new Error("工作数据超过 10 MB 分析上限，请明确缩小数据范围后重新导入。");
    rows = selectedRows.map((cells, index) => ({
      outputRow: index + 1,
      original: table.rowLocations[index + table.headerRow - 1]!,
      cells,
    }));
    text = `# 数据来源与使用声明\n\n${sourceDescription}\n\n材料：${material.name}\n原件 SHA256：${material.sha256}\n工作表：${table.name}\n表头原行：${table.rowLocations[table.headerRow - 1]}\n材料类别（用户声明）：${declaration.dataKind}\n用途许可（用户声明）：${declaration.permission}\n字段：${table.headers.join("、")}\n保留观察行：${selectedRows.length - 1}\n${declaration.formulaValueBasis ? `公式取值依据（用户声明）：${declaration.formulaValueBasis}\n` : ""}\n这些是来源及使用声明，不构成独立伦理审批或数据真实性核验。`;
  } else {
    const selected = declaration.locators
      ? material.locations.filter((location) => declaration.locators!.includes(location.locator))
      : material.locations;
    if (
      declaration.locators &&
      (new Set(declaration.locators).size !== declaration.locators.length ||
        selected.length !== declaration.locators.length)
    )
      throw new Error("所选原文定位重复或已失效。");
    if (!selected.some((location) => location.text.trim()))
      throw new Error("所选范围没有可用正文。");
    text = `# ${declaration.title || material.metadata.title || material.name}\n\n来源及提供说明：${sourceDescription}\n提取版本：${material.parserVersion}\n原件 SHA256：${material.sha256}\n实际提取范围：${selected.map((location) => location.locator).join("、")}\n${material.warnings.length ? `未核验范围与注意事项：${material.warnings.join("；")}\n` : ""}\n${selected.map((location) => `【${location.locator}】\n${location.text}`).join("\n\n")}`;
  }
  if (Buffer.byteLength(text) > 300_000)
    throw new Error(
      "工作原文超过当前单来源 300 KB 读取上限，请明确选择必要定位范围；不会自动截断正文。",
    );
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory),
    requested = join(root, `adoption-${randomUUID()}`);
  await mkdir(requested);
  const target = await realpath(requested),
    part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("采用目录不能越界。");
  const file = join(target, "source.txt");
  await write(file, text);
  const source: ResearchSource = {
    id: sourceId,
    materialImportId: material.id,
    title: declaration.title?.trim() || material.metadata.title?.trim() || material.name,
    authors:
      declaration.authors?.trim() || material.metadata.authors?.trim() || "未知作者（未提供）",
    year: declaration.year?.trim() || material.metadata.year?.trim() || "未知年份（未提供）",
    url:
      declaration.url?.trim() || material.metadata.url?.trim() || "本地用户提供（来源说明见正文）",
    file,
    sha256: digest(text),
    kind: declaration.category === "data" ? "dataset" : declaration.category,
    access: "provided-text",
    textScope: declaration.textScope ?? "partial-text",
  };
  const provenanceFile = join(target, "provenance.json");
  const result: AdoptedResearchMaterial = { source, provenanceFile };
  if (csv !== undefined && rows) {
    const dataFile = join(target, "working.csv"),
      rowMapFile = join(target, "row-map.json");
    await write(dataFile, csv);
    await write(
      rowMapFile,
      JSON.stringify(
        {
          originalSha256: material.sha256,
          importId: material.id,
          table: declaration.tableName ?? material.tables[0]?.name,
          outputSha256: digest(csv),
          rows,
        },
        null,
        2,
      ),
    );
    result.dataset = {
      id: `DATA-${randomUUID()}`,
      materialImportId: material.id,
      file: dataFile,
      sha256: digest(csv),
      description: sourceDescription,
      sourceId,
      dataKind: declaration.dataKind!,
      permission: declaration.permission!,
      delimiter: ",",
    };
    result.rowMapFile = rowMapFile;
  }
  await write(
    provenanceFile,
    JSON.stringify(
      {
        importId: material.id,
        originalSha256: material.sha256,
        original: material.original,
        parsed: material.parsed,
        parserVersion: material.parserVersion,
        declaration,
        declarationIdentity: "user-declaration-not-independent-verification",
        createdAt: new Date().toISOString(),
        source,
        dataset: result.dataset,
        rowMapFile: result.rowMapFile,
        warnings: material.warnings,
      },
      null,
      2,
    ),
  );
  return result;
}
