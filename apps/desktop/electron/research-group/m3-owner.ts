import type { ResearchProject, ResearchRole } from "../../contracts/research-group";

/** The same durable task/attempt/native identity owns every M3 write. */
export function researchM3Owner(p: ResearchProject, actor: string) {
  const attempt = p.fusion?.attempts
    .filter(
      (a) =>
        ["prepared", "running", "unknown"].includes(a.state) &&
        p.fusion!.tasks.some((t) => t.id === a.taskId && t.role === actor),
    )
    .at(-1);
  const task = p.fusion?.tasks.find((t) => t.id === attempt?.taskId);
  const member = p.members.find((m) => m.role === actor);
  const specialist = p.m3?.specialists?.find((s) => `specialist:${s.id}` === actor);
  const ref = member?.ref ?? specialist?.ref;
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    !attempt ||
    !task ||
    !ref ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !attempt.model ||
    attempt.taskVersion !== task.inputVersion ||
    !task.id.startsWith(`v${p.revision}:`) ||
    [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].some(
      (r) =>
        !p.fusion!.adoptedInputs.some((a) => a.inputId === r.inputId && a.version === r.version),
    )
  )
    throw new Error("操作需要当前输入版本、真实运行身份及实际模型的执行尝试。");
  return { task, attempt, ref, actor, role: member?.role as ResearchRole | undefined };
}
