import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  decodeResearchClaimRequest,
  decodeResearchClaimReviewRequest,
  decodeResearchClaims,
  type ResearchClaimRequest,
  type ResearchClaimReviewHost,
  type ResearchClaimSourceSnapshot,
  type ResearchClaims,
} from "../../contracts/research-claims";
import {
  createResearchAnalysisRegistry,
  executeRegisteredResearchAnalysis,
  registerResearchAnalysisPlan,
} from "../../electron/research-group/analysis-registry";
import {
  createResearchClaimArtifactSnapshot,
  createResearchClaims,
  projectResearchClaimSourceImpact,
  recordResearchClaimReview,
  registerResearchClaim,
  validateResearchClaims,
  type ResearchClaimContext,
} from "../../electron/research-group/claims";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const at = "2026-11-07T12:00:00.000Z";
const later = "2026-11-07T12:01:00.000Z";
const host = (
  id = "review-1",
  role: "reviewer" | "mentor" = "reviewer",
): ResearchClaimReviewHost => ({
  id,
  at: later,
  actor: {
    kind: "model",
    role,
    sessionId: role,
    runId: `${role}-run`,
    toolCallId: id,
    provider: "fixture",
    modelId: "synthetic-reviewer",
  },
});
function fixture() {
  const artifact = createResearchClaimArtifactSnapshot(
    "draft-1",
    "样本来自两所学校。不得推论全国总体。",
  );
  const source: ResearchClaimSourceSnapshot = {
    ...createResearchClaimArtifactSnapshot(
      "source-1",
      "Sample: two schools.\nThis is an observational study.",
    ),
    sha256: sha("immutable original source bytes"),
    available: true,
    locators: [
      { id: "methods", label: "原文第1–2行（合成夹具）", start: 0, end: 50, depth: "full-text" },
    ],
  };
  source.locators[0]!.end = source.body.length;
  const context: ResearchClaimContext = {
    artifacts: [artifact],
    sources: [source],
    registry: createResearchAnalysisRegistry(),
    currentDatasets: [],
    structuredActualReads: ["reviewer", "mentor"].map((sessionId) => ({
      id: `read-${sessionId}`,
      sourceId: source.id,
      sourceSha256: source.sha256,
      bodySha256: source.bodySha256,
      locatorId: "methods",
      start: 0,
      end: source.body.length,
      depth: "full-text",
      sessionId,
      at,
      evidenceRef: `host-tool-result:${sessionId}`,
    })),
  };
  const request: ResearchClaimRequest = {
    id: "claim-1",
    artifactId: artifact.id,
    start: 0,
    end: "样本来自两所学校。".length,
    category: "source-fact",
    evidence: [
      {
        kind: "source",
        sourceId: source.id,
        locatorId: "methods",
        start: 0,
        end: "Sample: two schools.".length,
        requiredDepth: "full-text",
        relation: "support",
      },
    ],
  };
  const ledger = registerResearchClaim(createResearchClaims(), context, request);
  return { context, request, ledger, artifact, source };
}
function review(
  ledger: ResearchClaims,
  context: ResearchClaimContext,
  conclusion:
    "supported" | "partially-supported" | "unsupported" | "insufficient-material" = "supported",
  identity = host(),
) {
  return recordResearchClaimReview(
    ledger,
    context,
    {
      claimId: "claim-1",
      conclusion,
      reason: "合成夹具中原文明确限定两所学校；此记录是模型语义判断。",
      resolvesReviewIds: [],
    },
    identity,
  );
}
const codes = (context: ResearchClaimContext, ledger: ResearchClaims, id = "draft-1") =>
  validateResearchClaims(context, ledger, id).blockers.map((issue) => issue.code);

