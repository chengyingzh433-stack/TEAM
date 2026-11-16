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
import type {
  ResearchClaimConclusion,
  ResearchClaimRequest,
} from "../../contracts/research-claims";
import { decodeResearchContentChecks } from "../../contracts/research-content-checks";
import {
  assertClaimAcceptance,
  prepareClaimAcceptance,
  requiresClaimAcceptance,
  type ClaimAcceptanceProject,
} from "../../electron/research-group/claim-acceptance";
import { applyResearchClaimTool } from "../../electron/research-group/claim-tools";
import { applyRegisteredAnalysisTool } from "../../electron/research-group/registered-analysis-tools";
import {
  finishFusionNativeRun,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import {
  addResearchTask,
  applyResearchChange,
  createResearchTaskGraph,
  finishResearchTaskAttempt,
  markResearchTaskDispatched,
  setResearchInput,
  startResearchTask,
} from "../../electron/research-group/task-graph";
import { researchHash } from "../../electron/research-group/materials";
import { researchAcceptanceTaskContext } from "../../electron/research-group/acceptance-context";

const time = (n: number) => new Date(Date.UTC(2026, 10, 7, 16, 0, n)).toISOString();
const sourceBody = "The study describes two schools; it does not establish a national conclusion.";
const body = "这项研究材料只涉及两所学校，不能据此判断全国总体。";
async function fixture(stage: "writing" | "audit" = "writing", withRun = false) {
  const directory = await mkdtemp(join(tmpdir(), "claim-acceptance-"));
  const sourceFile = join(directory, "source.txt");
  await writeFile(sourceFile, sourceBody);
  const p: ClaimAcceptanceProject = {
    id: randomUUID(),
    root: { workspaceId: directory, sessionId: "mentor" },
    workspacePath: directory,
    objective: "合成软件验收，不代表真实学术审阅或专家确认。",
    revision: 1,
    status: "running",
    createdAt: time(0),
    updatedAt: time(0),
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "materials",
    goal: "paper",
    scope: "paper",
    path: withRun ? "quantitative" : "review",
    currentStage: stage,
    knowledge: { directory, sha256: "fixture", version: "fixture", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: directory, sessionId: role },
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
          id: "SOURCE",
          title: "合成来源",
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
    inputId: "source:SOURCE",
    version: 1,
    kind: "material",
    availability: "available",
    actual: true,
    label: "合成文本",
    sourceRef: sourceFile,
    digest: researchHash(sourceBody),
  });
  p.fusion = applyResearchChange(p.fusion, {
    id: "adopt-source",
    at: time(0),
    inputId: "source:SOURCE",
    fromVersion: null,
    toVersion: 1,
    reason: "采用固定合成验收原文",
    authorizedBy: "existing-authorization",
    authorizationRef: "fixture",
  });
  const start = (role: ResearchRole, atStage: "writing" | "audit" | "analysis") => {
    const id = `v1:${atStage}:${role}`,
      attemptId = `attempt-${atStage}-${role}`;
    p.fusion = addResearchTask(p.fusion!, {
      id,
      stage: atStage,
      role,
      kind: atStage === "analysis" ? "analysis" : "writing",
      goal: "同稿主张门禁验收",
      inputs: [{ inputId: "source:SOURCE", version: 1, requirement: "available" }],
      dependencies: [],
      earlyHandoff: "当前稿件",
      deliverable: "同稿结果",
      reviewRequired: true,
      writeScope: [`fixture/${id}`],
    });
    p.fusion = startResearchTask(p.fusion, id, {
      id: attemptId,
      at: time(0),
      reservedTokens: 0,
      model: { provider: "fixture-host", modelId: `model-${role}` },
    });
    p.fusion = markResearchTaskDispatched(p.fusion, attemptId, time(0));
    p.fusion.attempts.find((attempt) => attempt.id === attemptId)!.nativeRunId =
      `native-${atStage}-${role}`;
  };
  let runId: string | undefined;
  if (withRun) {
    p.currentStage = "analysis";
    start("lead", "analysis");
    const csv = "x,y\n1,3\n2,5\n3,7\n4,9\n",
      file = join(directory, "data.csv");
    await writeFile(file, csv);
    p.evidence!.datasets.push({
      id: "DATA",
      file,
      sha256: researchHash(csv),
      sourceId: "SOURCE",
      description: "合成数据",
      dataKind: "synthetic",
      permission: "user-authorized",
      delimiter: ",",
    });
    await applyRegisteredAnalysisTool(
      p,
      "lead",
      "plan",
      {
        operation: "register-analysis",
        plan: {
          id: "main",
          version: 1,
          label: "合成OLS",
          purpose: "primary",
          objective: "验证结果文件依赖",
          dataset: { id: "DATA" },
          method: "ols",
          columns: ["x"],
          outcome: "y",
          parameters: {},
          outputs: ["regression.rSquared"],
          sample: { mode: "all" },
          reviewPlan: "模型读取实际结果后解释",
          registrationReason: "合成软件验收",
          timing: "prospective",
        },
      },
      time(1),
    );
    const run = await applyRegisteredAnalysisTool(
      p,
      "lead",
      "run",
      {
        operation: "run-analysis",
        planId: "main",
        planVersion: 1,
      },
      time(2),
    );
    runId = (run.result as { id: string }).id;
    p.fusion = finishResearchTaskAttempt(p.fusion!, "attempt-analysis-lead", {
      at: time(3),
      usedTokens: 1,
    });
    p.currentStage = stage;
  }
  for (const role of RESEARCH_ROLES) start(role, stage);
  const publish = (id = "revision-1", content = body) => {
    const artifact: ResearchArtifact = {
      id,
      role: "lead",
      kind: "stage-revision",
      revision: 1,
      round: 1,
      createdAt: time(5),
      content,
      refs: [],
      toolCallId: `publish-${id}`,
      stage,
    };
    p.artifacts.push(artifact);
    publishFusionArtifact(p, artifact);
    for (const role of RESEARCH_ROLES)
      p.events.push({
        id: randomUUID(),
        at: time(6),
        revision: 1,
        type: "read",
        role,
        artifactId: id,
        runId: `native-${stage}-${role}`,
        detail: "真实宿主读取的合成夹具记录",
      });
    return artifact;
  };
  const artifact = publish();
  for (const role of RESEARCH_ROLES) {
    p.sourceReads!.push({
      id: `source-read-${role}`,
      sourceId: "SOURCE",
      sourceSha256: researchHash(sourceBody),
      bodySha256: researchHash(sourceBody),
      locatorId: "text:SOURCE",
      start: 0,
      end: sourceBody.length,
      depth: "partial-text",
      sessionId: role,
      at: time(6),
      evidenceRef: `source-read:${role}`,
    });
    if (runId)
      await applyRegisteredAnalysisTool(
        p,
        role,
        `actual-read-${role}`,
        {
          operation: "read-registered-analysis",
          analysisId: runId,
        },
        time(6),
      );
  }
  let serial = 10;
  const register = async (target = artifact, id = `claim-${target.id}`) => {
    const claim: ResearchClaimRequest = {
      id,
      artifactId: target.id,
      start: 0,
      end: target.content.length,
      category: withRun ? "research-result" : "source-fact",
      evidence: withRun
        ? [{ kind: "result", runId: runId!, path: ["regression", "rSquared"] }]
        : [
            {
              kind: "source",
              sourceId: "SOURCE",
              locatorId: "text:SOURCE",
              start: 0,
              end: sourceBody.length,
              requiredDepth: "partial-text",
              relation: "support",
            },
          ],
    };
    await applyResearchClaimTool(
      p,
      "lead",
      `register-${++serial}`,
      { operation: "claim-register", claim },
      time(serial),
    );
    return claim;
  };
  const review = async (
    conclusion: ResearchClaimConclusion = "supported",
    role: "reviewer" | "mentor" = "reviewer",
    claimId = `claim-${artifact.id}`,
  ) => {
    await applyResearchClaimTool(
      p,
      role,
      `review-${++serial}`,
      {
        operation: "claim-review",
        review: {
          claimId,
          conclusion,
          reason: "这是合成模型的语义意见；局部样本不能推广全国，程序不证明这条意见正确。",
          resolvesReviewIds: [],
        },
      },
      time(serial),
    );
  };
  const input = (role: ResearchRole = "reviewer", target = artifact): Record<string, unknown> => ({
    operation: "publish",
    revision: p.revision,
    kind: role === "reviewer" ? "stage-verification" : "stage-review",
    stage,
    verdict: "accept",
    refs: [target.id],
    content: "同稿模型接受意见，仍受程序版本与读取门禁约束。",
  });
  const supported = async () => {
    await register();
    await review();
  };
  return { p, artifact, sourceFile, runId, publish, register, review, input, supported };
}

