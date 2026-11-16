import { expect, test } from "@playwright/test";
import { readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  settleResearchUsage,
  validateResearchUsage,
  type ResearchUsageRecord,
} from "../../contracts/research-usage";
import { researchUsageRows, researchUsageSummary } from "../../contracts/research-usage-report";
import type { ResearchGroupsState } from "../../contracts/research-group";
import { ResearchRepository } from "../../electron/research-group/repository";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import {
  finishFusionNativeRun,
  prepareFusionDelivery,
} from "../../electron/research-group/fusion-task-runtime";
import {
  researchExecutionCount,
  researchExecutionAdmission,
} from "../../electron/research-group/research-execution-policy";
import {
  reserveLegacyExecution,
  settleLegacyExecution,
} from "../../electron/research-group/legacy-execution-policy";
import { m3Activate, m3Project } from "../helpers/research-m3-unit-fixture";

const counts = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10 };
const host = (override: Partial<ResearchHost> = {}): ResearchHost => ({
  createMember: async () => {
    throw new Error("unexpected create");
  },
  deliver: async () => {
    throw new Error("unexpected dispatch");
  },
  cancel: async () => {},
  changed: () => {},
  ...override,
});
const stateFor = (p: ResearchGroupsState["projects"][number]): ResearchGroupsState => ({
  version: 1,
  config: { knowledgeDir: "" },
  projects: [p],
});

