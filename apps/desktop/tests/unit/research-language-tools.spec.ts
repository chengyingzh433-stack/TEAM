import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type {
  ResearchProject,
  ResearchRole,
  ResearchArtifact,
} from "../../contracts/research-group";
import { decodeResearchAction } from "../../contracts/research-group";
import { researchLanguageParagraphs } from "../../contracts/research-language-tools";
import { createResearchLanguageArtifact } from "../../electron/research-group/language-revisions";
import {
  applyResearchLanguageTool,
  grantResearchLanguageScope,
  researchLanguageStatus,
  assertResearchLanguageAcceptance,
  skipResearchLanguageRevision,
  validateResearchLanguageProject,
} from "../../electron/research-group/language-tools";
import {
  activeFusionAttempt,
  prepareFusionDelivery,
  dispatchFusionAttempt,
  bindFusionNativeRun,
  publishFusionArtifact,
  finishFusionNativeRun,
} from "../../electron/research-group/fusion-task-runtime";
import { applyResearchChange, setResearchInput } from "../../electron/research-group/task-graph";
import { isCurrentResearchArtifact } from "../../electron/research-group/paper-pipeline";
import { researchHash } from "../../electron/research-group/materials";

const BASE =
  "# 讨论\n\n本研究样本 n=120。学习支持与成绩可能有关，但未发现显著差异，不能推断因果。\n\n本文使用AI辅助语言编辑，作者核对内容。";
