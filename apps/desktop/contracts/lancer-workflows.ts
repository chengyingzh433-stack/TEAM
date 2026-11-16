import type { RuntimeSnapshot } from "@lancer/session-driver/runtime-types";
import { isCyzGuideId, type CyzGuideId } from "./cyz-paper-workflow";
import {
  snapshotSharedResearchMethod,
  type SharedResearchMethodSnapshot,
} from "./shared-research-method";

export const MAX_WORKFLOW_STEPS = 9;

export interface LancerWorkflowStep {
  readonly title: string;
  readonly model?: { readonly provider: string; readonly modelId: string };
  readonly skills?: readonly string[];
  readonly goal?: string;
  readonly deliverables?: string;
  readonly guide?: CyzGuideId;
}
export interface LancerWorkflow {
  readonly steps: readonly LancerWorkflowStep[];
  readonly method?: SharedResearchMethodSnapshot;
  readonly activeStep?: number;
}

export function decodeLancerWorkflow(value: unknown): LancerWorkflow {
  const plan = value as LancerWorkflow;
  if (
    !plan ||
    !Array.isArray(plan.steps) ||
    plan.steps.length < 1 ||
    plan.steps.length > MAX_WORKFLOW_STEPS
  )
    throw new Error(`流程需要 1–${MAX_WORKFLOW_STEPS} 个阶段。`);
  const steps = plan.steps.map((step: LancerWorkflowStep) => {
    if (!step || typeof step.title !== "string" || !step.title.trim() || step.title.length > 40)
      throw new Error("请为每个阶段填写名称（最多 40 字）。");
    if (step.guide !== undefined && !isCyzGuideId(step.guide))
      throw new Error("内置阶段指导无效，请重新选择流程。");
    if (
      step.model &&
      [step.model.provider, step.model.modelId].some(
        (part) => typeof part !== "string" || !part.trim() || part.length > 512,
      )
    )
      throw new Error("请选择有效模型。");
    for (const field of ["goal", "deliverables"] as const) {
      if (
        step[field] !== undefined &&
        (typeof step[field] !== "string" || step[field].length > 4000)
      )
        throw new Error("阶段目标和交付要求最多各 4000 字。");
    }
    if (
      step.skills !== undefined &&
      (!Array.isArray(step.skills) ||
        step.skills.length > 12 ||
        step.skills.some((s) => typeof s !== "string" || !s.trim() || s.length > 256))
    )
      throw new Error("每个阶段最多选择 12 个有效技能。");
    return {
      title: step.title.trim(),
      ...(step.guide ? { guide: step.guide } : {}),
      ...(step.model
        ? { model: { provider: step.model.provider, modelId: step.model.modelId } }
        : {}),
      ...(step.skills ? { skills: [...new Set(step.skills.map((s) => s.trim()))] } : {}),
      ...(step.goal?.trim() ? { goal: step.goal.trim() } : {}),
      ...(step.deliverables?.trim() ? { deliverables: step.deliverables.trim() } : {}),
    };
  });
  if (
    plan.activeStep !== undefined &&
    (!Number.isInteger(plan.activeStep) || plan.activeStep < 0 || plan.activeStep >= steps.length)
  )
    throw new Error("Invalid workflow stage");
  return {
    steps,
    ...(plan.method === undefined ? {} : { method: snapshotSharedResearchMethod(plan.method) }),
    ...(plan.activeStep === undefined ? {} : { activeStep: plan.activeStep }),
  };
}

export function workflowTaskPrompt(
  step: LancerWorkflowStep,
  runtime: RuntimeSnapshot,
  builtinGuidance?: string,
): string {
  if (!step.goal?.trim()) throw new Error("请先填写本阶段要解决的问题。");
  if (step.guide && !builtinGuidance?.trim())
    throw new Error("内置研究指导尚未加载，已保留草稿。请检查应用资源。");
  const skills = (step.skills ?? []).map((name) => {
    const skill = runtime.skills.find((s) => s.name === name && s.enabled);
    if (!skill) throw new Error(`技能「${name}」不可用，请在阶段设置中重新选择。`);
    return skill;
  });
  const command = runtime.settings.enableSkillCommands ? skills[0]?.slashCommand : undefined;
  const task = [
    `执行阶段：${step.title}`,
    `要解决的问题：\n${step.goal.trim()}`,
    skills.length
      ? `使用以下技能；先读取各技能说明并遵循其中适用的要求：\n${skills.map((s) => `- ${s.name}：${s.filePath}`).join("\n")}`
      : undefined,
    step.deliverables?.trim() ? `交付要求：\n${step.deliverables.trim()}` : undefined,
    builtinGuidance,
    "沿用当前会话上下文。完成后给出交付物、验证结果与仍未解决的问题。",
  ]
    .filter(Boolean)
    .join("\n\n");
  // Pi recognizes the skill name up to the first literal space.
  return command ? `${command} ${task}` : task;
}

export function moduleStageTitles(zone: string): readonly string[] {
  return (
    (
      {
        paper: ["检索论文", "阅读分析", "方法核验", "综述输出"],
        github: ["发现仓库", "阅读代码", "验证方案", "整理成果"],
        lancer: ["梳理需求", "实现功能", "审查验证", "交付版本"],
      } as Record<string, string[]>
    )[zone] ?? ["理解任务", "执行", "检查", "交付"]
  );
}
