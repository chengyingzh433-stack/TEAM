import { assertResearchMethodFields, assertResearchMethodText } from "./research-method-packages";

export interface ResearchMethodProgramPackageCheck {
  packageId: string;
  packageSha256: string;
  taskId: string;
  taskInputVersion: number;
  applicationId?: string;
  imageReadings: { path: string; readingIds: string[] }[];
  opinionIds: string[];
  adjudicationIds: string[];
  issues: string[];
}
export interface ResearchMethodProgramCheck {
  id: string;
  at: string;
  programVersion: "method-acceptance-1";
  role: "lead" | "reviewer" | "mentor" | "librarian";
  revision: number;
  stage: string;
  callId: string;
  attemptId?: string;
  nativeRunId?: string;
  taskId?: string;
  taskInputVersion?: number;
  model?: { provider: string; modelId: string; thinkingLevel?: string };
  snapshotToken: string;
  target: { artifactId: string; bodySha256: string } | null;
  result: "blocked" | "passed-at-snapshot";
  packages: ResearchMethodProgramPackageCheck[];
  issues: string[];
}
export function decodeResearchMethodProgramChecks(value: unknown): ResearchMethodProgramCheck[] {
  if (!Array.isArray(value) || value.length > 20000) throw new Error("方法程序检查清单无效。");
  const ids = new Set<string>();
  const texts = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 20000) throw new Error("方法检查引用清单无效。");
    for (const item of v) assertResearchMethodText(item, "检查引用或问题", 10000);
  };
  const sha = (v: unknown) => {
    if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) throw new Error("方法检查摘要无效。");
  };
  const positive = (v: unknown) => {
    if (!Number.isSafeInteger(v) || Number(v) < 1) throw new Error("方法检查版本无效。");
  };
  for (const row of value) {
    assertResearchMethodFields(row, [
      "id",
      "at",
      "programVersion",
      "role",
      "revision",
      "stage",
      "callId",
      "attemptId",
      "nativeRunId",
      "taskId",
      "taskInputVersion",
      "model",
      "snapshotToken",
      "target",
      "result",
      "packages",
      "issues",
    ]);
    for (const key of ["id", "stage", "callId"]) assertResearchMethodText(row[key], key, 1024);
    if (
      ids.has(String(row.id)) ||
      row.programVersion !== "method-acceptance-1" ||
      !["lead", "reviewer", "mentor", "librarian"].includes(String(row.role)) ||
      typeof row.at !== "string" ||
      !Number.isFinite(Date.parse(row.at)) ||
      !["blocked", "passed-at-snapshot"].includes(String(row.result))
    )
      throw new Error("方法程序检查身份无效。");
    ids.add(String(row.id));
    positive(row.revision);
    sha(row.snapshotToken);
    for (const key of ["attemptId", "nativeRunId", "taskId"])
      if (row[key] !== undefined) assertResearchMethodText(row[key], key, 1024);
    if (row.taskInputVersion !== undefined) positive(row.taskInputVersion);
    if (row.model !== undefined) {
      assertResearchMethodFields(row.model, ["provider", "modelId", "thinkingLevel"]);
      assertResearchMethodText(row.model.provider, "provider", 512);
      assertResearchMethodText(row.model.modelId, "modelId", 512);
      if (row.model.thinkingLevel !== undefined)
        assertResearchMethodText(row.model.thinkingLevel, "thinkingLevel", 32);
    }
    if (row.target !== null) {
      assertResearchMethodFields(row.target, ["artifactId", "bodySha256"]);
      assertResearchMethodText(row.target.artifactId, "目标稿件", 512);
      sha(row.target.bodySha256);
    }
    texts(row.issues);
    if (!Array.isArray(row.packages) || row.packages.length > 300)
      throw new Error("方法程序检查缺少实际采用包。");
    const packageIds = new Set<string>();
    for (const pkg of row.packages) {
      assertResearchMethodFields(pkg, [
        "packageId",
        "packageSha256",
        "taskId",
        "taskInputVersion",
        "applicationId",
        "imageReadings",
        "opinionIds",
        "adjudicationIds",
        "issues",
      ]);
      assertResearchMethodText(pkg.packageId, "包", 512);
      assertResearchMethodText(pkg.taskId, "应用任务", 512);
      const packageKey = `${pkg.packageId}:${pkg.taskId}`;
      if (packageIds.has(packageKey)) throw new Error("方法程序检查采用包重复。");
      packageIds.add(packageKey);
      sha(pkg.packageSha256);
      positive(pkg.taskInputVersion);
      if (pkg.applicationId !== undefined)
        assertResearchMethodText(pkg.applicationId, "方法应用", 512);
      texts(pkg.opinionIds);
      texts(pkg.adjudicationIds);
      texts(pkg.issues);
      if (!Array.isArray(pkg.imageReadings)) throw new Error("方法图像检查记录无效。");
      const paths = new Set<string>();
      for (const image of pkg.imageReadings) {
        assertResearchMethodFields(image, ["path", "readingIds"]);
        assertResearchMethodText(image.path, "图片路径", 1000);
        if (paths.has(image.path)) throw new Error("方法检查图片路径重复。");
        paths.add(image.path);
        texts(image.readingIds);
      }
    }
    if (
      row.result === "passed-at-snapshot" &&
      (!row.target ||
        !["reviewer", "mentor"].includes(String(row.role)) ||
        !row.attemptId ||
        !row.nativeRunId ||
        !row.taskId ||
        row.taskInputVersion === undefined ||
        !row.model ||
        !row.packages.length ||
        (row.issues as unknown[]).length ||
        row.packages.some(
          (pkg) =>
            (pkg.issues as unknown[]).length ||
            !pkg.applicationId ||
            !(pkg.opinionIds as unknown[]).length ||
            (row.role === "mentor" && !(pkg.adjudicationIds as unknown[]).length) ||
            (pkg.imageReadings as { readingIds: unknown[] }[]).some(
              (image) => !image.readingIds.length,
            ),
        ))
    )
      throw new Error("存在方法阻断问题的记录不能保存为通过。");
    if (
      row.result === "blocked" &&
      !(row.issues as unknown[]).length &&
      !row.packages.some((pkg) => (pkg.issues as unknown[]).length)
    )
      throw new Error("阻断检查必须保留具体原因。");
  }
  return structuredClone(value) as ResearchMethodProgramCheck[];
}
