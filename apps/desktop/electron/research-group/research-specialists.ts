import { randomUUID } from "node:crypto";
import type {
  ResearchModel,
  ResearchProject,
  ResearchRole,
  ResearchRoute,
  ResearchGroupsState,
} from "../../contracts/research-group";
import { researchStages } from "../../contracts/research-group";
import { decodeM3Model, type ResearchSpecialist } from "../../contracts/research-m3";
import { formatSharedResearchMethod } from "../../contracts/shared-research-method";
import { readPinnedResearchFile, researchHash } from "./materials";
import { researchM3Owner } from "./m3-owner";
import { selectResearchTaskModel } from "./research-execution-policy";
import {
  addResearchTask,
  applyResearchChange,
  publishResearchTaskResult,
  setResearchInput,
} from "./task-graph";

export const SPECIALIST_OPERATIONS = [
  "specialist-context",
  "specialist-read",
  "specialist-submit",
  "specialist-disposition",
] as const;
const manuscriptKinds = ["stage-draft", "stage-revision"];
export const latestSpecialistOpinion = (s: ResearchSpecialist) =>
  s.followups?.at(-1) ?? s.initialOpinion;
export function validateSpecialistInputs(
  p: ResearchProject,
  specialist: Pick<ResearchSpecialist, "kind" | "sourceIds" | "artifactIds">,
  beforeOpinion = true,
): void {
  if (specialist.sourceIds.some((id) => !p.evidence?.sources.some((s) => s.id === id)))
    throw new Error("专项材料必须来自本课题实际采用的来源。");
  if (
    new Set(specialist.sourceIds).size !== specialist.sourceIds.length ||
    new Set(specialist.artifactIds).size !== specialist.artifactIds.length
  )
    throw new Error("专项输入不能重复。");
  for (const id of specialist.artifactIds) {
    const artifact = p.artifacts.find((a) => a.id === id && a.revision === p.revision);
    const record = p.fusion?.artifacts.find((a) => a.id === id);
    const task = p.fusion?.tasks.find((t) => t.id === record?.taskId);
    if (
      !artifact ||
      (beforeOpinion &&
        (!record ||
          !task ||
          record.taskVersion !== task.inputVersion ||
          task.currentArtifactId !== id))
    )
      throw new Error("专项输入稿件已过期，须重新指定当前稿。");
    if (
      specialist.kind === "external-reviewer" &&
      beforeOpinion &&
      (artifact.role !== "lead" || !manuscriptKinds.includes(artifact.kind))
    )
      throw new Error("外审初判只接收当前A稿、原始材料与方法标准，不能提供旧争论或导师意见。");
  }
  if (specialist.kind === "external-reviewer" && !specialist.artifactIds.length)
    throw new Error("外审需要明确当前待审稿件。");
  if (specialist.kind === "external-reviewer" && !specialist.sourceIds.length)
    throw new Error("外审需要指定必要原始依据。");
}

export function specialistPrompt(s: ResearchSpecialist): string {
  if (s.initialOpinion && s.discussionOpenedAt)
    return `专项成员“${s.label}”，本次是独立初判后的讨论接续。独立初判保持原样；请用specialist-context取得本阶段已开放的意见目录，read读取所需意见。具体问题：${s.discussionQuestion ?? s.objective}。交付：${s.deliverable}。整合责任人：${s.integrator}。使用specialist-submit提交本次新的后续意见，说明与初判的变化和证据，不能以历史初判代替本轮交付。提交后结束回复。仍只允许限定research_group操作，不直接覆盖主稿。`;
  return `你是教育研究课题组的专项成员“${s.label}”，独立新会话，类型${s.kind}。本次只处理：${s.objective}。交付：${s.deliverable}。退出条件：${s.exitCondition}。整合责任人：${s.integrator}。仅使用research_group的status/inputs、source-read、read、specialist-context、method-package、specialist-submit。先从specialist-context取得限定输入目录；source-read实际读取列出的原文，read取得列出的当前稿，method-package取得固定方法标准。提交specialist-submit(content:至少80字具体意见)。外审在独立初判提交前，不接收旧争论和导师倾向；初判之后只有用户明确开放讨论才可读取额外意见。报告陈述已核范围与材料不足，不直接修改或接受主稿，不代替A/B和导师。提交后结束回复；后续整合及是否退出另行记录。`;
}

