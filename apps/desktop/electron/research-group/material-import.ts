import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const MAX_FILE = 40_000_000;
const MAX_TEXT = 8_000_000;
const PARSER_VERSION = "lancer-materials/2";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export type {
  MaterialLocation,
  MaterialTablePreview,
  MaterialMetadata,
  MaterialImportRequest,
  ImportedResearchMaterial,
  MaterialImportResult,
} from "../../contracts/research-materials";
import type {
  MaterialTablePreview,
  MaterialImportRequest,
  ImportedResearchMaterial,
  MaterialImportResult,
  MaterialParseOptions,
  MaterialRecoveryRequest,
  MaterialRecoveryRecord,
} from "../../contracts/research-materials";
import {
  decodeImportedResearchMaterials,
  decodeMaterialRecoveryRequest,
  decodeMaterialParseOptions,
} from "../../contracts/research-materials";

function decodeText(
  bytes: Uint8Array,
  selectedEncoding?: MaterialParseOptions["encoding"],
): string {
  const explicit = selectedEncoding === "auto" ? undefined : selectedEncoding;
  let encoding = explicit ?? "utf-8";
  if (!explicit && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  if (!explicit && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  const value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (value.includes("\0"))
    throw new Error("文本含空字节；请确认编码后补入 UTF-8 文本，原件已保留。");
  if (value.length > MAX_TEXT) throw new Error("提取文本超过 800 万字符上限。");
  return value;
}

type XmlNode = {
  tag: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};
function xml(bytes: Uint8Array): XmlNode[] {
  const input = decodeText(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new Error("不接受包含外部实体或 DTD 的文档。");
  const validation = XMLValidator.validate(input);
  if (validation !== true) throw new Error(`文档 XML 无效：${validation.err.msg}`);
  const raw: unknown = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    processEntities: true,
    parseTagValue: false,
    trimValues: false,
  }).parse(input);
  const convert = (items: unknown): XmlNode[] => {
    if (!Array.isArray(items)) return [];
    return items.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      const attrs = row[":@"];
      const attributes: Record<string, string> = {};
      if (attrs && typeof attrs === "object")
        for (const [key, value] of Object.entries(attrs))
          attributes[key.replace(/^@_/, "")] = String(value);
      return Object.entries(row)
        .filter(([key]) => key !== ":@")
        .map(([tag, value]) => ({
          tag,
          attributes,
          children: convert(value),
          text: tag === "#text" ? String(value) : "",
        }));
    });
  };
  return convert(raw);
}
function descendants(nodes: XmlNode[], tag: string): XmlNode[] {
  return nodes.flatMap((node) => [
    ...(node.tag === tag ? [node] : []),
    ...descendants(node.children, tag),
  ]);
}
function content(node: XmlNode): string {
  if (["w:tab", "w:br"].includes(node.tag)) return node.tag === "w:tab" ? "\t" : "\n";
  return node.text + node.children.map(content).join("");
}
function archive(bytes: Uint8Array): Record<string, Uint8Array> {
  let expanded = 0;
  return unzipSync(bytes, {
    filter: (entry) => {
      expanded += entry.originalSize;
      if (entry.originalSize > MAX_TEXT || expanded > MAX_FILE * 2)
        throw new Error("文档展开大小超过安全上限。");
      if (entry.name.startsWith("/") || entry.name.split("/").includes(".."))
        throw new Error("文档包含越界路径。");
      return entry.name.endsWith(".xml") || entry.name.endsWith(".rels");
    },
  });
}
function required(entries: Record<string, Uint8Array>, name: string): Uint8Array {
  const value = entries[name];
  if (!value) throw new Error(`文档缺少 ${name}。`);
  return value;
}
function table(
  name: string,
  rows: string[][],
  rowLocations: string[],
  headerRow: number,
): MaterialTablePreview {
  if (!Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > rows.length)
    throw new Error("表头行不存在，请选择实际表头行。");
  if (rows.length > 100_000 || rows.some((row) => row.length > 16384))
    throw new Error("表格超过 10 万行或 16384 列导入上限。");
  const headers = rows[headerRow - 1]!;
  const errors: MaterialTablePreview["errors"] = [];
  if (headers.some((value) => !value.trim()) || new Set(headers).size !== headers.length)
    errors.push({ row: headerRow, reason: "字段名为空或重复，请指定并核实表头。" });
  rows.slice(headerRow).forEach((row, index) => {
    if (row.length !== headers.length)
      errors.push({
        row: headerRow + index + 1,
        reason: `此行有 ${row.length} 个字段，表头有 ${headers.length} 个；未丢弃此行。`,
      });
  });
  const columns = headers.map((name, column) => {
    const values = rows.slice(headerRow).map((row) => row[column] ?? "");
    const nonempty = values.filter((value) => value.trim());
    const numbers = nonempty.filter((value) => Number.isFinite(Number(value))).length;
    const type: MaterialTablePreview["columns"][number]["type"] = !nonempty.length
      ? "empty"
      : numbers === nonempty.length
        ? "number"
        : numbers === 0
          ? "text"
          : "mixed";
    return { name, type, missing: values.length - nonempty.length };
  });
  return { name, headerRow, headers, rows, rowLocations, columns, errors };
}
function delimited(input: string, delimiter: string): { rows: string[][]; lines: number[] } {
  const rows: string[][] = [],
    lines: number[] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  const endField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else {
        field += char;
        if (char === "\r" || (char === "\n" && input[i - 1] !== "\r")) line++;
      }
    } else if (char === delimiter) endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      endField();
      rows.push(row);
      lines.push(start);
      row = [];
      line++;
      start = line;
    } else if (char === '"' && field === "" && !closed) quoted = true;
    else if (closed || char === '"')
      throw new Error(`第 ${line} 行引号位置无效，未修正或丢弃原始行。`);
    else field += char;
  }
  if (quoted) throw new Error(`第 ${start} 行引号未闭合，未修正或丢弃原始行。`);
  if (field || row.length || closed) {
    endField();
    rows.push(row);
    lines.push(start);
  }
  return { rows, lines };
}
export { delimited as parseResearchDelimitedText };
function parseDocx(bytes: Uint8Array, result: ImportedResearchMaterial): void {
  const entries = archive(bytes),
    nodes = xml(required(entries, "word/document.xml"));
  const body = descendants(nodes, "w:body")[0];
  if (!body) throw new Error("DOCX 缺少正文。");
  let paragraph = 0,
    tableIndex = 0;
  for (const node of body.children) {
    if (node.tag === "w:p")
      result.locations.push({
        kind: "paragraph",
        locator: `paragraph:${++paragraph}`,
        text: content(node),
      });
    if (node.tag === "w:tbl") {
      tableIndex++;
      const rows = descendants(node.children, "w:tr").map((row, r) =>
        row.children
          .filter((cell) => cell.tag === "w:tc")
          .map((cell, c) => {
            const text = descendants(cell.children, "w:p").map(content).join("\n");
            result.locations.push({
              kind: "table-cell",
              locator: `table:${tableIndex}/row:${r + 1}/cell:${c + 1}`,
              text,
            });
            return text;
          }),
      );
      if (rows.length)
        result.tables.push(
          table(
            `表 ${tableIndex}`,
            rows,
            rows.map((_, i) => `table:${tableIndex}/row:${i + 1}`),
            1,
          ),
        );
    }
  }
  const unsupported = ["w:drawing", "w:object", "m:oMath", "w:del", "w:ins"].filter(
    (tag) => descendants(nodes, tag).length,
  );
  if (unsupported.length)
    result.warnings.push(
      `以下对象需要原件核对：${unsupported.join("、")}；文本提取不代表图像、公式或修订已核验。`,
    );
  if (Object.keys(entries).some((key) => /^word\/(footnotes|endnotes|header|footer)/.test(key)))
    result.warnings.push("脚注、尾注、页眉或页脚不在正文提取范围，请打开原件核对。");
}
function parseXlsx(
  bytes: Uint8Array,
  request: MaterialImportRequest,
  result: ImportedResearchMaterial,
): void {
  const entries = archive(bytes);
  const workbook = xml(required(entries, "xl/workbook.xml"));
  const rels = descendants(xml(required(entries, "xl/_rels/workbook.xml.rels")), "Relationship");
  const shared = entries["xl/sharedStrings.xml"]
    ? descendants(xml(entries["xl/sharedStrings.xml"]), "si").map(content)
    : [];
  const sheets = descendants(workbook, "sheet");
  if (request.sheet && !sheets.some((sheet) => sheet.attributes.name === request.sheet))
    throw new Error("所选工作表不存在。");
  for (const sheet of sheets) {
    const name = sheet.attributes.name ?? "未知工作表";
    if (request.sheet && request.sheet !== name) continue;
    const rel = rels.find((item) => item.attributes.Id === sheet.attributes["r:id"]);
    const target = rel?.attributes.Target;
    if (!target || rel?.attributes.TargetMode === "External" || target.split("/").includes(".."))
      throw new Error("工作表关系缺失或指向外部位置。");
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const nodes = xml(required(entries, path));
    const rows: string[][] = [],
      locators: string[] = [];
    for (const row of descendants(nodes, "row")) {
      const values: string[] = [];
      for (const cell of row.children.filter((node) => node.tag === "c")) {
        const ref = cell.attributes.r ?? "";
        if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(ref)) throw new Error("工作表单元格定位无效。");
        const letters = ref.match(/^[A-Z]+/)![0];
        const col = [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        if (col > 16383) throw new Error("单元格列超出 XLSX 范围。");
        const raw = cell.children.find((node) => node.tag === "v");
        const value = raw ? content(raw) : "";
        if (
          cell.attributes.t === "s" &&
          (!/^\d+$/.test(value) || shared[Number(value)] === undefined)
        )
          throw new Error(`${name}!${ref} 的共享字符串索引失效，未把错误伪装为空值。`);
        const text =
          cell.attributes.t === "s"
            ? (shared[Number(value)] ?? "")
            : cell.attributes.t === "inlineStr"
              ? cell.children
                  .filter((n) => n.tag === "is")
                  .map(content)
                  .join("")
              : value;
        const formula = cell.children.find((node) => node.tag === "f");
        if (formula)
          result.warnings.push(
            `${name}!${ref} 为公式，${raw ? "缓存值未经重新计算" : "缺少缓存值"}，请核实取值依据。`,
          );
        if (cell.attributes.t === "e")
          result.warnings.push(`${name}!${ref} 存在工作表错误：${value}`);
        values[col] = text;
        result.locations.push({
          kind: "cell",
          locator: `${name}!${ref}`,
          sheet: name,
          text,
          ...(formula ? { formula: content(formula) } : {}),
        });
      }
      const rowNumber = Number(row.attributes.r);
      if (
        !Number.isSafeInteger(rowNumber) ||
        rowNumber < 1 ||
        rowNumber > 100_000 ||
        rows[rowNumber - 1]
      )
        throw new Error("工作表行号无效、重复或超过 10 万行导入上限。");
      rows[rowNumber - 1] = Array.from({ length: values.length }, (_, i) => values[i] ?? "");
    }
    if (rows.length) {
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
      if (width * rows.length > 1_000_000)
        throw new Error("工作表预览超过 100 万单元格上限，请缩小范围。");
      const completeRows = Array.from({ length: rows.length }, (_, r) => {
        locators.push(`${name}!${r + 1}`);
        return Array.from({ length: width }, (_, c) => rows[r]?.[c] ?? "");
      });
      result.tables.push(table(name, completeRows, locators, request.headerRow ?? 1));
    }
  }
  result.warnings.push(
    "XLSX 保留原始单元格值；日期、百分比等显示样式未转换，选择工作表及表头并核实取值后才能用于分析。",
  );
}
async function parsePdf(bytes: Uint8Array, result: ImportedResearchMaterial): Promise<void> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    useWorkerFetch: false,
  });
  const document = await loading.promise;
  try {
    if (document.numPages > 1000) throw new Error("PDF 超过 1000 页，请分批提供必要材料。");
    for (let page = 1; page <= document.numPages; page++) {
      try {
        const textContent = await (await document.getPage(page)).getTextContent();
        const text = textContent.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join("")
          .trim();
        result.locations.push({ kind: "page", locator: `page:${page}`, page, text });
        if (!text)
          result.warnings.push(`物理第 ${page} 页没有可提取文字，需要 OCR 或补入定位文本。`);
      } catch (error) {
        result.warnings.push(
          `物理第 ${page} 页提取失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    result.warnings.push("PDF 图表、公式与阅读顺序需对照原页核对，文字提取不代表视觉内容已核验。");
    if (!result.locations.some((location) => location.text.trim())) result.status = "needs-parsing";
  } finally {
    await loading.destroy();
  }
}

async function writeImmutable(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeDirectory(parent: string, child: string): Promise<string> {
  const target = join(parent, child);
  await mkdir(target, { recursive: true });
  const actual = await realpath(target),
    part = relative(parent, actual);
  if (!part || part.startsWith("..") || isAbsolute(part))
    throw new Error("材料存储目录不能通过链接越界。");
  return actual;
}
async function importOne(
  directory: string,
  request: MaterialImportRequest,
  context?: { name: string; recovery: MaterialRecoveryRecord },
): Promise<ImportedResearchMaterial> {
  const source = await realpath(request.file),
    info = await stat(source);
  if (!info.isFile() || info.size > MAX_FILE)
    throw new Error("请选择不超过 40 MB 的普通材料文件。");
  const bytes = await readFile(source);
  if (bytes.length > MAX_FILE) throw new Error("材料超过 40 MB 上限。");
  const sha256 = hash(bytes),
    extension = extname(context?.name ?? request.file).toLowerCase();
  const originals = await safeDirectory(directory, "originals"),
    parses = await safeDirectory(directory, "parses");
  const originalDirectory = await safeDirectory(originals, sha256);
  const savedName = (await readdir(originalDirectory)).find((name) =>
    /^original(?:\.[a-z0-9]{1,12})?$/.test(name),
  );
  const safeExtension = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
  const original = join(originalDirectory, savedName ?? `original${safeExtension}`);
  let duplicate = false;
  try {
    await writeImmutable(original, bytes);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if ((await realpath(original)) !== original || hash(await readFile(original)) !== sha256)
      throw new Error("已保存原件不匹配，停止导入并保留异常文件。");
    duplicate = true;
  }
  const id = randomUUID(),
    parsed = join(parses, `${sha256}-${id}.json`);
  const result: ImportedResearchMaterial = {
    id,
    name: context?.name ?? basename(request.file),
    sha256,
    bytes: bytes.length,
    importedAt: new Date().toISOString(),
    original,
    parsed,
    parserVersion: PARSER_VERSION,
    duplicate,
    metadata: { ...request.metadata },
    status: "ready",
    locations: [],
    tables: [],
    warnings: [],
    parseOptions: decodeMaterialParseOptions({
      ...(request.encoding ? { encoding: request.encoding } : {}),
      ...(request.delimiter ? { delimiter: request.delimiter } : {}),
      ...(request.sheet ? { sheet: request.sheet } : {}),
      ...(request.headerRow !== undefined ? { headerRow: request.headerRow } : {}),
    }),
    ...(context ? { recovery: context.recovery } : {}),
  };
  try {
    if ([".txt", ".md", ".markdown", ".json"].includes(extension))
      result.locations = decodeText(bytes, request.encoding)
        .split(/\r\n|\n|\r/)
        .map((text, i) => ({ kind: "line", locator: `line:${i + 1}`, text }));
    else if ([".csv", ".tsv"].includes(extension)) {
      const input = decodeText(bytes, request.encoding),
        delimiter = request.delimiter ?? (extension === ".tsv" ? "\t" : ",");
      const { rows, lines } = delimited(input, delimiter);
      result.tables = [
        table(
          result.name,
          rows,
          lines.map((line) => `line:${line}`),
          request.headerRow ?? 1,
        ),
      ];
      result.locations = rows.map((row, i) => ({
        kind: "line",
        locator: `line:${lines[i]}`,
        text: row.join(delimiter),
      }));
    } else if (extension === ".docx") parseDocx(bytes, result);
    else if (extension === ".xlsx") parseXlsx(bytes, request, result);
    else if (extension === ".pdf") await parsePdf(bytes, result);
    else {
      result.status = "needs-parsing";
      result.warnings.push("此格式需要 OCR 或可定位提取文本；原件已保存，尚不可作为已读正文。");
    }
    if (result.locations.reduce((sum, location) => sum + location.text.length, 0) > MAX_TEXT)
      throw new Error("提取文本超过 800 万字符上限。");
    if (
      result.status === "ready" &&
      (result.warnings.length || result.tables.some((preview) => preview.errors.length))
    )
      result.status = "partial";
    if (!result.locations.some((location) => location.text.trim())) result.status = "needs-parsing";
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  }
  await writeImmutable(parsed, JSON.stringify(result, null, 2));
  return result;
}

/** Main-process boundary: only pass paths chosen by the user, never arbitrary renderer paths. */
export async function importResearchMaterials(
  directory: string,
  requests: readonly MaterialImportRequest[],
): Promise<MaterialImportResult[]> {
  if (requests.length > 100) throw new Error("每批最多导入 100 份材料。");
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory),
    results: MaterialImportResult[] = [];
  for (const request of requests) {
    try {
      results.push({ ok: true, material: await importOne(root, request) });
    } catch (error) {
      results.push({
        ok: false,
        file: request.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** A recovery creates a new candidate; existing adopted evidence is never changed here. */
export async function recoverImportedResearchMaterial(
  directory: string,
  material: ImportedResearchMaterial,
  rawRecovery: MaterialRecoveryRequest,
  replacementFile?: string,
): Promise<ImportedResearchMaterial> {
  const recovery = decodeMaterialRecoveryRequest(rawRecovery);
  if (replacementFile && recovery.kind !== "replace")
    throw new Error("只有替换恢复可以选择新的文件。");
  const checked = decodeImportedResearchMaterials([material])[0]!;
  if (hash(await readFile(checked.original)) !== checked.sha256)
    throw new Error("保留原件已变化，停止恢复并保留历史。");
  const stored: unknown = JSON.parse(await readFile(checked.parsed, "utf8"));
  if (!isDeepStrictEqual(decodeImportedResearchMaterials([stored])[0], checked))
    throw new Error("解析记录已变化，不能以被修改的记录覆盖历史。");
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  if (recovery.kind !== "supplement") {
    if (recovery.kind === "replace" && !replacementFile)
      throw new Error("请选择修正后的材料文件；旧文件不会被覆盖。");
    const options =
      recovery.kind === "reparse"
        ? {
            ...checked.parseOptions,
            ...decodeMaterialParseOptions(
              Object.fromEntries(Object.entries(recovery).filter(([key]) => key !== "kind")),
            ),
          }
        : {};
    return importOne(
      root,
      { file: replacementFile ?? checked.original, metadata: checked.metadata, ...options },
      {
        name: recovery.kind === "replace" ? basename(replacementFile!) : checked.name,
        recovery: { kind: recovery.kind, fromImportId: checked.id },
      },
    );
  }
  if (/\.(?:csv|tsv|xlsx)$/i.test(checked.name))
    throw new Error("表格材料不能通过补入文本改写数据，请选择修正后的文件并重新检查。");
  const existing = checked.locations.find((location) => location.locator === recovery.locator);
  const image = /\.(?:png|jpe?g|webp|gif|tiff?|bmp)$/i.test(checked.name);
  if (!existing && !(image && recovery.locator === "page:1"))
    throw new Error(
      "补入文本必须绑定已存在的物理页或段落；单张图片使用 page:1。请先修复解析或提供真实定位。",
    );
  const location = existing ?? { kind: "page" as const, locator: "page:1", page: 1, text: "" };
  if (!["page", "paragraph", "line"].includes(location.kind))
    throw new Error("补入正文仅限页、段落或原文行；数据表修正请导入新文件，不能隐藏单元格更改。");
  const { error: _error, ...base } = checked;
  const id = randomUUID(),
    parses = await safeDirectory(root, "parses");
  const result: ImportedResearchMaterial = {
    ...base,
    id,
    parsed: join(parses, `${checked.sha256}-${id}.json`),
    importedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    duplicate: true,
    status: "partial",
    recovery: { fromImportId: checked.id, kind: "supplement", description: recovery.description },
    locations: existing
      ? checked.locations.map((item) =>
          item.locator === recovery.locator ? { ...item, text: recovery.text } : item,
        )
      : [{ ...location, text: recovery.text }],
    warnings: [
      ...checked.warnings,
      `用户补入提取文本（${recovery.locator}）：${recovery.description}。尚未自动核验原图、公式或原文支持关系。`,
    ],
  };
  decodeImportedResearchMaterials([result]);
  await writeImmutable(result.parsed, JSON.stringify(result, null, 2));
  return result;
}
