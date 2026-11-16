import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ResearchAnalysisSpec, ResearchDataset } from "../../contracts/research-evidence";
import {
  decodeRegisteredResearchAnalysisPlan,
  type RegisteredResearchAnalysisPlan,
  type RegisteredResearchAnalysisRun,
  type RegisteredResearchAnalysisReview,
  type ResearchAnalysisRegistry,
  type ResearchAnalysisSampleAudit,
} from "../../contracts/research-analysis-registry";
import { calculateResearchData, RESEARCH_ANALYSIS_ENGINE } from "./analysis";
import { parseResearchDelimitedText } from "./material-import";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => sha(JSON.stringify(value));
const intactRun = (run: RegisteredResearchAnalysisRun) => {
  const { runSha256, ...contents } = run;
  return digest(contents) === runSha256 && digest(run.result) === run.resultSha256;
};
const eventTimes = (registry: ResearchAnalysisRegistry) => [
  ...registry.plans.map((plan) => plan.registration.at),
  ...registry.runs.map((run) => run.at),
  ...registry.reviews.map((review) => review.at),
];
const missing = (value: string) => !value.trim() || /^(NA|N\/A|null)$/i.test(value.trim());
const latest = (registry: ResearchAnalysisRegistry, id: string) =>
  registry.plans.filter((plan) => plan.id === id).at(-1);

export function researchAnalysisCapability(plan: RegisteredResearchAnalysisPlan): {
  supported: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const methods = ["describe", "correlation", "ols"];
  if (!methods.includes(plan.method))
    reasons.push(`方法 ${plan.method} 需要方法扩展；不会改用另一种已支持方法。`);
  if (plan.method === "ols" && !plan.outcome) reasons.push("OLS 需要明确因变量。");
  if (plan.method !== "ols" && plan.outcome)
    reasons.push("非 OLS 方法请把变量明确列入 columns，不使用 outcome 隐式增加变量。");
  const policy = plan.method === "describe" ? "per-variable" : "complete-case";
  for (const [key, value] of Object.entries(plan.parameters)) {
    if (key === "missingPolicy" && value === policy) continue;
    if (key === "intercept" && plan.method === "ols" && value === true) continue;
    reasons.push(`参数 ${key}=${String(value)} 尚未由当前算法实现。`);
  }
  const outputs = new Set([
    "descriptive",
    "sample-accounting",
    ...(plan.method === "correlation" ? ["correlations"] : []),
    ...(plan.method === "ols"
      ? [
          "regression.coefficients",
          "regression.rSquared",
          "regression.residualDf",
          "regression.residualRmse",
          "regression.sampleSize",
        ]
      : []),
  ]);
  for (const output of plan.outputs)
    if (!outputs.has(output))
      reasons.push(`输出 ${output} 尚未支持；不提供 p 值、置信区间或显著性。`);
  return { supported: reasons.length === 0, reasons };
}

export function createResearchAnalysisRegistry(): ResearchAnalysisRegistry {
  return { version: 1, plans: [], runs: [], reviews: [] };
}

/** Append-only plan versions; callers keep the old single analysisPlan untouched. */
export function registerResearchAnalysisPlan(
  registry: ResearchAnalysisRegistry,
  input: RegisteredResearchAnalysisPlan,
): ResearchAnalysisRegistry {
  const plan = decodeRegisteredResearchAnalysisPlan(input);
  const duplicate = registry.plans.find(
    (entry) => entry.id === plan.id && entry.version === plan.version,
  );
  if (duplicate) {
    if (!duplicate.registration.observedPriorRunIds)
      throw new Error("已登记计划缺少在先运行见证；原记录保留，不能猜成事前登记。");
    plan.registration.observedPriorRunIds = [...duplicate.registration.observedPriorRunIds];
    if (!isDeepStrictEqual(duplicate, plan))
      throw new Error("已登记计划版本不可改写，请新增版本并说明变化。");
    return structuredClone(registry);
  }
  // A caller's claimed witness is not authority. Preserve the actual host order, including clock ties.
  plan.registration.observedPriorRunIds = registry.runs.map((run) => run.id);
  const previous = latest(registry, plan.id);
  if (plan.version !== (previous?.version ?? 0) + 1) throw new Error("计划版本必须连续递增。");
  const priorTimes = eventTimes(registry);
  if (priorTimes.some((at) => Date.parse(at) > Date.parse(plan.registration.at)))
    throw new Error("登记时间不能早于已记录事件，不能倒填事前计划。");
  if (registry.runs.length && plan.registration.timing === "prospective")
    throw new Error("已有实际结果后增加或修改计划须标为事后，不能重写为事前决定。");
  if (
    plan.compareWith &&
    !registry.plans.some(
      (entry) =>
        entry.id === plan.compareWith!.planId && entry.version === plan.compareWith!.planVersion,
    )
  )
    throw new Error("比较对象必须指向已登记的明确计划版本。");
  return { ...structuredClone(registry), plans: [...structuredClone(registry.plans), plan] };
}

