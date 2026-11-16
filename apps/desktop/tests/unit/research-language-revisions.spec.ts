import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeResearchLanguageRevisions,
  decodeResearchLanguageSemanticReviewRequest,
  type ResearchLanguageActor,
  type ResearchLanguageRevision,
} from "../../contracts/research-language-revisions";
import {
  createResearchLanguageArtifact,
  createResearchLanguageRevision,
  recordResearchLanguageSemanticReview,
  recordResearchLanguageSkip,
  reportResearchLanguageRevision,
} from "../../electron/research-group/language-revisions";

const BASE =
  "# 方法\n\n🙂 使用变量 G3；样本 n=120，时长8周，系数 β=0.20，p>0.05。[12]\n\n# 讨论\n\n在本研究样本中，我们观察到学习支持与成绩可能有关，但未发现显著差异；不能据此推断因果。\n\n# AI使用说明\n\n本文使用AI辅助语言编辑，作者核对内容。\n";
const at = "2026-11-08T10:00:00.000Z";
const actor = (role: "lead" | "reviewer"): ResearchLanguageActor => ({
  kind: "model",
  id: `model:${role}`,
  role,
  sessionId: `synthetic-session-${role}`,
  attemptId: `synthetic-attempt-${role}`,
  nativeRunId: `synthetic-native-${role}`,
  model: { provider: "unit-fixture", modelId: "synthetic-model" },
});
async function fixture(after = BASE.replace("我们观察到", "可见"), all = false) {
  const directory = await mkdtemp(join(tmpdir(), "language-revision-unit-"));
  const beforeFile = join(directory, "baseline.md"),
    afterFile = join(directory, "revision.md");
  await writeFile(beforeFile, BASE, { flag: "wx" });
  await writeFile(afterFile, after, { flag: "wx" });
  const baseline = createResearchLanguageArtifact("baseline", await readFile(beforeFile, "utf8"));
  const target = createResearchLanguageArtifact("target", await readFile(afterFile, "utf8"));
  const start = all ? 0 : BASE.indexOf("在本研究样本中"),
    end = all ? BASE.length : BASE.indexOf("\n\n# AI");
  const revision = createResearchLanguageRevision(
    {
      id: "language-revision",
      baseline,
      target,
      ranges: [
        { id: "discussion", label: "选定讨论段落", start, end, exactText: BASE.slice(start, end) },
      ],
    },
    {
      at,
      authorization: {
        id: "synthetic-user-selection",
        at,
        kind: "explicit-user-selection",
        sourceRef: "unit-fixture:user-selection:discussion",
      },
      frozenAnchors: [
        {
          id: "variable-G3",
          kind: "variable",
          start: BASE.indexOf("G3"),
          end: BASE.indexOf("G3") + 2,
          exactText: "G3",
        },
        {
          id: "required-disclosure",
          kind: "ai-disclosure",
          start: BASE.indexOf("本文使用AI"),
          end: BASE.indexOf("本文使用AI") + "本文使用AI辅助语言编辑，作者核对内容。".length,
          exactText: "本文使用AI辅助语言编辑，作者核对内容。",
        },
      ],
    },
  );
  return { revision, baseline, target, beforeFile, afterFile };
}
function review(
  revision: ResearchLanguageRevision,
  role: "lead" | "reviewer",
  classification:
    "meaning-preserved" | "substantive-change" | "insufficient-material" = "meaning-preserved",
) {
  const identity = actor(role);
  const actualReads = [revision.baseline, revision.target].map((artifact) => ({
    id: `synthetic-read-${role}-${artifact.id}`,
    artifactId: artifact.id,
    bodySha256: artifact.bodySha256,
    start: 0,
    end: artifact.body.length,
    exactText: artifact.body,
    at,
    actor: identity,
  }));
  return recordResearchLanguageSemanticReview(
    revision,
    {
      revisionId: revision.id,
      classification,
      reason:
        classification === "meaning-preserved"
          ? "逐段对照双稿：仅删减叙述性主语，样本、关联、不确定性和限制保持；此为具名模型判断。"
          : "逐段对照发现命题范围或强度变化，需要内容与主张重新审查。",
      coverage: revision.programReport.units.map((unit) => ({
        unitId: unit.id,
        baseline: unit.baseline,
        target: unit.target,
      })),
    },
    {
      id: `review-${role}-${classification}`,
      at,
      actor: identity,
      evidenceRef: `unit-fixture:actual-review:${role}`,
      readIds: actualReads.map((read) => read.id),
    },
    { artifacts: [revision.baseline, revision.target], reads: actualReads },
  );
}
test("selected language editing requires actual dual-draft A and B coverage and preserves the original files", async () => {
  const f = await fixture();
  expect(reportResearchLanguageRevision(f.revision, [f.baseline, f.target]).status).toBe(
    "needs-review",
  );
  const a = review(f.revision, "lead");
  expect(reportResearchLanguageRevision(a, [f.baseline, f.target]).status).toBe("needs-review");
  const both = review(a, "reviewer");
  expect(reportResearchLanguageRevision(both, [f.baseline, f.target])).toMatchObject({
    status: "reviewed-meaning-preserved",
    automaticSemanticProof: false,
    requiresContentReview: false,
  });
  expect(await readFile(f.beforeFile, "utf8")).toBe(BASE);
  expect(await readFile(f.afterFile, "utf8")).toBe(f.target.body);
  expect(f.revision.semanticReviews).toEqual([]);
});

