import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rename,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RESEARCH_ROLES, type ResearchRole } from "../../contracts/research-group";
import { decodeResearchSourcePageRecords } from "../../contracts/research-source-pages";
import {
  importResearchMaterials,
  recoverImportedResearchMaterial,
} from "../../electron/research-group/material-import";
import { adoptImportedResearchMaterial } from "../../electron/research-group/material-adoption";
import {
  bindFusionNativeRun,
  dispatchFusionAttempt,
  prepareFusionDelivery,
} from "../../electron/research-group/fusion-task-runtime";
import {
  applySourcePageTool,
  validateSourcePageProject,
  type SourcePageProject,
} from "../../electron/research-group/source-page-tools";
import { researchGroupToolResult } from "../../electron/research-group/runtime-extension";
import { researchPdfFixture } from "../helpers/research-material-fixture";

const at = (n: number) => new Date(Date.UTC(2026, 10, 8, 1, 0, n)).toISOString();
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Two actual synthetic PDF pages with text and distinct graphics, not research evidence. */
function pdfFixture(options: { hugeSecondPage?: boolean } = {}) {
  const stream1 = "1 0 0 rg 30 30 80 60 re f BT /F1 14 Tf 30 140 Td (Synthetic red page one) Tj ET",
    stream2 = "0 0 1 rg 150 30 80 60 re f BT /F1 14 Tf 30 140 Td (Synthetic blue page two) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${options.hugeSecondPage ? 100001 : 300} 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream1.length} >>\nstream\n${stream1}\nendstream`,
    `<< /Length ${stream2.length} >>\nstream\n${stream2}\nendstream`,
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
async function fixture(options: { scan?: boolean; hugeSecondPage?: boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "lancer-source-pages-")),
    id = randomUUID(),
    projectRoot = join(workspace, ".lancer", "research-groups", id),
    input = join(workspace, "synthetic.pdf");
  await writeFile(input, options.scan ? researchPdfFixture() : pdfFixture(options));
  const [imported] = await importResearchMaterials(join(projectRoot, "materials"), [
    { file: input },
  ]);
  if (!imported?.ok) throw new Error("Fixture PDF import failed");
  let material = imported.material;
  // A scan's user-supplied locating text is explicitly partial; it does not establish OCR or visual review.
  if (options.scan)
    material = await recoverImportedResearchMaterial(join(projectRoot, "materials"), material, {
      kind: "supplement",
      locator: "page:1",
      text: "Synthetic user locating text only",
      description: "合成扫描件定位补充，未核验图形",
    });
  await mkdir(join(projectRoot, "adopted-materials"), { recursive: true });
  const adopted = await adoptImportedResearchMaterial(
    join(projectRoot, "adopted-materials"),
    material,
    {
      category: "paper",
      sourceDescription: "合成软件单元材料，仅证明图像通道，不能作为论文内容核验。",
      textScope: "partial-text",
    },
  );
  const p: SourcePageProject = {
    id,
    root: { workspaceId: workspace, sessionId: `${id}-mentor` },
    workspacePath: workspace,
    objective: "合成原页工具单元",
    revision: 1,
    status: "running",
    createdAt: at(0),
    updatedAt: at(0),
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "design",
    scope: "proposal",
    path: "quantitative",
    currentStage: "design",
    knowledge: { directory: workspace, sha256: "a".repeat(64), version: "synthetic", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: `${id}-${role}` },
      status: "idle",
    })),
    stages: [
      {
        id: "design",
        title: "合成方案",
        goal: "合成软件验证",
        deliverables: "局部原页验证",
        models: Object.fromEntries(
          RESEARCH_ROLES.map((role) => [
            role,
            { provider: "synthetic", modelId: `synthetic-${role}` },
          ]),
        ),
      },
    ],
    artifacts: [],
    packets: [],
    events: [],
    importedMaterials: [material],
    evidence: { directory: "", sources: [adopted.source], datasets: [] },
  };
  for (const role of ["lead", "reviewer"] as const) {
    const delivery = prepareFusionDelivery(
      p,
      role,
      `${id}-${role}-attempt`,
      at(1),
      "合成 native 身份，不是真实提供商证明",
    );
    expect(delivery.kind).toBe("dispatch");
    dispatchFusionAttempt(p, delivery.attemptId!, at(1));
    bindFusionNativeRun(p, role, `${id}-${role}-native`);
  }
  let serial = 10;
  const tool = (
    role: ResearchRole,
    request: Record<string, unknown>,
    callId = `call-${++serial}`,
  ) =>
    applySourcePageTool(p, role, callId, { sourceId: adopted.source.id, ...request }, at(++serial));
  return { workspace, projectRoot, p, material, adopted, tool, input };
}
function records(p: SourcePageProject) {
  return { sourcePageReceipts: p.sourcePageReceipts, sourcePageReadings: p.sourcePageReadings };
}
async function pixel(bytes: Buffer, x: number, y: number) {
  // Decode the actual PNG independently from the PDF.js render call.
  const require = createRequire(__filename),
    root = dirname(require.resolve("pdfjs-dist/package.json"));
  const canvas = require(require.resolve("@napi-rs/canvas", { paths: [root] })) as {
    loadImage(bytes: Buffer): Promise<unknown>;
    createCanvas(
      w: number,
      h: number,
    ): {
      getContext(kind: "2d"): {
        drawImage(image: unknown, x: number, y: number): void;
        getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
      };
    };
  };
  const image = await canvas.loadImage(bytes),
    surface = canvas.createCanvas(bytes.readUInt32BE(16), bytes.readUInt32BE(20)),
    context = surface.getContext("2d");
  context.drawImage(image, 0, 0);
  return [...context.getImageData(x, y, 1, 1).data];
}

