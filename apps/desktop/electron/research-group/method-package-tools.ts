import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import {
  assertResearchMethodFields,
  assertResearchMethodText,
  decodeResearchMethodPackage,
  type ResearchMethodPackage,
  type ResearchMethodApplication,
  type ResearchMethodImageReading,
  type ResearchMethodImageReceipt,
  type ResearchMethodPackageUse,
  type ResearchMethodProjectRecords,
  decodeResearchMethodProjectRecords,
  decodeResearchMethodApplication,
  decodeResearchMethodImageReading,
  decodeResearchMethodContentOpinion,
  decodeResearchMethodAdjudication,
  decodeResearchMethodImageReceipt,
  decodeResearchMethodPackageUse,
  type ResearchMethodContentOpinion,
  type ResearchMethodAdjudication,
  type ResearchMethodActor,
  type ResearchMethodPackageImageReference,
  type ResearchMethodUseScope,
} from "../../contracts/research-method-packages";
import { ResearchKnowledge } from "./knowledge";
import { activeFusionAttempt } from "./fusion-task-runtime";
import {
  reuseOrCreateResearchMethodPackage,
  checkResearchMethodPackage,
  recordResearchMethodImageReading,
  recordResearchMethodApplication,
  recordResearchMethodContentOpinion,
  recordResearchMethodAdjudication,
} from "./method-packages";

export type MethodProject = ResearchProject & ResearchMethodProjectRecords;
export const METHOD_PACKAGE_OPERATIONS = [
  "method-package",
  "method-read-image",
  "method-image-reading",
  "method-apply",
  "method-opinion",
  "method-adjudicate",
  "method-check",
] as const;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const boundary =
  "课程方法包不是课题原始实证；图片字节返回、模型读图观察、方法应用、程序完整性、B内容意见和导师裁定分别记录。完整工具评分仍未认证，模型意见不是人类专家判断或伦理批准。";
