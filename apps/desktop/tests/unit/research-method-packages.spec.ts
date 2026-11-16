import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeResearchMethodPackage,
  type ResearchMethodApplication,
  type ResearchMethodContentOpinion,
  type ResearchMethodUseScope,
} from "../../contracts/research-method-packages";
import { ResearchKnowledge, type KnowledgeRecord } from "../../electron/research-group/knowledge";
import {
  checkResearchMethodPackage,
  createResearchMethodPackage,
  recordResearchMethodAdjudication,
  recordResearchMethodApplication,
  recordResearchMethodContentOpinion,
  recordResearchMethodImageReading,
  reuseOrCreateResearchMethodPackage,
} from "../../electron/research-group/method-packages";

const at = "2026-11-07T13:00:00.000Z";
const actor = {
  kind: "model" as const,
  id: "fixture-model-A",
  evidenceRef: "fixture:actual-tool-call",
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZqkAAAAASUVORK5CYII=",
  "base64",
);
async function fixture(
  options: { missing?: boolean; mismatch?: boolean; privateField?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "research-method-package-"));
  await Promise.all([
    mkdir(join(directory, "索引")),
    mkdir(join(directory, "溯源")),
    mkdir(join(directory, "素材", "原图"), { recursive: true }),
  ]);
  // Synthetic test excerpts model the real KB's field names and incomplete-rubric dependency.
  // This fixture is not evidence of visually reading the actual course screenshots.
  const records: KnowledgeRecord[] = [
    {
      id: "EDU-N02-2-5",
      title: "合成夹具：分级建议",
      text: "完整版总分的分级建议。原图只显示部分指标，不能据此计算完整版总分。",
      required_context_ids: ["EDU-N02-2-4"],
      image_paths: [],
      content_layers: ["course_paraphrase"],
      boundary_note: "部分截图不能计算完整版总分；分级建议不是统一硬规则。",
      source_file: "fixture-not-real-course.md",
      source_sha256: "a".repeat(64),
    },
    {
      id: "EDU-N02-2-4",
      title: "合成夹具：可见指标",
      text: "第一部分标题8项但完整展示5项；质性标题6项但展示4项；完整工具不可补造。原图p039至p042需一起核对。",
      required_context_ids: ["SOURCE-BOUNDARY"],
      image_paths: ["素材/原图/0801_p039.png"],
      content_layers: ["course_paraphrase", "note_commentary"],
      ...(options.privateField ? { privateDraft: "must not leak into shared content" } : {}),
    },
    {
      id: "SOURCE-BOUNDARY",
      title: "合成夹具：证据身份",
      text: "课程转述与案例不是当前课题的原始实证；完整评分工具尚未取得。",
      required_context_ids: [],
      image_paths: [],
      content_layers: ["worked_example_from_notes"],
      external_scholarship_verified: false,
    },
  ];
  const index = join(directory, "索引", "知识块.jsonl");
  await writeFile(index, records.map((record) => JSON.stringify(record)).join("\n"));
  await writeFile(
    join(directory, "溯源", "来源清单.json"),
    JSON.stringify({ version: "synthetic-1" }),
  );
  const paths = [39, 40, 41, 42].map((page) => `素材/原图/0801_p0${page}.png`);
  await writeFile(
    join(directory, "溯源", "图片清单.json"),
    JSON.stringify(paths.map((path) => ({ path, sha256: sha(imageBytes) }))),
  );
  for (const [index, path] of paths.entries())
    if (!(options.missing && index === 1))
      await writeFile(
        join(directory, path),
        options.mismatch && index === 2 ? Buffer.from("different fixture bytes") : imageBytes,
      );
  const knowledge = await ResearchKnowledge.open(directory),
    rootIds = ["EDU-N02-2-5"];
  const additionalImageReferences = paths.slice(1).map((path) => ({
    recordId: "EDU-N02-2-4",
    path,
    sourceRef: "fixture:explicit-host-reference-to-p039-p042-range",
  }));
  const input = {
    id: "method-package-1",
    at,
    knowledge,
    rootIds,
    retrievedRecords: knowledge.retrieve("", "reviewer", rootIds),
    additionalImageReferences,
  };
  return { input, records, directory, index, paths };
}
function scope(
  pkg: Awaited<ReturnType<typeof createResearchMethodPackage>>,
  projectId = "project-A",
): ResearchMethodUseScope {
  return { projectId, taskId: "design-task", packageId: pkg.id, packageSha256: pkg.packageSha256 };
}
function applicationInput(pkg: Awaited<ReturnType<typeof createResearchMethodPackage>>) {
  return {
    ...scope(pkg),
    id: "application-1",
    at,
    recordIds: ["EDU-N02-2-5", "EDU-N02-2-4"],
    methodSelection: "只采用可见质量指标作核查提纲",
    applicabilityExplanation: "用于追问原论文的报告完整性，不进行总分排名",
    nonApplicableConditions: ["完整工具未取得", "非追踪研究不套用流失指标"],
    limitations: "不能用截图部分条目冒充完整评分工具。",
    scoringClaim: "partial-indicators-only" as const,
  };
}

