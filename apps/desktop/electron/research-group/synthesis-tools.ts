import { isDeepStrictEqual } from "node:util";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import type {
  ResearchClaim,
  ResearchClaimActualRead,
  ResearchClaimDepth,
} from "../../contracts/research-claims";
import type { ResearchLiteratureToolState } from "../../contracts/research-literature-search";
import {
  decodeResearchSynthesis,
  decodeResearchSynthesisRequest,
  RESEARCH_SYNTHESIS_COLUMNS,
  SYNTHESIS_OPERATIONS,
  type ResearchCandidateGap,
  type ResearchCandidateGapRequest,
  type ResearchCounterevidence,
  type ResearchCounterevidenceRequest,
  type ResearchCounterevidenceResponse,
  type ResearchCounterevidenceResponseRequest,
  type ResearchCounterevidenceReview,
  type ResearchCounterevidenceReviewRequest,
  type ResearchCounterevidenceResolution,
  type ResearchCounterevidenceResolutionRequest,
  type ResearchSynthesis,
  type ResearchSynthesisCell,
  type ResearchSynthesisDraft,
  type ResearchSynthesisEvidence,
  type ResearchSynthesisHost,
  type ResearchSynthesisMatrix,
  type ResearchSynthesisMatrixRequest,
  type ResearchSynthesisOwner,
  type ResearchSynthesisSourceRef,
} from "../../contracts/research-synthesis";
import { createResearchClaims, projectResearchClaimSourceImpact } from "./claims";
import { researchClaimSourceDepth } from "./claim-tools";
import { activeFusionAttempt } from "./fusion-task-runtime";
import { hasStageIndependentJudgment, canReadResearchPeerJudgment } from "./paper-pipeline";
import { readPinnedResearchFile, researchHash } from "./materials";
import { reportResearchLiteratureSearch } from "./literature-search";
import { applyResearchChange, researchChangeImpact, setResearchInput } from "./task-graph";

export type SynthesisProject = ResearchProject &
  ResearchLiteratureToolState & { synthesis?: ResearchSynthesis };
export { SYNTHESIS_OPERATIONS };
export const RESEARCH_SYNTHESIS_BOUNDARY =
  "程序只验证实际来源、UTF-16/SHA、本人原生读取、明确影响范围及版本链。共识、分歧、缺口与矛盾是具名模型语义判断，不是程序发现矛盾或人类专家确认。课程知识和 AI 阅读卡只能辅助定位，不能替代 paper 原始来源。";
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const digest = (value: unknown) => researchHash(JSON.stringify(canonical(value)));
const depthRank: Record<ResearchClaimDepth, number> = {
  metadata: 0,
  abstract: 1,
  "partial-text": 2,
  "full-text": 3,
};
const occurred = (at: string, before: string) =>
  Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.parse(before);
const operationId = (p: SynthesisProject, role: ResearchRole, callId: string) =>
  `synthesis:${digest([p.id, role, callId])}`;
export function createResearchSynthesis(): ResearchSynthesis {
  return {
    version: 1,
    reads: [],
    matrices: [],
    gaps: [],
    counterevidence: [],
    responses: [],
    reviews: [],
    resolutions: [],
    operations: [],
  };
}
function one<T>(rows: T[], predicate: (row: T) => boolean, label: string): T {
  const found = rows.filter(predicate);
  if (found.length !== 1) throw new Error(`${label}不是唯一有效记录。`);
  return found[0]!;
}
function boundaries(body: string, start: number, end: number): boolean {
  const boundary = (index: number) =>
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index <= body.length &&
    !(
      index > 0 &&
      index < body.length &&
      /[\uD800-\uDBFF]/.test(body[index - 1]!) &&
      /[\uDC00-\uDFFF]/.test(body[index]!)
    );
  return start < end && boundary(start) && boundary(end) && !!body.slice(start, end).trim();
}
function authenticOwner(p: SynthesisProject, owner: ResearchSynthesisOwner): boolean {
  const task = p.fusion?.tasks.find((row) => row.id === owner.taskId);
  const attempt = p.fusion?.attempts.find((row) => row.id === owner.attemptId);
  return (
    owner.projectId === p.id &&
    !!task &&
    task.role === owner.role &&
    task.stage === owner.stage &&
    task.id.startsWith(`v${owner.revision}:`) &&
    attempt?.taskId === task.id &&
    attempt.taskVersion === owner.taskVersion &&
    attempt.nativeRunId === owner.nativeRunId &&
    attempt.model?.provider === owner.model.provider &&
    attempt.model.modelId === owner.model.modelId &&
    p.members.filter((row) => row.role === owner.role && row.ref.sessionId === owner.sessionId)
      .length === 1 &&
    owner.inputs.every(
      (pin) =>
        p.fusion!.inputs.some(
          (row) =>
            row.inputId === pin.inputId && row.version === pin.version && row.digest === pin.digest,
        ) &&
        [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].some(
          (row) => row.inputId === pin.inputId && row.version === pin.version,
        ),
    )
  );
}
/** Capture on the owner queue before starting source-read I/O; legacy callers need not use this hook. */
export function captureResearchSynthesisOwner(
  p: SynthesisProject,
  role: ResearchRole,
): ResearchSynthesisOwner {
  const member = p.members.filter((row) => row.role === role);
  const attempt = activeFusionAttempt(p, role);
  const task = p.fusion?.tasks.find((row) => row.id === attempt?.taskId);
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    member.length !== 1 ||
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    !attempt.nativeRunId?.trim() ||
    !attempt.model?.provider.trim() ||
    !attempt.model.modelId.trim() ||
    task.role !== role ||
    !task.id.startsWith(`v${p.revision}:`) ||
    attempt.taskVersion !== task.inputVersion ||
    !attempt.dispatchedAt ||
    !Number.isFinite(Date.parse(attempt.dispatchedAt))
  )
    throw new Error("综合操作需要当前输入版本、真实原生执行尝试及宿主模型身份。");
  const inputs = new Map<string, ResearchSynthesisOwner["inputs"][number]>();
  for (const ref of [...task.inputs, ...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])]) {
    const pin = one(
      p.fusion!.inputs,
      (row) => row.inputId === ref.inputId && row.version === ref.version,
      "综合输入",
    );
    if (
      !p.fusion!.adoptedInputs.some(
        (row) => row.inputId === ref.inputId && row.version === ref.version,
      ) ||
      (inputs.has(ref.inputId) && inputs.get(ref.inputId)!.version !== ref.version)
    )
      throw new Error("综合任务实际输入已失效。");
    inputs.set(ref.inputId, { inputId: ref.inputId, version: ref.version, digest: pin.digest });
  }
  const result: ResearchSynthesisOwner = {
    projectId: p.id,
    revision: p.revision,
    role,
    stage: task.stage,
    sessionId: member[0]!.ref.sessionId,
    taskId: task.id,
    taskVersion: task.inputVersion,
    attemptId: attempt.id,
    nativeRunId: attempt.nativeRunId,
    model: { provider: attempt.model.provider, modelId: attempt.model.modelId },
    inputs: [...inputs.values()].sort((a, b) => a.inputId.localeCompare(b.inputId)),
  };
  if (!authenticOwner(p, result)) throw new Error("综合 native 与实际输入固定关系不符。");
  return structuredClone(result);
}
function sameNative(a: ResearchSynthesisOwner, b: ResearchSynthesisOwner): boolean {
  const { inputs: ai, ...ac } = a,
    { inputs: bi, ...bc } = b;
  return (
    isDeepStrictEqual(ac, bc) &&
    ai.every((pin) => bi.some((other) => isDeepStrictEqual(pin, other)))
  );
}
function requireOwner(
  p: SynthesisProject,
  captured: ResearchSynthesisOwner,
): ResearchSynthesisOwner {
  const current = captureResearchSynthesisOwner(p, captured.role);
  if (!sameNative(captured, current))
    throw new Error("读取期间 native、模型、任务或输入版本已变化；旧请求不能采用当前结果。");
  return current;
}
/** Call after the existing source-read has stored its real receipt, inside the same durable mutation. */
export function recordResearchSynthesisSourceRead(
  p: SynthesisProject,
  captured: ResearchSynthesisOwner,
  readId: string,
): void {
  const owner = requireOwner(p, captured);
  const receipt = one(p.sourceReads ?? [], (row) => row.id === readId, "实际原文读取");
  const source = one(p.evidence?.sources ?? [], (row) => row.id === receipt.sourceId, "原文来源");
  const attempt = p.fusion!.attempts.find((row) => row.id === owner.attemptId)!;
  if (
    receipt.sessionId !== owner.sessionId ||
    Date.parse(receipt.at) < Date.parse(attempt.dispatchedAt!) ||
    !Number.isFinite(Date.parse(receipt.at)) ||
    receipt.sourceSha256 !== source.sha256 ||
    !owner.inputs.some(
      (pin) => pin.inputId === `source:${source.id}` && pin.digest === source.sha256,
    )
  )
    throw new Error("原文读取不属于本 native 的实际来源版本，历史读取保留但不能采用。");
  const next = decodeResearchSynthesis(p.synthesis ?? createResearchSynthesis());
  const binding = { id: receipt.id, receipt: structuredClone(receipt), owner };
  const prior = next.reads.find((row) => row.id === receipt.id);
  if (prior && !isDeepStrictEqual(prior, binding))
    throw new Error("原文读取 native 绑定不可改写。");
  if (!prior) next.reads.push(binding);
  p.synthesis = decodeResearchSynthesis(next);
}

