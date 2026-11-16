import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LANCER_ASSISTANTS } from "../../contracts/lancer-assistants";
import { DEFAULT_LANCER_MODULES, moduleZones } from "../../contracts/lancer-modules";
import { conversationZoneId } from "../../contracts/lancer-zones";
import { LancerAssistantStore } from "../../electron/application/lancer-assistant-store";
import { expectDoubaoSend } from "../../electron/ipc/doubao-app-requests";

test("upgrading removes retired presets while preserving ownership, workflows and the original file", async () => {
  const profile = await mkdtemp(join(tmpdir(), "lancer-retired-modules-"));
  const file = join(profile, "assistants.json");
  const custom = { id: "module-my-project", label: "我的项目", color: "#334455", description: "" };
  const oldModules = ["video", "research", "xhs"].map((id) => ({
    id,
    label: id,
    color: "#334455",
    description: "",
  }));
  const saved = {
    ...DEFAULT_LANCER_ASSISTANTS,
    modules: [...DEFAULT_LANCER_MODULES, ...oldModules, custom],
    owners: { "workspace:old-session": "research" },
    workflows: {
      "workspace:old-session": { steps: [{ title: "用户保存的步骤", goal: "保留原内容" }] },
    },
  };
  const original = JSON.stringify(saved, null, 2) + "\n";
  await writeFile(file, original);
  const store = new LancerAssistantStore(profile);
  const loaded = await store.load();
  expect(loaded.modules?.map((module) => module.id)).toEqual([
    "paper",
    "github",
    "lancer",
    "cyz-paper",
    "edu-research-group",
    custom.id,
  ]);
  expect(loaded.owners).toEqual(saved.owners);
  expect(loaded.workflows).toEqual(saved.workflows);
  expect(await readFile(file, "utf8")).toBe(original);
  for (const module of oldModules) {
    expect(conversationZoneId(`lancer-zone:${module.id}|原会话`, saved.modules)).toBe("chat");
    await expect(store.change({ kind: "save-module", module })).rejects.toThrow("已移除");
  }
  expect(moduleZones(saved.modules).map((module) => module.id)).toEqual([
    "chat",
    "paper",
    "github",
    "lancer",
    "cyz-paper",
    "edu-research-group",
    custom.id,
  ]);
  await store.change({ kind: "save-module", module: { ...custom, label: "重命名后的项目" } });
  expect(await readFile(`${file}.bak`, "utf8")).toBe(original);
  const restarted = await new LancerAssistantStore(profile).load();
  expect(restarted.modules?.find((module) => module.id === custom.id)?.label).toBe(
    "重命名后的项目",
  );
  expect(restarted.owners).toEqual(saved.owners);
  expect(restarted.workflows).toEqual(saved.workflows);
});

test("ordinary Doubao messages cannot request the removed download behavior", () => {
  const message = { target: { workspaceId: "workspace", sessionId: "chat" }, text: "查看项目说明" };
  expect(expectDoubaoSend(message)).toEqual(message);
  expect(() => expectDoubaoSend({ ...message, download: true })).toThrow(
    "Unsupported message option",
  );
});
