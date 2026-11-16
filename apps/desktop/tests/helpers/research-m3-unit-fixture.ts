import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RESEARCH_ROLES,
  researchStages,
  type ResearchArtifact,
  type ResearchProject,
  type ResearchRole,
} from "../../contracts/research-group";
import { researchHash } from "../../electron/research-group/materials";
import {
  bindFusionNativeRun,
  dispatchFusionAttempt,
  ensureFusionStageTasks,
  prepareFusionDelivery,
  publishFusionArtifact,
} from "../../electron/research-group/fusion-task-runtime";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { snapshotSharedResearchMethod } from "../../contracts/shared-research-method";

export const M3_BODY =
  "合成逻辑测试材料：学生描述实验中出现的不同证据解释，不能把满意度当作理解成绩。另一片段说明反例与同伴讨论可能改变解释；这是测试文本，不是真实研究原文。";
export const M3_MANUSCRIPT =
  "# 测试稿\n\n## 引言\n保留引言😀和引用[1]。\n\n## 方法\n保留方法和引用[2]。\n\n## 讨论\n仅这一章允许修改，原始文字与引用[3]。\n\n## 结论\n保留结论。\n";
export async function m3Project(
  path: ResearchProject["path"] = "review",
  stage: ResearchProject["currentStage"] = "analysis",
) {
  const directory = await mkdtemp(join(tmpdir(), "research-m3-unit-"));
  const knowledgeDir = join(directory, "course");
  await mkdir(join(knowledgeDir, "索引"), { recursive: true });
  await mkdir(join(knowledgeDir, "溯源"));
  await writeFile(
    join(knowledgeDir, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "M3-FIXTURE",
      title: "测试方法",
      text: M3_BODY,
      required_context_ids: [],
    }) + "\n",
  );
  await writeFile(
    join(knowledgeDir, "溯源", "来源清单.json"),
    JSON.stringify({ version: "m3-unit-fixture" }),
  );
  const id = randomUUID(),
    at = new Date().toISOString();
  const p: ResearchProject = {
    id,
    root: { workspaceId: directory, sessionId: `mentor-${id}` },
    workspacePath: directory,
    objective: "隔离的M3逻辑检查，不执行真实研究。",
    revision: 1,
    status: "running",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "paper",
    path,
    scope: "paper",
    currentStage: stage,
    knowledge: {
      directory: knowledgeDir,
      sha256: "a".repeat(64),
      version: "m3-unit-fixture",
      count: 1,
    },
    memberTokenBudget: 8_000_000,
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: directory, sessionId: `${role}-${id}` },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
    evidence: { directory, sources: [], datasets: [] },
  };
  for (const [sourceId, body, kind] of [
    ["paper-a", M3_BODY, "paper"],
    ["paper-b", M3_BODY + " 第二材料明确相反解释。", "paper"],
    ["manuscript", M3_MANUSCRIPT, "manuscript"],
  ] as const) {
    const file = join(directory, `${sourceId}.txt`);
    await writeFile(file, body);
    p.evidence!.sources.push({
      id: sourceId,
      title: sourceId,
      authors: "synthetic unit fixture",
      year: "2026",
      url: "",
      file,
      sha256: researchHash(body),
      kind,
      access: "provided-text",
      textScope: "full-text",
    });
  }
  p.stages = researchStages(p);
  p.sharedMethod = snapshotSharedResearchMethod();
  p.knowledge = (await ResearchKnowledge.open(knowledgeDir)).pin;
  ensureFusionStageTasks(p, at);
  return { p, directory, knowledgeDir, at };
}
export function m3Activate(p: ResearchProject, role: ResearchRole, at = new Date().toISOString()) {
  const attemptId = randomUUID(),
    nativeId = `fixture-native-${attemptId}`;
  const result = prepareFusionDelivery(p, role, attemptId, at, "单元测试派发");
  if (result.kind !== "dispatch")
    throw new Error(`fixture could not dispatch: ${JSON.stringify(result)}`);
  dispatchFusionAttempt(p, attemptId, at);
  bindFusionNativeRun(p, role, nativeId);
  const attempt = p.fusion!.attempts.find((a) => a.id === attemptId)!;
  attempt.model = { provider: "fixture", modelId: "logic-only", thinkingLevel: "high" };
  return attempt;
}
export function m3ReadSources(
  p: ResearchProject,
  role: ResearchRole,
  at = new Date().toISOString(),
) {
  const sessionId = p.members.find((m) => m.role === role)!.ref.sessionId;
  for (const source of p.evidence!.sources) {
    const body =
      source.id === "paper-a"
        ? M3_BODY
        : source.id === "paper-b"
          ? M3_BODY + " 第二材料明确相反解释。"
          : M3_MANUSCRIPT;
    (p.sourceReads ??= []).push({
      id: randomUUID(),
      sourceId: source.id,
      sourceSha256: source.sha256,
      bodySha256: researchHash(body),
      locatorId: `text:${source.id}`,
      start: 0,
      end: body.length,
      depth: "full-text",
      sessionId,
      at,
      evidenceRef: "unit-native-source-read",
    });
    p.events.push({
      id: randomUUID(),
      at,
      revision: p.revision,
      type: "source-read",
      role,
      sourceId: source.id,
      sourceSha256: source.sha256,
      detail: "explicit unit fixture read",
    });
  }
}
export function m3Artifact(
  p: ResearchProject,
  role: ResearchRole,
  kind: ResearchArtifact["kind"],
  extra: Partial<ResearchArtifact> = {},
) {
  const a: ResearchArtifact = {
    id: randomUUID(),
    role,
    kind,
    revision: p.revision,
    round: 0,
    stage: p.currentStage,
    content: M3_BODY + M3_BODY,
    refs: [],
    toolCallId: randomUUID(),
    createdAt: new Date().toISOString(),
    ...extra,
  };
  p.artifacts.push(a);
  publishFusionArtifact(p, a);
  return a;
}