const fields = (value: unknown, keys: string[]) => {
  assertResearchMethodFields(value, keys);
  return value;
};
const text = (value: unknown, label: string, max = 6000) => {
  assertResearchMethodText(value, label, max);
  return value;
};
function current(p: MethodProject, role: ResearchRole) {
  const member = p.members.find((item) => item.role === role),
    attempt = activeFusionAttempt(p, role),
    task = p.fusion?.tasks.find((item) => item.id === attempt?.taskId);
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    !member ||
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !attempt.model ||
    task.role !== role ||
    !task.id.startsWith(`v${p.revision}:`) ||
    attempt.taskVersion !== task.inputVersion ||
    [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].some(
      (ref) =>
        !p.fusion!.adoptedInputs.some(
          (input) => input.inputId === ref.inputId && input.version === ref.version,
        ),
    )
  )
    throw new Error("方法工具需要当前输入版本的实际native执行、会话与宿主模型身份。");
  return { member, attempt, task };
}
function actor(p: MethodProject, role: ResearchRole, callId: string): ResearchMethodActor {
  const owner = current(p, role);
  return {
    kind: "model",
    id: `model:${role}`,
    evidenceRef: `host-method:${JSON.stringify({ callId, taskId: owner.task.id, taskVersion: owner.task.inputVersion, attemptId: owner.attempt.id, nativeRunId: owner.attempt.nativeRunId, sessionId: owner.member.ref.sessionId, model: owner.attempt.model })}`,
  };
}
function token(p: MethodProject, role: ResearchRole) {
  const owner = current(p, role);
  return digest({
    projectId: p.id,
    revision: p.revision,
    pin: p.knowledge,
    task: owner.task,
    attempt: owner.attempt,
    member: owner.member.ref,
    packages: p.methodPackages,
    uses: p.methodPackageUses,
    applications: p.methodApplications,
    readings: p.methodImageReadings,
    opinions: p.methodContentOpinions,
    adjudications: p.methodAdjudications,
    receipts: p.methodImageReceipts,
  });
}
function ensureToken(p: MethodProject, role: ResearchRole, before: string) {
  if (token(p, role) !== before)
    throw new Error("读取方法或图片期间任务输入/身份/版本已变化，请重新请求。");
}
function scope(
  p: MethodProject,
  pkg: ResearchMethodPackage,
  taskId: string,
): ResearchMethodUseScope {
  return { projectId: p.id, taskId, packageId: pkg.id, packageSha256: pkg.packageSha256 };
}
function projectRecords(p: MethodProject): ResearchMethodProjectRecords {
  return {
    methodPackages: p.methodPackages,
    methodPackageUses: p.methodPackageUses,
    methodApplications: p.methodApplications,
    methodImageReadings: p.methodImageReadings,
    methodContentOpinions: p.methodContentOpinions,
    methodAdjudications: p.methodAdjudications,
    methodImageReceipts: p.methodImageReceipts,
  };
}
function makeUse(
  p: MethodProject,
  role: ResearchRole,
  pkg: ResearchMethodPackage,
  callId: string,
  at: string,
  operation: "knowledge" | "method-package",
): ResearchMethodPackageUse {
  text(callId, "宿主实际调用", 512);
  const owner = current(p, role);
  return {
    ...scope(p, pkg, owner.task.id),
    id: `method-use:${hash(`${p.id}:${role}:${callId}`).slice(0, 40)}`,
    role,
    revision: p.revision,
    taskInputVersion: owner.task.inputVersion,
    sessionId: owner.member.ref.sessionId,
    attemptId: owner.attempt.id,
    nativeRunId: owner.attempt.nativeRunId!,
    model: structuredClone(owner.attempt.model!),
    callId,
    at,
    operation,
  };
}
function assertCallOperation(
  p: MethodProject,
  role: ResearchRole,
  callId: string,
  operation: string,
) {
  const id = `method:${hash(`${p.id}:${role}:${callId}`).slice(0, 40)}`;
  const priorUse = p.methodPackageUses?.find((use) => use.callId === callId && use.role === role);
  if (priorUse && priorUse.operation !== operation)
    throw new Error("同一工具调用身份不能改作其他方法操作。");
  for (const [records, expected] of [
    [p.methodImageReceipts, "method-read-image"],
    [p.methodImageReadings, "method-image-reading"],
    [p.methodApplications, "method-apply"],
    [p.methodContentOpinions, "method-opinion"],
    [p.methodAdjudications, "method-adjudicate"],
  ] as const)
    if (records?.some((record) => record.id === id) && operation !== expected)
      throw new Error("同一工具调用身份不能改作其他方法操作。");
}
function packageFor(p: MethodProject, id: unknown) {
  const packageId = text(id, "packageId", 512),
    pkg = p.methodPackages?.find((item) => item.id === packageId);
  if (!pkg) throw new Error("本项目尚未实际取得此方法包。");
  checkResearchMethodPackage(pkg, scope(p, pkg, "host-package-integrity"));
  return pkg;
}
function safePath(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("方法图片路径不安全。");
}
async function directories(base: string, parts: string[]) {
  let root = await realpath(base);
  for (const part of parts) {
    safePath(part);
    if (part.includes("/")) throw new Error("缓存目录段无效。");
    root = join(root, part);
    try {
      await mkdir(root);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
    }
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("方法缓存不能使用符号链接目录。");
  }
  return root;
}
async function cacheRoot(p: MethodProject) {
  return directories(p.workspacePath, [".lancer", "research-method-packages"]);
}
async function within(root: string, path: string) {
  safePath(path);
  const actualRoot = await realpath(root),
    target = await realpath(join(root, path)),
    rel = relative(actualRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("图片路径越出固定方法包目录。");
  return target;
}
async function jsonFile(file: string): Promise<unknown> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 10_000_000) throw new Error("方法缓存清单不可读或过大。");
  const data: unknown = JSON.parse(await readFile(file, "utf8"));
  return data;
}
async function cachedPackages(root: string) {
  const entries = await readdir(root, { withFileTypes: true }),
    packages: ResearchMethodPackage[] = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("方法包缓存目录无效。");
    let file: string;
    try {
      file = await within(join(root, entry.name), "package.json");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    const pkg = decodeResearchMethodPackage(await jsonFile(file));
    checkResearchMethodPackage(pkg, {
      projectId: "cache-integrity",
      taskId: "cache-integrity",
      packageId: pkg.id,
      packageSha256: pkg.packageSha256,
    });
    if (pkg.packageSha256 !== entry.name) throw new Error("方法缓存路径和版本摘要不符。");
    packages.push(pkg);
  }
  return packages;
}
async function immutableWrite(file: string, bytes: Uint8Array) {
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !(await readFile(file)).equals(Buffer.from(bytes))
    )
      throw new Error("已有方法缓存不可覆盖，字节或路径已变化。");
  }
}
async function persistCache(
  root: string,
  pkg: ResearchMethodPackage,
  knowledge: ResearchKnowledge,
) {
  const directory = await directories(root, [pkg.packageSha256]);
  for (const image of pkg.images.filter((entry) => entry.state === "bytes-readable")) {
    const file = await within(knowledge.pin.directory, image.path),
      info = await stat(file);
    if (!info.isFile() || info.size !== image.bytes || info.size > 25_000_000)
      throw new Error("原方法图片在缓存前已变化。");
    const bytes = await readFile(file);
    if (hash(bytes) !== image.actualSha256) throw new Error("原方法图片摘要在缓存前已变化。");
    const parts = image.path.split("/"),
      name = parts.pop()!;
    const folder = await directories(directory, ["images", ...parts]);
    await immutableWrite(join(folder, name), bytes);
  }
  // Only allowlisted, validated course package content goes into this shared workspace cache.
  await immutableWrite(
    join(directory, "package.json"),
    Buffer.from(JSON.stringify(decodeResearchMethodPackage(pkg))),
  );
}
const actualCoursePin = "d287aed0d4abdb8213cc95ab926f9899a73f3eb508a9e23352750e31028d9da5";
function additionalReferences(
  knowledge: ResearchKnowledge,
  recordIds: string[],
): ResearchMethodPackageImageReference[] {
  if (knowledge.pin.sha256 !== actualCoursePin || !recordIds.includes("EDU-N02-2-4")) return [];
  return [40, 41, 42].map((page) => ({
    recordId: "EDU-N02-2-4",
    path: `素材/原图/0801_p0${page}.png`,
    sourceRef: `host-audited-course-pin:${actualCoursePin}:EDU-N02-2-4原文p039–p042范围及溯源/图片清单.json；image_paths仅列p039，显式补p${page}，不证明完整工具可得`,
  }));
}
async function prepare(
  p: MethodProject,
  knowledge: ResearchKnowledge,
  role: ResearchRole,
  query: string,
  ids: string[] | undefined,
  at: string,
  supersedesPackageId?: string,
  actualCallId?: string,
  operation: "knowledge" | "method-package" = "knowledge",
) {
  const before = token(p, role);
  const callId =
    actualCallId ??
    `host-prepare:${digest({ projectId: p.id, attemptId: current(p, role).attempt.id, query, ids, at }).slice(0, 40)}`;
  assertCallOperation(p, role, callId, operation);
  if (!isDeepStrictEqual(knowledge.pin, p.knowledge))
    throw new Error("课程适配器与本项目固定pin不一致；升级须由宿主显式采用新版本。");
  await knowledge.assertPinned(p.knowledge);
  const { rootIds, records } = knowledge.retrieveWithRoots(query, role, ids);
  if (!rootIds.length) throw new Error("未检索到实际方法知识块，不能创建空包。");
  const root = await cacheRoot(p),
    cached = await cachedPackages(root),
    own = p.methodPackages ?? [];
  const all = [
    ...own,
    ...cached.filter(
      (pkg) =>
        !own.some((entry) => entry.id === pkg.id) &&
        (pkg.knowledge.sha256 === knowledge.pin.sha256 || pkg.id === supersedesPackageId),
    ),
  ];
  const result = await reuseOrCreateResearchMethodPackage(all, {
    id: `method-package:${randomUUID()}`,
    at,
    knowledge,
    rootIds,
    retrievedRecords: records,
    additionalImageReferences: additionalReferences(
      knowledge,
      records.map((row) => row.id),
    ),
    ...(supersedesPackageId ? { supersedesPackageId } : {}),
  });
  await persistCache(root, result.package, knowledge);
  await knowledge.assertPinned(p.knowledge);
  ensureToken(p, role, before);
  const packages = structuredClone(p.methodPackages ?? []);
  if (!packages.some((pkg) => pkg.id === result.package.id))
    packages.push(structuredClone(result.package));
  const uses = structuredClone(p.methodPackageUses ?? []);
  const use = preserve(uses, makeUse(p, role, result.package, callId, at, operation));
  decodeResearchMethodProjectRecords({
    ...projectRecords(p),
    methodPackages: packages,
    methodPackageUses: uses,
  });
  p.methodPackages = packages;
  p.methodPackageUses = uses;
  return {
    use,
    packageId: result.package.id,
    packageSha256: result.package.packageSha256,
    package: result.package,
    reused: result.reused,
    rootIds,
    records,
    boundary,
  };
}
/** Use from the ordinary knowledge operation inside its owner mutation. Retrieval logic lives in ResearchKnowledge. */
export async function prepareMethodPackage(
  p: MethodProject,
  knowledge: ResearchKnowledge,
  role: ResearchRole,
  query: string,
  ids: string[] | undefined,
  at: string,
  actualCallId?: string,
) {
  return prepare(p, knowledge, role, query, ids, at, undefined, actualCallId);
}
async function cachedImage(p: MethodProject, pkg: ResearchMethodPackage, path: string) {
  safePath(path);
  const image = pkg.images.find((entry) => entry.path === path);
  if (!image || image.state !== "bytes-readable" || !image.actualSha256)
    throw new Error("图片不在本包可读清单中。");
  const root = await cacheRoot(p),
    directory = await within(root, pkg.packageSha256);
  const saved = decodeResearchMethodPackage(
    await jsonFile(await within(directory, "package.json")),
  );
  if (!isDeepStrictEqual(saved, pkg)) throw new Error("缓存方法包与项目固定版本不一致。");
  const file = await within(directory, `images/${path}`),
    info = await stat(file);
  if (!info.isFile() || info.size !== image.bytes || info.size < 1 || info.size > 25_000_000)
    throw new Error("方法图片字节数或文件状态变化。");
  const bytes = await readFile(file);
  if (hash(bytes) !== image.actualSha256) throw new Error("方法图片SHA已变化。");
  const png =
    bytes.length > 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR";
  const jpeg =
    bytes.length > 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217;
  if (!png && !jpeg) throw new Error("实际字节不是可传输的PNG/JPEG图片；不能把文本冒充图片。");
  return { image, bytes, mimeType: png ? ("image/png" as const) : ("image/jpeg" as const) };
}