test("cumulative input/output/cache counts settle once; SDK cost extras do not invalidate token counters", () => {
  const first: ResearchUsageRecord = {};
  const native = { ...counts, cost: 0.05 };
  expect(settleResearchUsage(first, undefined, 160, native)).toBe(160);
  expect(first.tokenUsage).toEqual(counts);
  const next: ResearchUsageRecord = {};
  expect(settleResearchUsage(next, first, 175, { ...counts, input: 110, output: 25 })).toBe(15);
  expect(next.tokenUsage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  const stable = structuredClone(next);
  expect(settleResearchUsage(next, first, 500, { ...counts, input: 440 })).toBe(15);
  expect(next).toEqual(stable);
  validateResearchUsage(next);
});
test("unknown earlier consumption stays unallocated; a new checkpoint permits only later deltas", () => {
  const failed: ResearchUsageRecord = {};
  const later: ResearchUsageRecord = {};
  expect(settleResearchUsage(later, failed, 160, counts)).toBeUndefined();
  expect(later.usedTokens).toBeUndefined();
  expect(later.sessionTotalTokens).toBe(160);
  const third: ResearchUsageRecord = {};
  expect(settleResearchUsage(third, later, 170, { ...counts, input: 110 })).toBe(10);
  expect(failed).toEqual({});
});
for (const invalid of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid usage ${invalid} stays unknown without modifying saved counters`, () => {
    const row: ResearchUsageRecord = {};
    expect(settleResearchUsage(row, undefined, invalid)).toBeUndefined();
    expect(row).toEqual({});
  });
}
test("counter reset, inconsistent totals and corrupt durable breakdown fail closed", () => {
  const previous: ResearchUsageRecord = {};
  settleResearchUsage(previous, undefined, 160, counts);
  for (const current of [
    { ...counts, input: 50, output: 100 },
    { ...counts, output: 19 },
  ]) {
    const row: ResearchUsageRecord = {};
    expect(
      settleResearchUsage(
        row,
        previous,
        Object.values(current).reduce((sum, value) => sum + value, 0),
        current,
      ),
    ).toBeUndefined();
    expect(row).toEqual({});
  }
  expect(() => validateResearchUsage({ usedTokens: 10, tokenUsage: counts })).toThrow("总数");
});
test("fusion completion and duplicate old terminals preserve detailed usage through real storage reload", async () => {
  const { p, directory } = await m3Project("quantitative", "question");
  const a = m3Activate(p, "lead");
  finishFusionNativeRun(p, "lead", a.nativeRunId, new Date().toISOString(), counts);
  const first = structuredClone(p.fusion);
  finishFusionNativeRun(p, "lead", a.nativeRunId, new Date().toISOString(), {
    ...counts,
    input: 999,
  });
  expect(p.fusion).toEqual(first);
  const repo = new ResearchRepository(directory);
  await repo.save(stateFor(p));
  const saved = await repo.load();
  expect(saved.projects[0]!.fusion!.attempts[0]!.tokenUsage).toEqual(counts);
  const summary = researchUsageSummary(researchUsageRows(saved, saved.projects[0]!));
  expect(summary).toMatchObject({
    knownTokens: 160,
    unresolved: 0,
    reservedTokens: 0,
    buckets: counts,
  });
});
test("legacy failures, retries and a second project retain separate reservations and counters", async () => {
  const { p } = await m3Project();
  const s = stateFor(p);
  const first = reserveLegacyExecution(s, p, "lead", "first", new Date().toISOString());
  settleLegacyExecution(s, first, "failed", new Date().toISOString());
  const second = reserveLegacyExecution(s, p, "lead", "retry", new Date().toISOString());
  settleLegacyExecution(s, second, "succeeded", new Date().toISOString(), 160, counts);
  expect(second.usedTokens).toBeUndefined();
  expect(researchUsageSummary(researchUsageRows(s, p))).toMatchObject({
    knownTokens: 0,
    unresolved: 2,
    reservedTokens: first.reservedTokens + second.reservedTokens,
  });
  const other = await m3Project();
  s.projects.push(other.p);
  const call = reserveLegacyExecution(s, other.p, "lead", "other", new Date().toISOString());
  settleLegacyExecution(s, call, "cancelled", new Date().toISOString(), 160, counts);
  expect(researchUsageSummary(researchUsageRows(s, other.p)).knownTokens).toBe(160);
  expect(researchUsageSummary(researchUsageRows(s, p)).knownTokens).toBe(0);
});
test("restart cancels never-dispatched work but keeps running requests unknown and counted", async () => {
  const { p, directory } = await m3Project("quantitative", "question");
  const running = m3Activate(p, "lead");
  prepareFusionDelivery(
    p,
    "reviewer",
    "prepared-at-crash",
    new Date().toISOString(),
    "isolated input",
  );
  const s = stateFor(p);
  s.m3 = { applicationLimit: 1 };
  const repo = new ResearchRepository(directory);
  await repo.save(s);
  const coordinator = new ResearchCoordinator(repo, host());
  await coordinator.load();
  const recovered = coordinator.snapshot();
  expect(
    recovered.projects[0]!.fusion!.attempts.find((a) => a.id === "prepared-at-crash"),
  ).toMatchObject({ state: "cancelled", usedTokens: 0 });
  expect(recovered.projects[0]!.fusion!.attempts.find((a) => a.id === running.id)!.state).toBe(
    "unknown",
  );
  expect(researchExecutionCount(recovered.projects[0]!)).toBe(1);
  expect(
    researchExecutionAdmission(recovered, recovered.projects[0]!, "v1:question:librarian", "next"),
  ).toBeTruthy();
  expect(
    recovered.projects[0]!.fusion!.attempts.find((a) => a.id === running.id)!.usedTokens,
  ).toBeUndefined();
});
test("cancellation failure is durable and preserves unknown slots and original member identities", async () => {
  const { p, directory } = await m3Project("quantitative", "question");
  m3Activate(p, "lead");
  const repo = new ResearchRepository(directory);
  await repo.save(stateFor(p));
  const coordinator = new ResearchCoordinator(
    repo,
    host({
      cancel: async () => {
        throw new Error("fixture cancellation unavailable");
      },
    }),
  );
  await coordinator.load();
  await coordinator.pause(p.root);
  const saved = (await repo.load()).projects[0]!;
  expect(saved.status).toBe("paused");
  expect(saved.members.map((m) => m.ref)).toEqual(p.members.map((m) => m.ref));
  expect(saved.events.filter((e) => e.detail.includes("取消未确认"))).toHaveLength(4);
  expect(saved.fusion!.attempts[0]!.state).toBe("unknown");
  expect(researchUsageSummary(researchUsageRows({ ...stateFor(saved) }, saved)).unresolved).toBe(1);
});
test("corrupt primary recovers valid backup and preserves damaged bytes on next save", async () => {
  const { p, directory } = await m3Project();
  const repo = new ResearchRepository(directory);
  await repo.save(stateFor(p));
  await repo.save(stateFor(p));
  const file = join(directory, "research-groups.json");
  const damaged = '{"broken":';
  await writeFile(file, damaged);
  const restored = await repo.load();
  expect(restored.projects[0]).toEqual(p);
  await repo.save(restored);
  const retained = (await readdir(directory)).find((name) =>
    name.startsWith("research-groups.json.corrupt."),
  );
  expect(retained).toBeTruthy();
  expect(await readFile(join(directory, retained!), "utf8")).toBe(damaged);
});
test("state write failure stops admission and preserves last confirmed state and damaged bytes", async () => {
  const { p, directory } = await m3Project();
  const repo = new ResearchRepository(directory);
  await repo.save(stateFor(p));
  const coordinator = new ResearchCoordinator(repo, host());
  await coordinator.load();
  const before = coordinator.snapshot().projects[0]!;
  const file = join(directory, "research-groups.json");
  const bytes = await readFile(file);
  await rename(file, file + ".retained-test-original");
  await writeFile(file, "damaged primary without valid backup");
  await expect(coordinator.pause(p.root)).rejects.toThrow();
  expect(coordinator.snapshot().error).toContain("停止新增派发");
  expect(coordinator.snapshot().projects[0]).toEqual(before);
  await expect(coordinator.exportReview(p.root, "not-a-real-draft")).rejects.toThrow("保存失败");
  expect(await readFile(file + ".retained-test-original")).toEqual(bytes);
  expect(await readFile(file, "utf8")).toBe("damaged primary without valid backup");
});

test("a positively never-dispatched zero attempt does not hide the next native usage", async () => {
  const { p } = await m3Project();
  const s = stateFor(p);
  const neverSent = reserveLegacyExecution(s, p, "lead", "prepared", new Date().toISOString());
  settleLegacyExecution(s, neverSent, "cancelled", new Date().toISOString(), 0);
  const next = reserveLegacyExecution(s, p, "lead", "next", new Date().toISOString());
  next.nativeRunId = "actual-native";
  settleLegacyExecution(s, next, "succeeded", new Date().toISOString(), 160, counts);
  expect(next.usedTokens).toBe(160);
  expect(researchUsageSummary(researchUsageRows(s, p)).knownTokens).toBe(160);
});
test("malformed durable usage fails validation without replacing original state bytes", async () => {
  const { p, directory } = await m3Project("quantitative", "question");
  const a = m3Activate(p, "lead");
  finishFusionNativeRun(p, "lead", a.nativeRunId, new Date().toISOString(), counts);
  const repo = new ResearchRepository(directory);
  await repo.save(stateFor(p));
  const file = join(directory, "research-groups.json"),
    before = await readFile(file);
  p.fusion!.attempts[0]!.tokenUsage!.input++;
  await expect(repo.save(stateFor(p))).rejects.toThrow("总数");
  expect(await readFile(file)).toEqual(before);
});

test("a backup older than dispatch stays read-only and cannot overwrite newer projection or replay requests", async () => {
  const { p, directory } = await m3Project("quantitative", "question");
  prepareFusionDelivery(
    p,
    "lead",
    "before-dispatch",
    new Date().toISOString(),
    "prepared snapshot",
  );
  const repo = new ResearchRepository(directory);
  await repo.save(stateFor(p));
  await repo.save(stateFor(p));
  const primary = join(directory, "research-groups.json");
  const damaged = '{"newer-running-state":';
  await writeFile(primary, damaged);
  const projectionDir = join(p.workspacePath, ".lancer", "research-groups", p.id);
  await repo.exportProject(p);
  const projection = join(projectionDir, "project.json");
  await writeFile(projection, "newer projection retained for recovery");
  const coordinator = new ResearchCoordinator(repo, host());
  await coordinator.load();
  expect(coordinator.snapshot().error).toContain("只读核查");
  await expect(coordinator.resume(p.root)).rejects.toThrow();
  await coordinator.flush().catch(() => undefined);
  expect(await readFile(primary, "utf8")).toBe(damaged);
  expect(await readFile(projection, "utf8")).toBe("newer projection retained for recovery");
  expect(coordinator.snapshot().projects[0]!.fusion!.attempts[0]!.state).toBe("prepared");
});
