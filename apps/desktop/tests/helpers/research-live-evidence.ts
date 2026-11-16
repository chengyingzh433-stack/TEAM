import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import type { ResearchProject } from "../../contracts/research-group";
import { researchExecutionRoute } from "../../contracts/research-method";

/** Evidence helpers only: no test registration, launch, credential access or state mutation. */
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function captureResearchNativeBoundary(state: DesktopAppState, project: ResearchProject) {
  const requiredRoles = researchExecutionRoute(project).requiredRoles;
  const activeNativeAtCapture = project.members.flatMap((member) => {
    const session = state.workspaces
      .find((item) => item.id === member.ref.workspaceId)
      ?.sessions.find((item) => item.id === member.ref.sessionId);
    const attempts =
      project.fusion?.attempts.filter(
        (attempt) =>
          project.fusion!.tasks.find((task) => task.id === attempt.taskId)?.role === member.role &&
          ["prepared", "running", "unknown"].includes(attempt.state),
      ) ?? [];
    const unfinishedRunIds = project.events
      .filter(
        (event) =>
          event.type === "started" &&
          event.role === member.role &&
          event.runId &&
          !project.events.some((end) => end.type === "finished" && end.runId === event.runId),
      )
      .map((event) => event.runId);
    return !session ||
      session.status === "running" ||
      member.status === "running" ||
      attempts.length ||
      unfinishedRunIds.length
      ? [
          {
            role: member.role,
            sessionStatus: session?.status ?? "unknown",
            memberStatus: member.status,
            attempts,
            unfinishedRunIds,
          },
        ]
      : [];
  });
  const usage = project.members.map((member) => {
    const value = state.sessionUsageBySession[`${member.ref.workspaceId}:${member.ref.sessionId}`];
    return {
      role: member.role,
      requiredForThisTask: requiredRoles.includes(member.role),
      ref: member.ref,
      usage: value ?? null,
      moneySpent: value && !value.subscription ? value.totals.cost : null,
    };
  });
  const unknownUsageAttempts =
    project.fusion?.attempts
      .filter((attempt) => attempt.usedTokens === undefined)
      .map((attempt) => attempt.id) ?? [];
  return {
    activeNativeAtCapture,
    usage,
    usageFinality: activeNativeAtCapture.length
      ? "provisional-native-unsettled"
      : usage.some((item) => item.requiredForThisTask && !item.usage) || unknownUsageAttempts.length
        ? "native-ended-usage-incomplete"
        : "native-ended-provider-reported",
    unknownUsageAttempts,
    usageNotice:
      "Provider usage is not an independently verified bill; absent usage stays unknown, subscription estimates are not money spent.",
  };
}

export async function researchNativeCallLedger(profile: string, project: ResearchProject) {
  const directory = join(profile, "agent", "sessions");
  const paths = await readdir(directory, { recursive: true });
  return Promise.all(
    project.members.map(async (member) => {
      const file = paths.find((path) => path.endsWith(`_${member.ref.sessionId}.jsonl`));
      if (!file && !researchExecutionRoute(project).requiredRoles.includes(member.role))
        return {
          role: member.role,
          file: null,
          audit: "role-not-dispatched-no-session-log",
          calls: [],
          errors: [],
        };
      if (!file)
        throw new Error(
          `Native session log missing for ${member.role}; cannot claim tool coverage.`,
        );
      const calls: {
        id: string;
        name: unknown;
        operation: unknown;
        sourceId: unknown;
        artifactId: unknown;
        kind: unknown;
        at: unknown;
        resultAt?: unknown;
        isError?: boolean;
        errorText?: string;
      }[] = [];
      for (const line of (await readFile(join(directory, file), "utf8")).trim().split("\n")) {
        const entry = object(JSON.parse(line)),
          message = object(entry.message);
        const content = Array.isArray(message.content) ? message.content.map(object) : [];
        for (const part of content)
          if (part.type === "toolCall" && typeof part.id === "string") {
            const args = object(part.arguments);
            calls.push({
              id: part.id,
              name: part.name,
              operation: args.operation,
              sourceId: args.sourceId,
              artifactId: args.artifactId,
              kind: args.kind,
              at: entry.timestamp,
            });
          }
        if (message.role === "toolResult") {
          const call = calls.find((item) => item.id === message.toolCallId);
          if (call)
            Object.assign(call, {
              resultAt: entry.timestamp,
              isError: message.isError === true,
              ...(message.isError === true
                ? {
                    errorText: content
                      .filter((part) => typeof part.text === "string")
                      .map((part) => String(part.text))
                      .join("\n"),
                  }
                : {}),
            });
        }
      }
      return { role: member.role, file, calls, errors: calls.filter((call) => call.isError) };
    }),
  );
}
