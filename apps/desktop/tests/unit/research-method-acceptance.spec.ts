import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESEARCH_ROLES,
  type ResearchArtifact,
  type ResearchRole,
} from "../../contracts/research-group";
import { decodeResearchMethodProgramChecks } from "../../contracts/research-method-checks";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import {
  prepareMethodPackage,
  applyMethodPackageTool,
  type MethodProject,
} from "../../electron/research-group/method-package-tools";
import {
  prepareMethodAcceptance,
  assertMethodAcceptance,
  requiresMethodAcceptance,
} from "../../electron/research-group/method-acceptance";
import {
  prepareFusionDelivery,
  dispatchFusionAttempt,
  bindFusionNativeRun,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import type {
  ResearchMethodApplication,
  ResearchMethodContentOpinion,
} from "../../contracts/research-method-packages";

const at = (n: number) => new Date(Date.UTC(2026, 10, 8, 1, 0, n)).toISOString();
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZqkAAAAASUVORK5CYII=",
  "base64",
);
const imagePath = "images/partial-rubric.png";
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "method-acceptance-")),
    kb = join(workspace, "synthetic-course");
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"));
  await mkdir(join(kb, "images"));
  const records = [
    {
      id: "ROOT",
      title: "合成方法框架",
      text: "部分指标仅作提纲，不可认证完整评分。",
      required_context_ids: ["CONTEXT"],
      image_paths: [],
      content_layers: ["course_paraphrase"],
    },
    {
      id: "CONTEXT",
      title: "合成限制",
      text: "此图不是完整工具。",
      required_context_ids: [],
      image_paths: [imagePath],
      content_layers: ["note_commentary"],
    },
  ];
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n"),
  );
  await writeFile(join(kb, "溯源", "来源清单.json"), JSON.stringify({ version: "synthetic-1" }));
  await writeFile(
    join(kb, "溯源", "图片清单.json"),
    JSON.stringify([{ path: imagePath, sha256: sha(png) }]),
  );
  await writeFile(join(kb, imagePath), png);
  const knowledge = await ResearchKnowledge.open(kb),
    id = randomUUID();
  const p: MethodProject = {
    id,
    root: { workspaceId: workspace, sessionId: "mentor" },
    workspacePath: workspace,
    objective: "合成方法接受门禁测试；不证明真实课程视觉理解",
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
    knowledge: knowledge.pin,
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: role },
      status: "idle",
    })),
    stages: [
      {
        id: "design",
        title: "方案",
        goal: "合成测试",
        deliverables: "合成方法应用",
        models: Object.fromEntries(
          RESEARCH_ROLES.map((role) => [role, { provider: "synthetic", modelId: `model-${role}` }]),
        ),
      },
    ],
    artifacts: [],
    events: [],
    packets: [],
  };
  for (const role of ["lead", "reviewer", "mentor"] as const) {
    const d = prepareFusionDelivery(
      p,
      role,
      `${role}-attempt`,
      at(0),
      "合成native身份夹具，非E/R证据",
    );
    expect(d.kind).toBe("dispatch");
    dispatchFusionAttempt(p, d.attemptId!, at(0));
    bindFusionNativeRun(p, role, `${role}-native`);
  }
  let serial = 10;
  const tool = (
    role: ResearchRole,
    input: Record<string, unknown>,
    callId = `method-call-${++serial}`,
  ) => applyMethodPackageTool(p, knowledge, role, callId, input, at(++serial));
  const pkg = await prepareMethodPackage(
    p,
    knowledge,
    "lead",
    "",
    ["ROOT"],
    at(2),
    "actual-knowledge-call",
  );
  const publish = (role: "lead" | "reviewer", kind: "stage-risk" | "stage-revision") => {
    const artifact: ResearchArtifact = {
      id: randomUUID(),
      role,
      kind,
      stage: "design",
      revision: 1,
      round: 1,
      createdAt: at(++serial),
      content: `合成${kind}，仅部分指标应用，非完整评分认证`,
      refs: [],
      sourceIds: [],
      analysisIds: [],
      toolCallId: `publish-${serial}`,
    };
    p.artifacts.push(artifact);
    publishFusionArtifact(p, artifact);
    return artifact;
  };
  publish("reviewer", "stage-risk");
  const acquire = async (role: ResearchRole) =>
    tool(role, { operation: "method-package", packageId: pkg.packageId });
  const seeImage = async (role: ResearchRole) => {
    await tool(role, { operation: "method-read-image", packageId: pkg.packageId, path: imagePath });
    const receipt = p.methodImageReceipts!.at(-1)!;
    await tool(role, {
      operation: "method-image-reading",
      packageId: pkg.packageId,
      path: imagePath,
      receiptId: receipt.id,
      observations: "合成1像素图仅验证传输与观察记录链，不是课程内容专业核验。",
    });
  };
  const apply = async () =>
    (
      (
        await tool("lead", {
          operation: "method-apply",
          packageId: pkg.packageId,
          recordIds: ["ROOT", "CONTEXT"],
          methodSelection: "部分指标核查提纲",
          applicabilityExplanation: "用于记录报告要素，不计算完整总分",
          nonApplicableConditions: ["完整量表未取得"],
          limitations: "课程方法非本项目实证",
          scoringClaim: "partial-indicators-only",
        })
      ).result as { application: ResearchMethodApplication }
    ).application;
  const opinion = async (
    applicationId: string,
    verdict: "support" | "revise" | "hold" = "support",
  ) =>
    (
      (
        await tool("reviewer", {
          operation: "method-opinion",
          packageId: pkg.packageId,
          applicationId,
          verdict,
          note: "合成B审阅意见，保留方法边界",
        })
      ).result as { opinion: ResearchMethodContentOpinion }
    ).opinion;
  const adjudicate = (
    applicationId: string,
    opinionId: string,
    verdict: "accept" | "hold" = "accept",
  ) =>
    tool("mentor", {
      operation: "method-adjudicate",
      packageId: pkg.packageId,
      applicationId,
      opinionIds: [opinionId],
      verdict,
      note: "合成导师模型裁定，不是人类专家或伦理批准",
    });
  let artifact = publish("lead", "stage-revision");
  const read = (role: ResearchRole, readAt = at(150)) => {
    // Mirrors the actual host read event after retrieving this immutable graph-backed body; no passed report is seeded.
    expect(p.fusion!.artifacts.find((a) => a.id === artifact.id)!.content).toBe(artifact.content);
    p.events.push({
      id: randomUUID(),
      at: readAt,
      revision: 1,
      type: "read",
      role,
      artifactId: artifact.id,
      stage: "design",
      detail: `读取 ${artifact.kind} · ${role} · 合成host读取事件`,
    });
  };
  const input = (role: "reviewer" | "mentor" = "reviewer") => ({
    operation: "publish",
    kind: role === "reviewer" ? "stage-verification" : "stage-review",
    revision: 1,
    stage: "design",
    verdict: "accept",
    refs: [artifact.id],
    content: "合成方法部分指标流程接受",
  });
  const complete = async () => {
    await seeImage("lead");
    const application = await apply();
    await acquire("reviewer");
    await seeImage("reviewer");
    const support = await opinion(application.id);
    await acquire("mentor");
    await adjudicate(application.id, support.id);
    read("reviewer");
    read("mentor");
    return { application, support };
  };
  return {
    p,
    knowledge,
    pkg,
    tool,
    acquire,
    seeImage,
    apply,
    opinion,
    adjudicate,
    read,
    input,
    complete,
    get artifact() {
      return artifact;
    },
    nextTarget() {
      artifact = publish("lead", "stage-revision");
      return artifact;
    },
    cacheImage: join(
      workspace,
      ".lancer",
      "research-method-packages",
      pkg.packageSha256,
      "images",
      imagePath,
    ),
  };
}