/** Verify only already-acquired packages; this never creates a Knowledge adapter or a new package. */
export async function verifyResearchMethodResumeCache(p: MethodProject): Promise<string[]> {
  if (p.workflowVersion !== "fusion-v2") throw new Error("仅融合版课题可核验已固定的方法缓存。");
  const packages =
    decodeResearchMethodProjectRecords({ methodPackages: p.methodPackages }).methodPackages?.filter(
      (pkg) =>
        pkg.knowledge.sha256 === p.knowledge.sha256 &&
        pkg.knowledge.version === p.knowledge.version &&
        pkg.knowledge.count === p.knowledge.count,
    ) ?? [];
  if (!packages.length) throw new Error("本项目尚无当前课程pin已取得的方法包，不能离线恢复。");
  // Do not create even an empty cache tree when the saved cache is absent.
  await realpath(join(p.workspacePath, ".lancer", "research-method-packages"));
  const root = await cacheRoot(p);
  for (const pkg of packages) {
    checkResearchMethodPackage(pkg, scope(p, pkg, "host-resume-cache"));
    const directory = await within(root, pkg.packageSha256);
    const saved = decodeResearchMethodPackage(
      await jsonFile(await within(directory, "package.json")),
    );
    if (!isDeepStrictEqual(saved, pkg)) throw new Error("缓存方法包与项目固定版本不一致。");
    for (const image of pkg.images.filter((entry) => entry.state === "bytes-readable"))
      await cachedImage(p, pkg, image.path);
  }
  return packages.map((pkg) => pkg.id);
}