test("claim acceptance covers all full-paper paths in S7/S8 and leaves limited scopes outside", async () => {
  for (const stage of ["writing", "audit"] as const) {
    const f = await fixture(stage);
    for (const path of ["quantitative", "review", "qualitative", "theoretical"] as const) {
      f.p.path = path;
      expect(requiresClaimAcceptance(f.p, "reviewer", f.input())).toBe(true);
      expect(requiresClaimAcceptance(f.p, "mentor", f.input("mentor"))).toBe(true);
    }
    for (const change of [
      { scope: "proposal" },
      { goal: "task" },
      { entry: "task" },
      { entry: "manuscript" },
      { workflowVersion: "legacy-v1" },
    ])
      expect(
        requiresClaimAcceptance(
          { ...f.p, ...change } as ClaimAcceptanceProject,
          "reviewer",
          f.input(),
        ),
      ).toBe(false);
    expect(requiresClaimAcceptance(f.p, "reviewer", { ...f.input(), verdict: "hold" })).toBe(false);
    expect(requiresClaimAcceptance(f.p, "reviewer", { ...f.input(), kind: "stage-critique" })).toBe(
      false,
    );
    const count = f.p.contentChecks?.length ?? 0;
    expect(
      await prepareClaimAcceptance(
        { ...f.p, goal: "task" },
        "reviewer",
        "limited",
        f.input(),
        time(40),
      ),
    ).toMatchObject({ required: false, blocked: false });
    expect(f.p.contentChecks?.length ?? 0).toBe(count);
  }
});

