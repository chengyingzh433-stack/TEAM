import { isDeepStrictEqual } from "node:util";
import type { ResearchRole } from "../../contracts/research-group";
import {
  decodeResearchContentChecks,
  type ResearchContentCheckIssue,
  type ResearchContentCheckRecord,
} from "../../contracts/research-content-checks";
import { researchClaimArtifactStatus, type ClaimProject } from "./claim-tools";
import { activeFusionAttempt, fusionRoleStage } from "./fusion-task-runtime";
import {
  isCurrentResearchAnalysis,
  isCurrentResearchArtifact,
  stageManuscript,
} from "./paper-pipeline";
import { researchHash } from "./materials";
import { verifyAnalysisResultFiles } from "./analysis-result-reuse";
import { researchAcceptanceTaskContext } from "./acceptance-context";

export type ClaimAcceptanceProject = ClaimProject & {
  contentChecks?: ResearchContentCheckRecord[];
};
const digest = (value: unknown) => researchHash(JSON.stringify(value));
const BOUNDARY =
  "程序只核查当前稿件的已登记主张、定位、依赖版本、实际读取与未关闭的模型意见。支持结论和理由属于B/导师模型语义审阅，不是程序证明或人类专家确认；不自动发现全部主张。通过仅对检查时快照有效，正式发布前必须重新读取并检查同一目标稿件。";

function scope(p: ClaimAcceptanceProject, role: ResearchRole, input: Record<string, unknown>) {
  const stage = fusionRoleStage(p, role) ?? p.currentStage;
  return {
    stage,
    required:
      p.workflowVersion === "fusion-v2" &&
      p.scope === "paper" &&
      (p.goal ?? "paper") === "paper" &&
      p.entry !== "task" &&
      p.entry !== "manuscript" &&
      input.verdict === "accept" &&
      ["stage-verification", "stage-review"].includes(String(input.kind)) &&
      ["writing", "audit"].includes(stage ?? ""),
  };
}

/** Scope only. The coordinator preserves duplicate/historical publications before entering this gate. */
export function requiresClaimAcceptance(
  p: ClaimAcceptanceProject,
  role: ResearchRole,
  input: Record<string, unknown>,
) {
  return scope(p, role, input).required;
}
function targetRevision(p: ClaimAcceptanceProject, stage: string | undefined) {
  return p.artifacts
    .filter((artifact) => {
      const graphRecord = p.fusion?.artifacts.find((entry) => entry.id === artifact.id);
      const task = p.fusion?.tasks.find((entry) => entry.id === graphRecord?.taskId);
      return (
        artifact.revision === p.revision &&
        artifact.role === "lead" &&
        artifact.id === stageManuscript(p, stage)?.id &&
        artifact.stage === stage &&
        task?.currentArtifactId === artifact.id &&
        isCurrentResearchArtifact(p, artifact)
      );
    })
    .at(-1);
}
function contextToken(p: ClaimAcceptanceProject, role: ResearchRole) {
  return digest({
    id: p.id,
    revision: p.revision,
    status: p.status,
    workflowVersion: p.workflowVersion,
    scope: p.scope,
    entry: p.entry,
    goal: p.goal,
    path: p.path,
    currentStage: p.currentStage,
    members: p.members.map(({ role, ref }) => ({ role, ref })),
    artifacts: p.artifacts,
    fusion: researchAcceptanceTaskContext(p, role),
    evidence: p.evidence,
    sourcesRead: p.sourceReads,
    claims: p.claims,
    registry: p.analysisRegistry,
    adoptions: p.analysisRunAdoptions,
    actualReads: p.analysisReads,
    reviewContexts: p.analysisReviewContexts,
    activePlans: p.activeAnalysisPlans,
    analyses: p.analyses,
    reads: p.events.filter(
      (event) => event.type === "read" || (event.type === "analysis" && event.analysisId),
    ),
  });
}
function callPrefix(
  p: ClaimAcceptanceProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
) {
  return `claim-check:${digest({
    projectId: p.id,
    revision: p.revision,
    role,
    nativeRunId: activeFusionAttempt(p, role)?.nativeRunId,
    callId,
    input,
  })}:`;
}
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 6000) || "主张检查失败。";