function draftPin(p: SynthesisProject, id: string, current = true): ResearchSynthesisDraft {
  const artifact = one(p.artifacts, (row) => row.id === id, "综合稿件");
  const record = one(p.fusion?.artifacts ?? [], (row) => row.id === id, "固定稿件");
  const task = one(p.fusion?.tasks ?? [], (row) => row.id === record.taskId, "稿件生产任务");
  const attempt = one(
    p.fusion?.attempts ?? [],
    (row) => row.id === record.attemptId,
    "稿件生产尝试",
  );
  if (
    (current && artifact.revision !== p.revision) ||
    record.content !== artifact.content ||
    artifact.role !== task.role ||
    attempt.taskId !== task.id ||
    attempt.taskVersion !== record.taskVersion ||
    (current &&
      (task.currentArtifactId !== id ||
        task.inputVersion !== record.taskVersion ||
        ["needs-review", "superseded"].includes(record.reviewState) ||
        record.inputRefs.some(
          (ref) =>
            !p.fusion!.adoptedInputs.some(
              (adopted) => adopted.inputId === ref.inputId && adopted.version === ref.version,
            ),
        )))
  )
    throw new Error("稿件不是当前固定生产者版本；旧稿或旧请求不能采用。");
  return {
    artifactId: id,
    bodySha256: researchHash(artifact.content),
    taskId: task.id,
    taskVersion: record.taskVersion,
    attemptId: attempt.id,
  };
}
function requireDraftRead(
  p: SynthesisProject,
  owner: ResearchSynthesisOwner,
  pin: ResearchSynthesisDraft,
  at: string,
): void {
  const attempt = p.fusion!.attempts.find((row) => row.id === owner.attemptId)!;
  if (
    !attempt.acquiredArtifacts?.some(
      (read) =>
        read.artifactId === pin.artifactId &&
        occurred(read.at, at) &&
        Date.parse(read.at) >= Date.parse(attempt.dispatchedAt!),
    )
  )
    throw new Error("请先在本 native 用 read 实际读取所审固定稿件；旧稿或他人读取不能代替。");
}
/** A prior accepted baseline reopened by a recorded change is a target, never current support. */
function counterTargetDraftPin(p: SynthesisProject, id: string): ResearchSynthesisDraft {
  try {
    return draftPin(p, id);
  } catch {
    /* Explicit baseline eligibility below. */
  }
  const pin = draftPin(p, id, false);
  const artifact = p.artifacts.find((row) => row.id === id)!;
  const record = p.fusion!.artifacts.find((row) => row.id === id)!;
  const task = p.fusion!.tasks.find((row) => row.id === pin.taskId)!;
  const accepted = record.reviews.filter((review) => review.verdict === "accepted").at(-1);
  if (
    artifact.revision !== p.revision ||
    !task.id.startsWith(`v${p.revision}:`) ||
    record.reviewState !== "needs-review" ||
    !accepted ||
    task.inputVersion <= pin.taskVersion ||
    !p.fusion!.changes.some(
      (change) => change.affectedTaskIds.includes(task.id) && occurred(accepted.at, change.at),
    ) ||
    p.fusion!.artifacts.some(
      (other) =>
        other.taskId === task.id &&
        other.id !== id &&
        (other.taskVersion > pin.taskVersion ||
          Date.parse(other.createdAt) > Date.parse(record.createdAt)) &&
        other.reviews.some((review) => review.verdict === "accepted"),
    )
  )
    throw new Error(
      "反证目标既不是当前稿，也不是被已记录变更重开的本轮已接受基线；旧稿不能借机采用。",
    );
  return pin;
}
const targetReadDetail = (pin: ResearchSynthesisDraft) =>
  `反证历史基线实际阅读；仅用于明确影响目标，不作当前支持；SHA256=${pin.bodySha256}`;
