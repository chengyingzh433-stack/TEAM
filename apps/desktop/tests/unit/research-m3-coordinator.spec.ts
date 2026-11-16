import { expect, test } from "@playwright/test";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { m3Project } from "../helpers/research-m3-unit-fixture";
import { m3Coordinator } from "../helpers/research-m3-coordinator-fixture";
import { researchExecutionCount } from "../../electron/research-group/research-execution-policy";
import { DEFAULT_RESEARCH_STAGES } from "../../contracts/research-group";
import { M3_BODY } from "../helpers/research-m3-unit-fixture";
import { ResearchCoordinator } from "../../electron/research-group/coordinator";
import type { ResearchProject } from "../../contracts/research-group";

async function legacyProject(): Promise<ResearchProject> {
  const p = (await m3Project("quantitative", "question")).p;
  delete p.fusion;
  delete p.workflowVersion;
  delete p.methodVersion;
  delete p.sharedMethod;
  delete p.entry;
  delete p.goal;
  delete p.path;
  p.stages = structuredClone(DEFAULT_RESEARCH_STAGES.slice(0, 2));
  return p;
}

test("two projects reserve the final global slots under the same persisted owner; lowering limits keeps admitted calls", async () => {
  const a = (await m3Project("quantitative", "question")).p,
    b = (await m3Project("review", "question")).p;
  const s = await m3Coordinator([a, b], 2);
  await Promise.all([s.c.resume(a.root), s.c.resume(b.root)]);
  await expect.poll(() => s.sent.length).toBe(2);
  await expect
    .poll(() => s.c.snapshot().projects.flatMap((p) => p.m3?.queued ?? []).length)
    .toBeGreaterThan(0);
  expect(
    (await s.repository.load()).projects.reduce((n, p) => n + researchExecutionCount(p), 0),
  ).toBe(2);
  await s.c.applyM3Action(a.root, {
    operation: "execution-settings",
    applicationLimit: 1,
    projectLimit: 4,
  });
  expect(s.cancelled).toEqual([]);
  expect(s.sent).toHaveLength(2);
  expect(s.c.snapshot().projects.reduce((n, p) => n + researchExecutionCount(p), 0)).toBe(2);
  const active = s.c.snapshot().projects.flatMap((p) =>
    p
      .fusion!.attempts.filter((a) => a.state === "running")
      .map((attempt) => ({
        p,
        role: p.fusion!.tasks.find((t) => t.id === attempt.taskId)!.role as "mentor",
      })),
  );
  for (const entry of active) {
    await s.native(entry.p.id, entry.role, "start");
    await s.native(entry.p.id, entry.role, "completed", 100);
  }
  await expect.poll(() => s.sent.length).toBe(3);
  expect(s.c.snapshot().projects.reduce((n, p) => n + researchExecutionCount(p), 0)).toBe(1);
});
test("task model changes wait for the next attempt and cannot change another project", async () => {
  const a = (await m3Project("quantitative", "question")).p,
    b = (await m3Project("review", "question")).p;
  const s = await m3Coordinator([a, b], 1);
  await s.c.applyM3Action(a.root, {
    operation: "task-model",
    taskId: "v1:question:mentor",
    model: { provider: "fixture", modelId: "first" },
  });
  await s.c.resume(a.root);
  await expect.poll(() => s.sent.length).toBe(1);
  const original = s.c.snapshot().projects[0]!.fusion!.attempts[0]!;
  await s.c.applyM3Action(a.root, {
    operation: "task-model",
    taskId: "v1:question:mentor",
    model: { provider: "fixture", modelId: "next" },
  });
  const route = (await s.c.tool(a.root, "route-query", { operation: "route" })) as {
    model: { modelId: string };
  };
  expect(route.model.modelId).toBe("first");
  expect(s.c.snapshot().projects[0]!.fusion!.attempts[0]!.model).toEqual(original.model);
  expect(s.c.snapshot().projects[1]!.m3?.taskModels).toBeUndefined();
  await expect(
    s.c.applyM3Action(a.root, {
      operation: "task-model",
      taskId: "v999:question:mentor",
      model: { provider: "fixture", modelId: "foreign" },
    }),
  ).rejects.toThrow("不属于");
});
test("saved presets fill project defaults without changing custom task/stage choices or in-flight attempts", async () => {
  const p = (await m3Project("review", "question")).p;
  p.m3 = {
    defaultModels: { lead: { provider: "fixture", modelId: "custom-project" } },
    taskModels: { "v1:question:mentor": { provider: "fixture", modelId: "custom-task" } },
  };
  p.stages!.find((s) => s.id === "question")!.models.reviewer = {
    provider: "fixture",
    modelId: "custom-stage",
  };
  const s = await m3Coordinator([p], 1);
  await s.c.applyM3Action(p.root, {
    operation: "save-model-preset",
    name: "balanced",
    models: {
      lead: { provider: "fixture", modelId: "preset-lead" },
      reviewer: { provider: "fixture", modelId: "preset-reviewer" },
    },
  });
  await s.c.applyM3Action(p.root, { operation: "apply-model-preset", name: "balanced" });
  const applied = s.c.snapshot().projects[0]!;
  expect(applied.m3!.defaultModels!.lead!.modelId).toBe("custom-project");
  expect(applied.m3!.defaultModels!.reviewer!.modelId).toBe("preset-reviewer");
  expect(applied.stages!.find((s) => s.id === "question")!.models.reviewer!.modelId).toBe(
    "custom-stage",
  );
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(1);
  expect(s.c.snapshot().projects[0]!.fusion!.attempts[0]!.model!.modelId).toBe("custom-task");
  const inFlight = s.c.snapshot().projects[0]!.fusion!.attempts[0]!;
  await s.c.applyM3Action(p.root, {
    operation: "save-model-preset",
    name: "review",
    models: { mentor: { provider: "fixture", modelId: "new-default" } },
  });
  await s.c.applyM3Action(p.root, { operation: "apply-model-preset", name: "review" });
  expect(s.c.snapshot().projects[0]!.m3!.defaultModels!.mentor!.modelId).toBe("new-default");
  expect(s.c.snapshot().projects[0]!.fusion!.attempts[0]).toEqual(inFlight);
  await s.c.applyM3Action(p.root, {
    operation: "execution-settings",
    applicationLimit: 1,
    projectLimit: 4,
    tokenBudget: 1000,
  });
  await s.c.applyM3Action(p.root, {
    operation: "execution-settings",
    applicationLimit: 1,
    projectLimit: 4,
    tokenBudget: null,
  });
  expect(s.c.snapshot().projects[0]!.m3!.tokenBudget).toBeUndefined();
  expect((await s.repository.load()).m3!.modelPresets![0]!.name).toBe("balanced");
});
test("a transient model failure uses only the preauthorized candidate after a known usage settlement", async () => {
  const p = (await m3Project("quantitative", "question")).p;
  const s = await m3Coordinator([p], 1);
  await s.c.applyM3Action(p.root, {
    operation: "task-model",
    taskId: "v1:question:mentor",
    model: { provider: "fixture", modelId: "original" },
    recovery: {
      candidates: [{ provider: "fixture", modelId: "explicit-fallback" }],
      maxRetries: 1,
    },
  });
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(1);
  await s.native(p.id, "mentor", "start");
  await s.native(p.id, "mentor", "failed", 100);
  await expect.poll(() => s.c.snapshot().projects[0]!.m3?.recoveries?.length).toBe(1);
  await expect
    .poll(async () => {
      const current = s.c.snapshot().projects[0]!;
      if (current.fusion!.attempts.filter((a) => a.taskId === "v1:question:mentor").length === 2)
        return true;
      const other = current.fusion!.attempts.find(
        (a) => a.state === "running" && a.taskId !== "v1:question:mentor",
      );
      if (other) {
        const role = current.fusion!.tasks.find((t) => t.id === other.taskId)!.role as "lead";
        await s.native(p.id, role, "start");
        await s.native(p.id, role, "completed", 100);
      }
      return false;
    })
    .toBe(true);
  const attempts = s.c
    .snapshot()
    .projects[0]!.fusion!.attempts.filter((a) => a.taskId === "v1:question:mentor");
  expect(attempts[0]).toMatchObject({
    state: "failed",
    usedTokens: 100,
    model: { modelId: "original" },
  });
  expect(attempts[1]).toMatchObject({
    model: { modelId: "explicit-fallback" },
    modelSource: "authorized-recovery",
  });
});
test("project totals keep an unknown finished usage reservation and never treat it as free capacity for spending", async () => {
  const p = (await m3Project("quantitative", "question")).p;
  const s = await m3Coordinator([p], 1);
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(1);
  const reservation = s.c.snapshot().projects[0]!.fusion!.attempts[0]!.reservedTokens;
  await s.c.applyM3Action(p.root, {
    operation: "execution-settings",
    applicationLimit: 1,
    projectLimit: 4,
    tokenBudget: reservation + 1,
  });
  await s.native(p.id, "mentor", "start");
  await s.native(p.id, "mentor", "completed");
  await expect
    .poll(() => s.c.snapshot().projects[0]!.m3?.queued?.some((q) => q.reason.includes("未结算")))
    .toBe(true);
  expect(s.sent).toHaveLength(1);
  const persisted = await s.repository.load();
  expect(persisted.projects[0]!.fusion!.attempts[0]!.usedTokens).toBeUndefined();
  expect(persisted.projects[0]!.fusion!.attempts[0]!.reservedTokens).toBe(reservation);
});

