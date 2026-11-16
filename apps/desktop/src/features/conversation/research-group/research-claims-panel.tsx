import type { ResearchClaims } from "../../../../contracts/research-claims";

const category = {
  "source-fact": "来源事实",
  "research-result": "本研究结果",
  inference: "解释与推断",
  method: "方法依据",
};
const conclusion = {
  supported: "支持",
  "partially-supported": "部分支持",
  unsupported: "不支持",
  "insufficient-material": "材料不足",
};
const depth = {
  metadata: "题录",
  abstract: "摘要",
  "partial-text": "部分正文",
  "full-text": "全文来源",
};

export function ResearchClaimsPanel({ ledger }: { ledger?: ResearchClaims }) {
  if (!ledger?.claims.length) return null;
  return (
    <details className="research-group-records" data-testid="research-claims-panel">
      <summary>
        主张与支持 · {ledger.claims.length} 条登记 · {ledger.reviews.length} 条模型审阅
      </summary>
      <p>
        每条记录固定到具体稿件、来源版本和实际阅读范围。新稿或新证据需要复核；支持结论来自有理由的模型审阅。
      </p>
      {ledger.claims.map((claim) => {
        const reviews = ledger.reviews.filter((review) => review.claimId === claim.id);
        const last = reviews.at(-1);
        return (
          <details className="research-material-item" key={claim.id} data-claim-id={claim.id}>
            <summary>
              {category[claim.category]} ·{" "}
              {last ? `审阅记录：${conclusion[last.conclusion]}` : "尚无模型审阅"}
            </summary>
            <blockquote>{claim.exactText}</blockquote>
            <details>
              <summary>稿件与定位</summary>
              <p>稿件：{claim.artifactId}</p>
              <p>
                字符：{claim.start}–{claim.end}
              </p>
              <p>正文摘要：{claim.bodySha256}</p>
            </details>
            {claim.evidence.map((evidence, index) => (
              <details key={index}>
                <summary>
                  {evidence.kind === "source"
                    ? `${evidence.relation === "counterevidence" ? "相反证据" : "支持依据"} · ${evidence.sourceId}`
                    : `实际结果 · ${evidence.runId}`}
                </summary>
                {evidence.kind === "source" ? (
                  <>
                    <p>
                      定位：{evidence.locatorId}，字符 {evidence.start}–{evidence.end}；要求层级：
                      {depth[evidence.requiredDepth]}
                    </p>
                    <blockquote>{evidence.exactText}</blockquote>
                    <p>来源摘要：{evidence.sourceSha256}</p>
                  </>
                ) : (
                  <>
                    <p>结果字段：{evidence.path.join(" → ")}</p>
                    <p>运行摘要：{evidence.runSha256}</p>
                  </>
                )}
              </details>
            ))}
            {reviews.map((review) => (
              <details className="research-material-item" key={review.id}>
                <summary>
                  {review.actor.role === "reviewer" ? "研究者 B Agent" : "导师 Agent"} ·{" "}
                  {conclusion[review.conclusion]} · <time dateTime={review.at}>{review.at}</time>
                </summary>
                <p>{review.reason}</p>
                <p>模型的语义审阅；不代表程序证明、人类专家意见或研究许可。</p>
                <details>
                  <summary>审阅身份与实际阅读</summary>
                  <p>
                    {review.actor.provider}/{review.actor.modelId}
                  </p>
                  <p>原生请求：{review.actor.runId}</p>
                  <ul>
                    {review.actualReads.map((read) => (
                      <li key={read.id}>
                        {read.sourceId} · {depth[read.depth]} · 字符 {read.start}–{read.end}
                      </li>
                    ))}
                  </ul>
                </details>
              </details>
            ))}
          </details>
        );
      })}
    </details>
  );
}
