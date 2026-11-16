import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import { activeFusionAttempt } from "./fusion-task-runtime";

/** Evidence identity must survive another producer's normal native completion.
 * Keep inputs, artifact/review versions, decisions and every native's immutable
 * identity. Only another member's derived task state and successful settlement
 * are irrelevant; the accepting member's entire active attempt/task stay pinned.
 */
export function researchAcceptanceTaskContext(p: ResearchProject, role: ResearchRole) {
  const graph = p.fusion;
  if (!graph) return undefined;
  const owner = activeFusionAttempt(p, role);
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      if (task.id === owner?.taskId) return task;
      const { state: _state, ...evidence } = task;
      return {
        ...evidence,
        blockers: task.blockers.filter((blocker) => {
          if (blocker.kind !== "attempt") return true;
          const attempt = graph.attempts.find((row) => row.id === blocker.objectId);
          return (
            !attempt ||
            attempt.taskId !== task.id ||
            !attempt.nativeRunId ||
            !["running", "succeeded"].includes(attempt.state)
          );
        }),
      };
    }),
    attempts: graph.attempts.map((attempt) => {
      if (attempt.id === owner?.id) return attempt;
      const {
        finishedAt: _finishedAt,
        usedTokens: _usedTokens,
        sessionTotalTokens: _sessionTotalTokens,
        tokenUsage: _tokenUsage,
        sessionTokenUsage: _sessionTokenUsage,
        ...evidence
      } = attempt;
      return {
        ...evidence,
        state: attempt.state === "succeeded" ? "running" : attempt.state,
      };
    }),
    ownerTask: graph.tasks.find((task) => task.id === owner?.taskId),
  };
}