/** Existing read's historical-return branch calls this before returning the actual body. */
export function recordResearchSynthesisTargetRead(
  p: SynthesisProject,
  role: ResearchRole,
  callId: string,
  artifactId: string,
  at: string,
): void {
  let draft: ResearchSynthesisDraft;
  try {
    draft = counterTargetDraftPin(p, artifactId);
  } catch {
    return;
  }
  const owner = captureResearchSynthesisOwner(p, role);
  if (!callId.trim() || !Number.isFinite(Date.parse(at)))
    throw new Error("反证基线实际阅读宿主身份无效。");
  const id = `synthesis-target-read:${digest([p.id, owner.nativeRunId, callId, artifactId])}`;
  const existing = p.events.find((event) => event.id === id);
  if (existing) {
    if (
      existing.runId !== owner.nativeRunId ||
      existing.artifactId !== artifactId ||
      existing.detail !== targetReadDetail(draft)
    )
      throw new Error("反证基线阅读身份不可改写。");
    return;
  }
  p.events.push({
    id,
    at,
    type: "read",
    role,
    revision: p.revision,
    artifactId,
    runId: owner.nativeRunId,
    detail: targetReadDetail(draft),
  });
}
function requireCounterTargetRead(
  p: SynthesisProject,
  owner: ResearchSynthesisOwner,
  pin: ResearchSynthesisDraft,
  at: string,
) {
  try {
    requireDraftRead(p, owner, pin, at);
    return;
  } catch {
    /* Reopened baseline reads cannot become live dependencies. */
  }
  if (
    !p.events.some(
      (event) =>
        event.id.startsWith("synthesis-target-read:") &&
        event.type === "read" &&
        event.role === owner.role &&
        event.revision === owner.revision &&
        event.runId === owner.nativeRunId &&
        event.artifactId === pin.artifactId &&
        event.detail === targetReadDetail(pin) &&
        occurred(event.at, at),
    )
  )
    throw new Error("请在本 native 实际 read 已重开的已接受基线；历史浏览或他人读取不能声明影响。");
}
interface SourceSnapshot {
  id: string;
  sha256: string;
  bodySha256: string;
  body: string;
  depth: ResearchClaimDepth;
  kind: string;
}
async function sourceSnapshots(p: SynthesisProject, sourceIds: string[]) {
  const manifest = structuredClone(p.evidence?.sources ?? []),
    revision = p.revision;
  const sources = await Promise.all(
    [...new Set(sourceIds)].map(async (id): Promise<SourceSnapshot> => {
      const source = one(manifest, (row) => row.id === id, "原始论文来源");
      if (source.kind !== "paper")
        throw new Error("课程方法、AI 阅读卡、设计或稿件不能冒充原始 paper 来源。");
      const body = await readPinnedResearchFile(source);
      return {
        id,
        sha256: source.sha256,
        bodySha256: researchHash(body),
        body,
        depth: researchClaimSourceDepth(source),
        kind: source.kind,
      };
    }),
  );
  if (p.revision !== revision || !isDeepStrictEqual(manifest, p.evidence?.sources ?? []))
    throw new Error("读取期间来源或课题快照已变化。");
  return sources;
}
function readBindingValid(p: SynthesisProject, ledger: ResearchSynthesis, id: string) {
  const bindings = ledger.reads.filter((row) => row.id === id),
    binding = bindings[0];
  if (bindings.length !== 1 || !binding || !authenticOwner(p, binding.owner)) return undefined;
  const receipts = (p.sourceReads ?? []).filter((row) => row.id === id);
  const attempt = p.fusion?.attempts.find((row) => row.id === binding.owner.attemptId);
  return receipts.length === 1 &&
    isDeepStrictEqual(receipts[0], binding.receipt) &&
    binding.receipt.sessionId === binding.owner.sessionId &&
    !!attempt?.dispatchedAt &&
    Date.parse(binding.receipt.at) >= Date.parse(attempt.dispatchedAt) &&
    binding.owner.inputs.some(
      (pin) =>
        pin.inputId === `source:${binding.receipt.sourceId}` &&
        pin.digest === binding.receipt.sourceSha256,
    )
    ? binding
    : undefined;
}
function pinEvidence(
  p: SynthesisProject,
  ledger: ResearchSynthesis,
  sources: SourceSnapshot[],
  owner: ResearchSynthesisOwner,
  ref: ResearchSynthesisSourceRef,
  at: string,
): ResearchSynthesisEvidence {
  const source = one(sources, (row) => row.id === ref.sourceId, "原文正文快照");
  if (
    ref.locatorId !== `text:${source.id}` ||
    !boundaries(source.body, ref.start, ref.end) ||
    depthRank[ref.requiredDepth] > depthRank[source.depth]
  )
    throw new Error("原文定位、UTF-16 边界或实际深度无效；摘要/部分正文不能冒充全文。");
  const reads = ledger.reads
    .filter((binding) => {
      const valid = readBindingValid(p, ledger, binding.id),
        read = valid?.receipt;
      return (
        valid &&
        read &&
        sameNative(valid.owner, owner) &&
        valid.owner.inputs.some(
          (pin) =>
            pin.inputId === `source:${source.id}` &&
            pin.digest === source.sha256 &&
            p.fusion!.adoptedInputs.some(
              (adopted) => adopted.inputId === pin.inputId && adopted.version === pin.version,
            ),
        ) &&
        read.sourceId === source.id &&
        read.sourceSha256 === source.sha256 &&
        read.bodySha256 === source.bodySha256 &&
        read.locatorId === ref.locatorId &&
        read.start >= 0 &&
        read.end <= source.body.length &&
        boundaries(source.body, read.start, read.end) &&
        depthRank[read.depth] >= depthRank[ref.requiredDepth] &&
        depthRank[read.depth] <= depthRank[source.depth] &&
        occurred(read.at, at)
      );
    })
    .sort((a, b) => a.receipt.start - b.receipt.start || b.receipt.end - a.receipt.end);
  let end = ref.start;
  const used: string[] = [];
  for (const binding of reads) {
    if (binding.receipt.end <= end) continue;
    if (binding.receipt.start > end) break;
    used.push(binding.id);
    end = binding.receipt.end;
    if (end >= ref.end) break;
  }
  if (end < ref.end)
    throw new Error(
      "缺少本 native 本人覆盖具体原文范围的真实 sourceReads；不能借用旧请求或他人读取。",
    );
  return {
    ...ref,
    sourceSha256: source.sha256,
    bodySha256: source.bodySha256,
    exactText: source.body.slice(ref.start, ref.end),
    readIds: used,
  };
}
function refOnly(e: ResearchSynthesisEvidence): ResearchSynthesisSourceRef {
  const { sourceId, locatorId, start, end, requiredDepth } = e;
  return { sourceId, locatorId, start, end, requiredDepth };
}
function evidenceCurrent(
  p: SynthesisProject,
  ledger: ResearchSynthesis,
  sources: SourceSnapshot[],
  evidence: ResearchSynthesisEvidence,
  host: ResearchSynthesisHost,
): boolean {
  try {
    const pinned = pinEvidence(p, ledger, sources, host.owner, refOnly(evidence), host.at);
    return isDeepStrictEqual(pinned, evidence);
  } catch {
    return false;
  }
}
function immutable<T extends { id: string }>(rows: T[], item: T) {
  const previous = rows.find((row) => row.id === item.id);
  if (previous && !isDeepStrictEqual(previous, item))
    throw new Error("综合身份不可改写；修订必须新建版本。");
  if (!previous) rows.push(item);
}
function currentClaim(p: SynthesisProject, id: string, counterTarget = false): ResearchClaim {
  const claim = one(p.claims?.claims ?? [], (row) => row.id === id, "已有主张");
  const pin = counterTarget
    ? counterTargetDraftPin(p, claim.artifactId)
    : draftPin(p, claim.artifactId);
  const body = p.artifacts.find((row) => row.id === claim.artifactId)!.content;
  if (pin.bodySha256 !== claim.bodySha256 || body.slice(claim.start, claim.end) !== claim.exactText)
    throw new Error("已有主张指向旧稿或失效位置。");
  return claim;
}
function leaf<T extends { id: string; supersedesId?: string }>(
  rows: T[],
  id: string,
  label: string,
): T {
  const row = one(rows, (entry) => entry.id === id, label);
  if (rows.some((entry) => entry.supersedesId === id)) throw new Error(`${label}已被新版本替代。`);
  return row;
}
function sameReplacements(pairs: { beforeId: string; afterId: string }[], targets: string[]) {
  if (
    pairs.length !== targets.length ||
    new Set(pairs.map((pair) => pair.beforeId)).size !== pairs.length ||
    pairs.some((pair) => !targets.includes(pair.beforeId) || pair.beforeId === pair.afterId)
  )
    throw new Error("回应必须逐项关联所有受影响对象的前后版本，不能仅附参考文献。");
}
function gapDescends(ledger: ResearchSynthesis, id: string, beforeId: string): boolean {
  const seen = new Set<string>();
  let next: string | undefined = id;
  while (next && !seen.has(next)) {
    if (next === beforeId) return true;
    seen.add(next);
    next = ledger.gaps.find((row) => row.id === next)?.supersedesId;
  }
  return false;
}
function currentSearchBatch(p: SynthesisProject, id: string) {
  const batch = one(
    p.literatureSearch?.batches ?? [],
    (row) => row.id === id && row.status === "succeeded",
    "实际反向检索批次",
  );
  const op = one(
    p.literatureToolOperations ?? [],
    (row) =>
      row.id === id &&
      !row.historical &&
      ["literature-search", "literature-import"].includes(row.operation),
    "真实检索宿主调用",
  );
  const strategy = p.literatureSearch?.strategies.find(
    (row) => row.id === batch.strategyId && row.version === batch.strategyVersion,
  );
  if (
    !authenticOwner(p, op.scope) ||
    op.scope.revision !== p.revision ||
    !strategy?.questionVersion.startsWith(`project:${p.id}:revision:${p.revision}:`) ||
    op.scope.inputs.some(
      (pin) =>
        !p.fusion?.adoptedInputs.some(
          (row) => row.inputId === pin.inputId && row.version === pin.version,
        ),
    )
  )
    throw new Error("反向检索属于旧问题或迟到请求，保留记录但不能采用当前缺口支持。");
  return batch;
}
function view<T>(entry: T): unknown {
  // Excerpts are delivered only through real source-read, even when guessed offsets are submitted.
  return JSON.parse(
    JSON.stringify(entry, (key: string, value: unknown) =>
      key === "exactText" ? undefined : value,
    ),
  );
}

