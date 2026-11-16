import { useState } from "react";
import type { ResearchProject, ResearchGroupAction } from "../../../../contracts/research-group";

export function ResearchArchiveControl({
  project,
  busy,
  run,
  open,
}: {
  project: ResearchProject;
  busy: boolean;
  run: (action: ResearchGroupAction) => void;
  open?: (path: string) => Promise<void>;
}) {
  const [sourceIds, setSources] = useState<string[]>([]);
  const [datasetIds, setDatasets] = useState<string[]>([]);
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  const receipts = [
    ...(project.archiveOrigin ? [project.archiveOrigin] : []),
    ...(project.archives ?? []),
  ];
  return (
    <details>
      <summary>研究归档与导入</summary>
      <p>
        逐项确认允许随包分发的原文和数据。未勾选的材料仅保留出处与缺项；课程库原文不随包分发。归档中的复算程序不会自动执行。
      </p>
      {(project.evidence?.sources ?? []).map((source) => (
        <label key={source.id}>
          <input
            type="checkbox"
            checked={sourceIds.includes(source.id)}
            onChange={(e) =>
              setSources(
                e.target.checked
                  ? [...sourceIds, source.id]
                  : sourceIds.filter((id) => id !== source.id),
              )
            }
          />
          允许分发原文：{source.title}（{source.id}）
        </label>
      ))}
      {(project.evidence?.datasets ?? []).map((data) => (
        <label key={data.id}>
          <input
            type="checkbox"
            checked={datasetIds.includes(data.id)}
            onChange={(e) =>
              setDatasets(
                e.target.checked
                  ? [...datasetIds, data.id]
                  : datasetIds.filter((id) => id !== data.id),
              )
            }
          />
          允许分发数据：{data.description}（{data.id}）
        </label>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          run({ kind: "export-archive", target: project.root, input: { sourceIds, datasetIds } })
        }
      >
        导出研究归档
      </button>
      <label>
        归档目录（含 manifest.json）
        <input value={directory} onChange={(e) => setDirectory(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={busy || !directory.trim()}
        onClick={() => run({ kind: "import-archive", target: project.root, input: { directory } })}
      >
        校验并导入为新课题
      </button>
      <p>导入创建新课题，保留原身份映射和历史记录；不会恢复原会话或将旧审阅当作新任务许可。</p>
      {receipts.map((receipt) => (
        <div key={receipt.directory}>
          <p>
            原课题 {receipt.sourceProjectId} · 输入版本 {receipt.revision}
            <br />
            {receipt.directory}
          </p>
          {open ? (
            <button
              type="button"
              onClick={() =>
                void open(`${receipt.directory}/index.html`).catch((e: unknown) =>
                  setError(String(e)),
                )
              }
            >
              打开归档目录与缺项
            </button>
          ) : null}
        </div>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