/** Import provenance only: legacy timing and execution are not invented. */
export function registerLegacySingleAnalysisPlan(
  registry: ResearchAnalysisRegistry,
  spec: ResearchAnalysisSpec,
  metadata: { id: string; observedAt: string; sourceRef: string; datasetSha256?: string },
): ResearchAnalysisRegistry {
  return registerResearchAnalysisPlan(registry, {
    id: metadata.id,
    version: 1,
    label: "旧单项分析计划",
    purpose: "primary",
    objective: "保留旧 analysisPlan 的原始方法与变量，登记时点不代表事前承诺。",
    dataset: {
      id: spec.datasetId,
      ...(metadata.datasetSha256 ? { sha256: metadata.datasetSha256 } : {}),
    },
    method: spec.method,
    columns: [...spec.columns],
    ...(spec.outcome ? { outcome: spec.outcome } : {}),
    parameters: {},
    outputs:
      spec.method === "ols"
        ? ["regression.coefficients", "regression.rSquared"]
        : spec.method === "correlation"
          ? ["correlations"]
          : ["descriptive"],
    reviewPlan: "实际执行、样本与独立核验仍待另行登记。",
    registration: {
      at: metadata.observedAt,
      timing: "legacy-unknown",
      reason: "导入旧单项计划；原始登记时间与审阅状态未知。",
      sourceRef: metadata.sourceRef,
    },
    sample: { mode: "all" },
  });
}

function prepareInput(
  csv: string,
  delimiter: ResearchDataset["delimiter"],
  plan: RegisteredResearchAnalysisPlan,
): { csv: string; audit: ResearchAnalysisSampleAudit } {
  if (![",", ";", "\t"].includes(delimiter) || Buffer.byteLength(csv) > 10_000_000)
    throw new Error("分析输入分隔符无效或超过 10 MB。");
  const { rows, lines } = parseResearchDelimitedText(csv.replace(/^\uFEFF/, ""), delimiter);
  const header = rows[0]?.map((value) => value.trim());
  if (
    !header?.length ||
    header.length > 200 ||
    header.some((value) => !value) ||
    new Set(header).size !== header.length ||
    rows.length < 2 ||
    rows.length > 50_001
  )
    throw new Error("分析需要首行唯一列名及 1–50000 个原始数据记录。");
  const variables = [...plan.columns, ...(plan.outcome ? [plan.outcome] : [])];
  if (variables.some((name) => !header.includes(name))) throw new Error("分析变量不在数据表中。");
  const records = rows.slice(1).map((cells, index) => ({ cells, sourceLine: lines[index + 1]! }));
  const allBlank = (cells: string[]) => cells.every((value) => !value.trim());
  if (records.some((record) => !allBlank(record.cells) && record.cells.length !== header.length))
    throw new Error("原始数据存在不完整行，不能通过样本选择静默丢弃。");
  const selectedLines =
    plan.sample.mode === "selected-rows" ? new Set(plan.sample.sourceLines) : undefined;
  if (
    selectedLines &&
    [...selectedLines].some(
      (line) => !records.some((record) => record.sourceLine === line && !allBlank(record.cells)),
    )
  )
    throw new Error("样本定位不存在、指向空记录或位于多行字段内部。");
  const audit: ResearchAnalysisSampleAudit = {
    originalDataRows: records.length,
    selectedSourceLines: [],
    completeSourceLines: [],
    perVariableSourceLines: Object.fromEntries(variables.map((name) => [name, []])),
    excluded: [],
    missing: [],
    policy: plan.method === "describe" ? "per-variable" : "complete-case",
    label: selectedLines ? "explicit-derived-sample" : "original-all-records",
  };
  const selected: string[][] = [];
  for (const record of records) {
    if (allBlank(record.cells)) {
      audit.excluded.push({ sourceLine: record.sourceLine, reason: "empty-record", columns: [] });
      continue;
    }
    if (selectedLines && !selectedLines.has(record.sourceLine)) {
      audit.excluded.push({ sourceLine: record.sourceLine, reason: "not-selected", columns: [] });
      continue;
    }
    selected.push(record.cells);
    audit.selectedSourceLines.push(record.sourceLine);
    const absent = variables.filter((name) => missing(record.cells[header.indexOf(name)]!));
    for (const name of variables)
      if (!absent.includes(name)) audit.perVariableSourceLines[name]!.push(record.sourceLine);
    if (absent.length) {
      audit.missing.push({ sourceLine: record.sourceLine, columns: absent });
      if (audit.policy === "complete-case")
        audit.excluded.push({
          sourceLine: record.sourceLine,
          reason: "missing-values",
          columns: absent,
        });
    } else audit.completeSourceLines.push(record.sourceLine);
  }
  if (!selected.length) throw new Error("没有实际选中的数据记录。");
  const cell = (value: string) =>
    value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return {
    csv: [header, ...selected].map((row) => row.map(cell).join(delimiter)).join("\n") + "\n",
    audit,
  };
}

