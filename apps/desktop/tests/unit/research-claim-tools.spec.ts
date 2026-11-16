import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESEARCH_ROLES,
  type ResearchArtifact,
  type ResearchRole,
} from "../../contracts/research-group";
import type { ResearchClaimDepth, ResearchClaimRequest } from "../../contracts/research-claims";
import {
  applyResearchClaimTool,
  researchClaimArtifactStatus,
  type ClaimProject,
} from "../../electron/research-group/claim-tools";
import { applyRegisteredAnalysisTool } from "../../electron/research-group/registered-analysis-tools";
import { publishFusionArtifact } from "../../electron/research-group/fusion-task-runtime";
import {
  addResearchTask,
  applyResearchChange,
  createResearchTaskGraph,
  markResearchTaskDispatched,
  startResearchTask,
  setResearchInput,
} from "../../electron/research-group/task-graph";
import { researchHash } from "../../electron/research-group/materials";

const at = "2026-11-07T12:00:00.000Z";
const later = "2026-11-07T12:10:00.000Z";
const sourceBody = "Sample: two schools.\nThe sample is not nationally representative. 🧪";
const sentence = "本研究材料来自两所学校。";
const draftBody = `${sentence}该结果不代表全国总体。`;

async function fixture(withRun = false) {
  const directory = await mkdtemp(join(tmpdir(), "research-claims-host-"));
  const sourceFile = join(directory, "source.txt");
  await writeFile(sourceFile, sourceBody);
  const p: ClaimProject = {
    id: randomUUID(),
    root: { workspaceId: directory, sessionId: "session-mentor" },
    workspacePath: directory,
    objective: "合成软件契约验收，不是真实研究或专家评阅。",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "materials",
    goal: "paper",
    path: "quantitative",
    scope: "paper",
    currentStage: "analysis",
    knowledge: { directory, sha256: "fixture", version: "fixture", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: directory, sessionId: `session-${role}` },
      status: "running",
    })),
    artifacts: [],
    packets: [],
    events: [],
    sourceReads: [],
    evidence: {
      directory,
      datasets: [],
      sources: [
        {
          id: "S1",
          title: "合成两校样本原文",
          authors: "fixture",
          year: "2026",
          url: "fixture:source",
          file: sourceFile,
          sha256: researchHash(sourceBody),
          kind: "paper",
          access: "provided-text",
        },
      ],
    },
  };
  p.fusion = createResearchTaskGraph(p.id, "2.0.0");
  p.fusion = setResearchInput(p.fusion, {
    inputId: "source:S1",
    version: 1,
    kind: "material",
    availability: "available",
    actual: true,
    label: "合成原文",
    sourceRef: sourceFile,
    digest: researchHash(sourceBody),
  });
  p.fusion = applyResearchChange(p.fusion, {
    id: "adopt-source",
    at,
    inputId: "source:S1",
    fromVersion: null,
    toVersion: 1,
    reason: "验收夹具采用实际文本",
    authorizedBy: "existing-authorization",
    authorizationRef: "fixture",
  });
  for (const role of RESEARCH_ROLES) {
    const taskId = `v1:analysis:${role}`;
    p.fusion = addResearchTask(p.fusion, {
      id: taskId,
      stage: "analysis",
      role,
      kind: "analysis",
      goal: "合成宿主工具验证",
      inputs: [{ inputId: "source:S1", version: 1, requirement: "available" }],
      dependencies: [],
      earlyHandoff: "可定位主张",
      deliverable: "稿件",
      reviewRequired: true,
      writeScope: [`claims/${role}`],
    });
    p.fusion = startResearchTask(p.fusion, taskId, {
      id: `attempt-${role}`,
      at,
      reservedTokens: 0,
      model: { provider: "fixture-host", modelId: `model-${role}` },
    });
    p.fusion = markResearchTaskDispatched(p.fusion, `attempt-${role}`, at);
    p.fusion.attempts.find((attempt) => attempt.id === `attempt-${role}`)!.nativeRunId =
      `native-${role}`;
  }
  let runId: string | undefined;
  if (withRun) {
    const csv = "x,y\n1,3\n2,5\n3,7\n4,9\n";
    const file = join(directory, "data.csv");
    await writeFile(file, csv);
    p.evidence!.datasets.push({
      id: "D1",
      file,
      sha256: researchHash(csv),
      description: "合成线性数据",
      sourceId: "S1",
      dataKind: "synthetic",
      permission: "user-authorized",
      delimiter: ",",
    });
    await applyRegisteredAnalysisTool(
      p,
      "lead",
      "register-run",
      {
        operation: "register-analysis",
        plan: {
          id: "primary",
          version: 1,
          label: "合成主分析",
          purpose: "primary",
          objective: "验证实际结果依赖",
          dataset: { id: "D1" },
          method: "ols",
          columns: ["x"],
          outcome: "y",
          parameters: {},
          outputs: ["regression.rSquared"],
          reviewPlan: "读取后另作模型判断",
          sample: { mode: "all" },
          registrationReason: "软件验收固定计划",
          timing: "prospective",
        },
      },
      at,
    );
    const execution = await applyRegisteredAnalysisTool(
      p,
      "lead",
      "execute-run",
      {
        operation: "run-analysis",
        planId: "primary",
        planVersion: 1,
      },
      at,
    );
    runId = (execution.result as { id: string }).id;
  }
  const publish = (id = "draft-1", body = draftBody) => {
    const artifact: ResearchArtifact = {
      id,
      role: "lead",
      kind: "stage-draft",
      revision: 1,
      round: 0,
      createdAt: at,
      content: body,
      refs: [],
      toolCallId: `publish-${id}`,
      stage: "analysis",
    };
    p.artifacts.push(artifact);
    publishFusionArtifact(p, artifact);
    return artifact;
  };
  const artifact = publish();
  const readDraft = (role: ResearchRole, artifactId = artifact.id) =>
    p.events.push({
      id: randomUUID(),
      at,
      revision: 1,
      type: "read",
      role,
      artifactId,
      runId: `native-${role}`,
      detail: "宿主 read 成果凭据夹具",
    });
  const readSource = (
    role: ResearchRole,
    options: { depth?: ResearchClaimDepth; end?: number } = {},
  ) =>
    p.sourceReads!.push({
      id: randomUUID(),
      sourceId: "S1",
      sourceSha256: researchHash(sourceBody),
      bodySha256: researchHash(sourceBody),
      locatorId: "text:S1",
      start: 0,
      end: options.end ?? sourceBody.length,
      depth: options.depth ?? "partial-text",
      sessionId: `session-${role}`,
      at,
      evidenceRef: `source-read:${role}`,
    });
  const readResult = (role: ResearchRole) =>
    applyRegisteredAnalysisTool(
      p,
      role,
      `actual-read-${role}`,
      {
        operation: "read-registered-analysis",
        analysisId: runId,
      },
      later,
    );
  const claim: ResearchClaimRequest = {
    id: "claim-1",
    artifactId: artifact.id,
    start: 0,
    end: sentence.length,
    category: "source-fact",
    evidence: [
      {
        kind: "source",
        sourceId: "S1",
        locatorId: "text:S1",
        start: 0,
        end: "Sample: two schools.".length,
        requiredDepth: "partial-text",
        relation: "support",
      },
    ],
  };
  let serial = 0;
  const tool = (role: ResearchRole, input: Record<string, unknown>, id = `tool-${++serial}`) =>
    applyResearchClaimTool(p, role, id, input, later);
  const register = () => tool("lead", { operation: "claim-register", claim });
  const review = (conclusion = "supported", role: ResearchRole = "reviewer", id?: string) =>
    tool(
      role,
      {
        operation: "claim-review",
        review: {
          claimId: claim.id,
          conclusion,
          reason: "合成原文明确列两校；这是模型语义判断，不能推广全国。",
          resolvesReviewIds: [],
        },
      },
      id,
    );
  return {
    p,
    artifact,
    sourceFile,
    claim,
    runId,
    publish,
    readDraft,
    readSource,
    readResult,
    tool,
    register,
    review,
  };
}

