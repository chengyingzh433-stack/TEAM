import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESEARCH_ROLES,
  type ResearchRole,
  type ResearchArtifact,
} from "../../contracts/research-group";
import { ResearchKnowledge, type KnowledgeRecord } from "../../electron/research-group/knowledge";
import {
  prepareFusionDelivery,
  dispatchFusionAttempt,
  bindFusionNativeRun,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import {
  applyMethodPackageTool,
  prepareMethodPackage,
  type MethodProject,
} from "../../electron/research-group/method-package-tools";
import {
  decodeResearchMethodProjectRecords,
  type ResearchMethodApplication,
  type ResearchMethodContentOpinion,
} from "../../contracts/research-method-packages";

const at = (n: number) => new Date(Date.UTC(2026, 10, 7, 22, 0, n)).toISOString();
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZqkAAAAASUVORK5CYII=",
  "base64",
);
const imagePath = "素材/原图/0801_p039.png";
async function fixture(options: { bytes?: Buffer; missing?: boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "method-package-host-")),
    directory = join(workspace, "synthetic-course");
  await mkdir(join(directory, "索引"), { recursive: true });
  await mkdir(join(directory, "溯源"), { recursive: true });
  await mkdir(join(directory, "素材", "原图"), { recursive: true });
  // Synthetic course/native identity fixture, not a real model or actual course visual review.
  const records: KnowledgeRecord[] = [
    {
      id: "EDU-N02-2-5",
      title: "合成评分范围",
      text: "仅作指标参考，必须同时读必要上下文。",
      required_context_ids: ["EDU-N02-2-4"],
      image_paths: [],
      content_layers: ["course_paraphrase"],
    },
    {
      id: "EDU-N02-2-4",
      title: "合成部分指标",
      text: "截图部分指标不能算完整版总分。",
      required_context_ids: [],
      image_paths: [imagePath],
      content_layers: ["note_commentary"],
    },
  ];
  const index = join(directory, "索引", "知识块.jsonl"),
    image = join(directory, imagePath),
    bytes = options.bytes ?? png;
  await writeFile(index, records.map((record) => JSON.stringify(record)).join("\n"));
  await writeFile(
    join(directory, "溯源", "来源清单.json"),
    JSON.stringify({ version: "synthetic-v1" }),
  );
  await writeFile(
    join(directory, "溯源", "图片清单.json"),
    JSON.stringify([{ path: imagePath, sha256: sha(bytes) }]),
  );
  if (!options.missing) await writeFile(image, bytes);
  const knowledge = await ResearchKnowledge.open(directory);
  const makeProject = (id = randomUUID()) => {
    const p: MethodProject = {
      id,
      root: { workspaceId: workspace, sessionId: `${id}-mentor` },
      workspacePath: workspace,
      objective: "PRIVATE-PROJECT-DRAFT must never enter shared method cache",
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
      knowledge: structuredClone(knowledge.pin),
      members: RESEARCH_ROLES.map((role) => ({
        role,
        ref: { workspaceId: workspace, sessionId: `${id}-${role}` },
        status: "idle",
      })),
      stages: [
        {
          id: "design",
          title: "合成方案",
          goal: "合成方案宿主测试",
          deliverables: "合成测试方法应用",
          models: Object.fromEntries(
            RESEARCH_ROLES.map((role) => [
              role,
              { provider: "synthetic-provider", modelId: `synthetic-${role}` },
            ]),
          ),
        },
      ],
      artifacts: [],
      packets: [],
      events: [],
    };
    for (const role of ["lead", "reviewer", "mentor"] as const) {
      const delivery = prepareFusionDelivery(
        p,
        role,
        `${id}-${role}-attempt`,
        at(0),
        "合成宿主状态，非E/R运行证明",
      );
      expect(delivery.kind).toBe("dispatch");
      dispatchFusionAttempt(p, delivery.attemptId!, at(0));
      bindFusionNativeRun(p, role, `${id}-${role}-native`);
    }
    return p;
  };
  const p = makeProject();
  let serial = 10;
  const tool = (role: ResearchRole, input: Record<string, unknown>, callId = `call-${++serial}`) =>
    applyMethodPackageTool(p, knowledge, role, callId, input, at(++serial));
  return { p, knowledge, directory, index, image, records, workspace, makeProject, tool };
}
async function readySupport(s: Awaited<ReturnType<typeof fixture>>, packageId: string) {
  await s.tool("reviewer", { operation: "method-package", packageId });
  await s.tool("reviewer", { operation: "method-read-image", packageId, path: imagePath });
  const receipt = s.p.methodImageReceipts!.at(-1)!;
  await s.tool("reviewer", {
    operation: "method-image-reading",
    packageId,
    path: imagePath,
    receiptId: receipt.id,
    observations: "B本人的合成像素图观察，不借A报告",
  });
}
function publishRisk(p: MethodProject, role: "lead" | "reviewer" = "reviewer") {
  const artifact: ResearchArtifact = {
    id: `risk-${randomUUID()}`,
    role,
    kind: role === "reviewer" ? "stage-risk" : "stage-draft",
    revision: p.revision,
    round: 1,
    createdAt: at(5),
    content: `合成${role}先独立判断，尚未读取对方私有方法解释。`,
    refs: [],
    sourceIds: [],
    analysisIds: [],
    toolCallId: "synthetic-risk-publication",
    stage: "design",
  };
  p.artifacts.push(artifact);
  publishFusionArtifact(p, artifact);
  return artifact;
}
function privateRecords(p: MethodProject) {
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
const applicationRequest = (packageId: string) => ({
  operation: "method-apply",
  packageId,
  recordIds: ["EDU-N02-2-5", "EDU-N02-2-4"],
  methodSelection: "将可见指标作为方法核查提纲",
  applicabilityExplanation: "仅评议报告完整性，不据此计算总分",
  nonApplicableConditions: ["完整评分表未取得"],
  limitations: "课程方法和案例不能替代原始实证",
  scoringClaim: "partial-indicators-only",
});

test("retrieve wrapper preserves exact closure and roots; shared cache contains only method material across projects", async () => {
  const s = await fixture();
  const retrieved = s.knowledge.retrieveWithRoots("", "lead", ["EDU-N02-2-5"]);
  expect(retrieved.rootIds).toEqual(["EDU-N02-2-5"]);
  expect(retrieved.records).toEqual(s.knowledge.retrieve("", "lead", ["EDU-N02-2-5"]));
  const first = await prepareMethodPackage(s.p, s.knowledge, "lead", "", retrieved.rootIds, at(2));
  const second = await prepareMethodPackage(
    s.p,
    s.knowledge,
    "reviewer",
    "",
    retrieved.rootIds,
    at(3),
  );
  expect(second.packageId).toBe(first.packageId);
  expect(second.reused).toBe(true);
  expect(s.p.methodPackages).toHaveLength(1);
  // Real course supplemental p040–42 refs must NOT be generalized to a same-ID synthetic pin.
  expect(first.package.images.map((image) => image.path)).toEqual([imagePath]);
  const other = s.makeProject();
  const reused = await prepareMethodPackage(
    other,
    s.knowledge,
    "lead",
    "",
    retrieved.rootIds,
    at(4),
  );
  expect(reused.packageId).toBe(first.packageId);
  const cache = join(s.workspace, ".lancer", "research-method-packages", first.packageSha256);
  const shared = await readFile(join(cache, "package.json"), "utf8");
  expect(shared).not.toContain(s.p.id);
  expect(shared).not.toContain("PRIVATE-PROJECT-DRAFT");
  expect(shared).not.toContain("sessionId");
  expect(await readFile(join(cache, "images", imagePath))).toEqual(png);
  expect(await readdir(cache)).toEqual(expect.arrayContaining(["images", "package.json"]));
  expect(await readFile(s.index, "utf8")).toBe(
    s.records.map((record) => JSON.stringify(record)).join("\n"),
  );
});

test("actual cached image transport, later model observations and integrity checks are distinct and idempotent", async () => {
  const s = await fixture(),
    prepared = await prepareMethodPackage(s.p, s.knowledge, "lead", "", ["EDU-N02-2-5"], at(2));
  const base = { packageId: prepared.packageId };
  const check = await s.tool("lead", { operation: "method-check", ...base });
  expect(check.result).toMatchObject({
    fullInstrumentScoring: "not-certified",
    methodApplicability: "not-assessed",
    blockers: [expect.stringContaining("未记录实际图像阅读")],
  });
  await expect(
    s.tool("lead", {
      operation: "method-image-reading",
      ...base,
      path: imagePath,
      receiptId: "fake",
      observations: "自报看过",
    }),
  ).rejects.toThrow("此前返回");
  const result = await s.tool(
    "lead",
    { operation: "method-read-image", ...base, path: imagePath },
    "read-image",
  );
  expect(result.media).toMatchObject({
    type: "image",
    mimeType: "image/png",
    data: png.toString("base64"),
  });
  expect(s.p.methodImageReadings).toBeUndefined();
  const receipt = s.p.methodImageReceipts![0]!;
  expect(receipt).toMatchObject({
    imageSha256: sha(png),
    model: { provider: "synthetic-provider", modelId: "synthetic-lead" },
  });
  expect(JSON.stringify(s.p)).not.toContain(png.toString("base64"));
  await s.tool("lead", { operation: "method-read-image", ...base, path: imagePath }, "read-image");
  expect(s.p.methodImageReceipts).toHaveLength(1);
  const observed = {
    operation: "method-image-reading",
    ...base,
    path: imagePath,
    receiptId: receipt.id,
    observations: "合成1像素图片仅验证传输；不是对真实课程图文的内容核验。",
  };
  await s.tool("lead", observed, "observe-image");
  await s.tool("lead", observed, "observe-image");
  expect(s.p.methodImageReadings).toHaveLength(1);
  expect(s.p.methodImageReadings![0]!.actor).toMatchObject({ kind: "model", id: "model:lead" });
  const checked = await s.tool("lead", { operation: "method-check", ...base });
  expect(checked.result).toMatchObject({ blockers: [], fullInstrumentScoring: "not-certified" });
  await expect(s.tool("reviewer", observed)).rejects.toThrow("本次实际native");
  for (const extra of [
    { actor: { kind: "user" } },
    { sha256: sha(png) },
    { image: png.toString("base64") },
    { ethicsApproved: true },
  ])
    await expect(
      s.tool("lead", { operation: "method-read-image", ...base, path: imagePath, ...extra }),
    ).rejects.toThrow("越权字段");
});

test("A application, B content opinion and mentor adjudication remain project-local model identities", async () => {
  const s = await fixture(),
    prepared = await prepareMethodPackage(s.p, s.knowledge, "lead", "", ["EDU-N02-2-5"], at(2));
  const applied = await s.tool("lead", applicationRequest(prepared.packageId));
  const application = (applied.result as { application: ResearchMethodApplication }).application;
  await expect(
    s.tool("lead", {
      operation: "method-opinion",
      packageId: prepared.packageId,
      applicationId: application.id,
      verdict: "support",
      note: "A不能冒充B",
    }),
  ).rejects.toThrow("对应当前角色");
  publishRisk(s.p);
  const response = await s.tool("reviewer", {
    operation: "method-opinion",
    packageId: prepared.packageId,
    applicationId: application.id,
    verdict: "revise",
    note: "应明确只用部分指标，不能登记完整工具评分。",
  });
  const opinion = (response.result as { opinion: ResearchMethodContentOpinion }).opinion;
  expect(opinion.taskId).toBe(application.taskId);
  expect(opinion.actor.id).toBe("model:reviewer");
  expect(
    (
      await s.tool("lead", {
        operation: "method-check",
        packageId: prepared.packageId,
        applicationId: application.id,
      })
    ).result,
  ).toMatchObject({ opinions: [] });
  publishRisk(s.p, "lead");
  expect(
    (
      await s.tool("lead", {
        operation: "method-check",
        packageId: prepared.packageId,
        applicationId: application.id,
      })
    ).result,
  ).toMatchObject({ opinions: [{ id: opinion.id }] });
  await s.tool("mentor", {
    operation: "method-adjudicate",
    packageId: prepared.packageId,
    applicationId: application.id,
    opinionIds: [opinion.id],
    verdict: "hold",
    note: "模型导师暂缓，完整量表不可补造；不构成伦理审批。",
  });
  const checked = await s.tool("mentor", {
    operation: "method-check",
    packageId: prepared.packageId,
    applicationId: application.id,
  });
  expect(checked.result).toMatchObject({
    fullInstrumentScoring: "not-certified",
    opinions: [{ id: opinion.id }],
    adjudications: [{ role: "mentor", actor: { kind: "model" } }],
  });
  await expect(
    s.tool("lead", {
      ...applicationRequest(prepared.packageId),
      scoringClaim: "full-scoring-certified",
    }),
  ).rejects.toThrow("不支持完整工具");
  const cache = await readFile(
    join(
      s.workspace,
      ".lancer",
      "research-method-packages",
      prepared.packageSha256,
      "package.json",
    ),
    "utf8",
  );
  expect(cache).not.toContain(application.id);
  expect(cache).not.toContain(opinion.note);
  expect(cache).not.toContain("伦理审批");
  const other = s.makeProject();
  other.methodPackages = s.p.methodPackages;
  await expect(
    applyMethodPackageTool(
      other,
      s.knowledge,
      "reviewer",
      "cross-project",
      {
        operation: "method-opinion",
        packageId: prepared.packageId,
        applicationId: application.id,
        verdict: "support",
        note: "不能跨项目带私有应用",
      },
      at(40),
    ),
  ).rejects.toThrow("不属于当前项目");
});

test("old cached package/images survive actual KB edits; upgrade is explicit and never rewrites old uses", async () => {
  const s = await fixture(),
    old = await prepareMethodPackage(s.p, s.knowledge, "lead", "", ["EDU-N02-2-5"], at(2));
  await s.tool("lead", applicationRequest(old.packageId));
  const prior = structuredClone(s.p.methodApplications);
  s.records[0]!.text += " 这是显式新版课程补充。";
  await writeFile(s.index, s.records.map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(s.image, Buffer.from("KB image changed after cache"));
  await rename(s.directory, `${s.directory}-moved-test-copy`);
  const read = await applyMethodPackageTool(
    s.p,
    undefined,
    "lead",
    "old-without-kb",
    {
      operation: "method-read-image",
      packageId: old.packageId,
      path: imagePath,
    },
    at(20),
  );
  expect(read.media!.data).toBe(png.toString("base64"));
  const retained = await applyMethodPackageTool(
    s.p,
    undefined,
    "lead",
    "read-old-text",
    { operation: "method-package", packageId: old.packageId },
    at(21),
  );
  expect(retained.result).toMatchObject({
    package: { id: old.packageId, records: old.package.records },
  });
  await expect(
    applyMethodPackageTool(
      s.p,
      undefined,
      "lead",
      "create-without-kb",
      { operation: "method-package", ids: ["EDU-N02-2-5"] },
      at(22),
    ),
  ).rejects.toThrow("实际可用的固定知识库");
  const oldCheck = await applyMethodPackageTool(
    s.p,
    undefined,
    "lead",
    "check-without-kb",
    { operation: "method-check", packageId: old.packageId },
    at(23),
  );
  expect(oldCheck.result).toMatchObject({ actualCacheIssues: [] });
  await rename(`${s.directory}-moved-test-copy`, s.directory);
  await expect(
    prepareMethodPackage(s.p, s.knowledge, "lead", "", ["EDU-N02-2-5"], at(25)),
  ).rejects.toThrow("索引已变化");
  // Restore legitimate new-version image bytes and reopen the actual KB; host explicitly adopts new pin.
  await writeFile(s.image, png);
  const newer = await ResearchKnowledge.open(s.directory);
  s.p.knowledge = structuredClone(newer.pin);
  await expect(
    prepareMethodPackage(s.p, newer, "lead", "", ["EDU-N02-2-5"], at(26)),
  ).rejects.toThrow("显式指定前版");
  const upgraded = await applyMethodPackageTool(
    s.p,
    newer,
    "lead",
    "upgrade",
    { operation: "method-package", ids: ["EDU-N02-2-5"], supersedesPackageId: old.packageId },
    at(27),
  );
  const newId = (upgraded.result as { packageId: string }).packageId;
  expect(newId).not.toBe(old.packageId);
  expect(s.p.methodPackages).toHaveLength(2);
  expect(s.p.methodApplications).toEqual(prior);
  expect(
    (
      await s.tool("lead", {
        operation: "method-read-image",
        packageId: old.packageId,
        path: imagePath,
      })
    ).media!.data,
  ).toBe(png.toString("base64"));
});

test("cache tampering, unsafe paths, non-images and unavailable images never produce media", async () => {
  const s = await fixture(),
    prepared = await prepareMethodPackage(s.p, s.knowledge, "lead", "", ["EDU-N02-2-5"], at(2));
  for (const path of ["../secret.png", "/tmp/secret.png", "素材\\secret.png", "not-listed.png"])
    await expect(
      s.tool("lead", { operation: "method-read-image", packageId: prepared.packageId, path }),
    ).rejects.toThrow();
  const file = join(
    s.workspace,
    ".lancer",
    "research-method-packages",
    prepared.packageSha256,
    "images",
    imagePath,
  );
  await writeFile(file, Buffer.alloc(png.length, 1));
  await expect(
    s.tool("lead", {
      operation: "method-read-image",
      packageId: prepared.packageId,
      path: imagePath,
    }),
  ).rejects.toThrow("SHA已变化");
  expect(s.p.methodImageReceipts).toBeUndefined();
  expect(
    (await s.tool("lead", { operation: "method-check", packageId: prepared.packageId })).result,
  ).toMatchObject({ actualCacheIssues: [expect.stringContaining("SHA已变化")] });
  const outsideImage = join(s.workspace, "outside-package.png");
  await writeFile(outsideImage, png);
  await rename(file, `${file}.tampered-test-copy`);
  await symlink(outsideImage, file);
  await expect(
    s.tool("lead", {
      operation: "method-read-image",
      packageId: prepared.packageId,
      path: imagePath,
    }),
  ).rejects.toThrow("越出固定方法包");
  expect(s.p.methodImageReceipts).toBeUndefined();
  for (const options of [{ bytes: Buffer.from("not an image") }, { missing: true }]) {
    const f = await fixture(options),
      pkg = await prepareMethodPackage(f.p, f.knowledge, "lead", "", ["EDU-N02-2-5"], at(2));
    await expect(
      f.tool("lead", { operation: "method-read-image", packageId: pkg.packageId, path: imagePath }),
    ).rejects.toThrow();
    expect(f.p.methodImageReceipts).toBeUndefined();
  }
  const linked = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "method-cache-outside-"));
  await mkdir(join(linked.workspace, ".lancer"));
  await symlink(outside, join(linked.workspace, ".lancer", "research-method-packages"));
  await expect(
    prepareMethodPackage(linked.p, linked.knowledge, "lead", "", ["EDU-N02-2-5"], at(2)),
  ).rejects.toThrow("符号链接目录");
  expect(await readdir(outside)).toEqual([]);
});

