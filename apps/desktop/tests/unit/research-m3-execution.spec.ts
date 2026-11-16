import { expect, test } from "@playwright/test";
import { researchStages, type ResearchGroupsState } from "../../contracts/research-group";
import {
  researchExecutionAdmission,
  researchExecutionCount,
  plannedResearchRecovery,
  selectResearchTaskModel,
} from "../../electron/research-group/research-execution-policy";
import { failResearchTask } from "../../electron/research-group/task-graph";
import { m3Activate, m3Project } from "../helpers/research-m3-unit-fixture";
import { decodeResearchState } from "../../electron/research-group/repository";
import { specialistModelSelection } from "../../electron/research-group/research-specialists";

test("model precedence is task, stage, project, application, then the inherited session", async () => {
  const { p } = await m3Project("quantitative", "question");
  const state: ResearchGroupsState = {
    version: 1,
    config: { knowledgeDir: "" },
    projects: [p],
    m3: { defaultModels: { lead: { provider: "fixture", modelId: "app" } } },
  };
  const taskId = "v1:question:lead";
  expect(selectResearchTaskModel({}, p, "lead", taskId, "question")).toEqual({
    source: "session-current",
  });
  expect(selectResearchTaskModel(state, p, "lead", taskId, "question")).toMatchObject({
    model: { modelId: "app" },
    source: "application-default",
  });
  p.m3 = { defaultModels: { lead: { provider: "fixture", modelId: "project" } } };
  expect(selectResearchTaskModel(state, p, "lead", taskId, "question").source).toBe(
    "project-default",
  );
  p.stages = researchStages(p);
  p.stages.find((s) => s.id === "question")!.models.lead = {
    provider: "fixture",
    modelId: "stage",
  };
  expect(selectResearchTaskModel(state, p, "lead", taskId, "question")).toMatchObject({
    model: { modelId: "stage" },
    source: "stage-role",
  });
  p.m3.taskModels = { [taskId]: { provider: "fixture", modelId: "task" } };
  expect(selectResearchTaskModel(state, p, "lead", taskId, "question")).toMatchObject({
    model: { modelId: "task" },
    source: "task-override",
  });
});
test("persisted model and recovery dictionaries reject arrays, null and primitive shapes", async () => {
  const { p } = await m3Project("review", "question");
  for (const name of ["taskModels", "recoveryPolicies"] as const)
    for (const value of [[], null, "value", 7]) {
      const malformed = {
        version: 1,
        config: { knowledgeDir: "" },
        projects: [{ ...p, m3: { [name]: value } }],
      };
      expect(() => decodeResearchState(malformed)).toThrow(name);
    }
});
test("specialist inherits the same stage, project and application layers and records the true source", async () => {
  const { p } = await m3Project("review", "question");
  const s = {
    taskId: "specialist-new-task",
    stage: "question" as const,
    model: { provider: "fixture", modelId: "old-session" },
  };
  const state = {
    m3: { defaultModels: { reviewer: { provider: "fixture", modelId: "application" } } },
  };
  expect(specialistModelSelection(p, s, state)).toMatchObject({
    source: "application-default",
    model: { modelId: "application" },
  });
  p.m3 = { defaultModels: { reviewer: { provider: "fixture", modelId: "project" } } };
  expect(specialistModelSelection(p, s, state).source).toBe("project-default");
  p.stages!.find((row) => row.id === "question")!.models.reviewer = {
    provider: "fixture",
    modelId: "stage",
  };
  expect(specialistModelSelection(p, s, state)).toMatchObject({
    source: "stage-role",
    model: { modelId: "stage" },
  });
  p.m3.taskModels = { [s.taskId]: { provider: "fixture", modelId: "task" } };
  expect(specialistModelSelection(p, s, state)).toMatchObject({
    source: "task-override",
    model: { modelId: "task" },
  });
});
test("application and project slots count prepared and unknown attempts, without double-counting a bound member", async () => {
  const { p } = await m3Project("quantitative", "question");
  const other = (await m3Project("review", "question")).p;
  p.m3 = { projectLimit: 1 };
  const state: ResearchGroupsState = {
    version: 1,
    config: { knowledgeDir: "" },
    projects: [p, other],
    m3: { applicationLimit: 1 },
  };
  const first = m3Activate(p, "lead");
  expect(researchExecutionAdmission(state, p, "v1:question:reviewer", "short")).toContain(
    "课题执行名额",
  );
  expect(researchExecutionAdmission(state, other, "v1:question:lead", "short")).toContain(
    "应用执行名额",
  );
  p.members.find((m) => m.role === "lead")!.status = "running";
  expect(researchExecutionCount(p)).toBe(1);
  first.state = "unknown";
  expect(researchExecutionAdmission(state, other, "v1:question:lead", "short")).toContain(
    "应用执行名额",
  );
  state.m3!.applicationLimit = 2;
  expect(researchExecutionAdmission(state, other, "v1:question:lead", "short")).toBeUndefined();
  state.m3!.applicationLimit = 1;
  expect(first.state).toBe("unknown");
});
test("the final shared budget reservation cannot be spent twice and unknown consumption remains reserved", async () => {
  const { p } = await m3Project("quantitative", "question");
  p.m3 = { tokenBudget: 5000 };
  const state: ResearchGroupsState = { version: 1, config: { knowledgeDir: "" }, projects: [p] };
  expect(researchExecutionAdmission(state, p, "v1:question:lead", "short")).toBeUndefined();
  const attempt = m3Activate(p, "lead");
  expect(researchExecutionAdmission(state, p, "v1:question:reviewer", "short")).toContain(
    "额度不足",
  );
  p.fusion = failResearchTask(p.fusion!, attempt.id, {
    at: new Date().toISOString(),
    outcome: "failed",
    reason: "provider ended without usage",
  });
  expect(researchExecutionCount(p)).toBe(0);
  expect(researchExecutionAdmission(state, p, "v1:question:reviewer", "short")).toContain("未结算");
  p.fusion.attempts[0]!.usedTokens = 100;
  expect(researchExecutionAdmission(state, p, "v1:question:reviewer", "short")).toBeUndefined();
});
test("only explicit finite candidates recover transient errors; unknown usage and authentication never do", async () => {
  const { p } = await m3Project("quantitative", "question");
  const attempt = m3Activate(p, "lead");
  p.m3 = {
    recoveryPolicies: {
      [attempt.taskId]: {
        candidates: [{ provider: "fixture", modelId: "authorized-fallback" }],
        maxRetries: 1,
      },
    },
  };
  p.fusion = failResearchTask(p.fusion!, attempt.id, {
    at: new Date().toISOString(),
    outcome: "failed",
    reason: "503 temporary service failure",
  });
  expect(
    plannedResearchRecovery(
      p,
      attempt.taskId,
      "503 temporary service failure",
      new Date().toISOString(),
    ),
  ).toBeUndefined();
  p.fusion.attempts[0]!.usedTokens = 100;
  expect(
    plannedResearchRecovery(
      p,
      attempt.taskId,
      "401 authentication failed",
      new Date().toISOString(),
    ),
  ).toBeUndefined();
  const recovery = plannedResearchRecovery(
    p,
    attempt.taskId,
    "503 temporary service failure",
    new Date().toISOString(),
  )!;
  expect(recovery.model.modelId).toBe("authorized-fallback");
  p.m3.recoveries = [recovery];
  expect(
    plannedResearchRecovery(
      p,
      attempt.taskId,
      "503 temporary service failure",
      new Date().toISOString(),
    ),
  ).toBeUndefined();
  expect(p.fusion.attempts[0]!.model?.modelId).toBe("logic-only");
});