test("a real durable write failure stops dispatch instead of spinning or replacing saved work", async () => {
  const p = (await m3Project("quantitative", "question")).p;
  const s = await m3Coordinator([p], 1);
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(1);
  const file = join(s.directory, "research-groups.json"),
    retained = join(s.directory, "research-groups.before-failure.json");
  await rename(file, retained);
  await mkdir(file);
  await expect(
    s.c.applyM3Action(p.root, {
      operation: "execution-settings",
      applicationLimit: 8,
      projectLimit: 4,
    }),
  ).rejects.toThrow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(s.c.snapshot().error).toContain("保存失败");
  expect(s.sent).toHaveLength(1);
  const saved = JSON.parse(await readFile(retained, "utf8")) as { projects: { id: string }[] };
  expect(saved.projects[0]!.id).toBe(p.id);
  expect(s.c.snapshot().projects[0]!.artifacts).toEqual([]);
});

test("a specialist uses a new session, shares the existing slot and retains its records on exit", async () => {
  const p = (await m3Project("review", "synthesis")).p;
  const s = await m3Coordinator([p], 1);
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(1);
  const originalMembers = s.c.snapshot().projects[0]!.members.map((m) => m.ref);
  await s.c.applyM3Action(p.root, {
    operation: "add-specialist",
    kind: "method",
    label: "方法专项",
    objective: "核查本材料的方法与解释边界",
    deliverable: "限定方法意见",
    exitCondition: "交付后退出",
    integrator: "lead",
    sourceIds: ["paper-a"],
    artifactIds: [],
    model: { provider: "fixture", modelId: "specialist" },
  });
  const specialist = s.c.snapshot().projects[0]!.m3!.specialists![0]!;
  expect(originalMembers).not.toContainEqual(specialist.ref);
  expect(s.c.snapshot().projects[0]!.members.map((m) => m.ref)).toEqual(originalMembers);
  expect(
    s.c.snapshot().projects[0]!.fusion!.attempts.some((a) => a.taskId === specialist.taskId),
  ).toBe(false);
  await expect
    .poll(async () => {
      const current = s.c.snapshot().projects[0]!;
      if (current.fusion!.attempts.some((a) => a.taskId === specialist.taskId)) return true;
      const active = current.fusion!.attempts.find((a) => a.state === "running");
      if (active) {
        const role = current.fusion!.tasks.find((t) => t.id === active.taskId)!.role as "mentor";
        await s.native(p.id, role, "start");
        await s.native(p.id, role, "completed", 100);
      }
      return false;
    })
    .toBe(true);
  expect(researchExecutionCount(s.c.snapshot().projects[0]!)).toBe(1);
  await s.native(p.id, { specialistId: specialist.id }, "start");
  expect(await s.c.tool(specialist.ref, "scope-query", { operation: "scope" })).toMatchObject({
    scope: "research-specialist",
  });
  await s.c.applyM3Action(p.root, { operation: "exit-specialist", specialistId: specialist.id });
  expect(s.cancelled).toContainEqual(specialist.ref);
  expect(researchExecutionCount(s.c.snapshot().projects[0]!)).toBe(1);
  await s.native(p.id, { specialistId: specialist.id }, "completed", 50);
  expect(s.c.snapshot().projects[0]!.m3!.specialists![0]!.state).toBe("exited");
  expect(s.c.snapshot().projects[0]!.members.map((m) => m.ref)).toEqual(originalMembers);
});
test("legacy and fusion projects race for the same durable global slot; restart retains unknown occupancy", async () => {
  const legacy = await legacyProject();
  const fusion = (await m3Project("review", "question")).p;
  const s = await m3Coordinator([legacy, fusion], 1);
  await Promise.all([s.c.resume(legacy.root), s.c.resume(fusion.root)]);
  await expect.poll(() => s.sent.length).toBe(1);
  await expect.poll(() => s.c.snapshot().m3?.legacyQueue?.length ?? 0).toBeGreaterThan(0);
  const state = s.c.snapshot();
  expect(state.projects.reduce((n, p) => n + researchExecutionCount(p, state), 0)).toBe(1);
  expect(state.projects.find((p) => p.id === legacy.id)!.fusion).toBeUndefined();
  if (!state.m3?.legacyExecutions?.length) {
    await s.native(fusion.id, "mentor", "start");
    await s.native(fusion.id, "mentor", "completed", 100);
    await expect.poll(() => s.c.snapshot().m3?.legacyExecutions?.length).toBe(1);
  }
  const call = s.c.snapshot().m3!.legacyExecutions![0]!;
  await s.native(legacy.id, call.role, "start");
  const awakened: string[] = [];
  const restored = new ResearchCoordinator(s.repository, {
    createMember: async () => {
      throw new Error("no sessions");
    },
    deliver: async (ref) => {
      awakened.push(ref.sessionId);
    },
    cancel: async () => {},
    changed: () => {},
  });
  await restored.load();
  const loaded = restored.snapshot();
  expect(loaded.m3!.legacyExecutions![0]!.state).toBe("unknown");
  expect(loaded.projects.reduce((n, p) => n + researchExecutionCount(p, loaded), 0)).toBe(1);
  await restored.resume(fusion.root);
  expect(awakened).toEqual([]);
  await restored.resolveAttempt(legacy.root, {
    attemptId: call.id,
    outcome: "cancelled",
    reason: "用户核对提供方记录，确认已取消",
    evidenceRef: "unit-provider-record",
  });
  const settled = restored.snapshot();
  expect(settled.m3!.legacyExecutions![0]!.usedTokens).toBeUndefined();
  expect(settled.m3!.legacyExecutions![0]!.reservedTokens).toBe(call.reservedTokens);
  await expect.poll(() => awakened.length).toBe(1);
  expect(legacy.members.map((m) => m.ref.sessionId)).not.toContain(awakened[0]);
});
test("legacy capacity waiting stays running, wakes on release and settles a bound failure after pause", async () => {
  const fusion = (await m3Project("review", "question")).p;
  const legacy = await legacyProject();
  const s = await m3Coordinator([fusion, legacy], 1);
  await s.c.resume(fusion.root);
  await expect.poll(() => s.sent.length).toBe(1);
  await s.c.resume(legacy.root);
  await expect
    .poll(() => s.c.snapshot().m3?.legacyQueue?.filter((q) => q.projectId === legacy.id).length)
    .toBe(4);
  expect(s.c.snapshot().projects.find((p) => p.id === legacy.id)!.status).toBe("running");
  await s.native(fusion.id, "mentor", "start");
  await s.native(fusion.id, "mentor", "completed", 100);
  await expect
    .poll(() =>
      s.sent.some(
        (call) =>
          call.ref.sessionId === legacy.members.find((m) => m.role === "mentor")!.ref.sessionId,
      ),
    )
    .toBe(true);
  await s.native(legacy.id, "mentor", "start");
  await s.c.pause(legacy.root);
  await s.native(legacy.id, "mentor", "failed");
  const state = s.c.snapshot();
  expect(state.projects.find((p) => p.id === legacy.id)!.status).toBe("paused");
  expect(state.m3!.legacyExecutions!.find((a) => a.projectId === legacy.id)!.state).toBe("failed");
});
test("old legacy queued prompts remain history and cannot enter a later revision", async () => {
  const legacy = await legacyProject();
  legacy.revision = 2;
  const s = await m3Coordinator([legacy], 1);
  const saved = await s.repository.load();
  saved.m3!.legacyQueue = [
    {
      projectId: legacy.id,
      revision: 1,
      role: "mentor",
      text: "OLD_REVISION_INSTRUCTION",
      at: new Date().toISOString(),
      reason: "old capacity wait",
    },
  ];
  await s.repository.save(saved);
  await s.c.load();
  await s.c.resume(legacy.root);
  await expect.poll(() => s.sent.length).toBe(1);
  expect(s.sent[0]!.text).not.toContain("OLD_REVISION_INSTRUCTION");
  expect(
    s.c
      .snapshot()
      .m3!.legacyQueue!.some((q) => q.revision === 1 && q.text === "OLD_REVISION_INSTRUCTION"),
  ).toBe(true);
});
for (const finish of ["native-completion", "unknown-resolution"] as const)
  test(`specialist follow-up ${finish} without a fresh submission preserves execution but fails delivery`, async () => {
    const p = (await m3Project("review", "synthesis")).p;
    const s = await m3Coordinator([p], 1);
    await s.c.applyM3Action(p.root, {
      operation: "add-specialist",
      kind: "method",
      label: "逻辑检查专项",
      objective: "检查原文的方法边界",
      deliverable: "方法边界意见",
      exitCondition: "交付后退出",
      integrator: "lead",
      sourceIds: ["paper-a"],
      artifactIds: [],
      model: { provider: "fixture", modelId: "logic-only" },
    });
    await s.c.resume(p.root);
    const specialist = s.c.snapshot().projects[0]!.m3!.specialists![0]!;
    await expect
      .poll(async () => {
        const current = s.c.snapshot().projects[0]!;
        if (current.fusion!.attempts.some((a) => a.taskId === specialist.taskId)) return true;
        const base = current.fusion!.attempts.find((a) => a.state === "running");
        if (base) {
          const role = current.fusion!.tasks.find((t) => t.id === base.taskId)!.role as "lead";
          await s.native(p.id, role, "start");
          await s.native(p.id, role, "completed", 100);
        }
        return false;
      })
      .toBe(true);
    await s.native(p.id, { specialistId: specialist.id }, "start");
    for (const input of [
      { operation: "source-read", sourceId: "paper-a" },
      { operation: "method-package" },
      { operation: "specialist-submit", content: M3_BODY + M3_BODY },
    ])
      await s.c.tool(specialist.ref, `unit-${input.operation}`, input);
    await s.native(p.id, { specialistId: specialist.id }, "completed", 100);
    const initial = s.c.snapshot().projects[0]!.m3!.specialists![0]!.initialOpinion;
    await s.c.applyM3Action(p.root, {
      operation: "open-specialist-discussion",
      specialistId: specialist.id,
      question: "检查新意见后说明是否维持原判断",
    });
    await expect
      .poll(async () => {
        const current = s.c.snapshot().projects[0]!;
        if (current.fusion!.attempts.filter((a) => a.taskId === specialist.taskId).length === 2)
          return true;
        const base = current.fusion!.attempts.find(
          (a) => a.state === "running" && a.taskId !== specialist.taskId,
        );
        if (base) {
          const role = current.fusion!.tasks.find((t) => t.id === base.taskId)!.role as "lead";
          await s.native(p.id, role, "start");
          await s.native(p.id, role, "completed", 200);
        }
        return false;
      })
      .toBe(true);
    await s.native(p.id, { specialistId: specialist.id }, "start");
    if (finish === "native-completion")
      await s.native(p.id, { specialistId: specialist.id }, "completed", 150);
    else {
      const attempt = s.c
        .snapshot()
        .projects[0]!.fusion!.attempts.filter((a) => a.taskId === specialist.taskId)
        .at(-1)!;
      await s.c.load();
      await s.c.resolveAttempt(p.root, {
        attemptId: attempt.id,
        outcome: "succeeded",
        evidenceRef: "unit-native-record",
        reason: "已结束但没有本轮新的后续交付。",
      });
    }
    const current = s.c.snapshot().projects[0]!;
    expect(current.m3!.specialists![0]!.state).toBe("failed");
    expect(current.m3!.specialists![0]!.initialOpinion).toEqual(initial);
    expect(current.fusion!.tasks.find((t) => t.id === specialist.taskId)!.state).toBe("failed");
    expect(
      current.fusion!.attempts.filter((a) => a.taskId === specialist.taskId).at(-1)!.state,
    ).toBe("succeeded");
  });
