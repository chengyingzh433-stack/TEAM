import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { ResearchProject } from "../../contracts/research-group";
import {
  decodeArchiveSelection,
  type ResearchArchiveFile,
  type ResearchArchiveManifest,
  type ResearchArchiveReceipt,
  type ResearchArchiveSelection,
} from "../../contracts/research-archive";

const LIMIT = 256 * 1024 * 1024;
const FILE_LIMIT = 32 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
function fail(message: string): never {
  throw new Error(`研究归档：${message}`);
}
function safePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length > 512 ||
    !path ||
    path.normalize("NFC") !== path ||
    path
      .split("/")
      .some(
        (part) =>
          !/^[A-Za-z0-9_\-.]+$/.test(part) ||
          [".", ".."].includes(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    fail("路径不安全或不支持");
}
/** No symlinks under the chosen root; open the final inode without following links. */
async function readSafe(root: string, path: string, limit = FILE_LIMIT): Promise<Buffer> {
  const base = await realpath(root);
  const parts = path.split("/");
  if (
    !path ||
    parts.some((part) => !part || part === "." || part === "..") ||
    path.includes("\\") ||
    path.startsWith("/")
  )
    fail("文件越界");
  let target = base;
  for (const part of parts) {
    target = join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink()) fail("拒绝符号链接");
  }
  if ((await realpath(target)) !== target) fail("文件逃逸");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) fail("文件类型或大小不支持");
    const current = await lstat(target);
    if (
      (await realpath(target)) !== target ||
      current.isSymbolicLink() ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev
    )
      fail("读取目标发生变化");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      fail("文件读取期间变化");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}
