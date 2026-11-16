export interface ResearchArchiveSelection {
  sourceIds: string[];
  datasetIds: string[];
}
export interface ResearchArchiveFile {
  path: string;
  sha256: string;
  bytes: number;
  kind: "record" | "source" | "dataset" | "analysis" | "manuscript";
  originalId: string;
}
export interface ResearchArchiveManifest {
  schema: "lancer-research-archive/1";
  workflowVersion: "legacy" | "fusion-v2";
  projectId: string;
  objective: string;
  revision: number;
  createdAt: string;
  files: ResearchArchiveFile[];
  missing: { id: string; reason: string; obtain: string }[];
}
export interface ResearchArchiveReceipt {
  directory: string;
  manifestSha256: string;
  sourceProjectId: string;
  revision: number;
}
export function decodeArchiveSelection(value: unknown): ResearchArchiveSelection {
  const v = value as ResearchArchiveSelection;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((key) => !["sourceIds", "datasetIds"].includes(key)) ||
    [v.sourceIds, v.datasetIds].some(
      (ids) =>
        !Array.isArray(ids) ||
        ids.length > 200 ||
        ids.some((id) => typeof id !== "string" || !id || id.length > 512) ||
        new Set(ids).size !== ids.length,
    )
  )
    throw new Error("请逐项选择允许分发的来源和数据。");
  return structuredClone(v);
}
