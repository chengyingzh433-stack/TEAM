import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ResearchProject,
  ResearchRole,
  ResearchArtifact,
} from "../../contracts/research-group";
import {
  languageObject,
  languageText,
  decodeResearchLanguageActualRead,
  decodeResearchLanguageRevisions,
  researchLanguageActorKey,
  type ResearchLanguageActor,
  type ResearchLanguageFrozenAnchor,
  type ResearchLanguageSemanticReviewRequest,
} from "../../contracts/research-language-revisions";
import {
  decodeResearchLanguageSelection,
  researchLanguageParagraphs,
  latestResearchLanguageSelection,
  type ResearchLanguageScope,
  type ResearchLanguageSelection,
} from "../../contracts/research-language-tools";
import {
  createResearchLanguageArtifact,
  createResearchLanguageRevision,
  checkResearchLanguageRevision,
  recordResearchLanguageSemanticReview,
  recordResearchLanguageSkip,
  reportResearchLanguageRevision,
} from "./language-revisions";
import { activeFusionAttempt, fusionRoleStage } from "./fusion-task-runtime";
import {
  stageManuscript,
  isCurrentResearchArtifact,
  canReadResearchPeerJudgment,
  hasStageIndependentJudgment,
} from "./paper-pipeline";

function manuscript(p: ResearchProject, id: unknown): ResearchArtifact {
  const a = p.artifacts.find((entry) => entry.id === id);
  if (
    !a ||
    a.revision !== p.revision ||
    a.role !== "lead" ||
    !["stage-draft", "stage-revision"].includes(a.kind) ||
    !["writing", "audit"].includes(a.stage ?? "")
  )
    throw new Error("语言修改只使用本轮实际保存的写作或审阅稿件。");
  return a;
}
function owner(p: ResearchProject, role: ResearchRole) {
  const attempt = activeFusionAttempt(p, role);
  const task = p.fusion?.tasks.find((entry) => entry.id === attempt?.taskId);
  const member = p.members.find((entry) => entry.role === role);
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    !attempt ||
    !task ||
    !member ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !attempt.model ||
    task.role !== role ||
    !task.id.startsWith(`v${p.revision}:`) ||
    attempt.taskVersion !== task.inputVersion ||
    [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].some(
      (ref) =>
        !p.fusion!.adoptedInputs.some(
          (input) => input.inputId === ref.inputId && input.version === ref.version,
        ),
    )
  )
    throw new Error("语言操作需要当前任务的实际原生执行和模型身份。");
  return { attempt, task, member };
}
function actor(p: ResearchProject, role: ResearchRole): ResearchLanguageActor {
  const { attempt, member } = owner(p, role);
  if (role !== "lead" && role !== "reviewer") throw new Error("逐段语义复核由 A/B 本人完成。");
  return {
    kind: "model",
    id: `model:${role}`,
    role,
    sessionId: member.ref.sessionId,
    attemptId: attempt.id,
    nativeRunId: attempt.nativeRunId!,
    model: { provider: attempt.model!.provider, modelId: attempt.model!.modelId },
  };
}
function independent(p: ResearchProject, role: ResearchRole) {
  const stage = fusionRoleStage(p, role) ?? p.currentStage;
  if (role === "reviewer" && !hasStageIndependentJudgment(p, role, stage))
    throw new Error("B 先提交本阶段独立判断，再读取 A 的语言改写及他人意见。");
}
function frozen(body: string, terms: string[]): ResearchLanguageFrozenAnchor[] {
  const anchors: ResearchLanguageFrozenAnchor[] = [];
  for (const term of terms) {
    let offset = 0,
      found = false;
    for (;;) {
      const start = body.indexOf(term, offset);
      if (start < 0) break;
      found = true;
      anchors.push({
        id: `term-${anchors.length + 1}`,
        kind: "term",
        start,
        end: start + term.length,
        exactText: term,
      });
      offset = start + term.length;
    }
    if (!found) throw new Error(`保护词未出现在所选基线：${term}`);
  }
  for (const paragraph of researchLanguageParagraphs(body))
    if (
      /(?:AI|人工智能).{0,30}(?:使用|辅助|生成|披露)|(?:使用|辅助|生成).{0,30}(?:AI|人工智能)/i.test(
        paragraph.exactText,
      )
    )
      anchors.push({
        id: `disclosure-${anchors.length + 1}`,
        kind: "ai-disclosure",
        start: paragraph.start,
        end: paragraph.end,
        exactText: paragraph.exactText,
      });
  return anchors;
}
export function grantResearchLanguageScope(
  p: ResearchProject,
  raw: ResearchLanguageSelection,
  at: string,
) {
  if (p.status === "completed")
    throw new Error(
      "本轮稿件已接受。请在导师会话提交新的修改要求，建立新输入版本后再选段；原接受稿与导出保留。",
    );
  const input = decodeResearchLanguageSelection(raw),
    a = manuscript(p, input.baselineId);
  const baseline = createResearchLanguageArtifact(a.id, a.content);
  if (baseline.bodySha256 !== input.bodySha256) throw new Error("基线已变化，请重新选定范围。");
  const paragraphs = researchLanguageParagraphs(a.content);
  const ranges = paragraphs.filter((range) => input.rangeIds.includes(range.id));
  if (ranges.length !== input.rangeIds.length) throw new Error("所选段落不属于此基线。");
  const id = randomUUID();
  const scope: ResearchLanguageScope = {
    id,
    revision: p.revision,
    baseline,
    ranges,
    authorization: {
      id,
      at,
      kind: "explicit-user-selection",
      sourceRef: `desktop-language-selection:${id}`,
    },
    frozenAnchors: frozen(a.content, input.frozenTerms),
  };
  // Validate selections with the same version/diff contract before saving the host grant.
  createResearchLanguageRevision(
    {
      id: `validate-${id}`,
      baseline,
      target: createResearchLanguageArtifact(`validate-${id}`, baseline.body),
      ranges,
    },
    { at, authorization: scope.authorization, frozenAnchors: scope.frozenAnchors },
  );
  (p.languageScopes ??= []).push(scope);
  return scope;
}
function artifacts(p: ResearchProject) {
  return p.artifacts.map((a) => createResearchLanguageArtifact(a.id, a.content));
}
function currentRevision(p: ResearchProject, id: unknown, role: ResearchRole) {
  const revision = p.languageRevisions?.find((entry) => entry.id === id);
  const target = stageManuscript(p, fusionRoleStage(p, role) ?? p.currentStage);
  if (!revision || target?.id !== revision.target.id)
    throw new Error("语言改写不属于当前稿；新稿需要重新检查和复核。");
  checkResearchLanguageRevision(revision, artifacts(p));
  return revision;
}
export function researchLanguageStatus(p: ResearchProject) {
  return (p.languageRevisions ?? []).map((revision) => {
    const a = p.artifacts.find((entry) => entry.id === revision.target.id);
    const report = reportResearchLanguageRevision(revision, artifacts(p));
    const current = !!a && a.revision === p.revision && stageManuscript(p, a.stage)?.id === a.id;
    return {
      id: revision.id,
      baselineId: revision.baseline.id,
      targetId: revision.target.id,
      programReport: revision.programReport,
      semanticReviews: revision.semanticReviews,
      ...report,
      current,
      status: current ? report.status : "stale",
    };
  });
}
export function skipResearchLanguageRevision(
  p: ResearchProject,
  revisionId: string,
  reason: string,
  at: string,
) {
  if (p.status === "completed")
    throw new Error("本轮稿件已接受，请在导师会话建立新修改版本后处理语言检查。");
  languageText(reason);
  const revision = p.languageRevisions?.find((row) => row.id === revisionId);
  if (!revision) throw new Error("改写检查不存在。");
  const a = manuscript(p, revision.target.id);
  if (stageManuscript(p, a.stage)?.id !== a.id) throw new Error("不能替新稿跳过旧版检查。");
  const updated = recordResearchLanguageSkip(
    revision,
    { classification: "user-skipped", reason },
    {
      id: randomUUID(),
      at,
      actor: { kind: "user", id: `desktop:${p.root.sessionId}` },
      evidenceRef: `desktop-language-skip:${p.id}:${revisionId}`,
    },
  );
  p.languageRevisions![p.languageRevisions!.indexOf(revision)] = updated;
}
export function applyResearchLanguageTool(
  p: ResearchProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
): unknown {
  owner(p, role);
  independent(p, role);
  const { executionModel: _model, ...raw } = input;
  if (raw.operation === "language-context") {
    languageObject(raw, ["operation"]);
    const stage = fusionRoleStage(p, role) ?? p.currentStage;
    const visible = (id: string) =>
      canReadResearchPeerJudgment(
        p,
        role,
        p.artifacts.find((artifact) => artifact.id === id)?.stage,
        stage,
      );
    return {
      scopes: p.languageScopes?.filter((scope) => visible(scope.baseline.id)),
      revisions: researchLanguageStatus(p).filter((revision) => visible(revision.targetId)),
      dispositions: p.languageDispositions?.filter((row) => visible(row.artifactId)),
      currentManuscriptId: stageManuscript(p, fusionRoleStage(p, role) ?? p.currentStage)?.id,
      boundary:
        "程序定位确定性问题和风险候选；每个改动段落由 A/B 本人实读双稿复核。新稿不得继承旧检查。",
    };
  }
  if (raw.operation === "language-register") {
    languageObject(raw, ["operation", "scopeId", "baselineId", "artifactId"]);
    if (role !== "lead") throw new Error("只有 A 可登记实际改写，不能自报授权或他人复核。");
    const target = manuscript(p, raw.artifactId),
      baseline = manuscript(p, raw.baselineId);
    if (
      target.stage !== baseline.stage ||
      target.stage !== (fusionRoleStage(p, role) ?? p.currentStage) ||
      stageManuscript(p, target.stage)?.id !== target.id
    )
      throw new Error("改写基线和当前稿必须属于同一写作阶段。");
    const selected = latestResearchLanguageSelection(p, target.stage);
    let scope =
      raw.scopeId === undefined
        ? (selected ??
          p.languageScopes
            ?.filter((row) => row.revision === p.revision && row.baseline.id === baseline.id)
            .at(-1))
        : p.languageScopes?.find((row) => row.id === raw.scopeId);
    if (!scope && raw.scopeId !== undefined) throw new Error("授权范围不存在。");
    if (selected && (scope?.id !== selected.id || baseline.id !== selected.baseline.id))
      throw new Error("请使用用户最新选定的实际基线和段落；旧的全稿授权不能扩大本次范围。");
    if (!scope) {
      if (
        (p.goal ?? "paper") !== "paper" ||
        p.scope !== "paper" ||
        ["task", "manuscript"].includes(p.entry ?? "")
      )
        throw new Error("限定任务先由用户在正文范围中选定实际段落，不能由模型扩大授权。");
      const id = randomUUID();
      scope = {
        id,
        revision: p.revision,
        baseline: createResearchLanguageArtifact(baseline.id, baseline.content),
        authorization: {
          id,
          at,
          kind: "existing-authorized-scope",
          sourceRef: `research-input:${p.id}:v${p.revision}`,
        },
        ranges: [
          {
            id: "authorized-paper",
            label: "本轮已授权完整论文",
            start: 0,
            end: baseline.content.length,
            exactText: baseline.content,
          },
        ],
        frozenAnchors: frozen(baseline.content, []),
      };
      (p.languageScopes ??= []).push(scope);
    }
    if (
      scope.revision !== p.revision ||
      scope.baseline.id !== baseline.id ||
      scope.baseline.body !== baseline.content
    )
      throw new Error("授权范围不是实际基线版本。");
    const duplicate = p.languageRevisions?.find(
      (row) =>
        row.baseline.id === baseline.id &&
        row.target.id === target.id &&
        row.authorization.id === scope.authorization.id,
    );
    if (duplicate) return duplicate;
    const revision = createResearchLanguageRevision(
      {
        id: randomUUID(),
        baseline: scope.baseline,
        target: createResearchLanguageArtifact(target.id, target.content),
        ranges: scope.ranges,
      },
      { at, authorization: scope.authorization, frozenAnchors: scope.frozenAnchors },
    );
    (p.languageRevisions ??= []).push(revision);
    return { ...revision, report: reportResearchLanguageRevision(revision, artifacts(p)) };
  }
  if (raw.operation === "language-not-applicable") {
    languageObject(raw, ["operation", "artifactId", "reason"]);
    if (role !== "lead") throw new Error("A 记录未进行语言改写的具体原因；不能代用户跳过。");
    languageText(raw.reason);
    const a = manuscript(p, raw.artifactId);
    if (
      stageManuscript(p, a.stage)?.id !== a.id ||
      p.languageRevisions?.some((row) => row.target.id === a.id)
    )
      throw new Error("实际改写须保留检查，不能改称不适用。");
    const row = {
      id: randomUUID(),
      artifactId: a.id,
      bodySha256: createResearchLanguageArtifact(a.id, a.content).bodySha256,
      at,
      actor: actor(p, role),
      reason: raw.reason,
      classification: "not-applicable" as const,
    };
    (p.languageDispositions ??= []).push(row);
    return row;
  }
  if (raw.operation === "language-read") {
    languageObject(raw, ["operation", "languageRevisionId", "side", "start", "end"]);
    const revision = currentRevision(p, raw.languageRevisionId, role);
    if (raw.side !== "baseline" && raw.side !== "target") throw new Error("选择实际基线或改写稿。");
    const a = revision[raw.side];
    if (
      !Number.isSafeInteger(raw.start) ||
      !Number.isSafeInteger(raw.end) ||
      Number(raw.start) < 0 ||
      Number(raw.end) <= Number(raw.start) ||
      Number(raw.end) > a.body.length ||
      Number(raw.end) - Number(raw.start) > 12000
    )
      throw new Error("每次读取实际 UTF16 区间，最多12000字符。");
    const { task } = owner(p, role),
      identity = actor(p, role);
    const read = {
      id: `${identity.kind === "model" ? identity.attemptId : "invalid"}:${callId}`,
      artifactId: a.id,
      bodySha256: a.bodySha256,
      at,
      actor: identity,
      start: Number(raw.start),
      end: Number(raw.end),
      exactText: a.body.slice(Number(raw.start), Number(raw.end)),
      taskId: task.id,
      taskVersion: task.inputVersion,
      callId,
    };
    const prior = p.languageReads?.find((row) => row.id === read.id);
    if (prior) {
      if (!isDeepStrictEqual({ ...prior, at }, read)) throw new Error("实际读取 ID 不能改写。");
      return prior;
    }
    const { taskId: _task, taskVersion: _version, callId: _call, ...receipt } = read;
    decodeResearchLanguageActualRead(receipt);
    (p.languageReads ??= []).push(read);
    return read;
  }
  if (raw.operation === "language-review") {
    languageObject(raw, ["operation", "languageReview"]);
    const request = raw.languageReview as ResearchLanguageSemanticReviewRequest;
    const revision = currentRevision(p, request?.revisionId, role),
      identity = actor(p, role);
    const reads = (p.languageReads ?? [])
      .filter(
        (read) =>
          researchLanguageActorKey(read.actor) === researchLanguageActorKey(identity) &&
          [revision.baseline, revision.target].some(
            (a) => a.id === read.artifactId && a.bodySha256 === read.bodySha256,
          ),
      )
      .map(({ taskId: _task, taskVersion: _version, callId: _call, ...read }) => read);
    const updated = recordResearchLanguageSemanticReview(
      revision,
      request,
      {
        id: `${identity.kind === "model" ? identity.attemptId : "invalid"}:${callId}`,
        at,
        actor: identity,
        evidenceRef: `host-language:${callId}`,
        readIds: reads.map((read) => read.id),
      },
      { artifacts: artifacts(p), reads },
    );
    p.languageRevisions![p.languageRevisions!.indexOf(revision)] = updated;
    return reportResearchLanguageRevision(updated, artifacts(p));
  }
  languageObject(raw, ["operation", "languageRevisionId"]);
  if (raw.operation !== "language-check") throw new Error("无效语言操作。");
  const revision = currentRevision(p, raw.languageRevisionId, role);
  return reportResearchLanguageRevision(revision, artifacts(p));
}

