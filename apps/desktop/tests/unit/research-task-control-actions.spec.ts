import { expect, test } from "@playwright/test";
import { decodeResearchAction } from "../../contracts/research-group";

const target = { workspaceId: "workspace", sessionId: "session" };
const actions = [
  { kind: "answer-decision", target, input: { requestId: "q", optionId: "yes", text: "确认" } },
  { kind: "retry-task", target, input: { taskId: "t", reason: "连接已恢复" } },
  {
    kind: "resolve-attempt",
    target,
    input: { attemptId: "a", outcome: "succeeded", reason: "核对服务记录", evidenceRef: "run/123" },
  },
];
for (const action of actions) {
  test(`${action.kind} accepts only scoped user payload`, () => {
    expect(decodeResearchAction(action)).toEqual(action);
    expect(() => decodeResearchAction({ ...action, actor: "user" })).toThrow("未知字段");
    expect(() =>
      decodeResearchAction({ ...action, input: { ...action.input, actor: "user" } }),
    ).toThrow("未知字段");
    for (const invalid of [
      null,
      [],
      {},
      { ...target, sessionId: " " },
      { ...target, workspaceId: "" },
      { ...target, extra: "target" },
    ]) {
      expect(() => decodeResearchAction({ ...action, target: invalid })).toThrow("目标");
    }
  });
}
test("unknown reconciliation usage remains absent at the action boundary", () => {
  const action = decodeResearchAction(actions[2]);
  expect(action).toEqual(actions[2]);
  expect(action).not.toHaveProperty("input.usedTokens");
  expect(() =>
    decodeResearchAction({ ...actions[2], input: { ...actions[2].input, usedTokens: null } }),
  ).toThrow();
});