test("a reported sample-word synonym can be resolved by attributed reviews, while unseen changes still need paragraph review", async () => {
  const f = await fixture(BASE.replace("在本研究样本中", "在本样本中"));
  expect(
    f.revision.programReport.semanticCandidates.some((risk) => risk.category === "sample-scope"),
  ).toBe(true);
  const reviewed = review(review(f.revision, "lead"), "reviewer");
  expect(reportResearchLanguageRevision(reviewed, [f.baseline, f.target]).status).toBe(
    "reviewed-meaning-preserved",
  );
  const unseen = await fixture(BASE.replace("学习支持", "家庭收入"));
  expect(unseen.revision.programReport.semanticCandidates).toEqual([]);
  expect(
    reportResearchLanguageRevision(unseen.revision, [unseen.baseline, unseen.target]).status,
  ).toBe("needs-review");
  expect(
    reportResearchLanguageRevision(review(unseen.revision, "reviewer", "substantive-change"), [
      unseen.baseline,
      unseen.target,
    ]).status,
  ).toBe("content-review-required");
});

test("out-of-scope edits and protected variable, unit, symbol, citation and disclosure changes cannot be waived", async () => {
  const outside = await fixture(BASE.replace("我们观察到", "可见").replace("# 方法", "# 改写方法"));
  expect(
    outside.revision.programReport.hardIssues.some((issue) => issue.category === "unselected-body"),
  ).toBe(true);
  const f = await fixture(
    BASE.replace("G3", "G2")
      .replace("8周", "8天")
      .replace("p>0.05", "p<0.05")
      .replace("[12]", "[13]")
      .replace("本文使用AI辅助语言编辑，作者核对内容。", "作者独立完成全部写作。"),
    true,
  );
  for (const category of ["frozen-variable", "unit", "symbol", "citation", "frozen-ai-disclosure"])
    expect(f.revision.programReport.hardIssues.some((issue) => issue.category === category)).toBe(
      true,
    );
  expect(
    reportResearchLanguageRevision(review(review(f.revision, "lead"), "reviewer"), [
      f.baseline,
      f.target,
    ]).status,
  ).toBe("blocked");
});

test("UTF16 positions survive emoji and length changes, while changed paragraphs outside read coverage stay unreviewed", async () => {
  const f = await fixture(
    BASE.replace("🙂 使用变量", "🙂 本次使用变量").replace("我们观察到", "可见"),
    true,
  );
  expect(f.revision.programReport.hardIssues).toEqual([]);
  expect(f.revision.programReport.units).toHaveLength(2);
  for (const change of f.revision.programReport.changes) {
    expect(f.baseline.body.slice(change.baseline.start, change.baseline.end)).toBe(
      change.baseline.exactText,
    );
    expect(f.target.body.slice(change.target.start, change.target.end)).toBe(
      change.target.exactText,
    );
  }
  const beforeRead = f.revision.programReport.units[0]!;
  const identity = actor("reviewer"),
    reads = [f.baseline, f.target].map((artifact, index) => ({
      id: `partial-${index}`,
      artifactId: artifact.id,
      bodySha256: artifact.bodySha256,
      ...(index ? beforeRead.target : beforeRead.baseline),
      at,
      actor: identity,
    }));
  const request = {
    revisionId: f.revision.id,
    classification: "meaning-preserved" as const,
    reason: "只核对第一个实际读取段落。",
    coverage: [{ unitId: beforeRead.id, baseline: beforeRead.baseline, target: beforeRead.target }],
  };
  const host = {
    id: "partial-B",
    at,
    actor: identity,
    evidenceRef: "unit-fixture:partial-read",
    readIds: reads.map((read) => read.id),
  };
  const partial = recordResearchLanguageSemanticReview(f.revision, request, host, {
    artifacts: [f.baseline, f.target],
    reads,
  });
  expect(reportResearchLanguageRevision(partial, [f.baseline, f.target]).status).toBe(
    "needs-review",
  );
  expect(() =>
    recordResearchLanguageSemanticReview(
      f.revision,
      {
        ...request,
        coverage: f.revision.programReport.units.map((unit) => ({
          unitId: unit.id,
          baseline: unit.baseline,
          target: unit.target,
        })),
      },
      host,
      { artifacts: [f.baseline, f.target], reads },
    ),
  ).toThrow(/读取覆盖/);
  const forged = structuredClone(partial);
  forged.semanticReviews[0]!.actualReads[0]!.end = forged.semanticReviews[0]!.actualReads[0]!.start;
  forged.semanticReviews[0]!.actualReads[0]!.exactText = "";
  expect(() => decodeResearchLanguageRevisions([forged])).toThrow(/覆盖/);
});