test("missing claims, absent B and all unresolved negative conclusions persist located blockers", async () => {
  const f = await fixture();
  const missing = await prepareClaimAcceptance(f.p, "reviewer", "missing", f.input(), time(40));
  expect(missing).toMatchObject({ required: true, blocked: true });
  expect(missing.record!.issues.map((issue) => issue.code)).toContain("claims-missing");
  await f.register();
  expect(
    (
      await prepareClaimAcceptance(f.p, "reviewer", "unread", f.input(), time(40))
    ).record!.issues.map((issue) => issue.code),
  ).toContain("review-missing");
  for (const conclusion of [
    "partially-supported",
    "unsupported",
    "insufficient-material",
  ] as const) {
    await f.review(conclusion);
    const check = await prepareClaimAcceptance(f.p, "reviewer", conclusion, f.input(), time(40));
    expect(check.blocked).toBe(true);
    expect(check.record!.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: `review-${conclusion}`,
          claimId: `claim-${f.artifact.id}`,
          start: 0,
          end: body.length,
          exactText: body,
        }),
      ]),
    );
    expect(check.record!.claimChecks![0]!.reviews[0]).toMatchObject({
      conclusion,
      actor: {
        kind: "model",
        role: "reviewer",
        sessionId: "reviewer",
        runId: "native-writing-reviewer",
        provider: "fixture-host",
      },
      actualReads: [f.p.sourceReads!.find((read) => read.sessionId === "reviewer")],
    });
  }
  await f.review("supported", "mentor");
  expect(
    (await prepareClaimAcceptance(f.p, "mentor", "mentor-override", f.input("mentor"), time(40)))
      .blocked,
  ).toBe(true);
  expect(decodeResearchContentChecks(f.p.contentChecks)).toHaveLength(f.p.contentChecks!.length);
  expect(JSON.stringify(f.p.contentChecks)).not.toContain(sourceBody);
});

test("fresh supported checks and assertion pass for the role-owned stage and retain both program kinds", async () => {
  const f = await fixture();
  await f.supported();
  f.p.currentStage = "analysis"; // Navigation changes; the actual B native attempt still owns writing.
  const check = await prepareClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(40));
  expect(check).toMatchObject({
    required: true,
    blocked: false,
    record: {
      kind: "claim-acceptance",
      program: { kind: "program", id: "claim-acceptance-1" },
      stage: "writing",
      target: { artifactId: f.artifact.id, bodySha256: researchHash(body) },
    },
  });
  await assertClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(41));
  expect(f.p.contentChecks).toHaveLength(1);
  const { claimChecks: _claimChecks, ...numeric } = check.record!;
  const mixed = decodeResearchContentChecks([
    check.record,
    {
      ...numeric,
      id: "old-numeric",
      kind: "numeric-acceptance",
      program: { kind: "program", id: "numeric-acceptance-1" },
    },
  ]);
  expect(mixed).toHaveLength(2);
  expect(() =>
    decodeResearchContentChecks([
      {
        ...check.record,
        claimChecks: check.record!.claimChecks!.map((claim) => ({ ...claim, reviews: [] })),
      },
    ]),
  ).toThrow("主张程序通过");
  expect(() =>
    decodeResearchContentChecks([
      { ...check.record, program: { kind: "program", id: "numeric-acceptance-1" } },
    ]),
  ).toThrow();
  await expect(
    assertClaimAcceptance(f.p, "mentor", "not-prepared", f.input("mentor"), time(41)),
  ).rejects.toThrow("缺少同一宿主调用");
});