/** Check only runs actually referenced by this manuscript's claims, not unrelated project analyses. */
async function resultFileIssues(
  p: ClaimAcceptanceProject,
  artifactId: string,
): Promise<ResearchContentCheckIssue[]> {
  const failures = new Map<string, string | undefined>();
  const issues: ResearchContentCheckIssue[] = [];
  for (const claim of p.claims?.claims.filter((item) => item.artifactId === artifactId) ?? []) {
    for (const reference of claim.evidence) {
      if (reference.kind !== "result") continue;
      if (!failures.has(reference.runId)) {
        const projection = p.analyses?.find(
          (run) => run.id === reference.runId && isCurrentResearchAnalysis(p, run),
        );
        const actual = p.analysisRegistry?.runs.find((run) => run.id === reference.runId);
        // Status reports absent/stale runs with the precise claim location.
        if (!projection || !actual) {
          failures.set(reference.runId, undefined);
          continue;
        }
        try {
          await verifyAnalysisResultFiles(p, reference.runId);
          failures.set(reference.runId, undefined);
        } catch (error) {
          failures.set(reference.runId, errorText(error));
        }
      }
      const detail = failures.get(reference.runId);
      if (detail)
        issues.push({
          code: "actual-claim-result-invalid",
          detail,
          claimId: claim.id,
          start: claim.start,
          end: claim.end,
          exactText: claim.exactText,
          runId: reference.runId,
          fieldPath: reference.path,
        });
    }
  }
  return issues;
}

async function evaluate(
  p: ClaimAcceptanceProject,
  role: ResearchRole,
  input: Record<string, unknown>,
  at: string,
) {
  const { stage } = scope(p, role, input);
  const target = targetRevision(p, stage);
  const targetPin = target
    ? { artifactId: target.id, bodySha256: researchHash(target.content) }
    : null;
  const issues: ResearchContentCheckIssue[] = [];
  const claimChecks: NonNullable<ResearchContentCheckRecord["claimChecks"]> = [];
  const attempt = activeFusionAttempt(p, role);
  const task = p.fusion?.tasks.find((entry) => entry.id === attempt?.taskId);
  if (
    (input.kind === "stage-verification" ? role !== "reviewer" : role !== "mentor") ||
    input.stage !== stage
  )
    issues.push({
      code: "claim-acceptance-role-stage",
      detail: "正式接受须由当前阶段对应的B/导师提交，不能更改阶段或角色绕过核查。",
    });
  if (
    input.revision !== p.revision ||
    p.status !== "running" ||
    !attempt ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !attempt.model ||
    !task ||
    task.inputVersion !== attempt.taskVersion ||
    !task.id.startsWith(`v${p.revision}:`)
  )
    issues.push({
      code: "current-native-required",
      detail: "正式接受的当前原生执行或输入版本已失效。",
    });
  if (
    [
      "report",
      "receipt",
      "claimAcceptance",
      "claimAcceptanceReceipt",
      "contentChecks",
      "claimChecks",
    ].some((key) => key in input)
  )
    issues.push({
      code: "host-claim-check-required",
      detail: "模型不能提交程序检查报告或凭据；正式发布必须由宿主重新检查。",
    });
  if (!target)
    issues.push({
      code: "latest-revision-required",
      detail: "当前阶段尚无最新有效A修订，不能接受旧阶段、旧版本或不存在的稿件。",
    });
  if (target && (!Array.isArray(input.refs) || !input.refs.includes(target.id)))
    issues.push({
      code: "latest-target-reference-required",
      detail: "正式接受必须明确引用本阶段最新有效A修订。",
    });
  if (
    target &&
    !p.events.some(
      (event) =>
        event.type === "read" &&
        event.role === role &&
        event.artifactId === target.id &&
        event.revision === p.revision &&
        Number.isFinite(Date.parse(event.at)) &&
        Date.parse(event.at) <= Date.parse(at),
    )
  )
    issues.push({ code: "target-read-required", detail: "接受者尚未实际读取本阶段当前目标稿件。" });
  if (target) {
    try {
      const report = await researchClaimArtifactStatus(p, target.id);
      // unavailableSources is informational; only actual claim dependencies contribute blockers.
      issues.push(
        ...report.blockers.map(({ code, detail, claimId, reviewId, start, end, exactText }) => ({
          code,
          detail,
          ...(claimId ? { claimId } : {}),
          ...(reviewId ? { reviewId } : {}),
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
          ...(exactText !== undefined ? { exactText } : {}),
        })),
      );
      for (const check of report.checks) {
        const claim = p.claims!.claims.find((entry) => entry.id === check.claim.id)!;
        claimChecks.push({
          claimId: claim.id,
          claimSha256: digest(claim),
          bodySha256: claim.bodySha256,
          start: claim.start,
          end: claim.end,
          reviews: (["reviewer", "mentor"] as const).flatMap((reviewRole) => {
            const review = check.reviews.filter((entry) => entry.actor.role === reviewRole).at(-1);
            return review ? [structuredClone(review)] : [];
          }),
        });
      }
      issues.push(...(await resultFileIssues(p, target.id)));
    } catch (error) {
      issues.push({ code: "actual-claim-check-failed", detail: errorText(error) });
    }
  }
  return { target: targetPin, issues, claimChecks };
}

