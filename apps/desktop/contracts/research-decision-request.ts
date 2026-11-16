import type { ResearchDecisionRequest } from "./research-task-graph";

/** Model-supplied proposal only. Identity, version, author and actual answers belong to main. */
export type ResearchDecisionRequestInput = Pick<
  ResearchDecisionRequest,
  "question" | "context" | "impact" | "options" | "recommendedOptionId" | "taskIds"
> & {
  conditionId: string;
  /** A changed real condition must explicitly name the request it replaces. */
  supersedesRequestId?: string;
  changedCondition?: string;
};

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  )
    throw new Error("决定请求必须是有效对象。");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)))
    throw new Error("决定请求含有未知或越权字段；模型不能填写答复、身份或自动授权。");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error(`${label}必须是非空文本，且不超过 ${max} 字符。`);
  return value.trim();
}
function identifier(value: unknown, label: string): string {
  const result = text(value, label, 512);
  if (/[\r\n\t]/.test(result)) throw new Error(`${label}不能包含换行或制表符。`);
  return result;
}

export function decodeResearchDecisionRequestInput(value: unknown): ResearchDecisionRequestInput {
  const input = record(value, [
    "conditionId",
    "question",
    "context",
    "impact",
    "options",
    "recommendedOptionId",
    "taskIds",
    "supersedesRequestId",
    "changedCondition",
  ]);
  if ((input.supersedesRequestId === undefined) !== (input.changedCondition === undefined))
    throw new Error("更新已有决定必须同时列出原请求及实际条件变化，不能只改写问题。");
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4)
    throw new Error("决定请求需要 2–4 个明确选项。");
  const options: ResearchDecisionRequestInput["options"] = input.options.map((raw: unknown) => {
    const option = record(raw, ["id", "label", "consequence", "outcome"]);
    if (
      option.outcome !== "confirmed" &&
      option.outcome !== "declined" &&
      option.outcome !== "deferred"
    )
      throw new Error("选项结果只能是 confirmed、declined 或 deferred；尚未代表用户已选择。");
    return {
      id: identifier(option.id, "选项 ID"),
      label: text(option.label, "选项名称", 300),
      consequence: text(option.consequence, "选项影响", 3000),
      outcome: option.outcome,
    };
  });
  const optionIds = new Set(options.map((option) => option.id));
  if (optionIds.size !== options.length) throw new Error("决定请求的选项 ID 不能重复。");
  const recommendedOptionId = identifier(input.recommendedOptionId, "推荐选项 ID");
  if (!optionIds.has(recommendedOptionId)) throw new Error("推荐选项必须属于本次选项列表。");
  if (!Array.isArray(input.taskIds) || input.taskIds.length < 1 || input.taskIds.length > 20)
    throw new Error("决定请求必须明确限定 1–20 个依赖任务，不能省略作用范围。");
  const taskIds = input.taskIds.map((taskId: unknown) => identifier(taskId, "依赖任务 ID"));
  if (new Set(taskIds).size !== taskIds.length) throw new Error("决定请求的依赖任务 ID 不能重复。");
  return {
    conditionId: identifier(input.conditionId, "待确认条件 ID"),
    question: text(input.question, "待决定问题", 2000),
    context: text(input.context, "依据与背景", 6000),
    impact: text(input.impact, "决定影响", 6000),
    options,
    recommendedOptionId,
    taskIds,
    ...(input.supersedesRequestId === undefined
      ? {}
      : {
          supersedesRequestId: identifier(input.supersedesRequestId, "原决定请求 ID"),
          changedCondition: text(input.changedCondition, "实际条件变化", 6000),
        }),
  };
}