export function registerResearchSpecialistTask(
  p: ResearchProject,
  s: ResearchSpecialist,
  at: string,
): void {
  if (!p.fusion) throw new Error("专项任务需要融合任务图。");
  const inputId = `specialist-scope:${s.id}`;
  const digest = researchHash(
    JSON.stringify({
      objective: s.objective,
      artifacts: s.artifactIds.map((id) => p.artifacts.find((a) => a.id === id)),
      sourceIds: s.sourceIds,
    }),
  );
  p.fusion = setResearchInput(p.fusion, {
    inputId,
    version: 1,
    kind: "context",
    actual: false,
    availability: "available",
    digest,
    label: s.label,
    sourceRef: `user-specialist:${s.id}`,
  });
  p.fusion = applyResearchChange(p.fusion, {
    id: inputId,
    at,
    inputId,
    fromVersion: null,
    toVersion: 1,
    reason: "用户指定专项任务及独立输入范围。",
    authorizedBy: "user",
    authorizationRef: `user-specialist:${s.id}`,
  });
  p.fusion = addResearchTask(p.fusion, {
    id: s.taskId,
    stage: s.stage,
    role: `specialist:${s.id}`,
    kind: "review",
    goal: s.objective,
    inputs: [
      { inputId, version: 1, requirement: "available" },
      ...s.sourceIds.map((id) => {
        const input = p.fusion!.adoptedInputs.find((i) => i.inputId === `source:${id}`);
        if (!input) throw new Error("专项来源未成为当前有效输入。");
        return { ...input, requirement: "available" as const };
      }),
    ],
    dependencies: [],
    earlyHandoff: "独立意见提交后交约定整合人。",
    deliverable: s.deliverable,
    reviewRequired: true,
    writeScope: [`specialists/${s.id}`],
    tokenBudget: p.memberTokenBudget,
  });
}

export function specialistModelSelection(
  p: ResearchProject,
  s: Pick<ResearchSpecialist, "taskId" | "stage" | "model">,
  state: Pick<ResearchGroupsState, "m3"> = {},
) {
  const selection = selectResearchTaskModel(state, p, "reviewer", s.taskId, s.stage);
  return { ...selection, model: selection.model ?? s.model };
}

export function specialistRoute(
  p: ResearchProject,
  s: ResearchSpecialist,
  state: Pick<ResearchGroupsState, "m3"> = {},
): ResearchRoute {
  const stage = researchStages(p).find((row) => row.id === s.stage);
  if (!stage) throw new Error("专项任务阶段不存在。");
  const { models: _models, ...description } = stage;
  const task = p.fusion?.tasks.find((t) => t.id === s.taskId);
  const attempt = p.fusion?.attempts
    .filter((a) => a.taskId === s.taskId && ["prepared", "running", "unknown"].includes(a.state))
    .at(-1);
  return {
    role: "reviewer",
    specialistId: s.id,
    stage: { ...description, goal: s.objective, deliverables: s.deliverable },
    revision: p.revision,
    active:
      p.status === "running" &&
      s.revision === p.revision &&
      !!task &&
      !["exited", "failed"].includes(s.state),
    model:
      (attempt?.model as ResearchModel | undefined) ?? specialistModelSelection(p, s, state).model,
    modelSource: attempt?.modelSource ?? specialistModelSelection(p, s, state).source,
  };
}

