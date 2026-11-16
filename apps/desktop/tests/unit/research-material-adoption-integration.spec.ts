import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESEARCH_ROLES,
  type ResearchGroupsState,
  type ResearchProject,
} from "../../contracts/research-group";
import type { MaterialAdoptionDeclaration } from "../../contracts/research-materials";
import { projectResearchMaterialAdoptionImpact } from "../../contracts/research-material-adoption-impact";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";
import { ResearchRepository } from "../../electron/research-group/repository";
import { ensureFusionStageTasks } from "../../electron/research-group/fusion-task-runtime";
import {
  addResearchTask,
  startResearchTask,
  markResearchTaskDispatched,
  publishResearchTaskResult,
  reviewResearchTaskArtifact,
} from "../../electron/research-group/task-graph";

const at = "2026-11-07T00:00:00.000Z";
const declaration: MaterialAdoptionDeclaration = {
  category: "data",
  sourceDescription: "集成测试合成数据，允许本次本地测试使用。",
  dataKind: "synthetic",
  permission: "user-authorized",
};

/** Gate only persistence timing; production decoding, filesystem writes and adoption still run. */
class GatedRepository extends ResearchRepository {
  private gate?: { entered: () => void; released: Promise<void> };
  gateNextSave() {
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { entered, released };
    return { observed, release };
  }
  override async save(state: ResearchGroupsState) {
    const gate = this.gate;
    this.gate = undefined;
    if (gate) {
      gate.entered();
      await gate.released;
    }
    await super.save(state);
  }
}