export function assertResearchLanguageAcceptance(
  p: ResearchProject,
  role: ResearchRole,
  input: Record<string, unknown>,
) {
  const stage = fusionRoleStage(p, role) ?? p.currentStage;
  if (
    p.workflowVersion !== "fusion-v2" ||
    input.verdict !== "accept" ||
    !["stage-verification", "stage-review"].includes(String(input.kind)) ||
    !["writing", "audit"].includes(stage ?? "")
  )
    return;
  const target = stageManuscript(p, stage);
  if (!target) return; // Existing manuscript-chain validation reports the missing target.
  const row = p.languageRevisions?.filter((revision) => revision.target.id === target.id).at(-1);
  const selected = latestResearchLanguageSelection(p, stage);
  if (selected && row?.authorization.id !== selected.authorization.id)
    throw new Error(
      "当前稿尚无用户最新选段对应的语言检查；新稿不能沿用旧检查，新范围不能继承旧复核。",
    );
  const fullPaper =
    p.scope === "paper" &&
    (p.goal ?? "paper") === "paper" &&
    !["task", "manuscript"].includes(p.entry ?? "");
  const scoped = p.languageScopes?.some((scope) =>
    p.artifacts.some(
      (a) => a.id === scope.baseline.id && a.stage === stage && a.revision === p.revision,
    ),
  );
  if (!row) {
    if (!fullPaper && !scoped) return;
    const pin = createResearchLanguageArtifact(target.id, target.content);
    if (
      !scoped &&
      p.languageDispositions?.some(
        (entry) => entry.artifactId === pin.id && entry.bodySha256 === pin.bodySha256,
      )
    )
      return;
    throw new Error(
      "当前稿尚无语言修订检查；未进行打磨须由 A 记录具体不适用原因。新稿不能沿用旧稿检查。",
    );
  }
  const report = reportResearchLanguageRevision(row, artifacts(p));
  if (!["reviewed-meaning-preserved", "unchanged", "skipped"].includes(report.status))
    throw new Error(
      `语言检查尚未完成：${report.status}；硬性错误不能由 accept 或跳过覆盖，实质变化须回到内容修订。`,
    );
}