test("one reader's contiguous pages cover a long citation without borrowing another reader or hiding a gap", () => {
  const f = fixture(),
    first = f.context.structuredActualReads[0]!;
  f.request.evidence[0] = {
    ...f.request.evidence[0]!,
    kind: "source",
    sourceId: f.source.id,
    locatorId: "methods",
    start: 0,
    end: f.source.body.length,
    requiredDepth: "full-text",
    relation: "support",
  };
  f.context.structuredActualReads = [
    { ...first, id: "first-page", start: 0, end: 20 },
    { ...first, id: "second-page", start: 20, end: f.source.body.length },
  ];
  const ledger = registerResearchClaim(createResearchClaims(), f.context, f.request);
  const reviewed = review(ledger, f.context);
  expect(codes(f.context, reviewed)).toEqual([]);
  expect(reviewed.reviews[0]!.actualReads.map((read) => read.id)).toEqual([
    "first-page",
    "second-page",
  ]);
  const missingReceipt = structuredClone(reviewed);
  missingReceipt.reviews[0]!.actualReads.pop();
  expect(codes(f.context, missingReceipt)).toContain("review-read-missing");
  const gap = structuredClone(f.context);
  gap.structuredActualReads[1]!.start++;
  expect(codes(gap, reviewed)).toContain("actual-read-missing");
  expect(codes(gap, reviewed)).toContain("review-read-missing");
  const borrowed = structuredClone(f.context);
  borrowed.structuredActualReads[1]!.sessionId = "mentor";
  expect(codes(borrowed, reviewed)).toContain("actual-read-missing");
});

test("unreviewed and negative claims remain located; a supported B review retains real host identity", () => {
  const f = fixture();
  expect(codes(f.context, f.ledger)).toContain("review-missing");
  const accepted = review(f.ledger, f.context);
  const report = validateResearchClaims(f.context, accepted, f.artifact.id);
  expect(report.blocksFormalAcceptance).toBe(false);
  expect(report.requiresContentReview).toBe(true);
  expect(report.boundary).toContain("不是程序证明或人类专家确认");
  expect(accepted.reviews[0]).toMatchObject({
    judgment: "model-semantic-review",
    actor: host().actor,
    actualReads: [f.context.structuredActualReads[0]],
  });
  expect(f.ledger.reviews).toEqual([]);
  expect(review(accepted, f.context)).toEqual(accepted);
  for (const verdict of ["partially-supported", "unsupported", "insufficient-material"] as const) {
    const blocked = review(f.ledger, f.context, verdict);
    const issue = validateResearchClaims(f.context, blocked, f.artifact.id).blockers.find(
      (item) => item.code === `review-${verdict}`,
    )!;
    expect(issue).toMatchObject({
      claimId: "claim-1",
      artifactId: f.artifact.id,
      start: 0,
      exactText: "样本来自两所学校。",
    });
  }
});

test("model arguments cannot forge reading, hashes, host identities or human expertise", () => {
  const f = fixture();
  for (const addition of [
    { alreadyRead: true },
    { bodySha256: f.artifact.bodySha256 },
    { actor: "human" },
  ])
    expect(() => decodeResearchClaimRequest({ ...f.request, ...addition })).toThrow("越权字段");
  for (const addition of [
    { actualReads: f.context.structuredActualReads },
    { actor: host().actor },
    { humanConfirmed: true },
  ])
    expect(() =>
      decodeResearchClaimReviewRequest({
        claimId: "claim-1",
        conclusion: "supported",
        reason: "理由",
        resolvesReviewIds: [],
        ...addition,
      }),
    ).toThrow("越权字段");
  expect(() =>
    recordResearchClaimReview(
      f.ledger,
      f.context,
      { claimId: "claim-1", conclusion: "supported", reason: "理由", resolvesReviewIds: [] },
      {
        ...host(),
        actor: { ...host().actor, kind: "human" },
      } as unknown as ResearchClaimReviewHost,
    ),
  ).toThrow("不是人类专家");
  expect(() =>
    decodeResearchClaimRequest({
      ...f.request,
      evidence: [{ kind: "result", runId: "run", path: ["__proto__", "x"] }],
    }),
  ).toThrow("安全");
});

