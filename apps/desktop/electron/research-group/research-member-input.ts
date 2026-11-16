import { randomUUID } from "node:crypto";
import type {
  ResearchArtifact,
  ResearchProject,
  ResearchRole,
} from "../../contracts/research-group";
import { researchHash } from "./materials";
import { researchM3Owner } from "./m3-owner";

/** A model's reasoned handling is distinct from the user's request and from research permission. */
export function respondToResearchMemberInput(
  p: ResearchProject,
  role: ResearchRole,
  input: Record<string, unknown>,
  at: string,
  current: ResearchArtifact | undefined,
) {
  const owner = researchM3Owner(p, role);
  const message = p.m3?.memberInputs?.find(
    (message) =>
      message.id === input.memberInputId &&
      message.revision === p.revision &&
      message.actor === role &&
      message.taskId === owner.task.id &&
      !!message.attemptId,
  );
  if (
    !message ||
    !current ||
    current.stage !== owner.task.stage ||
    current.id !== input.artifactId ||
    !p.fusion!.tasks.some((task) => task.currentArtifactId === current.id) ||
    !p.events.some(
      (event) =>
        event.type === "read" &&
        event.role === role &&
        event.artifactId === current.id &&
        event.runId === owner.attempt.nativeRunId,
    )
  )
    throw new Error("先在本次执行实际读取当前稿，再回应本人实际收到的用户补充。");
  if (
    !["no-manuscript-change", "requires-revision"].includes(String(input.memberInputDisposition)) ||
    typeof input.content !== "string" ||
    input.content.trim().length < 80 ||
    input.content.length > 20000
  )
    throw new Error("用户补充的处理需要明确是否改稿及80–20000字具体理由，不能自动假定已落实。");
  if ((message.responses?.length ?? 0) >= 8)
    throw new Error("本条用户补充已有多次意见，请形成实际修订后复核。");
  const response = {
    id: randomUUID(),
    kind: "model" as const,
    at,
    attemptId: owner.attempt.id,
    artifactId: current.id,
    artifactSha256: researchHash(current.content),
    disposition: input.memberInputDisposition as "no-manuscript-change" | "requires-revision",
    content: input.content.trim(),
  };
  (message.responses ??= []).push(response);
  return {
    ...response,
    note: "这是具名模型的处理说明，不代表用户许可或所有事实已核验；需修订时继续原A/B修订复核链。",
  };
}

export function assertResearchMemberInputsHandled(
  p: ResearchProject,
  role: ResearchRole,
  publication: Record<string, unknown>,
  manuscript: ResearchArtifact | undefined,
): void {
  if (!p.fusion || publication.verdict !== "accept") return;
  const ancestors = new Set<string>(),
    pending = manuscript ? [manuscript.id] : [];
  while (pending.length) {
    const id = pending.pop()!;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    pending.push(
      ...(p.artifacts.find((a) => a.id === id && a.revision === p.revision)?.refs ?? []),
    );
  }
  for (const message of p.m3?.memberInputs?.filter(
    (message) =>
      message.revision === p.revision &&
      !message.actor.startsWith("specialist:") &&
      p.fusion!.tasks.some(
        (task) =>
          task.id === message.taskId &&
          task.inputVersion === message.taskVersion &&
          task.stage === p.currentStage,
      ),
  ) ?? []) {
    // A recorded exploratory reply is conversation, not an instruction to revise or approve.
    // Only user-originated discussion entries delivered to the mentor qualify.
    if (
      message.actor === "mentor" &&
      p.m3?.discussions?.some(
        (topic) =>
          topic.revision === message.revision &&
          topic.messages.some(
            (entry) => entry.id === message.id && entry.actor === "user" && entry.intent === "idea",
          ),
      )
    )
      continue;
    const own = p.fusion.tasks.find((task) => task.id === message.taskId)!;
    const delivery = p.artifacts.some(
      (artifact) =>
        artifact.memberInputIds?.includes(message.id) &&
        artifact.role === message.actor &&
        (artifact.role === "lead"
          ? ancestors.has(artifact.id)
          : p.fusion!.artifacts.some(
              (a) =>
                a.id === artifact.id && a.taskId === own.id && a.taskVersion === own.inputVersion,
            )),
    );
    const response = message.responses?.at(-1);
    const explained =
      response?.disposition === "no-manuscript-change" &&
      response.artifactId === manuscript?.id &&
      response.artifactSha256 === researchHash(manuscript.content);
    const currentReview =
      message.actor === role &&
      Array.isArray(publication.memberInputIds) &&
      publication.memberInputIds.includes(message.id);
    if (!delivery && !explained && !currentReview)
      throw new Error(
        `用户补充 ${message.id} 尚未针对当前稿交付或具名说明无需改稿，不能接受旧稿跨过未完成工作。`,
      );
  }
}
