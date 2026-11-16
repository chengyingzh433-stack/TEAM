import { hasCurrentAnalysisRunAdoption } from "./analysis-result-reuse";
import {
  assertNonNumericPublication,
  isNonNumericResearch,
  nonNumericManuscriptIssues,
} from "./research-paths";
import { assertResearchTaskPublication } from "./research-task-scope";
import { assertSpecialistAcceptance, latestSpecialistOpinion } from "./research-specialists";
import { assertResearchMemberInputsHandled } from "./research-member-input";
import { latestResearchLanguageSelection } from "../../contracts/research-language-tools";
import type { ResearchAnalysisRun, ResearchAnalysisSpec } from "../../contracts/research-evidence";
import {
  matchesCurrentRegisteredAnalysis,
  registeredAnalysisAcceptanceIssues,
} from "./analysis-registry-state";
import {
  RESEARCH_STAGE_IDS,
  researchStages,
  type ResearchArtifact,
  type ResearchArtifactKind,
  type ResearchProject,
  type ResearchRole,
  type ResearchStageId,
} from "../../contracts/research-group";

export function researchAnalysisMatchesPlan(
  plan: ResearchAnalysisSpec | undefined,
  spec: ResearchAnalysisSpec,
): boolean {
  if (!plan || spec.datasetId !== plan.datasetId) return false;
  if (spec.method === "describe")
    return (
      spec.columns.length > 0 &&
      spec.columns.every((column) => [...plan.columns, plan.outcome].includes(column))
    );
  return (
    spec.method === plan.method &&
    spec.outcome === plan.outcome &&
    JSON.stringify(spec.columns) === JSON.stringify(plan.columns)
  );
}

/** Legacy records retain their old contract; fusion numeric evidence must pin the actual attempt. */
export function isCurrentResearchAnalysis(p: ResearchProject, run: ResearchAnalysisRun): boolean {
  if (run.revision !== p.revision) return false;
  if (p.workflowVersion !== "fusion-v2") return true;
  const graph = p.fusion;
  if (!graph || !run.taskId || !run.attemptId || !Number.isSafeInteger(run.taskInputVersion))
    return false;
  const task = graph.tasks.find((t) => t.id === run.taskId);
  const attempt = graph.attempts.find((a) => a.id === run.attemptId);
  const dataset = p.evidence?.datasets.find((d) => d.id === run.spec.datasetId);
  if (
    !task ||
    !attempt ||
    task.stage !== "analysis" ||
    task.role !== run.role ||
    attempt.taskId !== task.id ||
    attempt.taskVersion !== run.taskInputVersion ||
    !dataset ||
    dataset.sha256 !== run.datasetSha256 ||
    !(
      matchesCurrentRegisteredAnalysis(p, run) ??
      researchAnalysisMatchesPlan(p.analysisPlan, run.spec)
    )
  )
    return false;
  if (task.inputVersion !== run.taskInputVersion) return hasCurrentAnalysisRunAdoption(p, run.id);
  const datasetRef = [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].find(
    (ref) => ref.inputId === `dataset:${dataset.id}`,
  );
  return (
    !!datasetRef &&
    graph.adoptedInputs.some(
      (ref) => ref.inputId === datasetRef.inputId && ref.version === datasetRef.version,
    ) &&
    graph.inputs.some(
      (input) =>
        input.inputId === datasetRef.inputId &&
        input.version === datasetRef.version &&
        input.digest === run.datasetSha256 &&
        input.actual &&
        input.availability === "available",
    )
  );
}

export const PAPER_AUTHORS: Partial<Record<ResearchArtifactKind, ResearchRole>> = {
  "stage-draft": "lead",
  "stage-risk": "reviewer",
  "stage-material": "librarian",
  "stage-critique": "reviewer",
  "stage-revision": "lead",
  "stage-verification": "reviewer",
  "stage-review": "mentor",
};
export function paperStage(p: ResearchProject): ResearchStageId | undefined {
  return (p.workflowVersion === "fusion-v2" || p.scope === "paper") &&
    p.currentStage &&
    (p.workflowVersion === "fusion-v2" || !["question", "review"].includes(p.currentStage))
    ? p.currentStage
    : undefined;
}
export function isCurrentResearchArtifact(p: ResearchProject, artifact: ResearchArtifact): boolean {
  const record = p.fusion?.artifacts.find((a) => a.id === artifact.id);
  if (!record) return true;
  const task = p.fusion!.tasks.find((t) => t.id === record.taskId);
  return (
    task?.inputVersion === record.taskVersion &&
    !["superseded", "needs-review"].includes(record.reviewState)
  );
}
export const stageLatest = (
  p: ResearchProject,
  kind: ResearchArtifactKind,
  stage = p.currentStage,
) =>
  p.artifacts
    .filter(
      (a) =>
        a.revision === p.revision &&
        a.kind === kind &&
        a.stage === stage &&
        isCurrentResearchArtifact(p, a),
    )
    .at(-1);
