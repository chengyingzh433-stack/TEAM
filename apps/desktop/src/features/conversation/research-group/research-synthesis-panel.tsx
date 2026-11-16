import type { ResearchProject } from "../../../../contracts/research-group";
import { RESEARCH_SYNTHESIS_COLUMNS } from "../../../../contracts/research-synthesis";

const columns = {
  researchQuestion: "研究问题",
  populationContext: "对象与情境",
  conceptsMeasures: "概念与测量",
  designEvidence: "设计与证据",
  findings: "发现",
  limitations: "局限",
  relationToQuestion: "与本问题的关系",
};
const states = {
  "pending-validation": "待验证",
  "supported-in-scope": "在所查范围内有支持",
  "weakened-or-rejected": "已削弱或否定",
};
export function ResearchSynthesisPanel({ project }: { project: ResearchProject }) {
  const ledger = project.synthesis;
  if (!ledger || !(ledger.matrices.length || ledger.gaps.length || ledger.counterevidence.length))
    return null;
  const currentDraft = (artifactId: string, taskVersion: number) =>
    project.fusion?.tasks.some(
      (task) => task.currentArtifactId === artifactId && task.inputVersion === taskVersion,
    );
  return (
    <details className="research-group-records" data-testid="research-synthesis-panel">
      <summary>
        文献综合与反证 · {ledger.matrices.length} 份矩阵 · {ledger.counterevidence.length} 条反证
      </summary>
      <p>
        每份综合对应明确稿件及所读原文。候选缺口的支持仅限已查范围；新证据是否改变问题仍需具名判断、回应和复核。
      </p>
      {ledger.matrices.map((matrix) => (
        <details key={matrix.id} className="research-material-item">
          <summary>
            {currentDraft(matrix.artifactId, matrix.draft.taskVersion) ? "当前稿" : "历史稿"} ·
            文献对照
          </summary>
          <div className="research-synthesis-table">
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  {RESEARCH_SYNTHESIS_COLUMNS.map((column) => (
                    <th key={column}>{columns[column]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row) => (
                  <tr key={row.sourceId}>
                    <th>
                      {project.evidence?.sources.find((source) => source.id === row.sourceId)
                        ?.title ?? row.sourceId}
                    </th>
                    {RESEARCH_SYNTHESIS_COLUMNS.map((column) => {
                      const cell = row.cells[column];
                      return (
                        <td key={column}>
                          {"unavailable" in cell ? (
                            `未取得：${cell.unavailable}`
                          ) : (
                            <>
                              {cell.summary}
                              <details>
                                <summary>原文依据 · {cell.evidence.length} 处</summary>
                                {cell.evidence.map((evidence, index) => (
                                  <p key={index}>
                                    <q>{evidence.exactText}</q>
                                    <br />
                                    {evidence.requiredDepth} · 字符 {evidence.start}–{evidence.end}
                                  </p>
                                ))}
                              </details>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      {ledger.gaps.map((gap) => (
        <details key={gap.id} className="research-material-item">
          <summary>
            {currentDraft(gap.artifactId, gap.draft.taskVersion) ? "当前稿" : "历史稿"} · 候选缺口 ·{" "}
            {states[gap.state]}
          </summary>
          <p>{gap.statement}</p>
          <p>范围：{gap.scope}</p>
          <p>仍不确定：{gap.remainingUncertainty}</p>
          {gap.supersedesId ? <p>已保留前一版本及本次改变，旧判断不能自动成为新稿依据。</p> : null}
        </details>
      ))}
      {ledger.counterevidence.map((counter) => (
        <details key={counter.id} className="research-material-item">
          <summary>新增反证 · {counter.materialChange ? "涉及实质变化" : "明确局部影响"}</summary>
          <p>{counter.reason}</p>
          <blockquote>{counter.source.exactText}</blockquote>
          {ledger.responses
            .filter((response) => response.counterevidenceId === counter.id)
            .map((response) => (
              <div key={response.id}>
                <p>
                  <b>A 的实际新稿回应</b>：{response.reason}
                </p>
                <blockquote>{response.exactText}</blockquote>
                {ledger.reviews
                  .filter((review) => review.responseId === response.id)
                  .map((review) => (
                    <div key={review.id}>
                      <p>
                        <b>B 的具名复核</b>：
                        {review.conclusion === "addressed" ? "认为已回应" : "仍未解决"}。
                        {review.reason}
                      </p>
                      {ledger.resolutions
                        .filter((resolution) => resolution.reviewId === review.id)
                        .map((resolution) => (
                          <p key={resolution.id}>
                            <b>导师 Agent 处理</b>：
                            {resolution.decision === "close" ? "记录关闭" : "保留待处理"}。
                            {resolution.reason}（只对应记录中的稿件版本。）
                          </p>
                        ))}
                    </div>
                  ))}
              </div>
            ))}
        </details>
      ))}
    </details>
  );
}