export function validateResearchLanguageProject(p: ResearchProject) {
  for (const scope of p.languageScopes ?? []) {
    const a = p.artifacts.find((entry) => entry.id === scope.baseline.id);
    if (
      !a ||
      scope.revision !== a.revision ||
      scope.revision > p.revision ||
      !isDeepStrictEqual(createResearchLanguageArtifact(a.id, a.content), scope.baseline)
    )
      throw new Error("语言授权与实际历史基线不符。");
    createResearchLanguageRevision(
      {
        id: `validate-${scope.id}`,
        baseline: scope.baseline,
        target: createResearchLanguageArtifact(`validate-${scope.id}`, a.content),
        ranges: scope.ranges,
      },
      {
        at: scope.authorization.at,
        authorization: scope.authorization,
        frozenAnchors: scope.frozenAnchors,
      },
    );
  }
  const revisions = decodeResearchLanguageRevisions(p.languageRevisions ?? []);
  for (const revision of revisions) {
    const scope = p.languageScopes?.find(
      (row) => row.authorization.id === revision.authorization.id,
    );
    if (
      !scope ||
      !isDeepStrictEqual(scope.baseline, revision.baseline) ||
      !isDeepStrictEqual(scope.ranges, revision.ranges) ||
      !isDeepStrictEqual(scope.frozenAnchors, revision.frozenAnchors)
    )
      throw new Error("语言改写缺少原始范围授权。");
    checkResearchLanguageRevision(revision, artifacts(p));
  }
  for (const read of p.languageReads ?? []) {
    const { taskId, taskVersion, callId, ...receipt } = read;
    decodeResearchLanguageActualRead(receipt);
    languageText(callId, 1024);
    const identity = read.actor;
    const attempt =
      identity.kind === "model"
        ? p.fusion?.attempts.find((entry) => entry.id === identity.attemptId)
        : undefined;
    const task = p.fusion?.tasks.find((entry) => entry.id === taskId);
    const a = p.artifacts.find((entry) => entry.id === read.artifactId);
    if (
      identity.kind !== "model" ||
      !task ||
      !attempt ||
      attempt.taskId !== taskId ||
      task.role !== identity.role ||
      attempt.taskVersion !== taskVersion ||
      attempt.nativeRunId !== identity.nativeRunId ||
      attempt.model?.provider !== identity.model.provider ||
      attempt.model?.modelId !== identity.model.modelId ||
      !p.members.some((m) => m.role === identity.role && m.ref.sessionId === identity.sessionId) ||
      !a ||
      createResearchLanguageArtifact(a.id, a.content).bodySha256 !== read.bodySha256 ||
      a.content.slice(read.start, read.end) !== read.exactText
    )
      throw new Error("语言实际读取与任务、模型或稿件不符。");
  }
  for (const revision of revisions)
    for (const review of revision.semanticReviews)
      if (
        !review.actualReads.every((read) =>
          p.languageReads?.some(
            ({ taskId: _task, taskVersion: _version, callId: _call, ...actual }) =>
              isDeepStrictEqual(actual, read),
          ),
        )
      )
        throw new Error("语言复核借用了未记录的读取凭据。");
  for (const row of p.languageDispositions ?? []) {
    const a = p.artifacts.find((entry) => entry.id === row.artifactId);
    if (
      !a ||
      row.classification !== "not-applicable" ||
      row.actor.kind !== "model" ||
      row.actor.role !== "lead" ||
      createResearchLanguageArtifact(a.id, a.content).bodySha256 !== row.bodySha256
    )
      throw new Error("语言不适用记录缺少实际稿件身份。");
    languageText(row.reason);
  }
}