test("actual ResearchKnowledge.retrieve closure is pinned; incomplete rubric context and changed excerpts are rejected", async () => {
  const f = await fixture();
  expect(f.input.retrievedRecords.map((record) => record.id)).toEqual([
    "EDU-N02-2-5",
    "EDU-N02-2-4",
    "SOURCE-BOUNDARY",
  ]);
  await expect(
    createResearchMethodPackage({
      ...f.input,
      retrievedRecords: f.input.retrievedRecords.filter((record) => record.id !== "EDU-N02-2-4"),
    }),
  ).rejects.toThrow("必要上下文缺失");
  const altered = structuredClone(f.input.retrievedRecords);
  altered[0]!.text = "此处错误宣称完整工具可用";
  await expect(
    createResearchMethodPackage({ ...f.input, retrievedRecords: altered }),
  ).rejects.toThrow("实际retrieve");
  const pkg = await createResearchMethodPackage(f.input);
  expect(pkg.records.find((record) => record.id === "EDU-N02-2-5")!.boundaryNote).toContain(
    "不能计算完整版总分",
  );
  expect(pkg.records.find((record) => record.id === "SOURCE-BOUNDARY")!.contentLayers).toEqual([
    "worked_example_from_notes",
  ]);
  expect(pkg.knowledge.sha256).toBe(f.input.knowledge.pin.sha256);
  expect(JSON.stringify(pkg)).not.toContain(f.directory);
});

test("real file reads establish byte hashes only; image reading reports remain separate model identities", async () => {
  const f = await fixture(),
    pkg = await createResearchMethodPackage(f.input);
  expect(pkg.images.map((image) => image.path)).toEqual(f.paths);
  expect(
    pkg.images.every(
      (image) => image.state === "bytes-readable" && image.actualSha256 === sha(imageBytes),
    ),
  ).toBe(true);
  const initial = checkResearchMethodPackage(pkg, scope(pkg));
  expect(initial.blockers).toHaveLength(4);
  expect(initial.methodApplicability).toBe("not-assessed");
  expect(initial.fullInstrumentScoring).toBe("not-certified");
  const readings = pkg.images.map((image, index) =>
    recordResearchMethodImageReading(
      pkg,
      {
        ...scope(pkg),
        id: `reading-${index}`,
        at,
        path: image.path,
        observations: "合成单元夹具的读图报告，不代表实际课程图片已被视觉核查。",
      },
      actor,
      sha(imageBytes),
    ),
  );
  const after = checkResearchMethodPackage(pkg, scope(pkg), readings);
  expect(after.blockers).toEqual([]);
  expect(after.actor.kind).toBe("program");
  expect(after.images[0]!.readingReports[0]!.actor.kind).toBe("model");
  expect(after.fullInstrumentScoring).toBe("not-certified");
  expect(checkResearchMethodPackage(pkg, scope(pkg, "project-B"), readings).blockers).toHaveLength(
    4,
  );
  expect(JSON.stringify(pkg)).not.toContain("reading-0");
  expect(() =>
    recordResearchMethodImageReading(
      pkg,
      {
        ...scope(pkg),
        id: "wrong-read-bytes",
        at,
        path: pkg.images[0]!.path,
        observations: "宿主实际送入图像读取的字节已改变",
      },
      actor,
      "0".repeat(64),
    ),
  ).toThrow("变更");
});

