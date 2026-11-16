import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  RESEARCH_ROLES,
  type ResearchArtifact,
  type ResearchRole,
} from "../../contracts/research-group";
import {
  RESEARCH_SYNTHESIS_COLUMNS,
  decodeResearchSynthesis,
  type ResearchSynthesisCellRequest,
  type ResearchSynthesisSourceRef,
} from "../../contracts/research-synthesis";
import { createResearchAnalysisRegistry } from "../../electron/research-group/analysis-registry";
import {
  createResearchClaimArtifactSnapshot,
  createResearchClaims,
  registerResearchClaim,
} from "../../electron/research-group/claims";
import {
  attachFusionArtifactInputs,
  attachFusionSourceInputs,
  activeFusionAttempt,
  bindFusionNativeRun,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import { researchHash } from "../../electron/research-group/materials";
import { researchGroupToolResult } from "../../electron/research-group/runtime-extension";
import {
  applyResearchSynthesisTool,
  assertResearchSynthesisAcceptance,
  captureResearchSynthesisOwner,
  recordResearchSynthesisSourceRead,
  recordResearchSynthesisTargetRead,
  researchSynthesisArtifactStatus,
  validateResearchSynthesisProject,
  type SynthesisProject,
} from "../../electron/research-group/synthesis-tools";
import {
  addResearchTask,
  applyResearchChange,
  createResearchTaskGraph,
  finishResearchTaskAttempt,
  markResearchTaskDispatched,
  publishResearchTaskResult,
  reviewResearchTaskArtifact,
  setResearchInput,
  startResearchTask,
} from "../../electron/research-group/task-graph";

/**
 * Success: real pinned fixture text -> same-native sourceReads -> seven-column matrix /
 * three-state gap -> explicitly declared counterevidence -> only related graph versions
 * advance -> A's located new draft -> B's own source/new-draft read -> named mentor close.
 * Failure: metadata cannot masquerade as full text; borrowed, old-native, late request,
 * stale draft, forged host fields, negative B, and mentor accept cannot close that chain.
 * These are deterministic software contract fixtures, never real papers or R/C proof.
 * Reproduce without build/Electron:
 * pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/unit/research-synthesis-tools.spec.ts
 */
const bodies: Record<string, string> = {
  S1: "Software fixture only. A limited two-school study examined study time. 🧪",
  S2: "Software fixture only. An existing study already answers the narrow question; its context differs.",
};
const beforeBody = "在本限定范围，学习时间与成绩这一具体关系仍需验证。";
const afterBody = "已有研究回答了原问题的一部分；候选缺口收窄为另一情境中的测量差异。";
const sourceRef = (
  sourceId = "S1",
  requiredDepth: ResearchSynthesisSourceRef["requiredDepth"] = "partial-text",
): ResearchSynthesisSourceRef => ({
  sourceId,
  locatorId: `text:${sourceId}`,
  start: 0,
  end: bodies[sourceId]!.length,
  requiredDepth,
});

async function fixture(reviewerStage: "question" | "synthesis" = "synthesis") {
  const directory = await mkdtemp(join(tmpdir(), "research-synthesis-unit-"));
  const taskStage = (role: ResearchRole) => (role === "reviewer" ? reviewerStage : "synthesis");
  const taskId = (role: ResearchRole) => `v1:${taskStage(role)}:${role}`;
  let serial = 0,
    clock = 0;
  const now = () => new Date(Date.UTC(2026, 10, 8, 0, 0, ++clock)).toISOString();
  const at = now();
  const p: SynthesisProject = {
    id: randomUUID(),
    root: { workspaceId: directory, sessionId: "session-mentor" },
    workspacePath: directory,
    objective: "Synthetic software validation, not original research or expert review",
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
    currentStage: "synthesis",
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
    evidence: { directory, sources: [], datasets: [] },
  };
  p.fusion = createResearchTaskGraph(p.id, "2.0.0");
  for (const [id, body] of Object.entries(bodies)) {
    const file = join(directory, `${id}.txt`);
    await writeFile(file, body);
    p.evidence!.sources.push({
      id,
      file,
      title: `${id} synthetic software fixture`,
      authors: "Fixture",
      year: "2026",
      url: `fixture:${id}`,
      sha256: researchHash(body),
      kind: "paper",
      access: "provided-text",
    });
    p.fusion = setResearchInput(p.fusion, {
      inputId: `source:${id}`,
      version: 1,
      kind: "material",
      availability: "available",
      actual: true,
      label: id,
      sourceRef: file,
      digest: researchHash(body),
    });
    p.fusion = applyResearchChange(p.fusion, {
      id: `adopt:${id}`,
      at,
      inputId: `source:${id}`,
      fromVersion: null,
      toVersion: 1,
      reason: "Explicit fixture adoption",
      authorizedBy: "existing-authorization",
      authorizationRef: "fixture",
    });
  }
  for (const role of RESEARCH_ROLES) {
    p.fusion = addResearchTask(p.fusion, {
      id: taskId(role),
      stage: taskStage(role),
      role,
      kind: "research",
      goal: "Fixture contract",
      inputs: ["S1", "S2"].map((id) => ({
        inputId: `source:${id}`,
        version: 1,
        requirement: "available",
      })),
      dependencies: [],
      earlyHandoff: "Located matrix",
      deliverable: "Draft",
      reviewRequired: true,
      writeScope: [role],
    });
  }
  p.fusion = addResearchTask(p.fusion, {
    id: "v1:writing:dependent",
    stage: "writing",
    role: "dependent-fixture",
    kind: "writing",
    goal: "Only related downstream",
    inputs: [],
    dependencies: [{ taskId: "v1:synthesis:lead", requirement: "accepted" }],
    earlyHandoff: "draft",
    deliverable: "writing",
    reviewRequired: true,
    writeScope: ["dependent"],
  });
  p.fusion = addResearchTask(p.fusion, {
    id: "v1:analysis:unrelated",
    stage: "analysis",
    role: "unrelated-fixture",
    kind: "analysis",
    goal: "Unrelated preserved computation fixture",
    inputs: [{ inputId: "source:S1", version: 1, requirement: "available" }],
    dependencies: [],
    earlyHandoff: "result",
    deliverable: "result",
    reviewRequired: false,
    writeScope: ["unrelated"],
  });
  p.fusion = markResearchTaskDispatched(
    startResearchTask(p.fusion, "v1:analysis:unrelated", {
      id: "unrelated-attempt",
      at: now(),
      reservedTokens: 0,
    }),
    "unrelated-attempt",
    now(),
  );
  p.fusion = publishResearchTaskResult(p.fusion, {
    id: "unrelated-result",
    projectId: p.id,
    attemptId: "unrelated-attempt",
    at: now(),
    content: "preserved computation fixture: 4",
    usedTokens: 0,
  });
  const start = (role: ResearchRole) => {
    const id = `${role}-attempt-${++serial}`,
      at = now();
    p.fusion = markResearchTaskDispatched(
      startResearchTask(p.fusion!, taskId(role), {
        id,
        at,
        reservedTokens: 0,
        model: { provider: "fixture-host", modelId: `fixture-${role}` },
      }),
      id,
      at,
    );
    bindFusionNativeRun(p, role, `native-${id}`);
    return id;
  };
  const resumeCurrentRole = (role: ResearchRole) => {
    const task = p.fusion!.tasks.find((row) => row.id === taskId(role))!;
    const old = activeFusionAttempt(p, role);
    if (old?.taskVersion === task.inputVersion) return old.id;
    if (old) {
      // A real change leaves the in-flight native running on its old input version.
      // Complete that known request before dispatching/binding the new task version.
      expect(old.state).toBe("running");
      expect(old.taskVersion).toBeLessThan(task.inputVersion);
      p.fusion = finishResearchTaskAttempt(p.fusion!, old.id, { at: now() });
      expect(p.fusion.attempts.find((row) => row.id === old.id)!.state).toBe("succeeded");
    }
    const id = start(role);
    expect(activeFusionAttempt(p, role)).toMatchObject({
      id,
      state: "running",
      taskVersion: task.inputVersion,
      nativeRunId: `native-${id}`,
      model: { provider: "fixture-host", modelId: `fixture-${role}` },
    });
    return id;
  };
  for (const role of RESEARCH_ROLES) start(role);
  const publish = (id = "draft-before", body = beforeBody) => {
    const artifact: ResearchArtifact = {
      id,
      role: "lead",
      kind: "stage-draft",
      revision: 1,
      round: 0,
      createdAt: now(),
      content: body,
      refs: [],
      toolCallId: `publish-${id}`,
      stage: "synthesis",
    };
    p.artifacts.push(artifact);
    publishFusionArtifact(p, artifact);
    return artifact;
  };
  const before = publish();
  const readDraft = (role: ResearchRole, artifactId = before.id) =>
    attachFusionArtifactInputs(p, role, [artifactId], now(), `read:fixture:${++serial}`);
  const sourceRead = (
    role: ResearchRole,
    id = "S1",
    options: {
      start?: number;
      end?: number;
      depth?: ResearchSynthesisSourceRef["requiredDepth"];
      bind?: boolean;
    } = {},
  ) => {
    const captured = captureResearchSynthesisOwner(p, role),
      at = now();
    attachFusionSourceInputs(p, role, [id], at, `source-read:${id}:${options.start ?? 0}`);
    const receipt = {
      id: `fixture-read-${++serial}`,
      sourceId: id,
      sourceSha256: researchHash(bodies[id]!),
      bodySha256: researchHash(bodies[id]!),
      locatorId: `text:${id}`,
      start: options.start ?? 0,
      end: options.end ?? bodies[id]!.length,
      depth: options.depth ?? ("partial-text" as const),
      sessionId: captured.sessionId,
      at,
      evidenceRef: `tool:read-${serial}`,
    };
    p.sourceReads!.push(receipt);
    if (options.bind !== false) recordResearchSynthesisSourceRead(p, captured, receipt.id);
    return { captured, receipt };
  };
  const tool = (
    role: ResearchRole,
    operation: string,
    request?: unknown,
    callId = `fixture-call-${++serial}`,
  ) =>
    applyResearchSynthesisTool(
      p,
      role,
      callId,
      { operation, ...(request ? { request } : {}) },
      now(),
    );
  const matrixRequest = (id = "matrix-before", artifactId = before.id, source = "S1") => ({
    id,
    artifactId,
    rows: [
      {
        sourceId: source,
        cells: Object.fromEntries(
          RESEARCH_SYNTHESIS_COLUMNS.map((column) => [
            column,
            column === "conceptsMeasures"
              ? { unavailable: "Exact measurement unavailable in this fixture text" }
              : {
                  summary: `Fixture ${column}; limited to actual source scope`,
                  evidence: [sourceRef(source)],
                },
          ]),
        ) as Record<(typeof RESEARCH_SYNTHESIS_COLUMNS)[number], ResearchSynthesisCellRequest>,
      },
    ],
  });
  const prepare = async () => {
    sourceRead("lead");
    readDraft("lead");
    await tool("lead", "synthesis-matrix", matrixRequest());
    p.claims = registerResearchClaim(
      createResearchClaims(),
      {
        artifacts: [createResearchClaimArtifactSnapshot(before.id, before.content)],
        sources: [
          {
            ...createResearchClaimArtifactSnapshot("S1", bodies.S1!),
            sha256: researchHash(bodies.S1!),
            available: true,
            locators: [
              {
                id: "text:S1",
                label: "fixture UTF-16",
                start: 0,
                end: bodies.S1!.length,
                depth: "partial-text",
              },
            ],
          },
        ],
        structuredActualReads: p.sourceReads!,
        registry: createResearchAnalysisRegistry(),
        currentDatasets: [],
      },
      {
        id: "claim-before",
        artifactId: before.id,
        start: 0,
        end: before.content.length,
        category: "inference",
        evidence: [{ kind: "source", ...sourceRef(), relation: "support" }],
      },
    );
    await tool("lead", "synthesis-gap", {
      id: "gap-before",
      artifactId: before.id,
      statement: beforeBody,
      scope: "Fixture-only two-school context",
      state: "pending-validation",
      matrixIds: ["matrix-before"],
      claimIds: ["claim-before"],
      evidence: [sourceRef()],
      counterSearchBatchIds: [],
      remainingUncertainty: "No real research claim is established",
    });
    // Even the fixture's accepted baseline has a real host-recorded mentor read;
    // its review must be reopened when that actually consumed draft is challenged.
    readDraft("mentor");
    p.fusion = reviewResearchTaskArtifact(p.fusion!, before.id, {
      id: "fixture-accepted",
      at: now(),
      actor: "program",
      reviewer: "software-fixture",
      verdict: "accepted",
      reason: "Fixture setup only, not academic acceptance",
    });
  };
  const challengeRequest = () => ({
    id: "counter-1",
    source: sourceRef("S2"),
    claimIds: [],
    gapIds: ["gap-before"],
    reason:
      "Fixture S2 explicitly addresses the previously unresolved narrow question; context still differs",
    materialChange: true,
  });
  const challenge = async () => {
    sourceRead("reviewer", "S2");
    readDraft("reviewer");
    await tool("reviewer", "synthesis-counterevidence", challengeRequest());
  };
  const respond = async () => {
    const old = activeFusionAttempt(p, "lead")!;
    p.fusion = finishResearchTaskAttempt(p.fusion!, old.id, { at: now() });
    start("lead");
    sourceRead("lead", "S1");
    sourceRead("lead", "S2");
    const after = publish("draft-after", afterBody);
    readDraft("lead", after.id);
    await tool("lead", "synthesis-matrix", {
      ...matrixRequest("matrix-after", after.id, "S2"),
      supersedesId: "matrix-before",
    });
    await tool("lead", "synthesis-gap", {
      id: "gap-after",
      artifactId: after.id,
      supersedesId: "gap-before",
      statement: afterBody,
      scope: "Fixture context narrowed",
      state: "weakened-or-rejected",
      matrixIds: ["matrix-after"],
      claimIds: [],
      evidence: [sourceRef("S2")],
      counterSearchBatchIds: [],
      remainingUncertainty: "Does not establish all settings or measures",
    });
    const request = {
      id: "response-1",
      counterevidenceId: "counter-1",
      artifactId: after.id,
      start: 0,
      end: after.content.length,
      reason: "Located draft now narrows the candidate gap",
      claimReplacements: [],
      gapReplacements: [{ beforeId: "gap-before", afterId: "gap-after" }],
    };
    await tool("lead", "synthesis-respond", request);
    return { after, request };
  };
  const review = async (conclusion = "addressed", id = "review-1") => {
    resumeCurrentRole("reviewer");
    sourceRead("reviewer", "S2");
    readDraft("reviewer", "draft-after");
    return tool("reviewer", "synthesis-review", {
      id,
      responseId: "response-1",
      start: 0,
      end: afterBody.length,
      conclusion,
      reason:
        "Fixture source addresses only the former narrow question; the new draft preserves context uncertainty",
    });
  };
  const resolve = async (reviewId = "review-1", decision = "close", id = "resolution-1") => {
    resumeCurrentRole("mentor");
    sourceRead("mentor", "S2");
    readDraft("mentor", "draft-after");
    return tool("mentor", "synthesis-resolve", {
      id,
      reviewId,
      decision,
      reason: "Named fixture mentor narrows the original gap and preserves limitations",
      direction: "narrow",
    });
  };
  return {
    p,
    now,
    before,
    start,
    resumeCurrentRole,
    publish,
    readDraft,
    sourceRead,
    tool,
    prepare,
    matrixRequest,
    challengeRequest,
    challenge,
    respond,
    review,
    resolve,
  };
}

test("synthesis context summarizes repeated read input pins without changing receipts, judgments or stored owners", async () => {
  const f = await fixture();
  await f.prepare();
  for (let index = 1; index < 49; index++) f.sourceRead("lead", "S1");
  const stored = JSON.stringify(f.p),
    ledger = structuredClone(f.p.synthesis!),
    owner = captureResearchSynthesisOwner(f.p, "lead"),
    { reads, ...judgments } = ledger,
    inputPinsSha256 = researchHash(
      JSON.stringify(
        ["S1", "S2"].map((id) => ({
          digest: researchHash(bodies[id]!),
          inputId: `source:${id}`,
          version: 1,
        })),
      ),
    ),
    wire = (await f.tool("lead", "synthesis-context")).result;
  expect(reads).toHaveLength(49);
  expect(wire).not.toHaveProperty(["reads", "0", "owner", "inputs"]);
  for (let index = 1; index < reads.length; index++)
    expect(wire).not.toHaveProperty(["reads", String(index), "owner", "inputs"]);
  expect(wire).toMatchObject({
    reads: reads.map((read) => {
      const { inputs, ...identity } = read.owner;
      expect(inputs).toHaveLength(2);
      return {
        id: read.id,
        receipt: read.receipt,
        owner: { ...identity, inputCount: 2, inputPinsSha256 },
      };
    }),
    owner,
    // The existing excerpt boundary is preserved; all allowed judgment fields stay intact.
    ...(JSON.parse(
      JSON.stringify(judgments, (key, value: unknown) => (key === "exactText" ? undefined : value)),
    ) as Record<string, unknown>),
  });
  const previousWireLength = JSON.stringify(
    { ...ledger, owner },
    (key, value: unknown) => (key === "exactText" ? undefined : value),
    2,
  ).length;
  expect(JSON.stringify(wire, null, 2).length).toBeLessThan(previousWireLength);
  for (const operation of ["status", "synthesis-context"]) {
    const transported = researchGroupToolResult(operation, wire);
    expect(transported.content[0]!.type).toBe("text");
    const text = (transported.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(text)).toEqual(wire);
    expect(text.length).toBeLessThan(JSON.stringify(wire, null, 2).length);
    expect(transported.details).toBe(wire);
  }
  expect(JSON.stringify(f.p)).toBe(stored);
  expect(f.p.synthesis!.reads.every((read) => read.owner.inputs.length === 2)).toBe(true);
});

test("synthesis context waits for B's own judgment and retains it through a same-revision local reopening", async () => {
  const f = await fixture();
  await f.prepare();
  expect(f.p.artifacts.some((artifact) => artifact.kind === "stage-risk")).toBe(false);
  await expect(f.tool("reviewer", "synthesis-context")).rejects.toThrow(/独立/);

  // Publish a real independent artifact on B's bound attempt, without borrowing A's draft.
  f.sourceRead("reviewer", "S1");
  const risk: ResearchArtifact = {
    id: "independent-risk",
    role: "reviewer",
    kind: "stage-risk",
    revision: f.p.revision,
    stage: "synthesis",
    round: 0,
    createdAt: f.now(),
    content: "先核对实际来源能覆盖的对象与测量边界，不能把未检索到等同于没有研究。",
    refs: [],
    sourceIds: ["S1"],
    toolCallId: "publish-independent-risk",
  };
  f.p.artifacts.push(risk);
  publishFusionArtifact(f.p, risk);
  const initialAttempt = structuredClone(activeFusionAttempt(f.p, "reviewer")!);
  expect(await f.tool("reviewer", "synthesis-context")).toMatchObject({
    result: {
      owner: { role: "reviewer", nativeRunId: initialAttempt.nativeRunId },
      matrices: [
        {
          rows: [
            {
              cells: {
                findings: { summary: "Fixture findings; limited to actual source scope" },
              },
            },
          ],
        },
      ],
      gaps: [{ statement: beforeBody }],
    },
  });

  await f.challenge();
  // The previous native remains real but owns the superseded input version.
  await expect(f.tool("reviewer", "synthesis-context")).rejects.toThrow("当前输入版本");
  f.resumeCurrentRole("reviewer");
  const reopenedAttempt = activeFusionAttempt(f.p, "reviewer")!;
  expect(reopenedAttempt.nativeRunId).not.toBe(initialAttempt.nativeRunId);
  expect(reopenedAttempt.taskVersion).toBeGreaterThan(initialAttempt.taskVersion);
  expect(f.p.revision).toBe(risk.revision);
  expect(f.p.artifacts.filter((artifact) => artifact.kind === "stage-risk")).toEqual([risk]);
  // Reopening the task invalidates current dependencies, not the fact that B judged independently.
  expect(await f.tool("reviewer", "synthesis-context")).toMatchObject({
    result: {
      owner: {
        role: "reviewer",
        nativeRunId: reopenedAttempt.nativeRunId,
        taskVersion: reopenedAttempt.taskVersion,
      },
      gaps: [{ statement: beforeBody }],
      counterevidence: [{ id: "counter-1" }],
    },
  });
});

test("an earlier-stage B judgment does not disclose A's later-stage synthesis before B judges that stage", async () => {
  const f = await fixture("question");
  await f.prepare();
  expect(f.p.currentStage).toBe("synthesis");
  expect(captureResearchSynthesisOwner(f.p, "reviewer").stage).toBe("question");
  f.sourceRead("reviewer", "S1");
  const risk: ResearchArtifact = {
    id: "independent-question-risk",
    role: "reviewer",
    kind: "stage-risk",
    revision: f.p.revision,
    stage: "question",
    round: 0,
    createdAt: f.now(),
    content: "本人仅判断当前研究问题的证据边界，尚未读取或判断后继综合阶段的 A 观点。",
    refs: [],
    sourceIds: ["S1"],
    toolCallId: "publish-independent-question-risk",
  };
  f.p.artifacts.push(risk);
  publishFusionArtifact(f.p, risk);
  expect(f.p.artifacts.filter((artifact) => artifact.kind === "stage-risk")).toEqual([risk]);
  // Role sessions overlap stages; the question-stage judgment cannot open the synthesis ledger.
  const outcome = await f.tool("reviewer", "synthesis-context").then(
    (value) => ({ kind: "returned" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  if (outcome.kind === "rejected") {
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error)).toMatch(/独立/);
  } else {
    expect(outcome.value).toMatchObject({ result: { matrices: [], gaps: [] } });
    expect(JSON.stringify(outcome.value)).not.toContain(beforeBody);
    expect(JSON.stringify(outcome.value)).not.toContain(
      "Fixture findings; limited to actual source scope",
    );
  }
});

test("matrix cells pin actual paper scope and own reads; unavailable measurement stays explicit", async () => {
  const f = await fixture();
  f.readDraft("lead");
  await expect(f.tool("lead", "synthesis-matrix", f.matrixRequest())).rejects.toThrow(
    "真实 sourceReads",
  );
  const borrowed = f.sourceRead("reviewer");
  await expect(f.tool("lead", "synthesis-matrix", f.matrixRequest())).rejects.toThrow(
    "真实 sourceReads",
  );
  expect(f.p.sourceReads).toHaveLength(1);
  f.sourceRead("lead");
  const response = await f.tool("lead", "synthesis-matrix", f.matrixRequest());
  expect(JSON.stringify(response)).not.toContain(bodies.S1);
  const matrix = f.p.synthesis!.matrices[0]!;
  expect(matrix.rows[0]!.cells.conceptsMeasures).toEqual({
    unavailable: "Exact measurement unavailable in this fixture text",
  });
  const cell = matrix.rows[0]!.cells.findings;
  expect(cell).toMatchObject({
    evidence: [
      {
        sourceId: "S1",
        sourceSha256: researchHash(bodies.S1!),
        bodySha256: researchHash(bodies.S1!),
        start: 0,
        end: bodies.S1!.length,
        requiredDepth: "partial-text",
        exactText: bodies.S1,
      },
    ],
  });
  if ("evidence" in cell) expect(cell.evidence[0]!.readIds).not.toContain(borrowed.receipt.id);
  validateResearchSynthesisProject(f.p);
});

test("abstract/metadata cannot become full text, UTF-16 split is rejected, method notes are not original papers", async () => {
  const f = await fixture();
  f.readDraft("lead");
  f.sourceRead("lead");
  const request = f.matrixRequest();
  const cell = request.rows[0]!.cells.findings;
  if ("evidence" in cell) cell.evidence[0]!.requiredDepth = "full-text";
  await expect(f.tool("lead", "synthesis-matrix", request)).rejects.toThrow("摘要/部分正文");
  if ("evidence" in cell) {
    cell.evidence[0]!.requiredDepth = "partial-text";
    cell.evidence[0]!.end = bodies.S1!.indexOf("🧪") + 1;
  }
  await expect(f.tool("lead", "synthesis-matrix", request)).rejects.toThrow("UTF-16");
  f.p.evidence!.sources[0]!.kind = "method";
  await expect(f.tool("lead", "synthesis-matrix", f.matrixRequest())).rejects.toThrow("原始 paper");
  expect(f.p.synthesis!.matrices).toHaveLength(0);
});

test("unbound legacy reads stay historical and cannot count as current synthesis reading", async () => {
  const f = await fixture();
  f.readDraft("lead");
  f.sourceRead("lead", "S1", { bind: false });
  await expect(f.tool("lead", "synthesis-matrix", f.matrixRequest())).rejects.toThrow(
    "真实 sourceReads",
  );
  expect(f.p.sourceReads).toHaveLength(1);
  f.sourceRead("lead");
  await f.tool("lead", "synthesis-matrix", f.matrixRequest());
  expect(f.p.sourceReads).toHaveLength(2);
});

test("native read capture rejects a late old request; same-session old-native reads do not authorize new work", async () => {
  const f = await fixture();
  const { captured, receipt } = f.sourceRead("lead", "S1", { bind: false });
  f.p.fusion = finishResearchTaskAttempt(f.p.fusion!, captured.attemptId, { at: f.now() });
  f.p.fusion!.tasks.find((row) => row.id === captured.taskId)!.state = "pending";
  f.start("lead");
  expect(() => recordResearchSynthesisSourceRead(f.p, captured, receipt.id)).toThrow("旧请求");
  f.readDraft("lead");
  await expect(f.tool("lead", "synthesis-matrix", f.matrixRequest())).rejects.toThrow(
    "真实 sourceReads",
  );
  expect(f.p.sourceReads).toHaveLength(1);
});

test("gap support needs executed reverse-search scope and cannot be self-declared from an empty result", async () => {
  const f = await fixture();
  await f.prepare();
  const before = structuredClone(f.p.synthesis);
  const gap = {
    id: "gap-supported",
    artifactId: f.before.id,
    supersedesId: "gap-before",
    statement: "Limited fixture gap",
    scope: "Explicit bounded scope",
    state: "supported-in-scope",
    matrixIds: ["matrix-before"],
    claimIds: [],
    evidence: [sourceRef()],
    counterSearchBatchIds: [],
    remainingUncertainty: "Still uncertain",
  };
  await expect(f.tool("lead", "synthesis-gap", gap)).rejects.toThrow("实际反向检索范围");
  await expect(
    f.tool("lead", "synthesis-gap", { ...gap, counterSearchBatchIds: ["fabricated-query"] }),
  ).rejects.toThrow("真实检索账本");
  expect(f.p.synthesis).toEqual(before);
});

test("new counterevidence affects only explicitly named current objects and their existing graph downstream", async () => {
  const f = await fixture();
  await f.prepare();
  const unrelated = structuredClone(
    f.p.fusion!.tasks.find((row) => row.id === "v1:analysis:unrelated"),
  );
  const result = structuredClone(
    f.p.fusion!.artifacts.find((row) => row.id === "unrelated-result"),
  );
  f.sourceRead("reviewer", "S2");
  f.readDraft("reviewer");
  const declaringAttempt = structuredClone(activeFusionAttempt(f.p, "reviewer")!);
  await expect(
    f.tool("reviewer", "synthesis-counterevidence", {
      ...f.challengeRequest(),
      gapIds: ["unknown"],
    }),
  ).rejects.toThrow("候选缺口");
  const callId = "stable-counter-call";
  await f.tool("reviewer", "synthesis-counterevidence", f.challengeRequest(), callId);
  const challenge = f.p.synthesis!.counterevidence[0]!;
  expect(challenge.impact.affectedTaskIds).toEqual([
    "v1:synthesis:mentor",
    "v1:synthesis:lead",
    "v1:synthesis:reviewer",
    "v1:writing:dependent",
  ]);
  expect(challenge.impact.reusableTaskIds).toContain("v1:analysis:unrelated");
  expect(challenge.impact.reusableTaskIds).toContain("v1:synthesis:librarian");
  expect(f.p.fusion!.attempts.find((row) => row.id === declaringAttempt.id)).toMatchObject({
    state: "running",
    taskVersion: declaringAttempt.taskVersion,
    nativeRunId: declaringAttempt.nativeRunId,
  });
  expect(f.p.fusion!.tasks.find((row) => row.id === declaringAttempt.taskId)!.inputVersion).toBe(
    declaringAttempt.taskVersion + 1,
  );
  await expect(f.tool("reviewer", "synthesis-context")).rejects.toThrow("当前输入版本");
  expect(f.p.fusion!.tasks.find((row) => row.id === "v1:analysis:unrelated")).toEqual(unrelated);
  expect(f.p.fusion!.artifacts.find((row) => row.id === "unrelated-result")).toEqual(result);
  expect(f.p.fusion!.artifacts.find((row) => row.id === f.before.id)!.reviewState).toBe(
    "needs-review",
  );
  expect(f.p.synthesis!.gaps[0]!.state).toBe("pending-validation");
  expect((await researchSynthesisArtifactStatus(f.p, f.before.id)).blockers[0]!.code).toBe(
    "counterevidence-response-missing",
  );
  await expect(assertResearchSynthesisAcceptance(f.p, f.before.id)).rejects.toThrow("重审未关闭");
  await f.tool("reviewer", "synthesis-counterevidence", f.challengeRequest(), callId);
  expect(f.p.synthesis!.counterevidence).toHaveLength(1);
  expect(f.p.fusion!.changes.filter((row) => row.id === challenge.changeId)).toHaveLength(1);
  await expect(
    f.tool(
      "reviewer",
      "synthesis-counterevidence",
      { ...f.challengeRequest(), reason: "Different request" },
      callId,
    ),
  ).rejects.toThrow("不同请求");
  validateResearchSynthesisProject(f.p);
});

test("A responds in a new version, B reads original counterevidence and new draft, mentor closes material change", async () => {
  const f = await fixture();
  await f.prepare();
  const before = structuredClone(f.p.synthesis!.gaps[0]);
  await f.challenge();
  await f.respond();
  const open = await researchSynthesisArtifactStatus(f.p, "draft-after");
  expect(open.blockers.map((row) => row.code)).toContain("counterevidence-review-open");
  await f.review();
  expect(
    (await researchSynthesisArtifactStatus(f.p, "draft-after")).blockers.map((row) => row.code),
  ).toContain("counterevidence-mentor-open");
  await f.resolve();
  await expect(assertResearchSynthesisAcceptance(f.p, "draft-after")).resolves.toBeUndefined();
  expect(f.p.synthesis!.gaps[0]).toEqual(before);
  expect(f.p.synthesis!.gaps[1]).toMatchObject({
    state: "weakened-or-rejected",
    supersedesId: "gap-before",
    draft: { artifactId: "draft-after", taskVersion: 2 },
  });
  expect(f.p.synthesis!.reviews[0]!.host.owner).toMatchObject({
    role: "reviewer",
    sessionId: "session-reviewer",
    nativeRunId: expect.stringContaining("native-reviewer"),
    model: { provider: "fixture-host", modelId: "fixture-reviewer" },
  });
  expect(f.p.synthesis!.resolutions[0]!.host.owner.role).toBe("mentor");
  const reads = f.p.sourceReads!.length;
  await researchSynthesisArtifactStatus(f.p, "draft-after");
  expect(f.p.sourceReads).toHaveLength(reads);
});

test("B cannot borrow another native's source read and mentor close cannot override unresolved B", async () => {
  const f = await fixture();
  await f.prepare();
  await f.challenge();
  await f.respond();
  const old = activeFusionAttempt(f.p, "reviewer")!;
  f.resumeCurrentRole("reviewer");
  expect(activeFusionAttempt(f.p, "reviewer")!.id).not.toBe(old.id);
  f.readDraft("reviewer", "draft-after");
  await expect(
    f.tool("reviewer", "synthesis-review", {
      id: "borrowed-review",
      responseId: "response-1",
      start: 0,
      end: afterBody.length,
      conclusion: "addressed",
      reason: "Previous run had read it",
    }),
  ).rejects.toThrow("真实 sourceReads");
  await f.review("unresolved");
  await expect(f.resolve()).rejects.toThrow("不能用 accept 绕过");
  await expect(assertResearchSynthesisAcceptance(f.p, "draft-after")).rejects.toThrow("B 尚未");
  await f.review("addressed", "review-2");
  await f.resolve("review-2", "close", "resolution-2");
  expect(f.p.synthesis!.reviews).toHaveLength(2);
  await expect(assertResearchSynthesisAcceptance(f.p, "draft-after")).resolves.toBeUndefined();
});

test("a further new draft or changed source invalidates the previous closure without altering history", async () => {
  const f = await fixture();
  await f.prepare();
  await f.challenge();
  await f.respond();
  await f.review();
  await f.resolve();
  const count = f.p.synthesis!.resolutions.length;
  f.publish("draft-third", `${afterBody}增加新的结论。`);
  expect(
    (await researchSynthesisArtifactStatus(f.p, "draft-third")).blockers.map((row) => row.code),
  ).toContain("counterevidence-response-stale");
  await expect(assertResearchSynthesisAcceptance(f.p, "draft-third")).rejects.toThrow("当前新稿");
  expect(f.p.synthesis!.resolutions).toHaveLength(count);
  await writeFile(f.p.evidence!.sources.find((row) => row.id === "S2")!.file, "Replaced bytes");
  expect(
    (await researchSynthesisArtifactStatus(f.p, "draft-third")).blockers.map((row) => row.code),
  ).toContain("counterevidence-source-stale");
});

test("strict decoders reject hidden model identities; real host/model bindings are validated on restore", async () => {
  const f = await fixture();
  await f.prepare();
  await expect(
    f.tool("lead", "synthesis-matrix", { ...f.matrixRequest("forged"), host: { actor: "human" } }),
  ).rejects.toThrow("宿主专有字段");
  await expect(
    applyResearchSynthesisTool(
      f.p,
      "lead",
      "forged-top",
      { operation: "synthesis-context", actualReads: [] },
      f.now(),
    ),
  ).rejects.toThrow("宿主字段");
  expect(() => decodeResearchSynthesis({ ...f.p.synthesis, permissions: "accept" })).toThrow(
    "宿主专有字段",
  );
  const beforeInvalidRequest = JSON.stringify(f.p);
  await expect(
    f.tool("reviewer", "synthesis-counterevidence", {
      id: "wrong-model-shape",
      artifactId: f.before.id,
      evidence: [],
      impact: "do-not-echo-private-value",
    }),
  ).rejects.toThrow(
    /未知或宿主专有字段.*synthesis-counterevidence.*id, source, claimIds, gapIds, reason, materialChange.*sourceId,locatorId,start,end,requiredDepth/,
  );
  expect(JSON.stringify(f.p)).toBe(beforeInvalidRequest);
  const corrupt = structuredClone(f.p);
  corrupt.synthesis!.matrices[0]!.host.owner.model.modelId = "forged-model";
  expect(() => validateResearchSynthesisProject(corrupt)).toThrow("native/模型/输入");
  f.p.revision = 2;
  f.p.status = "paused";
  expect(() => validateResearchSynthesisProject(f.p)).not.toThrow();
});

test("a claim-only counterevidence declaration pins exactly that current claim", async () => {
  const f = await fixture();
  await f.prepare();
  f.sourceRead("reviewer", "S2");
  f.readDraft("reviewer");
  await f.tool("reviewer", "synthesis-counterevidence", {
    ...f.challengeRequest(),
    claimIds: ["claim-before"],
    gapIds: [],
  });
  expect(f.p.synthesis!.counterevidence[0]).toMatchObject({
    claimIds: ["claim-before"],
    targetClaimPins: [{ id: "claim-before", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    targetGapPins: [],
  });
  expect(f.p.claims!.claims[0]!.id).toBe("claim-before");
  expect(f.p.synthesis!.gaps[0]!.state).toBe("pending-validation");
});

test("B must actually read the new draft and give a concrete reason; A cannot pose as B", async () => {
  const f = await fixture();
  await f.prepare();
  await f.challenge();
  await f.respond();
  f.resumeCurrentRole("reviewer");
  const request = {
    id: "review-missing-draft",
    responseId: "response-1",
    start: 0,
    end: afterBody.length,
    conclusion: "addressed",
    reason: "Concrete fixture reason",
  };
  await expect(f.tool("reviewer", "synthesis-review", request)).rejects.toThrow(
    "本 native 用 read",
  );
  await expect(f.tool("lead", "synthesis-review", request)).rejects.toThrow("真实 B");
  f.readDraft("reviewer", "draft-after");
  const { reason: ignored, ...withoutReason } = request;
  void ignored;
  await expect(f.tool("reviewer", "synthesis-review", withoutReason)).rejects.toThrow("非空文本");
  expect(f.p.synthesis!.reviews).toEqual([]);
});

test("a task version changing during verification rejects before adopting a new matrix", async () => {
  const f = await fixture();
  f.sourceRead("lead");
  f.readDraft("lead");
  const before = structuredClone(f.p.synthesis);
  const pending = f.tool("lead", "synthesis-matrix", f.matrixRequest());
  f.p.fusion!.tasks.find((row) => row.role === "lead")!.inputVersion++;
  await expect(pending).rejects.toThrow("当前输入版本");
  expect(f.p.synthesis).toEqual(before);
});

test("a recorded source change may reopen an accepted target, but B must read that baseline in its current native", async () => {
  const f = await fixture();
  await f.prepare();
  const input = f.p.fusion!.inputs.find((row) => row.inputId === "source:S1")!;
  f.p.fusion = setResearchInput(f.p.fusion!, { ...input, version: 2 });
  f.p.fusion = applyResearchChange(f.p.fusion, {
    id: "fixture-source-change",
    at: f.now(),
    inputId: "source:S1",
    fromVersion: 1,
    toVersion: 2,
    reason:
      "Source revision reopens prior acceptance; same bytes retained in this software fixture",
    authorizedBy: "user",
    authorizationRef: "fixture-user-action",
  });
  const old = activeFusionAttempt(f.p, "reviewer")!;
  f.p.fusion = finishResearchTaskAttempt(f.p.fusion, old.id, { at: f.now() });
  f.start("reviewer");
  f.sourceRead("reviewer", "S2");
  await expect(
    f.tool("reviewer", "synthesis-counterevidence", f.challengeRequest()),
  ).rejects.toThrow("实际 read 已重开");
  // The real host calls this immediately before returning the already pinned historical body.
  recordResearchSynthesisTargetRead(
    f.p,
    "reviewer",
    "fixture-historical-read",
    f.before.id,
    f.now(),
  );
  await f.tool("reviewer", "synthesis-counterevidence", f.challengeRequest());
  expect(f.p.synthesis!.counterevidence[0]!.target).toMatchObject({
    artifactId: f.before.id,
    taskVersion: 1,
  });
  expect(f.p.fusion!.tasks.find((row) => row.role === "lead")!.inputVersion).toBe(3);
  expect(f.p.events.find((event) => event.id.startsWith("synthesis-target-read:"))).toMatchObject({
    role: "reviewer",
    runId: activeFusionAttempt(f.p, "reviewer")!.nativeRunId,
  });
  await expect(assertResearchSynthesisAcceptance(f.p, f.before.id)).rejects.toThrow("重审未关闭");
});

test("a reopened unaccepted or superseded manuscript cannot masquerade as the accepted counterevidence baseline", async () => {
  const f = await fixture();
  await f.prepare();
  const input = f.p.fusion!.inputs.find((row) => row.inputId === "source:S1")!;
  f.p.fusion = setResearchInput(f.p.fusion!, { ...input, version: 2 });
  f.p.fusion = applyResearchChange(f.p.fusion, {
    id: "fixture-reopen",
    at: f.now(),
    inputId: "source:S1",
    fromVersion: 1,
    toVersion: 2,
    reason: "Fixture source revision",
    authorizedBy: "user",
    authorizationRef: "fixture-user-action",
  });
  const old = activeFusionAttempt(f.p, "reviewer")!;
  f.p.fusion = finishResearchTaskAttempt(f.p.fusion, old.id, { at: f.now() });
  f.start("reviewer");
  f.sourceRead("reviewer", "S2");
  const artifact = f.p.fusion!.artifacts.find((row) => row.id === f.before.id)!;
  const reviews = artifact.reviews;
  artifact.reviews = [];
  recordResearchSynthesisTargetRead(f.p, "reviewer", "unaccepted-read", f.before.id, f.now());
  await expect(
    f.tool("reviewer", "synthesis-counterevidence", f.challengeRequest()),
  ).rejects.toThrow("已接受基线");
  artifact.reviews = reviews;
  artifact.reviewState = "superseded";
  recordResearchSynthesisTargetRead(f.p, "reviewer", "superseded-read", f.before.id, f.now());
  await expect(
    f.tool("reviewer", "synthesis-counterevidence", f.challengeRequest()),
  ).rejects.toThrow("旧稿不能借机采用");
  expect(f.p.synthesis!.counterevidence).toEqual([]);
  expect(f.p.events.filter((event) => event.id.startsWith("synthesis-target-read:"))).toEqual([]);
});