test("read coverage, reader identity and actual time are checked independently of semantic support", () => {
  const f = fixture();
  const missing = { ...f.context, structuredActualReads: [] };
  expect(codes(missing, review(f.ledger, missing))).toEqual(
    expect.arrayContaining(["actual-read-missing", "review-read-missing"]),
  );
  const partial = structuredClone(f.context);
  partial.structuredActualReads.forEach((read) => {
    read.end = 5;
  });
  expect(codes(partial, review(f.ledger, partial))).toContain("actual-read-missing");
  const otherReader = {
    ...f.context,
    structuredActualReads: f.context.structuredActualReads.filter(
      (read) => read.sessionId === "mentor",
    ),
  };
  expect(codes(otherReader, review(f.ledger, otherReader))).toContain("review-read-missing");
  const future = structuredClone(f.context);
  future.structuredActualReads.forEach((read) => {
    read.at = "2026-11-07T13:00:00.000Z";
  });
  expect(codes(future, review(f.ledger, future))).toContain("review-read-missing");
});

test("abstracts remain abstracts even when a forged receipt says full text", () => {
  const f = fixture();
  f.context.sources[0]!.locators[0]!.depth = "abstract";
  expect(codes(f.context, review(f.ledger, f.context))).toEqual(
    expect.arrayContaining(["reading-depth-insufficient", "actual-read-missing"]),
  );
  f.context.structuredActualReads.forEach((read) => {
    read.depth = "abstract";
  });
  const request = structuredClone(f.request);
  if (request.evidence[0]!.kind === "source") request.evidence[0]!.requiredDepth = "abstract";
  const abstractClaim = registerResearchClaim(createResearchClaims(), f.context, request);
  expect(
    validateResearchClaims(f.context, review(abstractClaim, f.context), "draft-1")
      .blocksFormalAcceptance,
  ).toBe(false);
  expect(review(abstractClaim, f.context).reviews[0]!.actualReads[0]!.depth).toBe("abstract");
});

test("partial text covers a located excerpt but cannot satisfy a full-text requirement", () => {
  const f = fixture();
  f.context.sources[0]!.locators[0]!.depth = "partial-text";
  for (const read of f.context.structuredActualReads) read.depth = "partial-text";
  const request = structuredClone(f.request);
  if (request.evidence[0]!.kind === "source") request.evidence[0]!.requiredDepth = "partial-text";
  const partial = registerResearchClaim(createResearchClaims(), f.context, request);
  expect(
    validateResearchClaims(f.context, review(partial, f.context), "draft-1").blocksFormalAcceptance,
  ).toBe(false);
  expect(codes(f.context, f.ledger)).toContain("reading-depth-insufficient");
  f.context.structuredActualReads[0]!.end = 5;
  expect(codes(f.context, review(partial, f.context))).toContain("review-read-missing");
});

test("invalid locations and unavailable source versions are pending even with model support", () => {
  const f = fixture(),
    accepted = review(f.ledger, f.context);
  for (const change of ["locator", "withdraw", "original", "extraction", "read-receipt"] as const) {
    const context = structuredClone(f.context);
    if (change === "locator") context.sources[0]!.locators = [];
    if (change === "withdraw") context.sources[0]!.available = false;
    if (change === "original") context.sources[0]!.sha256 = sha("replacement original");
    if (change === "extraction") context.sources[0]!.body = "Changed extraction.";
    if (change === "read-receipt")
      context.structuredActualReads[0]!.evidenceRef = "changed receipt";
    expect(validateResearchClaims(context, accepted, "draft-1").blocksFormalAcceptance).toBe(true);
  }
  const bad = structuredClone(f.request);
  if (bad.evidence[0]!.kind === "source") bad.evidence[0]!.locatorId = "invented-page-999";
  expect(codes(f.context, registerResearchClaim(createResearchClaims(), f.context, bad))).toContain(
    "source-location-stale",
  );
});

