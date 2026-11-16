import { ResearchCoordinator } from "../../electron/research-group/coordinator";
import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { XMLValidator } from "fast-xml-parser";
import { ResearchRepository, decodeResearchState } from "../../electron/research-group/repository";
import {
  RESEARCH_ROLES,
  decodeResearchAction,
  type ResearchProject,
  type ResearchArtifact,
} from "../../contracts/research-group";

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "lancer-m4-docx-"));
  const manuscript: ResearchArtifact = {
    id: randomUUID(),
    role: "lead",
    kind: "stage-draft",
    stage: "audit",
    revision: 1,
    round: 0,
    createdAt: "2026-11-14T00:00:00Z",
    refs: [],
    toolCallId: "draft",
    sourceIds: ["s1"],
    analysisIds: [],
    content:
      "# 中文标题\n样本数 42，不作因果推断。[SRC:s1]\n## 结果\n| 指标 | 数值 |\n| --- | --- |\n| 样本 | 42 |\n| 边界 | a & b < c |\n### 局限\n**原样强调**与链接 [出处](https://example.org)。",
  };
  const project: ResearchProject = {
    id: randomUUID(),
    root: { workspaceId: workspace, sessionId: "mentor" },
    workspacePath: workspace,
    objective: "文稿导出逻辑夹具",
    revision: 1,
    status: "completed",
    createdAt: manuscript.createdAt,
    updatedAt: manuscript.createdAt,
    knowledge: { directory: workspace, sha256: "test", version: "test", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: workspace, sessionId: role },
      status: "idle",
    })),
    artifacts: [manuscript],
    packets: [],
    events: [],
  };
  return { workspace, manuscript, project, repository: new ResearchRepository(workspace) };
}
function unpack(bytes: Uint8Array) {
  const parts = unzipSync(bytes);
  for (const [name, value] of Object.entries(parts))
    expect(XMLValidator.validate(strFromU8(value)), name).toBe(true);
  return {
    document: strFromU8(parts["word/document.xml"]!),
    styles: strFromU8(parts["word/styles.xml"]!),
  };
}
test("DOCX persists editable headings, linked TOC, Chinese styles and exact numeric table from one snapshot", async () => {
  const s = await fixture();
  s.project.evidence = {
    directory: s.workspace,
    datasets: [],
    sources: [
      {
        id: "s1",
        authors: "张三",
        year: "2024",
        title: "观察研究",
        url: "https://example.org",
        file: join(s.workspace, "source.txt"),
        sha256: "a".repeat(64),
        kind: "paper",
        access: "provided-text",
      },
    ],
  };
  const original = structuredClone(s.manuscript);
  const pending = s.repository.writeFinalPaper(s.project, s.manuscript);
  s.project.revision = 2;
  s.manuscript.content = "# 另一版本\n样本数 900";
  const files = await pending;
  const bytes = await readFile(files.docx!);
  const { document, styles } = unpack(bytes);
  expect(document).toContain('w:anchor="section_1"');
  expect(document).toContain('w:pStyle w:val="Heading1"');
  expect(styles).toContain('w:eastAsia="宋体"');
  expect(document).toContain("<w:tbl>");
  expect(document).toContain("<w:tblHeader/>");
  expect(document).toContain(">42</w:t>");
  expect(document).toContain("a &amp; b &lt; c");
  expect(document).toContain("本轮接受稿");
  expect(document).toContain("（张三，2024）");
  expect(document).toContain("观察研究");
  expect(document).not.toContain("另一版本");
  const provenance = JSON.parse(await readFile(files.provenance, "utf8")) as Record<
    string,
    unknown
  >;
  expect(provenance.docxSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(provenance.manuscriptSha256).toBe(
    createHash("sha256").update(original.content).digest("hex"),
  );
  expect(await readFile(files.markdown, "utf8")).toBe(original.content + "\n");
});
test("review export marks missing sources and preserves acceptance state and all previous deliveries", async () => {
  const s = await fixture();
  s.project.status = "paused";
  const before = structuredClone(s.project);
  const files = await s.repository.writeFinalPaper(s.project, s.manuscript, "review");
  const xml = unpack(await readFile(files.docx!)).document;
  expect(xml).toContain("审阅稿 · 待核验");
  expect(xml).toContain("尚缺项");
  const body = xml.split("附录：来源与计算对应")[0]!;
  expect(body).not.toContain("[SRC:s1]");
  expect(xml).toContain("内部来源编号：s1");
  expect(s.project).toEqual(before);
  const again = await s.repository.writeFinalPaper(s.project, s.manuscript, "review");
  expect(again.docx).not.toBe(files.docx);
  expect(unpack(await readFile(files.docx!))).toEqual(unpack(await readFile(again.docx!)));
});
test("storage failure rejects without replacing obstructing bytes and permits a later fresh attempt", async () => {
  const s = await fixture();
  await mkdir(join(s.workspace, ".lancer"));
  const obstruction = join(s.workspace, ".lancer", "research-groups");
  await writeFile(obstruction, "retained failure evidence");
  await expect(s.repository.writeFinalPaper(s.project, s.manuscript)).rejects.toThrow();
  expect(await readFile(obstruction, "utf8")).toBe("retained failure evidence");
  expect(s.project.finalPaper).toBeUndefined();
  // Retain the failed location; use a different actual destination for recovery.
  s.project.workspacePath = await mkdtemp(join(tmpdir(), "lancer-m4-recovery-"));
  const files = await s.repository.writeFinalPaper(s.project, s.manuscript);
  expect(unpack(await readFile(files.docx!)).document).toContain("中文标题");
  expect(
    await readdir(join(s.project.workspacePath, ".lancer", "research-groups", s.project.id)),
  ).toHaveLength(1);
});
test("delivery decoder retains old exports and rejects corrupt new DOCX paths; review action is narrow", async () => {
  const s = await fixture();
  s.project.finalPaper = { markdown: "/old.md", html: "/old.html", provenance: "/old.json" };
  const state = { version: 1, config: { knowledgeDir: "" }, projects: [s.project] };
  expect(decodeResearchState(state).projects[0]!.finalPaper).toEqual(s.project.finalPaper);
  expect(() =>
    decodeResearchState({
      ...state,
      projects: [{ ...s.project, finalPaper: { ...s.project.finalPaper, docx: 42 } }],
    }),
  ).toThrow("交付记录");
  expect(
    decodeResearchAction({
      kind: "export-review",
      target: s.project.root,
      input: { manuscriptId: "draft-1" },
    }).kind,
  ).toBe("export-review");
  expect(() =>
    decodeResearchAction({
      kind: "export-review",
      target: s.project.root,
      input: { manuscriptId: "draft-1", path: "/tmp/elsewhere" },
    }),
  ).toThrow();
});

test("review delivery persists through coordinator reload without accepting or dispatching work", async () => {
  const s = await fixture();
  s.project.status = "paused";
  await s.repository.save({ version: 1, config: { knowledgeDir: "" }, projects: [s.project] });
  const host = {
    createMember: async () => {
      throw new Error("no member creation during export");
    },
    deliver: async () => {
      throw new Error("no model dispatch during export");
    },
    cancel: async () => {},
    changed: () => {},
  };
  const coordinator = new ResearchCoordinator(s.repository, host);
  await coordinator.load();
  await coordinator.exportReview(s.project.root, s.manuscript.id);
  await expect(coordinator.exportReview(s.project.root, "unrelated-manuscript")).rejects.toThrow(
    "实际主稿",
  );
  const reloaded = new ResearchCoordinator(s.repository, host);
  await reloaded.load();
  const project = reloaded.snapshot().projects[0]!;
  expect(project.status).toBe("paused");
  expect(project.finalPaper).toBeUndefined();
  expect(project.artifacts).toEqual(s.project.artifacts);
  expect(project.reviewPapers).toHaveLength(1);
  expect(unpack(await readFile(project.reviewPapers![0]!.files.docx!)).document).toContain(
    "审阅稿 · 待核验",
  );
});
