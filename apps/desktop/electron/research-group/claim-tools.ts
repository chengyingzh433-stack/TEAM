import {
  hasCurrentAnalysisRead,
  hasAnalysisReadForNativeReview,
  verifyAnalysisResultFiles,
  type AnalysisReuseProject,
} from "./analysis-result-reuse";
import { isDeepStrictEqual } from "node:util";
import type {
  ResearchArtifact,
  ResearchProject,
  ResearchRole,
} from "../../contracts/research-group";
import type { ResearchSource } from "../../contracts/research-evidence";
import {
  decodeResearchClaimRequest,
  decodeResearchClaimReviewRequest,
  type ResearchClaim,
  type ResearchClaimActualRead,
  type ResearchClaimDepth,
  type ResearchClaims,
  type ResearchClaimSourceSnapshot,
} from "../../contracts/research-claims";
import { createResearchAnalysisRegistry } from "./analysis-registry";
import {
  createResearchClaimArtifactSnapshot,
  createResearchClaims,
  recordResearchClaimReview,
  registerResearchClaim,
  validateResearchClaims,
  RESEARCH_CLAIM_REVIEW_BOUNDARY,
  type ResearchClaimContext,
} from "./claims";
import { activeFusionAttempt } from "./fusion-task-runtime";
import { readPinnedResearchFile, researchHash } from "./materials";
import { isCurrentResearchAnalysis } from "./paper-pipeline";

export type ClaimProject = ResearchProject &
  AnalysisReuseProject & {
    claims?: ResearchClaims;
    sourceReads?: ResearchClaimActualRead[];
  };
export const CLAIM_OPERATIONS = [
  "claim-context",
  "claim-register",
  "claim-review",
  "claim-check",
] as const;

/** A host declaration may narrow or explicitly establish scope; access alone never establishes it. */
export function researchClaimSourceDepth(source: ResearchSource): ResearchClaimDepth {
  const scope = (source as ResearchSource & { textScope?: unknown }).textScope;
  return scope === "metadata" || scope === "abstract" || scope === "full-text"
    ? scope
    : "partial-text";
}

function currentArtifact(p: ClaimProject, id: string): ResearchArtifact | undefined {
  const artifacts = p.artifacts.filter((artifact) => artifact.id === id);
  const records = p.fusion?.artifacts.filter((artifact) => artifact.id === id) ?? [];
  const artifact = artifacts[0],
    record = records[0];
  const producer = p.fusion?.tasks.find((task) => task.id === record?.taskId);
  const attempt = p.fusion?.attempts.find((entry) => entry.id === record?.attemptId);
  if (
    artifacts.length !== 1 ||
    records.length !== 1 ||
    !artifact ||
    !record ||
    !producer ||
    artifact.revision !== p.revision ||
    !producer.id.startsWith(`v${p.revision}:`) ||
    producer.role !== artifact.role ||
    producer.currentArtifactId !== id ||
    record.taskVersion !== producer.inputVersion ||
    record.content !== artifact.content ||
    attempt?.taskId !== producer.id ||
    attempt.taskVersion !== record.taskVersion ||
    ["superseded", "needs-review"].includes(record.reviewState) ||
    record.inputRefs.some(
      (ref) =>
        !p.fusion!.adoptedInputs.some(
          (adopted) => adopted.inputId === ref.inputId && adopted.version === ref.version,
        ),
    )
  )
    return undefined;
  return artifact;
}

