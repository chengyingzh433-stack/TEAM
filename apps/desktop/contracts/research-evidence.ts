import type { ResearchRole } from "./research-group";

export interface ResearchSource {
  materialImportId?: string;
  id: string;
  title: string;
  authors: string;
  year: string;
  url: string;
  file: string;
  sha256: string;
  kind: "paper" | "dataset" | "method" | "manuscript" | "design";
  access: "provided-text" | "retrieved-text";
  /** Declared availability of this supplied text; actual read ranges remain separate receipts. */
  textScope?: "metadata" | "abstract" | "partial-text" | "full-text";
}
export interface ResearchDataset {
  materialImportId?: string;
  id: string;
  file: string;
  sha256: string;
  description: string;
  sourceId: string;
  dataKind: "observed" | "synthetic";
  permission: "public" | "user-authorized";
  delimiter: "," | ";" | "\t";
}
export interface ResearchEvidence {
  directory: string;
  manifestSha256?: string;
  sources: ResearchSource[];
  datasets: ResearchDataset[];
}
export interface ResearchAnalysisSpec {
  datasetId: string;
  method: "describe" | "correlation" | "ols";
  columns: string[];
  outcome?: string;
}
export interface ResearchAnalysisBinding {
  taskId: string;
  taskInputVersion: number;
  attemptId: string;
}
export interface ResearchAnalysisRun extends Partial<ResearchAnalysisBinding> {
  id: string;
  revision: number;
  role: ResearchRole;
  createdAt: string;
  spec: ResearchAnalysisSpec;
  datasetSha256: string;
  engine: string;
  /** Host pins the bytes written by this execution; builds may stringify functions differently. */
  replayScriptSha256?: string;
  result: Record<string, unknown>;
  sha256: string;
  file: string;
}
