import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { ResearchSpecialist } from "../../contracts/research-m3";
import {
  applySpecialistTool,
  assertSpecialistAcceptance,
  registerResearchSpecialistTask,
  validateSpecialistInputs,
} from "../../electron/research-group/research-specialists";
import {
  startResearchTask,
  markResearchTaskDispatched,
} from "../../electron/research-group/task-graph";
import { decodeResearchState } from "../../electron/research-group/repository";
import { m3Activate, m3Artifact, m3Project, M3_BODY } from "../helpers/research-m3-unit-fixture";

async function externalFixture() {
  const { p } = await m3Project("review", "synthesis");
  m3Activate(p, "lead");
  const draft = m3Artifact(p, "lead", "stage-draft");
  const id = randomUUID();
  const s: ResearchSpecialist = {
    id,
    kind: "external-reviewer",
    label: "独立审阅逻辑测试",
    ref: { workspaceId: p.root.workspaceId, sessionId: `specialist-${id}` },
    revision: 1,
    taskId: `v1:synthesis:specialist:${id}`,
    stage: "synthesis",
    objective: "只检查这份当前稿的证据边界",
    deliverable: "有原文依据的独立意见",
    exitCondition: "意见交付后待整合",
    integrator: "lead",
    sourceIds: ["paper-a"],
    artifactIds: [draft.id],
    model: { provider: "fixture", modelId: "independent" },
    state: "running",
    reads: [],
  };
  registerResearchSpecialistTask(p, s, new Date().toISOString());
  (p.m3 ??= {}).specialists = [s];
  const attemptId = randomUUID();
  p.fusion = startResearchTask(p.fusion!, s.taskId, {
    id: attemptId,
    at: new Date().toISOString(),
    reservedTokens: 4096,
    model: s.model,
  });
  p.fusion = markResearchTaskDispatched(p.fusion, attemptId, new Date().toISOString());
  p.fusion.attempts.find((a) => a.id === attemptId)!.nativeRunId = `specialist-native-${id}`;
  const old = {
    id: randomUUID(),
    revision: 1,
    stage: "synthesis" as const,
    role: "mentor" as const,
    kind: "stage-review" as const,
    round: 0,
    createdAt: new Date().toISOString(),
    content: "PRIVATE_OLD_MENTOR_TENDENCY",
    refs: [],
    toolCallId: "old",
  };
  p.artifacts.push(old);
  p.events.push({
    id: "private-event",
    at: new Date().toISOString(),
    type: "message",
    role: "reviewer",
    detail: "PRIVATE_OLD_DEBATE",
    revision: 1,
  });
  const tool = (operation: string, rest: Record<string, unknown> = {}) =>
    applySpecialistTool(p, s, { operation, ...rest }, new Date().toISOString());
  return { p, s, draft, old, tool };
}
test("external initial context does not expose old debate, mentor opinion, or unselected sources", async () => {
  const { p, s, draft, old, tool } = await externalFixture();
  const context = await tool("status");
  const serialized = JSON.stringify(context);
  expect(serialized).not.toContain("PRIVATE_OLD");
  expect(serialized).not.toContain("paper-b");
  await expect(tool("read", { artifactId: old.id })).rejects.toThrow("初判前");
  await expect(tool("source-read", { sourceId: "paper-b" })).rejects.toThrow("授权范围");
  await expect(tool("claim-context", { artifactId: old.id })).rejects.toThrow("不能访问");
  expect(await tool("read", { artifactId: draft.id })).toMatchObject({ content: draft.content });
  expect(p.members.map((m) => m.ref.sessionId)).not.toContain(s.ref.sessionId);
});
test("external first opinion requires actual selected reads and standards, and cannot overwrite the manuscript", async () => {
  const { p, s, draft, tool } = await externalFixture();
  const before = draft.content;
  await expect(tool("specialist-submit", { content: M3_BODY + M3_BODY })).rejects.toThrow(
    "本人实际读取",
  );
  await tool("source-read", { sourceId: "paper-a" });
  await tool("read", { artifactId: draft.id });
  await tool("method-package");
  const opinion = (await tool("specialist-submit", { content: M3_BODY + M3_BODY })) as {
    id: string;
  };
  expect(s.initialOpinion!.id).toBe(opinion.id);
  expect(s.state).toBe("submitted");
  expect(p.artifacts.find((a) => a.id === draft.id)!.content).toBe(before);
  expect(() => assertSpecialistAcceptance(p)).toThrow("整合");
  expect(
    decodeResearchState({ version: 1, config: { knowledgeDir: "" }, projects: [p] }).projects[0]!
      .m3!.specialists![0]!.initialOpinion!.content,
  ).toBe(M3_BODY + M3_BODY);
});
test("opening later discussion never changes the independent opinion; follow-up stays a separate version", async () => {
  const { p, s, draft, old, tool } = await externalFixture();
  await tool("source-read", { sourceId: "paper-a" });
  await tool("read", { artifactId: draft.id });
  await tool("method-package");
  await tool("specialist-submit", { content: M3_BODY + M3_BODY });
  const initial = structuredClone(s.initialOpinion);
  await expect(tool("specialist-submit", { content: M3_BODY + "后续" })).rejects.toThrow(
    "尚未开放",
  );
  s.discussionOpenedAt = new Date().toISOString();
  s.discussionQuestion = "核对本阶段新增争论，并说明维持或改变初判的依据。";
  expect(JSON.stringify(await tool("specialist-context"))).toContain(old.id);
  expect(await tool("read", { artifactId: old.id })).toMatchObject({
    content: "PRIVATE_OLD_MENTOR_TENDENCY",
  });
  await tool("specialist-submit", { content: M3_BODY + M3_BODY + "已开放讨论后的有边界回应。" });
  expect(s.initialOpinion).toEqual(initial);
  expect(s.followups).toHaveLength(1);
  expect(s.followups![0]!.id).not.toBe(s.initialOpinion!.id);
  const checked = decodeResearchState({ version: 1, config: { knowledgeDir: "" }, projects: [p] });
  expect(checked.projects[0]!.m3!.specialists![0]!.followups).toHaveLength(1);
});
test("external selection rejects a mentor verdict and changed originals cannot qualify a new opinion", async () => {
  const { p, s, old, draft, tool } = await externalFixture();
  expect(() => validateSpecialistInputs(p, { ...s, artifactIds: [old.id] })).toThrow();
  await tool("source-read", { sourceId: "paper-a" });
  await tool("read", { artifactId: draft.id });
  await tool("method-package");
  await writeFile(p.evidence!.sources.find((s) => s.id === "paper-a")!.file, "changed original");
  await expect(tool("specialist-submit", { content: M3_BODY + M3_BODY })).rejects.toThrow("已变化");
  expect(s.initialOpinion).toBeUndefined();
});