test("current native/model identities and task versions gate operations and stale B opinions cannot authorize mentor review", async () => {
  const s = await fixture(),
    prepared = await prepareMethodPackage(s.p, s.knowledge, "lead", "", ["EDU-N02-2-5"], at(2));
  const response = await s.tool("lead", applicationRequest(prepared.packageId));
  const app = (response.result as { application: ResearchMethodApplication }).application;
  publishRisk(s.p);
  await readySupport(s, prepared.packageId);
  const b = await s.tool("reviewer", {
    operation: "method-opinion",
    packageId: prepared.packageId,
    applicationId: app.id,
    verdict: "support",
    note: "合成B意见",
  });
  const op = (b.result as { opinion: ResearchMethodContentOpinion }).opinion;
  const task = s.p.fusion!.tasks.find((t) => t.role === "reviewer" && t.stage === "design")!;
  task.inputVersion++;
  await expect(
    s.tool("reviewer", { operation: "method-check", packageId: prepared.packageId }),
  ).rejects.toThrow("当前输入版本");
  await expect(
    s.tool("mentor", {
      operation: "method-adjudicate",
      packageId: prepared.packageId,
      applicationId: app.id,
      opinionIds: [op.id],
      verdict: "accept",
      note: "旧B意见不能沿用",
    }),
  ).rejects.toThrow(/B内容意见|B支持意见/);
  const lead = s.p.fusion!.tasks.find((t) => t.role === "lead" && t.stage === "design")!;
  lead.inputVersion++;
  await expect(
    s.tool("mentor", {
      operation: "method-check",
      packageId: prepared.packageId,
      applicationId: app.id,
    }),
  ).rejects.toThrow("不属于当前项目");
  const noModel = await fixture();
  noModel.p.fusion!.attempts.find((a) => a.taskId.includes("lead"))!.model = undefined;
  await expect(
    prepareMethodPackage(noModel.p, noModel.knowledge, "lead", "", ["EDU-N02-2-5"], at(2)),
  ).rejects.toThrow("宿主模型身份");
});

