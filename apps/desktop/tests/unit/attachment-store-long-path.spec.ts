import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../electron/persistence/attachment-store";

test("long Chinese workspace paths support missing, save, restore and listing without overlong filenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attachments-long-"));
  const key = `/Users/某位研究者/教育研究课题组/${"长期研究工作区/".repeat(8)}:session-1`;
  const data = [
    {
      id: "file",
      kind: "file" as const,
      name: "研究材料.md",
      mimeType: "text/markdown",
      fsPath: "/tmp/研究材料.md",
    },
  ];
  const store = new AttachmentStore(dir);
  expect(await store.read(key)).toBeUndefined();
  await store.write(key, data);
  await store.write(key, data);
  expect(await new AttachmentStore(dir).read(key)).toEqual(data);
  expect(await store.listKeys()).toEqual([key]);
  expect((await readdir(join(dir, "attachments"))).every((name) => name.length < 160)).toBe(true);
});

test("existing encodable long keys retain legacy bytes while new saves use a bounded filename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attachments-legacy-"));
  const key = `${"workspace/".repeat(17)}:session`;
  await mkdir(join(dir, "attachments"));
  const old = join(dir, "attachments", `${encodeURIComponent(key)}.json`);
  await writeFile(old, "[]\n");
  const store = new AttachmentStore(dir);
  expect(await store.read(key)).toEqual([]);
  await store.write(key, []);
  expect(await readFile(old, "utf8")).toBe("[]\n");
  expect(await store.listKeys()).toEqual([key]);
});