export interface ExecuteRegisteredResearchAnalysis {
  id: string;
  planId: string;
  planVersion: number;
  at: string;
  actor: string;
  dataset: Pick<ResearchDataset, "id" | "sha256" | "delimiter">;
  csv: string;
  replayOf?: string;
}

/** Pure actual computation using the existing engine; original CSV and dataset registration are never edited. */
export function executeRegisteredResearchAnalysis(
  registry: ResearchAnalysisRegistry,
  input: ExecuteRegisteredResearchAnalysis,
): {
  registry: ResearchAnalysisRegistry;
  run: RegisteredResearchAnalysisRun;
  calculationInput: string;
} {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(input.id) ||
    !input.actor?.trim() ||
    !Number.isFinite(Date.parse(input.at))
  )
    throw new Error("实际执行需要有效身份、执行者与时间。");
  if (registry.runs.some((run) => run.id === input.id))
    throw new Error("执行身份已存在；复跑使用新身份并引用原运行。");
  const plan = registry.plans.find(
    (entry) => entry.id === input.planId && entry.version === input.planVersion,
  );
  if (!plan) throw new Error("未登记此分析或计划版本。");
  if (
    Date.parse(input.at) < Date.parse(plan.registration.at) ||
    eventTimes(registry).some((at) => Date.parse(at) > Date.parse(input.at))
  )
    throw new Error("实际执行时间不能早于登记或已记录执行。");
  if (!input.replayOf && latest(registry, plan.id)?.version !== plan.version)
    throw new Error("旧计划版本只能明确复跑，不能冒充当前执行。");
  const capability = researchAnalysisCapability(plan);
  if (!capability.supported) throw new Error(`需要方法扩展：${capability.reasons.join("；")}`);
  if (!plan.dataset.sha256) throw new Error("计划尚未锁定实际数据摘要，不能登记实算完成。");
  if (
    input.dataset.id !== plan.dataset.id ||
    input.dataset.sha256 !== plan.dataset.sha256 ||
    sha(input.csv) !== plan.dataset.sha256
  )
    throw new Error("实际数据身份或原始字节摘要不符，停止执行。");
  const original = input.replayOf
    ? registry.runs.find((run) => run.id === input.replayOf)
    : undefined;
  if (
    input.replayOf &&
    (!original ||
      !intactRun(original) ||
      original.planId !== plan.id ||
      original.planVersion !== plan.version ||
      original.engine !== RESEARCH_ANALYSIS_ENGINE ||
      original.replay.planSha256 !== digest(plan))
  )
    throw new Error("复跑必须引用同一计划与算法版本的实际运行。");
  const prepared = prepareInput(input.csv, input.dataset.delimiter, plan);
  const spec: ResearchAnalysisSpec = {
    datasetId: plan.dataset.id,
    method: plan.method as ResearchAnalysisSpec["method"],
    columns: [...plan.columns],
    ...(plan.outcome ? { outcome: plan.outcome } : {}),
  };
  const result = calculateResearchData(prepared.csv, input.dataset.delimiter, spec);
  if (
    result.totalRows !== prepared.audit.selectedSourceLines.length ||
    result.completeRows !== prepared.audit.completeSourceLines.length
  )
    throw new Error("样本登记与既有算法的实际纳入不一致，停止记录结果。");
  const resultSha256 = digest(result);
  const contents: Omit<RegisteredResearchAnalysisRun, "runSha256"> = {
    id: input.id,
    planId: plan.id,
    planVersion: plan.version,
    at: input.at,
    actor: input.actor,
    datasetId: input.dataset.id,
    datasetSha256: input.dataset.sha256,
    engine: RESEARCH_ANALYSIS_ENGINE,
    adapter: "analysis-registry-1",
    spec,
    parameters: {
      ...plan.parameters,
      missingPolicy: prepared.audit.policy,
      ...(plan.method === "ols" ? { intercept: true } : {}),
    },
    calculationInputSha256: sha(prepared.csv),
    sample: prepared.audit,
    result,
    resultSha256,
    replay: {
      dataset: {
        id: input.dataset.id,
        sha256: input.dataset.sha256,
        delimiter: input.dataset.delimiter,
      },
      sample: structuredClone(plan.sample),
      planSha256: digest(plan),
    },
    verification: original
      ? {
          level: "same-engine-replay",
          replayOf: original.id,
          matches:
            original.resultSha256 === resultSha256 &&
            original.calculationInputSha256 === sha(prepared.csv) &&
            digest(original.sample) === digest(prepared.audit),
        }
      : { level: "unreviewed" },
  };
  const run: RegisteredResearchAnalysisRun = { ...contents, runSha256: digest(contents) };
  return {
    registry: { ...structuredClone(registry), runs: [...structuredClone(registry.runs), run] },
    run: structuredClone(run),
    calculationInput: prepared.csv,
  };
}