/** A closed capability surface: no project events, private applications or unselected artifact list. */
export async function applySpecialistTool(
  p: ResearchProject,
  s: ResearchSpecialist,
  input: Record<string, unknown>,
  at: string,
  state: Pick<ResearchGroupsState, "m3"> = {},
): Promise<unknown> {
  if (input.operation === "scope") return { scope: "research-specialist", specialistId: s.id };
  if (input.operation === "route") return specialistRoute(p, s, state);
  if (s.revision !== p.revision || p.status !== "running" || s.state === "exited")
    throw new Error("专项任务已停止或输入版本已变化。");
  if (["status", "inputs", "specialist-context"].includes(String(input.operation))) {
    return {
      id: s.id,
      kind: s.kind,
      stage: s.stage,
      objective: s.objective,
      deliverable: s.deliverable,
      exitCondition: s.exitCondition,
      sources: p.evidence?.sources
        .filter((source) => s.sourceIds.includes(source.id))
        .map(({ file: _file, ...source }) => source),
      artifacts: p.artifacts
        .filter(
          (a) =>
            s.artifactIds.includes(a.id) ||
            (!!s.initialOpinion &&
              !!s.discussionOpenedAt &&
              a.revision === p.revision &&
              a.stage === s.stage),
        )
        .map(({ id, role, kind, createdAt }) => ({ id, role, kind, createdAt })),
      independentOpinionSubmitted: !!s.initialOpinion,
      discussionOpened: !!s.discussionOpenedAt,
      ...(s.initialOpinion && s.discussionOpenedAt
        ? {
            discussionQuestion: s.discussionQuestion ?? s.objective,
            ownInitialOpinion: structuredClone(s.initialOpinion),
            userQuestions: p.m3?.memberInputs?.filter(
              (input) => input.actor === `specialist:${s.id}` && input.revision === p.revision,
            ),
          }
        : {}),
      note: "只有显式列出的输入可读取；开放后的目录仅含本阶段，初判与后续意见分别保留。",
    };
  }
  if (input.operation === "route-applied") {
    const route = input.route as ResearchRoute;
    if (!route || route.specialistId !== s.id || route.revision !== p.revision)
      throw new Error("专项模型应用身份不符。");
    const model = decodeM3Model(route.model);
    const attempt = p.fusion?.attempts
      .filter((a) => a.taskId === s.taskId && a.state === "running")
      .at(-1);
    if (!attempt || !attempt.nativeRunId) throw new Error("专项模型应用缺少真实原生身份。");
    const expected = attempt.model ?? s.model;
    if (
      expected &&
      (model.provider !== expected.provider ||
        model.modelId !== expected.modelId ||
        (expected.thinkingLevel && model.thinkingLevel !== expected.thinkingLevel))
    )
      throw new Error("专项实际模型与明确选择不符。");
    attempt.model = model;
    return { applied: true };
  }
  const owner = researchM3Owner(p, `specialist:${s.id}`);
  if (input.operation === "source-read") {
    const source = p.evidence?.sources.find(
      (source) => source.id === input.sourceId && s.sourceIds.includes(source.id),
    );
    if (!source) throw new Error("该原文不在专项授权范围内。");
    const body = await readPinnedResearchFile(source);
    const start = input.offset === undefined ? 0 : Number(input.offset);
    if (!Number.isSafeInteger(start) || start < 0 || start >= body.length)
      throw new Error("专项原文读取位置无效。");
    const end = Math.min(start + 8000, body.length);
    s.reads.push({
      kind: "source",
      id: source.id,
      sha256: source.sha256,
      at,
      attemptId: owner.attempt.id,
      start,
      end,
    });
    return {
      sourceId: source.id,
      sha256: source.sha256,
      start,
      end,
      total: body.length,
      text: body.slice(start, end),
      textScope: source.textScope ?? "partial-text",
    };
  }
  if (input.operation === "method-package") {
    if (!p.sharedMethod && !p.methodPackages?.length)
      throw new Error("当前项目缺少固定方法标准，不能登记不存在的标准阅读凭据。");
    const standards = p.sharedMethod
      ? formatSharedResearchMethod(p.sharedMethod)
      : "当前项目未固定新版共同方法标准；具体方法依据需由授权的method来源取得并明确限制。";
    const packages = (p.methodPackages ?? []).map((pkg) => ({
      id: pkg.id,
      packageSha256: pkg.packageSha256,
      records: pkg.records,
    }));
    s.reads.push({
      kind: "standards",
      id: "fixed-method",
      sha256: researchHash(JSON.stringify({ standards, packages })),
      at,
      attemptId: owner.attempt.id,
    });
    return {
      standards,
      packages,
      boundary: "共同方法事实，不含项目私有应用、成员意见、争论或导师裁定。",
    };
  }
  if (input.operation === "read") {
    const artifact = p.artifacts.find(
      (a) => a.id === input.artifactId && a.revision === p.revision,
    );
    if (!artifact) throw new Error("专项稿件不存在。");
    const initiallyAllowed = s.artifactIds.includes(artifact.id);
    const discussionAllowed =
      !!s.initialOpinion && !!s.discussionOpenedAt && artifact.stage === s.stage;
    if (!initiallyAllowed && !discussionAllowed)
      throw new Error("该稿件不在专项输入中；外审独立初判前禁止读取旧争论与导师倾向。");
    if (initiallyAllowed && !s.initialOpinion) validateSpecialistInputs(p, s);
    s.reads.push({
      kind: "artifact",
      id: artifact.id,
      sha256: researchHash(artifact.content),
      at,
      attemptId: owner.attempt.id,
    });
    return structuredClone(artifact);
  }
  if (input.operation !== "specialist-submit")
    throw new Error("专项成员不能访问其他研究操作或主项目记录。");
  if (s.initialOpinion && !s.discussionOpenedAt)
    throw new Error("独立意见已保存，用户尚未开放后续讨论。");
  if (s.followups?.some((r) => r.attemptId === owner.attempt.id) || (s.followups?.length ?? 0) >= 8)
    throw new Error("本次后续意见已保存，请等待具体任务接续。");
  validateSpecialistInputs(p, s, !s.initialOpinion);
  if (
    typeof input.content !== "string" ||
    input.content.trim().length < 80 ||
    input.content.length > 20000
  )
    throw new Error("专项意见需要80–20000字，包含范围、依据、问题和限制。");
  if (
    s.sourceIds.some((id) => !s.reads.some((r) => r.kind === "source" && r.id === id)) ||
    s.artifactIds.some((id) => !s.reads.some((r) => r.kind === "artifact" && r.id === id)) ||
    !s.reads.some((r) => r.kind === "standards")
  )
    throw new Error("专项意见需要本人实际读取全部指定原文、目标稿和固定方法标准。");
  // Re-read pins before committing; a file changed after the first read cannot pass as current evidence.
  for (const id of s.sourceIds) {
    const source = p.evidence!.sources.find((source) => source.id === id)!;
    await readPinnedResearchFile(source);
    if (!s.reads.some((r) => r.kind === "source" && r.id === id && r.sha256 === source.sha256))
      throw new Error("专项原文已变版。");
  }
  const opinion = {
    id: randomUUID(),
    content: input.content.trim(),
    at,
    attemptId: owner.attempt.id,
  };
  p.fusion = publishResearchTaskResult(p.fusion!, {
    projectId: p.id,
    attemptId: owner.attempt.id,
    id: opinion.id,
    at,
    content: opinion.content,
    interim: false,
    keepAttemptRunning: true,
  });
  if (!s.initialOpinion) s.initialOpinion = opinion;
  else {
    (s.followups ??= []).push(opinion);
    for (const continuation of p
      .fusion!.tasks.find((t) => t.id === s.taskId)!
      .continuations.filter((c) => !c.attemptId && c.id.startsWith("specialist-discussion:")))
      continuation.attemptId = owner.attempt.id;
  }
  s.state = "submitted";
  return {
    id: opinion.id,
    content: opinion.content,
    state: s.state,
    integrator: s.integrator,
    note: "专项交付已保存，未覆盖或接受主稿。",
  };
}