test("claim context requires an actual draft read and reveals only source locator metadata", async () => {
  const f = await fixture();
  await expect(
    f.tool("lead", { operation: "claim-context", artifactId: f.artifact.id }),
  ).rejects.toThrow("先用 read");
  f.readDraft("lead");
  const response = await f.tool("lead", { operation: "claim-context", artifactId: f.artifact.id });
  expect(response.result).toMatchObject({
    artifact: { id: "draft-1", body: draftBody },
    sources: [
      {
        id: "S1",
        locators: [{ id: "text:S1", start: 0, end: sourceBody.length, depth: "partial-text" }],
      },
    ],
    actualReads: [],
  });
  expect(JSON.stringify(response)).not.toContain(sourceBody);
  expect(f.p.sourceReads).toEqual([]);
});

test("registration stays pending; only actual B reads permit an attributable semantic review", async () => {
  const f = await fixture();
  f.readDraft("lead");
  const registered = await f.register();
  expect(JSON.stringify(registered)).not.toContain("Sample: two schools.");
  expect(
    (await researchClaimArtifactStatus(f.p, f.artifact.id)).blockers.map((issue) => issue.code),
  ).toContain("review-missing");
  await expect(f.review()).rejects.toThrow("先用 read");
  f.readDraft("reviewer");
  await expect(f.review()).rejects.toThrow("尚未实际读取");
  expect(f.p.claims!.reviews).toHaveLength(0);
  f.readSource("reviewer");
  await f.review("supported", "reviewer", "review-call");
  expect(f.p.claims!.reviews[0]).toMatchObject({
    actor: {
      kind: "model",
      role: "reviewer",
      sessionId: "session-reviewer",
      runId: "native-reviewer",
      toolCallId: "review-call",
      provider: "fixture-host",
      modelId: "model-reviewer",
    },
    judgment: "model-semantic-review",
    actualReads: [f.p.sourceReads![0]],
  });
  expect((await researchClaimArtifactStatus(f.p, f.artifact.id)).blocksFormalAcceptance).toBe(
    false,
  );
  await f.review("supported", "reviewer", "review-call");
  expect(f.p.claims!.reviews).toHaveLength(1);
  await f.review("unsupported");
  const issue = (await researchClaimArtifactStatus(f.p, f.artifact.id)).blockers.find(
    (entry) => entry.code === "review-unsupported",
  );
  expect(issue).toMatchObject({
    artifactId: f.artifact.id,
    start: 0,
    end: sentence.length,
    exactText: sentence,
  });
});