function currentOwner(p: ClaimProject, role: ResearchRole) {
  const member = p.members.find((entry) => entry.role === role);
  const attempt = activeFusionAttempt(p, role);
  const task = p.fusion?.tasks.find((entry) => entry.id === attempt?.taskId);
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    !member ||
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !attempt.model ||
    task.role !== role ||
    !task.id.startsWith(`v${p.revision}:`) ||
    attempt.taskVersion !== task.inputVersion ||
    [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].some(
      (ref) =>
        !p.fusion!.adoptedInputs.some(
          (item) => item.inputId === ref.inputId && item.version === ref.version,
        ),
    )
  )
    throw new Error("主张操作需要当前输入版本的真实原生执行尝试及宿主模型身份。");
  return {
    revision: p.revision,
    sessionId: member.ref.sessionId,
    attemptId: attempt.id,
    taskId: task.id,
    taskVersion: task.inputVersion,
    runId: attempt.nativeRunId,
    provider: attempt.model.provider,
    modelId: attempt.model.modelId,
  };
}

const occurred = (at: string, before: string) =>
  Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.parse(before);
function readArtifact(p: ClaimProject, role: ResearchRole, artifactId: string, at: string) {
  if (
    !p.events.some(
      (event) =>
        event.type === "read" &&
        event.role === role &&
        event.artifactId === artifactId &&
        event.revision === p.revision &&
        occurred(event.at, at),
    )
  )
    throw new Error("请先用 read 实际读取当前稿件，再登记或审阅其主张。");
}
function readRun(p: ClaimProject, role: ResearchRole, runId: string, at: string): boolean {
  if (p.analysisRegistry?.runs.some((run) => run.id === runId))
    return hasCurrentAnalysisRead(p, role, runId);
  return (
    !!p.analyses?.some((run) => run.id === runId && isCurrentResearchAnalysis(p, run)) &&
    p.events.some(
      (event) =>
        event.type === "analysis" &&
        event.role === role &&
        event.analysisId === runId &&
        event.revision === p.revision &&
        occurred(event.at, at),
    )
  );
}

/** Internal reads verify location/hash only; they do not create model reading receipts. */
async function contextFor(p: ClaimProject, artifactId: string) {
  const artifact = currentArtifact(p, artifactId);
  const artifactPin =
    artifact && createResearchClaimArtifactSnapshot(artifact.id, artifact.content);
  const revision = p.revision;
  const sources = structuredClone(p.evidence?.sources ?? []);
  const unavailableSources: { sourceId: string; detail: string }[] = [];
  const snapshots = await Promise.all(
    sources.map(async (source): Promise<ResearchClaimSourceSnapshot | undefined> => {
      if (sources.filter((entry) => entry.id === source.id).length !== 1) {
        unavailableSources.push({
          sourceId: source.id,
          detail: "来源身份重复，无法建立唯一定位。",
        });
        return undefined;
      }
      try {
        const body = await readPinnedResearchFile(source);
        const snapshot = createResearchClaimArtifactSnapshot(source.id, body);
        return {
          ...snapshot,
          sha256: source.sha256,
          available: true,
          locators: [
            {
              id: `text:${source.id}`,
              label: "宿主固定文本的 UTF-16 范围 [start,end)",
              start: 0,
              end: body.length,
              depth: researchClaimSourceDepth(source),
            },
          ],
        };
      } catch {
        unavailableSources.push({
          sourceId: source.id,
          detail: "原文缺失、不可读或与固定摘要不符；保留原主张待核。",
        });
        return undefined;
      }
    }),
  );
  if (p.revision !== revision || !isDeepStrictEqual(sources, p.evidence?.sources ?? []))
    throw new Error("核验读取期间来源或课题快照已变化，请重试当前版本。");
  const current = currentArtifact(p, artifactId);
  if ((current?.content ?? null) !== (artifactPin?.body ?? null))
    throw new Error("核验读取期间目标稿件或生产者版本已变化，请重试当前稿件。");
  const registry = p.analysisRegistry ?? createResearchAnalysisRegistry();
  const context: ResearchClaimContext = {
    artifacts: artifactPin ? [artifactPin] : [],
    sources: snapshots.filter((source): source is ResearchClaimSourceSnapshot => !!source),
    structuredActualReads: structuredClone(p.sourceReads ?? []),
    registry: {
      ...registry,
      runs: registry.runs.filter(
        (run) =>
          p.analyses?.filter(
            (projection) => projection.id === run.id && isCurrentResearchAnalysis(p, projection),
          ).length === 1,
      ),
    },
    currentDatasets: (p.evidence?.datasets ?? []).map(({ id, sha256 }) => ({ id, sha256 })),
  };
  return { context, unavailableSources };
}