test("immutable draft and dependency identities cannot inherit an old support judgment", () => {
  const f = fixture(),
    accepted = review(f.ledger, f.context);
  const next = createResearchClaimArtifactSnapshot("draft-2", "样本代表全国学校。");
  const context = { ...f.context, artifacts: [f.artifact, next] };
  expect(codes(context, accepted, next.id)).toEqual(["claims-missing"]);
  const request = { ...f.request, id: "claim-2", artifactId: next.id, end: next.body.length };
  const newClaim = registerResearchClaim(accepted, context, request);
  expect(codes(context, newClaim, next.id)).toContain("review-missing");
  expect(newClaim.claims[0]).toEqual(accepted.claims[0]);
  expect(newClaim.reviews).toEqual(accepted.reviews);
  expect(() => registerResearchClaim(accepted, context, { ...request, id: "claim-1" })).toThrow(
    "不可改写",
  );
  const altered = {
    ...f.context,
    artifacts: [createResearchClaimArtifactSnapshot("draft-1", "样本代表全国学校。")],
  };
  expect(codes(altered, accepted)).toEqual(
    expect.arrayContaining(["artifact-stale", "claim-location-stale"]),
  );
  const corrupted = structuredClone(accepted);
  corrupted.claims[0]!.category = "inference";
  expect(codes(f.context, corrupted)).toContain("review-stale");
});

test("mentor disagreement is attributable and cannot erase B's open negative finding or unread material", () => {
  const f = fixture();
  const negative = review(f.ledger, f.context, "unsupported");
  const resolved = recordResearchClaimReview(
    negative,
    f.context,
    {
      claimId: "claim-1",
      conclusion: "supported",
      reason: "导师提出另一种解释；需 B 对原句重新核查。",
      resolvesReviewIds: ["review-1"],
    },
    host("mentor-resolution", "mentor"),
  );
  expect(resolved.reviews).toHaveLength(2);
  expect(resolved.reviews[0]!.conclusion).toBe("unsupported");
  expect(codes(f.context, resolved)).toContain("review-unsupported");
  const freshB = review(resolved, f.context, "supported", host("b-recheck"));
  expect(codes(f.context, freshB)).toEqual([]);
  const unread = { ...f.context, structuredActualReads: [] };
  expect(codes(unread, freshB)).toContain("actual-read-missing");
  expect(() =>
    recordResearchClaimReview(
      f.ledger,
      f.context,
      {
        claimId: "claim-1",
        conclusion: "supported",
        reason: "不存在的分歧",
        resolvesReviewIds: ["absent"],
      },
      host("invalid", "mentor"),
    ),
  ).toThrow("在先同主张");
  expect(() =>
    decodeResearchClaims({
      ...resolved,
      reviews: [{ ...resolved.reviews[0], actor: { ...host().actor, kind: "external-expert" } }],
    }),
  ).toThrow("不是人类专家");
});

test("source replacement and explicit contrary-evidence mapping affect only named dependencies", () => {
  const f = fixture(),
    accepted = review(f.ledger, f.context);
  const source2 = { ...f.source, id: "independent-source", sha256: sha("other original") };
  const context = { ...f.context, sources: [...f.context.sources, source2] };
  const request = structuredClone(f.request);
  request.id = "independent-claim";
  if (request.evidence[0]!.kind === "source") request.evidence[0]!.sourceId = source2.id;
  const ledger = registerResearchClaim(accepted, context, request),
    before = structuredClone(ledger);
  const impact = projectResearchClaimSourceImpact(ledger, {
    sourceId: f.source.id,
    sourceSha256: f.source.sha256,
    reason: "原支持来源已被真实相反论文替换；需重审具体原句。",
  });
  expect(impact.affected.map((item) => item.claimId)).toEqual(["claim-1"]);
  expect(impact.reviewIdsRequiringRecheck).toEqual(["review-1"]);
  expect(impact.unaffectedClaimIds).toEqual(["independent-claim"]);
  expect(ledger).toEqual(before);
  const explicit = projectResearchClaimSourceImpact(ledger, {
    sourceId: "new-contrary",
    sourceSha256: sha("new evidence"),
    reason: "宿主记录 B 对第二项主张的显式影响判断。",
    additionalClaimIds: ["independent-claim"],
  });
  expect(explicit.affected.map((item) => item.claimId)).toEqual(["independent-claim"]);
  expect(explicit.unaffectedClaimIds).toEqual(["claim-1"]);
});

