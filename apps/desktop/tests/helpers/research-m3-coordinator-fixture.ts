import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionRef, SessionSnapshot } from "@lancer/session-driver";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchRepository } from "../../electron/research-group/repository";

export async function m3Coordinator(projects: ResearchProject[], applicationLimit = 8) {
  const directory = await mkdtemp(join(tmpdir(), "m3-coordinator-logic-"));
  const repository = new ResearchRepository(directory);
  for (const p of projects) p.status = "paused";
  await repository.save({
    version: 1,
    config: { knowledgeDir: "" },
    m3: { applicationLimit },
    projects,
  });
  const sent: { ref: SessionRef; text: string }[] = [],
    cancelled: SessionRef[] = [];
  const snapshots = new Map<string, SessionSnapshot>();
  const refKey = (r: SessionRef) => JSON.stringify(r);
  const host: ResearchHost = {
    createMember: async (root, role, model) => ({
      role,
      model,
      ref: { workspaceId: root.workspaceId, sessionId: randomUUID() },
      status: "idle",
    }),
    deliver: async (ref, text) => {
      sent.push({ ref, text });
    },
    cancel: async (ref) => {
      cancelled.push(ref);
    },
    inspectSession: async (ref) => {
      const snapshot = snapshots.get(refKey(ref));
      if (!snapshot) throw new Error("unit fixture has no native usage snapshot");
      return snapshot;
    },
    changed: () => {},
  };
  const c = new ResearchCoordinator(repository, host);
  await c.load();
  const native = async (
    projectId: string,
    actor: ResearchRole | { specialistId: string },
    outcome: "start" | "completed" | "failed",
    total?: number,
  ) => {
    const p = c.snapshot().projects.find((p) => p.id === projectId)!;
    const member =
      typeof actor === "string"
        ? p.members.find((m) => m.role === actor)!
        : p.m3!.specialists!.find((s) => s.id === actor.specialistId)!;
    const role = typeof actor === "string" ? actor : `specialist:${actor.specialistId}`;
    const attempt = p.fusion
      ? p.fusion.attempts
          .filter(
            (a) =>
              p.fusion!.tasks.some((t) => t.id === a.taskId && t.role === role) &&
              ["prepared", "running", "unknown"].includes(a.state),
          )
          .at(-1)!
      : c
          .snapshot()
          .m3?.legacyExecutions?.filter(
            (a) =>
              a.projectId === p.id &&
              a.role === role &&
              ["prepared", "running", "unknown"].includes(a.state),
          )
          .at(-1);
    if (!attempt) throw new Error("native unit fixture needs an admitted attempt");
    const runId = attempt.nativeRunId ?? `unit-native-${attempt.id}`,
      timestamp = new Date().toISOString();
    const snapshot: SessionSnapshot = {
      ref: member.ref,
      workspace: { workspaceId: p.root.workspaceId, path: p.workspacePath },
      title: "M3 unit native lifecycle fixture",
      status: outcome === "start" ? "running" : outcome === "failed" ? "failed" : "idle",
      updatedAt: timestamp,
      ...(outcome === "start" ? { runningRunId: runId } : {}),
      ...(total === undefined
        ? {}
        : {
            usage: {
              cache: {},
              subscription: true,
              totals: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            },
          }),
    };
    snapshots.set(refKey(member.ref), snapshot);
    if (outcome === "start")
      c.onSessionEvent({
        type: "sessionUpdated",
        sessionRef: member.ref,
        timestamp,
        runId,
        snapshot,
      });
    else if (outcome === "completed")
      c.onSessionEvent({
        type: "runCompleted",
        sessionRef: member.ref,
        timestamp,
        runId,
        snapshot,
      });
    else
      c.onSessionEvent({
        type: "runFailed",
        sessionRef: member.ref,
        timestamp,
        runId,
        error: { message: "503 temporary provider failure", code: "SERVICE_UNAVAILABLE" },
      });
    await c.flush();
  };
  return { c, host, repository, directory, sent, cancelled, snapshots, native };
}
