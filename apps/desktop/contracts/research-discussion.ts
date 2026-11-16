export interface ResearchDiscussionInput {
  id: string;
  topic: string;
  revision: number;
  expectedMessages: number;
  intent: "idea" | "instruction";
  text: string;
}
export interface ResearchDiscussionPost {
  topic: string;
  revision: number;
  expectedMessages: number;
  text: string;
  question: string;
}
export interface ResearchDiscussionMessage {
  id: string;
  at: string;
  actor: "user" | "mentor";
  intent: "idea" | "instruction" | "discussion";
  text: string;
  question: string;
}
export interface ResearchDiscussion {
  topic: string;
  revision: number;
  messages: ResearchDiscussionMessage[];
}
function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !keys.includes(k))
  )
    throw new Error("研讨内容含无效或越权字段。");
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max: number, empty = false): string {
  if (typeof raw !== "string" || raw.length > max || raw.includes("\0") || (!empty && !raw.trim()))
    throw new Error("研讨文字为空或过长。");
  return raw.trim();
}
function base(r: Record<string, unknown>) {
  if (
    !Number.isSafeInteger(r.revision) ||
    Number(r.revision) < 0 ||
    !Number.isSafeInteger(r.expectedMessages) ||
    Number(r.expectedMessages) < 0
  )
    throw new Error("研讨版本无效。");
  return {
    topic: text(r.topic, 200),
    revision: Number(r.revision),
    expectedMessages: Number(r.expectedMessages),
    text: text(r.text, 10000),
  };
}
export function decodeResearchDiscussionInput(raw: unknown): ResearchDiscussionInput {
  const r = record(raw, ["id", "topic", "revision", "expectedMessages", "intent", "text"]);
  if (r.intent !== "idea" && r.intent !== "instruction")
    throw new Error("请选择探讨想法或正式指令。");
  return { ...base(r), id: text(r.id, 200), intent: r.intent };
}
export function decodeResearchDiscussionPost(raw: unknown): ResearchDiscussionPost {
  const r = record(raw, ["topic", "revision", "expectedMessages", "text", "question"]);
  return { ...base(r), question: text(r.question, 2000, true) };
}
export function discussionWaiting(topic: ResearchDiscussion): boolean {
  const last = topic.messages.at(-1);
  return last?.actor === "mentor" && !!last.question;
}
export function validateResearchDiscussions(raw: unknown): asserts raw is ResearchDiscussion[] {
  if (!Array.isArray(raw) || raw.length > 2000) throw new Error("研讨记录无效，保留原文件。");
  const keys = new Set<string>(),
    ids = new Set<string>();
  for (const value of raw) {
    const r = record(value, ["topic", "revision", "messages"]);
    const topic = text(r.topic, 200);
    if (
      !Number.isSafeInteger(r.revision) ||
      Number(r.revision) < 0 ||
      keys.has(`${r.revision}:${topic}`) ||
      !Array.isArray(r.messages) ||
      !r.messages.length ||
      r.messages.length > 1000
    )
      throw new Error("研讨身份或轮次无效。");
    keys.add(`${r.revision}:${topic}`);
    let previous: string | undefined;
    for (const value of r.messages) {
      const m = record(value, ["id", "at", "actor", "intent", "text", "question"]);
      const id = text(m.id, 200);
      if (ids.has(id) || !Number.isFinite(Date.parse(text(m.at, 100))))
        throw new Error("研讨消息身份或时间无效。");
      ids.add(id);
      text(m.text, 10000);
      text(m.question, 2000, true);
      if (m.actor === "user") {
        if (!["idea", "instruction"].includes(String(m.intent)) || m.question !== "")
          throw new Error("用户研讨身份无效。");
      } else if (m.actor !== "mentor" || m.intent !== "discussion" || previous === "mentor")
        throw new Error("导师研讨轮次无效。");
      previous = String(m.actor);
    }
  }
  const waiting = new Set<number>();
  for (const topic of raw as ResearchDiscussion[])
    if (discussionWaiting(topic)) {
      if (waiting.has(topic.revision)) throw new Error("同一版本只能有一个待答研讨问题。");
      waiting.add(topic.revision);
    }
}
