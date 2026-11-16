import { createHash } from "node:crypto";
import type { ResearchArtifact, ResearchRole } from "../../contracts/research-group";
import {
  decodeResearchContentChecks,
  type ResearchContentCheckIssue,
  type ResearchContentCheckRecord,
} from "../../contracts/research-content-checks";
import { applyNumericBindingTool, type NumericProject } from "./numeric-binding-tools";
import { activeFusionAttempt, fusionRoleStage } from "./fusion-task-runtime";
import {
  isCurrentResearchAnalysis,
  isCurrentResearchArtifact,
  stageManuscript,
} from "./paper-pipeline";
import { researchAnalysisRegistryReport } from "./analysis-registry";
import { verifyAnalysisResultFiles } from "./analysis-result-reuse";
import { researchAcceptanceTaskContext } from "./acceptance-context";

export type NumericAcceptanceProject = NumericProject & {
  contentChecks?: ResearchContentCheckRecord[];
};
declare const receiptBrand: unique symbol;
/** Host-private object capability. JSON, model payloads and copied objects cannot mint this receipt. */
export interface NumericAcceptanceReceipt {
  readonly [receiptBrand]: true;
}
const receipts = new WeakMap<
  NumericAcceptanceReceipt,
  {
    projectId: string;
    role: ResearchRole;
    inputToken: string;
    contextToken: string;
    targetId: string;
    targetSha256: string;
    callId: string;
    at: string;
  }
>();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
const digest = (value: unknown) => sha(JSON.stringify(stable(value)));
const BOUNDARY =
  "仅检查本次目标稿件及当前数据/运行版本的数值绑定与待审候选；不证明全文事实、统计解释、因果主张或研究质量正确。通过记录仅对检查时快照有效，正式发布前必须再核对私有凭据。";
