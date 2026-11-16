import { expect, test } from "@playwright/test";
import { decodeResearchDecisionRequestInput } from "../../contracts/research-decision-request";

const request = () => ({
  conditionId: "permission-classroom-text",
  question: "这些已提供的课堂文本是否允许用于本轮研究？",
  context: "已收到文本，但当前来源说明没有包含研究使用许可。",
  impact: "仅文本分析任务等待确认；文献整理可继续。",
  options: [
    {
      id: "allowed",
      label: "已获得本次研究许可",
      consequence: "继续核对文本来源与分析条件。",
      outcome: "confirmed",
    },
    {
      id: "not-allowed",
      label: "不能用于本次研究",
      consequence: "不执行依赖这些文本的分析。",
      outcome: "declined",
    },
    {
      id: "later",
      label: "稍后核实",
      consequence: "相关分析继续等待，其他任务可继续。",
      outcome: "deferred",
    },
  ],
  recommendedOptionId: "later",
  taskIds: ["analysis-text", "review-text-findings"],
});

test("a scoped decision proposal is copied without asserting any user answer or author identity", () => {
  const input = request();
  const result = decodeResearchDecisionRequestInput(input);
  expect(result).toEqual(input);
  expect(result).not.toBe(input);
  expect(result.options[0]).not.toBe(input.options[0]);
  result.taskIds.push("later-task");
  result.options[0]!.label = "新标签";
  expect(input.taskIds).toHaveLength(2);
  expect(input.options[0]!.label).toBe("已获得本次研究许可");
  expect(result).not.toHaveProperty("actor");
  expect(result).not.toHaveProperty("answer");
  expect(result).not.toHaveProperty("requestedBy");
});

test("a changed condition requires both a specific prior request and the actual change", () => {
  expect(() =>
    decodeResearchDecisionRequestInput({ ...request(), supersedesRequestId: "prior" }),
  ).toThrow("同时");
  expect(() =>
    decodeResearchDecisionRequestInput({ ...request(), changedCondition: "新增访谈对象" }),
  ).toThrow("同时");
  expect(() =>
    decodeResearchDecisionRequestInput({
      ...request(),
      supersedesRequestId: "prior",
      changedCondition: " ",
    }),
  ).toThrow("实际条件变化");
  expect(
    decodeResearchDecisionRequestInput({
      ...request(),
      supersedesRequestId: "prior",
      changedCondition: "原授权只涉及公共材料，新增访谈对象需要另行确认。",
    }),
  ).toMatchObject({
    supersedesRequestId: "prior",
    changedCondition: "原授权只涉及公共材料，新增访谈对象需要另行确认。",
  });
});

test("missing or unbounded task scope is rejected instead of blocking the whole project", () => {
  const { taskIds: _taskIds, ...withoutScope } = request();
  for (const value of [
    withoutScope,
    { ...request(), taskIds: [] },
    { ...request(), taskIds: "all" },
    { ...request(), taskIds: Array.from({ length: 21 }, (_, i) => `task-${i}`) },
  ])
    expect(() => decodeResearchDecisionRequestInput(value)).toThrow("作用范围");
  expect(() =>
    decodeResearchDecisionRequestInput({ ...request(), taskIds: ["analysis", " analysis "] }),
  ).toThrow("不能重复");
  expect(() => decodeResearchDecisionRequestInput({ ...request(), taskIds: [""] })).toThrow(
    "依赖任务",
  );
  expect(
    decodeResearchDecisionRequestInput({
      ...request(),
      taskIds: Array.from({ length: 20 }, (_, i) => `task-${i}`),
    }).taskIds,
  ).toHaveLength(20);
});

test("model-supplied actor, answers, automatic authorization and main-owned metadata are rejected at every object boundary", () => {
  for (const key of [
    "actor",
    "answer",
    "autoApprove",
    "authorization",
    "authorizedBy",
    "id",
    "at",
    "version",
    "requestedBy",
    "affectedTaskIds",
  ])
    expect(() => decodeResearchDecisionRequestInput({ ...request(), [key]: "forged" })).toThrow(
      "越权字段",
    );
  for (const key of ["actor", "answer", "selected", "autoConfirm"])
    expect(() =>
      decodeResearchDecisionRequestInput({
        ...request(),
        options: request().options.map((option, index) =>
          index === 0 ? { ...option, [key]: "forged" } : option,
        ),
      }),
    ).toThrow("越权字段");
  const inherited: unknown = Object.assign(Object.create({ actor: "user" }) as object, request());
  expect(() => decodeResearchDecisionRequestInput(inherited)).toThrow("有效对象");
  expect(() =>
    decodeResearchDecisionRequestInput({ ...request(), [Symbol("answer")]: "yes" }),
  ).toThrow("越权字段");
});

test("option cardinality, outcomes, canonical IDs and the recommendation are validated together", () => {
  for (const options of [
    [],
    request().options.slice(0, 1),
    [...request().options, request().options[0], request().options[1]],
  ])
    expect(() => decodeResearchDecisionRequestInput({ ...request(), options })).toThrow("2–4");
  expect(() =>
    decodeResearchDecisionRequestInput({
      ...request(),
      options: [request().options[0], { ...request().options[1], id: " allowed " }],
    }),
  ).toThrow("不能重复");
  expect(() =>
    decodeResearchDecisionRequestInput({ ...request(), recommendedOptionId: "not-listed" }),
  ).toThrow("推荐选项");
  expect(() =>
    decodeResearchDecisionRequestInput({
      ...request(),
      options: [request().options[0], { ...request().options[1], outcome: "auto-authorized" }],
    }),
  ).toThrow("选项结果");
  expect(
    decodeResearchDecisionRequestInput({ ...request(), recommendedOptionId: " later " })
      .recommendedOptionId,
  ).toBe("later");
});

test("all required text is nonempty and bounded without coercing arbitrary input values", () => {
  for (const [field, max] of [
    ["conditionId", 512],
    ["question", 2000],
    ["context", 6000],
    ["impact", 6000],
    ["recommendedOptionId", 512],
  ] as const) {
    for (const value of [undefined, null, false, 7, "  ", "x".repeat(max + 1), "bad\0text"])
      expect(() => decodeResearchDecisionRequestInput({ ...request(), [field]: value })).toThrow();
  }
  for (const [field, max] of [
    ["id", 512],
    ["label", 300],
    ["consequence", 3000],
  ] as const) {
    for (const value of [" ", "x".repeat(max + 1)])
      expect(() =>
        decodeResearchDecisionRequestInput({
          ...request(),
          options: [request().options[0], { ...request().options[1], [field]: value }],
        }),
      ).toThrow();
  }
  expect(() =>
    decodeResearchDecisionRequestInput({ ...request(), conditionId: "permission\nother" }),
  ).toThrow("换行");
  for (const value of [null, [], "request", 1, new Date()])
    expect(() => decodeResearchDecisionRequestInput(value)).toThrow("有效对象");
});