for (const role of ["reviewer", "mentor"] as const) {
  test(`claim ${role} acceptance survives another producer finishing its native turn after prepare`, async () => {
    const f = await fixture();
    await f.supported();
    const input = f.input(role);
    const evidence = () => ({
      artifacts: f.p.artifacts,
      graphArtifacts: f.p.fusion!.artifacts,
      sources: f.p.evidence,
      sourceReads: f.p.sourceReads,
      claims: f.p.claims,
      reads: f.p.events.filter((event) => event.type === "read"),
      inputs: f.p.fusion!.inputs,
      adoptedInputs: f.p.fusion!.adoptedInputs,
      decisions: f.p.fusion!.decisions,
      acceptingAttempt: f.p.fusion!.attempts.find(
        (attempt) => attempt.id === `attempt-writing-${role}`,
      ),
      acceptingTask: f.p.fusion!.tasks.find((task) => task.id === `v1:writing:${role}`),
    });
    const unchanged = structuredClone(evidence());
    const prepared = await prepareClaimAcceptance(f.p, role, "finish-other", input, time(40));
    expect(prepared).toMatchObject({ required: true, blocked: false });
    const contextBefore = structuredClone(researchAcceptanceTaskContext(f.p, role));
    expect(
      f.p.fusion!.attempts.find((attempt) => attempt.id === "attempt-writing-lead"),
    ).toMatchObject({ state: "running", nativeRunId: "native-writing-lead" });
    finishFusionNativeRun(f.p, "lead", "native-writing-lead", time(41), {
      input: 20,
      output: 10,
      cacheRead: 3,
      cacheWrite: 1,
    });
    const producer = f.p.members.find((member) => member.role === "lead")!;
    producer.status = "idle";
    producer.finishedAt = time(41);
    f.p.updatedAt = time(41);
    f.p.events.push({
      id: randomUUID(),
      at: time(41),
      runtimeAt: time(41),
      revision: f.p.revision,
      type: "finished",
      role: "lead",
      runId: "native-writing-lead",
      detail: "合成L夹具：生产者正常结束；没有改稿、改来源或重新采用输入。",
    });
    expect(
      f.p.fusion!.attempts.find((attempt) => attempt.id === "attempt-writing-lead"),
    ).toMatchObject({ state: "succeeded", finishedAt: time(41), usedTokens: 34 });
    expect(f.p.fusion!.tasks.find((task) => task.id === "v1:writing:lead")!.state).toBe(
      "completed",
    );
    expect(evidence()).toEqual(unchanged);
    await test.info().attach("acceptance-task-context-before-after", {
      body: JSON.stringify(
        { before: contextBefore, after: researchAcceptanceTaskContext(f.p, role) },
        null,
        2,
      ),
      contentType: "application/json",
    });
    await expect(
      assertClaimAcceptance(f.p, role, "finish-other", input, time(42)),
    ).resolves.toBeUndefined();
    expect(f.p.contentChecks).toHaveLength(1);
  });
}

test("model reports, wrong roles/stages and stale references cannot authorize acceptance", async () => {
  const f = await fixture();
  await f.supported();
  const forged = await prepareClaimAcceptance(
    f.p,
    "reviewer",
    "forged",
    { ...f.input(), report: { blocksFormalAcceptance: false } },
    time(40),
  );
  expect(forged.record!.issues.map((issue) => issue.code)).toContain("host-claim-check-required");
  expect(
    (await prepareClaimAcceptance(f.p, "lead", "wrong-role", f.input(), time(40))).blocked,
  ).toBe(true);
  expect(
    (
      await prepareClaimAcceptance(
        f.p,
        "reviewer",
        "wrong-stage",
        { ...f.input(), stage: "audit" },
        time(40),
      )
    ).blocked,
  ).toBe(true);
  expect(
    (
      await prepareClaimAcceptance(
        f.p,
        "reviewer",
        "wrong-ref",
        { ...f.input(), refs: ["old"] },
        time(40),
      )
    ).record!.issues.map((issue) => issue.code),
  ).toContain("latest-target-reference-required");
});

test("unreferenced failures do not block; a referenced source changing after prepare cannot pass assertion", async () => {
  const f = await fixture();
  await f.supported();
  f.p.evidence!.sources.push({
    ...f.p.evidence!.sources[0]!,
    id: "UNRELATED",
    file: `${f.sourceFile}.not-present`,
  });
  expect(
    (await prepareClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(40))).blocked,
  ).toBe(false);
  await writeFile(f.sourceFile, "The actual source now says something else.");
  await expect(
    assertClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(41)),
  ).rejects.toThrow("正式发布前主张检查未通过");
  expect(f.p.contentChecks!.at(-1)!.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "source-stale", claimId: `claim-${f.artifact.id}` }),
    ]),
  );
  expect(f.p.contentChecks![0]!.result).toBe("passed-at-snapshot");
});