/** Persist inside the owner mutation even if blocked. Throw only outside that successful save. */
export async function prepareClaimAcceptance(
  p: ClaimAcceptanceProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Promise<{
  required: boolean;
  blocked: boolean;
  record?: ResearchContentCheckRecord;
  detail: string;
}> {
  const applicable = scope(p, role, input);
  if (!applicable.required)
    return { required: false, blocked: false, detail: "本操作不在完整论文S7/S8主张正式接受范围。" };
  const before = contextToken(p, role);
  const evaluated = await evaluate(p, role, input, at);
  if (!callId.trim() || !Number.isFinite(Date.parse(at)))
    evaluated.issues.push({
      code: "claim-check-host-invalid",
      detail: "宿主调用身份或检查时间无效。",
    });
  const token = contextToken(p, role);
  if (before !== token)
    evaluated.issues.push({
      code: "claim-context-changed",
      detail: "检查期间稿件、原文、读取凭据或模型意见版本变化，需要重新检查。",
    });
  const id = `${callPrefix(p, role, callId, input)}${digest({ token, ...evaluated })}`;
  const previous = p.contentChecks?.find((record) => record.id === id);
  const record: ResearchContentCheckRecord = {
    id,
    at: previous?.at ?? (Number.isFinite(Date.parse(at)) ? at : new Date().toISOString()),
    kind: "claim-acceptance",
    program: { kind: "program", id: "claim-acceptance-1" },
    target: evaluated.target,
    role,
    stage: applicable.stage === "audit" ? "audit" : "writing",
    issues: evaluated.issues,
    claimChecks: evaluated.claimChecks,
    unboundCandidates: [],
    result: evaluated.issues.length ? "blocked" : "passed-at-snapshot",
    snapshotToken: token,
    boundary: BOUNDARY,
  };
  decodeResearchContentChecks([record]);
  if (!previous) (p.contentChecks ??= []).push(structuredClone(record));
  return {
    required: true,
    blocked: record.result === "blocked",
    record,
    detail:
      record.result === "blocked"
        ? `主张接受检查阻断：${record.issues.map((issue) => issue.detail).join("；")}`
        : "主张检查在此稿件快照通过；支持意见仍属于模型语义审阅，正式发布须再次核验。",
  };
}

/** Await inside the real publish mutation. Saved reports bind the target; only fresh evaluation grants passage. */
export async function assertClaimAcceptance(
  p: ClaimAcceptanceProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Promise<void> {
  if (!requiresClaimAcceptance(p, role, input)) return;
  const prefix = callPrefix(p, role, callId, input);
  const prepared = p.contentChecks
    ?.filter((record) => record.kind === "claim-acceptance" && record.id.startsWith(prefix))
    .at(-1);
  const checked = await prepareClaimAcceptance(p, role, callId, input, at);
  if (
    !prepared ||
    prepared.result !== "passed-at-snapshot" ||
    !prepared.target ||
    !isDeepStrictEqual(prepared.target, checked.record?.target)
  )
    throw new Error("本次接受缺少同一宿主调用和目标稿件的有效检查，或目标稿件已变化；请重新检查。");
  if (checked.blocked) throw new Error(`正式发布前主张检查未通过：${checked.detail}`);
  if (prepared.snapshotToken !== checked.record?.snapshotToken)
    throw new Error("正式发布前主张核验的输入/采用/读取上下文已变化，请重新检查当前快照。");
}
