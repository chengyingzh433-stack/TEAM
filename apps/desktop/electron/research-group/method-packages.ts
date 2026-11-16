import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ResearchKnowledge, type KnowledgeRecord } from "./knowledge";
import {
  assertResearchMethodFields,
  assertResearchMethodText,
  decodeResearchMethodActor,
  decodeResearchMethodPackage,
  type ResearchMethodActor,
  type ResearchMethodAdjudication,
  type ResearchMethodApplication,
  type ResearchMethodContentOpinion,
  type ResearchMethodImageReading,
  type ResearchMethodPackage,
  type ResearchMethodPackageImage,
  type ResearchMethodPackageImageReference,
  type ResearchMethodUseScope,
} from "../../contracts/research-method-packages";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));
const provenanceKeys = [
  "topic_id",
  "topic_title",
  "document_path",
  "source_file",
  "source_heading_path",
  "source_line_start",
  "source_line_end",
  "source_sha256",
  "pdf_locations",
  "external_scholarship_verified",
  "editorial_changes",
  "derived_from",
  "retrieval_kind",
];
const recordKeys = [
  "id",
  "title",
  "text",
  "required_context_ids",
  "image_paths",
  "content_layers",
  "boundary_note",
  "roles",
  "stages",
  "tags",
  ...provenanceKeys,
];
const safePath = (path: string) =>
  !!path &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !/^[a-z]:/i.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
