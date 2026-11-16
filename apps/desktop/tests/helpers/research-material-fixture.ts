import { zipSync, strToU8 } from "fflate";

/** Synthetic single-page PDF bytes: actual text layer, or an embedded raster-only page.
 * Exercises the production parser without precomputed extraction results.
 */
export function researchPdfFixture(text?: string): Buffer {
  if (text !== undefined && /[^\x20-\x7E]/.test(text))
    throw new Error(
      "PDF fixture text must be ASCII; this fixture uses Helvetica without a Unicode font.",
    );
  const escaped = text?.replace(/[\\()]/g, "\\$&");
  const stream = text
    ? `BT /F1 14 Tf 40 120 Td (${escaped}) Tj ET`
    : "q 100 0 0 100 40 40 cm /Im1 Do Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> ${text ? "" : "/XObject << /Im1 6 0 R >>"} >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  if (!text)
    objects.push(
      "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream",
    );
  let result = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

export function researchOfficeFixture(entries: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])),
  );
}

export function researchDocxFixture(): Uint8Array {
  return researchOfficeFixture({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX 原文定位示例</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>说明</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>论证</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>需要原始证据</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>',
  });
}

export function researchXlsxFixture(): Uint8Array {
  return researchOfficeFixture({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="成绩" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>登记说明</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2" t="inlineStr"><is><t>y</t></is></c></row><row r="3"><c r="A3"><v>1</v></c><c r="B3"><f>A3*2</f><v>2</v></c></row><row r="4"><c r="A4"><v>2</v></c><c r="B4"><f>A4*2</f><v>4</v></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml":
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>用途</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>合成测试数据，不能用于实证研究</t></is></c></row></sheetData></worksheet>',
  });
}