test("host uses persist exact task/native identities across restart, are idempotent per real call and never enter shared cache", async () => {
  const s = await fixture();
  const first = await prepareMethodPackage(
    s.p,
    s.knowledge,
    "lead",
    "",
    ["EDU-N02-2-5"],
    at(2),
    "actual-knowledge-call",
  );
  expect(first.use).toMatchObject({
    callId: "actual-knowledge-call",
    operation: "knowledge",
    role: "lead",
    revision: 1,
    taskInputVersion: 1,
    packageId: first.packageId,
  });
  await prepareMethodPackage(
    s.p,
    s.knowledge,
    "lead",
    "",
    ["EDU-N02-2-5"],
    at(3),
    "actual-knowledge-call",
  );
  expect(s.p.methodPackageUses).toHaveLength(1);
  await s.tool(
    "lead",
    { operation: "method-package", packageId: first.packageId },
    "actual-package-read",
  );
  await s.tool(
    "lead",
    { operation: "method-package", packageId: first.packageId },
    "actual-package-read",
  );
  expect(s.p.methodPackageUses).toHaveLength(2);
  await s.tool(
    "lead",
    { operation: "method-package", ids: ["EDU-N02-2-5"] },
    "actual-package-create-reuse",
  );
  expect(s.p.methodPackageUses).toHaveLength(3);
  const restarted = JSON.parse(JSON.stringify(privateRecords(s.p))) as unknown;
  expect(decodeResearchMethodProjectRecords(restarted)).toEqual(
    JSON.parse(JSON.stringify(privateRecords(s.p))),
  );
  expect(decodeResearchMethodProjectRecords({})).toEqual({});
  expect(
    decodeResearchMethodProjectRecords({ methodPackages: undefined, methodPackageUses: undefined }),
  ).toEqual({});
  await expect(
    s.tool(
      "lead",
      { operation: "method-read-image", packageId: first.packageId, path: imagePath },
      "actual-package-read",
    ),
  ).rejects.toThrow("不能改作其他");
  await expect(
    s.tool(
      "lead",
      { operation: "method-package", packageId: first.packageId },
      "actual-knowledge-call",
    ),
  ).rejects.toThrow("不能改作其他");
  const old = structuredClone(s.p.methodPackageUses);
  s.p.fusion!.tasks.find((task) => task.id === first.use.taskId)!.inputVersion++;
  await expect(
    s.tool("lead", { operation: "method-package", packageId: first.packageId }, "stale-use"),
  ).rejects.toThrow("当前输入版本");
  expect(s.p.methodPackageUses).toEqual(old);
  const shared = await readFile(
    join(s.workspace, ".lancer", "research-method-packages", first.packageSha256, "package.json"),
    "utf8",
  );
  expect(shared).not.toContain("actual-knowledge-call");
  expect(shared).not.toContain(first.use.sessionId);
});