const sameRoots = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const scopeKeys = ["projectId", "taskId", "packageId", "packageSha256"];
const baseKeys = ["id", "at", ...scopeKeys];
function time(at: string) {
  if (!Number.isFinite(Date.parse(at))) throw new Error("需要实际记录时间。");
}
function reachable(records: { id: string; requiredContextIds: string[] }[], roots: string[]) {
  const reached = new Set<string>(),
    missing = new Set<string>();
  const visit = (id: string) => {
    if (reached.has(id)) return;
    const row = records.find((record) => record.id === id);
    if (!row) {
      missing.add(id);
      return;
    }
    reached.add(id);
    row.requiredContextIds.forEach(visit);
  };
  roots.forEach(visit);
  return { reached, missing: [...missing] };
}
function packageContents(pkg: ResearchMethodPackage) {
  return {
    knowledge: pkg.knowledge,
    rootIds: pkg.rootIds,
    records: pkg.records,
    images: pkg.images,
  };
}
function assertPackage(pkg: ResearchMethodPackage) {
  decodeResearchMethodPackage(pkg);
  const { packageSha256, ...contents } = pkg;
  if (digest(contents) !== packageSha256 || digest(packageContents(pkg)) !== pkg.contentSha256)
    throw new Error("方法包原文或版本摘要已改变，不能改写旧包。");
  const closure = reachable(pkg.records, pkg.rootIds);
  if (closure.missing.length || closure.reached.size !== pkg.records.length)
    throw new Error("必要上下文缺失或混入无关记录。");
  if (
    new Set(pkg.images.map((image) => image.path)).size !== pkg.images.length ||
    pkg.records.some((record) =>
      record.imagePaths.some(
        (path) =>
          !pkg.images.some(
            (image) =>
              image.path === path && image.references.some((ref) => ref.recordId === record.id),
          ),
      ),
    )
  )
    throw new Error("结构化图片引用缺失或图片身份重复。");
}
async function fileWithin(directory: string, path: string): Promise<string> {
  if (!safePath(path)) throw new Error("unsafe-path");
  const root = await realpath(directory),
    target = await realpath(join(root, path)),
    rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("unsafe-path");
  return target;
}
async function readImage(
  directory: string,
  path: string,
  references: ResearchMethodPackageImageReference[],
  manifest: Map<string, string>,
): Promise<ResearchMethodPackageImage> {
  const expectedSha256 = manifest.get(path),
    base = { path, references, ...(expectedSha256 ? { expectedSha256 } : {}) };
  if (!safePath(path)) return { ...base, state: "unsafe-path" };
  try {
    const file = await fileWithin(directory, path),
      info = await stat(file);
    if (!info.isFile() || info.size < 1 || info.size > 25_000_000)
      return { ...base, state: "unreadable" };
    const bytes = await readFile(file),
      actualSha256 = sha(bytes);
    return {
      ...base,
      actualSha256,
      bytes: bytes.length,
      state: !expectedSha256
        ? "manifest-missing"
        : expectedSha256 === actualSha256
          ? "bytes-readable"
          : "hash-mismatch",
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return {
      ...base,
      state:
        error instanceof Error && error.message === "unsafe-path"
          ? "unsafe-path"
          : code === "ENOENT"
            ? "missing"
            : "unreadable",
    };
  }
}
export interface CreateResearchMethodPackageInput {
  id: string;
  at: string;
  knowledge: ResearchKnowledge;
  rootIds: string[];
  /** Pass the actual retrieve result; the host checks it against this pinned adapter. */
  retrievedRecords: KnowledgeRecord[];
  /** Explicit host-resolved references where image_paths is incomplete; never inferred from prose. */
  additionalImageReferences?: ResearchMethodPackageImageReference[];
  supersedesPackageId?: string;
}
export async function createResearchMethodPackage(
  input: CreateResearchMethodPackageInput,
): Promise<ResearchMethodPackage> {
  assertResearchMethodText(input.id, "方法包身份", 512);
  time(input.at);
  if (
    !input.rootIds.length ||
    input.rootIds.length > 8 ||
    new Set(input.rootIds).size !== input.rootIds.length
  )
    throw new Error("方法包需要1–8个不重复根知识块。");
  await input.knowledge.assertPinned(input.knowledge.pin);
  const actual = input.knowledge.retrieve("", "mentor", input.rootIds);
  const closure = reachable(
    input.retrievedRecords.map((record) => ({
      id: record.id,
      requiredContextIds: record.required_context_ids,
    })),
    input.rootIds,
  );
  if (closure.missing.length) throw new Error(`必要上下文缺失：${closure.missing.join("、")}`);
  if (
    !isDeepStrictEqual(
      [...actual].sort((a, b) => a.id.localeCompare(b.id)),
      [...input.retrievedRecords].sort((a, b) => a.id.localeCompare(b.id)),
    )
  )
    throw new Error("传入记录不是此pin实际retrieve的完整原文，不能伪造或拼入项目内容。");
  const records = actual
    .map((record) => {
      assertResearchMethodFields(record, recordKeys);
      const images = record.image_paths ?? [],
        layers = record.content_layers ?? [];
      if (
        !Array.isArray(images) ||
        images.some((path) => typeof path !== "string") ||
        !Array.isArray(layers) ||
        layers.some((layer) => typeof layer !== "string")
      )
        throw new Error("课程图片或内容层次字段无效。");
      return {
        id: record.id,
        title: record.title,
        text: record.text,
        requiredContextIds: [...record.required_context_ids],
        imagePaths: (images as string[]).slice(),
        contentLayers: (layers as string[]).slice(),
        ...(typeof record.boundary_note === "string" ? { boundaryNote: record.boundary_note } : {}),
        provenance: Object.fromEntries(
          provenanceKeys
            .filter((key) => record[key] !== undefined)
            .map((key) => [key, structuredClone(record[key])]),
        ),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const references = records.flatMap((record) =>
    record.imagePaths.map((path) => ({
      recordId: record.id,
      path,
      sourceRef: `knowledge:${record.id}:image_paths`,
    })),
  );
  for (const ref of input.additionalImageReferences ?? []) {
    assertResearchMethodFields(ref, ["recordId", "path", "sourceRef"]);
    if (!records.some((record) => record.id === ref.recordId))
      throw new Error("补充图片必须关联本包实际知识块。");
    assertResearchMethodText(ref.path, "图片路径", 1000);
    assertResearchMethodText(ref.sourceRef, "补充图片定位", 3000);
    references.push(structuredClone(ref));
  }
  const manifest = new Map<string, string>();
  if (references.length) {
    try {
      const file = await fileWithin(input.knowledge.pin.directory, "溯源/图片清单.json");
      if ((await stat(file)).size > 1_000_000) throw new Error("图片清单过大。");
      const entries: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(entries)) throw new Error("图片清单格式无效。");
      for (const entry of entries as unknown[]) {
        assertResearchMethodFields(entry, [
          "path",
          "sha256",
          "source_filename",
          "source_relative_path",
        ]);
        if (
          !entry ||
          typeof entry.path !== "string" ||
          !safePath(entry.path) ||
          typeof entry.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          manifest.has(entry.path)
        )
          throw new Error("图片清单路径、摘要或唯一身份无效。");
        manifest.set(entry.path, entry.sha256);
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
  }
  const images = await Promise.all(
    [...new Set(references.map((ref) => ref.path))].sort().map((path) =>
      readImage(
        input.knowledge.pin.directory,
        path,
        references.filter((ref) => ref.path === path),
        manifest,
      ),
    ),
  );
  await input.knowledge.assertPinned(input.knowledge.pin);
  const content = {
    knowledge: {
      sha256: input.knowledge.pin.sha256,
      version: input.knowledge.pin.version,
      count: input.knowledge.pin.count,
    },
    rootIds: [...input.rootIds].sort(),
    records,
    images,
  };
  const contents = {
    id: input.id,
    createdAt: input.at,
    kind: "course-method-package" as const,
    ...content,
    ...(input.supersedesPackageId ? { supersedesPackageId: input.supersedesPackageId } : {}),
    contentSha256: digest(content),
  };
  return decodeResearchMethodPackage({ ...contents, packageSha256: digest(contents) });
}
/** Rechecks current image bytes. Reuse never replaces a package already referenced by a task. */
export async function reuseOrCreateResearchMethodPackage(
  packages: ResearchMethodPackage[],
  input: CreateResearchMethodPackageInput,
) {
  packages.forEach(assertPackage);
  const candidate = await createResearchMethodPackage(input);
  const existing = packages.find(
    (pkg) =>
      pkg.contentSha256 === candidate.contentSha256 && sameRoots(pkg.rootIds, candidate.rootIds),
  );
  if (existing)
    return {
      package: structuredClone(existing),
      packages: structuredClone(packages),
      reused: true,
    };
  if (packages.some((pkg) => pkg.id === candidate.id))
    throw new Error("新方法包必须使用新身份，旧包不能覆盖。");
  const previous = packages.filter((pkg) => sameRoots(pkg.rootIds, candidate.rootIds));
  if (previous.length && !previous.some((pkg) => pkg.id === input.supersedesPackageId))
    throw new Error("课程pin或图片已变化；显式指定前版创建新包，不能自动更新旧任务。");
  if (input.supersedesPackageId && !previous.some((pkg) => pkg.id === input.supersedesPackageId))
    throw new Error("前版方法包不属于相同根知识块范围。");
  return { package: candidate, packages: [...structuredClone(packages), candidate], reused: false };
}
function useBase(
  pkg: ResearchMethodPackage,
  input: ResearchMethodUseScope & { id: string; at: string },
  actor: ResearchMethodActor,
) {
  assertPackage(pkg);
  time(input.at);
  for (const key of ["id", "projectId", "taskId"] as const)
    assertResearchMethodText(input[key], key, 512);
  if (input.packageId !== pkg.id || input.packageSha256 !== pkg.packageSha256)
    throw new Error("任务应用必须固定所读方法包身份及版本。");
  return { ...structuredClone(input), actor: decodeResearchMethodActor(actor) };
}
export function recordResearchMethodImageReading(
  pkg: ResearchMethodPackage,
  input: Omit<ResearchMethodImageReading, "kind" | "actor" | "imageSha256">,
  actor: ResearchMethodActor,
  /** Digest from the actual host image-read result, not a model assertion or package lookup. */
  observedImageSha256: string,
): ResearchMethodImageReading {
  assertResearchMethodFields(input, [...baseKeys, "path", "observations"]);
  const base = useBase(pkg, input, actor),
    image = pkg.images.find((item) => item.path === input.path);
  if (
    !image ||
    image.state !== "bytes-readable" ||
    !image.actualSha256 ||
    observedImageSha256 !== image.actualSha256
  )
    throw new Error("无法为缺失、变更或不可读图片记录本包图像阅读。");
  assertResearchMethodText(input.observations, "实际读图观察");
  return {
    ...base,
    kind: "image-reading-report",
    path: input.path,
    imageSha256: image.actualSha256,
    observations: input.observations,
  };
}
export function recordResearchMethodApplication(
  pkg: ResearchMethodPackage,
  input: Omit<ResearchMethodApplication, "kind" | "actor">,
  actor: ResearchMethodActor,
): ResearchMethodApplication {
  assertResearchMethodFields(input, [
    ...baseKeys,
    "recordIds",
    "methodSelection",
    "applicabilityExplanation",
    "nonApplicableConditions",
    "limitations",
    "scoringClaim",
  ]);
  const base = useBase(pkg, input, actor);
  if (
    !Array.isArray(input.recordIds) ||
    !input.recordIds.length ||
    input.recordIds.some((id) => !pkg.records.some((record) => record.id === id)) ||
    !Array.isArray(input.nonApplicableConditions) ||
    input.nonApplicableConditions.some(
      (condition) => typeof condition !== "string" || !condition.trim(),
    ) ||
    !["not-scored", "partial-indicators-only"].includes(input.scoringClaim)
  )
    throw new Error("方法应用需指定实际知识块与不适用条件；课程包不支持完整工具评分认证。");
  for (const key of ["methodSelection", "applicabilityExplanation", "limitations"] as const)
    assertResearchMethodText(input[key], key);
  return {
    ...base,
    kind: "task-application",
    recordIds: [...input.recordIds],
    methodSelection: input.methodSelection,
    applicabilityExplanation: input.applicabilityExplanation,
    nonApplicableConditions: [...input.nonApplicableConditions],
    limitations: input.limitations,
    scoringClaim: input.scoringClaim,
  };
}
function matchesUse(left: ResearchMethodUseScope, right: ResearchMethodUseScope) {
  return scopeKeys.every(
    (key) =>
      left[key as keyof ResearchMethodUseScope] === right[key as keyof ResearchMethodUseScope],
  );
}
export function recordResearchMethodContentOpinion(
  pkg: ResearchMethodPackage,
  application: ResearchMethodApplication,
  input: Omit<ResearchMethodContentOpinion, "kind" | "role" | "actor">,
  actor: ResearchMethodActor,
): ResearchMethodContentOpinion {
  assertResearchMethodFields(input, [...baseKeys, "applicationId", "verdict", "note"]);
  const base = useBase(pkg, input, actor);
  if (
    application.kind !== "task-application" ||
    application.id !== input.applicationId ||
    !matchesUse(application, input) ||
    !["support", "revise", "hold"].includes(input.verdict)
  )
    throw new Error("B内容意见必须关联同一项目任务的实际应用记录。");
  assertResearchMethodText(input.note, "B内容意见");
  return {
    ...base,
    kind: "content-opinion",
    role: "reviewer",
    applicationId: input.applicationId,
    verdict: input.verdict,
    note: input.note,
  };
}
export function recordResearchMethodAdjudication(
  pkg: ResearchMethodPackage,
  application: ResearchMethodApplication,
  opinions: ResearchMethodContentOpinion[],
  input: Omit<ResearchMethodAdjudication, "kind" | "role" | "actor">,
  actor: ResearchMethodActor,
): ResearchMethodAdjudication {
  assertResearchMethodFields(input, [
    ...baseKeys,
    "applicationId",
    "opinionIds",
    "verdict",
    "note",
  ]);
  const base = useBase(pkg, input, actor);
  if (
    application.id !== input.applicationId ||
    !matchesUse(application, input) ||
    !Array.isArray(input.opinionIds) ||
    !input.opinionIds.length ||
    input.opinionIds.some(
      (id) =>
        !opinions.some(
          (opinion) =>
            opinion.kind === "content-opinion" &&
            opinion.role === "reviewer" &&
            opinion.id === id &&
            opinion.applicationId === application.id &&
            matchesUse(opinion, input),
        ),
    ) ||
    !["accept", "revise", "hold"].includes(input.verdict)
  )
    throw new Error("导师裁定必须引用同一应用的B内容意见，程序检查不能代替内容审阅。");
  assertResearchMethodText(input.note, "导师裁定理由");
  return {
    ...base,
    kind: "mentor-adjudication",
    role: "mentor",
    applicationId: input.applicationId,
    opinionIds: [...input.opinionIds],
    verdict: input.verdict,
    note: input.note,
  };
}
export function checkResearchMethodPackage(
  pkg: ResearchMethodPackage,
  scope: ResearchMethodUseScope,
  imageReadings: ResearchMethodImageReading[] = [],
) {
  assertPackage(pkg);
  if (scope.packageId !== pkg.id || scope.packageSha256 !== pkg.packageSha256)
    throw new Error("程序检查须固定本次任务方法包版本。");
  for (const reading of imageReadings.filter((item) => matchesUse(item, scope))) {
    assertResearchMethodText(reading.id, "读图记录身份", 512);
    assertResearchMethodText(reading.observations, "实际读图观察");
    time(reading.at);
  }
  const images = pkg.images.map((image) => ({
    path: image.path,
    byteState: image.state,
    readingReports: imageReadings
      .filter(
        (reading) =>
          reading.kind === "image-reading-report" &&
          matchesUse(reading, scope) &&
          reading.path === image.path &&
          reading.imageSha256 === image.actualSha256,
      )
      .map((reading) => ({
        id: reading.id,
        actor: decodeResearchMethodActor(reading.actor),
        observations: reading.observations,
      })),
  }));
  return {
    kind: "program-integrity-check" as const,
    actor: { kind: "program" as const, id: "method-packages-1" },
    ...structuredClone(scope),
    requiredContextComplete: true,
    images,
    blockers: images.flatMap((image) =>
      image.byteState !== "bytes-readable"
        ? [`${image.path}: ${image.byteState}`]
        : !image.readingReports.length
          ? [`${image.path}: 未记录实际图像阅读`]
          : [],
    ),
    methodApplicability: "not-assessed" as const,
    fullInstrumentScoring: "not-certified" as const,
    sourceIdentity: "课程方法/笔记解释/案例；不是当前课题原始实证" as const,
    boundary:
      "程序仅检查上下文和所列图片字节/阅读记录完整性，不判断方法适用或完整工具评分；读图记录保留声明者身份，不冒充程序视觉核验。image_paths可能不完整，正文图范围须另作内容审阅与显式补充。",
  };
}