test("partial-indicator flow passes actual adapter/file checks; assertion rereads without creating uses/native operations", async () => {
  const s = await fixture();
  await s.complete();
  const prepared = await prepareMethodAcceptance(s.p, "reviewer", "accept", s.input(), at(200));
  expect(prepared.blocked).toBe(false);
  expect(prepared.record).toBeTruthy();
  expect(decodeResearchMethodProgramChecks(s.p.methodProgramChecks)).toEqual(
    s.p.methodProgramChecks,
  );
  const before = JSON.stringify(s.p);
  await assertMethodAcceptance(s.p, "reviewer", "accept", s.input(), at(201));
  expect(JSON.stringify(s.p)).toBe(before);
  const mentor = await prepareMethodAcceptance(
    s.p,
    "mentor",
    "mentor-accept",
    s.input("mentor"),
    at(202),
  );
  expect(mentor.blocked).toBe(false);
  await assertMethodAcceptance(s.p, "mentor", "mentor-accept", s.input("mentor"), at(203));
  expect((prepared.record as unknown as { snapshotToken: string }).snapshotToken).toMatch(
    /^[a-f0-9]{64}$/,
  );
});

test("support cannot be declared from a guessed package/application without B's own real course and image use", async () => {
  const s = await fixture();
  await s.seeImage("lead");
  const app = await s.apply();
  await expect(s.opinion(app.id)).rejects.toThrow(/方法包|课程|图/);
  await s.acquire("reviewer");
  await expect(s.opinion(app.id)).rejects.toThrow(/图/);
  await s.seeImage("reviewer");
  const support = await s.opinion(app.id);
  await expect(s.adjudicate(app.id, support.id)).rejects.toThrow(/方法包|课程/);
  await s.acquire("mentor");
  await s.adjudicate(app.id, support.id);
});