async function setup(status: ResearchProject["status"] = "completed") {
  const directory = await mkdtemp(join(tmpdir(), "lancer-adoption-integration-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const root = { workspaceId: workspace, sessionId: "mentor" };
  const project: ResearchProject = {
    id: randomUUID(),
    root,
    workspacePath: workspace,
    objective: "核对材料采用的真实影响；测试合成课题。",
    revision: 1,
    status,
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "idea",
    goal: "paper",
    path: "quantitative",
    scope: "paper",
    currentStage: "question",
    knowledge: { directory: "", sha256: "a".repeat(64), version: "fixture", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
    evidence: { directory: workspace, sources: [], datasets: [] },
    finalPaper: {
      markdown: join(workspace, "accepted.md"),
      html: join(workspace, "accepted.html"),
      provenance: join(workspace, "accepted.json"),
    },
  };
  ensureFusionStageTasks(project, at);
  for (const stage of ["question", "reading", "design", "analysis", "writing", "audit"]) {
    const id = `v1:${stage}:lead`;
    if (!project.fusion!.tasks.some((task) => task.id === id)) {
      project.fusion = addResearchTask(project.fusion!, {
        id,
        stage,
        role: "lead",
        kind: "research",
        goal: `${stage} 测试成果`,
        inputs: [],
        dependencies: [],
        earlyHandoff: "初稿",
        deliverable: "全文",
        reviewRequired: true,
        writeScope: [id],
      });
    }
    const attemptId = `attempt-${stage}`,
      artifactId = `artifact-${stage}`;
    project.fusion = startResearchTask(project.fusion!, id, {
      id: attemptId,
      at,
      reservedTokens: 20,
    });
    project.fusion = markResearchTaskDispatched(project.fusion, attemptId, at);
    project.fusion = publishResearchTaskResult(project.fusion, {
      projectId: project.id,
      id: artifactId,
      attemptId,
      at,
      content: `${stage} 实际保存的测试成果`,
      usedTokens: 5,
    });
    project.fusion = reviewResearchTaskArtifact(project.fusion, artifactId, {
      id: `review-${stage}`,
      at,
      actor: "program",
      reviewer: "test-fixture",
      verdict: "accepted",
      reason: "确定性测试接受状态，不代表专业审阅。",
    });
  }
  project.currentStage = "audit";
  const repository = new GatedRepository(directory);
  await repository.save({ version: 1, config: { knowledgeDir: "" }, projects: [project] });
  const host: ResearchHost = {
    createMember: async () => {
      throw new Error("unexpected member creation");
    },
    deliver: async () => {
      throw new Error("unexpected provider dispatch");
    },
    cancel: async () => {},
    changed: () => {},
  };
  const coordinator = new ResearchCoordinator(repository, host);
  await coordinator.load();
  expect(coordinator.snapshot().error).toBeUndefined();
  const csv = join(workspace, "new-observations.csv");
  await writeFile(csv, "id,score\na,3\nb,5\n");
  await coordinator.importMaterials(root, [csv]);
  const material = coordinator.snapshot().projects[0]!.importedMaterials![0]!;
  expect(material.status).toBe("ready");
  const adoptedDirectory = join(
    workspace,
    ".lancer",
    "research-groups",
    project.id,
    "adopted-materials",
  );
  const snapshot = () => coordinator.snapshot().projects[0]!;
  return {
    directory,
    workspace,
    repository,
    coordinator,
    root,
    material,
    adoptedDirectory,
    snapshot,
  };
}

test("coordinator refuses data adoption without a viewed impact when accepted artifacts exist", async () => {
  const s = await setup(),
    before = s.snapshot();
  await expect(s.coordinator.adoptMaterial(s.root, s.material.id, declaration)).rejects.toThrow(
    "查看当前具体影响",
  );
  expect(s.snapshot()).toEqual(before);
  expect((await s.repository.load()).projects[0]).toEqual(before);
  await expect(readdir(s.adoptedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("coordinator adopts the matching snapshot, retaining accepted upstream work and archiving the export", async () => {
  const s = await setup(),
    before = s.snapshot();
  const impact = projectResearchMaterialAdoptionImpact(before, "data");
  await s.coordinator.adoptMaterial(s.root, s.material.id, declaration, impact.token);
  const after = s.snapshot();
  expect(after.currentStage).toBe("design");
  expect(after.status).toBe("paused");
  expect(after.evidence!.sources).toHaveLength(1);
  expect(after.evidence!.datasets).toHaveLength(1);
  expect(after.evidence!.datasets[0]!.materialImportId).toBe(s.material.id);
  expect(await readFile(after.evidence!.datasets[0]!.file, "utf8")).toBe("id,score\na,3\nb,5\n");
  expect(after.finalPaper).toBeUndefined();
  expect(after.supersededExports![0]!.files).toEqual(before.finalPaper);
  for (const stage of ["question", "reading"]) {
    expect(after.fusion!.artifacts.find((artifact) => artifact.id === `artifact-${stage}`)).toEqual(
      before.fusion!.artifacts.find((artifact) => artifact.id === `artifact-${stage}`),
    );
    expect(after.fusion!.tasks.find((task) => task.id === `v1:${stage}:lead`)).toEqual(
      before.fusion!.tasks.find((task) => task.id === `v1:${stage}:lead`),
    );
  }
  for (const stage of ["design", "analysis", "writing", "audit"]) {
    expect(
      after.fusion!.artifacts.find((artifact) => artifact.id === `artifact-${stage}`)!.reviewState,
    ).toBe("needs-review");
    expect(
      after.fusion!.tasks.find((task) => task.id === `v1:${stage}:lead`)!.currentArtifactId,
    ).toBeUndefined();
  }
  expect((await s.repository.load()).projects[0]).toEqual(after);
  const saved = structuredClone(after);
  await s.coordinator.adoptMaterial(s.root, s.material.id, declaration, impact.token);
  expect(s.snapshot()).toEqual(saved);
});

test("coordinator rejects a stale adoption token after another material import", async () => {
  const s = await setup();
  const token = projectResearchMaterialAdoptionImpact(s.snapshot(), "data").token;
  const extra = join(s.workspace, "extra.txt");
  await writeFile(extra, "另一个候选来源，尚未采用。");
  await s.coordinator.importMaterials(s.root, [extra]);
  const before = s.snapshot();
  await expect(
    s.coordinator.adoptMaterial(s.root, s.material.id, declaration, token),
  ).rejects.toThrow("查看当前具体影响");
  expect(s.snapshot()).toEqual(before);
  expect(before.evidence!.sources).toHaveLength(0);
  await expect(readdir(s.adoptedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("coordinator rechecks the snapshot after real file preparation while a concurrent change waits to commit", async () => {
  const s = await setup("needs-decision");
  const token = projectResearchMaterialAdoptionImpact(s.snapshot(), "data").token;
  const gate = s.repository.gateNextSave();
  const pausing = s.coordinator.pause(s.root);
  await gate.observed;
  // The old snapshot remains visible while the real pause mutation is waiting on disk.
  expect(s.snapshot().status).toBe("needs-decision");
  const adopting = s.coordinator.adoptMaterial(s.root, s.material.id, declaration, token);
  const rejected = expect(adopting).rejects.toThrow("准备期间研究影响已变化");
  try {
    await expect
      .poll(async () => {
        const directories = await readdir(s.adoptedDirectory).catch(() => [] as string[]);
        const files = await Promise.all(
          directories.map((directory) =>
            readFile(join(s.adoptedDirectory, directory, "provenance.json"), "utf8").catch(
              () => "",
            ),
          ),
        );
        return files.some((content) => content.includes(s.material.id));
      })
      .toBe(true);
  } finally {
    gate.release();
  }
  await pausing;
  await rejected;
  expect(s.snapshot().status).toBe("paused");
  expect(s.snapshot().evidence!.sources).toHaveLength(0);
  expect(s.snapshot().evidence!.datasets).toHaveLength(0);
  expect(s.snapshot().finalPaper).toBeDefined();
  expect(s.snapshot().importedMaterials![0]).toEqual(s.material);
  expect(
    s.snapshot().fusion!.artifacts.every((artifact) => artifact.reviewState === "accepted"),
  ).toBe(true);
  expect((await s.repository.load()).projects[0]).toEqual(s.snapshot());
  expect(await readdir(s.adoptedDirectory)).toHaveLength(1);
});

test("additive text adoption does not invalidate the already accepted work or export", async () => {
  const s = await setup();
  const file = join(s.workspace, "method.txt");
  await writeFile(file, "这是本地测试提供的方法说明，不包含真实研究发现。");
  await s.coordinator.importMaterials(s.root, [file]);
  const before = s.snapshot(),
    material = before.importedMaterials!.find((item) => item.name === "method.txt")!;
  await s.coordinator.adoptMaterial(s.root, material.id, {
    category: "method",
    sourceDescription: "实际提供的方法文本，测试材料。",
  });
  const after = s.snapshot();
  expect(after.evidence!.sources).toHaveLength(1);
  expect(after.evidence!.datasets).toHaveLength(0);
  expect(after.finalPaper).toEqual(before.finalPaper);
  expect(after.fusion!.artifacts).toEqual(before.fusion!.artifacts);
  expect(after.currentStage).toBe("audit");
});
