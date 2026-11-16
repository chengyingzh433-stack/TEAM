import { expect, test } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RESEARCH_ROLES, type ResearchProject } from "../../contracts/research-group";
import type { ResearchArchiveManifest } from "../../contracts/research-archive";
import {
  exportResearchArchive,
  stageResearchArchiveImport,
  validateResearchArchive,
} from "../../electron/research-group/research-archive";
import {
  calculateResearchData,
  RESEARCH_ANALYSIS_ENGINE,
} from "../../electron/research-group/analysis";
import { ResearchRepository } from "../../electron/research-group/repository";
import { ResearchCoordinator, type ResearchHost } from "../../electron/research-group/coordinator";

const sha = (data: string) => createHash("sha256").update(data).digest("hex");
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "lancer-ac16-"));
  const materials = join(workspace, "materials");
  await mkdir(materials);
  const source = "允许分发的测试来源，不是真实研究证据。";
  const secret = "UNRELATED_AUTH_AND_TRANSCRIPT_SENTINEL";
  await writeFile(join(workspace, "auth.json"), secret);
  await writeFile(join(materials, "source.txt"), source);
  await writeFile(join(materials, "private.txt"), "NOT_LICENSED_ORIGINAL");
  const csv = "x\n1\n2\n3\n4\n";
  await writeFile(join(materials, "input.csv"), csv);
  const id = randomUUID(),
    artifactId = randomUUID(),
    at = "2026-11-14T00:00:00Z";
  const project: ResearchProject = {
    id,
    root: { workspaceId: workspace, sessionId: "mentor" },
    workspacePath: workspace,
    objective: "同名测试课题",
    revision: 1,
    status: "paused",
    createdAt: at,
    updatedAt: at,
    knowledge: {
      directory: "/private/course",
      sha256: "a".repeat(64),
      version: "fixture-v1",
      count: 1,
    },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: role },
      status: "idle",
    })),
    artifacts: [
      {
        id: artifactId,
        role: "lead",
        kind: "stage-draft",
        stage: "audit",
        revision: 1,
        round: 0,
        createdAt: at,
        content: "# 原稿\n样本数 4。",
        refs: [],
        toolCallId: "private-call",
      },
    ],
    packets: [],
    events: [],
    evidence: {
      directory: materials,
      sources: [
        {
          id: "source",
          title: "可分发",
          authors: "作者",
          year: "2026",
          url: "https://example.org/source",
          file: join(materials, "source.txt"),
          sha256: sha(source),
          kind: "paper",
          access: "provided-text",
        },
        {
          id: "private",
          title: "不分发",
          authors: "作者",
          year: "2026",
          url: "https://example.org/private",
          file: join(materials, "private.txt"),
          sha256: sha("NOT_LICENSED_ORIGINAL"),
          kind: "paper",
          access: "provided-text",
        },
      ],
      datasets: [
        {
          id: "data",
          file: join(materials, "input.csv"),
          sha256: sha(csv),
          description: "合成数据",
          sourceId: "source",
          dataKind: "synthetic",
          permission: "user-authorized",
          delimiter: ",",
        },
      ],
    },
  };
  const directory = join(workspace, ".lancer", "research-groups", id, "analysis", "run");
  await mkdir(directory, { recursive: true });
  const spec = { datasetId: "data", method: "describe" as const, columns: ["x"] };
  const result = calculateResearchData(csv, ",", spec);
  const run = {
    id: "run",
    revision: 1,
    role: "lead" as const,
    createdAt: at,
    spec,
    datasetSha256: sha(csv),
    engine: RESEARCH_ANALYSIS_ENGINE,
    result,
    sha256: sha(JSON.stringify(result)),
    file: join(directory, "result.json"),
  };
  project.analyses = [run];
  await writeFile(run.file, JSON.stringify(run));
  await writeFile(join(directory, "input.csv"), csv);
  await writeFile(join(directory, "spec.json"), JSON.stringify({ delimiter: ",", spec }));
  await writeFile(
    join(directory, "replay.mjs"),
    `import {readFileSync} from 'node:fs';\nconst calculate=${calculateResearchData.toString()};\nconst {delimiter,spec}=JSON.parse(readFileSync(new URL('./spec.json',import.meta.url),'utf8'));\nconsole.log(JSON.stringify(calculate(readFileSync(new URL('./input.csv',import.meta.url),'utf8'),delimiter,spec)));`,
  );
  return { project, workspace, result, secret };
}
const selection = { sourceIds: ["source"], datasetIds: ["data"] };
test("archive relocates with pinned files, readable manuscripts and a real independently executed replay", async () => {
  const s = await fixture();
  const original = structuredClone(s.project);
  const pending = exportResearchArchive(s.project, selection);
  s.project.objective = "later live change";
  s.project.artifacts[0]!.content = "new manuscript";
  const receipt = await pending;
  const moved = join(await mkdtemp(join(tmpdir(), "lancer-ac16-moved-")), "archive");
  await cp(receipt.directory, moved, { recursive: true });
  await rename(s.workspace, s.workspace + "-retained");
  const archive = await validateResearchArchive(moved);
  expect(archive.manifest.objective).toBe(original.objective);
  expect(archive.files.get("manuscripts/0.md")!.toString()).toBe(original.artifacts[0]!.content);
  const all = [...archive.files.values()].map((b) => b.toString()).join("\n");
  expect(all).not.toContain(s.secret);
  expect(all).not.toContain("NOT_LICENSED_ORIGINAL");
  expect(all).not.toContain(s.workspace);
  expect(all).not.toContain("private-call");
  expect(
    archive.manifest.missing.some((m) => m.id === "private" && m.obtain.includes("example.org")),
  ).toBe(true);
  const replay = await promisify(execFile)(
    process.execPath,
    [join(moved, "analyses/0/replay.mjs")],
    { cwd: moved },
  );
  expect(JSON.parse(replay.stdout)).toEqual(s.result);
  const imported = await stageResearchArchiveImport(
    moved,
    join(await mkdtemp(join(tmpdir(), "lancer-ac16-import-")), "imports"),
  );
  expect(imported.projectId).not.toBe(original.id);
  expect(imported.receipt.sourceProjectId).toBe(original.id);
  expect((await validateResearchArchive(imported.receipt.directory)).manifestSha256).toBe(
    receipt.manifestSha256,
  );
});
test("unlicensed data also excludes every analysis input copy; source tampering and links fail export", async () => {
  const s = await fixture();
  const receipt = await exportResearchArchive(s.project, { sourceIds: [], datasetIds: [] });
  const archive = await validateResearchArchive(receipt.directory);
  expect(
    archive.manifest.files.some((f) => ["source", "dataset", "analysis"].includes(f.kind)),
  ).toBe(false);
  await writeFile(s.project.evidence!.sources[0]!.file, "changed source");
  await expect(exportResearchArchive(s.project, selection)).rejects.toThrow("固定版本");
  const link = join(s.project.evidence!.directory, "linked.txt");
  await symlink(join(s.workspace, "auth.json"), link);
  s.project.evidence!.sources[0]!.file = link;
  await expect(exportResearchArchive(s.project, selection)).rejects.toThrow("符号链接");
});
for (const attack of [
  "traversal",
  "absolute",
  "backslash",
  "duplicate",
  "version",
  "fingerprint",
  "extra",
  "symlink",
  "size",
] as const) {
  test(`import rejects ${attack} without applying any destination`, async () => {
    const s = await fixture();
    const receipt = await exportResearchArchive(s.project, selection);
    const manifestFile = join(receipt.directory, "manifest.json");
    const m = JSON.parse(await readFile(manifestFile, "utf8")) as ResearchArchiveManifest;
    if (attack === "traversal") m.files[0]!.path = "../outside.txt";
    if (attack === "absolute") m.files[0]!.path = "/tmp/outside.txt";
    if (attack === "backslash") m.files[0]!.path = "..\\outside.txt";
    if (attack === "duplicate")
      m.files.push({ ...m.files[0]!, path: m.files[0]!.path.toUpperCase() });
    if (attack === "version") Object.assign(m, { schema: "lancer-research-archive/999" });
    if (attack === "fingerprint")
      await writeFile(join(receipt.directory, m.files[0]!.path), "tampered");
    if (attack === "extra") await writeFile(join(receipt.directory, "auth.json"), "extra");
    if (attack === "symlink") await symlink(s.workspace, join(receipt.directory, "escape"));
    if (attack === "size") m.files[0]!.bytes = 999999999;
    await writeFile(manifestFile, JSON.stringify(m));
    const destination = join(s.workspace, "not-created");
    await expect(stageResearchArchiveImport(receipt.directory, destination)).rejects.toThrow();
    await expect(readFile(join(destination, "manifest.json"))).rejects.toThrow();
    expect(await readFile(manifestFile, "utf8")).toBe(JSON.stringify(m));
    expect(await readFile(join(s.workspace, "auth.json"), "utf8")).toBe(s.secret);
  });
}
test("coordinator imports duplicate titles as independent paused projects and preserves the original on reload", async () => {
  const s = await fixture();
  const receipt = await exportResearchArchive(s.project, selection);
  const repo = new ResearchRepository(s.workspace);
  await repo.save({ version: 1, config: { knowledgeDir: "" }, projects: [s.project] });
  let roots = 0;
  const host: ResearchHost = {
    createProjectRoot: async (ref) => ({
      workspaceId: ref.workspaceId,
      sessionId: `new-${++roots}`,
    }),
    createMember: async (root, role) => ({
      role,
      ref: role === "mentor" ? root : { ...root, sessionId: `${root.sessionId}-${role}` },
      status: "idle",
    }),
    deliver: async () => {
      throw new Error("must not dispatch");
    },
    cancel: async () => {},
    changed: () => {},
  };
  const coordinator = new ResearchCoordinator(repo, host);
  await coordinator.load();
  const first = await coordinator.importArchive(s.project.root, receipt.directory);
  await coordinator.importArchive(s.project.root, receipt.directory);
  const after = await repo.load();
  expect(after.projects).toHaveLength(3);
  expect(after.projects[0]).toEqual(s.project);
  expect(new Set(after.projects.map((p) => p.id)).size).toBe(3);
  expect(
    after.projects
      .slice(1)
      .every(
        (p) =>
          p.status === "paused" &&
          p.revision === 0 &&
          p.artifacts.length === 0 &&
          p.archiveOrigin?.sourceProjectId === s.project.id,
      ),
  ).toBe(true);
  await expect(coordinator.resume(first)).rejects.toThrow("明确新任务");
  await writeFile(join(receipt.directory, "records.json"), "damaged");
  await expect(coordinator.importArchive(s.project.root, receipt.directory)).rejects.toThrow(
    "指纹",
  );
  expect(roots).toBe(2);
  expect((await repo.load()).projects).toEqual(after.projects);
});