test("a new manuscript cannot inherit the old prepared check even when its own claims become supported", async () => {
  const f = await fixture();
  await f.supported();
  await prepareClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(40));
  const next = f.publish("revision-2", `${body}这是新修订。`);
  await f.register(next);
  await f.review("supported", "reviewer", `claim-${next.id}`);
  await expect(
    assertClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(41)),
  ).rejects.toThrow("目标稿件已变化");
  await expect(
    assertClaimAcceptance(f.p, "reviewer", "accept", f.input("reviewer", next), time(41)),
  ).rejects.toThrow("缺少同一宿主调用");
  expect(
    (await prepareClaimAcceptance(f.p, "reviewer", "accept", f.input("reviewer", next), time(42)))
      .blocked,
  ).toBe(false);
  await assertClaimAcceptance(f.p, "reviewer", "accept", f.input("reviewer", next), time(43));
});

test("changed reading receipts, evaluation exceptions and in-flight changes become saved program blockers", async () => {
  const f = await fixture();
  await f.supported();
  await prepareClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(40));
  f.p.sourceReads!.find((read) => read.sessionId === "reviewer")!.bodySha256 = "a".repeat(64);
  await expect(
    assertClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(41)),
  ).rejects.toThrow("正式发布前主张检查未通过");
  expect(f.p.contentChecks!.at(-1)!.issues.map((issue) => issue.code)).toContain(
    "review-read-missing",
  );
  f.p.claims!.reviews[0]!.reason = "";
  const failed = await prepareClaimAcceptance(f.p, "reviewer", "bad-record", f.input(), time(42));
  expect(failed).toMatchObject({ blocked: true });
  expect(failed.record!.issues.map((issue) => issue.code)).toContain("actual-claim-check-failed");
  const racing = await fixture();
  await racing.supported();
  const pending = prepareClaimAcceptance(racing.p, "reviewer", "race", racing.input(), time(40));
  racing.p.fusion!.tasks.find((task) => task.role === "reviewer")!.inputVersion++;
  const result = await pending;
  expect(result.blocked).toBe(true);
  expect(result.record!.issues.map((issue) => issue.code)).toContain("claim-context-changed");
});

test("assertion rereads the referenced actual result files instead of trusting a canonical run or prior pass", async () => {
  const f = await fixture("writing", true);
  await f.supported();
  expect(
    (await prepareClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(40))).blocked,
  ).toBe(false);
  const projection = f.p.analyses!.find((run) => run.id === f.runId)!;
  await writeFile(
    projection.file,
    JSON.stringify({ ...projection, result: { regression: { rSquared: 0.123 } } }),
  );
  await expect(
    assertClaimAcceptance(f.p, "reviewer", "accept", f.input(), time(41)),
  ).rejects.toThrow("正式发布前主张检查未通过");
  expect(f.p.contentChecks!.at(-1)!.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "actual-claim-result-invalid",
        claimId: `claim-${f.artifact.id}`,
        runId: f.runId,
        fieldPath: ["regression", "rSquared"],
        start: 0,
        exactText: body,
      }),
    ]),
  );
});

test("old result reading cannot resurrect a supported claim review and all private ledgers invalidate a prepared claim snapshot", async () => {
  const f = await fixture("writing", true);
  await f.supported();
  const baseline = structuredClone(f.p);
  const pass = await prepareClaimAcceptance(
    f.p,
    "reviewer",
    "private-ledgers",
    f.input(),
    time(40),
  );
  expect(pass.blocked).toBe(false);
  for (const key of ["analysisReads", "analysisRunAdoptions", "analysisReviewContexts"] as const) {
    const changed = structuredClone(baseline);
    changed.contentChecks = structuredClone(f.p.contentChecks);
    changed[key] = [];
    await expect(
      assertClaimAcceptance(changed, "reviewer", "private-ledgers", f.input(), time(41)),
    ).rejects.toThrow();
  }
  f.p.analysisReads = f.p.analysisReads!.filter((read) => read.context.role !== "reviewer");
  const blocked = await prepareClaimAcceptance(
    f.p,
    "reviewer",
    "missing-private-read",
    f.input(),
    time(41),
  );
  expect(blocked.blocked).toBe(true);
  expect(blocked.record!.issues.some((issue) => issue.code === "review-result-read-stale")).toBe(
    true,
  );
});