test("invalid current native/input identities are persisted as blocked records rather than thrown away", async () => {
  const s = await fixture();
  s.read("reviewer");
  s.p.fusion!.attempts.find((a) => a.id === "reviewer-attempt")!.model = undefined;
  const outcome = await prepareMethodAcceptance(s.p, "reviewer", "no-model", s.input(), at(200));
  expect(outcome.blocked).toBe(true);
  expect(s.p.methodProgramChecks).toHaveLength(1);
  expect(decodeResearchMethodProgramChecks(s.p.methodProgramChecks)).toEqual(
    s.p.methodProgramChecks,
  );
});

test("same-ID application changes and forged A use identity invalidate a prepared snapshot", async () => {
  const s = await fixture();
  const { application } = await s.complete();
  await prepareMethodAcceptance(s.p, "reviewer", "accept", s.input(), at(200));
  application.methodSelection = "changed";
  s.p.methodApplications!.find((a) => a.id === application.id)!.methodSelection =
    "原位改写方法解释";
  await expect(
    assertMethodAcceptance(s.p, "reviewer", "accept", s.input(), at(201)),
  ).rejects.toThrow(/变化|快照|依据/);
  const forged = await fixture();
  await forged.complete();
  forged.p.methodPackageUses!.find((u) => u.role === "lead")!.nativeRunId = "fake-native";
  expect(
    (await prepareMethodAcceptance(forged.p, "reviewer", "forged-use", forged.input(), at(200)))
      .blocked,
  ).toBe(true);
});

test("unread or altered graph target and stale read events cannot be formally accepted", async () => {
  const s = await fixture();
  await s.complete();
  s.p.events = s.p.events.filter((e) => e.role !== "reviewer" || e.type !== "read");
  s.read("reviewer", at(1));
  expect(
    (await prepareMethodAcceptance(s.p, "reviewer", "old-read", s.input(), at(200))).blocked,
  ).toBe(true);
  const changed = await fixture();
  await changed.complete();
  changed.artifact.content += "原位改稿";
  expect(
    (await prepareMethodAcceptance(changed.p, "reviewer", "changed-body", changed.input(), at(200)))
      .blocked,
  ).toBe(true);
});

test("missing images/app, latest B revise/mentor hold and actual cache tampering block while no-use compatibility stays untouched", async () => {
  const empty = await fixture();
  empty.read("reviewer");
  expect(
    (await prepareMethodAcceptance(empty.p, "reviewer", "missing-app", empty.input(), at(200)))
      .blocked,
  ).toBe(true);
  const s = await fixture();
  const { application, support } = await s.complete();
  await s.adjudicate(application.id, support.id, "hold");
  expect(
    (await prepareMethodAcceptance(s.p, "mentor", "held", s.input("mentor"), at(200))).blocked,
  ).toBe(true);
  await s.opinion(application.id, "revise");
  expect(
    (await prepareMethodAcceptance(s.p, "reviewer", "revised", s.input(), at(201))).blocked,
  ).toBe(true);
  const disk = await fixture();
  await disk.complete();
  await prepareMethodAcceptance(disk.p, "reviewer", "disk", disk.input(), at(200));
  await writeFile(disk.cacheImage, Buffer.alloc(png.length, 1));
  await expect(
    assertMethodAcceptance(disk.p, "reviewer", "disk", disk.input(), at(201)),
  ).rejects.toThrow();
  const compatible = await fixture();
  compatible.p.methodPackageUses = undefined;
  expect(requiresMethodAcceptance(compatible.p, "reviewer", compatible.input())).toBe(false);
  expect(
    (await prepareMethodAcceptance(compatible.p, "reviewer", "legacy", compatible.input(), at(200)))
      .required,
  ).toBe(false);
  expect(compatible.p.methodProgramChecks).toBeUndefined();
});