/** Opens peer opinions after this revision/stage's own initial judgment. Historical
 * initial judgments remain known during a local reopening; this grants no current
 * input, source-read or artifact dependency qualification. */
export function hasStageIndependentJudgment(
  p: ResearchProject,
  role: ResearchRole,
  stage: string | undefined = p.currentStage,
): boolean {
  if (p.workflowVersion !== "fusion-v2" || !["lead", "reviewer"].includes(role)) return true;
  return p.artifacts.some((artifact) => {
    if (
      artifact.revision !== p.revision ||
      artifact.stage !== stage ||
      artifact.role !== role ||
      artifact.kind !== (role === "lead" ? "stage-draft" : "stage-risk")
    )
      return false;
    const record = p.fusion?.artifacts.find((row) => row.id === artifact.id);
    const task = p.fusion?.tasks.find((row) => row.id === record?.taskId);
    const attempt = p.fusion?.attempts.find((row) => row.id === record?.attemptId);
    return (
      !!record &&
      !!task &&
      !!attempt &&
      task.role === role &&
      task.stage === stage &&
      task.id.startsWith(`v${p.revision}:`) &&
      record.taskVersion <= task.inputVersion &&
      attempt.taskId === task.id &&
      attempt.taskVersion === record.taskVersion &&
      record.content === artifact.content &&
      record.createdAt === artifact.createdAt
    );
  });
}
/** Accepted upstream work is shared input; a peer's same/future-stage opinions
 * remain private until this member has made that target stage's own judgment. */