function decodeManifest(value: unknown): ResearchArchiveManifest {
  const m = value as ResearchArchiveManifest;
  if (
    !m ||
    typeof m !== "object" ||
    Array.isArray(m) ||
    Object.keys(m).some(
      (k) =>
        ![
          "schema",
          "workflowVersion",
          "projectId",
          "objective",
          "revision",
          "createdAt",
          "files",
          "missing",
        ].includes(k),
    ) ||
    m.schema !== "lancer-research-archive/1" ||
    !["legacy", "fusion-v2"].includes(m.workflowVersion) ||
    !/^[a-f0-9-]{36}$/.test(m.projectId) ||
    typeof m.objective !== "string" ||
    !m.objective.trim() ||
    m.objective.length > 64000 ||
    !Number.isSafeInteger(m.revision) ||
    m.revision < 0 ||
    !Number.isFinite(Date.parse(m.createdAt)) ||
    !Array.isArray(m.files) ||
    m.files.length > 2000 ||
    !Array.isArray(m.missing) ||
    m.missing.length > 2000
  )
    fail("不支持的版本或无效清单");
  const seen = new Set<string>();
  let total = 0;
  for (const f of m.files) {
    if (
      !f ||
      typeof f !== "object" ||
      Object.keys(f).some((k) => !["path", "sha256", "bytes", "kind", "originalId"].includes(k)) ||
      typeof f.path !== "string" ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      !Number.isSafeInteger(f.bytes) ||
      f.bytes < 0 ||
      f.bytes > FILE_LIMIT ||
      !["record", "source", "dataset", "analysis", "manuscript"].includes(f.kind) ||
      typeof f.originalId !== "string" ||
      !f.originalId ||
      f.originalId.length > 512
    )
      fail("无效文件记录");
    safePath(f.path);
    const permitted = {
      record: /^(records\.json|index\.html)$/,
      source: /^materials\/source-[0-9]+\.[a-z0-9]{1,8}$/,
      dataset: /^materials\/dataset-[0-9]+\.csv$/,
      analysis:
        /^analyses\/[0-9]+\/(input\.csv|calculation-input\.csv|plan\.json|registered-run\.json|result\.json|replay\.mjs|spec\.json)$/,
      manuscript: /^(manuscripts\/[0-9]+\.md|deliveries\/[0-9]+\/paper\.(md|html|docx))$/,
    };
    if (!permitted[f.kind].test(f.path)) fail("文件位置与登记用途不符");
    if (f.path === "manifest.json" || seen.has(f.path.toLowerCase())) fail("重复或保留路径");
    seen.add(f.path.toLowerCase());
    total += f.bytes;
  }
  if (total > LIMIT) fail("归档超过大小上限");
  if (
    !["records.json", "index.html"].every((path) =>
      m.files.some((f) => f.path === path && f.kind === "record"),
    )
  )
    fail("缺少研究记录");
  for (const row of m.missing)
    if (
      !row ||
      Object.keys(row).some((k) => !["id", "reason", "obtain"].includes(k)) ||
      [row.id, row.reason, row.obtain].some((s) => typeof s !== "string" || s.length > 8000)
    )
      fail("无效缺项说明");
  return structuredClone(m);
}
export async function validateResearchArchive(directory: string) {
  if ((await lstat(directory)).isSymbolicLink()) fail("归档根目录不能是链接");
  const root = await realpath(directory);
  const raw = await readSafe(root, "manifest.json", 2_000_000);
  const manifest = decodeManifest(JSON.parse(raw.toString("utf8")));
  const allowed = new Set(["manifest.json", ...manifest.files.map((f) => f.path)]);
  let count = 0;
  async function walk(path = ""): Promise<void> {
    for (const item of await readdir(join(root, path), { withFileTypes: true })) {
      if (++count > 4000) fail("目录条目过多");
      const name = path ? `${path}/${item.name}` : item.name;
      safePath(name);
      if (item.isSymbolicLink()) fail("归档含符号链接");
      if (item.isDirectory()) {
        if (![...allowed].some((f) => f.startsWith(name + "/"))) fail("归档含未登记目录");
        await walk(name);
      } else if (!item.isFile() || !allowed.has(name)) fail("归档含未登记文件");
    }
  }
  await walk();
  const files = new Map<string, Buffer>();
  for (const f of manifest.files) {
    const bytes = await readSafe(root, f.path);
    if (bytes.length !== f.bytes || hash(bytes) !== f.sha256) fail(`文件指纹不符：${f.path}`);
    files.set(f.path, bytes);
  }
  const records = JSON.parse(files.get("records.json")!.toString("utf8")) as Record<
    string,
    unknown
  >;
  if (
    !records ||
    typeof records !== "object" ||
    Array.isArray(records) ||
    Object.keys(records).some(
      (key) =>
        ![
          "schema",
          "projectId",
          "revision",
          "artifacts",
          "sources",
          "datasets",
          "knowledge",
          "methodLocations",
          "analysisPlan",
          "analysisPlans",
          "analysisResults",
          "decisions",
          "analysisReviews",
          "numericBindings",
          "contentChecks",
          "pathRecords",
          "pathReviews",
          "synthesis",
        ].includes(key),
    ) ||
    records.schema !== "lancer-research-records/1" ||
    records.projectId !== manifest.projectId ||
    records.revision !== manifest.revision ||
    !Array.isArray(records.artifacts) ||
    !Array.isArray(records.sources) ||
    !Array.isArray(records.datasets)
  )
    fail("研究记录与清单不一致");
  // Return pinned bytes; subsequent changes to the selected directory cannot affect import.
  return { manifest, files, raw, manifestSha256: hash(raw) };
}
export async function exportResearchArchive(
  projectValue: ResearchProject,
  selectionValue: ResearchArchiveSelection,
): Promise<ResearchArchiveReceipt> {
  const p = structuredClone(projectValue),
    selection = decodeArchiveSelection(selectionValue);
  const sources = p.evidence?.sources ?? [],
    datasets = p.evidence?.datasets ?? [];
  if (
    selection.sourceIds.some((id) => !sources.some((s) => s.id === id)) ||
    selection.datasetIds.some((id) => !datasets.some((d) => d.id === id))
  )
    fail("分发选择已过期");
  const files = new Map<string, Buffer>();
  const manifest: ResearchArchiveManifest = {
    schema: "lancer-research-archive/1",
    workflowVersion: p.workflowVersion === "fusion-v2" ? "fusion-v2" : "legacy",
    projectId: p.id,
    objective: p.objective,
    revision: p.revision,
    createdAt: new Date().toISOString(),
    files: [],
    missing: [],
  };
  let total = 0;
  const add = (
    path: string,
    bytes: Buffer,
    kind: ResearchArchiveFile["kind"],
    originalId: string,
  ) => {
    safePath(path);
    total += bytes.length;
    if (bytes.length > FILE_LIMIT || total > LIMIT || files.size >= 1999)
      fail("导出超过大小或文件数量上限");
    files.set(path, bytes);
    manifest.files.push({ path, sha256: hash(bytes), bytes: bytes.length, kind, originalId });
  };
  const missing = (id: string, reason: string, obtain = "请联系原课题作者取得允许分发的材料") =>
    manifest.missing.push({ id, reason, obtain });
  const copy = async (
    root: string,
    file: string,
    target: string,
    kind: ResearchArchiveFile["kind"],
    id: string,
    expected?: string,
  ) => {
    const path = relative(resolve(root), resolve(file)).split("\\").join("/");
    try {
      const bytes = await readSafe(root, path);
      if (kind === "analysis") {
        const projection = p.analyses?.find((a) => a.id === id);
        const registered = p.analysisRegistry?.runs.find((a) => a.id === id);
        if (!projection) fail("分析身份已变化");
        if (target.endsWith("/spec.json")) {
          const dataset = datasets.find((d) => d.id === projection.spec.datasetId);
          if (
            !dataset ||
            !isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), {
              delimiter: dataset.delimiter,
              spec: projection.spec,
            })
          )
            fail("复算参数与固定记录不符");
        }
        if (
          target.endsWith("/registered-run.json") &&
          (!registered || !isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), registered))
        )
          fail("登记结果与固定记录不符");
        if (target.endsWith("/plan.json")) {
          const plan = p.analysisRegistry?.plans.find(
            (plan) => plan.id === registered?.planId && plan.version === registered.planVersion,
          );
          if (!plan || !isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), plan))
            fail("登记计划与固定记录不符");
        }
        if (
          target.endsWith("/calculation-input.csv") &&
          (!registered || hash(bytes) !== registered.calculationInputSha256)
        )
          fail("复算输入与固定记录不符");
      }
      if (expected && hash(bytes) !== expected) fail(`原文件与固定版本不符：${id}`);
      if (kind === "analysis" && target.endsWith("/result.json")) {
        const projection = p.analyses?.find((a) => a.id === id);
        if (!projection || !isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), projection))
          fail("分析结果文件与固定记录不符");
        const {
          id: runId,
          revision,
          role,
          createdAt,
          spec,
          datasetSha256,
          engine,
          result,
          sha256,
        } = projection;
        add(
          target,
          json({
            id: runId,
            revision,
            role,
            createdAt,
            spec,
            datasetSha256,
            engine,
            result,
            sha256,
            file: "result.json",
          }),
          kind,
          id,
        );
      } else add(target, bytes, kind, id);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing(id, "固定文件缺失");
      return false;
    }
  };
  for (const [i, s] of sources.entries()) {
    if (!selection.sourceIds.includes(s.id)) {
      missing(s.id, "未获本次分发许可，未打包原文", s.url || "联系原作者");
      continue;
    }
    const extension = /^\.[a-zA-Z0-9]{1,8}$/.test(extname(s.file))
      ? extname(s.file).toLowerCase()
      : ".bin";
    await copy(
      dirname(s.file),
      s.file,
      `materials/source-${i}${extension}`,
      "source",
      s.id,
      s.sha256,
    );
  }
  for (const [i, d] of datasets.entries()) {
    if (!selection.datasetIds.includes(d.id)) {
      missing(d.id, "未获本次数据分发许可");
      continue;
    }
    await copy(dirname(d.file), d.file, `materials/dataset-${i}.csv`, "dataset", d.id, d.sha256);
  }
  const projectDirectory = join(p.workspacePath, ".lancer", "research-groups", p.id);
  for (const [i, a] of (p.analyses ?? []).entries()) {
    if (!selection.datasetIds.includes(a.spec.datasetId)) {
      missing(a.id, "数据未许可，未打包含输入副本的复算目录");
      continue;
    }
    for (const name of a.replayScriptSha256
      ? [
          "input.csv",
          "calculation-input.csv",
          "plan.json",
          "registered-run.json",
          "result.json",
          "replay.mjs",
        ]
      : ["input.csv", "spec.json", "result.json", "replay.mjs"]) {
      await copy(
        projectDirectory,
        join(dirname(a.file), name),
        `analyses/${i}/${name}`,
        "analysis",
        a.id,
        name === "input.csv"
          ? a.datasetSha256
          : name === "replay.mjs"
            ? a.replayScriptSha256
            : undefined,
      );
    }
  }
  for (const [i, artifact] of p.artifacts.entries())
    add(`manuscripts/${i}.md`, Buffer.from(artifact.content), "manuscript", artifact.id);
  // Explicit projection: never serialize credentials, native sessions, global state or arbitrary project files.
  add(
    "records.json",
    json({
      schema: "lancer-research-records/1",
      projectId: p.id,
      revision: p.revision,
      artifacts: p.artifacts.map(
        ({
          id,
          role,
          kind,
          revision,
          round,
          createdAt,
          content,
          refs,
          verdict,
          sourceIds,
          analysisIds,
          stage,
        }) => ({
          id,
          role,
          kind,
          revision,
          round,
          createdAt,
          content,
          refs,
          verdict,
          sourceIds,
          analysisIds,
          stage,
        }),
      ),
      sources: sources.map(({ id, title, authors, year, url, sha256, kind, textScope }) => ({
        id,
        title,
        authors,
        year,
        url,
        sha256,
        kind,
        textScope,
      })),
      datasets: datasets.map(({ id, sha256, description, sourceId, dataKind, delimiter }) => ({
        id,
        sha256,
        description,
        sourceId,
        dataKind,
        delimiter,
      })),
      knowledge: {
        sha256: p.knowledge.sha256,
        version: p.knowledge.version,
        count: p.knowledge.count,
      },
      methodLocations: p.methodPackages?.map((m) => ({
        id: m.id,
        packageSha256: m.packageSha256,
        knowledge: m.knowledge,
        rootIds: m.rootIds,
        recordIds: m.records.map((r) => r.id),
      })),
      analysisPlan: p.analysisPlan,
      analysisPlans: p.analysisRegistry?.plans,
      analysisResults: p.analyses?.map(
        ({ id, revision, spec, datasetSha256, engine, result, sha256 }) => ({
          id,
          revision,
          spec,
          datasetSha256,
          engine,
          result,
          sha256,
        }),
      ),
      decisions: p.fusion?.decisions,
      analysisReviews: p.analysisRegistry?.reviews,
      numericBindings: p.numericBindings,
      contentChecks: p.contentChecks,
      pathRecords: p.m3?.pathRecords?.map(
        ({ id, revision, role, at, input, excerpts, sources }) => ({
          id,
          revision,
          role,
          at,
          input,
          sources,
          excerpts: excerpts.filter((excerpt) =>
            input.evidence.some(
              (e) => e.id === excerpt.id && selection.sourceIds.includes(e.sourceId),
            ),
          ),
        }),
      ),
      pathReviews: p.m3?.pathReviews,
      synthesis: sources.every((source) => selection.sourceIds.includes(source.id))
        ? p.synthesis
        : undefined,
    }),
    "record",
    p.id,
  );
  missing(
    "knowledge",
    "课程库原文与图像不随包分发；保留固定方法版本和条目定位",
    `知识版本 ${p.knowledge.version}，SHA ${p.knowledge.sha256}`,
  );
  missing(
    "runtime",
    "复算程序需 Node.js；导入仅保存程序，不自动执行。历史审阅不作为新课题许可。",
    "使用与原课题相符的 Node.js 环境，核对脚本后手动复算",
  );
  if (p.synthesis && !sources.every((source) => selection.sourceIds.includes(source.id)))
    missing("synthesis", "综合记录含未许可原文片段，未随包分发；主稿与审阅仍保留");
  if (
    p.m3?.pathRecords?.length &&
    !sources.every((source) => selection.sourceIds.includes(source.id))
  )
    missing("path-excerpts", "非数值分析中未许可原文的逐字片段未随包分发；编码与解释记录仍保留");
  const deliveries = [
    ...(p.finalPaper ? [{ files: p.finalPaper, status: "accepted" }] : []),
    ...(p.reviewPapers ?? []).map((r) => ({ files: r.files, status: "review" })),
    ...(p.supersededExports ?? []).map((r) => ({ files: r.files, status: "superseded" })),
  ];
  for (const [i, delivery] of deliveries.entries()) {
    let provenance: Record<string, unknown>;
    try {
      provenance = JSON.parse(
        (
          await readSafe(projectDirectory, relative(projectDirectory, delivery.files.provenance))
        ).toString("utf8"),
      ) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing(`delivery-${i}`, "交付溯源缺失，未将文件冒充固定稿随包交付");
      continue;
    }
    const manuscript = p.artifacts.find((a) => a.id === provenance.manuscriptId);
    if (
      !manuscript ||
      provenance.projectId !== p.id ||
      provenance.revision !== manuscript.revision ||
      provenance.manuscriptSha256 !== hash(Buffer.from(manuscript.content))
    )
      fail("交付稿件与固定溯源不符");
    for (const format of ["markdown", "html", "docx"] as const) {
      const file = delivery.files[format];
      const expected =
        format === "markdown"
          ? hash(Buffer.from(manuscript.content + "\n"))
          : format === "docx" && typeof provenance.docxSha256 === "string"
            ? provenance.docxSha256
            : undefined;
      if (format === "docx" && file && !expected) {
        missing(`delivery-${i}`, "Word 缺固定文件指纹，未随包分发");
        continue;
      }
      if (file)
        await copy(
          projectDirectory,
          file,
          `deliveries/${i}/paper.${format === "markdown" ? "md" : format}`,
          "manuscript",
          `${delivery.status}:${manuscript.id}`,
          expected,
        );
    }
  }
  for (const id of new Set(p.artifacts.flatMap((a) => a.sourceIds ?? []))) {
    if (!sources.some((source) => source.id === id))
      missing(id, "历史稿引用的来源不在当前材料版本，需从原课题补取");
  }
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  add(
    "index.html",
    Buffer.from(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>研究归档</title><h1>${escape(p.objective)}</h1><p>固定输入版本 ${p.revision}；历史审阅不代表新项目许可。复算程序不自动执行。</p><h2>文件</h2><ul>${manifest.files.map((f) => `<li><a href="${f.path}">${escape(f.kind)} · ${escape(f.originalId)} · ${f.path}</a></li>`).join("")}</ul><h2>缺项与环境依赖</h2><ul>${manifest.missing.map((m) => `<li>${escape(m.id)}：${escape(m.reason)}；${escape(m.obtain)}</li>`).join("")}</ul></html>`,
    ),
    "record",
    p.id,
  );
  const parent = join(projectDirectory, "archives");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "archive-"));
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes, { flag: "wx", flush: true });
  }
  const raw = json(decodeManifest(manifest));
  await writeFile(join(directory, "manifest.json"), raw, { flag: "wx", flush: true });
  return { directory, manifestSha256: hash(raw), sourceProjectId: p.id, revision: p.revision };
}
export async function stageResearchArchiveImport(directory: string, destinationParent: string) {
  const validated = await validateResearchArchive(directory);
  const projectId = randomUUID();
  await mkdir(destinationParent, { recursive: true });
  const staging = await mkdtemp(join(destinationParent, ".pending-"));
  for (const [path, bytes] of validated.files) {
    await mkdir(dirname(join(staging, path)), { recursive: true });
    await writeFile(join(staging, path), bytes, { flag: "wx", flush: true });
  }
  await writeFile(join(staging, "manifest.json"), validated.raw, { flag: "wx", flush: true });
  // Rename the complete verified package; no partial directory is exposed as an imported project.
  const destination = join(destinationParent, projectId);
  await rename(staging, destination);
  return {
    projectId,
    manifest: validated.manifest,
    receipt: {
      directory: destination,
      manifestSha256: validated.manifestSha256,
      sourceProjectId: validated.manifest.projectId,
      revision: validated.manifest.revision,
    },
  };
}