export function compareRegisteredAnalysisSamples(
  left: RegisteredResearchAnalysisRun,
  right: RegisteredResearchAnalysisRun,
): { comparable: boolean; reason: string } {
  if (!intactRun(left) || !intactRun(right))
    return { comparable: false, reason: "执行记录或样本摘要已变化，不能采用该比较。" };
  if (left.datasetSha256 !== right.datasetSha256 || left.datasetId !== right.datasetId)
    return { comparable: false, reason: "原始数据版本或身份不同，不能声称同一样本。" };
  if (left.sample.policy !== "complete-case" || right.sample.policy !== "complete-case")
    return {
      comparable: false,
      reason: "逐变量描述样本不同于一个完整案例模型样本，请逐字段核对。",
    };
  const same = digest(left.sample.completeSourceLines) === digest(right.sample.completeSourceLines);
  return {
    comparable: same,
    reason: same
      ? "两次模型实际纳入相同原始记录；不因此证明方法、假设或结论有效。"
      : "变量缺失或显式选择导致实际样本不同，不能当作同样本模型比较。",
  };
}

export function researchAnalysisRegistryReport(
  registry: ResearchAnalysisRegistry,
  currentDatasets: readonly { id: string; sha256: string }[],
) {
  return registry.plans
    .filter((plan) => latest(registry, plan.id) === plan)
    .map((plan) => {
      const capability = researchAnalysisCapability(plan);
      const runs = registry.runs.filter(
        (run) => run.planId === plan.id && run.planVersion === plan.version,
      );
      const current = runs.filter(
        (run) =>
          run.engine === RESEARCH_ANALYSIS_ENGINE &&
          intactRun(run) &&
          run.replay.planSha256 === digest(plan) &&
          currentDatasets.some(
            (dataset) => dataset.id === run.datasetId && dataset.sha256 === run.datasetSha256,
          ),
      );
      const state = !capability.supported
        ? "needs-method-extension"
        : current.length
          ? "executed"
          : runs.length
            ? "stale"
            : "not-executed";
      let comparison: { comparable: boolean; reason: string } | undefined;
      if (plan.compareWith?.requireSameSample) {
        const other = registry.runs
          .filter(
            (run) =>
              run.planId === plan.compareWith!.planId &&
              run.planVersion === plan.compareWith!.planVersion,
          )
          .at(-1);
        comparison =
          current.length && other
            ? compareRegisteredAnalysisSamples(other, current.at(-1)!)
            : { comparable: false, reason: "比较所需的两个实际运行尚未齐备。" };
      }
      return {
        planId: plan.id,
        planVersion: plan.version,
        state,
        reasons: capability.reasons,
        runIds: current.map((run) => run.id),
        timing: plan.registration.timing,
        ...(comparison ? { comparison } : {}),
        verification: current.at(-1)?.verification.level ?? "unreviewed",
        reviews: registry.reviews.filter(
          (review) =>
            review.planId === plan.id &&
            review.planVersion === plan.version &&
            (!review.runId || current.some((run) => run.id === review.runId)),
        ),
      };
    });
}

/** Records actual reviewer attribution; it does not infer review from successful computation. */
export function recordRegisteredAnalysisReview(
  registry: ResearchAnalysisRegistry,
  review: RegisteredResearchAnalysisReview,
): ResearchAnalysisRegistry {
  if (
    !review ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(review.id) ||
    !["plan-review", "interpretation-review"].includes(review.kind) ||
    !["accept", "revise", "hold"].includes(review.verdict) ||
    !Number.isFinite(Date.parse(review.at)) ||
    [review.actor, review.evidenceRef, review.note].some(
      (value) => typeof value !== "string" || !value.trim() || value.length > 6000,
    )
  )
    throw new Error("审阅需要有效身份、实际出处、时间、意见与结论。");
  const existing = registry.reviews.find((entry) => entry.id === review.id);
  if (existing) {
    if (digest(existing) !== digest(review)) throw new Error("已登记审阅不可改写。");
    return structuredClone(registry);
  }
  if (
    !registry.plans.some(
      (plan) => plan.id === review.planId && plan.version === review.planVersion,
    ) ||
    eventTimes(registry).some((at) => Date.parse(at) > Date.parse(review.at))
  )
    throw new Error("审阅计划版本不存在或时间早于已记录事件。");
  const run = registry.runs.find((entry) => entry.id === review.runId);
  if (
    (review.kind === "interpretation-review" && !review.runId) ||
    (review.runId &&
      (!run ||
        !intactRun(run) ||
        run.planId !== review.planId ||
        run.planVersion !== review.planVersion))
  )
    throw new Error("解释审阅必须指向该计划版本的完整实际结果。");
  return {
    ...structuredClone(registry),
    reviews: [...structuredClone(registry.reviews), structuredClone(review)],
  };
}

