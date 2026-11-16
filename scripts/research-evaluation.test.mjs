import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createEvaluation,
  validateEvaluation,
  summarizeEvaluation,
  TASKS,
} from "./research-evaluation.mjs";

function recorded() {
  const data = createEvaluation();
  data.protocol = Object.fromEntries(
    [
      "operator",
      "budgetApproval",
      "budgetAndScale",
      "environment",
      "serialProcedure",
      "collaborativeProcedure",
      "cachePolicy",
      "reviewerIndependence",
    ].map((k) => [k, "fixture only"]),
  );
  data.protocol.registeredAt = "2026-11-14T00:00:00Z";
  for (const task of data.tasks)
    task.registration = Object.fromEntries(
      [
        "objective",
        "materialsManifest",
        "modelAssignments",
        "tools",
        "deliverables",
        "qualityRubric",
        "interventionRule",
        "stopRule",
      ].map((k) => [k, "fixture only"]),
    );
  const run = data.runs[0];
  run.status = "failed";
  run.observation = {
    projectId: "fixture",
    sessionEvidence: "fixture/session",
    timingEvidence: "fixture/timing",
    usageEvidence: "fixture/usage",
    cacheConditions: "unknown",
    interventions: "none",
    failures: "provider timeout",
    deviations: "none",
    resultEvidence: "fixture/failure",
    unknownReasons: "provider did not report usage",
    authorIds: ["author"],
    startedAt: "2026-11-14T00:00:00Z",
    endedAt: "2026-11-14T00:01:00Z",
    metrics: {
      elapsedSeconds: 60,
      criticalPathSeconds: null,
      inputTokens: null,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      money: null,
      humanMinutes: 0,
      reworkCount: 0,
    },
    quality: null,
  };
  return data;
}
test("18 pending runs interleave both conditions for every task/repeat; no fabricated results", () => {
  const data = createEvaluation();
  validateEvaluation(data);
  for (const task of TASKS)
    for (const condition of ["serial", "collaborative"])
      assert.equal(data.runs.filter((r) => r.task === task && r.condition === condition).length, 3);
  for (let i = 0; i < 18; i += 2)
    assert.notEqual(data.runs[i].condition, data.runs[i + 1].condition);
  const report = summarizeEvaluation(data);
  assert.equal(report.status, "incomplete");
  assert.equal(report.groups[0].metrics.elapsedSeconds.median, null);
});
test("failures and missing usage remain visible; known zero differs from unknown", () => {
  const data = recorded();
  const summary = summarizeEvaluation(data);
  assert.deepEqual(summary.protocol, data.protocol);
  assert.deepEqual(summary.tasks, data.tasks);
  assert.equal(summary.groups[0].counts.failed, 1);
  assert.deepEqual(summary.groups[0].metrics.elapsedSeconds, {
    known: 1,
    unknown: 2,
    median: 60,
    min: 60,
    max: 60,
  });
  assert.equal(summary.groups[0].metrics.inputTokens.median, null);
  assert.equal(summary.groups[0].metrics.outputTokens.median, 0);
  assert.equal(summary.groups[0].runs[0].observation.failures, "provider timeout");
  assert.equal(summary.status, "incomplete");
});
test("identity, registration, timings, usage, pricing and reviewer boundaries reject false records", () => {
  for (const corrupt of [
    (d) => d.runs.pop(),
    (d) => {
      d.runs[1].id = d.runs[0].id;
    },
    (d) => {
      d.protocol = null;
    },
    (d) => {
      d.runs[0].observation.metrics.inputTokens = -1;
    },
    (d) => {
      d.runs[0].observation.metrics.elapsedSeconds = 10;
    },
    (d) => {
      d.runs[0].observation.metrics.criticalPathSeconds = 61;
    },
    (d) => {
      d.runs[0].observation.metrics.money = 1;
    },
    (d) => {
      d.runs[0].observation.quality = {
        reviewerId: "author",
        rubricEvidence: "rubric",
        reviewEvidence: "review",
        limitations: "none",
        score: 80,
      };
    },
    (d) => {
      d.runs[0].status = "pending";
    },
  ]) {
    const data = recorded();
    corrupt(data);
    assert.throws(() => validateEvaluation(data));
  }
});
test("all measured values determine small sample medians/ranges, including failures", () => {
  const data = recorded();
  for (const [i, run] of data.runs.entries()) {
    run.status = i === 0 ? "failed" : "completed";
    run.observation = structuredClone(data.runs[0].observation);
    run.observation.metrics.inputTokens = i;
    run.observation.quality = {
      reviewerId: "independent",
      rubricEvidence: "rubric",
      reviewEvidence: "review",
      limitations: "fixture",
      score: 70,
    };
  }
  const summary = summarizeEvaluation(data);
  assert.equal(summary.status, "ready-for-human-review");
  assert.deepEqual(summary.groups[0].metrics.inputTokens, {
    known: 3,
    unknown: 0,
    median: 7,
    min: 0,
    max: 12,
  });
  data.runs[0].observation.metrics.money = 1;
  data.runs[0].observation.currency = "USD";
  data.runs[0].observation.pricingEvidence = "fixture";
  data.runs[7].observation.metrics.money = 2;
  data.runs[7].observation.currency = "CNY";
  data.runs[7].observation.pricingEvidence = "fixture";
  assert.match(summarizeEvaluation(data).groups[0].metrics.money.unavailable, /Mixed currencies/);
});
test("CLI persists blank records, reads them back, and never replaces source or existing evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "research-evaluation-"));
  const source = join(dir, "records.json"),
    output = join(dir, "summary.json");
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/research-evaluation.mjs", ...args], { encoding: "utf8" });
  assert.equal(run("init", source).status, 0);
  const bytes = await readFile(source, "utf8");
  assert.equal(run("init", source).status, 1);
  assert.equal(run("summarize", source, source).status, 1);
  assert.equal(await readFile(source, "utf8"), bytes);
  assert.equal(run("summarize", source, output).status, 0);
  assert.equal(JSON.parse(await readFile(output, "utf8")).status, "incomplete");
  await writeFile(join(dir, "bad.json"), "{bad");
  assert.equal(run("summarize", join(dir, "bad.json"), output).status, 1);
  assert.equal(await readFile(source, "utf8"), bytes);
});
