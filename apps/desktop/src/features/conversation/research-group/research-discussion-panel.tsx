import { useState } from "react";
import type { ResearchProject } from "../../../../contracts/research-group";
import {
  discussionWaiting,
  type ResearchDiscussionInput,
} from "../../../../contracts/research-discussion";
import { MessageMarkdown } from "../message-markdown";

export function ResearchDiscussionPanel({
  project,
  busy,
  onSend,
}: {
  project: ResearchProject;
  busy: boolean;
  onSend: (input: ResearchDiscussionInput) => Promise<void>;
}) {
  const [topic, setTopic] = useState("");
  const [text, setText] = useState("");
  const [intent, setIntent] = useState<"idea" | "instruction">("idea");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<ResearchDiscussionInput | null>(null);
  const topics = project.m3?.discussions ?? [];
  const current = topics.filter((t) => t.revision === project.revision);
  const waiting = current.find(discussionWaiting);
  const selected = current.find((t) => t.topic === topic);
  if (!project.fusion) return null;
  return (
    <details className="research-group-records">
      <summary>与团队研讨{waiting ? " · 导师有一个问题待你回答" : ""}</summary>
      <p>
        你是课题发起人和最终决策者。导师组织讨论，A、B、资料员职责不变。探讨不自动成为修改指令或许可；正式指令仍需原有研究核验。可以自由回答、反问，或请团队先调查。
      </p>
      {topics.map((t) => (
        <details
          key={`${t.revision}:${t.topic}`}
          className="research-material-item"
          open={t === waiting}
        >
          <summary>
            {t.topic} · 输入版本 {t.revision} ·{" "}
            {discussionWaiting(t)
              ? "待回答"
              : t.messages.at(-1)?.actor === "user"
                ? "已交导师，等待回应"
                : "本轮已收束"}
          </summary>
          {t.messages.map((m) => (
            <div key={m.id}>
              <strong>
                {m.actor === "mentor"
                  ? "导师 · 研讨意见"
                  : m.intent === "instruction"
                    ? "你 · 正式指令"
                    : "你 · 探讨想法"}
              </strong>
              <MessageMarkdown text={m.text} />
              {m.question && <p>导师提问：{m.question}</p>}
            </div>
          ))}
          {t.revision === project.revision && (
            <button type="button" disabled={sending || !!pending} onClick={() => setTopic(t.topic)}>
              继续这个议题
            </button>
          )}
        </details>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (sending || busy) return;
          const input = pending ?? {
            id: crypto.randomUUID(),
            topic: topic.trim(),
            revision: project.revision,
            expectedMessages: selected?.messages.length ?? 0,
            intent,
            text: text.trim(),
          };
          setPending(input);
          setSending(true);
          setError("");
          void onSend(input)
            .then(() => {
              setText("");
              setPending(null);
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setSending(false));
        }}
      >
        <label>
          议题
          <input
            required
            maxLength={200}
            value={topic}
            disabled={sending || !!pending}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <label>
          这次表达的是
          <select
            value={intent}
            disabled={sending || !!pending}
            onChange={(e) => setIntent(e.target.value === "instruction" ? "instruction" : "idea")}
          >
            <option value="idea">探讨想法／自由回答</option>
            <option value="instruction">正式指令</option>
          </select>
        </label>
        <label>
          我的想法或回答
          <textarea
            required
            maxLength={10000}
            value={text}
            disabled={sending || !!pending}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {intent === "instruction" && (
          <p>
            将按正式指令交给导师处理；不会自动替你选择待决定事项，也不会跳过材料变更或内容核验。
          </p>
        )}
        {project.status !== "running" && (
          <p>请先通过课题原有控制恢复当前任务后发送。历史研讨继续保留。</p>
        )}
        <button
          disabled={
            busy || sending || project.status !== "running" || !topic.trim() || !text.trim()
          }
        >
          {pending ? "重试发送同一条消息" : "交给导师"}
        </button>
        {pending && !sending && (
          <button
            type="button"
            onClick={() => {
              setPending(null);
              setError("");
            }}
          >
            核对记录后编辑
          </button>
        )}
        {error && <p role="alert">{error} 原文字保留；先核对记录，重试不会重复登记同一消息。</p>}
      </form>
    </details>
  );
}