/** Explicit claim anchors only; free-text statistical promises still require content review. */
export function auditResearchAnalysisPromises(
  registry: ResearchAnalysisRegistry,
  claims: readonly { locator: string; planId: string }[],
  currentDatasets: readonly { id: string; sha256: string }[],
) {
  const report = researchAnalysisRegistryReport(registry, currentDatasets);
  return claims.map((claim) => ({
    ...claim,
    state: report.find((item) => item.planId === claim.planId)?.state ?? "not-registered",
  }));
}

function requireRegistry(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`分析登记保存记录无效：${detail}；原记录保留。`);
}
function savedObject(value: unknown, allowed: string[], name: string): Record<string, unknown> {
  const prototype: unknown =
    value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  requireRegistry(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (prototype === Object.prototype || prototype === null) &&
      Object.keys(value).every((key) => allowed.includes(key)),
    `${name}字段`,
  );
  return value as Record<string, unknown>;
}
const savedId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const savedHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const savedText = (value: unknown, limit = 6000) =>
  typeof value === "string" && !!value.trim() && value.length <= limit;
const savedTime = (value: unknown) =>
  typeof value === "string" && value.length <= 100 && Number.isFinite(Date.parse(value));
function savedLines(value: unknown, name: string): number[] {
  requireRegistry(
    Array.isArray(value) &&
      value.length <= 50_000 &&
      value.every(
        (line, i) => Number.isSafeInteger(line) && line >= 2 && (i === 0 || line > value[i - 1]),
      ),
    `${name}必须为递增唯一原始行定位`,
  );
  return value as number[];
}
function exactKeys(record: Record<string, unknown>, keys: string[], name: string): void {
  requireRegistry(
    isDeepStrictEqual(Object.keys(record).sort(), [...keys].sort()),
    `${name}变量或字段不匹配`,
  );
}

function validateSavedSample(
  value: unknown,
  plan: RegisteredResearchAnalysisPlan,
): ResearchAnalysisSampleAudit {
  const raw = savedObject(
    value,
    [
      "originalDataRows",
      "selectedSourceLines",
      "completeSourceLines",
      "perVariableSourceLines",
      "excluded",
      "missing",
      "policy",
      "label",
    ],
    "样本",
  );
  requireRegistry(
    Number.isSafeInteger(raw.originalDataRows) &&
      Number(raw.originalDataRows) > 0 &&
      Number(raw.originalDataRows) <= 50_000,
    "原始记录数",
  );
  const variables = [...plan.columns, ...(plan.outcome ? [plan.outcome] : [])];
  const selected = savedLines(raw.selectedSourceLines, "选择样本"),
    complete = savedLines(raw.completeSourceLines, "完整案例");
  requireRegistry(selected.length > 0, "实际样本为空");
  const selectedSet = new Set(selected);
  const perVariable = savedObject(raw.perVariableSourceLines, variables, "逐变量样本");
  exactKeys(perVariable, variables, "逐变量样本");
  const policy = plan.method === "describe" ? "per-variable" : "complete-case";
  requireRegistry(
    raw.policy === policy &&
      raw.label ===
        (plan.sample.mode === "all" ? "original-all-records" : "explicit-derived-sample"),
    "样本策略与计划不符",
  );
  if (plan.sample.mode === "selected-rows")
    requireRegistry(
      isDeepStrictEqual(
        selected,
        [...plan.sample.sourceLines].sort((a, b) => a - b),
      ),
      "显式选择与实际样本不符",
    );
  requireRegistry(Array.isArray(raw.missing) && raw.missing.length <= selected.length, "缺失记录");
  const absent = new Map<number, string[]>();
  for (const item of raw.missing) {
    const entry = savedObject(item, ["sourceLine", "columns"], "缺失项");
    requireRegistry(
      typeof entry.sourceLine === "number" &&
        selectedSet.has(entry.sourceLine) &&
        !absent.has(entry.sourceLine) &&
        Array.isArray(entry.columns) &&
        entry.columns.length > 0 &&
        entry.columns.every(
          (column: unknown) => typeof column === "string" && variables.includes(column),
        ) &&
        new Set(entry.columns).size === entry.columns.length,
      "缺失行或变量引用",
    );
    absent.set(entry.sourceLine, entry.columns as string[]);
  }
  requireRegistry(
    isDeepStrictEqual(
      complete,
      selected.filter((line) => !absent.has(line)),
    ),
    "完整案例与缺失记录矛盾",
  );
  for (const name of variables)
    requireRegistry(
      isDeepStrictEqual(
        savedLines(perVariable[name], `变量 ${name}`),
        selected.filter((line) => !absent.get(line)?.includes(name)),
      ),
      "逐变量纳入与缺失记录矛盾",
    );
  requireRegistry(Array.isArray(raw.excluded) && raw.excluded.length <= 50_000, "排除记录");
  const outside = new Set<number>(),
    missingExcluded = new Set<number>();
  for (const item of raw.excluded) {
    const entry = savedObject(item, ["sourceLine", "reason", "columns"], "排除项");
    requireRegistry(
      Number.isSafeInteger(entry.sourceLine) &&
        Number(entry.sourceLine) >= 2 &&
        Array.isArray(entry.columns),
      "排除行定位",
    );
    const line = Number(entry.sourceLine);
    if (entry.reason === "missing-values") {
      requireRegistry(
        policy === "complete-case" &&
          absent.has(line) &&
          !missingExcluded.has(line) &&
          isDeepStrictEqual(entry.columns, absent.get(line)),
        "缺失排除与实际缺失矛盾",
      );
      missingExcluded.add(line);
    } else {
      requireRegistry(
        ["empty-record", "not-selected"].includes(String(entry.reason)) &&
          entry.columns.length === 0 &&
          !selectedSet.has(line) &&
          !outside.has(line) &&
          (entry.reason !== "not-selected" || plan.sample.mode === "selected-rows"),
        "非纳入样本排除记录",
      );
      outside.add(line);
    }
  }
  requireRegistry(
    selected.length + outside.size === raw.originalDataRows &&
      missingExcluded.size === (policy === "complete-case" ? absent.size : 0),
    "原始、纳入与排除数量不闭合",
  );
  return value as ResearchAnalysisSampleAudit;
}

