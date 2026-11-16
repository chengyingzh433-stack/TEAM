import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CYZ_PAPER_MODULE_ID, CYZ_PAPER_WORKFLOW } from "../../contracts/cyz-paper-workflow";
import { DEFAULT_LANCER_ASSISTANTS, decodeLancerAction } from "../../contracts/lancer-assistants";
import { DEFAULT_LANCER_MODULES } from "../../contracts/lancer-modules";
import { decodeLancerWorkflow, workflowTaskPrompt } from "../../contracts/lancer-workflows";
import { LancerAssistantStore } from "../../electron/application/lancer-assistant-store";
import { loadCyzWorkflowGuide } from "../../electron/application/cyz-workflow-guide";
import type { RuntimeSnapshot } from "@lancer/session-driver/runtime-types";

const resources = join(__dirname, "../../resources/workflows");
const runtime: RuntimeSnapshot = {
  workspace: { workspaceId: "research", path: "/tmp/research" },
  providers: [],
  models: [],
  extensions: [],
  skills: [],
  settings: { enableSkillCommands: true, enabledModelPatterns: [] },
};

test("nine research stages inherit, save and restart independently of later template edits", async () => {
  const profile = await mkdtemp(join(tmpdir(), "cyz-workflow-"));
  const store = new LancerAssistantStore(profile);
  await store.load();
  const target = { workspaceId: "research", sessionId: "first" };
  await store.inheritWorkflow(target, CYZ_PAPER_MODULE_ID);
  const workflow = decodeLancerWorkflow({ ...CYZ_PAPER_WORKFLOW, activeStep: 8 });
  expect(workflow.steps).toHaveLength(9);
  expect(workflow.steps[8]!.guide).toBe("cyz-edu-research/S8");
  for (const kind of ["handoff-workflow", "prepare-workflow"]) {
    expect(decodeLancerAction({ kind, target, step: 8 })).toMatchObject({ step: 8 });
    expect(() => decodeLancerAction({ kind, target, step: 9 })).toThrow("Invalid stage");
  }
  await store.change({ kind: "save-workflow", target, workflow });
  const module = DEFAULT_LANCER_MODULES.find((item) => item.id === CYZ_PAPER_MODULE_ID)!;
  await store.change({
    kind: "save-module",
    module: {
      ...module,
      workflow: {
        steps: [{ ...workflow.steps[1]!, title: "我的问题打磨", goal: "优先分析课堂观察" }],
      },
    },
  });
  await store.inheritWorkflow({ ...target, sessionId: "second" }, CYZ_PAPER_MODULE_ID);
  const saved = await new LancerAssistantStore(profile).load();
  expect(saved.workflows?.["research:first"]).toEqual(workflow);
  expect(saved.workflows?.["research:second"]?.steps[0]).toMatchObject({
    title: "我的问题打磨",
    goal: "优先分析课堂观察",
    guide: "cyz-edu-research/S1",
  });
  expect(() => decodeLancerWorkflow({ steps: [...workflow.steps, workflow.steps[0]] })).toThrow(
    "1–9",
  );
  for (const guide of ["cyz-edu-research/S9", "../../private", "another-workflow/S0", 5])
    expect(() => decodeLancerWorkflow({ steps: [{ title: "研究", guide }] })).toThrow("指导无效");
});

test("upgrade adds CYZ without changing the old paper module, saved workflows or original bytes", async () => {
  const profile = await mkdtemp(join(tmpdir(), "cyz-upgrade-"));
  const modules = DEFAULT_LANCER_MODULES.filter((item) => item.id !== CYZ_PAPER_MODULE_ID).map(
    (item) =>
      item.id === "paper"
        ? {
            ...item,
            label: "我的论文查询",
            workflow: { steps: [{ title: "保留的个人流程", goal: "保留我的想法" }] },
          }
        : item,
  );
  const savedWorkflow = {
    steps: [{ title: "旧会话流程", model: { provider: "custom", modelId: "model" } }],
  };
  const original =
    JSON.stringify(
      { ...DEFAULT_LANCER_ASSISTANTS, modules, workflows: { "w:s": savedWorkflow } },
      null,
      2,
    ) + "\n";
  const path = join(profile, "assistants.json");
  await writeFile(path, original);
  const store = new LancerAssistantStore(profile);
  const loaded = await store.load();
  expect(loaded.modules?.filter((item) => item.id !== CYZ_PAPER_MODULE_ID)).toEqual(modules);
  expect(
    loaded.modules?.find((item) => item.id === CYZ_PAPER_MODULE_ID)?.workflow?.steps,
  ).toHaveLength(9);
  expect(loaded.workflows?.["w:s"]).toEqual(savedWorkflow);
  expect(await readFile(path, "utf8")).toBe(original);
  await store.change({ kind: "delete-module", id: CYZ_PAPER_MODULE_ID });
  expect(await readFile(`${path}.bak`, "utf8")).toBe(original);
  const restarted = await new LancerAssistantStore(profile).load();
  expect(restarted.modules?.filter((item) => item.id === CYZ_PAPER_MODULE_ID)).toHaveLength(1);
  expect(restarted.modules?.find((item) => item.id === CYZ_PAPER_MODULE_ID)?.deleted).toBe(true);
  expect(restarted.workflows?.["w:s"]).toEqual(savedWorkflow);
});

for (const step of CYZ_PAPER_WORKFLOW.steps) {
  test(`${step.title} loads actual research guidance without registered skills`, async () => {
    const guidance = await loadCyzWorkflowGuide(resources, step.guide!);
    const prompt = workflowTaskPrompt(step, runtime, guidance);
    expect(prompt).toContain(step.goal!);
    expect(prompt).toContain(step.deliverables!);
    const adapted = await readFile(
      join(resources, "cyz-stages", `${step.guide!.split("/")[1]}.md`),
      "utf8",
    );
    expect(prompt).toContain(adapted);
    expect(prompt).toContain("验收针对本轮实际完成的范围");
    expect(prompt).toContain("方法参考（按需读取）");
    expect(prompt).toContain(join(resources, "cyz-edu-research/references/integrity-gates.md"));
    // Keep original materials available without promoting their complete Skill
    // workflow into every scoped reading, writing or review request.
    expect(prompt).not.toContain("## Gate S8: Finalization");
    expect(prompt).not.toContain("## Canonical Records");
    expect(prompt).toContain(join(resources, "cyz-edu-research"));
    expect(prompt).not.toMatch(/^\/skill:/);
    expect(() => workflowTaskPrompt(step, runtime)).toThrow("尚未加载");
  });
}

test("missing guidance fails explicitly and original resource snapshots retain their hashes", async () => {
  const empty = await mkdtemp(join(tmpdir(), "cyz-missing-"));
  await expect(loadCyzWorkflowGuide(empty, "cyz-edu-research/S1")).rejects.toThrow("缺失或不可读");
  await expect(loadCyzWorkflowGuide(undefined, "entry")).rejects.toThrow("未配置");
  const provenance = JSON.parse(await readFile(join(resources, "provenance.json"), "utf8")) as {
    resources: { name: string; files: Record<string, string> }[];
  };
  for (const resource of provenance.resources)
    for (const [file, sha256] of Object.entries(resource.files))
      expect(
        createHash("sha256")
          .update(await readFile(join(resources, resource.name, file)))
          .digest("hex"),
        `${resource.name}/${file}`,
      ).toBe(sha256);
});
