import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { teamUserDataDirectory } from "../../electron/platform/app-identity";

test("TEAM reads the existing Lancer profile location without relocating its state", async () => {
  const root = await mkdtemp(join(tmpdir(), "team-identity-"));
  const prior = join(root, "Lancer");
  await mkdir(prior);
  const original = '{"projects":[{"id":"retained-project"}]}';
  await writeFile(join(prior, "research-groups.json"), original);
  expect(await readFile(join(teamUserDataDirectory(root), "research-groups.json"), "utf8")).toBe(
    original,
  );
  expect(teamUserDataDirectory(root, "  ")).toBe(prior);
  expect(teamUserDataDirectory(root, " /isolated/research ")).toBe("/isolated/research");
  expect(await readFile(join(prior, "research-groups.json"), "utf8")).toBe(original);
});