export function readSpecialistOpinion(
  p: ResearchProject,
  role: ResearchRole,
  specialistId: unknown,
  at: string,
) {
  const owner = researchM3Owner(p, role);
  const s = p.m3?.specialists?.find((s) => s.id === specialistId && s.revision === p.revision);
  if (!s?.initialOpinion) throw new Error("专项意见尚未提交。");
  const opinion = latestSpecialistOpinion(s)!;
  if (
    ["lead", "reviewer"].includes(role) &&
    !p.artifacts.some(
      (a) =>
        a.role === role &&
        a.revision === p.revision &&
        a.stage === s.stage &&
        a.kind === (role === "lead" ? "stage-draft" : "stage-risk"),
    )
  )
    throw new Error("先完成本阶段独立初判，再读取专项意见。");
  p.events.push({
    id: randomUUID(),
    at,
    revision: p.revision,
    stage: s.stage,
    type: "read",
    role,
    runId: owner.attempt.nativeRunId,
    artifactId: opinion.id,
    detail: `读取专项意见 ${s.label}，整合责任仍由${s.integrator}承担。`,
  });
  return structuredClone(opinion);
}

export function assertSpecialistAcceptance(p: ResearchProject): void {
  for (const s of p.m3?.specialists?.filter(
    (s) => s.revision === p.revision && s.stage === p.currentStage && s.state !== "exited",
  ) ?? []) {
    const current = p.artifacts
      .filter(
        (a) =>
          a.revision === p.revision &&
          a.stage === s.stage &&
          a.role === "lead" &&
          manuscriptKinds.includes(a.kind),
      )
      .filter((a) => p.fusion?.tasks.some((t) => t.currentArtifactId === a.id))
      .at(-1);
    if (
      !s.initialOpinion ||
      s.state !== "submitted" ||
      !s.disposition ||
      s.disposition.verdict === "revise" ||
      s.disposition.artifactId !== current?.id ||
      s.disposition.opinionId !== latestSpecialistOpinion(s)?.id
    )
      throw new Error(`专项成员“${s.label}”的意见尚未在当前稿完成整合或明确处理。`);
  }
}