test("strict private decoders reject forged bytes, duplicate IDs, wrong SHA/scope and missing opinion links", async () => {
  const s = await fixture(),
    pkg = await prepareMethodPackage(s.p, s.knowledge, "lead", "", ["EDU-N02-2-5"], at(2));
  await s.tool("lead", {
    operation: "method-read-image",
    packageId: pkg.packageId,
    path: imagePath,
  });
  await s.tool("lead", {
    operation: "method-image-reading",
    packageId: pkg.packageId,
    path: imagePath,
    receiptId: s.p.methodImageReceipts![0]!.id,
    observations: "合成图像观察，不是专业方法判断",
  });
  const application = (await s.tool("lead", applicationRequest(pkg.packageId))).result as {
    application: ResearchMethodApplication;
  };
  publishRisk(s.p);
  await readySupport(s, pkg.packageId);
  const opinion = (
    await s.tool("reviewer", {
      operation: "method-opinion",
      packageId: pkg.packageId,
      applicationId: application.application.id,
      verdict: "support",
      note: "合成B内容意见",
    })
  ).result as { opinion: ResearchMethodContentOpinion };
  await s.tool("mentor", {
    operation: "method-adjudicate",
    packageId: pkg.packageId,
    applicationId: application.application.id,
    opinionIds: [opinion.opinion.id],
    verdict: "hold",
    note: "仅模型导师判断",
  });
  const saved = decodeResearchMethodProjectRecords(privateRecords(s.p));
  expect(saved.methodAdjudications).toHaveLength(1);
  const duplicates = structuredClone(saved);
  duplicates.methodPackageUses!.push(duplicates.methodPackageUses![0]!);
  expect(() => decodeResearchMethodProjectRecords(duplicates)).toThrow("身份重复");
  const injected = JSON.parse(JSON.stringify(saved)) as Record<string, Record<string, unknown>[]>;
  injected.methodImageReceipts![0]!.data = png.toString("base64");
  expect(() => decodeResearchMethodProjectRecords(injected)).toThrow("越权字段");
  const shaMismatch = structuredClone(saved);
  shaMismatch.methodApplications![0]!.packageSha256 = "a".repeat(64);
  expect(() => decodeResearchMethodProjectRecords(shaMismatch)).toThrow("同版方法包");
  const scopeMismatch = structuredClone(saved);
  scopeMismatch.methodContentOpinions![0]!.taskId = "foreign-task";
  expect(() => decodeResearchMethodProjectRecords(scopeMismatch)).toThrow("同任务同包");
  const noOpinion = structuredClone(saved);
  noOpinion.methodContentOpinions = [];
  expect(() => decodeResearchMethodProjectRecords(noOpinion)).toThrow("B意见不属于");
  const wrongVersion = structuredClone(saved);
  wrongVersion.methodPackageUses![0]!.taskInputVersion = 0;
  expect(() => decodeResearchMethodProjectRecords(wrongVersion)).toThrow("正整数");
  const badDate = structuredClone(saved);
  badDate.methodImageReadings![0]!.at = "not-a-date";
  expect(() => decodeResearchMethodProjectRecords(badDate)).toThrow("时间无效");
});