function contextToken(p: NumericAcceptanceProject, role: ResearchRole) {
  // Exclude contentChecks/events/updatedAt: the check's own durable audit append must not stale its receipt.
  return digest({
    projectId: p.id,
    revision: p.revision,
    status: p.status,
    workflowVersion: p.workflowVersion,
    entry: p.entry,
    goal: p.goal,
    scope: p.scope,
    path: p.path,
    currentStage: p.currentStage,
    objective: p.objective,
    artifacts: p.artifacts,
    registry: p.analysisRegistry,
    adoptions: p.analysisRunAdoptions,
    actualReads: p.analysisReads,
    reviewContexts: p.analysisReviewContexts,
    activePlans: p.activeAnalysisPlans,
    analyses: p.analyses,
    evidence: p.evidence,
    fusion: researchAcceptanceTaskContext(p, role),
    bindings: p.numericBindings,
    fieldMetadata: p.numericFieldMetadata,
    candidateReviews: p.numericCandidateReviews,
  });
}
function applicable(
  p: NumericAcceptanceProject,
  role: ResearchRole,
  input: Record<string, unknown>,
) {
  const stage = fusionRoleStage(p, role) ?? p.currentStage;
  const required =
    p.workflowVersion === "fusion-v2" &&
    p.scope === "paper" &&
    (p.path ?? "quantitative") === "quantitative" &&
    (p.goal ?? "paper") === "paper" &&
    p.entry !== "task" &&
    p.entry !== "manuscript" &&
    input.verdict === "accept" &&
    ["stage-verification", "stage-review"].includes(String(input.kind)) &&
    ["writing", "audit"].includes(stage ?? "");
  return { required, stage };
}
/** Pure routing check; callers may avoid a persistence mutation for unrelated publish operations. */
export function requiresNumericAcceptance(
  p: NumericAcceptanceProject,
  role: ResearchRole,
  input: Record<string, unknown>,
): boolean {
  return applicable(p, role, input).required;
}
function targetRevision(p: NumericAcceptanceProject, stage: string | undefined) {
  return p.artifacts
    .filter(
      (artifact) =>
        artifact.revision === p.revision &&
        artifact.role === "lead" &&
        artifact.id === stageManuscript(p, stage)?.id &&
        artifact.stage === stage &&
        isCurrentResearchArtifact(p, artifact),
    )
    .at(-1);
}
function requiredAnalysisFields(
  p: NumericAcceptanceProject,
  target: ResearchArtifact | undefined,
  validBindingIds: Set<string>,
) {
  const issues: ResearchContentCheckIssue[] = [],
    active = p.activeAnalysisPlans ?? [],
    registry = p.analysisRegistry;
  if (!active.length || !registry)
    return [
      {
        code: "registered-analysis-required",
        detail: "完整量化研究正式接受前，必须有本轮已采用的登记计划与实际当前运行。",
      },
    ];
  for (const ref of active) {
    const plan = registry.plans.find((item) => item.id === ref.id && item.version === ref.version);
    if (!plan || registry.plans.some((item) => item.id === ref.id && item.version > ref.version)) {
      issues.push({
        code: "active-plan-stale",
        detail: `本轮计划${ref.id}版本${ref.version}缺失或已过期。`,
      });
      continue;
    }
    const currentIds =
      researchAnalysisRegistryReport(registry, p.evidence?.datasets ?? []).find(
        (report) =>
          report.planId === plan.id &&
          report.planVersion === plan.version &&
          report.state === "executed",
      )?.runIds ?? [];
    const runs = registry.runs.filter(
      (run) =>
        currentIds.includes(run.id) &&
        run.planId === plan.id &&
        run.planVersion === plan.version &&
        p.analyses?.some(
          (projection) => projection.id === run.id && isCurrentResearchAnalysis(p, projection),
        ),
    );
    if (!runs.length) {
      issues.push({
        code: "current-run-required",
        detail: `${plan.label}尚无当前有效的实际运行。`,
      });
      continue;
    }
    if (plan.purpose !== "primary" || plan.method !== "ols") continue;
    const run = runs.filter((item) => item.actor === "model:lead").at(-1);
    if (!run) {
      issues.push({
        code: "primary-lead-run-required",
        detail: `${plan.label}尚无A的当前主OLS实际运行。`,
      });
      continue;
    }
    for (const path of [
      ["regression", "sampleSize"],
      ["regression", "rSquared"],
      ...plan.columns.map((column) => ["regression", "coefficients", column]),
    ]) {
      if (
        !target ||
        !(p.numericBindings ?? []).some(
          (binding) =>
            binding.artifactId === target.id &&
            binding.bodySha256 === sha(target.content) &&
            binding.runId === run.id &&
            binding.runSha256 === run.runSha256 &&
            digest(binding.path) === digest(path) &&
            validBindingIds.has(binding.id),
        )
      )
        issues.push({
          code: "required-primary-field-unbound",
          detail: `${plan.label}的当前主OLS字段${JSON.stringify(path)}必须在最新A修订中有有效绑定；候选语义排除不能代替。`,
          runId: run.id,
          fieldPath: path,
        });
    }
  }
  return issues;
}
async function checkCurrentRunFiles(p: NumericAcceptanceProject) {
  const registry = p.analysisRegistry;
  if (!registry) return;
  const currentIds = new Set(
    researchAnalysisRegistryReport(registry, p.evidence?.datasets ?? [])
      .filter(
        (report) =>
          report.state === "executed" &&
          p.activeAnalysisPlans?.some(
            (plan) => plan.id === report.planId && plan.version === report.planVersion,
          ),
      )
      .flatMap((report) => report.runIds),
  );
  for (const run of registry.runs.filter((item) => currentIds.has(item.id))) {
    const projection = p.analyses?.find(
      (item) => item.id === run.id && isCurrentResearchAnalysis(p, item),
    );
    if (!projection) continue; // The required-analysis check reports a missing current projection.
    await verifyAnalysisResultFiles(p, run.id);
  }
}
async function evaluate(
  p: NumericAcceptanceProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
) {
  const { stage } = applicable(p, role, input),
    target = targetRevision(p, stage);
  const issues: ResearchContentCheckIssue[] = [],
    candidates: ResearchContentCheckRecord["unboundCandidates"] = [],
    valid = new Set<string>();
  const attempt = activeFusionAttempt(p, role),
    task = p.fusion?.tasks.find((item) => item.id === attempt?.taskId);
  if (
    !["reviewer", "mentor"].includes(role) ||
    (input.kind === "stage-verification" ? role !== "reviewer" : role !== "mentor") ||
    input.stage !== stage
  )
    issues.push({
      code: "acceptance-role-stage",
      detail: "正式接受须由当前阶段对应的B/导师提交，不能改写阶段或角色绕过检查。",
    });
  if (
    p.status !== "running" ||
    !attempt ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !task ||
    task.inputVersion !== attempt.taskVersion ||
    !task.id.startsWith(`v${p.revision}:`)
  )
    issues.push({ code: "current-native-required", detail: "当前原生执行或输入版本已失效。" });
  if (["receipt", "numericAcceptanceReceipt", "contentChecks"].some((key) => key in input))
    issues.push({
      code: "host-private-receipt",
      detail: "模型不能提交程序凭据或检查记录；凭据只能由宿主独立传递。",
    });
  if (!target)
    issues.push({
      code: "latest-revision-required",
      detail: "当前阶段尚无最新有效A stage-revision，不能对不存在的稿件正式接受。",
    });
  if (target && (!Array.isArray(input.refs) || !input.refs.includes(target.id)))
    issues.push({
      code: "latest-target-reference-required",
      detail: "正式接受必须明确引用所检查的最新A修订。",
    });
  if (target && !issues.length) {
    try {
      // Even a run with no manuscript bindings yet must have real, intact backing files.
      await checkCurrentRunFiles(p);
      const effect = await applyNumericBindingTool(
        p,
        role,
        `acceptance:${callId}`,
        { operation: "numeric-check", artifactId: target.id },
        at,
      );
      const result = effect.result as {
        deterministic: {
          checks: { bindingId: string; valid: boolean }[];
          blockers: { code: string; detail: string; bindingId?: string }[];
        };
        semantic: {
          unbound: {
            artifactId: string;
            bodySha256: string;
            start: number;
            end: number;
            text: string;
            reason: string;
          }[];
        };
      };
      for (const check of result.deterministic.checks) if (check.valid) valid.add(check.bindingId);
      issues.push(
        ...result.deterministic.blockers.map((blocker) => ({
          code: blocker.code,
          detail: blocker.detail,
          ...(blocker.bindingId ? { bindingId: blocker.bindingId } : {}),
        })),
      );
      candidates.push(
        ...result.semantic.unbound.map(({ artifactId, bodySha256, start, end, text, reason }) => ({
          artifactId,
          bodySha256,
          start,
          end,
          text,
          reason,
        })),
      );
    } catch (error) {
      issues.push({
        code: "actual-numeric-check-failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  issues.push(...requiredAnalysisFields(p, target, valid));
  return { stage, target, issues, candidates, blocked: issues.length > 0 || candidates.length > 0 };
}
/** Owner mutation persists this record even when blocked; caller throws only after mutation commits. */
export async function prepareNumericAcceptance(
  p: NumericAcceptanceProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Promise<{
  required: boolean;
  blocked: boolean;
  receipt?: NumericAcceptanceReceipt;
  detail: string;
}> {
  const scope = applicable(p, role, input);
  if (!scope.required)
    return {
      required: false,
      blocked: false,
      detail: "本操作不在完整量化S7/S8正式接受数值门禁范围。",
    };
  if (!callId.trim() || !Number.isFinite(Date.parse(at)))
    throw new Error("宿主调用身份或检查时间无效。");
  const before = contextToken(p, role),
    evaluated = await evaluate(p, role, callId, input, at),
    token = contextToken(p, role);
  if (before !== token) {
    evaluated.issues.push({
      code: "acceptance-context-changed",
      detail: "检查期间稿件或依赖状态变化，需对新版本重新检查。",
    });
    evaluated.blocked = true;
  }
  const inputToken = digest(input),
    id = `numeric-check:${digest({ project: p.id, role, callId, token, inputToken }).slice(0, 40)}`;
  const existing = p.contentChecks?.find((record) => record.id === id);
  const record: ResearchContentCheckRecord = {
    id,
    at: existing?.at ?? at,
    kind: "numeric-acceptance",
    target: evaluated.target
      ? { artifactId: evaluated.target.id, bodySha256: sha(evaluated.target.content) }
      : null,
    program: { kind: "program", id: "numeric-acceptance-1" },
    role,
    stage: scope.stage === "audit" ? "audit" : "writing",
    issues: evaluated.issues,
    unboundCandidates: evaluated.candidates,
    result: evaluated.blocked ? "blocked" : "passed-at-snapshot",
    snapshotToken: token,
    boundary: BOUNDARY,
  };
  decodeResearchContentChecks([record]);
  if (existing && digest(existing) !== digest(record)) {
    // A disk change can alter check output without changing project fields. Keep both audit snapshots.
    record.id = `${id}:${digest({ issues: record.issues, candidates: record.unboundCandidates }).slice(0, 12)}`;
    record.at = at;
  }
  if (!p.contentChecks?.some((item) => item.id === record.id))
    (p.contentChecks ??= []).push(structuredClone(record));
  const detail = evaluated.blocked
    ? `数值接受检查阻断：${evaluated.issues.map((issue) => issue.detail).join("；")}${evaluated.candidates.length ? `；还有${evaluated.candidates.length}个同稿数字候选待逐项审阅或绑定。` : ""}`
    : "数值接受检查在当前稿件快照通过，正式发布前仍须复核私有凭据。";
  if (evaluated.blocked || !evaluated.target) return { required: true, blocked: true, detail };
  const receipt = Object.freeze({}) as NumericAcceptanceReceipt;
  receipts.set(receipt, {
    projectId: p.id,
    role,
    inputToken,
    contextToken: token,
    targetId: evaluated.target.id,
    targetSha256: sha(evaluated.target.content),
    callId,
    at,
  });
  return { required: true, blocked: false, receipt, detail };
}
/** Await inside the actual publish mutation. The receipt must never arrive through model/tool input. */
export async function assertNumericAcceptanceReceipt(
  p: NumericAcceptanceProject,
  role: ResearchRole,
  input: Record<string, unknown>,
  receipt?: NumericAcceptanceReceipt,
): Promise<void> {
  const required = applicable(p, role, input).required;
  if (!required && !receipt) return;
  const authority = receipt && receipts.get(receipt);
  if (
    !required ||
    !authority ||
    authority.projectId !== p.id ||
    authority.role !== role ||
    authority.inputToken !== digest(input) ||
    authority.contextToken !== contextToken(p, role)
  )
    throw new Error("数值接受凭据缺失、非宿主生成或上下文已变化；请重新检查。");
  const target = targetRevision(p, applicable(p, role, input).stage);
  if (!target || target.id !== authority.targetId || sha(target.content) !== authority.targetSha256)
    throw new Error("接受凭据绑定的目标稿件已变化。");
  const evaluated = await evaluate(p, role, authority.callId, input, authority.at);
  if (evaluated.blocked || authority.contextToken !== contextToken(p, role))
    throw new Error("正式发布前数值、实际文件或当前执行状态已变化，接受被阻断；请重新检查。");
}