test("actual result claims pin a calculated run and safe field path; plan, data or result changes block", () => {
  const f = fixture(),
    csv = "x\n1\n2\n3\n",
    dataset = { id: "synthetic", sha256: sha(csv), delimiter: "," as const };
  let registry = registerResearchAnalysisPlan(createResearchAnalysisRegistry(), {
    id: "plan",
    version: 1,
    label: "合成描述统计",
    purpose: "descriptive",
    objective: "明确非真实研究的计算夹具",
    dataset: { id: dataset.id, sha256: dataset.sha256 },
    method: "describe",
    columns: ["x"],
    parameters: {},
    outputs: ["descriptive"],
    reviewPlan: "独立核对",
    registration: { at, timing: "prospective", reason: "事前夹具", sourceRef: "fixture" },
    sample: { mode: "all" },
  });
  registry = executeRegisteredResearchAnalysis(registry, {
    id: "run",
    planId: "plan",
    planVersion: 1,
    at,
    actor: "host:test-calculator",
    dataset,
    csv,
  }).registry;
  const context = { ...f.context, registry, currentDatasets: [dataset] };
  const request: ResearchClaimRequest = {
    ...f.request,
    category: "research-result",
    evidence: [{ kind: "result", runId: "run", path: ["descriptive", "x", "mean"] }],
  };
  const ledger = review(registerResearchClaim(createResearchClaims(), context, request), context);
  expect(codes(context, ledger)).toEqual([]);
  for (const kind of ["result", "plan", "dataset", "field"] as const) {
    const changed = structuredClone(context);
    if (kind === "result") changed.registry.runs[0]!.resultSha256 = sha("tampered");
    if (kind === "plan") changed.registry.plans[0]!.objective = "changed";
    if (kind === "dataset") changed.currentDatasets[0]!.sha256 = sha("changed data");
    if (kind === "field")
      delete (changed.registry.runs[0]!.result.descriptive as Record<string, unknown>).x;
    expect(validateResearchClaims(changed, ledger, "draft-1").blocksFormalAcceptance).toBe(true);
  }
  expect(
    codes(
      f.context,
      registerResearchClaim(createResearchClaims(), f.context, {
        ...f.request,
        category: "research-result",
      }),
    ),
  ).toContain("actual-result-missing");
});

test("the core does not invent semantic detection or accept arbitrary Unicode split positions", () => {
  const f = fixture();
  const wrong = createResearchClaimArtifactSnapshot("wrong-draft", "此样本代表全国学生。");
  const context = { ...f.context, artifacts: [wrong] };
  const ledger = registerResearchClaim(createResearchClaims(), context, {
    ...f.request,
    artifactId: wrong.id,
    end: wrong.body.length,
  });
  expect(codes(context, ledger, wrong.id)).toContain("review-missing");
  const checked = recordResearchClaimReview(
    ledger,
    context,
    {
      claimId: "claim-1",
      conclusion: "unsupported",
      reason: "只调查两所学校，原文不支持全国代表性。",
      resolvesReviewIds: [],
    },
    host(),
  );
  expect(codes(context, checked, wrong.id)).toContain("review-unsupported");
  const unicode = createResearchClaimArtifactSnapshot("unicode", "🧪研究原句");
  expect(() =>
    registerResearchClaim(
      createResearchClaims(),
      { ...context, artifacts: [unicode] },
      { ...f.request, artifactId: unicode.id, start: 1, end: 3 },
    ),
  ).toThrow("位置");
});