/** Keep source excerpts behind source-read even when a claim/check is requested with guessed offsets. */
function claimView(claim: ResearchClaim) {
  return {
    ...claim,
    evidence: claim.evidence.map((entry) => {
      if (entry.kind !== "source") return entry;
      const { exactText: _sourceText, ...reference } = entry;
      return reference;
    }),
  };
}
function status(
  p: ClaimProject,
  context: ResearchClaimContext,
  claims: ResearchClaims,
  artifactId: string,
) {
  const report = validateResearchClaims(context, claims, artifactId);
  for (const check of report.checks) {
    for (const role of ["reviewer", "mentor"] as const) {
      const review = check.reviews.filter((entry) => entry.actor.role === role).at(-1);
      if (!review) continue;
      for (const evidence of check.claim.evidence) {
        if (
          evidence.kind !== "result" ||
          !p.analysisRegistry?.runs.some((run) => run.id === evidence.runId)
        )
          continue;
        if (
          hasAnalysisReadForNativeReview(
            p,
            {
              role,
              sessionId: review.actor.sessionId,
              nativeRunId: review.actor.runId,
              at: review.at,
            },
            evidence.runId,
          )
        )
          continue;
        const issue = {
          code: "review-result-read-stale",
          detail: "该意见没有本native取得当前结果的有效凭据；旧读取或旧采用不能恢复其语义授权。",
          artifactId,
          claimId: check.claim.id,
          reviewId: review.id,
          start: check.claim.start,
          end: check.claim.end,
          exactText: check.claim.exactText,
        };
        check.blockers.push(issue);
        report.blockers.push(issue);
        check.eligible = false;
      }
    }
  }
  report.blocksFormalAcceptance = report.blockers.length > 0;
  return {
    ...report,
    checks: report.checks.map((check) => ({ ...check, claim: claimView(check.claim) })),
  };
}

/** Owner-only gate/status API. It never grants a member access to manuscript or source text. */
export async function researchClaimArtifactStatus(p: ClaimProject, artifactId: string) {
  const { context, unavailableSources } = await contextFor(p, artifactId);
  return {
    ...status(p, context, p.claims ?? createResearchClaims(), artifactId),
    unavailableSources,
  };
}

