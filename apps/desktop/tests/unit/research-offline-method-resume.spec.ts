import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESEARCH_ROLES,
  researchStages,
  type ResearchConfig,
  type ResearchProject,
} from "../../contracts/research-group";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchRepository } from "../../electron/research-group/repository";
import { ensureFusionStageTasks } from "../../electron/research-group/fusion-task-runtime";
import { pauseResearchTasks } from "../../electron/research-group/task-graph";
import { createResearchMethodPackage } from "../../electron/research-group/method-packages";
import { verifyResearchMethodResumeCache } from "../../electron/research-group/method-package-tools";

test("a restarted unfinished project resumes from its intact pinned method cache when its original KB is offline", async () => {
  // L only: synthetic course/PNG and host; real package creation, filesystem cache,
  // Repository reload, resume and cache validation. No Pi/native/provider execution.
  const directory = await mkdtemp(join(tmpdir(), "research-offline-method-resume-")),
    workspace = join(directory, "workspace"),
    kb = join(directory, "course"),
    imagePath = "素材/原图/synthetic.png";
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZqkAAAAASUVORK5CYII=",
    "base64",
  );
  await Promise.all([
    mkdir(join(kb, "索引"), { recursive: true }),
    mkdir(join(kb, "溯源"), { recursive: true }),
    mkdir(join(kb, "素材", "原图"), { recursive: true }),
    mkdir(workspace),
  ]);
  await writeFile(join(kb, imagePath), image);
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "SYNTHETIC-METHOD",
      title: "合成方法缓存",
      text: "仅验证旧项目离线恢复，不是课程学术结论。",
      required_context_ids: [],
      image_paths: [imagePath],
      content_layers: ["course_paraphrase"],
    }),
  );
  await writeFile(
    join(kb, "溯源", "来源清单.json"),
    JSON.stringify({ version: "synthetic-offline-v1" }),
  );
  await writeFile(
    join(kb, "溯源", "图片清单.json"),
    JSON.stringify([{ path: imagePath, sha256: createHash("sha256").update(image).digest("hex") }]),
  );
  const knowledge = await ResearchKnowledge.open(kb),
    at = new Date().toISOString();
  const pkg = await createResearchMethodPackage({
    id: "synthetic-fixed-package",
    at,
    knowledge,
    rootIds: ["SYNTHETIC-METHOD"],
    retrievedRecords: knowledge.retrieve("", "lead", ["SYNTHETIC-METHOD"]),
    additionalImageReferences: [],
  });
  const cache = join(workspace, ".lancer", "research-method-packages", pkg.packageSha256),
    cacheFile = join(cache, "package.json"),
    cacheImage = join(cache, "images", imagePath);
  await mkdir(join(cache, "images", "素材", "原图"), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(pkg));
  await writeFile(cacheImage, image);
  const config: ResearchConfig = {
    knowledgeDir: kb,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "question",
    scope: "proposal",
  };
  const root = { workspaceId: workspace, sessionId: "mentor" };
  const project: ResearchProject = {
    id: randomUUID(),
    root,
    workspacePath: workspace,
    objective: "合成未完成任务：只续用已固定方法包",
    revision: 1,
    status: "paused",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "question",
    scope: "proposal",
    currentStage: "question",
    knowledge: knowledge.pin,
    stages: researchStages(config),
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
    methodPackages: [pkg],
    evidence: { directory: workspace, sources: [], datasets: [] },
  };
  ensureFusionStageTasks(project, at);
  project.fusion = pauseResearchTasks(project.fusion!);
  expect(await verifyResearchMethodResumeCache(project)).toEqual([pkg.id]);
  const repository = new ResearchRepository(directory);
  await repository.save({ version: 1, config, projects: [project] });
  const beforeCache = await readFile(cacheFile),
    releases: (() => void)[] = [],
    delivered: string[] = [];
  const host: ResearchHost = {
    createMember: async () => {
      throw new Error("Resume must retain old member sessions");
    },
    deliver: async (ref) => {
      delivered.push(ref.sessionId);
      await new Promise<void>((resolve) => releases.push(resolve));
    },
    cancel: async () => {
      releases.splice(0).forEach((release) => release());
    },
    changed: () => {},
  };
  const coordinator = new ResearchCoordinator(repository, host);
  await coordinator.load();
  await rename(kb, `${kb}-offline-retained`);
  try {
    await coordinator.resume(root);
    // Resume schedules dispatch after its persisted mutation. Observe actual host
    // entry and drain those admissions before teardown pauses this synthetic host.
    await expect.poll(() => delivered.length).toBeGreaterThan(0);
    await coordinator.flush();
    const resumed = coordinator.snapshot().projects[0]!;
    expect(resumed.fusion!.attempts.some((attempt) => attempt.state === "prepared")).toBe(false);
    expect(resumed.status).toBe("running");
    expect(resumed.knowledge).toEqual(project.knowledge);
    expect(resumed.methodPackages).toEqual([pkg]);
    expect(resumed.members.map((member) => member.ref)).toEqual(
      project.members.map((member) => member.ref),
    );
    expect(resumed.finalPaper).toBeUndefined();
    expect(resumed.artifacts).toEqual([]);
    expect(await verifyResearchMethodResumeCache(resumed)).toEqual([pkg.id]);
    expect(await readFile(cacheFile)).toEqual(beforeCache);
    expect(await readFile(cacheImage)).toEqual(image);
  } finally {
    await coordinator.pause(root);
    await coordinator.flush();
    await test.info().attach("synthetic-offline-resume.json", {
      body: JSON.stringify({ directory, project: coordinator.snapshot().projects[0] }),
      contentType: "application/json",
    });
  }
});