/** Strict synchronous persistence check. Historical scopes need not be the active attempt. */
export function validateResearchSynthesisProject(p: SynthesisProject): void {
  if (!p.synthesis) return;
  const ledger = decodeResearchSynthesis(p.synthesis);
  const hostValid = (host: ResearchSynthesisHost) => {
    if (!authenticOwner(p, host.owner))
      throw new Error("综合保存记录的 native/模型/输入身份不符。");
    const attempt = p.fusion!.attempts.find((row) => row.id === host.owner.attemptId)!;
    if (!attempt.dispatchedAt || Date.parse(host.at) < Date.parse(attempt.dispatchedAt))
      throw new Error("综合记录早于实际原生派发。");
  };
  for (const read of ledger.reads)
    if (!readBindingValid(p, ledger, read.id))
      throw new Error("综合原文读取凭据或 native 绑定已损坏。");
  for (const entries of [ledger.matrices, ledger.gaps])
    for (const row of entries) {
      hostValid(row.host);
      if (row.host.owner.role !== "lead") throw new Error("综合矩阵和候选缺口不是 A 本人提交。");
      if (!isDeepStrictEqual(draftPin(p, row.artifactId, false), row.draft))
        throw new Error("综合原稿固定摘要已改变。");
      if (
        row.supersedesId &&
        (!entries.some(
          (prior) =>
            prior.id === row.supersedesId && Date.parse(prior.host.at) <= Date.parse(row.host.at),
        ) ||
          row.supersedesId === row.id ||
          entries.filter((other) => other.supersedesId === row.supersedesId).length > 1)
      )
        throw new Error("综合前后版本链无效。");
    }
  for (const gap of ledger.gaps) {
    if (
      !gap.matrixIds.length ||
      gap.matrixIds.some(
        (id) =>
          !ledger.matrices.some(
            (matrix) => matrix.id === id && matrix.artifactId === gap.artifactId,
          ),
      ) ||
      gap.claimIds.some(
        (id) =>
          !p.claims?.claims.some((claim) => claim.id === id && claim.artifactId === gap.artifactId),
      )
    )
      throw new Error("候选缺口综合或主张依赖丢失。");
    if (
      gap.searchPins.some(
        (pin) =>
          digest(p.literatureSearch?.batches.find((batch) => batch.id === pin.id)) !== pin.sha256,
      )
    )
      throw new Error("候选缺口实际反向检索批次已改变。");
  }
  for (const challenge of ledger.counterevidence) {
    hostValid(challenge.host);
    if (challenge.host.owner.role !== "reviewer" && challenge.host.owner.role !== "librarian")
      throw new Error("反证声明不是 B 或资料员本人提交。");
    if (
      !isDeepStrictEqual(draftPin(p, challenge.target.artifactId, false), challenge.target) ||
      challenge.targetClaimPins.some(
        (pin) => digest(p.claims?.claims.find((claim) => claim.id === pin.id)) !== pin.sha256,
      ) ||
      challenge.targetGapPins.some(
        (pin) => digest(ledger.gaps.find((gap) => gap.id === pin.id)) !== pin.sha256,
      )
    )
      throw new Error("反证原主张或候选缺口快照改变。");
    const change = p.fusion?.changes.find((row) => row.id === challenge.changeId);
    if (
      !change ||
      !isDeepStrictEqual(change.affectedTaskIds, challenge.impact.affectedTaskIds) ||
      change.authorizationRef !== `synthesis-counterevidence:${challenge.id}`
    )
      throw new Error("反证局部影响没有既有任务图采用记录。");
  }
  for (const response of ledger.responses) {
    hostValid(response.host);
    const challenge = ledger.counterevidence.find((row) => row.id === response.counterevidenceId);
    if (
      response.host.owner.role !== "lead" ||
      !challenge ||
      response.draft.taskId !== challenge.target.taskId ||
      response.draft.taskVersion <= challenge.target.taskVersion ||
      !isDeepStrictEqual(draftPin(p, response.artifactId, false), response.draft) ||
      p.artifacts
        .find((row) => row.id === response.artifactId)!
        .content.slice(response.start, response.end) !== response.exactText
    )
      throw new Error("A 的反证回应或实际新稿位置无效。");
    sameReplacements(response.claimReplacements, challenge.claimIds);
    sameReplacements(response.gapReplacements, challenge.gapIds);
    if (
      response.claimReplacements.some(
        (pair) =>
          !p.claims?.claims.some(
            (claim) => claim.id === pair.afterId && claim.artifactId === response.artifactId,
          ),
      ) ||
      response.gapReplacements.some(
        (pair) =>
          !ledger.gaps.some(
            (gap) =>
              gap.id === pair.afterId &&
              gap.artifactId === response.artifactId &&
              gapDescends(ledger, gap.id, pair.beforeId),
          ),
      )
    )
      throw new Error("反证回应的前后主张或候选缺口依赖丢失。");
  }
  for (const review of ledger.reviews) {
    hostValid(review.host);
    const response = ledger.responses.find((row) => row.id === review.responseId);
    if (
      review.host.owner.role !== "reviewer" ||
      !response ||
      digest(response) !== review.responseSha256 ||
      p.artifacts
        .find((row) => row.id === response.artifactId)!
        .content.slice(review.start, review.end) !== review.exactText
    )
      throw new Error("B 的反证复核未固定实际新稿。");
  }
  for (const resolution of ledger.resolutions) {
    hostValid(resolution.host);
    if (
      resolution.host.owner.role !== "mentor" ||
      digest(ledger.reviews.find((row) => row.id === resolution.reviewId)) !==
        resolution.reviewSha256
    )
      throw new Error("导师反证处理未固定 B 的复核。");
  }
  for (const op of ledger.operations) {
    hostValid(op.host);
    if (op.id !== operationId(p, op.host.owner.role, op.host.callId))
      throw new Error("综合宿主调用身份不符。");
    const list =
      op.operation === "synthesis-matrix"
        ? ledger.matrices
        : op.operation === "synthesis-gap"
          ? ledger.gaps
          : op.operation === "synthesis-counterevidence"
            ? ledger.counterevidence
            : op.operation === "synthesis-respond"
              ? ledger.responses
              : op.operation === "synthesis-review"
                ? ledger.reviews
                : ledger.resolutions;
    if (!list.some((row) => row.id === op.recordId && isDeepStrictEqual(row.host, op.host)))
      throw new Error("综合操作没有对应不可变成果。");
  }
}