function fixture(after = BASE.replace("可能有关", "可能存在关联")) {
  const at = "2026-11-08T06:00:00.000Z",
    id = randomUUID();
  const p: ResearchProject = {
    id,
    root: { workspaceId: "/synthetic-unit", sessionId: "mentor" },
    workspacePath: "/synthetic-unit",
    objective: "仅修改指定讨论段的软件单元夹具",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "task",
    goal: "task",
    path: "quantitative",
    task: { kind: "chapter-edit", scope: "仅讨论正文" },
    currentStage: "writing",
    scope: "paper",
    knowledge: { directory: "/synthetic-unit", sha256: "fixture", version: "fixture", count: 0 },
    members: ["lead", "reviewer", "mentor"].map((role) => ({
      role: role as ResearchRole,
      ref: { workspaceId: "/synthetic-unit", sessionId: role },
      status: "running",
    })),
    artifacts: [],
    events: [],
    packets: [],
    evidence: {
      directory: "/synthetic-unit",
      datasets: [],
      sources: [
        {
          id: "fixed-manuscript",
          file: "/synthetic-unit/manuscript.md",
          title: "合成语言检查基线",
          authors: "unit fixture",
          year: "2026",
          url: "",
          sha256: researchHash(BASE),
          kind: "manuscript",
          access: "provided-text",
        },
      ],
    },
    // Pure language tests supply the new fixed-scope prerequisite in memory;
    // they still make no filesystem or whole-publication claim.
    m3: {
      scopes: [
        {
          id: "fixed-task-scope",
          revision: 1,
          sourceId: "fixed-manuscript",
          sourceSha256: researchHash(BASE),
          baseline: BASE,
          bodySha256: researchHash(BASE),
          ranges: [{ start: 0, end: BASE.length, label: "讨论正文" }],
          at,
        },
      ],
    },
  };
  for (const role of ["lead", "reviewer", "mentor"] as const) {
    const delivery = prepareFusionDelivery(
      p,
      role,
      `unit-${role}`,
      at,
      "合成宿主生命周期夹具，不是E/R证明",
    );
    expect(delivery.kind).toBe("dispatch");
    dispatchFusionAttempt(p, delivery.attemptId!, at);
    bindFusionNativeRun(p, role, `native-${role}`);
    p.fusion!.attempts.find((a) => a.id === delivery.attemptId)!.model = {
      provider: "unit",
      modelId: "synthetic",
    };
  }
  let serial = 0;
  const publish = (role: ResearchRole, kind: ResearchArtifact["kind"], content: string) => {
    const a: ResearchArtifact = {
      id: randomUUID(),
      revision: 1,
      stage: "writing",
      role,
      kind,
      content,
      refs: [],
      round: 0,
      createdAt: at,
      toolCallId: `publish-${++serial}`,
    };
    p.artifacts.push(a);
    publishFusionArtifact(p, a);
    return a;
  };
  const baseline = publish("lead", "stage-draft", BASE);
  const range = researchLanguageParagraphs(BASE)[1]!;
  const scope = grantResearchLanguageScope(
    p,
    {
      baselineId: baseline.id,
      bodySha256: createResearchLanguageArtifact(baseline.id, BASE).bodySha256,
      rangeIds: [range.id],
      frozenTerms: ["学习支持"],
    },
    at,
  );
  const target = publish("lead", "stage-revision", after);
  const tool = (role: ResearchRole, input: Record<string, unknown>) =>
    applyResearchLanguageTool(p, role, `call-${++serial}`, input, at);
  tool("lead", {
    operation: "language-register",
    scopeId: scope.id,
    baselineId: baseline.id,
    artifactId: target.id,
  });
  const revision = () => p.languageRevisions!.at(-1)!;
  const risk = () => publish("reviewer", "stage-risk", "合成独立风险判断");
  const review = (role: "lead" | "reviewer", classification = "meaning-preserved") =>
    tool(role, {
      operation: "language-review",
      languageReview: {
        revisionId: revision().id,
        classification,
        reason: "本单元合成语义意见，不是对真实论文的模型内容验收。",
        coverage: revision().programReport.units.map(({ id, baseline, target }) => ({
          unitId: id,
          baseline,
          target,
        })),
      },
    });
  const readBoth = (role: "lead" | "reviewer") => {
    for (const side of ["baseline", "target"] as const)
      tool(role, {
        operation: "language-read",
        languageRevisionId: revision().id,
        side,
        start: 0,
        end: revision()[side].body.length,
      });
  };
  const accept = () =>
    assertResearchLanguageAcceptance(p, "mentor", { kind: "stage-review", verdict: "accept" });
  return {
    p,
    at,
    baseline,
    target,
    scope,
    tool,
    risk,
    review,
    readBoth,
    revision,
    accept,
    publish,
  };
}
test("actual selected scope and each member's dual reads are required before language acceptance", () => {
  const f = fixture();
  expect(() => f.tool("reviewer", { operation: "language-context" })).toThrow(/独立判断/);
  f.risk();
  expect(() => f.accept()).toThrow(/needs-review/);
  expect(() => f.review("reviewer")).toThrow(/读取覆盖/);
  f.readBoth("lead");
  f.review("lead");
  expect(() => f.review("reviewer")).toThrow(/读取覆盖/);
  f.readBoth("reviewer");
  f.review("reviewer");
  expect(() => f.accept()).not.toThrow();
  expect(researchLanguageStatus(f.p)[0]!.status).toBe("reviewed-meaning-preserved");
  expect(() => validateResearchLanguageProject(f.p)).not.toThrow();
  const corrupted = structuredClone(f.p);
  corrupted.languageReads!.pop();
  expect(() => validateResearchLanguageProject(corrupted)).toThrow(/未记录的读取凭据/);
});
test("a same-revision reopening retains B's initial judgment without inheriting old language approval", () => {
  const f = fixture();
  const risk = f.risk();
  f.readBoth("lead");
  f.review("lead");
  f.readBoth("reviewer");
  f.review("reviewer");
  f.accept();
  const previous = f.revision();
  const oldReviewer = structuredClone(activeFusionAttempt(f.p, "reviewer")!);

  f.p.fusion = setResearchInput(f.p.fusion!, {
    inputId: "fixture-local-counterevidence",
    version: 1,
    kind: "context",
    actual: false,
    availability: "available",
    label: "只验证局部重开生命周期的合成反证，不是论文事实",
    sourceRef: "fixture:local-counterevidence",
    digest: researchHash("A new local review condition, not a new project revision"),
  });
  f.p.fusion = applyResearchChange(f.p.fusion, {
    id: "fixture-local-reopening",
    at: f.at,
    inputId: "fixture-local-counterevidence",
    fromVersion: null,
    toVersion: 1,
    reason: "合成局部重审条件，只重开现有写作范围，不重写历史初判或检查。",
    authorizedBy: "existing-authorization",
    authorizationRef: "fixture:local-review-authorization",
    additionalTaskIds: f.p.fusion.tasks
      .filter((task) => task.stage === "writing")
      .map((task) => task.id),
  });
  expect(isCurrentResearchArtifact(f.p, risk)).toBe(false);
  expect(() => f.tool("reviewer", { operation: "language-context" })).toThrow(/实际原生/);

  for (const role of ["lead", "reviewer"] as const) {
    const old = activeFusionAttempt(f.p, role)!;
    finishFusionNativeRun(f.p, role, old.nativeRunId, f.at);
    const delivery = prepareFusionDelivery(
      f.p,
      role,
      `reopened-${role}`,
      f.at,
      "实际重开任务与新 native 的软件夹具，不代替 R",
    );
    expect(delivery.kind).toBe("dispatch");
    dispatchFusionAttempt(f.p, delivery.attemptId!, f.at);
    bindFusionNativeRun(f.p, role, `native-reopened-${role}`);
    f.p.fusion!.attempts.find((attempt) => attempt.id === delivery.attemptId)!.model = {
      provider: "unit",
      modelId: "synthetic",
    };
  }
  const reviewer = activeFusionAttempt(f.p, "reviewer")!;
  expect(reviewer.nativeRunId).not.toBe(oldReviewer.nativeRunId);
  expect(reviewer.taskVersion).toBeGreaterThan(oldReviewer.taskVersion);
  expect(f.p.artifacts.filter((artifact) => artifact.kind === "stage-risk")).toEqual([risk]);
  let context: unknown;
  expect(() => {
    context = f.tool("reviewer", { operation: "language-context" });
  }).not.toThrow();
  expect(context).toMatchObject({
    currentManuscriptId: undefined,
    revisions: [{ id: previous.id, current: false, status: "stale" }],
  });
  expect(() =>
    f.tool("reviewer", {
      operation: "language-read",
      languageRevisionId: previous.id,
      side: "target",
      start: 0,
      end: previous.target.body.length,
    }),
  ).toThrow(/不属于当前稿/);

  const next = f.publish("lead", "stage-revision", BASE.replace("可能有关", "可能存在某种关联"));
  expect(() => f.accept()).toThrow(/新稿不能沿用/);
  f.tool("lead", {
    operation: "language-register",
    scopeId: f.scope.id,
    baselineId: f.baseline.id,
    artifactId: next.id,
  });
  expect(f.revision().id).not.toBe(previous.id);
  expect(f.revision().semanticReviews).toEqual([]);
  expect(() => f.review("reviewer")).toThrow(/读取覆盖/);
  f.readBoth("lead");
  f.review("lead");
  f.readBoth("reviewer");
  f.review("reviewer");
  expect(() => f.accept()).not.toThrow();
  expect(isCurrentResearchArtifact(f.p, risk)).toBe(false);
});
test("skip and unanimous semantic opinions cannot conceal numerical or out-of-scope edits", () => {
  for (const after of [BASE.replace("n=120", "n=1200"), BASE.replace("# 讨论", "# 已证实因果")]) {
    const f = fixture(after);
    f.risk();
    if (f.revision().programReport.units.length) {
      f.readBoth("lead");
      f.review("lead");
      f.readBoth("reviewer");
      f.review("reviewer");
    }
    skipResearchLanguageRevision(f.p, f.revision().id, "测试操作者记录跳过，不能清除错误", f.at);
    expect(() => f.accept()).toThrow(/blocked/);
    expect(researchLanguageStatus(f.p)[0]!.hardIssues.length).toBeGreaterThan(0);
  }
});
test("new manuscripts and actual substantive judgments cannot inherit a prior semantic pass", () => {
  const f = fixture();
  f.risk();
  f.readBoth("lead");
  f.review("lead");
  f.readBoth("reviewer");
  f.review("reviewer");
  f.accept();
  const newer = f.publish("lead", "stage-revision", BASE.replace("可能有关", "会显著促进"));
  expect(() => f.accept()).toThrow(/新稿不能沿用/);
  expect(researchLanguageStatus(f.p)[0]!.status).toBe("stale");
  f.tool("lead", {
    operation: "language-register",
    scopeId: f.scope.id,
    baselineId: f.baseline.id,
    artifactId: newer.id,
  });
  f.readBoth("lead");
  f.review("lead");
  f.readBoth("reviewer");
  f.review("reviewer", "substantive-change");
  expect(() => f.accept()).toThrow(/content-review-required/);
  expect(f.p.languageRevisions).toHaveLength(2);
});
test("model arguments cannot forge user authorization, skip identity or an expanded chapter boundary", () => {
  const f = fixture();
  expect(() =>
    f.tool("lead", {
      operation: "language-register",
      scopeId: f.scope.id,
      baselineId: f.baseline.id,
      artifactId: f.target.id,
      authorization: { kind: "user" },
    }),
  ).toThrow(/未知字段/);
  expect(() =>
    f.tool("lead", {
      operation: "language-skip",
      languageRevisionId: f.revision().id,
      reason: "模型代跳过",
    }),
  ).toThrow();
  expect(() =>
    f.tool("lead", {
      operation: "language-not-applicable",
      artifactId: f.target.id,
      reason: "不再检查",
    }),
  ).toThrow(/实际改写/);
  expect(() =>
    decodeResearchAction({
      kind: "language-scope",
      target: f.p.root,
      input: {
        baselineId: f.baseline.id,
        bodySha256: f.scope.baseline.bodySha256,
        rangeIds: ["paragraph-999"],
        frozenTerms: [],
        actor: "user",
      },
    }),
  ).toThrow(/未知字段/);
  f.p.fusion!.attempts.find((a) => a.taskId.endsWith(":lead"))!.state = "unknown";
  expect(() => f.tool("lead", { operation: "language-context" })).toThrow(/实际原生/);
});

test("an existing full-paper authorization cannot widen the user's newer paragraph selection", () => {
  const f = fixture();
  f.p.entry = "idea";
  f.p.goal = "paper";
  f.p.task = undefined;
  const next = f.publish(
    "lead",
    "stage-revision",
    BASE.replace("# 讨论", "# 改过未选标题").replace("可能有关", "可能存在关联"),
  );
  f.tool("lead", {
    operation: "language-register",
    baselineId: f.baseline.id,
    artifactId: next.id,
  });
  expect(f.revision().authorization.id).toBe(f.scope.authorization.id);
  expect(
    f.revision().programReport.hardIssues.some((issue) => issue.category === "unselected-body"),
  ).toBe(true);
  expect(() => f.accept()).toThrow(/blocked/);
});