test("matching hashes cannot authorize a credential path or an incompatible record schema", async () => {
  const s = await fixture();
  const receipt = await exportResearchArchive(s.project, selection);
  const manifestFile = join(receipt.directory, "manifest.json");
  const original = JSON.parse(await readFile(manifestFile, "utf8")) as ResearchArchiveManifest;
  const attack = structuredClone(original);
  attack.files.push({
    path: "auth.json",
    kind: "record",
    originalId: s.project.id,
    bytes: 2,
    sha256: sha("{}"),
  });
  await writeFile(join(receipt.directory, "auth.json"), "{}");
  await writeFile(manifestFile, JSON.stringify(attack));
  await expect(validateResearchArchive(receipt.directory)).rejects.toThrow("登记用途");
  // Preserve the hostile package; create another for the record-schema case.
  const second = await exportResearchArchive(s.project, selection);
  const manifest = JSON.parse(
    await readFile(join(second.directory, "manifest.json"), "utf8"),
  ) as ResearchArchiveManifest;
  const invalidRecords = JSON.stringify({
    schema: "lancer-research-records/999",
    projectId: s.project.id,
    revision: 1,
    artifacts: [],
    sources: [],
    datasets: [],
  });
  await writeFile(join(second.directory, "records.json"), invalidRecords);
  Object.assign(
    manifest.files.find((f) => f.path === "records.json")!,
    { bytes: Buffer.byteLength(invalidRecords), sha256: sha(invalidRecords) },
  );
  await writeFile(join(second.directory, "manifest.json"), JSON.stringify(manifest));
  await expect(validateResearchArchive(second.directory)).rejects.toThrow("记录与清单");
});
test("changed replay parameters fail export; destination IO failure preserves source and last saved projects", async () => {
  const s = await fixture();
  const receipt = await exportResearchArchive(s.project, selection);
  const archiveBefore = await readFile(join(receipt.directory, "manifest.json"));
  await writeFile(
    join(s.workspace, ".lancer", "research-groups", s.project.id, "analysis", "run", "spec.json"),
    JSON.stringify({
      delimiter: ",",
      spec: { datasetId: "data", method: "describe", columns: ["other"] },
    }),
  );
  await expect(exportResearchArchive(s.project, selection)).rejects.toThrow("复算参数");
  const blockedDestination = join(s.workspace, "blocked");
  await writeFile(blockedDestination, "preserve me");
  await expect(stageResearchArchiveImport(receipt.directory, blockedDestination)).rejects.toThrow();
  expect(await readFile(blockedDestination, "utf8")).toBe("preserve me");
  expect(await readFile(join(receipt.directory, "manifest.json"))).toEqual(archiveBefore);
});

test("accepted Word and Markdown are archived with their fixed manuscript identity; modified Word is refused", async () => {
  const s = await fixture();
  s.project.finalPaper = await new ResearchRepository(s.workspace).writeFinalPaper(
    s.project,
    s.project.artifacts[0]!,
  );
  const receipt = await exportResearchArchive(s.project, selection);
  const archive = await validateResearchArchive(receipt.directory);
  expect(archive.manifest.files.find((f) => f.path === "deliveries/0/paper.docx")!.originalId).toBe(
    `accepted:${s.project.artifacts[0]!.id}`,
  );
  expect(archive.files.get("deliveries/0/paper.docx")).toEqual(
    await readFile(s.project.finalPaper.docx!),
  );
  expect(archive.files.get("deliveries/0/paper.md")!.toString()).toBe(
    s.project.artifacts[0]!.content + "\n",
  );
  await writeFile(s.project.finalPaper.docx!, "modified Word");
  await expect(exportResearchArchive(s.project, selection)).rejects.toThrow("固定版本");
  expect((await validateResearchArchive(receipt.directory)).manifestSha256).toBe(
    receipt.manifestSha256,
  );
});