export function canReadResearchPeerJudgment(
  p: ResearchProject,
  role: ResearchRole,
  targetStage: string | undefined,
  callerStage: string | undefined = p.currentStage,
): boolean {
  if (p.workflowVersion !== "fusion-v2" || !["lead", "reviewer"].includes(role)) return true;
  if (!targetStage) return false;
  const stages = researchStages(p).map((stage) => stage.id as string);
  const target = stages.indexOf(targetStage),
    caller = stages.indexOf(callerStage ?? "");
  return (
    (target >= 0 && caller >= 0 && target < caller) ||
    hasStageIndependentJudgment(p, role, targetStage)
  );
}
/** Both first drafts and revisions can be reviewed; an unaddressed critique is checked separately. */
export function stageManuscript(p: ResearchProject, stage: string | undefined = p.currentStage) {
  const manuscripts = p.artifacts.filter(
    (a) =>
      a.revision === p.revision &&
      a.stage === stage &&
      a.role === "lead" &&
      ["stage-draft", "stage-revision"].includes(a.kind) &&
      isCurrentResearchArtifact(p, a),
  );
  return (
    manuscripts.filter((a) => a.kind === "stage-revision").at(-1) ??
    manuscripts.filter((a) => a.kind === "stage-draft").at(-1)
  );
}
export function previousStageReview(p: ResearchProject): ResearchArtifact | undefined {
  if (p.workflowVersion === "fusion-v2") {
    const stages = researchStages(p);
    const index = stages.findIndex((stage) => stage.id === p.currentStage);
    return index > 0 ? stageLatest(p, "stage-review", stages[index - 1]!.id) : undefined;
  }
  const index = RESEARCH_STAGE_IDS.indexOf(
    (p.currentStage as (typeof RESEARCH_STAGE_IDS)[number]) ?? "question",
  );
  return index === 2
    ? p.artifacts.filter((a) => a.revision === p.revision && a.kind === "review").at(-1)
    : stageLatest(p, "stage-review", RESEARCH_STAGE_IDS[index - 1]);
}
export function validatePaperArtifact(
  p: ResearchProject,
  role: ResearchRole,
  input: Record<string, unknown>,
): { round: number; sourceIds: string[]; analysisIds: string[] } {
  const stage = paperStage(p),
    kind = input.kind as ResearchArtifactKind,
    refs = input.refs as string[];
  if (!stage || input.stage !== stage || PAPER_AUTHORS[kind] !== role)
    throw new Error("当前阶段或成果角色不符，请读取 status 后按当前阶段提交。");
  const numericPath = !isNonNumericResearch(p);
  assertNonNumericPublication(p, role, input);
  assertResearchTaskPublication(p, input);
  if (
    !numericPath &&
    p.goal !== "task" &&
    p.entry !== "manuscript" &&
    stage === "audit" &&
    ["stage-draft", "stage-revision"].includes(kind)
  ) {
    const issues = nonNumericManuscriptIssues(p, { content: String(input.content) });
    if (issues.length) throw new Error(`当前路径终稿不完整：${issues.join("；")}`);
  }
  const latest = (k: ResearchArtifactKind) => stageLatest(p, k);
  const requireRef = (a: ResearchArtifact | undefined) => {
    if (!a || !refs.includes(a.id)) throw new Error("缺少最新前置成果的实际读取与引用。");
  };
  const ids = (value: unknown) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string") || value.length > 40)
      throw new Error("来源或分析引用无效。");
    return [...new Set(value as string[])];
  };
  const sourceIds = ids(input.sourceIds),
    analysisIds = ids(input.analysisIds);
  const memberInputIds = ids(input.memberInputIds);
  if (memberInputIds.length) {
    const current = p.fusion?.attempts
      .filter(
        (attempt) =>
          attempt.state === "running" &&
          p.fusion!.tasks.some(
            (task) =>
              task.id === attempt.taskId &&
              task.role === role &&
              task.stage === stage &&
              task.inputVersion === attempt.taskVersion,
          ),
      )
      .at(-1);
    if (
      !current?.nativeRunId ||
      memberInputIds.some(
        (id) =>
          !p.m3?.memberInputs?.some(
            (user) =>
              user.id === id &&
              user.revision === p.revision &&
              user.actor === role &&
              user.taskVersion === current.taskVersion &&
              (role === "lead" ? user.attemptId === current.id : !!user.attemptId),
          ) ||
          (role === "lead" &&
            p.artifacts.some((artifact) => artifact.memberInputIds?.includes(id))),
      )
    )
      throw new Error(
        "交付只能引用本人实际收到的用户补充；旧输入版本或其他成员说明不能代用，A不能重复用同一输入修订。",
      );
  }
  if (["stage-review", "stage-verification"].includes(kind) && input.verdict === "accept") {
    assertResearchMemberInputsHandled(p, role, input, stageManuscript(p));
    if (kind === "stage-review") assertSpecialistAcceptance(p);
  }
  const plannedDatasetIds = p.activeAnalysisPlans?.length
    ? (p.analysisRegistry?.plans
        .filter((plan) =>
          p.activeAnalysisPlans!.some((ref) => ref.id === plan.id && ref.version === plan.version),
        )
        .map((plan) => plan.dataset.id) ?? [])
    : p.analysisPlan
      ? [p.analysisPlan.datasetId]
      : [];
  if (
    sourceIds.some(
      (id) =>
        !p.evidence?.sources.some((s) => s.id === id) ||
        !p.events.some(
          (e) =>
            e.type === "source-read" &&
            e.role === role &&
            e.sourceId === id &&
            (p.workflowVersion !== "fusion-v2" ||
              e.sourceSha256 === p.evidence?.sources.find((source) => source.id === id)?.sha256) &&
            e.revision === p.revision,
        ),
    )
  )
    throw new Error("来源必须已由本成员实际读取，不能只引用候选元数据。");
  if (
    analysisIds.some(
      (id) =>
        !p.analyses?.some((a) => a.id === id && isCurrentResearchAnalysis(p, a)) ||
        !p.events.some((e) => e.type === "analysis" && e.role === role && e.analysisId === id),
    )
  )
    throw new Error("分析引用需要实际运行或读取结果。");
  let round = 0;
  if (kind === "stage-review" && input.verdict === "hold") {
    requireRef(latest("stage-draft") ?? previousStageReview(p));
    return { round, sourceIds, analysisIds };
  }
  if (["stage-draft", "stage-risk", "stage-critique"].includes(kind) && latest(kind))
    throw new Error("本阶段独立稿或批评已发布，请走修订链。");
  if (kind === "stage-draft" || kind === "stage-risk") {
    const previous = previousStageReview(p);
    if (previous || p.workflowVersion !== "fusion-v2") requireRef(previous);
  }
  if (kind === "stage-critique") {
    if (!latest("stage-risk")) throw new Error("B 先发布独立风险判断。");
    requireRef(latest("stage-draft"));
  }
  if (kind === "stage-revision") {
    const reconsidered = p.events
      .filter((e) => e.type === "decision" && e.stage === stage && e.revision === p.revision)
      .at(-1);
    const blocker = p.artifacts
      .filter(
        (a) =>
          a.revision === p.revision &&
          a.stage === stage &&
          isCurrentResearchArtifact(p, a) &&
          (a.kind === "stage-critique" ||
            (["stage-verification", "stage-review"].includes(a.kind) && a.verdict === "revise") ||
            (a.kind === "stage-review" && a.id === reconsidered?.artifactId)),
      )
      .at(-1);
    if (input.languageBaselineId !== undefined) {
      const current = stageManuscript(p);
      const baseline = p.artifacts.find(
        (a) =>
          a.id === input.languageBaselineId &&
          a.role === "lead" &&
          a.stage === stage &&
          a.revision === p.revision &&
          ["stage-draft", "stage-revision"].includes(a.kind),
      );
      const selected = latestResearchLanguageSelection(p, stage);
      const scope =
        input.languageScopeId === undefined
          ? selected
          : p.languageScopes?.find(
              (row) =>
                row.id === input.languageScopeId &&
                row.revision === p.revision &&
                row.baseline.id === baseline?.id,
            );
      const authorizedPaper =
        (p.goal ?? "paper") === "paper" &&
        p.scope === "paper" &&
        !["task", "manuscript"].includes(p.entry ?? "");
      if (
        p.workflowVersion !== "fusion-v2" ||
        !["writing", "audit"].includes(stage) ||
        !baseline ||
        !current ||
        (!scope && !authorizedPaper) ||
        (selected && (scope?.id !== selected.id || baseline.id !== selected.baseline.id)) ||
        (input.languageScopeId !== undefined && !scope)
      )
        throw new Error("语言改写需要本阶段实际基线和用户选定或既有授权的范围。");
      requireRef(current);
      if (blocker) {
        const pending = [current.id],
          seen = new Set<string>();
        while (pending.length) {
          const id = pending.pop()!;
          if (seen.has(id)) continue;
          seen.add(id);
          pending.push(...(p.artifacts.find((a) => a.id === id)?.refs ?? []));
        }
        if (!seen.has(blocker.id)) throw new Error("先回应已有实质批评，再进行语言打磨。");
      }
      round = current.round;
    } else {
      const specialist = p.m3?.specialists?.find(
        (s) =>
          s.revision === p.revision &&
          s.stage === stage &&
          s.integrator === role &&
          s.initialOpinion &&
          refs.includes(latestSpecialistOpinion(s)!.id),
      );
      if (blocker) requireRef(blocker);
      else if (memberInputIds.length) requireRef(stageManuscript(p));
      else if (
        !specialist?.initialOpinion ||
        !p.events.some(
          (e) =>
            e.type === "read" &&
            e.role === role &&
            e.artifactId === latestSpecialistOpinion(specialist)!.id,
        )
      )
        throw new Error(
          "缺少最新前置成果：修订需要最新实质批评，或由指定整合人实际读取的专项意见。",
        );
      if (blocker && latest("stage-revision")?.refs.includes(blocker.id))
        throw new Error("此批评已经修订，请等待复核。");
      round =
        p.artifacts
          .slice(
            reconsidered ? p.artifacts.findIndex((a) => a.id === reconsidered.artifactId) + 1 : 0,
          )
          .filter(
            (a) =>
              a.revision === p.revision &&
              a.stage === stage &&
              a.kind === kind &&
              !a.languageBaselineId &&
              isCurrentResearchArtifact(p, a),
          ).length + 1;
      if (round > 2) throw new Error("本阶段已达两轮修订，需要导师决定。");
    }
  }
  if (kind === "stage-verification" || kind === "stage-review") {
    const manuscript = stageManuscript(p);
    if (
      manuscript?.kind === "stage-draft" &&
      (p.workflowVersion !== "fusion-v2" || !latest("stage-risk") || latest("stage-critique"))
    )
      throw new Error(
        "首稿直接复核需要B已独立判断，且没有尚未回应的批评；已有实质意见须走修订链。",
      );
    requireRef(manuscript);
    round = manuscript!.round;
    if (latest(kind)?.refs.includes(manuscript!.id)) throw new Error("此稿已审阅，请勿重复提交。");
    if (kind === "stage-review") {
      requireRef(latest("stage-verification"));
      if (!latest("stage-verification")?.refs.includes(manuscript!.id))
        throw new Error("不能使用旧复核意见审阅新稿。");
      if (input.verdict === "accept" && latest("stage-verification")?.verdict !== "accept")
        throw new Error("B 尚未通过，导师不能放行。");
    }
    if (!["accept", "revise", "hold"].includes(String(input.verdict)))
      throw new Error("请提供 accept / revise / hold 裁定。");
  }
  if (
    p.workflowVersion !== "fusion-v2" &&
    kind === "stage-material" &&
    p.artifacts.filter((a) => a.revision === p.revision && a.stage === stage && a.kind === kind)
      .length >= 2
  )
    throw new Error("本阶段两份材料已交付，请等待下一阶段。");
  if (
    stage === "literature" &&
    ["stage-draft", "stage-revision"].includes(kind) &&
    sourceIds.filter((id) => p.evidence?.sources.some((s) => s.id === id && s.kind === "paper"))
      .length < 2
  )
    throw new Error("文献综合至少需要两篇由本成员读取的研究原文，数据说明不能替代研究文献。");
  if (
    stage === "design" &&
    kind === "stage-revision" &&
    (p.workflowVersion !== "fusion-v2" || input.analysisPlan !== undefined)
  ) {
    const plan = input.analysisPlan as
      import("../../contracts/research-evidence").ResearchAnalysisSpec | undefined;
    if (
      !plan ||
      (p.workflowVersion !== "fusion-v2" &&
        !p.evidence?.datasets.some((d) => d.id === plan.datasetId)) ||
      !["describe", "correlation", "ols"].includes(plan.method) ||
      !Array.isArray(plan.columns) ||
      !plan.columns.length ||
      plan.columns.length > 12 ||
      plan.columns.some((c) => typeof c !== "string" || !c) ||
      new Set(plan.columns).size !== plan.columns.length ||
      (plan.method === "ols" &&
        (typeof plan.outcome !== "string" || !plan.outcome || plan.columns.includes(plan.outcome)))
    )
      throw new Error(
        "设计修订必须提供已登记数据集的 analysisPlan（datasetId、method、columns，ols 另需 outcome）。缺数据应请求导师 hold。",
      );
  }
  if (
    p.workflowVersion !== "fusion-v2" &&
    stage === "design" &&
    kind === "stage-review" &&
    input.verdict === "accept" &&
    (!p.evidence?.datasets.length || !p.analysisPlan)
  )
    throw new Error(
      "没有已登记且声明许可的数据与分析计划，不能通过实施与分析关口；请 hold 并列出所需材料。",
    );
  if (
    numericPath &&
    ["analysis", "writing", "audit"].includes(stage) &&
    kind === "stage-review" &&
    input.verdict === "accept" &&
    p.activeAnalysisPlans?.length
  ) {
    const issues = registeredAnalysisAcceptanceIssues(
      p,
      (p.analyses ?? []).filter((run) => isCurrentResearchAnalysis(p, run)).map((run) => run.id),
    );
    if (issues.length) throw new Error(`登记分析尚未完成：${issues.join("；")}`);
  }
  if (
    numericPath &&
    stage === "analysis" &&
    kind === "stage-review" &&
    input.verdict === "accept" &&
    !p.activeAnalysisPlans?.length
  ) {
    const plan = p.analysisPlan;
    const runs =
      p.analyses?.filter(
        (a) =>
          isCurrentResearchAnalysis(p, a) &&
          plan &&
          a.spec.datasetId === plan.datasetId &&
          a.spec.method === plan.method &&
          a.spec.outcome === plan.outcome &&
          JSON.stringify(a.spec.columns) === JSON.stringify(plan.columns),
      ) ?? [];
    if (
      !runs.some(
        (a) =>
          a.role === "lead" && runs.some((b) => b.role === "reviewer" && b.sha256 === a.sha256),
      )
    )
      throw new Error("A 的计算尚无 B 的同引擎复跑一致记录，不能进入写作；这不代表独立算法校验。");
  }
  if (numericPath && stage === "analysis" && ["stage-draft", "stage-revision"].includes(kind)) {
    const plan = p.analysisPlan;
    if (
      !p.analyses?.some(
        (a) =>
          isCurrentResearchAnalysis(p, a) &&
          a.role === "lead" &&
          (p.activeAnalysisPlans?.length
            ? p.analysisRegistry?.runs.some(
                (run) =>
                  run.id === a.id &&
                  p.analysisRegistry?.plans.some(
                    (entry) =>
                      entry.id === run.planId &&
                      entry.version === run.planVersion &&
                      entry.purpose === "primary",
                  ),
              )
            : plan &&
              a.spec.datasetId === plan.datasetId &&
              a.spec.method === plan.method &&
              a.spec.outcome === plan.outcome &&
              JSON.stringify(a.spec.columns) === JSON.stringify(plan.columns)),
      )
    )
      throw new Error(
        "请先实际执行已冻结的主分析，再提交完整分析稿；中间实施问题用 message 讨论，不能把描述关口当作完整阶段交付。",
      );
  }
  const limitedTask =
    p.workflowVersion === "fusion-v2" && (p.goal === "task" || p.entry === "manuscript");
  if (limitedTask && ["stage-draft", "stage-revision"].includes(kind)) {
    const targetKinds =
      p.task?.kind === "design-review" || stage === "design"
        ? ["design", "manuscript"]
        : p.task?.kind === "reading" || p.task?.kind === "citations"
          ? ["paper", "method", "manuscript"]
          : ["manuscript"];
    if (
      !sourceIds.some((id) =>
        p.evidence?.sources.some((source) => source.id === id && targetKinds.includes(source.kind)),
      )
    )
      throw new Error(
        "限定任务须实际读取并引用对应稿件、方案或指定原文；缺支持材料的判断保留待核验。",
      );
  }
  if (
    !limitedTask &&
    ["writing", "audit"].includes(stage) &&
    ["stage-draft", "stage-revision"].includes(kind)
  ) {
    if (
      sourceIds.length < (numericPath || p.path === "review" ? 2 : 1) ||
      (numericPath && !analysisIds.length)
    )
      throw new Error("论文稿必须引用已读取的研究来源与实际分析结果。");
    if (stage === "audit" && kind === "stage-revision") {
      const content = String(input.content);
      if (
        numericPath &&
        (content.length < 800 ||
          !/^# /m.test(content) ||
          !/摘要|Abstract/i.test(content) ||
          !/方法|Method/i.test(content) ||
          !/结果|Results/i.test(content) ||
          !/讨论|Discussion/i.test(content) ||
          !/参考文献|References/i.test(content))
      )
        throw new Error("全文修订需提交包含题目、摘要、方法、结果、讨论与参考文献的完整论文。");
      if (!numericPath) {
        const issues = nonNumericManuscriptIssues(p, { content });
        if (issues.length) throw new Error(`当前路径终稿不完整：${issues.join("；")}`);
      }
      const cited = [...content.matchAll(/\[SRC:([A-Za-z0-9_-]+)\]/g)].map((m) => m[1]!);
      if (
        new Set(cited).size < (numericPath || p.path === "review" ? 2 : 1) ||
        cited.some((id) => !sourceIds.includes(id)) ||
        (numericPath && !analysisIds.some((id) => content.includes(`[ANALYSIS:${id}]`))) ||
        [...content.matchAll(/\[ANALYSIS:([A-Za-z0-9_-]+)\]/g)].some(
          (m) => !analysisIds.includes(m[1]!),
        ) ||
        (p.evidence?.datasets
          .filter((d) => plannedDatasetIds.includes(d.id))
          .some((d) => !cited.includes(d.sourceId)) ??
          false)
      )
        throw new Error("终稿须使用 [SRC:来源ID] 和 [ANALYSIS:分析ID] 标明可追溯引用。");
      if (
        p.evidence?.datasets.some(
          (d) => plannedDatasetIds.includes(d.id) && d.dataKind === "synthetic",
        ) &&
        !/合成数据|synthetic data/i.test(content.slice(0, 600))
      )
        throw new Error("合成数据论文必须在开头显著标明演练用途。");
    }
  }
  return { round, sourceIds, analysisIds };
}