test("missing images and mismatched bytes block integrity and cannot be reported as read", async () => {
  const f = await fixture({ missing: true, mismatch: true }),
    pkg = await createResearchMethodPackage(f.input);
  expect(pkg.images[1]!.state).toBe("missing");
  expect(pkg.images[2]!.state).toBe("hash-mismatch");
  expect(checkResearchMethodPackage(pkg, scope(pkg)).blockers).toEqual(
    expect.arrayContaining([`${f.paths[1]}: missing`, `${f.paths[2]}: hash-mismatch`]),
  );
  expect(() =>
    recordResearchMethodImageReading(
      pkg,
      {
        ...scope(pkg),
        id: "invalid-read",
        at,
        path: f.paths[1]!,
        observations: "不能为未取得图片伪造实际阅读",
      },
      actor,
      sha(imageBytes),
    ),
  ).toThrow("无法");
});

test("path traversal and symlink escape never read files outside the pinned course directory", async () => {
  const f = await fixture(),
    outside = await mkdtemp(join(tmpdir(), "method-package-outside-"));
  await writeFile(join(outside, "outside.png"), imageBytes);
  await symlink(join(outside, "outside.png"), join(f.directory, "escape.png"));
  const pkg = await createResearchMethodPackage({
    ...f.input,
    additionalImageReferences: [
      ...f.input.additionalImageReferences,
      { recordId: "EDU-N02-2-4", path: "../outside.png", sourceRef: "fixture:unsafe-path-test" },
      { recordId: "EDU-N02-2-4", path: "escape.png", sourceRef: "fixture:symlink-test" },
    ],
  });
  for (const path of ["../outside.png", "escape.png"]) {
    const image = pkg.images.find((item) => item.path === path)!;
    expect(image.state).toBe("unsafe-path");
    expect(image.actualSha256).toBeUndefined();
  }
});

test("same pin and roots reuse immutable content; a new pin requires explicit new package and leaves old task uses untouched", async () => {
  const f = await fixture(),
    first = await reuseOrCreateResearchMethodPackage([], f.input);
  const application = recordResearchMethodApplication(
    first.package,
    applicationInput(first.package),
    actor,
  );
  const old = structuredClone({ package: first.package, application });
  const reused = await reuseOrCreateResearchMethodPackage(first.packages, {
    ...f.input,
    id: "unused-new-id",
  });
  expect(reused.reused).toBe(true);
  expect(reused.package).toEqual(first.package);
  expect(reused.packages).toHaveLength(1);
  const updated = structuredClone(f.records);
  updated[0]!.text += " 新版补充：旧任务不得静默切换课程内容。";
  await writeFile(f.index, updated.map((record) => JSON.stringify(record)).join("\n"));
  const knowledge = await ResearchKnowledge.open(f.directory),
    input = {
      ...f.input,
      id: "method-package-2",
      knowledge,
      retrievedRecords: knowledge.retrieve("", "mentor", f.input.rootIds),
    };
  await expect(reuseOrCreateResearchMethodPackage(first.packages, input)).rejects.toThrow(
    "显式指定前版",
  );
  await expect(createResearchMethodPackage(f.input)).rejects.toThrow("索引已变化");
  const upgrade = await reuseOrCreateResearchMethodPackage(first.packages, {
    ...input,
    supersedesPackageId: first.package.id,
  });
  expect(upgrade.packages).toHaveLength(2);
  expect(upgrade.package.knowledge.sha256).not.toBe(first.package.knowledge.sha256);
  expect(first.package).toEqual(old.package);
  expect(application).toEqual(old.application);
  expect(upgrade.packages[0]).toEqual(first.package);
});