function allEvidence(ledger: ResearchSynthesis) {
  return [
    ...ledger.matrices.flatMap((matrix) =>
      matrix.rows.flatMap((row) =>
        Object.values(row.cells).flatMap((cell) =>
          "evidence" in cell
            ? cell.evidence.map((e) => ({
                evidence: e,
                host: matrix.host,
                artifactId: matrix.artifactId,
              }))
            : [],
        ),
      ),
    ),
    ...ledger.gaps.flatMap((gap) =>
      gap.evidence.map((evidence) => ({ evidence, host: gap.host, artifactId: gap.artifactId })),
    ),
  ];
}
/** Owner gate. Checking does not grant source text or manufacture read receipts. */
export async function researchSynthesisArtifactStatus(p: SynthesisProject, artifactId: string) {
  validateResearchSynthesisProject(p);
  const ledger = p.synthesis ?? createResearchSynthesis();
  const record = p.fusion?.artifacts.find((row) => row.id === artifactId);
  if (p.synthesis && !record) throw new Error("正式接受目标缺少固定任务稿件。");
  const challenges = ledger.counterevidence.filter((row) =>
    row.impact.affectedTaskIds.includes(record?.taskId ?? ""),
  );
  const evidence = allEvidence(ledger).filter((row) => row.artifactId === artifactId);
  const sourceIds = [
    ...evidence.map((row) => row.evidence.sourceId),
    ...challenges.map((row) => row.source.sourceId),
  ];
  const sources: SourceSnapshot[] = [];
  const unavailable: string[] = [];
  for (const id of new Set(sourceIds)) {
    try {
      sources.push(...(await sourceSnapshots(p, [id])));
    } catch {
      unavailable.push(id);
    }
  }
  const blockers: {
    code: string;
    detail: string;
    counterevidenceId?: string;
    sourceId?: string;
  }[] = [];
  for (const row of evidence)
    if (!evidenceCurrent(p, ledger, sources, row.evidence, row.host))
      blockers.push({
        code: "synthesis-source-stale",
        sourceId: row.evidence.sourceId,
        detail: "综合矩阵/缺口的原文、读取范围或深度已失效，旧版本判断不能采用。",
      });
  for (const gap of ledger.gaps.filter(
    (row) => row.artifactId === artifactId && row.state === "supported-in-scope",
  )) {
    try {
      if (
        !gap.searchPins.length ||
        gap.searchPins.some((pin) => digest(currentSearchBatch(p, pin.id)) !== pin.sha256)
      )
        throw new Error();
    } catch {
      blockers.push({
        code: "synthesis-reverse-search-stale",
        detail: "候选缺口的实际反向检索范围属于旧问题、迟到请求或已失效版本。",
      });
    }
  }
  for (const challenge of challenges) {
    const issue = (code: string, detail: string) =>
      blockers.push({ code, detail, counterevidenceId: challenge.id });
    if (!evidenceCurrent(p, ledger, sources, challenge.source, challenge.host)) {
      issue("counterevidence-source-stale", "原反证来源/读取凭据已失效，须重新明确当前依据。");
      continue;
    }
    const response = ledger.responses
      .filter((row) => row.counterevidenceId === challenge.id)
      .at(-1);
    if (!response) {
      issue("counterevidence-response-missing", "新反证尚无 A 在实际新稿中的具名回应。");
      continue;
    }
    try {
      if (!isDeepStrictEqual(draftPin(p, response.artifactId), response.draft)) throw new Error();
    } catch {
      issue("counterevidence-response-stale", "A 回应指向旧稿；当前新稿必须重新回应并复核。");
      continue;
    }
    if (!evidenceCurrent(p, ledger, sources, response.source, response.host)) {
      issue("counterevidence-response-read-stale", "A 的回应未保持原反证当前版本与本人实际读取。");
      continue;
    }
    const review = ledger.reviews.filter((row) => row.responseId === response.id).at(-1);
    if (
      !review ||
      review.conclusion !== "addressed" ||
      digest(response) !== review.responseSha256 ||
      !evidenceCurrent(p, ledger, sources, review.source, review.host)
    ) {
      issue(
        "counterevidence-review-open",
        "B 尚未在本人读过原反证和当前新稿后具体关闭问题；导师 accept 不能绕过。",
      );
      continue;
    }
    if (challenge.materialChange) {
      const resolution = ledger.resolutions.filter((row) => row.reviewId === review.id).at(-1);
      if (
        !resolution ||
        resolution.decision !== "close" ||
        digest(review) !== resolution.reviewSha256 ||
        !evidenceCurrent(p, ledger, sources, resolution.source, resolution.host)
      )
        issue("counterevidence-mentor-open", "实质变化尚无导师对当前 A/B 版本的具名处理。");
    }
  }
  return {
    artifactId,
    blockers,
    blocksFormalAcceptance: blockers.length > 0,
    unavailableSourceIds: unavailable,
    counterevidenceIds: challenges.map((row) => row.id),
    requiresContentReview: true as const,
    boundary: RESEARCH_SYNTHESIS_BOUNDARY,
  };
}
/** Invoke in every formal accept route, before recording an accepted decision. */
export async function assertResearchSynthesisAcceptance(
  p: SynthesisProject,
  artifactId: string,
): Promise<void> {
  const status = await researchSynthesisArtifactStatus(p, artifactId);
  if (status.blocksFormalAcceptance)
    throw new Error(
      `相反证据局部重审未关闭：${status.blockers.map((issue) => `${issue.counterevidenceId ?? issue.sourceId ?? artifactId} ${issue.detail}`).join("；")}`,
    );
}

