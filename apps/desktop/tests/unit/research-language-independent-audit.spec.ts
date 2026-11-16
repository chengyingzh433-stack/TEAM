import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESEARCH_ROLES,
  type ResearchArtifact,
  type ResearchProject,
  type ResearchRole,
} from "../../contracts/research-group";
import { researchLanguageParagraphs } from "../../contracts/research-language-tools";
import { createResearchLanguageArtifact } from "../../electron/research-group/language-revisions";
import {
  applyResearchLanguageTool,
  assertResearchLanguageAcceptance,
  grantResearchLanguageScope,
} from "../../electron/research-group/language-tools";
import {
  bindFusionNativeRun,
  dispatchFusionAttempt,
  finishFusionNativeRun,
  prepareFusionDelivery,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchRepository } from "../../electron/research-group/repository";

// Independent contract fixtures. No Electron, provider request or semantic quality claim.
const BASE = "# 讨论\n\n学习支持可能有关；未观察到确定差异。\n\n限制：只讨论所提供材料。";
const at = "2026-11-08T08:00:00.000Z";
function fixture() {
  const p: ResearchProject = {
    id: randomUUID(),
    root: { workspaceId: "/synthetic-review", sessionId: "mentor" },
    workspacePath: "/synthetic-review",
    objective: "完整论文授权之下，后续用户选段是实际修改边界；独立软件审查夹具",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "paper",
    path: "quantitative",
    currentStage: "writing",
    scope: "paper",
    knowledge: {
      directory: "/synthetic-review",
      sha256: "a".repeat(64),
      version: "unit",
      count: 0,
    },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: "/synthetic-review", sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    events: [],
    packets: [],
  };
  for (const role of ["lead", "reviewer", "mentor"] as const) {
    const delivery = prepareFusionDelivery(
      p,
      role,
      `independent-${role}`,
      at,
      "合成宿主执行，不是实际R或C。",
    );
    expect(delivery.kind).toBe("dispatch");
    dispatchFusionAttempt(p, delivery.attemptId!, at);
    bindFusionNativeRun(p, role, `independent-native-${role}`);
    p.fusion!.attempts.find((attempt) => attempt.id === delivery.attemptId)!.model = {
      provider: "unit",
      modelId: "fixture",
    };
  }
  let serial = 0;
  const publish = (role: ResearchRole, kind: ResearchArtifact["kind"], body: string) => {
    const artifact: ResearchArtifact = {
      id: randomUUID(),
      role,
      kind,
      revision: p.revision,
      stage: "writing",
      round: 0,
      createdAt: at,
      content: body,
      refs: [],
      toolCallId: `publish-${++serial}`,
    };
    p.artifacts.push(artifact);
    publishFusionArtifact(p, artifact);
    return artifact;
  };
  const baseline = publish("lead", "stage-draft", BASE);
  const tool = (role: ResearchRole, input: Record<string, unknown>) =>
    applyResearchLanguageTool(p, role, `audit-${++serial}`, input, at);
  const selected = () =>
    grantResearchLanguageScope(
      p,
      {
        baselineId: baseline.id,
        bodySha256: createResearchLanguageArtifact(baseline.id, baseline.content).bodySha256,
        rangeIds: [researchLanguageParagraphs(BASE)[1]!.id],
        frozenTerms: ["学习支持"],
      },
      at,
    );
  const register = (target: ResearchArtifact, scopeId?: string, from = baseline) =>
    tool("lead", {
      operation: "language-register",
      baselineId: from.id,
      artifactId: target.id,
      ...(scopeId ? { scopeId } : {}),
    });
  const review = (role: "lead" | "reviewer") => {
    const revision = p.languageRevisions!.at(-1)!;
    for (const side of ["baseline", "target"] as const)
      tool(role, {
        operation: "language-read",
        languageRevisionId: revision.id,
        side,
        start: 0,
        end: revision[side].body.length,
      });
    tool(role, {
      operation: "language-review",
      languageReview: {
        revisionId: revision.id,
        classification: "meaning-preserved",
        reason: "合成软件契约观察；独立C另行评阅。",
        coverage: revision.programReport.units.map(({ id, baseline, target }) => ({
          unitId: id,
          baseline,
          target,
        })),
      },
    });
  };
  return { p, baseline, publish, tool, selected, register, review };
}

