import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESEARCH_ROLES } from "../../contracts/research-group";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { createResearchMethodPackage } from "../../electron/research-group/method-packages";
import {
  verifyResearchMethodResumeCache,
  type MethodProject,
} from "../../electron/research-group/method-package-tools";

const at = "2026-11-08T08:00:00.000Z";
const imagePath = "素材/原图/synthetic.png";
const secondImagePath = "素材/原图/second-synthetic.png";
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZqkAAAAASUVORK5CYII=",
  "base64",
);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(options: { images?: boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "method-resume-cache-")),
    course = join(workspace, "course");
  await mkdir(join(course, "索引"), { recursive: true });
  await mkdir(join(course, "溯源"), { recursive: true });
  await mkdir(join(course, "素材", "原图"), { recursive: true });
  const records = [
    {
      id: "SYNTHETIC-METHOD",
      title: "合成方法缓存",
      text: "本夹具只验证固定包离线恢复，不是实际课程内容或模型判断。",
      required_context_ids: [],
      image_paths: options.images === false ? [] : [imagePath, secondImagePath],
      content_layers: ["course_paraphrase"],
    },
  ];
  await writeFile(
    join(course, "索引", "知识块.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  await writeFile(join(course, "溯源", "来源清单.json"), JSON.stringify({ version: "fixture-v1" }));
  await writeFile(
    join(course, "溯源", "图片清单.json"),
    JSON.stringify(records[0]!.image_paths.map((path) => ({ path, sha256: sha(imageBytes) }))),
  );
  for (const path of records[0]!.image_paths) await writeFile(join(course, path), imageBytes);
  const knowledge = await ResearchKnowledge.open(course);
  const pkg = await createResearchMethodPackage({
    id: "method-package:resume-fixture",
    at,
    knowledge,
    rootIds: ["SYNTHETIC-METHOD"],
    retrievedRecords: knowledge.retrieve("", "lead", ["SYNTHETIC-METHOD"]),
  });
  const id = randomUUID();
  const project: MethodProject = {
    id,
    root: { workspaceId: workspace, sessionId: id + "-mentor" },
    workspacePath: workspace,
    objective: "合成夹具：只核已有固定包的离线恢复",
    revision: 1,
    status: "paused",
    createdAt: at,
    updatedAt: at,
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    knowledge: structuredClone(knowledge.pin),
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: id + "-" + role },
      status: "idle",
    })),
    artifacts: [],
    packets: [],
    events: [],
    methodPackages: [pkg],
  };
  const directory = join(workspace, ".lancer", "research-method-packages", pkg.packageSha256),
    manifest = join(directory, "package.json"),
    image = join(directory, "images", imagePath);
  await mkdir(join(directory, "images", "素材", "原图"), { recursive: true });
  await writeFile(manifest, JSON.stringify(pkg));
  for (const path of records[0]!.image_paths)
    await writeFile(join(directory, "images", path), imageBytes);
  return { project, course, pkg, directory, manifest, image };
}

test("a paused project can verify its acquired fixed package after the original course is offline", async () => {
  const s = await fixture();
  await rename(s.course, s.course + "-offline");
  const before = structuredClone(s.project),
    manifest = await readFile(s.manifest),
    image = await readFile(s.image);
  await expect(verifyResearchMethodResumeCache(s.project)).resolves.toEqual([s.pkg.id]);
  expect(s.project).toEqual(before);
  expect(await readFile(s.manifest)).toEqual(manifest);
  expect(await readFile(s.image)).toEqual(image);
});

test("shared cache alone cannot authorize a project that never acquired a fixed package", async () => {
  const s = await fixture();
  s.project.methodPackages = [];
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow("尚无当前课程pin");
});

for (const field of ["sha256", "version", "count"] as const)
  test("offline recovery rejects a different current knowledge " + field, async () => {
    const s = await fixture();
    if (field === "sha256") s.project.knowledge.sha256 = "f".repeat(64);
    else if (field === "version") s.project.knowledge.version = "different-version";
    else s.project.knowledge.count = 99;
    await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow("尚无当前课程pin");
  });

test("missing cache is rejected without creating an empty replacement tree", async () => {
  const s = await fixture();
  const root = join(s.project.workspacePath, ".lancer", "research-method-packages");
  await rename(root, root + "-retained");
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow();
  await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(join(root + "-retained", s.pkg.packageSha256, "package.json"))).isFile()).toBe(
    true,
  );
});

test("an acquired package still needs its own cache path and original immutable content", async () => {
  const s = await fixture();
  await rename(s.directory, s.directory + "-retained");
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow();
  await rename(s.directory + "-retained", s.directory);
  s.project.methodPackages![0]!.records[0]!.text = "Changed after acquisition";
  await writeFile(s.manifest, JSON.stringify(s.project.methodPackages![0]));
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow("原文或版本摘要已改变");
});

test("strict cache decoding rejects added private fields and a different package identity", async () => {
  const s = await fixture();
  await writeFile(s.manifest, JSON.stringify({ ...s.pkg, privateDraft: "unrelated project" }));
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow();
  await writeFile(s.manifest, JSON.stringify({ ...s.pkg, id: "method-package:other" }));
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow("固定版本不一致");
});

test("text-only packages also require a complete, parseable fixed manifest", async () => {
  const s = await fixture({ images: false });
  await expect(verifyResearchMethodResumeCache(s.project)).resolves.toEqual([s.pkg.id]);
  await writeFile(s.manifest, "{broken");
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow();
  await rename(s.manifest, s.manifest + "-retained");
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow();
});

test("every readable image is checked, including same-size changes to the second image", async () => {
  const s = await fixture();
  const image = join(s.directory, "images", secondImagePath);
  const bytes = Buffer.from(imageBytes);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(image, bytes);
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow("SHA已变化");
  await writeFile(image, imageBytes.subarray(0, imageBytes.length - 1));
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow("字节数或文件状态变化");
  await rename(image, image + "-retained");
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow();
});

test("an image symlink outside the fixed package cannot stand in for the cached image", async () => {
  const s = await fixture();
  await rename(s.image, s.image + "-retained");
  await symlink(join(s.course, imagePath), s.image);
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow("越出固定方法包目录");
});

test("legacy projects cannot use the fusion fixed-cache fallback", async () => {
  const s = await fixture();
  delete s.project.workflowVersion;
  await expect(verifyResearchMethodResumeCache(s.project)).rejects.toThrow("仅融合版");
});
