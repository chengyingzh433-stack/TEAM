import { zipSync, strToU8 } from "fflate";
import type { ResearchArtifact, ResearchProject } from "../../contracts/research-group";

const xml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const run = (text: string) => `<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
const paragraph = (text: string, style = "Normal") =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${run(text)}</w:p>`;

/** A local OOXML writer: editable text/tables, no external assets or runtime processes. */
export function createResearchDocx(
  project: ResearchProject,
  manuscript: ResearchArtifact,
  status: "review" | "accepted",
): Uint8Array {
  const sources = project.evidence?.sources ?? [];
  const cited: string[] = [];
  const calculations: string[] = [];
  const missing: string[] = [];
  const readable = (text: string) =>
    text
      .replace(/\[SRC:([A-Za-z0-9_-]+)\]/g, (_, id: string) => {
        if (!cited.includes(id)) cited.push(id);
        const source = sources.find((s) => s.id === id && manuscript.sourceIds?.includes(id));
        if (!source) {
          if (!missing.includes(id)) missing.push(id);
          return `[${cited.indexOf(id) + 1}，来源待核验]`;
        }
        return `（${source.authors}，${source.year}）`;
      })
      .replace(/\[ANALYSIS:([A-Za-z0-9_-]+)\]/g, (_, id: string) => {
        if (!calculations.includes(id)) calculations.push(id);
        return `（计算记录 ${calculations.indexOf(id) + 1}，见附录）`;
      });
  const blocks: string[] = [];
  const headings: { id: number; text: string; level: number }[] = [];
  const lines = manuscript.content.split(/\r?\n/);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const heading = !fenced && line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const id = headings.length + 1,
        text = readable(heading[2]!),
        level = heading[1]!.length;
      headings.push({ id, text, level });
      blocks.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:bookmarkStart w:id="${id}" w:name="section_${id}"/>${run(text)}<w:bookmarkEnd w:id="${id}"/></w:p>`,
      );
    } else if (
      !fenced &&
      line.trim().startsWith("|") &&
      /^\s*\|[\s|:\-]+\|\s*$/.test(lines[i + 1] ?? "")
    ) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const current = lines[i++]!;
        if (/^\s*\|[\s|:\-]+\|\s*$/.test(current)) continue;
        rows.push(
          current
            .trim()
            .replace(/^\||\|$/g, "")
            .split(/(?<!\\)\|/)
            .map((cell) => readable(cell.trim().replace(/\\\|/g, "|"))),
        );
      }
      i--;
      const count = Math.max(...rows.map((row) => row.length));
      blocks.push(
        `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((edge) => `<w:${edge} w:val="single" w:sz="4" w:color="B0B0B0"/>`).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: count }, () => `<w:gridCol w:w="${Math.floor(9000 / count)}"/>`).join("")}</w:tblGrid>${rows.map((row, index) => `<w:tr>${index === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: count }, (_, cell) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9000 / count)}" w:type="dxa"/></w:tcPr>${paragraph(row[cell] ?? "")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`,
      );
    } else blocks.push(paragraph(fenced ? line : readable(line)));
  }
  const label = status === "accepted" ? "本轮接受稿" : "审阅稿 · 待核验";
  const intro = [
    paragraph(label, "Title"),
    paragraph(`输入版本 ${project.revision}；稿件 ${manuscript.id}`),
    paragraph("模型审阅与本轮接受不代替作者核验、研究许可或发表审查。"),
  ];
  if (status === "review")
    intro.push(paragraph("本稿尚未作为本轮接受稿交付；正文、引用、计算及相关审阅仍须核对。"));
  if (missing.length)
    intro.push(
      paragraph(`尚缺项：${missing.length} 条正文引用未在本稿声明的来源中找到，详见附录。`),
    );
  const toc =
    paragraph("目录", "Title") +
    headings
      .map(
        (h) =>
          `<w:p><w:pPr><w:ind w:left="${(h.level - 1) * 240}"/></w:pPr><w:hyperlink w:anchor="section_${h.id}">${run(h.text)}</w:hyperlink></w:p>`,
      )
      .join("");
  const appendix = [paragraph("附录：来源与计算对应", "Heading1")];
  for (const id of cited) {
    const source = sources.find((s) => s.id === id && manuscript.sourceIds?.includes(id));
    appendix.push(
      paragraph(
        source
          ? `[${cited.indexOf(id) + 1}] ${source.authors} (${source.year}). ${source.title}. ${source.url}；内部来源编号：${id}`
          : `[${cited.indexOf(id) + 1}] 来源待核验；内部来源编号：${id}`,
      ),
    );
  }
  for (const id of calculations)
    appendix.push(
      paragraph(
        `计算记录 ${calculations.indexOf(id) + 1}：${id}；${manuscript.analysisIds?.includes(id) && project.analyses?.some((a) => a.id === id) ? "实际结果与复跑位置见同包研究溯源.json" : "本稿计算记录待核验"}`,
      ),
    );
  appendix.push(
    paragraph(
      "原始稿件及内部引用保持在同包 Markdown；材料、结果和审阅版本见研究溯源.json。本包不等于可搬移研究归档。",
    ),
  );
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const parts: Record<string, string> = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "word/document.xml": `<w:document ${ns}><w:body>${intro.join("")}${toc}${blocks.join("")}${appendix.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    "word/styles.xml": `<w:styles ${ns}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>${Array.from({ length: 6 }, (_, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:rFonts w:eastAsia="黑体"/><w:sz w:val="${32 - Math.min(i, 4) * 2}"/></w:rPr></w:style>`).join("")}</w:styles>`,
  };
  return zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([name, value]) => [name, strToU8(declaration + value)]),
    ),
  );
}
