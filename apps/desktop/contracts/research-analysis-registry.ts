import type { ResearchAnalysisSpec, ResearchDataset } from "./research-evidence";

export interface RegisteredResearchAnalysisPlan {
  id: string;
  version: number;
  label: string;
  purpose: "primary" | "comparison" | "descriptive" | "supplementary" | "exploratory";
  objective: string;
  dataset: { id: string; sha256?: string };
  /** Unsupported names remain registered, but are never substituted with OLS. */
  method: string;
  columns: string[];
  outcome?: string;
  parameters: Record<string, string | number | boolean | null>;
  outputs: string[];
  reviewPlan: string;
  registration: {
    at: string;
    timing: "prospective" | "post-hoc" | "legacy-unknown";
    reason: string;
    sourceRef: string;
    /** Input-compatible only; register derives this ordered run prefix from host state. */
    observedPriorRunIds?: string[];
  };
  sample:
    { mode: "all" } | { mode: "selected-rows"; id: string; sourceLines: number[]; reason: string };
  compareWith?: { planId: string; planVersion: number; requireSameSample: boolean };
}

export interface ResearchAnalysisSampleAudit {
  originalDataRows: number;
  /** Physical start lines in the original CSV, including quoted multiline records. */
  selectedSourceLines: number[];
  completeSourceLines: number[];
  perVariableSourceLines: Record<string, number[]>;
  excluded: {
    sourceLine: number;
    reason: "empty-record" | "not-selected" | "missing-values";
    columns: string[];
  }[];
  missing: { sourceLine: number; columns: string[] }[];
  policy: "per-variable" | "complete-case";
  label: "original-all-records" | "explicit-derived-sample";
}

export interface RegisteredResearchAnalysisRun {
  id: string;
  planId: string;
  planVersion: number;
  at: string;
  actor: string;
  datasetId: string;
  datasetSha256: string;
  engine: string;
  adapter: "analysis-registry-1";
  spec: ResearchAnalysisSpec;
  parameters: RegisteredResearchAnalysisPlan["parameters"];
  calculationInputSha256: string;
  sample: ResearchAnalysisSampleAudit;
  result: Record<string, unknown>;
  resultSha256: string;
  runSha256: string;
  /** Pins enough to reconstruct the working input from the immutable original bytes. */
  replay: {
    dataset: Pick<ResearchDataset, "id" | "sha256" | "delimiter">;
    sample: RegisteredResearchAnalysisPlan["sample"];
    planSha256: string;
  };
  verification:
    { level: "unreviewed" } | { level: "same-engine-replay"; replayOf: string; matches: boolean };
}

export interface ResearchAnalysisRegistry {
  version: 1;
  plans: RegisteredResearchAnalysisPlan[];
  runs: RegisteredResearchAnalysisRun[];
  reviews: RegisteredResearchAnalysisReview[];
}

/** A recorded review identity is separate from computation and same-engine replay. */
export interface RegisteredResearchAnalysisReview {
  id: string;
  planId: string;
  planVersion: number;
  runId?: string;
  kind: "plan-review" | "interpretation-review";
  at: string;
  actor: string;
  verdict: "accept" | "revise" | "hold";
  evidenceRef: string;
  note: string;
}

const text = (value: unknown, limit = 6000): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= limit;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const fields = (value: unknown, allowed: string[]): boolean =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
export function decodeRegisteredResearchAnalysisPlan(
  value: unknown,
): RegisteredResearchAnalysisPlan {
  const p = value as RegisteredResearchAnalysisPlan;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some(
      (key) =>
        ![
          "id",
          "version",
          "label",
          "purpose",
          "objective",
          "dataset",
          "method",
          "columns",
          "outcome",
          "parameters",
          "outputs",
          "reviewPlan",
          "registration",
          "sample",
          "compareWith",
        ].includes(key),
    ) ||
    !identifier(p.id) ||
    !Number.isSafeInteger(p.version) ||
    p.version < 1 ||
    !text(p.label, 300) ||
    !["primary", "comparison", "descriptive", "supplementary", "exploratory"].includes(p.purpose) ||
    !text(p.objective) ||
    !fields(p.dataset, ["id", "sha256"]) ||
    !identifier(p.dataset?.id) ||
    (p.dataset.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(p.dataset.sha256)) ||
    !text(p.method, 100) ||
    !Array.isArray(p.columns) ||
    p.columns.length < 1 ||
    p.columns.length > 12 ||
    p.columns.some((column) => !text(column, 300)) ||
    new Set(p.columns).size !== p.columns.length ||
    (p.outcome !== undefined && (!text(p.outcome, 300) || p.columns.includes(p.outcome))) ||
    !p.parameters ||
    typeof p.parameters !== "object" ||
    Array.isArray(p.parameters) ||
    Object.keys(p.parameters).length > 24 ||
    Object.entries(p.parameters).some(
      ([key, v]) =>
        !text(key, 100) ||
        !(
          v === null ||
          typeof v === "boolean" ||
          (typeof v === "string" && v.length <= 1000) ||
          (typeof v === "number" && Number.isFinite(v))
        ),
    ) ||
    !Array.isArray(p.outputs) ||
    !p.outputs.length ||
    p.outputs.length > 24 ||
    p.outputs.some((output) => !text(output, 200)) ||
    new Set(p.outputs).size !== p.outputs.length ||
    !text(p.reviewPlan) ||
    !fields(p.registration, ["at", "timing", "reason", "sourceRef", "observedPriorRunIds"]) ||
    typeof p.registration.at !== "string" ||
    !Number.isFinite(Date.parse(p.registration.at)) ||
    !["prospective", "post-hoc", "legacy-unknown"].includes(p.registration.timing) ||
    !text(p.registration.reason) ||
    !text(p.registration.sourceRef) ||
    (p.registration.observedPriorRunIds !== undefined &&
      (!Array.isArray(p.registration.observedPriorRunIds) ||
        p.registration.observedPriorRunIds.length > 10_000 ||
        p.registration.observedPriorRunIds.some((id) => !identifier(id)) ||
        new Set(p.registration.observedPriorRunIds).size !==
          p.registration.observedPriorRunIds.length)) ||
    !fields(
      p.sample,
      p.sample?.mode === "all" ? ["mode"] : ["mode", "id", "sourceLines", "reason"],
    ) ||
    !["all", "selected-rows"].includes(p.sample.mode)
  )
    throw new Error("结构化分析计划字段无效。");
  if (
    p.sample.mode === "selected-rows" &&
    (!identifier(p.sample.id) ||
      !text(p.sample.reason) ||
      !Array.isArray(p.sample.sourceLines) ||
      !p.sample.sourceLines.length ||
      p.sample.sourceLines.length > 50_000 ||
      p.sample.sourceLines.some((line) => !Number.isSafeInteger(line) || line < 2) ||
      new Set(p.sample.sourceLines).size !== p.sample.sourceLines.length)
  )
    throw new Error("显式样本选择需要唯一原始行定位及理由。");
  if (
    p.compareWith !== undefined &&
    (!fields(p.compareWith, ["planId", "planVersion", "requireSameSample"]) ||
      !identifier(p.compareWith.planId) ||
      p.compareWith.planId === p.id ||
      !Number.isSafeInteger(p.compareWith.planVersion) ||
      p.compareWith.planVersion < 1 ||
      typeof p.compareWith.requireSameSample !== "boolean")
  )
    throw new Error("比较计划引用无效。");
  return structuredClone(p);
}
