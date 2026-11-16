import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHARED_RESEARCH_METHOD,
  SHARED_RESEARCH_METHOD_VERSION,
  snapshotSharedResearchMethod,
  formatSharedResearchMethod,
} from "../../contracts/shared-research-method";
import { CYZ_PAPER_MODULE_ID, CYZ_PAPER_WORKFLOW } from "../../contracts/cyz-paper-workflow";
import { DEFAULT_LANCER_MODULES } from "../../contracts/lancer-modules";
import { DEFAULT_LANCER_ASSISTANTS } from "../../contracts/lancer-assistants";
import { decodeLancerWorkflow } from "../../contracts/lancer-workflows";
import { LancerAssistantStore } from "../../electron/application/lancer-assistant-store";
import { loadCyzWorkflowGuide } from "../../electron/application/cyz-workflow-guide";

const resources = join(__dirname, "../../resources/workflows");

test("shared snapshots carry copied rule text and reject private project fields", () => {
  const snapshot = snapshotSharedResearchMethod();
  expect(snapshot.version).toBe(SHARED_RESEARCH_METHOD_VERSION);
  expect(snapshot).toEqual(CYZ_PAPER_WORKFLOW.method);
  expect(snapshot).not.toBe(SHARED_RESEARCH_METHOD);
  expect(snapshot.rules).not.toBe(SHARED_RESEARCH_METHOD.rules);
  expect(() => snapshotSharedResearchMethod({ ...snapshot, evidence: ["private-source"] })).toThrow(
    "字段",
  );
  expect(() =>
    snapshotSharedResearchMethod({ ...snapshot, rules: [...snapshot.rules, snapshot.rules[0]] }),
  ).toThrow("重复");
  expect(() =>
    snapshotSharedResearchMethod({ ...snapshot, rules: [{ id: "scope", text: "" }] }),
  ).toThrow("字段");
  expect(formatSharedResearchMethod(snapshot)).toContain("未答复不得自动同意");
});

test("new CYZ tasks freeze method text while later template updates and repeated inheritance leave old tasks unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shared-method-cyz-"));
  const store = new LancerAssistantStore(directory);
  await store.load();
  const first = { workspaceId: "research", sessionId: "first" },
    second = { ...first, sessionId: "second" };
  await store.inheritWorkflow(first, CYZ_PAPER_MODULE_ID);
  const pinned = store.snapshot().workflows!["research:first"]!;
  const changedMethod = snapshotSharedResearchMethod({
    ...SHARED_RESEARCH_METHOD,
    version: "2.1.0",
    rules: [{ id: "scope", text: "隔离副本中的新方法规则，仅供版本固定测试。" }],
  });
  const module = DEFAULT_LANCER_MODULES.find((item) => item.id === CYZ_PAPER_MODULE_ID)!;
  await store.change({
    kind: "save-module",
    module: { ...module, workflow: { ...CYZ_PAPER_WORKFLOW, method: changedMethod } },
  });
  await store.inheritWorkflow(second, CYZ_PAPER_MODULE_ID);
  await store.inheritWorkflow(first, CYZ_PAPER_MODULE_ID);
  const restored = await new LancerAssistantStore(directory).load();
  expect(restored.workflows!["research:first"]).toEqual(pinned);
  expect(restored.workflows!["research:second"]!.method).toEqual(changedMethod);
  const oldGuidance = await loadCyzWorkflowGuide(
    resources,
    "cyz-edu-research/S3",
    restored.workflows!["research:first"]!.method,
  );
  const newGuidance = await loadCyzWorkflowGuide(
    resources,
    "cyz-edu-research/S3",
    restored.workflows!["research:second"]!.method,
  );
  expect(oldGuidance).toContain(`共享教育研究方法 ${SHARED_RESEARCH_METHOD_VERSION}`);
  expect(oldGuidance).toContain(SHARED_RESEARCH_METHOD.rules[0]!.text);
  expect(oldGuidance).not.toContain(changedMethod.rules[0]!.text);
  expect(newGuidance).toContain("共享教育研究方法 2.1.0");
  expect(newGuidance).toContain(changedMethod.rules[0]!.text);
  expect(pinned.steps).toEqual(restored.workflows!["research:second"]!.steps);
});

test("existing unversioned workflows are not relabeled, while a newly created task from an old template gets a new snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shared-method-legacy-"));
  const legacyWorkflow = { steps: [{ ...CYZ_PAPER_WORKFLOW.steps[1]!, goal: "保留旧用户的问题" }] };
  const modules = DEFAULT_LANCER_MODULES.map((module) =>
    module.id === CYZ_PAPER_MODULE_ID ? { ...module, workflow: legacyWorkflow } : module,
  );
  const original = JSON.stringify(
    { ...DEFAULT_LANCER_ASSISTANTS, modules, workflows: { "research:old": legacyWorkflow } },
    null,
    2,
  );
  const file = join(directory, "assistants.json");
  await writeFile(file, original);
  const store = new LancerAssistantStore(directory);
  await store.load();
  expect(await readFile(file, "utf8")).toBe(original);
  expect(decodeLancerWorkflow(legacyWorkflow)).toEqual(legacyWorkflow);
  await store.inheritWorkflow({ workspaceId: "research", sessionId: "old" }, CYZ_PAPER_MODULE_ID);
  expect(await readFile(file, "utf8")).toBe(original);
  await store.inheritWorkflow({ workspaceId: "research", sessionId: "new" }, CYZ_PAPER_MODULE_ID);
  const state = store.snapshot();
  expect(state.workflows!["research:old"]).toEqual(legacyWorkflow);
  expect(state.workflows!["research:old"]!.method).toBeUndefined();
  expect(state.workflows!["research:new"]!.method).toEqual(SHARED_RESEARCH_METHOD);
  expect(state.workflows!["research:new"]!.steps).toEqual(legacyWorkflow.steps);
  const guidance = await loadCyzWorkflowGuide(resources, "cyz-edu-research/S1");
  expect(guidance).toContain("此旧任务未登记快照");
  expect(guidance).not.toContain(`共享教育研究方法 ${SHARED_RESEARCH_METHOD_VERSION}`);
});