test("model input cannot fabricate identities, SHA or reads, and A cannot act as B", async () => {
  const f = await fixture();
  f.readDraft("lead");
  for (const extra of [
    { actor: { kind: "human" } },
    { bodySha256: "a".repeat(64) },
    { actualReads: [] },
  ]) {
    await expect(
      f.tool("lead", { operation: "claim-register", claim: { ...f.claim, ...extra } }),
    ).rejects.toThrow("越权字段");
  }
  await expect(
    f.tool("lead", { operation: "claim-register", claim: f.claim, depth: "full-text" }),
  ).rejects.toThrow("宿主字段");
  await f.register();
  await expect(f.review("supported", "lead")).rejects.toThrow("B/导师");
  f.readDraft("reviewer");
  f.readSource("reviewer");
  await expect(
    f.tool("reviewer", {
      operation: "claim-review",
      review: {
        claimId: f.claim.id,
        conclusion: "supported",
        reason: "自报真人",
        resolvesReviewIds: [],
        actor: { kind: "human" },
      },
    }),
  ).rejects.toThrow("越权字段");
  expect(f.p.claims!.reviews).toHaveLength(0);
});

test("partial and abstract text do not become full text, and an unread span cannot be reviewed", async () => {
  const f = await fixture();
  f.readDraft("lead");
  f.readDraft("reviewer");
  const evidence = f.claim.evidence[0]!;
  if (evidence.kind === "source") evidence.requiredDepth = "full-text";
  await f.register();
  f.readSource("reviewer", { depth: "full-text" });
  await expect(f.review()).rejects.toThrow("尚未实际读取");
  expect(
    (await researchClaimArtifactStatus(f.p, f.artifact.id)).blockers.map((issue) => issue.code),
  ).toContain("reading-depth-insufficient");
  Object.assign(f.p.evidence!.sources[0]!, { textScope: "full-text" });
  f.p.sourceReads![0]!.end = 5;
  await expect(f.review()).rejects.toThrow("尚未实际读取");
  f.p.sourceReads![0]!.end = sourceBody.length;
  await f.review();
  expect((await researchClaimArtifactStatus(f.p, f.artifact.id)).blocksFormalAcceptance).toBe(
    false,
  );
  Object.assign(f.p.evidence!.sources[0]!, { textScope: "abstract" });
  expect(
    (await researchClaimArtifactStatus(f.p, f.artifact.id)).blockers.map((issue) => issue.code),
  ).toContain("reading-depth-insufficient");
});

test("one read cannot satisfy another dependency's deeper scope or replaced source pin", async () => {
  const f = await fixture();
  f.readDraft("lead");
  f.readDraft("reviewer");
  Object.assign(f.p.evidence!.sources[0]!, { textScope: "full-text" });
  const reference = f.claim.evidence[0]!;
  if (reference.kind === "source")
    f.claim.evidence.push({ ...reference, requiredDepth: "full-text" });
  await f.register();
  f.readSource("reviewer");
  await expect(f.review()).rejects.toThrow("尚未实际读取");
  expect(f.p.claims!.reviews).toHaveLength(0);
  f.p.sourceReads![0]!.depth = "full-text";
  const replacement =
    "Changed: ten schools.\nThis is a distinct source version with a different population.";
  await writeFile(f.sourceFile, replacement);
  f.p.evidence!.sources[0]!.sha256 = researchHash(replacement);
  await expect(f.review()).rejects.toThrow("尚未实际读取");
  expect(f.p.claims!.reviews).toHaveLength(0);
});

