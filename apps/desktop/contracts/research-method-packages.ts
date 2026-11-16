/** Shared content contains course methods/cases only. Task material and decisions live elsewhere. */
export interface ResearchMethodPackageRecord {
  id: string;
  title: string;
  text: string;
  requiredContextIds: string[];
  imagePaths: string[];
  contentLayers: string[];
  boundaryNote?: string;
  /** Original course provenance, not independently verified empirical evidence. */
  provenance: Record<string, unknown>;
}
export interface ResearchMethodPackageImageReference {
  recordId: string;
  path: string;
  sourceRef: string;
}
export interface ResearchMethodPackageImage {
  path: string;
  references: ResearchMethodPackageImageReference[];
  expectedSha256?: string;
  actualSha256?: string;
  bytes?: number;
  state:
    | "bytes-readable"
    | "missing"
    | "unreadable"
    | "hash-mismatch"
    | "manifest-missing"
    | "unsafe-path";
}
export interface ResearchMethodPackage {
  id: string;
  createdAt: string;
  kind: "course-method-package";
  knowledge: { sha256: string; version: string; count: number };
  rootIds: string[];
  records: ResearchMethodPackageRecord[];
  images: ResearchMethodPackageImage[];
  /** Explicit change creates a new package; existing uses remain pinned to the old package. */
  supersedesPackageId?: string;
  contentSha256: string;
  packageSha256: string;
}
export interface ResearchMethodActor {
  kind: "model" | "user" | "external-expert";
  id: string;
  evidenceRef: string;
}
/** This project-local context must never be embedded in the shared package. */
export interface ResearchMethodUseScope {
  projectId: string;
  taskId: string;
  packageId: string;
  packageSha256: string;
}
export interface ResearchMethodImageReading extends ResearchMethodUseScope {
  id: string;
  kind: "image-reading-report";
  at: string;
  actor: ResearchMethodActor;
  path: string;
  imageSha256: string;
  observations: string;
}
export interface ResearchMethodApplication extends ResearchMethodUseScope {
  id: string;
  kind: "task-application";
  at: string;
  actor: ResearchMethodActor;
  recordIds: string[];
  methodSelection: string;
  applicabilityExplanation: string;
  nonApplicableConditions: string[];
  limitations: string;
  scoringClaim: "not-scored" | "partial-indicators-only";
}
export interface ResearchMethodContentOpinion extends ResearchMethodUseScope {
  id: string;
  kind: "content-opinion";
  role: "reviewer";
  at: string;
  actor: ResearchMethodActor;
  applicationId: string;
  verdict: "support" | "revise" | "hold";
  note: string;
}
export interface ResearchMethodAdjudication extends ResearchMethodUseScope {
  id: string;
  kind: "mentor-adjudication";
  role: "mentor";
  at: string;
  actor: ResearchMethodActor;
  applicationId: string;
  opinionIds: string[];
  verdict: "accept" | "revise" | "hold";
  note: string;
}
export function assertResearchMethodFields(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("方法包记录含未知或越权字段。");
}
export function assertResearchMethodText(
  value: unknown,
  label: string,
  max = 6000,
): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error(`${label}需要非空、有界文本。`);
}
export function decodeResearchMethodActor(value: unknown): ResearchMethodActor {
  assertResearchMethodFields(value, ["kind", "id", "evidenceRef"]);
  if (!["model", "user", "external-expert"].includes(String(value.kind)))
    throw new Error("方法审阅身份必须由宿主记录，不自动推定人类专家。");
  assertResearchMethodText(value.id, "身份", 512);
  assertResearchMethodText(value.evidenceRef, "出处", 3000);
  return structuredClone(value) as unknown as ResearchMethodActor;
}
export function decodeResearchMethodPackage(value: unknown): ResearchMethodPackage {
  assertResearchMethodFields(value, [
    "id",
    "createdAt",
    "kind",
    "knowledge",
    "rootIds",
    "records",
    "images",
    "supersedesPackageId",
    "contentSha256",
    "packageSha256",
  ]);
  assertResearchMethodText(value.id, "包身份", 512);
  if (
    value.kind !== "course-method-package" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error("方法包身份或时间无效。");
  assertResearchMethodFields(value.knowledge, ["sha256", "version", "count"]);
  const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (
    !hash(value.knowledge.sha256) ||
    !hash(value.contentSha256) ||
    !hash(value.packageSha256) ||
    !Number.isSafeInteger(value.knowledge.count) ||
    Number(value.knowledge.count) < 1
  )
    throw new Error("方法包版本摘要无效。");
  assertResearchMethodText(value.knowledge.version, "课程版本", 512);
  const strings = (v: unknown, label: string) => {
    if (!Array.isArray(v) || v.some((item) => typeof item !== "string" || !item.trim()))
      throw new Error(`${label}无效。`);
  };
  strings(value.rootIds, "根知识块");
  if (
    !(value.rootIds as string[]).length ||
    (value.rootIds as string[]).length > 8 ||
    new Set(value.rootIds as string[]).size !== (value.rootIds as string[]).length ||
    !Array.isArray(value.records) ||
    !value.records.length ||
    value.records.length > 40 ||
    !Array.isArray(value.images)
  )
    throw new Error("方法包范围无效。");
  const ids = new Set<string>();
  for (const row of value.records) {
    assertResearchMethodFields(row, [
      "id",
      "title",
      "text",
      "requiredContextIds",
      "imagePaths",
      "contentLayers",
      "boundaryNote",
      "provenance",
    ]);
    assertResearchMethodText(row.id, "知识块身份", 512);
    assertResearchMethodText(row.title, "知识块标题");
    assertResearchMethodText(row.text, "知识块原文", 100_000);
    if (ids.has(row.id)) throw new Error("知识块身份重复。");
    ids.add(row.id);
    strings(row.requiredContextIds, "必要上下文");
    strings(row.imagePaths, "图片路径");
    strings(row.contentLayers, "来源层次");
    if (row.boundaryNote !== undefined) assertResearchMethodText(row.boundaryNote, "资料边界");
    assertResearchMethodFields(row.provenance, [
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
    ]);
  }
  for (const image of value.images) {
    assertResearchMethodFields(image, [
      "path",
      "references",
      "expectedSha256",
      "actualSha256",
      "bytes",
      "state",
    ]);
    assertResearchMethodText(image.path, "图片路径", 1000);
    if (
      !Array.isArray(image.references) ||
      !image.references.length ||
      ![
        "bytes-readable",
        "missing",
        "unreadable",
        "hash-mismatch",
        "manifest-missing",
        "unsafe-path",
      ].includes(String(image.state)) ||
      (image.expectedSha256 !== undefined && !hash(image.expectedSha256)) ||
      (image.actualSha256 !== undefined && !hash(image.actualSha256)) ||
      (image.bytes !== undefined && (!Number.isSafeInteger(image.bytes) || Number(image.bytes) < 1))
    )
      throw new Error("图片字节记录无效。");
    if (
      image.state === "bytes-readable" &&
      (!image.expectedSha256 || image.expectedSha256 !== image.actualSha256 || !image.bytes)
    )
      throw new Error("图片字节可读状态必须有实际一致的清单摘要及字节数。");
    for (const ref of image.references) {
      assertResearchMethodFields(ref, ["recordId", "path", "sourceRef"]);
      assertResearchMethodText(ref.recordId, "图片关联知识块", 512);
      assertResearchMethodText(ref.sourceRef, "图片引用出处", 3000);
      if (ref.path !== image.path || !ids.has(ref.recordId))
        throw new Error("图片引用不属于本包。");
    }
  }
  if (value.supersedesPackageId !== undefined)
    assertResearchMethodText(value.supersedesPackageId, "前版方法包", 512);
  return structuredClone(value) as unknown as ResearchMethodPackage;
}

/** Host image transport receipt only. Bytes/base64 never persist in project state. */
export interface ResearchMethodImageReceipt extends ResearchMethodUseScope {
  id: string;
  path: string;
  imageSha256: string;
  bytes: number;
  mimeType: "image/png" | "image/jpeg";
  actor: ResearchMethodActor;
  sessionId: string;
  attemptId: string;
  taskInputVersion: number;
  nativeRunId: string;
  model: { provider: string; modelId: string; thinkingLevel?: string };
  callId: string;
  at: string;
}

/** Private project use of a package in one actual task attempt; never part of the shared package. */
export interface ResearchMethodPackageUse extends ResearchMethodUseScope {
  id: string;
  role: "lead" | "reviewer" | "mentor" | "librarian";
  revision: number;
  taskInputVersion: number;
  sessionId: string;
  attemptId: string;
  nativeRunId: string;
  model: { provider: string; modelId: string; thinkingLevel?: string };
  operation: "knowledge" | "method-package";
  callId: string;
  at: string;
}
export interface ResearchMethodProjectRecords {
  methodPackages?: ResearchMethodPackage[];
  methodPackageUses?: ResearchMethodPackageUse[];
  methodApplications?: ResearchMethodApplication[];
  methodImageReadings?: ResearchMethodImageReading[];
  methodContentOpinions?: ResearchMethodContentOpinion[];
  methodAdjudications?: ResearchMethodAdjudication[];
  methodImageReceipts?: ResearchMethodImageReceipt[];
}
const privateScopeKeys = ["id", "projectId", "taskId", "packageId", "packageSha256", "at"];
function methodHash(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("方法记录SHA无效。");
}
function methodImagePath(value: unknown) {
  assertResearchMethodText(value, "图像路径", 1000);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z]:/i.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("私有读图记录路径不安全。");
}
function methodPositive(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label}必须为正整数。`);
}
function methodTime(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("方法记录实际时间无效。");
}
function methodStrings(value: unknown, label: string, nonempty = false) {
  if (!Array.isArray(value) || value.length > 1000 || (nonempty && !value.length))
    throw new Error(`${label}清单无效。`);
  value.forEach((item: unknown) => assertResearchMethodText(item, label));
  if (new Set(value).size !== value.length) throw new Error(`${label}不能重复。`);
}
function privateScope(row: Record<string, unknown>) {
  for (const key of ["id", "projectId", "taskId", "packageId"])
    assertResearchMethodText(row[key], key, 512);
  methodHash(row.packageSha256);
  methodTime(row.at);
}
function methodModel(value: unknown) {
  assertResearchMethodFields(value, ["provider", "modelId", "thinkingLevel"]);
  assertResearchMethodText(value.provider, "实际provider", 512);
  assertResearchMethodText(value.modelId, "实际modelId", 512);
  if (value.thinkingLevel !== undefined)
    assertResearchMethodText(value.thinkingLevel, "实际thinkingLevel", 512);
}
export function decodeResearchMethodApplication(value: unknown): ResearchMethodApplication {
  assertResearchMethodFields(value, [
    ...privateScopeKeys,
    "kind",
    "actor",
    "recordIds",
    "methodSelection",
    "applicabilityExplanation",
    "nonApplicableConditions",
    "limitations",
    "scoringClaim",
  ]);
  privateScope(value);
  decodeResearchMethodActor(value.actor);
  methodStrings(value.recordIds, "应用知识块", true);
  methodStrings(value.nonApplicableConditions, "不适用条件");
  for (const key of ["methodSelection", "applicabilityExplanation", "limitations"])
    assertResearchMethodText(value[key], key);
  if (
    value.kind !== "task-application" ||
    !["not-scored", "partial-indicators-only"].includes(String(value.scoringClaim))
  )
    throw new Error("方法应用不能自称完整工具评分认证。");
  return structuredClone(value) as unknown as ResearchMethodApplication;
}
export function decodeResearchMethodImageReading(value: unknown): ResearchMethodImageReading {
  assertResearchMethodFields(value, [
    ...privateScopeKeys,
    "kind",
    "actor",
    "path",
    "imageSha256",
    "observations",
  ]);
  privateScope(value);
  decodeResearchMethodActor(value.actor);
  methodImagePath(value.path);
  methodHash(value.imageSha256);
  assertResearchMethodText(value.observations, "实际模型观察");
  if (value.kind !== "image-reading-report") throw new Error("读图记录类型无效。");
  return structuredClone(value) as unknown as ResearchMethodImageReading;
}
export function decodeResearchMethodContentOpinion(value: unknown): ResearchMethodContentOpinion {
  assertResearchMethodFields(value, [
    ...privateScopeKeys,
    "kind",
    "role",
    "actor",
    "applicationId",
    "verdict",
    "note",
  ]);
  privateScope(value);
  decodeResearchMethodActor(value.actor);
  assertResearchMethodText(value.applicationId, "应用身份", 512);
  assertResearchMethodText(value.note, "B内容意见");
  if (
    value.kind !== "content-opinion" ||
    value.role !== "reviewer" ||
    !["support", "revise", "hold"].includes(String(value.verdict))
  )
    throw new Error("B内容意见角色或结论无效。");
  return structuredClone(value) as unknown as ResearchMethodContentOpinion;
}
export function decodeResearchMethodAdjudication(value: unknown): ResearchMethodAdjudication {
  assertResearchMethodFields(value, [
    ...privateScopeKeys,
    "kind",
    "role",
    "actor",
    "applicationId",
    "opinionIds",
    "verdict",
    "note",
  ]);
  privateScope(value);
  decodeResearchMethodActor(value.actor);
  assertResearchMethodText(value.applicationId, "应用身份", 512);
  methodStrings(value.opinionIds, "B意见", true);
  assertResearchMethodText(value.note, "导师裁定");
  if (
    value.kind !== "mentor-adjudication" ||
    value.role !== "mentor" ||
    !["accept", "revise", "hold"].includes(String(value.verdict))
  )
    throw new Error("导师裁定角色或结论无效。");
  return structuredClone(value) as unknown as ResearchMethodAdjudication;
}
const nativeKeys = ["sessionId", "attemptId", "nativeRunId", "model", "callId", "taskInputVersion"];
function actualNative(row: Record<string, unknown>) {
  for (const key of ["sessionId", "attemptId", "nativeRunId", "callId"])
    assertResearchMethodText(row[key], key, 512);
  methodPositive(row.taskInputVersion, "任务输入版本");
  methodModel(row.model);
}
export function decodeResearchMethodImageReceipt(value: unknown): ResearchMethodImageReceipt {
  assertResearchMethodFields(value, [
    ...privateScopeKeys,
    ...nativeKeys,
    "path",
    "imageSha256",
    "bytes",
    "mimeType",
    "actor",
  ]);
  privateScope(value);
  actualNative(value);
  decodeResearchMethodActor(value.actor);
  methodImagePath(value.path);
  methodHash(value.imageSha256);
  methodPositive(value.bytes, "真实图像字节数");
  if (
    Number(value.bytes) > 25000000 ||
    !["image/png", "image/jpeg"].includes(String(value.mimeType))
  )
    throw new Error("实际图片类型或字节数无效。");
  return structuredClone(value) as unknown as ResearchMethodImageReceipt;
}
export function decodeResearchMethodPackageUse(value: unknown): ResearchMethodPackageUse {
  assertResearchMethodFields(value, [
    ...privateScopeKeys,
    ...nativeKeys,
    "role",
    "revision",
    "operation",
  ]);
  privateScope(value);
  actualNative(value);
  methodPositive(value.revision, "项目版本");
  if (
    !["lead", "reviewer", "mentor", "librarian"].includes(String(value.role)) ||
    !["knowledge", "method-package"].includes(String(value.operation))
  )
    throw new Error("方法包使用角色或宿主操作无效。");
  return structuredClone(value) as unknown as ResearchMethodPackageUse;
}
/** Pure persistence validation. Project/task/attempt cross-references remain the repository owner's responsibility. */
export function decodeResearchMethodProjectRecords(value: unknown): ResearchMethodProjectRecords {
  const decoders = {
    methodPackages: decodeResearchMethodPackage,
    methodPackageUses: decodeResearchMethodPackageUse,
    methodApplications: decodeResearchMethodApplication,
    methodImageReadings: decodeResearchMethodImageReading,
    methodContentOpinions: decodeResearchMethodContentOpinion,
    methodAdjudications: decodeResearchMethodAdjudication,
    methodImageReceipts: decodeResearchMethodImageReceipt,
  };
  assertResearchMethodFields(value, Object.keys(decoders));
  const result: Record<string, unknown> = {},
    ids = new Set<string>();
  for (const [key, decode] of Object.entries(decoders)) {
    const rows = value[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.length > 20000) throw new Error("方法私有记录清单无效。");
    result[key] = rows.map((row: unknown) => {
      const record = decode(row);
      if (ids.has(record.id)) throw new Error("方法记录身份重复。");
      ids.add(record.id);
      return record;
    });
  }
  const state = result as ResearchMethodProjectRecords;
  const packages = new Map((state.methodPackages ?? []).map((pkg) => [pkg.id, pkg]));
  const privateRecords = [
    ...(state.methodPackageUses ?? []),
    ...(state.methodApplications ?? []),
    ...(state.methodImageReadings ?? []),
    ...(state.methodContentOpinions ?? []),
    ...(state.methodAdjudications ?? []),
    ...(state.methodImageReceipts ?? []),
  ];
  for (const row of privateRecords) {
    const pkg = packages.get(row.packageId);
    if (!pkg || row.packageSha256 !== pkg.packageSha256)
      throw new Error("私有方法记录必须关联保存的同版方法包。");
    if (
      "recordIds" in row &&
      row.recordIds.some((id) => !pkg.records.some((record) => record.id === id))
    )
      throw new Error("应用知识块不在固定方法包中。");
    if ("imageSha256" in row) {
      const image = pkg.images.find((item) => item.path === row.path);
      if (
        !image ||
        image.state !== "bytes-readable" ||
        image.actualSha256 !== row.imageSha256 ||
        ("bytes" in row && row.bytes !== image.bytes)
      )
        throw new Error("读图记录必须关联固定包的实际图片版本。");
    }
  }
  const sameScope = (a: ResearchMethodUseScope, b: ResearchMethodUseScope) =>
    a.projectId === b.projectId &&
    a.taskId === b.taskId &&
    a.packageId === b.packageId &&
    a.packageSha256 === b.packageSha256;
  for (const row of [
    ...(state.methodContentOpinions ?? []),
    ...(state.methodAdjudications ?? []),
  ]) {
    const app = state.methodApplications?.find((item) => item.id === row.applicationId);
    if (!app || !sameScope(app, row)) throw new Error("B意见/导师裁定缺少同任务同包应用记录。");
    if (
      "opinionIds" in row &&
      row.opinionIds.some(
        (id) =>
          !state.methodContentOpinions?.some(
            (opinion) =>
              opinion.id === id && opinion.applicationId === app.id && sameScope(opinion, row),
          ),
      )
    )
      throw new Error("导师裁定引用的B意见不属于同一应用。");
  }
  return state;
}