test("renders only an explicit actual PDF page into nonempty PNG; caches fixed bytes without changing originals", async ({}, testInfo) => {
  const s = await fixture(),
    original = await readFile(s.material.original),
    parsed = await readFile(s.material.parsed);
  const index = await s.tool("lead", { operation: "source-pages" });
  expect(index.result).toMatchObject({
    ok: true,
    pageCount: 2,
    extractedPageLocators: ["page:1", "page:2"],
  });
  expect(await stat(join(s.projectRoot, "source-pages")).catch(() => undefined)).toBeUndefined();
  const result = await s.tool("lead", { operation: "source-read-page", page: 2 }, "read-blue");
  expect(result.result).toMatchObject({
    ok: true,
    cacheReused: false,
    receipt: {
      page: 2,
      locator: "page:2",
      pageCount: 2,
      width: 600,
      height: 400,
      role: "lead",
      mimeType: "image/png",
    },
  });
  const bytes = Buffer.from(result.media!.data, "base64"),
    receipt = s.p.sourcePageReceipts![0]!;
  expect(bytes.length).toBeGreaterThan(500);
  expect(hash(bytes)).toBe(receipt.imageSha256);
  expect(await pixel(bytes, 340, 280)).toEqual([0, 0, 255, 255]);
  expect(await pixel(bytes, 80, 280)).toEqual([255, 255, 255, 255]);
  const cache = join(s.projectRoot, "source-pages"),
    image = join(cache, receipt.cacheKey, "page.png"),
    before = await stat(image);
  expect(await readdir(cache)).toEqual([receipt.cacheKey]);
  const replay = await s.tool("lead", { operation: "source-read-page", page: 2 }, "read-blue");
  expect(replay.result).toMatchObject({ ok: true, cacheReused: true });
  expect(replay.media).toEqual(result.media);
  expect(s.p.sourcePageReceipts).toHaveLength(1);
  expect((await stat(image)).mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(s.material.original)).toEqual(original);
  expect(await readFile(s.material.parsed)).toEqual(parsed);
  expect(s.p.sourcePageReadings).toBeUndefined();
  expect(JSON.stringify(records(s.p))).not.toContain(result.media!.data);
  expect(JSON.stringify(records(s.p))).not.toContain('"media"');
  const piResult = researchGroupToolResult("source-read-page", {
    result: result.result,
    media: result.media,
  });
  expect(piResult.content).toHaveLength(2);
  expect(piResult.content[1]).toEqual(result.media);
  expect(JSON.stringify(piResult.details)).not.toContain(result.media!.data);
  expect(JSON.stringify(piResult.content.filter((part) => part.type === "text"))).not.toContain(
    result.media!.data,
  );
  await writeFile(testInfo.outputPath("synthetic-blue-page-2.png"), bytes, { flag: "wx" });
  await writeFile(
    testInfo.outputPath("retained-fixture.json"),
    JSON.stringify(
      {
        workspace: s.workspace,
        original: s.material.original,
        parsed: s.material.parsed,
        cacheImage: image,
        receipt,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  await testInfo.attach("synthetic-blue-page-2", { body: bytes, contentType: "image/png" });
  await testInfo.attach("retained-source-page-fixture", {
    body: JSON.stringify({
      workspace: s.workspace,
      original: s.material.original,
      cacheImage: image,
      sha256: receipt.originalSha256,
    }),
    contentType: "application/json",
  });
});

test("each role and actual native execution needs its own receipt before a separate model observation", async () => {
  const s = await fixture();
  await s.tool("lead", { operation: "source-read-page", page: 1 }, "lead-red");
  const lead = s.p.sourcePageReceipts![0]!;
  const observation = {
    operation: "source-page-reading",
    receiptId: lead.id,
    observations: "合成图中左下方红色矩形，图像事实只用于软件验证。",
    remainingLimitations: ["尚无真实论文内容 C 评阅。"],
  };
  await expect(s.tool("reviewer", observation)).rejects.toThrow("本人当前实际");
  await s.tool("lead", observation, "lead-observation");
  await s.tool("lead", observation, "lead-observation");
  expect(s.p.sourcePageReadings).toHaveLength(1);
  await s.tool("reviewer", { operation: "source-read-page", page: 1 }, "reviewer-red");
  const reviewer = s.p.sourcePageReceipts!.at(-1)!;
  expect(reviewer.imageSha256).toBe(lead.imageSha256);
  expect(reviewer.nativeRunId).not.toBe(lead.nativeRunId);
  await s.tool("reviewer", { ...observation, receiptId: reviewer.id }, "reviewer-observation");
  expect(s.p.sourcePageReadings).toHaveLength(2);
  const broken = structuredClone(records(s.p));
  broken.sourcePageReadings![1]!.receiptId = lead.id;
  expect(() => decodeResearchSourcePageRecords(broken)).toThrow("本人同一实际执行");
  const member = s.p.members.find((member) => member.role === "reviewer")!;
  member.ref = { ...member.ref, sessionId: "changed-session" };
  await expect(s.tool("reviewer", { ...observation, receiptId: reviewer.id })).rejects.toThrow(
    "本人当前实际",
  );
});

test("unadopted, wrong-kind, foreign-project and arbitrary path or page inputs cannot provide an image", async () => {
  const s = await fixture();
  for (const page of [0, -1, 1.5, "1", "../../private.pdf", 1001])
    await expect(s.tool("lead", { operation: "source-read-page", page })).rejects.toThrow(
      "物理页码",
    );
  await expect(
    s.tool("lead", { operation: "source-read-page", page: 1, path: s.input }),
  ).rejects.toThrow("未知字段");
  await expect(
    s.tool("lead", { operation: "source-read-page", page: 1, sourceId: "unknown" }),
  ).rejects.toThrow("已明确采用");
  const missing = await s.tool("lead", { operation: "source-read-page", page: 3 });
  expect(missing.media).toBeUndefined();
  expect(missing.result).toMatchObject({
    ok: false,
    page: 3,
    limitation: { scope: "requested-page", message: expect.stringContaining("不存在") },
  });
  const piFailure = researchGroupToolResult("source-read-page", missing.result);
  expect(piFailure.content).toHaveLength(1);
  expect(piFailure.content[0]!.type).toBe("text");
  expect(piFailure.details).toMatchObject({ ok: false, limitation: { scope: "requested-page" } });
  expect(s.p.sourcePageReceipts).toBeUndefined();
  s.adopted.source.kind = "method";
  await expect(s.tool("lead", { operation: "source-read-page", page: 1 })).rejects.toThrow(
    "已明确采用",
  );
  s.adopted.source.kind = "paper";
  const foreign = await fixture();
  s.p.evidence!.sources = [foreign.adopted.source];
  await expect(
    s.tool("lead", { operation: "source-read-page", page: 1, sourceId: foreign.adopted.source.id }),
  ).rejects.toThrow("本项目 PDF 导入原件");
  s.p.importedMaterials = [foreign.material];
  await expect(
    s.tool("lead", { operation: "source-read-page", page: 1, sourceId: foreign.adopted.source.id }),
  ).rejects.toThrow();
  expect(s.p.sourcePageReceipts).toBeUndefined();
});

test("changed originals, parses, adoption declarations and symlink escapes are rejected without altering evidence", async () => {
  const s = await fixture(),
    original = await readFile(s.material.original),
    parsed = await readFile(s.material.parsed),
    provenance = await readFile(s.adopted.provenanceFile);
  await writeFile(s.material.original, Buffer.concat([original, Buffer.from("changed")]));
  await expect(s.tool("lead", { operation: "source-read-page", page: 1 })).rejects.toThrow(
    "SHA 或字节数",
  );
  await writeFile(s.material.original, original);
  await writeFile(
    s.material.parsed,
    parsed.toString("utf8").replace("Synthetic red", "Altered red"),
  );
  await expect(s.tool("lead", { operation: "source-read-page", page: 1 })).rejects.toThrow(
    "解析副本",
  );
  await writeFile(s.material.parsed, parsed);
  await writeFile(
    s.adopted.provenanceFile,
    provenance.toString("utf8").replace('"category": "paper"', '"category": "method"'),
  );
  await expect(s.tool("lead", { operation: "source-read-page", page: 1 })).rejects.toThrow(
    "采用凭据",
  );
  await writeFile(s.adopted.provenanceFile, provenance);
  await rename(s.material.original, `${s.material.original}.retained`);
  await symlink(`${s.material.original}.retained`, s.material.original);
  await expect(s.tool("lead", { operation: "source-read-page", page: 1 })).rejects.toThrow(
    "链接越界",
  );
  expect(s.p.sourcePageReceipts).toBeUndefined();
  expect(await readFile(`${s.material.original}.retained`)).toEqual(original);
});

test("partial scan keeps text and OCR limits; rendering failure is local and leaves other pages and successful receipts usable", async () => {
  const scan = await fixture({ scan: true });
  const scanResult = await scan.tool("lead", { operation: "source-read-page", page: 1 });
  expect(scanResult.result).toMatchObject({
    ok: true,
    receipt: { page: 1, limitations: expect.arrayContaining([expect.stringContaining("OCR")]) },
  });
  expect(scan.material.status).toBe("partial");
  expect(scan.p.sourcePageReadings).toBeUndefined();
  const s = await fixture({ hugeSecondPage: true });
  await s.tool("lead", { operation: "source-read-page", page: 1 });
  const before = JSON.stringify(records(s.p)),
    result = await s.tool("lead", { operation: "source-read-page", page: 2 });
  expect(result.media).toBeUndefined();
  expect(result.result).toMatchObject({
    ok: false,
    page: 2,
    limitation: { scope: "requested-page", message: expect.stringContaining("尺寸不受支持") },
  });
  expect(await pixel(Buffer.from(scanResult.media!.data, "base64"), 100, 200)).toEqual([
    255, 0, 0, 255,
  ]);
  expect(JSON.stringify(records(s.p))).toBe(before);
  expect((await s.tool("lead", { operation: "source-read-page", page: 1 })).result).toMatchObject({
    ok: true,
    cacheReused: true,
  });
});

test("cache corruption is retained and cannot turn into visual proof; persisted contracts reject injected bytes", async () => {
  const s = await fixture();
  const result = await s.tool("lead", { operation: "source-read-page", page: 1 });
  const receipt = s.p.sourcePageReceipts![0]!,
    cache = join(s.projectRoot, "source-pages", receipt.cacheKey),
    image = join(cache, "page.png");
  const corrupt = Buffer.from(result.media!.data, "base64");
  corrupt[50] = corrupt[50]! ^ 0xff;
  await writeFile(image, corrupt);
  const failed = await s.tool("lead", { operation: "source-read-page", page: 1 });
  expect(failed.media).toBeUndefined();
  expect(failed.result).toMatchObject({
    ok: false,
    limitation: { message: expect.stringContaining("SHA 已变化") },
  });
  expect(s.p.sourcePageReceipts).toHaveLength(1);
  expect(await readFile(image)).toEqual(corrupt);
  const forged = structuredClone(records(s.p));
  Object.assign(forged.sourcePageReceipts![0]!, { data: result.media!.data });
  expect(() => decodeResearchSourcePageRecords(forged)).toThrow("未知字段");
  const stale = s.p.fusion!.tasks.find((task) => task.role === "lead")!;
  stale.inputVersion++;
  await expect(s.tool("lead", { operation: "source-read-page", page: 1 })).rejects.toThrow(
    "当前输入版本",
  );
});

test("strict project validation pins source, native identity and historical task version without accepting foreign records", async () => {
  const s = await fixture();
  await s.tool("lead", { operation: "source-read-page", page: 1 }, "audit-read");
  const receipt = s.p.sourcePageReceipts![0]!;
  await s.tool(
    "lead",
    {
      operation: "source-page-reading",
      receiptId: receipt.id,
      observations: "合成原页左下矩形观察；软件契约单元，不是独立学术核验。",
      remainingLimitations: ["仅合成测试图形"],
    },
    "audit-observe",
  );
  expect(() => validateSourcePageProject(s.p)).not.toThrow();
  for (const change of [
    { projectId: "foreign-project" },
    { nativeRunId: "foreign-native" },
    { sessionId: "foreign-session" },
    { originalSha256: "0".repeat(64) },
    { sourceSha256: "0".repeat(64) },
    { cacheKey: "0".repeat(64) },
  ]) {
    const corrupt = structuredClone(s.p);
    Object.assign(corrupt.sourcePageReceipts![0]!, change);
    expect(() => validateSourcePageProject(corrupt)).toThrow();
  }
  const historical = structuredClone(s.p);
  historical.fusion!.tasks.find((task) => task.id === receipt.taskId)!.inputVersion++;
  expect(() => validateSourcePageProject(historical)).not.toThrow();
  await expect(
    applySourcePageTool(
      historical,
      "lead",
      "new-observe",
      {
        operation: "source-page-reading",
        sourceId: s.adopted.source.id,
        receiptId: receipt.id,
        observations: "不得借用过期输入的图像凭据",
        remainingLimitations: [],
      },
      at(55),
    ),
  ).rejects.toThrow("当前输入版本");
});

test("a project revision changed while async bytes are loading cannot receive a success receipt", async () => {
  const s = await fixture(),
    pending = s.tool("lead", { operation: "source-read-page", page: 1 });
  s.p.revision++;
  await expect(pending).rejects.toThrow("当前输入版本");
  expect(s.p.sourcePageReceipts).toBeUndefined();
  expect(s.p.sourcePageReadings).toBeUndefined();
});
