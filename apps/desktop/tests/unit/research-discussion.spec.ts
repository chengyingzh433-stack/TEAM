import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { decodeResearchAction } from "../../contracts/research-group";
import {
  decodeResearchDiscussionInput,
  decodeResearchDiscussionPost,
  validateResearchDiscussions,
} from "../../contracts/research-discussion";
import { appendResearchDiscussion } from "../../electron/research-group/research-discussion";
import { assertResearchMemberInputsHandled } from "../../electron/research-group/research-member-input";
import { ResearchRepository } from "../../electron/research-group/repository";
import { m3Project } from "../helpers/research-m3-unit-fixture";
import { m3Coordinator } from "../helpers/research-m3-coordinator-fixture";

const reply = () => ({
  id: randomUUID(),
  topic: "研究意图",
  revision: 1,
  expectedMessages: 0,
  intent: "idea" as const,
  text: "我还不知道，先讨论学生为什么会算但不会解释。",
});
const post = (expectedMessages = 0, question = "你最想改善哪个课堂现象？") => ({
  topic: "研究意图",
  revision: 1,
  expectedMessages,
  text: "先澄清目标，不改变已有研究稿。",
  question,
});

test("discussion actions reject model identities, invalid versions and implicit instructions", () => {
  const input = reply();
  expect(decodeResearchDiscussionInput(input)).toEqual(input);
  expect(
    decodeResearchAction({
      kind: "discussion",
      target: { workspaceId: "w", sessionId: "s" },
      input,
    }),
  ).toMatchObject({ kind: "discussion", input });
  for (const raw of [
    { ...input, actor: "user" },
    { ...input, revision: -1 },
    { ...input, intent: "confirmed" },
    { ...input, expectedMessages: 0.5 },
  ])
    expect(() => decodeResearchDiscussionInput(raw)).toThrow();
  expect(() => decodeResearchDiscussionPost({ ...post(), intent: "instruction" })).toThrow();
});
test("mentor asks once, free answers enable one next round; duplicates and stale replies cannot disturb history", async () => {
  const { p } = await m3Project("quantitative", "question");
  const before = structuredClone(p.fusion);
  const add = (data: ReturnType<typeof post>, id: string) =>
    appendResearchDiscussion(p, data, {
      id,
      at: new Date().toISOString(),
      actor: "mentor",
      intent: "discussion",
      text: data.text,
      question: data.question,
    });
  expect(add(post(), "first")).toBe(true);
  expect(add(post(), "first")).toBe(false);
  expect(() => add(post(1, "还有呢？"), "repeat")).toThrow("等待");
  expect(() =>
    appendResearchDiscussion(
      p,
      { ...post(), topic: "另一个问题" },
      {
        id: "other",
        at: new Date().toISOString(),
        actor: "mentor",
        intent: "discussion",
        text: "说明",
        question: "另一个问题？",
      },
    ),
  ).toThrow("已有待答");
  const user = { ...reply(), expectedMessages: 1 };
  appendResearchDiscussion(p, user, {
    id: user.id,
    at: new Date().toISOString(),
    actor: "user",
    intent: user.intent,
    text: user.text,
    question: "",
  });
  expect(() => add(post(2), "same-question")).toThrow("已提出");
  add(post(2, "你有学生报告可以提供吗？"), "next");
  expect(() =>
    appendResearchDiscussion(
      p,
      { ...user, id: "stale" },
      {
        id: "stale",
        at: new Date().toISOString(),
        actor: "user",
        intent: "idea",
        text: user.text,
        question: "",
      },
    ),
  ).toThrow("新消息");
  validateResearchDiscussions(p.m3!.discussions);
  expect(p.fusion).toEqual(before);
});
test("real coordinator stores free reply and delivery atomically, retries once, preserves four members and reloads", async () => {
  const { p } = await m3Project("quantitative", "question");
  const s = await m3Coordinator([p]);
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(4);
  await s.native(p.id, "mentor", "start");
  const input = reply();
  const original = s.c.snapshot().projects[0]!;
  await s.c.submitDiscussion(p.root, input);
  await s.c.submitDiscussion(p.root, input);
  const current = s.c.snapshot().projects[0]!;
  expect(current.m3!.discussions![0]!.messages).toHaveLength(1);
  expect(current.m3!.memberInputs!.filter((m) => m.id === input.id)).toHaveLength(1);
  expect(current.m3!.memberInputs!.find((m) => m.id === input.id)!.actor).toBe("mentor");
  expect(current.fusion!.decisions).toEqual(original.fusion!.decisions);
  expect(current.artifacts).toEqual(original.artifacts);
  expect(current.members.map((m) => m.ref)).toEqual(original.members.map((m) => m.ref));
  expect(() =>
    assertResearchMemberInputsHandled(current, "mentor", { verdict: "accept" }, undefined),
  ).not.toThrow();
  const command = {
    ...reply(),
    expectedMessages: 1,
    intent: "instruction" as const,
    text: "请保留原稿，先给我两个方案。",
  };
  await s.c.submitDiscussion(p.root, command);
  const commanded = s.c.snapshot().projects[0]!;
  expect(() =>
    assertResearchMemberInputsHandled(commanded, "mentor", { verdict: "accept" }, undefined),
  ).toThrow("尚未");
  const mentor = p.members.find((m) => m.role === "mentor")!.ref;
  await s.c.tool(mentor, "respond-discussion", {
    operation: "discussion-post",
    discussion: post(2, ""),
  });
  await s.c.tool(mentor, "respond-discussion", {
    operation: "discussion-post",
    discussion: post(2, ""),
  });
  const loaded = await s.repository.load();
  expect(loaded.projects[0]!.m3!.discussions![0]!.messages).toHaveLength(3);
  await expect(
    s.c.tool(p.members.find((m) => m.role === "lead")!.ref, "impersonate", {
      operation: "discussion-post",
      discussion: post(3),
    }),
  ).rejects.toThrow("导师");
  await s.c.pause(p.root);
});
test("storage rejects malformed discussion without replacing primary; old revision replies are rejected", async () => {
  const { p, directory } = await m3Project("quantitative", "question");
  const input = reply();
  appendResearchDiscussion(p, input, {
    id: input.id,
    at: new Date().toISOString(),
    actor: "user",
    intent: "idea",
    text: input.text,
    question: "",
  });
  const repo = new ResearchRepository(directory);
  const state = { version: 1 as const, config: { knowledgeDir: "" }, projects: [p] };
  await repo.save(state);
  const files = await import("node:fs/promises").then((fs) => fs.readdir(directory));
  const file = files.find((f) => f.endsWith(".json") && f.includes("research"))!;
  expect(file).toBeTruthy();
  const bytes = await readFile(join(directory, file));
  const invalid = structuredClone(state);
  invalid.projects[0]!.m3!.discussions![0]!.messages[0]!.actor = "mentor";
  await expect(repo.save(invalid)).rejects.toThrow();
  expect(await readFile(join(directory, file))).toEqual(bytes);
  p.revision++;
  expect(() =>
    appendResearchDiscussion(p, input, {
      id: "new",
      at: new Date().toISOString(),
      actor: "user",
      intent: "idea",
      text: input.text,
      question: "",
    }),
  ).toThrow("版本");
});

test("failed durable save retains original bytes, records no partial reply and dispatches nothing", async () => {
  const { p } = await m3Project("quantitative", "question");
  const s = await m3Coordinator([p]);
  await s.c.resume(p.root);
  await expect.poll(() => s.sent.length).toBe(4);
  await s.native(p.id, "mentor", "start");
  const fs = await import("node:fs/promises");
  const path = join(s.directory, "research-groups.json");
  const original = await readFile(path);
  await fs.rename(path, path + ".preserved");
  await fs.mkdir(path);
  await fs.writeFile(join(path, "obstacle"), "keep failed storage evidence");
  const before = s.sent.length;
  await expect(s.c.submitDiscussion(p.root, reply())).rejects.toThrow();
  expect(s.c.snapshot().projects[0]!.m3?.discussions).toBeUndefined();
  expect(s.sent).toHaveLength(before);
  expect(await readFile(path + ".preserved")).toEqual(original);
  expect(await readFile(join(path, "obstacle"), "utf8")).toBe("keep failed storage evidence");
});
