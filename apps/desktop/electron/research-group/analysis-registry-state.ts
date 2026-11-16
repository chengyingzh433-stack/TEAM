import { hasCurrentAnalysisReviewContext } from "./analysis-result-reuse";
import type { ResearchProject } from "../../contracts/research-group";
import type { ResearchAnalysisRun, ResearchAnalysisSpec } from "../../contracts/research-evidence";
import { researchAnalysisRegistryReport } from "./analysis-registry";
import { createHash } from "node:crypto";

export function registeredAnalysisProjectionIntact(
  p: ResearchProject,
  projection: ResearchAnalysisRun,
): boolean {
  const actual = p.analysisRegistry?.runs.find((entry) => entry.id === projection.id);
  if (!actual) return true;
  const result = JSON.stringify(projection.result);
  return (
    typeof result === "string" &&
    createHash("sha256").update(result).digest("hex") === actual.resultSha256 &&
    projection.sha256 === actual.resultSha256 &&
    projection.datasetSha256 === actual.datasetSha256 &&
    projection.engine === actual.engine &&
    projection.createdAt === actual.at &&
    `model:${projection.role}` === actual.actor &&
    JSON.stringify(projection.spec) === JSON.stringify(actual.spec)
  );
}

export function matchesCurrentRegisteredAnalysis(
  p: ResearchProject,
  run: ResearchAnalysisRun,
): boolean | undefined {
  const actual = p.analysisRegistry?.runs.find((entry) => entry.id === run.id);
  if (!actual) return p.activeAnalysisPlans?.length ? false : undefined;
  if (!registeredAnalysisProjectionIntact(p, run)) return false;
  const plan = p.analysisRegistry!.plans.find(
    (entry) => entry.id === actual.planId && entry.version === actual.planVersion,
  );
  return (
    !!plan &&
    !!p.activeAnalysisPlans?.some(
      (entry) => entry.id === plan.id && entry.version === plan.version,
    ) &&
    p.analysisRegistry!.plans.filter((entry) => entry.id === plan.id).at(-1)?.version ===
      plan.version &&
    actual.datasetSha256 === run.datasetSha256 &&
    actual.resultSha256 === run.sha256 &&
    JSON.stringify(actual.spec) === JSON.stringify(run.spec)
  );
}
export function matchesAdoptedRegisteredSpec(
  p: ResearchProject,
  spec: ResearchAnalysisSpec,
): boolean | undefined {
  if (!p.activeAnalysisPlans?.length) return undefined;
  return p.activeAnalysisPlans.some((ref) =>
    p.analysisRegistry?.plans.some(
      (plan) =>
        plan.id === ref.id &&
        plan.version === ref.version &&
        plan.dataset.id === spec.datasetId &&
        plan.method === spec.method &&
        plan.outcome === spec.outcome &&
        JSON.stringify(plan.columns) === JSON.stringify(spec.columns),
    ),
  );
}

/** Deterministic completion checks; semantic reviews retain their actual model attribution. */
export function registeredAnalysisAcceptanceIssues(
  p: ResearchProject,
  currentRunIds: string[],
): string[] {
  const active = p.activeAnalysisPlans ?? [];
  if (!active.length) return [];
  const registry = p.analysisRegistry;
  if (!registry) return ["已采用分析计划缺少登记记录。"];
  const report = researchAnalysisRegistryReport(registry, p.evidence?.datasets ?? []),
    issues: string[] = [];
  for (const ref of active) {
    const plan = registry.plans.find(
        (entry) => entry.id === ref.id && entry.version === ref.version,
      ),
      status = report.find((entry) => entry.planId === ref.id && entry.planVersion === ref.version);
    if (!plan || !status) {
      issues.push(`${ref.id} 的当前计划版本不完整。`);
      continue;
    }
    if (status.state !== "executed") {
      issues.push(
        `${plan.label}：${status.state}${status.reasons.length ? `，${status.reasons.join("；")}` : ""}`,
      );
      continue;
    }
    const runs = registry.runs.filter(
      (run) => status.runIds.includes(run.id) && currentRunIds.includes(run.id),
    );
    const lead = runs.filter((run) => run.actor === "model:lead");
    if (!lead.length) issues.push(`${plan.label} 尚无当前任务版本的 A 实算。`);
    if (
      !runs.some(
        (run) =>
          run.actor === "model:reviewer" &&
          run.verification.level === "same-engine-replay" &&
          run.verification.matches &&
          lead.some(
            (original) =>
              original.id ===
              (run.verification.level === "same-engine-replay"
                ? run.verification.replayOf
                : undefined),
          ),
      )
    )
      issues.push(`${plan.label} 尚无 B 对 A 的同引擎复跑一致记录；不能称作独立算法。`);
    const review = registry.reviews
      .filter(
        (entry) =>
          entry.planId === plan.id &&
          entry.planVersion === plan.version &&
          entry.actor === "model:reviewer" &&
          entry.kind === "interpretation-review" &&
          runs.some((run) => run.id === entry.runId),
      )
      .at(-1);
    if (review?.verdict !== "accept" || !hasCurrentAnalysisReviewContext(p, review.id))
      issues.push(`${plan.label} 尚无 B 针对当前结果的接受意见。`);
    if (status.comparison && !status.comparison.comparable)
      issues.push(`${plan.label}：${status.comparison.reason}`);
    if (
      plan.compareWith &&
      !active.some(
        (entry) =>
          entry.id === plan.compareWith!.planId && entry.version === plan.compareWith!.planVersion,
      )
    )
      issues.push(`${plan.label} 的比较对象不是本轮采用的版本。`);
  }
  return issues;
}
