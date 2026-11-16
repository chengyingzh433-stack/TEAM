import type { SessionDriverEvent } from "@lancer/session-driver";

export function isUndeliveredResearchHandoffError(error: unknown): boolean {
  return (
    String(error).includes(
      "Session finished streaming before the queued message could be delivered",
    ) ||
    String(error).includes(
      "Message was not delivered: cannot await a same-session send from its event listener.",
    )
  );
}
/** Native Pi rejected this undelivered entry; the coordinator owns boundary deferral. */
export function isUndeliveredResearchHandoff(event: SessionDriverEvent): boolean {
  return (
    event.type === "runFailed" &&
    !event.runId &&
    event.error.code === "SEND_FAILED" &&
    isUndeliveredResearchHandoffError(event.error.message)
  );
}