/** Call within the coordinator's durable mutation; never spread model arguments into host context. */
export async function applyResearchClaimTool(
  p: ClaimProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Promise<{ result: unknown; detail?: string }> {
  if (!CLAIM_OPERATIONS.includes(input.operation as (typeof CLAIM_OPERATIONS)[number]))
    throw new Error("未知主张操作。");
  const keys =
    input.operation === "claim-register"
      ? ["operation", "claim", "executionModel"]
      : input.operation === "claim-review"
        ? ["operation", "review", "executionModel"]
        : ["operation", "artifactId", "executionModel"];
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error("主张请求不能自填读取凭据、深度、身份或摘要等宿主字段。");
  if (!callId.trim() || !Number.isFinite(Date.parse(at)))
    throw new Error("宿主调用身份或时间无效。");
  const owner = currentOwner(p, role);
  const request =
    input.operation === "claim-register" ? decodeResearchClaimRequest(input.claim) : undefined;
  const review =
    input.operation === "claim-review" ? decodeResearchClaimReviewRequest(input.review) : undefined;
  if (review && role !== "reviewer" && role !== "mentor")
    throw new Error("主张审阅只能由真实 B/导师会话提交。");
  const existingClaim = review && p.claims?.claims.find((claim) => claim.id === review.claimId);
  const artifactId = request?.artifactId ?? (review ? existingClaim?.artifactId : input.artifactId);
  if (typeof artifactId !== "string" || !currentArtifact(p, artifactId))
    throw new Error("目标稿件不是生产者当前成果，或正文与固定任务记录不符。");
  readArtifact(p, role, artifactId, at);
  const { context, unavailableSources } = await contextFor(p, artifactId);
  if (!isDeepStrictEqual(owner, currentOwner(p, role)))
    throw new Error("核验读取期间执行尝试或输入版本已变化。");
  const ledger = p.claims ?? createResearchClaims();
  if (input.operation === "claim-context")
    return {
      result: {
        artifact: context.artifacts[0],
        sources: context.sources.map(({ body: _body, ...source }) => source),
        actualReads: context.structuredActualReads.filter(
          (read) => read.sessionId === owner.sessionId && occurred(read.at, at),
        ),
        runs: context.registry.runs
          .filter((run) => readRun(p, role, run.id, at))
          .map((run) => ({
            id: run.id,
            runSha256: run.runSha256,
            planId: run.planId,
            planVersion: run.planVersion,
          })),
        unavailableSources,
        boundary: RESEARCH_CLAIM_REVIEW_BOUNDARY,
      },
    };
  if (request) {
    for (const evidence of request.evidence)
      if (evidence.kind === "result" && !readRun(p, role, evidence.runId, at))
        throw new Error("计算依赖必须是本成员实际运行或读取过的当前结果。");
    for (const evidence of request.evidence)
      if (evidence.kind === "result") await verifyAnalysisResultFiles(p, evidence.runId);
    if (!isDeepStrictEqual(owner, currentOwner(p, role)))
      throw new Error("结果文件核验期间native已变化。");
    const next = registerResearchClaim(ledger, context, request);
    p.claims = next;
    return {
      result: {
        claim: claimView(next.claims.find((claim) => claim.id === request.id)!),
        ...status(p, context, next, artifactId),
        unavailableSources,
      },
      detail: `登记当前稿件主张 ${request.id}；登记与实际读取均不等于内容受支持。`,
    };
  }
  if (review && existingClaim && (role === "reviewer" || role === "mentor")) {
    for (const evidence of existingClaim.evidence)
      if (evidence.kind === "result" && !readRun(p, role, evidence.runId, at))
        throw new Error("审阅者尚未实际读取此主张依赖的当前计算结果。");
    for (const evidence of existingClaim.evidence)
      if (evidence.kind === "result") await verifyAnalysisResultFiles(p, evidence.runId);
    if (!isDeepStrictEqual(owner, currentOwner(p, role)))
      throw new Error("结果文件核验期间native已变化。");
    const id = researchHash(JSON.stringify([p.id, owner.sessionId, owner.runId, callId]));
    const next = recordResearchClaimReview(ledger, context, review, {
      id,
      at: ledger.reviews.find((entry) => entry.id === id)?.at ?? at,
      actor: {
        kind: "model",
        role,
        sessionId: owner.sessionId,
        runId: owner.runId,
        toolCallId: callId,
        provider: owner.provider,
        modelId: owner.modelId,
      },
    });
    const recorded = next.reviews.find((entry) => entry.id === id)!;
    const checked = status(p, context, next, artifactId);
    if (
      checked.blockers.some(
        (issue) =>
          issue.claimId === existingClaim.id &&
          (["source-stale", "source-location-stale", "reading-depth-insufficient"].includes(
            issue.code,
          ) ||
            (issue.code === "review-read-missing" && issue.reviewId === recorded.id)),
      )
    )
      throw new Error("审阅者尚未实际读取所引当前原文范围与所需深度；不能自报完成核验。");
    p.claims = next;
    return {
      result: { review: recorded, ...checked, unavailableSources },
      detail: `模型 ${role} 对主张 ${review.claimId} 记录 ${review.conclusion}，不是程序证明或人类专家确认。`,
    };
  }
  return { result: { ...status(p, context, ledger, artifactId), unavailableSources } };
}
