import type {
  ResearchArtifact,
  ResearchArtifactKind,
  ResearchProject,
  ResearchRole,
  ResearchStageId,
} from "../../contracts/research-group";
import { isResearchStageId, RESEARCH_ROLES } from "../../contracts/research-group";
import { isCurrentResearchArtifact, stageLatest } from "./paper-pipeline";
import { researchTaskBlockers } from "./task-graph";
import {
  createResearchLanguageArtifact,
  reportResearchLanguageRevision,
} from "./language-revisions";

export interface FusionContinuationPlan {
  taskId: string;
  role: ResearchRole;
  stage: ResearchStageId;
  id: string;
  reason: string;
}

/** Called only for explicit user resume; never authorize automatic execution replay. */
export function planFusionContinuations(p: ResearchProject): FusionContinuationPlan[] {
  const graph = p.fusion;
  const stage = p.currentStage;
  if (p.workflowVersion !== "fusion-v2" || !graph || !stage || p.status === "completed") return [];
  const plans: FusionContinuationPlan[] = [];
  for (const task of graph.tasks) {
    if (
      !task.id.startsWith(`v${p.revision}:`) ||
      task.state !== "pending" ||
      !RESEARCH_ROLES.includes(task.role as ResearchRole) ||
      !isResearchStageId(task.stage) ||
      task.continuations.some((c) => !c.attemptId)
    )
      continue;
    const lastAttempt = graph.attempts.filter((a) => a.taskId === task.id).at(-1);
    if (
      lastAttempt?.state !== "succeeded" ||
      lastAttempt.taskVersion !== task.inputVersion ||
      researchTaskBlockers(graph, task.id).length ||
      [...lastAttempt.inputRefs, ...(lastAttempt.acquiredInputs ?? [])].some(
        (ref) =>
          !graph.adoptedInputs.some(
            (input) => input.inputId === ref.inputId && input.version === ref.version,
          ),
      ) ||
      task.inputs.some(
        (ref) =>
          !lastAttempt.inputRefs.some(
            (input) => input.inputId === ref.inputId && input.version === ref.version,
          ),
      ) ||
      graph.artifacts.some(
        (artifact) =>
          artifact.taskId === task.id &&
          artifact.taskVersion === task.inputVersion &&
          !artifact.interim &&
          !["needs-review", "superseded"].includes(artifact.reviewState),
      )
    )
      continue;
    const roleTaskIds = new Set(graph.tasks.filter((t) => t.role === task.role).map((t) => t.id));
    if (
      graph.attempts.some(
        (a) => roleTaskIds.has(a.taskId) && ["prepared", "running", "unknown"].includes(a.state),
      )
    )
      continue;
    const id = `fusion-user-resume:${task.id}:v${task.inputVersion}:${lastAttempt.id}`;
    if (task.continuations.some((c) => c.id === id)) continue;
    plans.push({
      taskId: task.id,
      role: task.role as ResearchRole,
      stage: task.stage,
      id,
      reason: `用户显式恢复：执行 ${lastAttempt.id} 已正常结束，但尚未发布当前输入的有效交付；继续该任务并保留已有成果。`,
    });
  }
  const latest = (kind: ResearchArtifactKind) => stageLatest(p, kind, stage);
  if (latest("stage-review")?.verdict === "accept") return plans;
  const add = (
    role: ResearchRole,
    kind: ResearchArtifactKind,
    trigger: ResearchArtifact,
    triggerId = trigger.id,
  ) => {
    const task = graph.tasks.find(
      (t) => t.id.startsWith(`v${p.revision}:`) && t.stage === stage && t.role === role,
    );
    if (!task || task.state !== "completed") return;
    const roleTaskIds = new Set(graph.tasks.filter((t) => t.role === role).map((t) => t.id));
    if (
      graph.attempts.some(
        (a) => roleTaskIds.has(a.taskId) && ["prepared", "running", "unknown"].includes(a.state),
      )
    )
      return;
    const lastAttempt = graph.attempts.filter((a) => a.taskId === task.id).at(-1);
    if (lastAttempt && ["failed", "cancelled"].includes(lastAttempt.state)) return;
    const id = `fusion-handoff:${task.id}:${kind}:${triggerId}`;
    if (task.continuations.some((c) => c.id === id)) return;
    plans.push({
      taskId: task.id,
      role,
      stage,
      id,
      reason: `恢复缺失交接：读取 ${trigger.id} 并完成 ${kind}。`,
    });
  };
  const draft = latest("stage-draft");
  const critique = latest("stage-critique");
  const revision = latest("stage-revision");
  const verification = latest("stage-verification");
  const review = latest("stage-review");
  const languageScope = p.languageScopes
    ?.filter(
      (scope) =>
        scope.revision === p.revision &&
        p.artifacts.some((a) => a.id === scope.baseline.id && a.stage === stage) &&
        !p.languageRevisions?.some(
          (revision) => revision.authorization.id === scope.authorization.id,
        ),
    )
    .at(-1);
  if (languageScope) {
    const baseline = p.artifacts.find((a) => a.id === languageScope.baseline.id)!;
    add("lead", "stage-revision", baseline, `language-scope:${languageScope.id}`);
    return plans;
  }
  const languageRevision = p.languageRevisions
    ?.filter((entry) => entry.target.id === (revision ?? draft)?.id)
    .at(-1);
  if (languageRevision) {
    const report = reportResearchLanguageRevision(
      languageRevision,
      p.artifacts.map((a) => createResearchLanguageArtifact(a.id, a.content)),
    );
    if (report.status === "needs-review") {
      for (const role of ["lead", "reviewer"] as const)
        if (report.pending.some((item) => item.role === role))
          add(
            role,
            role === "lead" ? "stage-revision" : "stage-verification",
            (revision ?? draft)!,
            `language-review:${languageRevision.id}`,
          );
      return plans;
    }
  }
  if (draft && latest("stage-risk") && !critique && !verification)
    add("reviewer", "stage-critique", draft);
  // Match the pipeline's latest actionable revision blocker, including explicit reconsideration.
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
  if (blocker && !revision?.refs.includes(blocker.id)) {
    // Two unsuccessful revisions go to the mentor, never an invalid third revision.
    if (
      blocker.verdict === "revise" &&
      blocker.round >= 2 &&
      blocker.id !== reconsidered?.artifactId
    ) {
      if (
        blocker.kind === "stage-verification" &&
        revision &&
        !(review?.refs.includes(revision.id) && review.refs.includes(blocker.id))
      )
        add("mentor", "stage-review", blocker);
      return plans;
    }
    add("lead", "stage-revision", blocker);
    return plans;
  }
  const manuscript = revision ?? draft;
  if (revision && !verification?.refs.includes(revision.id)) {
    add("reviewer", "stage-verification", revision);
  } else if (
    manuscript &&
    verification?.refs.includes(manuscript.id) &&
    !(review?.refs.includes(manuscript.id) && review.refs.includes(verification.id))
  ) {
    add("mentor", "stage-review", verification);
  }
  return plans;
}
