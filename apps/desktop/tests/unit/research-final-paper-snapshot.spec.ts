import { expect, test } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchProject, ResearchArtifact } from "../../contracts/research-group";
import { ResearchRepository } from "../../electron/research-group/repository";

test("an export pins its manuscript and provenance before another version arrives during file IO", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "research-export-snapshot-"));
  const manuscript: ResearchArtifact = {
    id: randomUUID(),
    role: "lead",
    kind: "stage-draft",
    stage: "audit",
    revision: 1,
    round: 0,
    createdAt: "2026-11-08T00:00:00.000Z",
    refs: [],
    toolCallId: "v1",
    content: "# 已接受第一稿\n样本仅限本研究，不作因果推断。",
  };
  const project: ResearchProject = {
    id: randomUUID(),
    root: { workspaceId: workspace, sessionId: "mentor" },
    workspacePath: workspace,
    objective: "导出竞态软件演练",
    revision: 1,
    status: "completed",
    createdAt: manuscript.createdAt,
    updatedAt: manuscript.createdAt,
    knowledge: { directory: workspace, sha256: "test", version: "test", count: 0 },
    members: [],
    artifacts: [manuscript],
    packets: [],
    events: [],
  };
  const expected = structuredClone(manuscript);
  const pending = new ResearchRepository(workspace).writeFinalPaper(project, manuscript);
  // Synchronously advance the caller's objects while the real mkdir is pending.
  // No clock delay or mocked filesystem: a mutable export would mix v2 into the v1 folder.
  project.revision = 2;
  manuscript.content = "# 新到第二稿\n将相关误写成因果。";
  manuscript.revision = 2;
  const files = await pending;
  const [markdown, html, raw] = await Promise.all([
    readFile(files.markdown, "utf8"),
    readFile(files.html, "utf8"),
    readFile(files.provenance, "utf8"),
  ]);
  const provenance = JSON.parse(raw) as Record<string, unknown>;
  expect(markdown).toBe(expected.content + "\n");
  expect(html).toContain("已接受第一稿");
  expect(html).toContain("输入版本 1");
  expect(html).not.toContain("新到第二稿");
  expect(provenance.revision).toBe(1);
  expect(provenance.manuscriptId).toBe(expected.id);
  expect(provenance.manuscriptSha256).toBe(
    createHash("sha256").update(expected.content).digest("hex"),
  );
  expect(files.markdown).toContain(`paper-v1-${expected.id}`);
});
