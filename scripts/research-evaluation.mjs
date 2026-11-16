import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TASKS = ["question-design", "literature-synthesis", "analysis-writing"];
const CONDITIONS = ["serial", "collaborative"];
const METRICS = [
  "elapsedSeconds",
  "criticalPathSeconds",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "money",
  "humanMinutes",
  "reworkCount",
];
const text = (v) => typeof v === "string" && v.trim().length > 0;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const requireThat = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** Preparation only: no provider, application state or research files are touched. */
export function createEvaluation() {
  const runs = [];
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (const [index, task] of TASKS.entries()) {
      const order = (repeat + index) % 2 ? CONDITIONS : [...CONDITIONS].reverse();
      for (const condition of order)
        runs.push({
          id: `${task}-${repeat}-${condition}`,
          order: runs.length + 1,
          task,
          repeat,
          condition,
          status: "pending",
          observation: null,
        });
    }
  }
  return {
    schemaVersion: 1,
    protocol: null,
    tasks: TASKS.map((task) => ({ task, registration: null })),
    runs,
  };
}

export function validateEvaluation(value) {
  requireThat(object(value) && value.schemaVersion === 1, "Unsupported evaluation schema");
  requireThat(
    Array.isArray(value.tasks) && value.tasks.length === 3,
    "Require three task registrations",
  );
  const expected = createEvaluation();
  requireThat(
    Array.isArray(value.runs) && value.runs.length === 18,
    "Keep all 18 planned runs, including failures",
  );
  for (const [index, task] of value.tasks.entries()) {
    requireThat(
      object(task) && task.task === TASKS[index],
      "Task registration order/identity changed",
    );
    if (task.registration !== null) {
      requireThat(object(task.registration), "Invalid task registration");
      for (const key of [
        "objective",
        "materialsManifest",
        "modelAssignments",
        "tools",
        "deliverables",
        "qualityRubric",
        "interventionRule",
        "stopRule",
      ])
        requireThat(text(task.registration[key]), `Missing registration ${task.task}.${key}`);
    }
  }
  if (value.protocol !== null) {
    requireThat(object(value.protocol), "Invalid protocol");
    for (const key of [
      "registeredAt",
      "operator",
      "budgetApproval",
      "budgetAndScale",
      "environment",
      "serialProcedure",
      "collaborativeProcedure",
      "cachePolicy",
      "reviewerIndependence",
    ])
      requireThat(text(value.protocol[key]), `Missing protocol ${key}`);
    requireThat(
      Number.isFinite(Date.parse(value.protocol.registeredAt)),
      "Invalid registration date",
    );
  }
  for (const [index, run] of value.runs.entries()) {
    const planned = expected.runs[index];
    requireThat(object(run), "Invalid run");
    for (const key of ["id", "order", "task", "repeat", "condition"])
      requireThat(
        run[key] === planned[key],
        `Planned identity/order changed: ${planned.id}.${key}`,
      );
    requireThat(
      ["pending", "completed", "failed", "aborted"].includes(run.status),
      `Invalid status ${run.id}`,
    );
    if (run.status === "pending") {
      requireThat(run.observation === null, `Pending run must not contain results: ${run.id}`);
      continue;
    }
    requireThat(
      value.protocol !== null && value.tasks.every((t) => t.registration !== null),
      "Register protocol and all tasks before recording runs",
    );
    const o = run.observation;
    requireThat(object(o), `Missing observation ${run.id}`);
    for (const key of [
      "projectId",
      "sessionEvidence",
      "timingEvidence",
      "usageEvidence",
      "cacheConditions",
      "interventions",
      "failures",
      "deviations",
      "resultEvidence",
      "unknownReasons",
    ])
      requireThat(text(o[key]), `Missing observation ${run.id}.${key}`);
    requireThat(
      Array.isArray(o.authorIds) && o.authorIds.length > 0 && o.authorIds.every(text),
      `Missing author identities ${run.id}`,
    );
    const start = typeof o.startedAt === "string" ? Date.parse(o.startedAt) : NaN;
    const end = typeof o.endedAt === "string" ? Date.parse(o.endedAt) : NaN;
    requireThat(
      Number.isFinite(start) &&
        Number.isFinite(end) &&
        end >= start &&
        start >= Date.parse(value.protocol.registeredAt),
      `Invalid run times ${run.id}`,
    );
    requireThat(object(o.metrics), `Missing metrics ${run.id}`);
    for (const key of METRICS) {
      const n = o.metrics[key];
      requireThat(
        n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0),
        `Invalid metric ${run.id}.${key}; unknown must be null`,
      );
      if (n !== null && (key.endsWith("Tokens") || key === "reworkCount"))
        requireThat(Number.isSafeInteger(n), `Count must be a safe integer ${run.id}.${key}`);
    }
    requireThat(
      o.metrics.elapsedSeconds === (end - start) / 1000,
      `Elapsed time must match timestamps ${run.id}`,
    );
    requireThat(
      o.metrics.criticalPathSeconds === null ||
        o.metrics.criticalPathSeconds <= o.metrics.elapsedSeconds,
      `Critical path exceeds elapsed time ${run.id}`,
    );
    if (o.metrics.money !== null)
      requireThat(
        text(o.currency) && text(o.pricingEvidence),
        `Money requires currency and pricing evidence ${run.id}`,
      );
    requireThat(o.quality === null || object(o.quality), `Invalid quality review ${run.id}`);
    if (o.quality !== null) {
      for (const key of ["reviewerId", "rubricEvidence", "reviewEvidence", "limitations"])
        requireThat(text(o.quality[key]), `Missing quality ${run.id}.${key}`);
      requireThat(
        !o.authorIds.includes(o.quality.reviewerId),
        `Reviewer participated as author ${run.id}`,
      );
      requireThat(
        Number.isFinite(o.quality.score) && o.quality.score >= 0 && o.quality.score <= 100,
        `Quality score must be 0–100 ${run.id}`,
      );
    }
  }
  return value;
}
function distribution(values) {
  const known = values.filter((n) => n !== null).sort((a, b) => a - b);
  const n = known.length;
  return {
    known: n,
    unknown: values.length - n,
    median: n ? (known[Math.floor((n - 1) / 2)] + known[Math.floor(n / 2)]) / 2 : null,
    min: n ? known[0] : null,
    max: n ? known[n - 1] : null,
  };
}
export function summarizeEvaluation(input) {
  const data = validateEvaluation(input);
  return {
    schemaVersion: 1,
    status: data.runs.every((r) => r.status !== "pending" && r.observation.quality !== null)
      ? "ready-for-human-review"
      : "incomplete",
    protocol: data.protocol,
    tasks: data.tasks,
    limitation:
      "Self-reported evidence pointers are not verified research results. Includes failed/aborted runs; null is unknown. No significance or speedup claim; human acceptance remains required.",
    groups: TASKS.flatMap((task) =>
      CONDITIONS.map((condition) => {
        const runs = data.runs.filter((r) => r.task === task && r.condition === condition);
        const observed = runs.filter((r) => r.status !== "pending");
        const currencies = new Set(
          observed
            .filter((r) => r.observation.metrics.money !== null)
            .map((r) => r.observation.currency),
        );
        return {
          task,
          condition,
          counts: Object.fromEntries(
            ["pending", "completed", "failed", "aborted"].map((status) => [
              status,
              runs.filter((r) => r.status === status).length,
            ]),
          ),
          metrics: Object.fromEntries(
            METRICS.map((key) => [
              key,
              key === "money" && currencies.size > 1
                ? { unavailable: "Mixed currencies; inspect individual runs" }
                : distribution(runs.map((r) => r.observation?.metrics[key] ?? null)),
            ]),
          ),
          quality: distribution(runs.map((r) => r.observation?.quality?.score ?? null)),
          moneyCurrency: currencies.size === 1 ? [...currencies][0] : null,
          runs,
        };
      }),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, source, destination, ...extra] = process.argv.slice(2);
    requireThat(extra.length === 0, "Unexpected arguments");
    if (command === "init" && source && !destination) {
      await writeFile(source, JSON.stringify(createEvaluation(), null, 2) + "\n", { flag: "wx" });
      console.log("Created 18 pending runs. No model requests made.");
    } else if (command === "summarize" && source && destination) {
      const summary = summarizeEvaluation(JSON.parse(await readFile(source, "utf8")));
      await writeFile(destination, JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
      console.log(summary.status);
    } else
      throw new Error(
        "Usage: node scripts/research-evaluation.mjs init NEW.json | summarize INPUT.json NEW-SUMMARY.json",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