function validateSavedResult(
  value: unknown,
  plan: RegisteredResearchAnalysisPlan,
  sample: ResearchAnalysisSampleAudit,
): void {
  const method = plan.method;
  const result = savedObject(
    value,
    [
      "method",
      "totalRows",
      "completeRows",
      "excludedRows",
      "descriptive",
      "notes",
      ...(method === "ols" ? ["regression"] : method === "correlation" ? ["correlations"] : []),
    ],
    "计算结果",
  );
  requireRegistry(
    result.method === method &&
      result.totalRows === sample.selectedSourceLines.length &&
      result.completeRows === sample.completeSourceLines.length &&
      result.excludedRows ===
        sample.selectedSourceLines.length - sample.completeSourceLines.length &&
      Array.isArray(result.notes) &&
      result.notes.length <= 100 &&
      result.notes.every((note) => savedText(note)),
    "结果方法、样本数量或说明",
  );
  const variables = [...plan.columns, ...(plan.outcome ? [plan.outcome] : [])];
  const descriptive = savedObject(result.descriptive, variables, "描述结果");
  exactKeys(descriptive, variables, "描述结果");
  for (const variable of variables) {
    const stats = savedObject(
      descriptive[variable],
      ["n", "missing", "mean", "sd", "median", "min", "max"],
      "描述统计",
    );
    exactKeys(stats, ["n", "missing", "mean", "sd", "median", "min", "max"], "描述统计");
    const n = sample.perVariableSourceLines[variable]!.length;
    requireRegistry(
      stats.n === n && stats.missing === sample.selectedSourceLines.length - n,
      "描述统计样本数",
    );
    for (const field of ["mean", "median", "min", "max", "sd"])
      requireRegistry(
        n === 0 || (field === "sd" && n === 1)
          ? stats[field] === null
          : typeof stats[field] === "number" && Number.isFinite(stats[field]),
        "描述统计数值字段",
      );
    requireRegistry(stats.sd === null || Number(stats.sd) >= 0, "标准差");
  }
  if (method === "correlation") {
    requireRegistry(sample.completeSourceLines.length >= 3, "相关实际完整案例数");
    const matrix = savedObject(result.correlations, variables, "相关矩阵");
    exactKeys(matrix, variables, "相关矩阵");
    for (const name of variables) {
      const row = savedObject(matrix[name], variables, "相关矩阵行");
      exactKeys(row, variables, "相关矩阵行");
      requireRegistry(
        Object.values(row).every(
          (number) =>
            number === null ||
            (typeof number === "number" && Number.isFinite(number) && number >= -1 && number <= 1),
        ),
        "相关系数范围",
      );
    }
  }
  if (method === "ols") {
    const regression = savedObject(
      result.regression,
      ["outcome", "coefficients", "rSquared", "residualDf", "residualRmse", "sampleSize"],
      "OLS结果",
    );
    exactKeys(
      regression,
      ["outcome", "coefficients", "rSquared", "residualDf", "residualRmse", "sampleSize"],
      "OLS结果",
    );
    const coefficients = savedObject(
      regression.coefficients,
      ["intercept", ...plan.columns],
      "回归系数",
    );
    exactKeys(coefficients, ["intercept", ...plan.columns], "回归系数");
    const df = sample.completeSourceLines.length - plan.columns.length - 1;
    requireRegistry(
      Object.values(coefficients).every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ) &&
        regression.outcome === plan.outcome &&
        regression.sampleSize === sample.completeSourceLines.length &&
        df > 0 &&
        regression.residualDf === df &&
        typeof regression.residualRmse === "number" &&
        Number.isFinite(regression.residualRmse) &&
        regression.residualRmse >= 0 &&
        (regression.rSquared === null ||
          (typeof regression.rSquared === "number" && Number.isFinite(regression.rSquared))),
      "OLS字段或样本自由度",
    );
  }
}

