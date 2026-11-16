import type { ResearchContentCheckRecord } from "../../../../contracts/research-content-checks";

export function ResearchContentChecks({
  records,
}: {
  records?: readonly ResearchContentCheckRecord[];
}) {
  if (!records?.length) return null;
  return (
    <details className="research-group-records" data-testid="research-content-checks">
      <summary>程序核验 · {records.length} 次记录</summary>
      <p>
        每条记录对应检查时的稿件和数据。新的稿件或数据需要重新检查；数值一致不代表结论或全文已通过审阅。
      </p>
      {[...records].reverse().map((record) => (
        <details
          className="research-material-item"
          key={record.id}
          data-check-result={record.result}
          data-check-kind={record.kind}
        >
          <summary>
            {record.kind === "claim-acceptance" ? "主张与证据" : "数值关系"} ·{" "}
            {record.result === "blocked"
              ? "检查时仍有问题"
              : record.kind === "claim-acceptance"
                ? "检查时无未关闭核查项"
                : "检查时无数值阻断"}{" "}
            · <time dateTime={record.at}>{record.at}</time>
          </summary>
          <p>程序检查；研究者 B 的内容意见与导师 Agent 裁定另行保留。</p>
          {record.issues.length ? (
            <ul>
              {record.issues.map((issue, index) => (
                <li key={`${issue.code}:${index}`}>
                  {issue.detail}
                  {issue.fieldPath ? (
                    <details>
                      <summary>结果字段与定位</summary>
                      <code>{issue.fieldPath.join(" → ")}</code>
                      <p>{issue.bindingId ?? issue.runId}</p>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {record.kind === "claim-acceptance"
                ? "本次登记的主张没有未关闭的定位、阅读、版本或模型意见；语义支持仍属于模型审阅。"
                : "本次未发现已明确绑定数值的确定性问题。"}
            </p>
          )}
          {record.unboundCandidates.length ? (
            <details>
              <summary>仍待逐项绑定或审阅 · {record.unboundCandidates.length} 个片段</summary>
              <ul>
                {record.unboundCandidates.map((candidate, index) => (
                  <li key={`${candidate.start}:${index}`}>
                    <q>{candidate.text}</q>：{candidate.reason}（字符 {candidate.start}–
                    {candidate.end}）
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <details>
            <summary>检查版本</summary>
            <p>稿件：{record.target?.artifactId ?? "尚无可检查稿件"}</p>
            <p>正文摘要：{record.target?.bodySha256 ?? "无"}</p>
            <p>程序版本：{record.program.id}</p>
            <p>阶段：{record.stage === "writing" ? "论文写作" : "全文审查"}</p>
          </details>
        </details>
      ))}
    </details>
  );
}
