import type { ResearchArtifact, ResearchProject } from "../../contracts/research-group";
import type { ResearchDecisionRequest } from "../../contracts/research-task-graph";
import { isCurrentResearchArtifact, stageLatest } from "./paper-pipeline";
import { requestResearchDecision } from "./task-graph";

/** A mentor's unresolved academic review asks a local human question, never pauses unrelated work. */
export function ensureFusionReviewDecision(
  p: ResearchProject,
  review: ResearchArtifact,
): ResearchDecisionRequest | undefined {
  if (
    p.workflowVersion !== "fusion-v2" ||
    !p.fusion ||
    review.role !== "mentor" ||
    review.kind !== "stage-review" ||
    !review.stage ||
    review.revision !== p.revision ||
    !(review.verdict === "hold" || (review.verdict === "revise" && review.round >= 2))
  )
    return;
  const id = `review-decision:${review.id}`;
  const previous = p.fusion.decisionRequests?.find((request) => request.id === id);
  if (previous) return previous;
  if (
    !isCurrentResearchArtifact(p, review) ||
    stageLatest(p, "stage-review", review.stage)?.id !== review.id
  )
    return;
  const task = p.fusion.tasks.find(
    (candidate) => candidate.id === `v${p.revision}:${review.stage}:mentor`,
  );
  if (!task) throw new Error("导师暂缓缺少对应阶段任务，不能创建无归属的待决条件。");
  const inputId = `review-condition:${task.id}`;
  const version =
    Math.max(
      0,
      ...p.fusion.inputs.filter((input) => input.inputId === inputId).map((input) => input.version),
    ) + 1;
  p.fusion = requestResearchDecision(p.fusion, {
    id,
    inputId,
    version,
    at: review.createdAt,
    requestedBy: "mentor-agent",
    question: `${review.stage} 阶段导师${review.verdict === "hold" ? "暂缓" : "两轮修订后仍要求修改"}，是否补充条件后继续核查？`,
    context: `导师成果 ${review.id}：${review.content.slice(0, 3000)}`,
    impact:
      "仅等待本阶段导师重新评审及依赖其接受结果的后续任务；资料整理和无关任务继续。确认继续不代表学术接受，也不自动开启第三轮修订。",
    taskIds: [task.id],
    options: [
      {
        id: "continue-review",
        label: "补充条件后继续核查",
        consequence: "记录实际答复，导师重新检查已有修订和复核；接受与否仍须另作学术裁定。",
        outcome: "confirmed",
      },
      {
        id: "keep-hold",
        label: "保留暂缓",
        consequence: "相关导师评审及依赖下游继续等待，无关工作可继续。",
        outcome: "declined",
      },
      {
        id: "defer",
        label: "暂不决定",
        consequence: "保留当前成果和待决条件，不产生新的评审请求。",
        outcome: "deferred",
      },
    ],
    recommendedOptionId: "defer",
  });
  return p.fusion.decisionRequests!.find((request) => request.id === id)!;
}