test("stale or unbound native attempts and altered producer projections cannot write claims", async () => {
  const f = await fixture();
  f.readDraft("reviewer");
  const attempt = f.p.fusion!.attempts.find((entry) => entry.id === "attempt-reviewer")!;
  delete attempt.nativeRunId;
  await expect(f.tool("reviewer", { operation: "claim-register", claim: f.claim })).rejects.toThrow(
    "真实原生",
  );
  attempt.nativeRunId = "native-reviewer";
  const task = f.p.fusion!.tasks.find((entry) => entry.id === attempt.taskId)!;
  task.inputVersion++;
  await expect(f.tool("reviewer", { operation: "claim-register", claim: f.claim })).rejects.toThrow(
    "当前输入版本",
  );
  task.inputVersion--;
  f.artifact.content += "未被固定的新内容";
  await expect(f.tool("reviewer", { operation: "claim-register", claim: f.claim })).rejects.toThrow(
    "正文与固定任务记录",
  );
  expect(f.p.claims).toBeUndefined();
});

test("source snapshots changing during actual file reads reject registration before mutation", async () => {
  const f = await fixture();
  f.readDraft("lead");
  const pending = f.register();
  f.p.evidence!.sources[0]!.sha256 = researchHash("new source version");
  await expect(pending).rejects.toThrow("来源或课题快照已变化");
  expect(f.p.claims).toBeUndefined();
  const changedAttempt = await fixture();
  changedAttempt.readDraft("reviewer");
  const inFlight = changedAttempt.tool("reviewer", {
    operation: "claim-register",
    claim: changedAttempt.claim,
  });
  changedAttempt.p.fusion!.tasks.find((task) => task.role === "reviewer")!.inputVersion++;
  await expect(inFlight).rejects.toThrow("当前输入版本");
  expect(changedAttempt.p.claims).toBeUndefined();
});

test("missing or changed source text preserves located claims, and a new manuscript inherits no support", async () => {
  const f = await fixture();
  f.readDraft("lead");
  await f.register();
  f.readDraft("reviewer");
  f.readSource("reviewer");
  await f.review();
  await writeFile(f.sourceFile, "changed source bytes");
  const report = await researchClaimArtifactStatus(f.p, f.artifact.id);
  expect(report.blockers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "source-stale",
        claimId: f.claim.id,
        start: 0,
        exactText: sentence,
      }),
    ]),
  );
  expect(f.p.claims!.reviews).toHaveLength(1);
  f.p.evidence!.sources[0]!.file += ".unavailable";
  expect((await researchClaimArtifactStatus(f.p, f.artifact.id)).blocksFormalAcceptance).toBe(true);
  const next = f.publish("draft-2");
  f.readDraft("lead", next.id);
  expect(
    (await researchClaimArtifactStatus(f.p, next.id)).blockers.map((issue) => issue.code),
  ).toContain("claims-missing");
  await expect(f.register()).rejects.toThrow("生产者当前成果");
  expect(f.p.claims!.claims).toHaveLength(1);
});

test("a canonical computed run alone cannot substitute for the claimant and reviewer's actual read", async () => {
  const f = await fixture(true);
  f.readDraft("lead");
  f.claim.category = "research-result";
  f.claim.evidence = [{ kind: "result", runId: f.runId!, path: ["regression", "rSquared"] }];
  f.p.analysisReads = []; // A bare canonical run/old events do not replace host operation receipts.
  await expect(f.register()).rejects.toThrow("实际运行或读取过");
  await f.readResult("lead");
  await f.register();
  f.readDraft("reviewer");
  await expect(f.review()).rejects.toThrow("尚未实际读取");
  await f.readResult("reviewer");
  await f.review();
  expect((await researchClaimArtifactStatus(f.p, f.artifact.id)).blocksFormalAcceptance).toBe(
    false,
  );
  f.p.evidence!.datasets[0]!.sha256 = researchHash("different data");
  expect(
    (await researchClaimArtifactStatus(f.p, f.artifact.id)).blockers.map((issue) => issue.code),
  ).toContain("run-missing");
  await expect(f.review()).rejects.toThrow("当前计算结果");
});