/** Call within the coordinator durable mutation. File verification never creates a model read. */
export async function applyResearchSynthesisTool(
  p: SynthesisProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): Promise<{ result: unknown; detail?: string }> {
  if (
    !(SYNTHESIS_OPERATIONS as readonly unknown[]).includes(input.operation) ||
    !callId.trim() ||
    !Number.isFinite(Date.parse(at))
  )
    throw new Error("综合操作、宿主调用或时间无效。");
  const operation = input.operation as (typeof SYNTHESIS_OPERATIONS)[number];
  if (
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" ||
        ![
          "operation",
          "executionModel",
          ...(operation === "synthesis-context" ? [] : ["request"]),
        ].includes(key),
    )
  )
    throw new Error("综合请求不能自填读取、摘要、身份或影响范围等宿主字段。");
  validateResearchSynthesisProject(p);
  const ledger = decodeResearchSynthesis(p.synthesis ?? createResearchSynthesis());
  if (operation === "synthesis-context") {
    const owner = captureResearchSynthesisOwner(p, role);
    const peerJudgments = [
      ...ledger.matrices,
      ...ledger.gaps,
      ...ledger.counterevidence,
      ...ledger.responses,
      ...ledger.reviews,
      ...ledger.resolutions,
    ].some(
      (row) =>
        row.host.owner.revision === p.revision &&
        row.host.owner.stage === owner.stage &&
        row.host.owner.role !== role,
    );
    if (peerJudgments && !hasStageIndependentJudgment(p, role, owner.stage))
      throw new Error("先提交本阶段独立判断，再读取其他成员的综合、缺口或反证意见。");
    const visible = (row: { host: ResearchSynthesisHost }) =>
      row.host.owner.role === role ||
      canReadResearchPeerJudgment(p, role, row.host.owner.stage, owner.stage);
    const available = {
      ...ledger,
      matrices: ledger.matrices.filter(visible),
      gaps: ledger.gaps.filter(visible),
      counterevidence: ledger.counterevidence.filter(visible),
      responses: ledger.responses.filter(visible),
      reviews: ledger.reviews.filter(visible),
      resolutions: ledger.resolutions.filter(visible),
      operations: ledger.operations.filter(visible),
    };
    // Navigation keeps every receipt and native identity. Full input pins remain
    // in the validated ledger; repeating them for every prior read grants no authority.
    const reads = available.reads.map(({ owner: readOwner, ...binding }) => {
      const { inputs, ...identity } = readOwner;
      return {
        ...binding,
        owner: { ...identity, inputCount: inputs.length, inputPinsSha256: digest(inputs) },
      };
    });
    return {
      result: {
        ...(view({ ...available, reads }) as object),
        owner,
        boundary: RESEARCH_SYNTHESIS_BOUNDARY,
      },
    };
  }
  const request = decodeResearchSynthesisRequest(operation, input.request) as { id: string };
  const replayId = operationId(p, role, callId),
    requestSha256 = digest({ operation, request });
  const replay = ledger.operations.find((row) => row.id === replayId);
  if (replay) {
    if (replay.requestSha256 !== requestSha256) throw new Error("综合宿主调用身份已用于不同请求。");
    return {
      result: {
        alreadyApplied: true,
        recordId: replay.recordId,
        boundary: RESEARCH_SYNTHESIS_BOUNDARY,
      },
    };
  }
  const owner = captureResearchSynthesisOwner(p, role);
  const host: ResearchSynthesisHost = { callId, at, owner, judgment: "model-semantic-review" };
  if (
    Date.parse(at) <
    Date.parse(p.fusion!.attempts.find((row) => row.id === owner.attemptId)!.dispatchedAt!)
  )
    throw new Error("综合调用早于当前 native 派发。");
  const oldLedger = digest(ledger),
    artifactSnapshot = digest(p.artifacts),
    graphSnapshot = digest(p.fusion);
  const sourceIds: string[] = [];
  if (operation === "synthesis-matrix")
    for (const row of (request as ResearchSynthesisMatrixRequest).rows)
      for (const cell of Object.values(row.cells))
        if ("evidence" in cell) sourceIds.push(...cell.evidence.map((e) => e.sourceId));
  if (operation === "synthesis-gap")
    sourceIds.push(...(request as ResearchCandidateGapRequest).evidence.map((e) => e.sourceId));
  if (operation === "synthesis-counterevidence")
    sourceIds.push((request as ResearchCounterevidenceRequest).source.sourceId);
  let challenge: ResearchCounterevidence | undefined;
  let response: ResearchCounterevidenceResponse | undefined;
  let review: ResearchCounterevidenceReview | undefined;
  if (operation === "synthesis-respond")
    challenge = one(
      ledger.counterevidence,
      (row) => row.id === (request as ResearchCounterevidenceResponseRequest).counterevidenceId,
      "反证问题",
    );
  if (operation === "synthesis-review") {
    response = one(
      ledger.responses,
      (row) => row.id === (request as ResearchCounterevidenceReviewRequest).responseId,
      "A 的回应",
    );
    challenge = one(
      ledger.counterevidence,
      (row) => row.id === response!.counterevidenceId,
      "反证问题",
    );
  }
  if (operation === "synthesis-resolve") {
    review = one(
      ledger.reviews,
      (row) => row.id === (request as ResearchCounterevidenceResolutionRequest).reviewId,
      "B 的复核",
    );
    response = one(ledger.responses, (row) => row.id === review!.responseId, "A 的回应");
    challenge = one(
      ledger.counterevidence,
      (row) => row.id === response!.counterevidenceId,
      "反证问题",
    );
  }
  if (challenge) sourceIds.push(challenge.source.sourceId);
  const sources = await sourceSnapshots(p, sourceIds);
  requireOwner(p, owner);
  if (
    digest(p.synthesis ?? createResearchSynthesis()) !== oldLedger ||
    digest(p.artifacts) !== artifactSnapshot ||
    digest(p.fusion) !== graphSnapshot
  )
    throw new Error("综合读取期间依赖、稿件或账本变化，请重试当前版本。");
  const pin = (ref: ResearchSynthesisSourceRef) => pinEvidence(p, ledger, sources, owner, ref, at);
  let result: unknown;
  let nextGraph = p.fusion!;
  if (operation === "synthesis-matrix") {
    if (role !== "lead") throw new Error("综合矩阵由真实 A 会话登记。");
    const r = request as ResearchSynthesisMatrixRequest,
      draft = draftPin(p, r.artifactId);
    if (p.artifacts.find((row) => row.id === r.artifactId)!.role !== "lead")
      throw new Error("综合矩阵必须绑定 A 的实际稿件。");
    requireDraftRead(p, owner, draft, at);
    if (r.supersedesId) leaf(ledger.matrices, r.supersedesId, "前版综合矩阵");
    const rows = r.rows.map((row) => {
      let known = 0;
      const cells = Object.fromEntries(
        RESEARCH_SYNTHESIS_COLUMNS.map((column) => {
          const cell = row.cells[column];
          if ("unavailable" in cell) return [column, cell];
          if (cell.evidence.some((ref) => ref.sourceId !== row.sourceId))
            throw new Error("矩阵行不能借用另一来源支撑本论文事实。");
          known++;
          return [column, { summary: cell.summary, evidence: cell.evidence.map(pin) }];
        }),
      ) as Record<(typeof RESEARCH_SYNTHESIS_COLUMNS)[number], ResearchSynthesisCell>;
      if (!known) throw new Error("矩阵行至少需要一处实际可读来源，不能全是空题录。");
      return { sourceId: row.sourceId, cells };
    });
    const matrix: ResearchSynthesisMatrix = { ...r, rows, draft, host };
    immutable(ledger.matrices, matrix);
    result = matrix;
  } else if (operation === "synthesis-gap") {
    if (role !== "lead") throw new Error("候选缺口由真实 A 会话登记。");
    const r = request as ResearchCandidateGapRequest,
      draft = draftPin(p, r.artifactId);
    requireDraftRead(p, owner, draft, at);
    if (r.supersedesId) leaf(ledger.gaps, r.supersedesId, "前版候选缺口");
    if (
      !r.matrixIds.length ||
      r.matrixIds.some((id) => leaf(ledger.matrices, id, "综合矩阵").artifactId !== r.artifactId) ||
      r.claimIds.some((id) => currentClaim(p, id).artifactId !== r.artifactId)
    )
      throw new Error("候选缺口必须依赖本稿实际综合矩阵和主张。");
    if (
      (r.state !== "pending-validation" && !r.evidence.length) ||
      (r.state === "supported-in-scope" && !r.counterSearchBatchIds.length)
    )
      throw new Error("候选缺口有支持状态需要原文及实际反向检索范围，不能把未搜到当作从未研究。");
    if (r.counterSearchBatchIds.length) {
      if (!p.literatureSearch) throw new Error("尚无真实检索账本。");
      reportResearchLiteratureSearch(p.literatureSearch);
    }
    const searchPins = r.counterSearchBatchIds.map((id) => {
      const batch = currentSearchBatch(p, id);
      return { id, sha256: digest(batch) };
    });
    const gap: ResearchCandidateGap = {
      ...r,
      evidence: r.evidence.map(pin),
      searchPins,
      draft,
      host,
    };
    immutable(ledger.gaps, gap);
    result = gap;
  } else if (operation === "synthesis-counterevidence") {
    if (role !== "reviewer" && role !== "librarian")
      throw new Error("反证须由实际读取原文的 B 或资料员明确声明，程序不自动判断矛盾。");
    const r = request as ResearchCounterevidenceRequest,
      source = pin(r.source);
    const claims = r.claimIds.map((id) => currentClaim(p, id, true));
    const gaps = r.gapIds.map((id) => {
      const gap = leaf(ledger.gaps, id, "候选缺口");
      counterTargetDraftPin(p, gap.artifactId);
      return gap;
    });
    const artifacts = new Set([
      ...claims.map((row) => row.artifactId),
      ...gaps.map((row) => row.artifactId),
    ]);
    if (artifacts.size !== 1)
      throw new Error("一次反证只关联同一当前综合稿的明确对象；其他稿件单独声明影响。");
    const target = counterTargetDraftPin(p, [...artifacts][0]!);
    requireCounterTargetRead(p, owner, target, at);
    if (
      claims.some((claim) =>
        claim.evidence.some(
          (e) =>
            e.kind === "source" &&
            e.sourceId === source.sourceId &&
            e.sourceSha256 === source.sourceSha256,
        ),
      ) ||
      gaps.some((gap) =>
        gap.evidence.some(
          (e) => e.sourceId === source.sourceId && e.sourceSha256 === source.sourceSha256,
        ),
      )
    )
      throw new Error("此反证已是目标原有依赖；新反证不能重报已有来源。");
    const selectedClaims = {
      ...createResearchClaims(),
      claims,
      reviews: (p.claims?.reviews ?? []).filter((row) => r.claimIds.includes(row.claimId)),
    };
    const projected = projectResearchClaimSourceImpact(selectedClaims, {
      sourceId: source.sourceId,
      sourceSha256: source.sourceSha256,
      reason: r.reason,
      additionalClaimIds: r.claimIds,
    });
    const directTaskIds = [
      ...new Set([
        ...projected.affected.map((row) => counterTargetDraftPin(p, row.artifactId).taskId),
        ...gaps.map((gap) => gap.draft.taskId),
      ]),
    ];
    const inputId = `counterevidence:${r.id}`,
      changeId = `counterevidence-change:${r.id}`;
    if (p.fusion!.inputs.some((row) => row.inputId === inputId))
      throw new Error("反证身份已有任务输入，请使用新的不可变身份。");
    const impact = { directTaskIds, ...researchChangeImpact(p.fusion!, inputId, directTaskIds) };
    const item: ResearchCounterevidence = {
      ...r,
      source,
      target,
      targetClaimPins: claims.map((claim) => ({ id: claim.id, sha256: digest(claim) })),
      targetGapPins: gaps.map((gap) => ({ id: gap.id, sha256: digest(gap) })),
      impact,
      changeId,
      host,
    };
    nextGraph = setResearchInput(p.fusion!, {
      inputId,
      version: 1,
      kind: "context",
      availability: "available",
      actual: false,
      label: `具名反证 ${r.id}`,
      sourceRef: `synthesis:${r.id}`,
      digest: digest(item),
    });
    nextGraph = applyResearchChange(nextGraph, {
      id: changeId,
      at,
      inputId,
      fromVersion: null,
      toVersion: 1,
      reason: r.reason,
      authorizedBy: "existing-authorization",
      authorizationRef: `synthesis-counterevidence:${r.id}`,
      additionalTaskIds: directTaskIds,
    });
    // Reuse the graph's version/invalidation machinery. The marker follows only the declared tasks.
    for (const task of nextGraph.tasks.filter((row) => impact.affectedTaskIds.includes(row.id)))
      task.inputs.push({ inputId, version: 1, requirement: "available" });
    immutable(ledger.counterevidence, item);
    result = item;
  } else if (operation === "synthesis-respond") {
    if (role !== "lead" || !challenge) throw new Error("反证必须由真实 A 用新稿回应。");
    const r = request as ResearchCounterevidenceResponseRequest,
      draft = draftPin(p, r.artifactId);
    if (
      draft.taskId !== challenge.target.taskId ||
      draft.taskVersion <= challenge.target.taskVersion ||
      draft.artifactId === challenge.target.artifactId ||
      p.artifacts.find((row) => row.id === draft.artifactId)!.role !== "lead"
    )
      throw new Error("回应必须是受影响任务的新版本 A 实际稿件。");
    requireDraftRead(p, owner, draft, at);
    const body = p.artifacts.find((row) => row.id === r.artifactId)!.content;
    if (!boundaries(body, r.start, r.end)) throw new Error("A 回应缺少实际新稿具体位置。");
    sameReplacements(r.claimReplacements, challenge.claimIds);
    sameReplacements(r.gapReplacements, challenge.gapIds);
    for (const pair of r.claimReplacements)
      if (currentClaim(p, pair.afterId).artifactId !== r.artifactId)
        throw new Error("回应主张未指向新稿。");
    for (const pair of r.gapReplacements) {
      const gap = leaf(ledger.gaps, pair.afterId, "新候选缺口");
      if (gap.artifactId !== r.artifactId || !gapDescends(ledger, gap.id, pair.beforeId))
        throw new Error("候选缺口未保留前后修订链。");
    }
    const item: ResearchCounterevidenceResponse = {
      ...r,
      draft,
      exactText: body.slice(r.start, r.end),
      source: pin(refOnly(challenge.source)),
      host,
    };
    immutable(ledger.responses, item);
    result = item;
  } else {
    if (!challenge || !response) throw new Error("反证复核缺少前版问题及 A 的实际回应。");
    if (
      ledger.responses.filter((row) => row.counterevidenceId === challenge!.id).at(-1)?.id !==
        response.id ||
      !isDeepStrictEqual(draftPin(p, response.artifactId), response.draft)
    )
      throw new Error("只能复核当前最新 A 回应和新稿，旧意见保留历史。");
    requireDraftRead(p, owner, response.draft, at);
    if (operation === "synthesis-review") {
      if (role !== "reviewer") throw new Error("反证复核只能由真实 B 本人提交。");
      const r = request as ResearchCounterevidenceReviewRequest,
        body = p.artifacts.find((row) => row.id === response!.artifactId)!.content;
      if (!boundaries(body, r.start, r.end)) throw new Error("B 的复核需要新稿具体位置和理由。");
      const item: ResearchCounterevidenceReview = {
        ...r,
        exactText: body.slice(r.start, r.end),
        responseSha256: digest(response),
        source: pin(refOnly(challenge.source)),
        host,
      };
      immutable(ledger.reviews, item);
      result = item;
    } else {
      if (role !== "mentor" || !review) throw new Error("实质变化只能由真实导师具名处理。");
      const r = request as ResearchCounterevidenceResolutionRequest;
      if (
        ledger.reviews.filter((row) => row.responseId === response!.id).at(-1)?.id !== review.id ||
        (r.decision === "close" && review.conclusion !== "addressed")
      )
        throw new Error("导师不能用 accept 绕过 B 尚未关闭的具体反证。");
      if (r.direction === "change-question-or-design") {
        const decision = p.fusion?.decisions.find(
          (row) => row.id === r.decisionId && row.actor === "user" && row.outcome === "confirmed",
        );
        if (
          !decision ||
          !p.fusion!.adoptedInputs.some(
            (row) => row.inputId === decision.inputId && row.version === decision.version,
          )
        )
          throw new Error("实质方向改变需要 FR24 已采用的真实用户决定，不能自填授权。");
      }
      const item: ResearchCounterevidenceResolution = {
        ...r,
        reviewSha256: digest(review),
        source: pin(refOnly(challenge.source)),
        host,
      };
      immutable(ledger.resolutions, item);
      result = item;
    }
  }
  ledger.operations.push({ id: replayId, operation, requestSha256, recordId: request.id, host });
  const next = decodeResearchSynthesis(ledger);
  validateResearchSynthesisProject({ ...p, synthesis: next, fusion: nextGraph });
  p.synthesis = next;
  p.fusion = nextGraph;
  if (operation === "synthesis-counterevidence") {
    const recorded = next.counterevidence.find((row) => row.id === request.id)!;
    const stage = p.artifacts.find((row) => row.id === recorded.target.artifactId)?.stage;
    if (stage) p.currentStage = stage;
  }
  return {
    result: { record: view(result), boundary: RESEARCH_SYNTHESIS_BOUNDARY },
    detail: `${role} 登记 ${operation} ${request.id}；实际读取和版本校验不等于程序证明语义。`,
  };
}
