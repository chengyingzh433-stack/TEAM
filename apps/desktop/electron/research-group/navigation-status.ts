import { createHash } from "node:crypto";
import {
  RESEARCH_ROLES,
  type ResearchProject,
  type ResearchRole,
} from "../../contracts/research-group";
import { activeFusionAttempt } from "./fusion-task-runtime";
import { researchTaskUsage } from "./task-graph";

const digest = (value: unknown[]) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Navigation only: the persisted ledger and current native's complete inputs stay intact. */
export function researchNavigationStatus(project: ResearchProject, role: ResearchRole) {
  const graph = project.fusion;
  const currentAttempt = activeFusionAttempt(project, role);
  const currentTask = graph?.tasks.find((task) => task.id === currentAttempt?.taskId);
  return {
    tasks: graph?.tasks.map(
      ({ goal, earlyHandoff, deliverable, writeScope, inputs, continuations, ...task }) => ({
        ...task,
        inputCount: inputs.length,
        inputPinsSha256: digest(inputs),
        continuationCount: continuations.length,
        continuations: continuations.filter((continuation) => !continuation.attemptId),
      }),
    ),
    attempts: graph?.attempts.map(
      ({ inputRefs, acquiredInputs, acquiredArtifacts, ...attempt }) => ({
        ...attempt,
        inputRefCount: inputRefs.length,
        inputRefsSha256: digest(inputRefs),
        acquiredInputCount: acquiredInputs?.length ?? 0,
        acquiredInputsSha256: digest(acquiredInputs ?? []),
        acquiredArtifactCount: acquiredArtifacts?.length ?? 0,
        acquiredArtifactsSha256: digest(acquiredArtifacts ?? []),
      }),
    ),
    currentTask,
    currentAttempt,
    methodPackageUses: project.methodPackageUses?.map(
      ({ projectId, revision, sessionId, model, ...use }) => use,
    ),
    budget: {
      memberTokenBudget: project.memberTokenBudget,
      roles: RESEARCH_ROLES.map((memberRole) => {
        const taskIds = new Set(
          graph?.tasks.filter((task) => task.role === memberRole).map((task) => task.id),
        );
        const usage = graph
          ? researchTaskUsage({
              ...graph,
              attempts: graph.attempts.filter((attempt) => taskIds.has(attempt.taskId)),
            })
          : { knownTokens: 0, reservedTokens: 0, unknownAttempts: [] };
        return { role: memberRole, ...usage };
      }),
    },
  };
}
