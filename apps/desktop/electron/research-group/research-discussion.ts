import type { ResearchProject } from "../../contracts/research-group";
import {
  discussionWaiting,
  type ResearchDiscussionInput,
  type ResearchDiscussionPost,
  type ResearchDiscussionMessage,
} from "../../contracts/research-discussion";

export function appendResearchDiscussion(
  p: ResearchProject,
  input: ResearchDiscussionInput | ResearchDiscussionPost,
  message: ResearchDiscussionMessage,
): boolean {
  if (!p.fusion || p.revision !== input.revision)
    throw new Error("研讨版本已改变，请重新查看当前课题；旧记录保留。");
  const topics = ((p.m3 ??= {}).discussions ??= []);
  const topic = topics.find((t) => t.topic === input.topic && t.revision === input.revision);
  const duplicate = topics
    .flatMap((t) => t.messages.map((m) => ({ t, m })))
    .find((x) => x.m.id === message.id);
  if (duplicate) {
    if (
      duplicate.t !== topic ||
      duplicate.m.actor !== message.actor ||
      duplicate.m.intent !== message.intent ||
      duplicate.m.text !== message.text ||
      duplicate.m.question !== message.question
    )
      throw new Error("同一研讨消息不能改写。");
    return false;
  }
  if ((topic?.messages.length ?? 0) !== input.expectedMessages)
    throw new Error("研讨已有新消息，请刷新后回答。");
  if (message.actor === "mentor") {
    if (topic?.messages.at(-1)?.actor === "mentor") throw new Error("请等待用户回答，不重复追问。");
    if (topics.some((t) => t.revision === p.revision && t !== topic && discussionWaiting(t)))
      throw new Error("已有待答问题，先等待或处理原议题。");
    if (
      message.question &&
      topics.some(
        (t) => t.revision === p.revision && t.messages.some((m) => m.question === message.question),
      )
    )
      throw new Error("此问题已提出，先核对已有回答。");
  }
  if (topic) topic.messages.push(message);
  else topics.push({ topic: input.topic, revision: input.revision, messages: [message] });
  return true;
}
