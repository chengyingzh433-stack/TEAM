import { useRef, useState } from "react";
import type { ResearchTaskGraph } from "../../../../contracts/research-task-graph";
import {
  projectResearchDecisionReuse,
  type ResearchTaskReuseDecisionInput,
} from "../../../../contracts/research-decision-reuse";
import {
  decodeResearchTaskAnswerInput,
  decodeResearchTaskRetryInput,
  decodeResearchTaskResolveInput,
  parseResearchControlTokenCount,
  projectResearchTaskControls,
  researchDecisionReplyIdentity,
} from "../../../../contracts/research-task-controls";
import type {
  ResearchTaskAnswerInput,
  ResearchTaskRetryInput,
  ResearchTaskResolveInput,
} from "../../../../contracts/research-task-controls";

export interface ResearchTaskControlsProps {
  graph: ResearchTaskGraph;
  busy: boolean;
  onAnswer: (input: ResearchTaskAnswerInput) => void | Promise<void>;
  onReuse?: (input: ResearchTaskReuseDecisionInput) => void | Promise<void>;
  onRetry: (input: ResearchTaskRetryInput) => void | Promise<void>;
  onResolve: (input: ResearchTaskResolveInput) => void | Promise<void>;
}
const outcomeLabels = { confirmed: "确认", declined: "拒绝", deferred: "暂缓" };
const statusLabels = { ...outcomeLabels, pending: "等待选择", superseded: "已被新版本替代" };
function useSubmission(busy: boolean) {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return {
    disabled: busy || pending,
    error,
    submit(action: () => void | Promise<void>) {
      if (busy || lock.current) return;
      lock.current = true;
      setPending(true);
      setError("");
      Promise.resolve()
        .then(action)
        .then(
          () => {
            lock.current = false;
            setPending(false);
          },
          (error: unknown) => {
            setError(error instanceof Error ? error.message : "操作失败，请重试。");
            lock.current = false;
            setPending(false);
          },
        );
    },
  };
}
type DecisionView = ReturnType<typeof projectResearchTaskControls>["decisions"][number];
function DecisionControl({
  view,
  busy,
  onAnswer,
  onReuse,
  graph,
}: { view: DecisionView } & Pick<
  ResearchTaskControlsProps,
  "busy" | "onAnswer" | "onReuse" | "graph"
>) {
  const [optionId, setOptionId] = useState("");
  const [sourceDecisionId, setSourceDecisionId] = useState("");
  const [reuseOptionId, setReuseOptionId] = useState("");
  const [text, setText] = useState("");
  const submission = useSubmission(busy);
  const { request, status, replies } = view;
  const option = request.options.find((o) => o.id === optionId);
  const reuse = projectResearchDecisionReuse(graph, request.id);
  const source = reuse.candidates.find((candidate) => candidate.decision.id === sourceDecisionId);
  const reuseOption = request.options.find(
    (item) => item.id === reuseOptionId && item.outcome === "confirmed",
  );
  const scopeLabels = (ids: string[]) =>
    ids
      .map((id) => {
        const task = graph.tasks.find((item) => item.id === id);
        return task
          ? `${task.stage} / ${task.role} · 输入版本 ${task.inputVersion}`
          : "历史任务（详见项目记录）";
      })
      .join("；");
  return (
    <details className="research-material-item" data-decision-id={request.id}>
      <summary>
        {request.question} · {statusLabels[status]}
      </summary>
      <p>{request.context}</p>
      <p>影响：{request.impact}</p>
      {replies.map((reply) => (
        <p key={reply.id}>
          <strong>{researchDecisionReplyIdentity(reply)}</strong> · {reply.at}
          <br />
          {reply.text}
          {reply.sourceDecisionId && (
            <>
              <br />
              原决定：{reply.sourceDecisionId}；本次映射出处：{reply.evidenceRef}
            </>
          )}
        </p>
      ))}
      {status !== "confirmed" && status !== "superseded" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!option) return;
            submission.submit(() =>
              onAnswer(
                decodeResearchTaskAnswerInput({
                  requestId: request.id,
                  optionId,
                  text: text.trim() || option.label,
                }),
              ),
            );
          }}
        >
          <label>
            我的选择
            <select
              aria-label="我的选择"
              value={optionId}
              disabled={submission.disabled}
              onChange={(event) => setOptionId(event.target.value)}
              required
            >
              <option value="">请选择，不会自动提交</option>
              {request.options.map((item) => (
                <option key={item.id} value={item.id}>
                  {outcomeLabels[item.outcome]}：{item.label}
                  {item.id === request.recommendedOptionId ? "（建议）" : ""}
                </option>
              ))}
            </select>
          </label>
          {option && <p>{option.consequence}</p>}
          <label>
            补充说明（选填）
            <textarea
              value={text}
              maxLength={6000}
              disabled={submission.disabled}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <button type="submit" disabled={submission.disabled || !option}>
            提交我的决定
          </button>
        </form>
      )}
      {onReuse && reuse.available && reuse.candidates.length > 0 && (
        <details data-testid="research-decision-reuse">
          <summary>沿用已有决定（可选）</summary>
          <p>
            查看原决定及其范围，再明确选择本次选项。原始任务说明和模型意见不会自动成为本次答复；本操作不代表伦理审批。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!source || !reuseOption) return;
              submission.submit(() =>
                onReuse({
                  requestId: request.id,
                  optionId: reuseOption.id,
                  sourceDecisionId: source.decision.id,
                  expectedContextToken: reuse.token,
                }),
              );
            }}
          >
            <label>
              选择既有用户决定
              <select
                aria-label="选择既有用户决定"
                value={sourceDecisionId}
                disabled={submission.disabled}
                onChange={(event) => {
                  setSourceDecisionId(event.target.value);
                  setReuseOptionId("");
                }}
              >
                <option value="">请选择，不会自动沿用</option>
                {reuse.candidates.map((candidate) => (
                  <option key={candidate.decision.id} value={candidate.decision.id}>
                    {candidate.request.question} · {candidate.decision.at}
                  </option>
                ))}
              </select>
            </label>
            {source && (
              <div>
                <p>原问题：{source.request.question}</p>
                <p>
                  原选择：
                  {
                    source.request.options.find((item) => item.id === source.decision.optionId)
                      ?.label
                  }
                </p>
                <p>原答复：{source.decision.text}</p>
                <p>
                  原范围：{source.request.impact}；{scopeLabels(source.request.affectedTaskIds)}
                </p>
                <p>
                  时间：{source.decision.at}；条件版本：{source.request.version}；出处：
                  {source.decision.evidenceRef}
                </p>
                <p>
                  本次范围：{request.impact}；{scopeLabels(request.affectedTaskIds)}
                </p>
              </div>
            )}
            <label>
              将既有决定用于本次选项
              <select
                aria-label="将既有决定用于本次选项"
                value={reuseOptionId}
                disabled={submission.disabled || !source}
                onChange={(event) => setReuseOptionId(event.target.value)}
              >
                <option value="">请明确选择本次适用选项</option>
                {request.options
                  .filter((item) => item.outcome === "confirmed")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </label>
            {reuseOption && <p>{reuseOption.consequence}</p>}
            <button type="submit" disabled={submission.disabled || !source || !reuseOption}>
              明确沿用这个决定
            </button>
          </form>
        </details>
      )}
      {submission.error && (
        <p role="alert" className="research-group-error">
          {submission.error}
        </p>
      )}
    </details>
  );
}
function RetryControl({
  task,
  busy,
  onRetry,
}: { task: ResearchTaskGraph["tasks"][number] } & Pick<
  ResearchTaskControlsProps,
  "busy" | "onRetry"
>) {
  const [reason, setReason] = useState("");
  const submission = useSubmission(busy);
  return (
    <details className="research-material-item" data-task-id={task.id}>
      <summary>恢复失败任务：{task.goal}</summary>
      <p>{task.error || "这项任务执行失败。"} 已有成果会保留。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submission.submit(() =>
            onRetry(decodeResearchTaskRetryInput({ taskId: task.id, reason })),
          );
        }}
      >
        <label>
          恢复说明
          <textarea
            required
            maxLength={6000}
            value={reason}
            disabled={submission.disabled}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button type="submit" disabled={submission.disabled || !reason.trim()}>
          只恢复这项任务
        </button>
      </form>
      {submission.error && (
        <p role="alert" className="research-group-error">
          {submission.error}
        </p>
      )}
    </details>
  );
}
function ResolveControl({
  view,
  busy,
  onResolve,
}: { view: ReturnType<typeof projectResearchTaskControls>["unknown"][number] } & Pick<
  ResearchTaskControlsProps,
  "busy" | "onResolve"
>) {
  const [outcome, setOutcome] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [tokens, setTokens] = useState("");
  const submission = useSubmission(busy);
  const { attempt, task } = view;
  return (
    <details className="research-material-item" data-attempt-id={attempt.id}>
      <summary>核对执行结果：{task?.goal ?? "执行状态未知"}</summary>
      <p>请根据实际会话或服务方记录核对。登记结果不会自动重试，也不会代替成果审阅。</p>
      <p>
        发起时间：{attempt.dispatchedAt ?? attempt.preparedAt}
        <br />
        会话运行：{attempt.nativeRunId ?? "未记录"}
      </p>
      {attempt.error && <p>{attempt.error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submission.submit(() =>
            onResolve(
              decodeResearchTaskResolveInput({
                attemptId: attempt.id,
                outcome,
                reason,
                evidenceRef,
                usedTokens: parseResearchControlTokenCount(tokens),
              }),
            ),
          );
        }}
      >
        <label>
          核实的执行结果
          <select
            aria-label="核实的执行结果"
            required
            value={outcome}
            disabled={submission.disabled}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="">请选择已核实的结果</option>
            <option value="succeeded">执行已成功结束</option>
            <option value="failed">执行失败</option>
            <option value="cancelled">执行已取消</option>
          </select>
        </label>
        <label>
          核对依据（会话、记录位置或凭据编号）
          <textarea
            required
            maxLength={4096}
            value={evidenceRef}
            disabled={submission.disabled}
            onChange={(event) => setEvidenceRef(event.target.value)}
          />
        </label>
        <label>
          核对说明
          <textarea
            required
            maxLength={6000}
            value={reason}
            disabled={submission.disabled}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <label>
          已核实 Token 用量（未知请留空）
          <input
            inputMode="numeric"
            value={tokens}
            disabled={submission.disabled}
            onChange={(event) => setTokens(event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={submission.disabled || !outcome || !reason.trim() || !evidenceRef.trim()}
        >
          登记核对结果
        </button>
      </form>
      {submission.error && (
        <p role="alert" className="research-group-error">
          {submission.error}
        </p>
      )}
    </details>
  );
}
export function ResearchTaskControls(props: ResearchTaskControlsProps) {
  const view = projectResearchTaskControls(props.graph);
  const count = view.waiting.length + view.failed.length + view.unknown.length;
  if (!count && !view.decisions.length) return null;
  return (
    <details className="research-group-records" data-testid="research-task-controls">
      <summary>{count ? `需要我处理 · ${count}` : "我的决定记录"}</summary>
      {view.decisions.map((item) => (
        <DecisionControl
          key={item.request.id}
          view={item}
          busy={props.busy}
          onAnswer={props.onAnswer}
          onReuse={props.onReuse}
          graph={props.graph}
        />
      ))}
      {view.failed.map((task) => (
        <RetryControl key={task.id} task={task} busy={props.busy} onRetry={props.onRetry} />
      ))}
      {view.unknown.map((item) => (
        <ResolveControl
          key={item.attempt.id}
          view={item}
          busy={props.busy}
          onResolve={props.onResolve}
        />
      ))}
    </details>
  );
}