test("new target, superseding application and changed task inputs require fresh reviews instead of reusing old support", async () => {
  const s = await fixture();
  await s.complete();
  const oldInput = s.input();
  await prepareMethodAcceptance(s.p, "reviewer", "old-target", oldInput, at(200));
  s.nextTarget();
  await expect(
    assertMethodAcceptance(s.p, "reviewer", "old-target", oldInput, at(201)),
  ).rejects.toThrow(/变化|快照/);
  expect(
    (await prepareMethodAcceptance(s.p, "reviewer", "new-unread", s.input(), at(202))).blocked,
  ).toBe(true);
  const replacement = await fixture();
  await replacement.complete();
  const newer = await replacement.apply();
  const blocked = await prepareMethodAcceptance(
    replacement.p,
    "reviewer",
    "new-app",
    replacement.input(),
    at(200),
  );
  expect(blocked.blocked).toBe(true);
  expect(blocked.record!.packages[0]!.applicationId).toBe(newer.id);
  const stale = await fixture();
  await stale.complete();
  stale.p.fusion!.tasks.find((task) => task.role === "lead" && task.stage === "design")!
    .inputVersion++;
  expect(
    (await prepareMethodAcceptance(stale.p, "reviewer", "stale-task", stale.input(), at(200)))
      .blocked,
  ).toBe(true);
});

test("decoder rejects passed records without target/identity, record tampering fails, and unrelated events do not stale the local snapshot", async () => {
  const s = await fixture();
  await s.complete();
  const prepared = await prepareMethodAcceptance(s.p, "reviewer", "identity", s.input(), at(200));
  expect(() => decodeResearchMethodProgramChecks([{ ...prepared.record!, target: null }])).toThrow(
    "不能保存为通过",
  );
  expect(() =>
    decodeResearchMethodProgramChecks([{ ...prepared.record!, model: undefined }]),
  ).toThrow("不能保存为通过");
  s.p.events.push({
    id: randomUUID(),
    at: at(201),
    revision: 1,
    type: "read",
    role: "librarian",
    stage: "reading",
    detail: "无关资料员事件，不改变本阶段方法依据",
  });
  await assertMethodAcceptance(s.p, "reviewer", "identity", s.input(), at(202));
  s.p.methodProgramChecks![0]!.model!.provider = "spoofed-provider";
  await expect(
    assertMethodAcceptance(s.p, "reviewer", "identity", s.input(), at(203)),
  ).rejects.toThrow(/摘要|快照/);
});

test("B's image reading cannot replace A's application image evidence, and blocked checks remain valid snapshots", async () => {
  const s = await fixture();
  await s.complete();
  s.p.methodImageReadings = s.p.methodImageReadings!.filter(
    (reading) => reading.actor.id !== "model:lead",
  );
  const check = await prepareMethodAcceptance(
    s.p,
    "reviewer",
    "missing-a-image",
    s.input(),
    at(200),
  );
  expect(check.blocked).toBe(true);
  expect(check.record!.issues.join(" ")).toContain("实际图像阅读");
  expect(decodeResearchMethodProgramChecks(s.p.methodProgramChecks)).toEqual(
    s.p.methodProgramChecks,
  );
  const noNative = await fixture();
  noNative.p.fusion!.attempts.find((a) => a.id === "reviewer-attempt")!.nativeRunId = undefined;
  const missing = await prepareMethodAcceptance(
    noNative.p,
    "reviewer",
    "missing-native",
    noNative.input(),
    at(200),
  );
  expect(missing.blocked).toBe(true);
  expect(missing.record!.nativeRunId).toBeUndefined();
  expect(decodeResearchMethodProgramChecks(noNative.p.methodProgramChecks)).toEqual(
    noNative.p.methodProgramChecks,
  );
});