test("task application, program integrity, B content opinion and mentor adjudication retain different identities and scopes", async () => {
  const f = await fixture(),
    pkg = await createResearchMethodPackage(f.input);
  const application = recordResearchMethodApplication(pkg, applicationInput(pkg), actor);
  const b = {
    kind: "model" as const,
    id: "fixture-model-B",
    evidenceRef: "fixture:B-content-tool-call",
  };
  const opinion = recordResearchMethodContentOpinion(
    pkg,
    application,
    {
      ...scope(pkg),
      id: "B-opinion",
      at,
      applicationId: application.id,
      verdict: "support",
      note: "支持仅将可见条目作为提示，不能按完整工具总分评分。",
    },
    b,
  );
  const mentor = recordResearchMethodAdjudication(
    pkg,
    application,
    [opinion],
    {
      ...scope(pkg),
      id: "mentor-decision",
      at,
      applicationId: application.id,
      opinionIds: [opinion.id],
      verdict: "accept",
      note: "接受有限方法应用，不接受完整评分声明；仍需读图。",
    },
    { kind: "model", id: "fixture-mentor", evidenceRef: "fixture:mentor-tool-call" },
  );
  expect([
    application.kind,
    checkResearchMethodPackage(pkg, scope(pkg)).kind,
    opinion.kind,
    mentor.kind,
  ]).toEqual([
    "task-application",
    "program-integrity-check",
    "content-opinion",
    "mentor-adjudication",
  ]);
  expect(mentor.actor.kind).toBe("model");
  expect(() =>
    recordResearchMethodAdjudication(
      pkg,
      application,
      [checkResearchMethodPackage(pkg, scope(pkg)) as unknown as ResearchMethodContentOpinion],
      {
        ...scope(pkg),
        id: "bad-mentor",
        at,
        applicationId: application.id,
        opinionIds: ["program-check"],
        verdict: "accept",
        note: "不能用程序检查替代B",
      },
      actor,
    ),
  ).toThrow("程序检查不能代替");
  expect(() =>
    recordResearchMethodContentOpinion(
      pkg,
      application,
      {
        ...scope(pkg, "other-project"),
        id: "cross-project",
        at,
        applicationId: application.id,
        verdict: "support",
        note: "不允许跨项目夹带应用",
      },
      b,
    ),
  ).toThrow("同一项目");
  expect(JSON.stringify(pkg)).not.toContain(application.methodSelection);
  expect(() => decodeResearchMethodPackage({ ...pkg, application })).toThrow("越权");
});

test("partial indicator use cannot become complete scoring and private project fields cannot enter a shared package", async () => {
  const f = await fixture(),
    pkg = await createResearchMethodPackage(f.input),
    input = applicationInput(pkg);
  expect(() =>
    recordResearchMethodApplication(
      pkg,
      { ...input, scoringClaim: "full-instrument-completed" } as unknown as Omit<
        ResearchMethodApplication,
        "kind" | "actor"
      >,
      actor,
    ),
  ).toThrow("完整工具评分认证");
  expect(() =>
    recordResearchMethodApplication(pkg, { ...input, totalScore: 36 } as typeof input, actor),
  ).toThrow("越权");
  expect(() =>
    recordResearchMethodApplication(
      pkg,
      { ...input, actor: { kind: "user" } } as typeof input,
      actor,
    ),
  ).toThrow("越权");
  const privateFixture = await fixture({ privateField: true });
  await expect(createResearchMethodPackage(privateFixture.input)).rejects.toThrow("越权");
  const mutated = structuredClone(pkg);
  mutated.records[0]!.text += "偷偷覆盖原文";
  expect(() => checkResearchMethodPackage(mutated, scope(mutated))).toThrow("摘要已改变");
});