test("B cannot guess an application ID to read A reasoning or image observations before its current independent judgment", async () => {
  const s = await fixture(),
    pkg = await prepareMethodPackage(s.p, s.knowledge, "lead", "", ["EDU-N02-2-5"], at(2));
  const result = (await s.tool("lead", applicationRequest(pkg.packageId))).result as {
    application: ResearchMethodApplication;
  };
  const applicationId = result.application.id;
  for (const operation of ["method-check", "method-opinion"]) {
    const extra =
      operation === "method-opinion" ? { verdict: "support", note: "不能偷读A后再称独立" } : {};
    await expect(
      s.tool("reviewer", { operation, packageId: pkg.packageId, applicationId, ...extra }),
    ).rejects.toThrow("独立初判");
  }
  expect(
    (await s.tool("reviewer", { operation: "method-check", packageId: pkg.packageId })).result,
  ).toMatchObject({ application: null, opinions: [], adjudications: [] });
  expect(
    JSON.stringify(
      (await s.tool("reviewer", { operation: "method-package", packageId: pkg.packageId })).result,
    ),
  ).not.toContain(result.application.applicabilityExplanation);
  const artifact = publishRisk(s.p);
  // Current graph publication unlocks access; simply inserting a textual artifact would not.
  expect(
    (
      await s.tool("reviewer", {
        operation: "method-check",
        packageId: pkg.packageId,
        applicationId,
      })
    ).result,
  ).toMatchObject({ application: { id: applicationId } });
  s.p.fusion!.artifacts.find((row) => row.id === artifact.id)!.reviewState = "superseded";
  await expect(
    s.tool("reviewer", { operation: "method-check", packageId: pkg.packageId, applicationId }),
  ).rejects.toThrow("独立初判");
});
