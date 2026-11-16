import type { ResearchProject } from "../../../../contracts/research-group";
import { RESEARCH_ROLE_LABELS } from "../../../../contracts/research-group";

export function ResearchSourcePagesPanel({ project }: { project: ResearchProject }) {
  if (!project.sourcePageReceipts?.length) return null;
  return (
    <details className="research-group-records" data-testid="research-source-pages-panel">
      <summary>原页与图表阅读 · {project.sourcePageReceipts.length} 次图像取得</summary>
      <p>
        图像取得与成员的具体观察分别记录；阅读深度仅覆盖所列物理页，不能据此称全文或未读图表已核验。
      </p>
      {project.sourcePageReceipts.map((receipt) => (
        <details key={receipt.id} className="research-material-item">
          <summary>
            {RESEARCH_ROLE_LABELS[receipt.role]} ·{" "}
            {project.evidence?.sources.find((source) => source.id === receipt.sourceId)?.title ??
              receipt.sourceId}{" "}
            · 物理第 {receipt.page} 页
          </summary>
          <p>
            共 {receipt.pageCount} 页；本次原页 {receipt.width} × {receipt.height} 像素。输入版本{" "}
            {receipt.revision}。
          </p>
          {project.sourcePageReadings
            ?.filter((reading) => reading.receiptId === receipt.id)
            .map((reading) => (
              <div key={reading.id}>
                <p>{reading.observations}</p>
                {reading.remainingLimitations.length ? (
                  <p>仍未核验：{reading.remainingLimitations.join("；")}</p>
                ) : null}
              </div>
            ))}
          {!project.sourcePageReadings?.some((reading) => reading.receiptId === receipt.id) ? (
            <p>尚无该成员的具体读图观察。</p>
          ) : null}
          <details>
            <summary>原件与图像版本</summary>
            <p>原件：{receipt.originalSha256}</p>
            <p>图像：{receipt.imageSha256}</p>
            <p>渲染：{receipt.rendererVersion}</p>
          </details>
        </details>
      ))}
    </details>
  );
}