test("latest actual selected paragraph constrains omitted or older full-paper scope and alternate baseline", () => {
  const f = fixture(),
    first = f.publish("lead", "stage-revision", BASE.replace("可能有关", "或有关联"));
  f.register(first);
  const broad = f.p.languageScopes!.at(-1)!,
    selected = f.selected();
  const target = f.publish("lead", "stage-revision", BASE.replace("# 讨论", "# 讨论修订"));
  f.register(target);
  const actual = f.p.languageRevisions!.at(-1)!;
  expect(actual.authorization.id).toBe(selected.id);
  expect(
    actual.programReport.hardIssues.some((issue) => issue.category === "unselected-body"),
  ).toBe(true);
  expect(() => f.register(target, broad.id)).toThrow();
  expect(() => f.register(target, undefined, first)).toThrow();
  expect(() =>
    assertResearchLanguageAcceptance(f.p, "mentor", { kind: "stage-review", verdict: "accept" }),
  ).toThrow();
});

test("a fresh explicit authorization cannot inherit the same-body broad authorization's old semantic opinions", () => {
  const f = fixture(),
    target = f.publish("lead", "stage-revision", BASE.replace("可能有关", "或有关联"));
  f.register(target);
  f.publish("reviewer", "stage-risk", "合成独立意见");
  f.review("lead");
  f.review("reviewer");
  expect(() =>
    assertResearchLanguageAcceptance(f.p, "mentor", { kind: "stage-review", verdict: "accept" }),
  ).not.toThrow();
  const old = f.p.languageRevisions!.at(-1)!,
    selected = f.selected();
  f.register(target, selected.id);
  const current = f.p.languageRevisions!.at(-1)!;
  expect(current.id).not.toBe(old.id);
  expect(current.authorization.id).toBe(selected.id);
  expect(current.semanticReviews).toEqual([]);
  expect(() =>
    assertResearchLanguageAcceptance(f.p, "mentor", { kind: "stage-review", verdict: "accept" }),
  ).toThrow();
});

test("granting language work on a completed project must reject clearly or create schedulable continuation", async ({}, testInfo) => {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "independent-language-grant-"));
  f.p.workspacePath = directory;
  for (const role of ["lead", "reviewer", "mentor"] as const)
    finishFusionNativeRun(f.p, role, `independent-native-${role}`, at);
  f.p.status = "completed";
  const repository = new ResearchRepository(directory);
  await repository.save({ version: 1, config: { knowledgeDir: directory }, projects: [f.p] });
  const deliveries: string[] = [];
  const host: ResearchHost = {
    createMember: async () => {
      throw new Error("This audit must not create a member");
    },
    deliver: async (ref) => {
      deliveries.push(ref.sessionId);
    },
    cancel: async () => {},
    changed: () => {},
  };
  const coordinator = new ResearchCoordinator(repository, host);
  await coordinator.load();
  let rejection: string | undefined;
  try {
    await coordinator.grantLanguageScope(f.p.root, {
      baselineId: f.baseline.id,
      bodySha256: createResearchLanguageArtifact(f.baseline.id, BASE).bodySha256,
      rangeIds: [researchLanguageParagraphs(BASE)[1]!.id],
      frozenTerms: [],
    });
  } catch (error) {
    rejection = String(error);
  }
  if (!rejection) await coordinator.flush();
  const after = coordinator.snapshot().projects[0]!;
  await writeFile(
    testInfo.outputPath("completed-language-grant.json"),
    JSON.stringify(
      {
        directory,
        rejection: rejection ?? null,
        deliveries,
        beforeStatus: f.p.status,
        afterStatus: after.status,
        scopes: after.languageScopes,
        attempts: after.fusion?.attempts,
      },
      null,
      2,
    ),
  );
  if (rejection) {
    expect(after.languageScopes ?? []).toEqual([]);
    expect((await repository.load()).projects[0]!.languageScopes ?? []).toEqual([]);
    return;
  }
  expect(after.languageScopes).toHaveLength(1);
  expect(
    after.status,
    "A successful grant must have a visible runnable/paused continuation, not remain silently completed",
  ).not.toBe("completed");
});