test("a later target version never inherits reviews and malformed or borrowed identities cannot create a review", async () => {
  const f = await fixture(),
    passed = review(review(f.revision, "lead"), "reviewer");
  expect(decodeResearchLanguageRevisions(JSON.parse(JSON.stringify([passed])))).toEqual([passed]);
  const changed = createResearchLanguageArtifact(
    f.target.id,
    f.target.body.replace("可能有关", "有关"),
  );
  expect(reportResearchLanguageRevision(passed, [f.baseline, changed]).status).toBe("stale");
  const fresh = createResearchLanguageRevision(
    {
      id: "next-revision",
      baseline: f.baseline,
      target: { ...changed, id: "next-target" },
      ranges: passed.ranges,
    },
    { at, authorization: passed.authorization, frozenAnchors: passed.frozenAnchors },
  );
  expect(fresh.semanticReviews).toEqual([]);
  expect(reportResearchLanguageRevision(fresh, [fresh.baseline, fresh.target]).status).toBe(
    "needs-review",
  );
  const reviewRecord = passed.semanticReviews[0]!;
  const request = {
    revisionId: passed.id,
    classification: reviewRecord.classification,
    reason: reviewRecord.reason,
    coverage: reviewRecord.coverage,
  };
  expect(() =>
    decodeResearchLanguageSemanticReviewRequest({
      ...request,
      actor: { kind: "user", id: "fabricated-human" },
    }),
  ).toThrow(/未知字段|宿主/);
  expect(() => decodeResearchLanguageSemanticReviewRequest({ ...request, reason: " " })).toThrow();
  expect(() =>
    recordResearchLanguageSemanticReview(
      f.revision,
      request,
      {
        id: "borrowed",
        at,
        actor: actor("reviewer"),
        evidenceRef: "unit-fixture:wrong-actor",
        readIds: reviewRecord.readIds,
      },
      { artifacts: [f.baseline, f.target], reads: reviewRecord.actualReads },
    ),
  ).toThrow(/他人/);
  const corrupt = structuredClone(passed);
  corrupt.semanticReviews[0]!.programReportSha256 = "0".repeat(64);
  expect(() => decodeResearchLanguageRevisions([corrupt])).toThrow(/版本/);
  expect(() => decodeResearchLanguageRevisions([{ ...passed, base64: "forged" }])).toThrow();
});

test("a real skip is distinct from a pass and never conceals deterministic blockers", async () => {
  const f = await fixture(),
    host = {
      id: "actual-user-skip",
      at,
      actor: { kind: "user" as const, id: "synthetic-user" },
      evidenceRef: "unit-fixture:user-action:skip",
    };
  const skipped = recordResearchLanguageSkip(
    f.revision,
    { classification: "user-skipped", reason: "软件单元情境中的实际操作者明确跳过语言流程。" },
    host,
  );
  expect(reportResearchLanguageRevision(skipped, [f.baseline, f.target]).status).toBe("skipped");
  expect(() =>
    recordResearchLanguageSkip(
      f.revision,
      { classification: "user-skipped", reason: "模型不能代用户跳过。" },
      { ...host, actor: actor("lead") },
    ),
  ).toThrow();
  const bad = await fixture(BASE.replace("β=0.20", "β=0.25"), true);
  expect(
    reportResearchLanguageRevision(
      recordResearchLanguageSkip(
        bad.revision,
        { classification: "user-skipped", reason: "跳过不免除数值问题。" },
        host,
      ),
      [bad.baseline, bad.target],
    ).status,
  ).toBe("blocked");
});

