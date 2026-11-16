import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import {
  decodeImportedResearchMaterials,
  decodeMaterialAdoptionDeclaration,
} from "../../contracts/research-materials";
import {
  SOURCE_PAGE_OPERATIONS,
  decodeResearchSourcePageReceipt,
  decodeResearchSourcePageReading,
  decodeResearchSourcePageRecords,
  sourcePageObject,
  sourcePageText,
  type ResearchSourcePageReceipt,
  type ResearchSourcePageRecords,
} from "../../contracts/research-source-pages";
import { activeFusionAttempt } from "./fusion-task-runtime";

export { SOURCE_PAGE_OPERATIONS };
export type SourcePageProject = ResearchProject & ResearchSourcePageRecords;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const boundary =
  "仅返回指定物理页图像；图像字节返回、模型视觉观察及内容支持判断分别记录，不能据此称全文已读或原文支持已核验。";
const renderPolicy = "lancer-source-pages/1;scale2;side2400;pixels6000000;white;display";
const requirePdf = createRequire(__filename);

function current(p: SourcePageProject, role: ResearchRole) {
  const member = p.members.find((row) => row.role === role),
    attempt = activeFusionAttempt(p, role),
    task = p.fusion?.tasks.find((row) => row.id === attempt?.taskId);
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    !member ||
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !attempt.model ||
    p.fusion?.projectId !== p.id ||
    task.role !== role ||
    !task.id.startsWith(`v${p.revision}:`) ||
    task.inputVersion !== attempt.taskVersion ||
    [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].some(
      (ref) =>
        !p.fusion!.adoptedInputs.some(
          (input) => input.inputId === ref.inputId && input.version === ref.version,
        ),
    )
  )
    throw new Error("原页读取需要当前输入版本的实际 native 执行、本人会话与模型身份。");
  return { member, attempt, task };
}
function token(p: SourcePageProject, role: ResearchRole) {
  const owner = current(p, role);
  return hash(
    JSON.stringify({
      id: p.id,
      revision: p.revision,
      workspace: p.workspacePath,
      task: owner.task,
      attempt: owner.attempt,
      member: owner.member.ref,
      adoptedInputs: p.fusion!.adoptedInputs,
      sources: p.evidence?.sources,
      materials: p.importedMaterials,
    }),
  );
}
function ensureToken(p: SourcePageProject, role: ResearchRole, before: string) {
  if (token(p, role) !== before)
    throw new Error("读取期间任务、材料采用或实际身份已变化，请重新请求原页。");
}
function safePart(part: string) {
  if (!/^[A-Za-z0-9_.-]{1,251}$/.test(part) || part === "." || part === "..")
    throw new Error("原页存储身份或目录段无效。");
}
async function directory(base: string, parts: string[], create = false) {
  let root = await realpath(base);
  for (const part of parts) {
    safePart(part);
    root = join(root, part);
    if (create)
      await mkdir(root, { recursive: false }).catch((error: unknown) => {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST")
          throw error;
      });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("原页目录不能使用符号链接。");
  }
  return root;
}
async function fileWithin(root: string, requested: string, max = 40_000_000) {
  const part = relative(root, requested);
  if (!part || isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`))
    throw new Error("材料路径越出当前项目固定目录。");
  const parts = part.split(sep),
    name = parts.pop()!;
  safePart(name);
  const folder = await directory(root, parts),
    file = join(folder, name),
    info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max)
    throw new Error("原页文件不可读、过大或通过链接越界。");
  return { file, bytes: await readFile(file) };
}
async function verifiedSource(p: SourcePageProject, sourceId: unknown) {
  sourcePageText(sourceId);
  const source = p.evidence?.sources.find((row) => row.id === sourceId);
  if (!source || source.kind !== "paper" || !source.materialImportId)
    throw new Error("仅允许读取用户已明确采用为 paper/source 的本项目 PDF 原件。");
  const material = p.importedMaterials?.find((row) => row.id === source.materialImportId);
  if (!material || !/\.pdf$/i.test(material.name))
    throw new Error("已采用来源没有本项目 PDF 导入原件。");
  decodeImportedResearchMaterials([material]);
  const root = await directory(p.workspacePath, [".lancer", "research-groups", p.id]),
    materialRoot = await directory(root, ["materials"]),
    originalRoot = await directory(materialRoot, ["originals", material.sha256]),
    original = await fileWithin(originalRoot, material.original),
    parsedRoot = await directory(materialRoot, ["parses"]),
    parsed = await fileWithin(parsedRoot, material.parsed, 80_000_000);
  if (
    !/^original(?:\.[a-z0-9]{1,12})?$/.test(basename(original.file)) ||
    original.bytes.length !== material.bytes ||
    hash(original.bytes) !== material.sha256
  )
    throw new Error("PDF 导入原件 SHA 或字节数已变化，停止原页读取并保留原件。");
  const saved: unknown = JSON.parse(parsed.bytes.toString("utf8"));
  if (!isDeepStrictEqual(decodeImportedResearchMaterials([saved])[0], material))
    throw new Error("PDF 解析副本与已登记版本不一致。");
  const adoptedRoot = await directory(root, ["adopted-materials"]),
    adopted = await fileWithin(adoptedRoot, source.file, 25_000_000);
  if (basename(adopted.file) !== "source.txt" || hash(adopted.bytes) !== source.sha256)
    throw new Error("已采用来源文本版本已变化。");
  const provenance = await fileWithin(
      adoptedRoot,
      join(dirname(adopted.file), "provenance.json"),
      10_000_000,
    ),
    data: unknown = JSON.parse(provenance.bytes.toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("缺少用户采用凭据。");
  const record = data as Record<string, unknown>,
    declaration = decodeMaterialAdoptionDeclaration(record.declaration);
  if (
    declaration.category !== "paper" ||
    record.declarationIdentity !== "user-declaration-not-independent-verification" ||
    record.importId !== material.id ||
    record.originalSha256 !== material.sha256 ||
    record.original !== material.original ||
    record.parsed !== material.parsed ||
    record.parserVersion !== material.parserVersion ||
    !isDeepStrictEqual(record.source, source)
  )
    throw new Error("用户采用凭据与本项目原件或来源版本不一致。");
  if (original.bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
    throw new Error("保留原件不是 PDF 文件。");
  return { root, source, material, bytes: original.bytes };
}
type Verified = Awaited<ReturnType<typeof verifiedSource>>;
type PageCache = Pick<
  ResearchSourcePageReceipt,
  | "originalSha256"
  | "rendererVersion"
  | "page"
  | "pageCount"
  | "cacheKey"
  | "imageSha256"
  | "bytes"
  | "width"
  | "height"
  | "mimeType"
  | "limitations"
>;
function checkPng(bytes: Buffer, expected?: PageCache) {
  if (
    bytes.length < 60 ||
    bytes.length > 25_000_000 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    !bytes.subarray(-8, -4).equals(Buffer.from("IEND"))
  )
    throw new Error("原页缓存不是完整 PNG 图像。");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 2400 ||
    height > 2400 ||
    width * height > 6_000_000 ||
    (expected &&
      (width !== expected.width ||
        height !== expected.height ||
        bytes.length !== expected.bytes ||
        hash(bytes) !== expected.imageSha256))
  )
    throw new Error("原页缓存图像尺寸或 SHA 已变化。");
  return { width, height };
}
async function immutable(file: string, bytes: Buffer | string) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function pdfDocument(bytes: Buffer) {
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs"),
    pdfRoot = dirname(requirePdf.resolve("pdfjs-dist/package.json")),
    canvasPackage: unknown = requirePdf(
      requirePdf.resolve("@napi-rs/canvas/package.json", { paths: [pdfRoot] }),
    );
  if (
    !canvasPackage ||
    typeof canvasPackage !== "object" ||
    !("version" in canvasPackage) ||
    typeof canvasPackage.version !== "string"
  )
    throw new Error("当前内置 Node canvas 渲染器不可用。");
  const rendererVersion = `${renderPolicy};pdfjs${pdf.version};canvas${canvasPackage.version}`;
  const loading = pdf.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    useSystemFonts: false,
    stopAtErrors: true,
    cMapUrl: join(pdfRoot, "cmaps") + sep,
    cMapPacked: true,
    standardFontDataUrl: join(pdfRoot, "standard_fonts") + sep,
    wasmUrl: join(pdfRoot, "wasm") + sep,
  });
  try {
    const document = await loading.promise;
    if (
      !Number.isSafeInteger(document.numPages) ||
      document.numPages < 1 ||
      document.numPages > 1000
    )
      throw new Error("PDF 页数不在 1 至 1000 页范围。");
    return { document, loading, rendererVersion };
  } catch (error) {
    await loading.destroy();
    throw error;
  }
}
async function pageImage(v: Verified, page: number) {
  const pdf = await pdfDocument(v.bytes);
  try {
    if (page > pdf.document.numPages)
      throw new Error(`物理第 ${page} 页不存在；原件共 ${pdf.document.numPages} 页。`);
    const cacheKey = hash(JSON.stringify([v.material.sha256, page, pdf.rendererVersion])),
      root = await directory(v.root, ["source-pages", cacheKey], true),
      manifestFile = join(root, "page.json"),
      imageFile = join(root, "page.png");
    try {
      const manifest = await fileWithin(root, manifestFile, 1_000_000),
        raw: unknown = JSON.parse(manifest.bytes.toString("utf8"));
      sourcePageObject(raw, [
        "originalSha256",
        "rendererVersion",
        "page",
        "pageCount",
        "cacheKey",
        "imageSha256",
        "bytes",
        "width",
        "height",
        "mimeType",
        "limitations",
      ]);
      const metadata = raw as unknown as PageCache;
      if (
        metadata.originalSha256 !== v.material.sha256 ||
        metadata.page !== page ||
        metadata.pageCount !== pdf.document.numPages ||
        metadata.rendererVersion !== pdf.rendererVersion ||
        metadata.cacheKey !== cacheKey ||
        metadata.mimeType !== "image/png" ||
        !Array.isArray(metadata.limitations) ||
        metadata.limitations.some((row) => typeof row !== "string")
      )
        throw new Error("原页缓存索引与固定原件、物理页码或渲染版本不一致。");
      const image = await fileWithin(root, imageFile, 25_000_000);
      checkPng(image.bytes, metadata);
      return { metadata, bytes: image.bytes, reused: true };
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
        throw error;
      // An incomplete cache is retained. Never replace an existing PNG or failed manifest.
      for (const file of [imageFile, manifestFile]) {
        try {
          await lstat(file);
          throw new Error("原页缓存写入不完整，保留证据并停止覆盖。");
        } catch (missing) {
          if (
            !missing ||
            typeof missing !== "object" ||
            !("code" in missing) ||
            missing.code !== "ENOENT"
          )
            throw missing;
        }
      }
    }
    const sourcePage = await pdf.document.getPage(page),
      base = sourcePage.getViewport({ scale: 1 });
    if (
      ![base.width, base.height].every(
        (size) => Number.isFinite(size) && size > 0 && size <= 100_000,
      )
    )
      throw new Error("原页尺寸不受支持，未把失败页标为已读。");
    const viewport = sourcePage.getViewport({
      scale: Math.min(
        2,
        2400 / base.width,
        2400 / base.height,
        Math.sqrt(6_000_000 / (base.width * base.height)),
      ),
    });
    // PDF.js owns its installed NodeCanvasFactory; no second canvas adapter or server.
    const factory = pdf.document.canvasFactory as {
      create(
        width: number,
        height: number,
      ): { canvas: { toBuffer(mime: "image/png"): Buffer }; context: unknown };
      destroy(entry: unknown): void;
    };
    const surface = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    let bytes: Buffer;
    try {
      const parameters = {
        canvas: null,
        canvasContext: surface.context,
        viewport,
        background: "rgb(255,255,255)",
      };
      await sourcePage.render(parameters as Parameters<typeof sourcePage.render>[0]).promise;
      bytes = surface.canvas.toBuffer("image/png");
    } finally {
      factory.destroy(surface);
      sourcePage.cleanup();
    }
    const size = checkPng(bytes),
      metadata: PageCache = {
        originalSha256: v.material.sha256,
        rendererVersion: pdf.rendererVersion,
        page,
        pageCount: pdf.document.numPages,
        cacheKey,
        imageSha256: hash(bytes),
        bytes: bytes.length,
        ...size,
        mimeType: "image/png",
        limitations: ["仅渲染所请求的物理页；未执行 OCR 或核验图表、公式的内容支持关系。"],
      };
    await immutable(imageFile, bytes);
    await immutable(manifestFile, JSON.stringify(metadata, null, 2));
    return { metadata, bytes, reused: false };
  } finally {
    await pdf.loading.destroy();
  }
}
function preserve<T extends { id: string; at: string }>(rows: T[], record: T) {
  const prior = rows.find((row) => row.id === record.id);
  if (prior && !isDeepStrictEqual(prior, { ...record, at: prior.at }))
    throw new Error("同一原页工具调用不能改变来源、页码或实际身份。");
  if (!prior) rows.push(structuredClone(record));
  return prior ?? record;
}
/** Strict persisted/export boundary. Historical task versions remain valid historical records. */
export function validateSourcePageProject(p: SourcePageProject): void {
  const records = decodeResearchSourcePageRecords({
    sourcePageReceipts: p.sourcePageReceipts,
    sourcePageReadings: p.sourcePageReadings,
  });
  const sources = [
    ...(p.evidence?.sources ?? []),
    ...(p.evidenceHistory ?? []).flatMap((entry) => entry.evidence.sources),
    ...(p.materialHistory ?? []).flatMap((entry) => entry.evidence.sources),
  ];
  const calls = new Set<string>();
  for (const row of [
    ...(records.sourcePageReceipts ?? []),
    ...(records.sourcePageReadings ?? []),
  ]) {
    const task = p.fusion?.tasks.find((item) => item.id === row.taskId),
      attempt = p.fusion?.attempts.find((item) => item.id === row.attemptId),
      member = p.members.find((item) => item.role === row.role),
      callKey = JSON.stringify([row.role, row.callId]);
    if (
      row.projectId !== p.id ||
      row.revision > p.revision ||
      !task ||
      !attempt ||
      !member ||
      !row.taskId.startsWith(`v${row.revision}:`) ||
      task.role !== row.role ||
      row.taskInputVersion > task.inputVersion ||
      attempt.taskId !== row.taskId ||
      attempt.taskVersion !== row.taskInputVersion ||
      attempt.nativeRunId !== row.nativeRunId ||
      !isDeepStrictEqual(attempt.model, row.model) ||
      row.sessionId !== member.ref.sessionId ||
      row.id !== `source-page:${hash(`${p.id}:${row.role}:${row.callId}`).slice(0, 40)}` ||
      calls.has(callKey)
    )
      throw new Error("原页记录与实际项目、成员、历史任务或 native 执行不符，保留原记录。");
    calls.add(callKey);
  }
  for (const row of records.sourcePageReceipts ?? []) {
    const material = p.importedMaterials?.find((item) => item.id === row.materialImportId);
    if (
      !material ||
      material.sha256 !== row.originalSha256 ||
      material.parserVersion !== row.parserVersion ||
      !sources.some(
        (source) =>
          source.id === row.sourceId &&
          source.kind === "paper" &&
          source.materialImportId === row.materialImportId &&
          source.sha256 === row.sourceSha256,
      ) ||
      row.cacheKey !== hash(JSON.stringify([row.originalSha256, row.page, row.rendererVersion]))
    )
      throw new Error("原页凭据与本项目实际采用的原件、来源或缓存版本不符，保留原记录。");
  }
}
/** Run inside the coordinator's durable owner mutation. Persist result metadata, never media. */
export async function applySourcePageTool(
  p: SourcePageProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Promise<{
  result: unknown;
  detail?: string;
  media?: { type: "image"; data: string; mimeType: "image/png" };
}> {
  sourcePageText(callId, 512);
  if (!Number.isFinite(Date.parse(at))) throw new Error("原页工具实际时间无效。");
  const owner = current(p, role),
    before = token(p, role),
    operation = input.operation;
  if (!SOURCE_PAGE_OPERATIONS.includes(operation as (typeof SOURCE_PAGE_OPERATIONS)[number]))
    throw new Error("未知原页工具操作。");
  sourcePageObject(
    input,
    operation === "source-pages"
      ? ["operation", "sourceId"]
      : operation === "source-read-page"
        ? ["operation", "sourceId", "page"]
        : ["operation", "sourceId", "receiptId", "observations", "remainingLimitations"],
  );
  decodeResearchSourcePageRecords({
    sourcePageReceipts: p.sourcePageReceipts,
    sourcePageReadings: p.sourcePageReadings,
  });
  const v = await verifiedSource(p, input.sourceId),
    identity = {
      projectId: p.id,
      revision: p.revision,
      role,
      taskId: owner.task.id,
      taskInputVersion: owner.task.inputVersion,
      attemptId: owner.attempt.id,
      nativeRunId: owner.attempt.nativeRunId!,
      sessionId: owner.member.ref.sessionId,
      model: structuredClone(owner.attempt.model!),
      callId,
      at,
    },
    id = `source-page:${hash(`${p.id}:${role}:${callId}`).slice(0, 40)}`;
  if (
    (p.sourcePageReceipts?.some((row) => row.id === id) && operation !== "source-read-page") ||
    (p.sourcePageReadings?.some((row) => row.id === id) && operation !== "source-page-reading")
  )
    throw new Error("同一原页工具调用不能改作其他操作。");
  if (operation === "source-page-reading") {
    sourcePageText(input.receiptId);
    sourcePageText(input.observations, 12_000);
    const receipt = p.sourcePageReceipts?.find((row) => row.id === input.receiptId);
    if (
      !receipt ||
      receipt.sourceId !== v.source.id ||
      receipt.sourceSha256 !== v.source.sha256 ||
      receipt.originalSha256 !== v.material.sha256 ||
      receipt.materialImportId !== v.material.id ||
      [
        "projectId",
        "revision",
        "role",
        "taskId",
        "taskInputVersion",
        "attemptId",
        "nativeRunId",
        "sessionId",
      ].some(
        (key) =>
          receipt[key as keyof ResearchSourcePageReceipt] !==
          identity[key as keyof typeof identity],
      ) ||
      !isDeepStrictEqual(receipt.model, identity.model) ||
      receipt.callId === callId ||
      Date.parse(receipt.at) > Date.parse(at)
    )
      throw new Error("原页观察须引用本人当前实际 native 执行此前返回的同版图像凭据。");
    ensureToken(p, role, before);
    const reading = decodeResearchSourcePageReading({
      ...identity,
      id,
      receiptId: receipt.id,
      observations: input.observations,
      remainingLimitations: input.remainingLimitations,
      kind: "model-visual-observation",
    });
    const readings = structuredClone(p.sourcePageReadings ?? []),
      saved = preserve(readings, reading);
    decodeResearchSourcePageRecords({
      sourcePageReceipts: p.sourcePageReceipts,
      sourcePageReadings: readings,
    });
    p.sourcePageReadings = readings;
    return { result: { reading: saved, boundary } };
  }
  let page: number | undefined;
  if (operation === "source-read-page") {
    if (
      typeof input.page !== "number" ||
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      input.page > 1000
    )
      throw new Error("请选择 1 至 1000 范围内一个明确的物理页码。");
    page = input.page;
  }
  let output: Awaited<ReturnType<typeof pageImage>> | undefined,
    pageCount: number | undefined,
    failure: string | undefined;
  try {
    if (page !== undefined) output = await pageImage(v, page);
    else {
      const pdf = await pdfDocument(v.bytes);
      try {
        pageCount = pdf.document.numPages;
      } finally {
        await pdf.loading.destroy();
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await verifiedSource(p, v.source.id);
  ensureToken(p, role, before);
  if (failure)
    return {
      result: {
        ok: false,
        sourceId: v.source.id,
        materialImportId: v.material.id,
        originalSha256: v.material.sha256,
        ...(page === undefined ? {} : { page, locator: `page:${page}` }),
        limitation: {
          scope: page === undefined ? "page-count" : "requested-page",
          message: failure,
        },
        warnings: v.material.warnings,
        boundary,
      },
      detail: `PDF 原页局部不可用：${failure}`,
    };
  if (!output)
    return {
      result: {
        ok: true,
        sourceId: v.source.id,
        materialImportId: v.material.id,
        originalSha256: v.material.sha256,
        pageCount,
        textExtractionStatus: v.material.status,
        extractedPageLocators: v.material.locations
          .filter((row) => row.kind === "page")
          .map((row) => row.locator),
        warnings: v.material.warnings,
        boundary,
      },
    };
  const receipt = decodeResearchSourcePageReceipt({
    ...identity,
    id,
    sourceId: v.source.id,
    sourceSha256: v.source.sha256,
    materialImportId: v.material.id,
    parserVersion: v.material.parserVersion,
    locator: `page:${page!}`,
    ...output.metadata,
    limitations: [...output.metadata.limitations, ...v.material.warnings],
  });
  const receipts = structuredClone(p.sourcePageReceipts ?? []),
    saved = preserve(receipts, receipt);
  decodeResearchSourcePageRecords({
    sourcePageReceipts: receipts,
    sourcePageReadings: p.sourcePageReadings,
  });
  p.sourcePageReceipts = receipts;
  return {
    result: { ok: true, receipt: saved, cacheReused: output.reused, boundary },
    media: { type: "image", data: output.bytes.toString("base64"), mimeType: "image/png" },
  };
}
