import { useState } from "react";
import type { ResearchGroupAction, ResearchProject } from "../../../../contracts/research-group";
import { researchLanguageParagraphs } from "../../../../contracts/research-language-tools";

export function ResearchLanguagePanel({
  project,
  busy,
  act,
}: {
  project: ResearchProject;
  busy: boolean;
  act: (action: ResearchGroupAction) => Promise<void>;
}) {
  const drafts = project.artifacts.filter(
    (a) =>
      a.revision === project.revision &&
      a.role === "lead" &&
      ["writing", "audit"].includes(a.stage ?? "") &&
      ["stage-draft", "stage-revision"].includes(a.kind),
  );
  const [baselineId, setBaselineId] = useState("");
  const baseline = drafts.find((a) => a.id === baselineId) ?? drafts.at(-1);
  const [selected, setSelected] = useState<string[]>([]),
    [terms, setTerms] = useState("");
  const [reason, setReason] = useState(""),
    [error, setError] = useState("");
  if (!drafts.length && !project.languageRevisions?.length) return null;
  const target = project.root;
  const readOnly = project.status === "completed";
  const grant = async () => {
    if (!baseline) return;
    setError("");
    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(baseline.content),
      );
      const bodySha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      await act({
        kind: "language-scope",
        target,
        input: {
          baselineId: baseline.id,
          bodySha256,
          rangeIds: selected,
          frozenTerms: [
            ...new Set(
              terms
                .split(/\n/)
                .map((term) => term.trim())
                .filter(Boolean),
            ),
          ],
        },
      });
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <details className="research-group-records" data-testid="research-language-panel">
      <summary>语言修改与语义复核 · {project.languageRevisions?.length ?? 0} 次改写</summary>
      {readOnly ? (
        <p>
          本轮稿件已接受，此处保留阅读与检查记录。要继续修改，请在导师会话提交新的修改要求，建立新输入版本后选段。
        </p>
      ) : null}
      <p>
        选定本次可修改的段落，原稿与未选正文保留。数字、引文和保护词的程序检查，与 A/B
        逐段语义复核分别记录。
      </p>
      {baseline ? (
        <details>
          <summary>选定正文范围</summary>
          <label>
            改写前基线
            <select
              aria-label="语言改写基线"
              value={baseline.id}
              disabled={busy || readOnly}
              onChange={(e) => {
                setBaselineId(e.target.value);
                setSelected([]);
              }}
            >
              {drafts.map((a, i) => (
                <option key={a.id} value={a.id}>
                  {a.stage === "audit" ? "全文审阅" : "论文写作"} · 第 {i + 1} 份稿
                </option>
              ))}
            </select>
          </label>
          {researchLanguageParagraphs(baseline.content).map((range) => (
            <label key={range.id} className="research-material-item">
              <input
                type="checkbox"
                checked={selected.includes(range.id)}
                disabled={busy || readOnly}
                onChange={(e) =>
                  setSelected((prior) =>
                    e.target.checked ? [...prior, range.id] : prior.filter((id) => id !== range.id),
                  )
                }
              />
              {range.label}
              <blockquote>{range.exactText}</blockquote>
            </label>
          ))}
          <label>
            额外保护的术语或变量（每行一个，须与原稿一致）
            <textarea
              aria-label="语言保护词"
              value={terms}
              disabled={busy || readOnly}
              onChange={(e) => setTerms(e.target.value)}
            />
          </label>
          <p>
            原稿中的 AI
            使用说明自动保留。完整论文已有写作授权时，成员也可使用该授权范围；限定任务须按实际选段处理。
          </p>
          <button
            type="button"
            disabled={busy || readOnly || !selected.length}
            onClick={() => void grant().catch((e) => setError(String(e)))}
          >
            保存语言修改范围
          </button>
        </details>
      ) : null}
      {project.languageScopes?.length ? (
        <p>已保存 {project.languageScopes.length} 份范围授权，旧范围与基线保留。</p>
      ) : null}
      {[...(project.languageRevisions ?? [])].reverse().map((revision) => {
        const current = project.fusion?.tasks.some(
          (task) =>
            task.currentArtifactId === revision.target.id &&
            task.id.startsWith(`v${project.revision}:`),
        );
        return (
          <details
            className="research-material-item"
            key={revision.id}
            data-language-revision={revision.id}
          >
            <summary>
              {current ? "当前稿" : "历史稿"} ·{" "}
              {revision.programReport.hardIssues.length ? "有程序阻断" : "程序检查已记录"} ·{" "}
              {revision.semanticReviews.length} 份具名复核
            </summary>
            <p>
              双稿版本：{revision.baseline.bodySha256.slice(0, 12)} →{" "}
              {revision.target.bodySha256.slice(0, 12)}
            </p>
            <p>
              改动 {revision.programReport.units.length} 段；风险候选{" "}
              {revision.programReport.semanticCandidates.length}{" "}
              处。程序不确定判断所有自然语言语义。
            </p>
            <details>
              <summary>前后正文与定位</summary>
              <pre>{revision.baseline.body}</pre>
              <pre>{revision.target.body}</pre>
            </details>
            {[
              ...revision.programReport.hardIssues,
              ...revision.programReport.semanticCandidates,
            ].map((issue) => (
              <p key={issue.id}>
                <b>{issue.category}</b>：{issue.reason}
                <br />
                <q>{issue.baseline.exactText}</q> → <q>{issue.target.exactText}</q>
              </p>
            ))}
            {revision.semanticReviews.map((review) => (
              <p key={review.id}>
                {review.actor.kind === "model"
                  ? `研究者 ${review.actor.role === "lead" ? "A" : "B"}`
                  : review.actor.id}{" "}
                · {review.classification}
                <br />
                {review.reason}
              </p>
            ))}
            {revision.skip ? (
              <p>用户已跳过：{revision.skip.reason}。这条记录不表示程序或语义检查通过。</p>
            ) : current && !readOnly ? (
              <details>
                <summary>跳过本次语言打磨</summary>
                <label>
                  具体原因
                  <textarea
                    aria-label="跳过语言打磨的原因"
                    value={reason}
                    disabled={busy}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void act({
                      kind: "language-skip",
                      target,
                      input: { revisionId: revision.id, reason },
                    }).catch((e) => setError(String(e)))
                  }
                >
                  记录跳过原因
                </button>
                <p>保留硬性错误及实质内容问题，其他审阅仍须完成。</p>
              </details>
            ) : null}
          </details>
        );
      })}
      {project.languageDispositions?.map((entry) => (
        <p key={entry.id}>未进行语言打磨：{entry.reason}；仅对应已记录的稿件版本。</p>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