for (const example of [
  { name: "negation", before: "未发现显著差异", after: "发现显著差异", category: "negation" },
  {
    name: "association into causality",
    before: "可能有关",
    after: "导致成绩提高",
    category: "causality",
  },
  {
    name: "sample expansion",
    before: "在本研究样本中",
    after: "在所有学生中",
    category: "sample-scope",
  },
  {
    name: "stronger conclusion",
    before: "可能有关",
    after: "已被充分证实",
    category: "claim-strength",
  },
] as const)
  test(`changed ${example.name} is located as a candidate and substantive review returns it to content work`, async () => {
    const f = await fixture(BASE.replace(example.before, example.after));
    const candidate = f.revision.programReport.semanticCandidates.find(
      (risk) => risk.category === example.category,
    );
    expect(candidate).toBeTruthy();
    expect(f.baseline.body.slice(candidate!.baseline.start, candidate!.baseline.end)).toBe(
      candidate!.baseline.exactText,
    );
    expect(f.target.body.slice(candidate!.target.start, candidate!.target.end)).toBe(
      candidate!.target.exactText,
    );
    expect(reportResearchLanguageRevision(f.revision, [f.baseline, f.target]).status).toBe(
      "needs-review",
    );
    const returned = review(f.revision, "reviewer", "substantive-change");
    expect(reportResearchLanguageRevision(returned, [f.baseline, f.target])).toMatchObject({
      status: "content-review-required",
      requiresContentReview: true,
      downstream: { contentReviewRequired: true, rerunAnalysis: false },
    });
  });
test("changed numerical result remains a hard blocker even when both models claim meaning was preserved", async () => {
  const f = await fixture(BASE.replace("β=0.20", "β=0.25"), true);
  expect(
    f.revision.programReport.hardIssues.some(
      (issue) =>
        issue.category === "number" &&
        issue.baseline.exactText === "0.20" &&
        issue.target.exactText === "0.25",
    ),
  ).toBe(true);
  const reviewed = review(review(f.revision, "lead"), "reviewer");
  expect(reportResearchLanguageRevision(reviewed, [f.baseline, f.target]).status).toBe("blocked");
});

test("negating novelty and removing the population exclusion remain visible in actual-draft comparisons", () => {
  for (const [before, after, category] of [
    ["本研究是探索性再分析，不是首次发现。", "本研究是探索性再分析，是首次发现。", "negation"],
    ["对象仅为葡萄牙两校历史记录，不代表全国学生。", "对象为全国学生。", "sample-scope"],
  ]) {
    const baseline = createResearchLanguageArtifact("baseline", before!),
      target = createResearchLanguageArtifact("target", after!);
    const revision = createResearchLanguageRevision(
      {
        id: "review-candidate",
        baseline,
        target,
        ranges: [
          {
            id: "selected",
            label: "已选实际对照段",
            start: 0,
            end: before!.length,
            exactText: before!,
          },
        ],
      },
      {
        at,
        authorization: {
          id: "unit-authorization",
          at,
          kind: "explicit-user-selection",
          sourceRef: "unit:actual-draft-phrase",
        },
      },
    );
    expect(
      revision.programReport.semanticCandidates.some(
        (candidate) => candidate.category === category,
      ),
    ).toBe(true);
    expect(reportResearchLanguageRevision(revision, [baseline, target]).status).toBe(
      "needs-review",
    );
  }
});

test("saved version-one reports remain verifiable after the newer lexical hints are introduced", async () => {
  // This record was produced by the old committed implementation, not today's derive function.
  const old = decodeResearchLanguageRevisions([
    JSON.parse(
      await readFile(join(__dirname, "../fixtures/research-language-v1-record.json"), "utf8"),
    ),
  ])[0]!;
  expect(old.programReport.programVersion).toBe("language-revisions-1");
  expect(reportResearchLanguageRevision(old, [old.baseline, old.target]).status).toBe(
    "needs-review",
  );
  expect(old.programReport.semanticCandidates).toEqual([]);
  const next = createResearchLanguageRevision(
    { id: "new-check", baseline: old.baseline, target: old.target, ranges: old.ranges },
    { at, authorization: old.authorization },
  );
  expect(next.programReport.programVersion).toBe("language-revisions-2");
  expect(next.programReport.semanticCandidates.some((row) => row.category === "negation")).toBe(
    true,
  );
});