/** Persistence boundary: validate stored digests and references without repairing or recomputing them. */
export function decodeResearchAnalysisRegistry(value: unknown): ResearchAnalysisRegistry {
  const raw = savedObject(value, ["version", "plans", "runs", "reviews"], "注册表");
  requireRegistry(
    raw.version === 1 &&
      Array.isArray(raw.plans) &&
      raw.plans.length <= 1000 &&
      Array.isArray(raw.runs) &&
      raw.runs.length <= 10_000 &&
      Array.isArray(raw.reviews) &&
      raw.reviews.length <= 10_000,
    "注册表版本或集合",
  );
  const plans: RegisteredResearchAnalysisPlan[] = [];
  for (const item of raw.plans) {
    const plan = decodeRegisteredResearchAnalysisPlan(item);
    const previous = plans.filter((entry) => entry.id === plan.id).at(-1);
    requireRegistry(
      plan.version === (previous?.version ?? 0) + 1 &&
        (!plans.length ||
          Date.parse(plan.registration.at) >= Date.parse(plans.at(-1)!.registration.at)),
      "计划版本重复、缺号或时间倒退",
    );
    if (plan.compareWith)
      requireRegistry(
        plans.some(
          (entry) =>
            entry.id === plan.compareWith!.planId &&
            entry.version === plan.compareWith!.planVersion,
        ),
        "比较计划断引用",
      );
    plans.push(plan);
  }
  const runs: RegisteredResearchAnalysisRun[] = [];
  for (const item of raw.runs) {
    const run = savedObject(
      item,
      [
        "id",
        "planId",
        "planVersion",
        "at",
        "actor",
        "datasetId",
        "datasetSha256",
        "engine",
        "adapter",
        "spec",
        "parameters",
        "calculationInputSha256",
        "sample",
        "result",
        "resultSha256",
        "runSha256",
        "replay",
        "verification",
      ],
      "运行",
    );
    requireRegistry(
      savedId(run.id) &&
        !runs.some((entry) => entry.id === run.id) &&
        savedId(run.planId) &&
        Number.isSafeInteger(run.planVersion) &&
        savedTime(run.at) &&
        savedText(run.actor) &&
        savedText(run.engine, 128) &&
        run.adapter === "analysis-registry-1" &&
        [run.datasetSha256, run.calculationInputSha256, run.resultSha256, run.runSha256].every(
          savedHash,
        ),
      "运行身份、时间或摘要",
    );
    const plan = plans.find(
      (entry) => entry.id === run.planId && entry.version === run.planVersion,
    );
    requireRegistry(
      plan &&
        researchAnalysisCapability(plan).supported &&
        plan.dataset.sha256 &&
        run.datasetId === plan.dataset.id &&
        run.datasetSha256 === plan.dataset.sha256 &&
        Date.parse(String(run.at)) >= Date.parse(plan.registration.at) &&
        (!runs.length || Date.parse(String(run.at)) >= Date.parse(runs.at(-1)!.at)),
      "运行计划、数据或时间引用",
    );
    const spec = savedObject(run.spec, ["datasetId", "method", "columns", "outcome"], "执行spec");
    requireRegistry(
      isDeepStrictEqual(spec, {
        datasetId: plan.dataset.id,
        method: plan.method,
        columns: plan.columns,
        ...(plan.outcome ? { outcome: plan.outcome } : {}),
      }),
      "spec与登记计划不符",
    );
    const sample = validateSavedSample(run.sample, plan);
    requireRegistry(
      isDeepStrictEqual(run.parameters, {
        ...plan.parameters,
        missingPolicy: sample.policy,
        ...(plan.method === "ols" ? { intercept: true } : {}),
      }),
      "实际参数与登记计划不符",
    );
    validateSavedResult(run.result, plan, sample);
    const replay = savedObject(run.replay, ["dataset", "sample", "planSha256"], "复跑输入");
    const dataset = savedObject(replay.dataset, ["id", "sha256", "delimiter"], "复跑数据");
    requireRegistry(
      dataset.id === plan.dataset.id &&
        dataset.sha256 === plan.dataset.sha256 &&
        [",", ";", "\t"].includes(String(dataset.delimiter)) &&
        replay.planSha256 === digest(plan) &&
        isDeepStrictEqual(replay.sample, plan.sample),
      "复跑数据、样本或计划摘要",
    );
    const verification = savedObject(
      run.verification,
      ["level", "replayOf", "matches"],
      "复核身份",
    );
    if (verification.level === "unreviewed") exactKeys(verification, ["level"], "未审阅身份");
    else {
      requireRegistry(
        verification.level === "same-engine-replay" &&
          typeof verification.matches === "boolean" &&
          savedId(verification.replayOf),
        "复跑复核字段",
      );
      const original = runs.find((entry) => entry.id === verification.replayOf);
      requireRegistry(
        original &&
          original.planId === run.planId &&
          original.planVersion === run.planVersion &&
          original.engine === run.engine &&
          original.adapter === run.adapter &&
          isDeepStrictEqual(original.replay, replay),
        "复跑记录断引用或跨算法／样本",
      );
      const matches =
        original.resultSha256 === run.resultSha256 &&
        original.calculationInputSha256 === run.calculationInputSha256 &&
        isDeepStrictEqual(original.sample, sample);
      requireRegistry(verification.matches === matches, "复跑一致性声明与保存结果矛盾");
    }
    requireRegistry(intactRun(item as RegisteredResearchAnalysisRun), "实际结果或整份运行摘要不符");
    runs.push(item as RegisteredResearchAnalysisRun);
  }
  let previousObservedCount = 0;
  for (const [planIndex, plan] of plans.entries()) {
    const observed = plan.registration.observedPriorRunIds;
    requireRegistry(
      observed !== undefined,
      "计划缺少在先运行见证，旧记录原样保留；不能推断事前登记",
    );
    requireRegistry(
      observed.length >= previousObservedCount &&
        isDeepStrictEqual(
          observed,
          runs.slice(0, observed.length).map((run) => run.id),
        ) &&
        runs
          .slice(0, observed.length)
          .every(
            (run) =>
              Date.parse(run.at) <= Date.parse(plan.registration.at) &&
              plans
                .slice(0, planIndex)
                .some((prior) => prior.id === run.planId && prior.version === run.planVersion),
          ) &&
        runs.every(
          (run) =>
            Date.parse(run.at) >= Date.parse(plan.registration.at) || observed.includes(run.id),
        ),
      "在先运行见证不是实际前缀、含未来运行或遗漏更早运行",
    );
    requireRegistry(
      plan.registration.timing !== "prospective" || observed.length === 0,
      "结果后登记伪称事前计划",
    );
    previousObservedCount = observed.length;
  }
  const reviews: RegisteredResearchAnalysisReview[] = [];
  for (const item of raw.reviews) {
    const review = savedObject(
      item,
      [
        "id",
        "planId",
        "planVersion",
        "runId",
        "kind",
        "at",
        "actor",
        "verdict",
        "evidenceRef",
        "note",
      ],
      "审阅",
    );
    requireRegistry(
      savedId(review.id) &&
        !reviews.some((entry) => entry.id === review.id) &&
        savedTime(review.at) &&
        [review.actor, review.evidenceRef, review.note].every((value) => savedText(value)) &&
        ["plan-review", "interpretation-review"].includes(String(review.kind)) &&
        ["accept", "revise", "hold"].includes(String(review.verdict)),
      "审阅身份或意见",
    );
    const plan = plans.find(
      (entry) => entry.id === review.planId && entry.version === review.planVersion,
    );
    requireRegistry(
      plan &&
        Date.parse(String(review.at)) >= Date.parse(plan.registration.at) &&
        (!reviews.length || Date.parse(String(review.at)) >= Date.parse(reviews.at(-1)!.at)),
      "审阅计划断引用或时间倒退",
    );
    if (review.runId !== undefined || review.kind === "interpretation-review") {
      const run = runs.find((entry) => entry.id === review.runId);
      requireRegistry(
        savedId(review.runId) &&
          run &&
          run.planId === review.planId &&
          run.planVersion === review.planVersion &&
          Date.parse(String(review.at)) >= Date.parse(run.at),
        "审阅实际运行断引用",
      );
    }
    reviews.push(item as RegisteredResearchAnalysisReview);
  }
  return structuredClone({ version: 1, plans, runs, reviews });
}