function preserve<T extends { id: string; at: string }>(items: T[], item: T) {
  if ("kind" in item) {
    if (item.kind === "task-application") decodeResearchMethodApplication(item);
    else if (item.kind === "image-reading-report") decodeResearchMethodImageReading(item);
    else if (item.kind === "content-opinion") decodeResearchMethodContentOpinion(item);
    else if (item.kind === "mentor-adjudication") decodeResearchMethodAdjudication(item);
    else throw new Error("未知私有方法记录类型。");
  } else if ("mimeType" in item) decodeResearchMethodImageReceipt(item);
  else decodeResearchMethodPackageUse(item);
  const prior = items.find((entry) => entry.id === item.id);
  if (prior) {
    if (!isDeepStrictEqual(prior, { ...item, at: prior.at }))
      throw new Error("同一工具调用不能改变方法记录。");
    return prior;
  }
  items.push(structuredClone(item));
  return item;
}
function currentEvidence(p: MethodProject, identity: ResearchMethodActor) {
  if (identity.kind !== "model" || !identity.evidenceRef.startsWith("host-method:")) return false;
  try {
    const parsed: unknown = JSON.parse(identity.evidenceRef.slice("host-method:".length));
    const origin = fields(parsed, [
      "callId",
      "taskId",
      "taskVersion",
      "attemptId",
      "nativeRunId",
      "sessionId",
      "model",
    ]);
    const task = p.fusion?.tasks.find((entry) => entry.id === origin.taskId),
      attempt = p.fusion?.attempts.find((entry) => entry.id === origin.attemptId);
    return (
      !!task &&
      task.id.startsWith(`v${p.revision}:`) &&
      origin.taskVersion === task.inputVersion &&
      !!attempt &&
      attempt.taskId === task.id &&
      attempt.taskVersion === task.inputVersion &&
      attempt.nativeRunId === origin.nativeRunId &&
      isDeepStrictEqual(attempt.model, origin.model) &&
      identity.id === `model:${task.role}` &&
      p.members.some(
        (member) => member.role === task.role && member.ref.sessionId === origin.sessionId,
      ) &&
      [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].every((ref) =>
        p.fusion!.adoptedInputs.some(
          (input) => input.inputId === ref.inputId && input.version === ref.version,
        ),
      )
    );
  } catch {
    return false;
  }
}
export function isCurrentResearchMethodPackageUse(p: MethodProject, use: ResearchMethodPackageUse) {
  if (use.projectId !== p.id || use.revision !== p.revision) return false;
  return currentEvidence(p, {
    kind: "model",
    id: `model:${use.role}`,
    evidenceRef: `host-method:${JSON.stringify({ callId: use.callId, taskId: use.taskId, taskVersion: use.taskInputVersion, attemptId: use.attemptId, nativeRunId: use.nativeRunId, sessionId: use.sessionId, model: use.model })}`,
  });
}
/** Readiness at the actual opinion/adjudication time; later reads cannot retroactively justify it. */
export function researchMethodReviewReadiness(
  p: MethodProject,
  pkg: ResearchMethodPackage,
  identity: ResearchMethodActor,
  at: string,
  requireImages: boolean,
): string[] {
  if (!currentEvidence(p, identity)) return ["方法审阅实际身份或任务输入版本已失效。"];
  const origin = JSON.parse(identity.evidenceRef.slice("host-method:".length)) as {
    taskId: string;
    taskVersion: number;
    sessionId: string;
    model: unknown;
  };
  const issues: string[] = [];
  if (
    !(p.methodPackageUses ?? []).some(
      (use) =>
        use.packageId === pkg.id &&
        use.packageSha256 === pkg.packageSha256 &&
        use.taskId === origin.taskId &&
        use.taskInputVersion === origin.taskVersion &&
        use.sessionId === origin.sessionId &&
        isDeepStrictEqual(use.model, origin.model) &&
        !use.callId.startsWith("host-prepare:") &&
        Date.parse(use.at) <= Date.parse(at) &&
        isCurrentResearchMethodPackageUse(p, use),
    )
  )
    issues.push("支持/接受前必须由本人当前任务实际取得同版课程方法包正文。");
  if (!requireImages) return issues;
  for (const image of pkg.images) {
    const read = (p.methodImageReadings ?? []).some((reading) => {
      if (
        reading.projectId !== p.id ||
        reading.taskId !== origin.taskId ||
        reading.packageId !== pkg.id ||
        reading.packageSha256 !== pkg.packageSha256 ||
        reading.path !== image.path ||
        reading.imageSha256 !== image.actualSha256 ||
        !currentEvidence(p, reading.actor) ||
        Date.parse(reading.at) > Date.parse(at)
      )
        return false;
      const observation = JSON.parse(reading.actor.evidenceRef.slice("host-method:".length)) as {
        attemptId: string;
        nativeRunId: string;
        sessionId: string;
        model: unknown;
      };
      if (
        observation.sessionId !== origin.sessionId ||
        !isDeepStrictEqual(observation.model, origin.model)
      )
        return false;
      return (p.methodImageReceipts ?? []).some(
        (receipt) =>
          receipt.projectId === p.id &&
          receipt.packageId === pkg.id &&
          receipt.packageSha256 === pkg.packageSha256 &&
          receipt.path === image.path &&
          receipt.imageSha256 === image.actualSha256 &&
          receipt.bytes === image.bytes &&
          receipt.taskId === origin.taskId &&
          receipt.taskInputVersion === origin.taskVersion &&
          receipt.attemptId === observation.attemptId &&
          receipt.nativeRunId === observation.nativeRunId &&
          receipt.sessionId === origin.sessionId &&
          isDeepStrictEqual(receipt.model, origin.model) &&
          currentEvidence(p, receipt.actor) &&
          Date.parse(receipt.at) <= Date.parse(reading.at),
      );
    });
    if (image.state !== "bytes-readable" || !read)
      issues.push(
        `${image.path}: B支持前须有本人当前任务的实际图像返回凭据与后续读图观察，不能借用A观察。`,
      );
  }
  return issues;
}
function hasIndependent(p: MethodProject, role: ResearchRole, kind: "stage-risk" | "stage-draft") {
  const owner = current(p, role);
  return p.artifacts.some((artifact) => {
    const graph = p.fusion?.artifacts.find((item) => item.id === artifact.id);
    const sourceAttempt = p.fusion?.attempts.find((item) => item.id === graph?.attemptId);
    return (
      artifact.role === role &&
      artifact.stage === owner.task.stage &&
      artifact.revision === p.revision &&
      artifact.kind === kind &&
      !!graph &&
      graph.taskId === owner.task.id &&
      graph.taskVersion === owner.task.inputVersion &&
      graph.content === artifact.content &&
      !["superseded", "needs-review"].includes(graph.reviewState) &&
      sourceAttempt?.taskId === owner.task.id &&
      sourceAttempt.taskVersion === owner.task.inputVersion &&
      !!sourceAttempt.nativeRunId &&
      graph.inputRefs.every((ref) =>
        p.fusion!.adoptedInputs.some(
          (input) => input.inputId === ref.inputId && input.version === ref.version,
        ),
      )
    );
  });
}
function applicationFor(
  p: MethodProject,
  role: ResearchRole,
  id: unknown,
  pkg: ResearchMethodPackage,
) {
  const applicationId = text(id, "applicationId", 512),
    application = p.methodApplications?.find((entry) => entry.id === applicationId),
    owner = current(p, role);
  if (
    !application ||
    application.projectId !== p.id ||
    application.packageId !== pkg.id ||
    application.packageSha256 !== pkg.packageSha256 ||
    !currentEvidence(p, application.actor)
  )
    throw new Error("方法应用不属于当前项目/方法包。");
  const producer = p.fusion?.tasks.find((task) => task.id === application.taskId);
  const requiredIndependent =
    role === "reviewer" && producer?.role === "lead"
      ? "stage-risk"
      : role === "lead" && producer?.role === "reviewer"
        ? "stage-draft"
        : undefined;
  if (requiredIndependent && !hasIndependent(p, role, requiredIndependent))
    throw new Error(
      "请先发布本阶段当前输入版本的独立初判，再读取对方方法应用或读图观察/提交内容意见。",
    );
  const evidence: unknown = application.actor.evidenceRef.startsWith("host-method:")
    ? JSON.parse(application.actor.evidenceRef.slice("host-method:".length))
    : undefined;
  const origin = fields(evidence, [
    "callId",
    "taskId",
    "taskVersion",
    "attemptId",
    "nativeRunId",
    "sessionId",
    "model",
  ]);
  const attempt = p.fusion?.attempts.find((entry) => entry.id === origin.attemptId);
  if (
    !producer ||
    !producer.id.startsWith(`v${p.revision}:`) ||
    producer.stage !== owner.task.stage ||
    origin.taskId !== producer.id ||
    origin.taskVersion !== producer.inputVersion ||
    attempt?.taskId !== producer.id ||
    attempt.taskVersion !== producer.inputVersion ||
    attempt.nativeRunId !== origin.nativeRunId
  )
    throw new Error("方法应用的任务输入版本或审阅阶段已过期。");
  return application;
}
export async function applyMethodPackageTool(
  p: MethodProject,
  knowledge: ResearchKnowledge | undefined,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Promise<{
  result: unknown;
  detail?: string;
  media?: { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };
}> {
  text(callId, "宿主工具调用", 512);
  if (!Number.isFinite(Date.parse(at))) throw new Error("宿主实际时间无效。");
  const owner = current(p, role),
    before = token(p, role),
    actualActor = actor(p, role, callId),
    id = `method:${hash(`${p.id}:${role}:${callId}`).slice(0, 40)}`;
  const operation = text(input.operation, "operation", 100);
  assertCallOperation(p, role, callId, operation);
  if (operation === "method-package") {
    if (input.packageId !== undefined) {
      fields(input, ["operation", "packageId"]);
      const pkg = packageFor(p, input.packageId);
      const uses = structuredClone(p.methodPackageUses ?? []),
        use = preserve(uses, makeUse(p, role, pkg, callId, at, "method-package"));
      decodeResearchMethodProjectRecords({ ...projectRecords(p), methodPackageUses: uses });
      p.methodPackageUses = uses;
      return {
        result: {
          use,
          packageId: pkg.id,
          packageSha256: pkg.packageSha256,
          package: structuredClone(pkg),
          reused: true,
          boundary,
        },
      };
    }
    if (!knowledge)
      throw new Error("创建或升级方法包需要实际可用的固定知识库；旧包读取不需要当前知识库。");
    fields(input, ["operation", "query", "ids", "supersedesPackageId"]);
    const query = input.query === undefined ? "" : text(input.query, "query");
    if (
      input.ids !== undefined &&
      (!Array.isArray(input.ids) || input.ids.some((entry) => typeof entry !== "string"))
    )
      throw new Error("知识块ids无效。");
    const result = await prepare(
      p,
      knowledge,
      role,
      query,
      input.ids as string[] | undefined,
      at,
      input.supersedesPackageId === undefined
        ? undefined
        : text(input.supersedesPackageId, "supersedesPackageId", 512),
      callId,
      "method-package",
    );
    return {
      result,
      detail: `取得固定课程方法包 ${result.packageId}；${result.reused ? "复用同版" : "新建"}。`,
    };
  }
  const pkg = packageFor(p, input.packageId);
  const use = scope(p, pkg, owner.task.id),
    base = { ...use, id, at };
  if (operation === "method-read-image" || operation === "method-image-reading") {
    fields(
      input,
      operation === "method-read-image"
        ? ["operation", "packageId", "path"]
        : ["operation", "packageId", "path", "receiptId", "observations"],
    );
    const path = text(input.path, "path", 1000),
      read = await cachedImage(p, pkg, path);
    ensureToken(p, role, before);
    if (operation === "method-read-image") {
      const receipt: ResearchMethodImageReceipt = {
        ...base,
        path,
        imageSha256: read.image.actualSha256!,
        bytes: read.bytes.length,
        mimeType: read.mimeType,
        actor: actualActor,
        sessionId: owner.member.ref.sessionId,
        attemptId: owner.attempt.id,
        taskInputVersion: owner.task.inputVersion,
        nativeRunId: owner.attempt.nativeRunId!,
        model: structuredClone(owner.attempt.model!),
        callId,
      };
      const saved = preserve((p.methodImageReceipts ??= []), receipt);
      return {
        result: {
          receipt: saved,
          boundary:
            "返回图片字节供实际模型输入；未记录视觉理解，后续需method-image-reading提交具体观察。",
        },
        media: { type: "image", data: read.bytes.toString("base64"), mimeType: read.mimeType },
      };
    }
    const receiptId = text(input.receiptId, "receiptId", 512),
      receipt = p.methodImageReceipts?.find((entry) => entry.id === receiptId);
    if (
      !receipt ||
      receipt.projectId !== p.id ||
      receipt.packageId !== pkg.id ||
      receipt.packageSha256 !== pkg.packageSha256 ||
      receipt.path !== path ||
      receipt.imageSha256 !== read.image.actualSha256 ||
      receipt.attemptId !== owner.attempt.id ||
      receipt.nativeRunId !== owner.attempt.nativeRunId ||
      receipt.sessionId !== owner.member.ref.sessionId ||
      receipt.taskId !== owner.task.id ||
      receipt.taskInputVersion !== owner.task.inputVersion ||
      receipt.actor.id !== actualActor.id ||
      !isDeepStrictEqual(receipt.model, owner.attempt.model) ||
      receipt.callId === callId ||
      Date.parse(receipt.at) > Date.parse(at)
    )
      throw new Error("图像观察必须引用本次实际native中此前返回的同图凭据；不能自报已看图。");
    const reading = recordResearchMethodImageReading(
      pkg,
      { ...base, path, observations: text(input.observations, "observations") },
      actualActor,
      receipt.imageSha256,
    );
    return { result: { reading: preserve((p.methodImageReadings ??= []), reading), boundary } };
  }
  if (operation === "method-apply") {
    fields(input, [
      "operation",
      "packageId",
      "recordIds",
      "methodSelection",
      "applicabilityExplanation",
      "nonApplicableConditions",
      "limitations",
      "scoringClaim",
    ]);
    const { operation: ignored, packageId: ignoredPackage, ...request } = input;
    void ignored;
    void ignoredPackage;
    const application = recordResearchMethodApplication(
      pkg,
      { ...request, ...base } as Parameters<typeof recordResearchMethodApplication>[1],
      actualActor,
    );
    return {
      result: { application: preserve((p.methodApplications ??= []), application), boundary },
    };
  }
  if (operation === "method-opinion" || operation === "method-adjudicate") {
    fields(
      input,
      operation === "method-opinion"
        ? ["operation", "packageId", "applicationId", "verdict", "note"]
        : ["operation", "packageId", "applicationId", "opinionIds", "verdict", "note"],
    );
    if (role !== (operation === "method-opinion" ? "reviewer" : "mentor"))
      throw new Error("B内容意见和导师裁定只能由对应当前角色提交。");
    const application = applicationFor(p, role, input.applicationId, pkg),
      applicationBase = { ...base, taskId: application.taskId, applicationId: application.id };
    if (operation === "method-opinion") {
      if (input.verdict === "support") {
        const missing = researchMethodReviewReadiness(p, pkg, actualActor, at, true);
        if (missing.length) throw new Error(missing.join("；"));
      }
      const opinion = recordResearchMethodContentOpinion(
        pkg,
        application,
        { ...applicationBase, verdict: input.verdict, note: input.note } as Parameters<
          typeof recordResearchMethodContentOpinion
        >[2],
        actualActor,
      );
      return { result: { opinion: preserve((p.methodContentOpinions ??= []), opinion), boundary } };
    }
    if (input.verdict === "accept") {
      const missing = researchMethodReviewReadiness(p, pkg, actualActor, at, false);
      const latest = (p.methodContentOpinions ?? [])
        .filter(
          (opinion) =>
            opinion.applicationId === application.id && currentEvidence(p, opinion.actor),
        )
        .at(-1);
      if (
        !latest ||
        latest.verdict !== "support" ||
        !Array.isArray(input.opinionIds) ||
        !input.opinionIds.includes(latest.id)
      )
        missing.push("导师接受必须引用此应用最新的当前B支持意见。");
      if (latest)
        missing.push(...researchMethodReviewReadiness(p, pkg, latest.actor, latest.at, true));
      if (missing.length) throw new Error(missing.join("；"));
    }
    const adjudication = recordResearchMethodAdjudication(
      pkg,
      application,
      (p.methodContentOpinions ?? []).filter((entry) => currentEvidence(p, entry.actor)),
      {
        ...applicationBase,
        opinionIds: input.opinionIds,
        verdict: input.verdict,
        note: input.note,
      } as Parameters<typeof recordResearchMethodAdjudication>[3],
      actualActor,
    );
    return {
      result: { adjudication: preserve((p.methodAdjudications ??= []), adjudication), boundary },
    };
  }
  if (operation === "method-check") {
    fields(input, ["operation", "packageId", "applicationId"]);
    const application =
      input.applicationId === undefined
        ? undefined
        : applicationFor(p, role, input.applicationId, pkg);
    const check = checkResearchMethodPackage(
      pkg,
      application ? scope(p, pkg, application.taskId) : use,
      (p.methodImageReadings ?? []).filter((entry) => currentEvidence(p, entry.actor)),
    );
    const actualCacheIssues: string[] = [];
    for (const image of pkg.images.filter((entry) => entry.state === "bytes-readable")) {
      try {
        await cachedImage(p, pkg, image.path);
      } catch (error) {
        actualCacheIssues.push(
          `${image.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    ensureToken(p, role, before);
    const canReadOtherOpinions = role !== "lead" || hasIndependent(p, role, "stage-draft");
    return {
      result: {
        ...check,
        blockers: [...check.blockers, ...actualCacheIssues],
        actualCacheIssues,
        application: application ?? null,
        opinions: (p.methodContentOpinions ?? []).filter(
          (entry) =>
            canReadOtherOpinions &&
            entry.applicationId === application?.id &&
            currentEvidence(p, entry.actor),
        ),
        adjudications: (p.methodAdjudications ?? []).filter(
          (entry) =>
            canReadOtherOpinions &&
            entry.applicationId === application?.id &&
            currentEvidence(p, entry.actor),
        ),
        boundary,
      },
    };
  }
  throw new Error("未知方法包操作。");
}
