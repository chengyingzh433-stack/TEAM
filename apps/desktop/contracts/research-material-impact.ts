import { decodeMaterialAdoptionDeclaration } from "./research-materials";
import type { MaterialAdoptionDeclaration } from "./research-materials";
export type ResearchMaterialChangeRequest =
  | {
      kind: "replace";
      sourceId: string;
      candidateMaterialId: string;
      declaration: MaterialAdoptionDeclaration;
      reason: string;
    }
  | { kind: "withdraw"; sourceId: string; reason: string };
export interface ResearchMaterialChangeCommit {
  changeId: string;
  expectedImpactToken: string;
  request: ResearchMaterialChangeRequest;
}
export interface ResearchMaterialImpact {
  token: string;
  sourceId: string;
  sourceTitle: string;
  inputIds: string[];
  directTaskIds: string[];
  affectedTaskIds: string[];
  reusableTaskIds: string[];
  affectedArtifactIds: string[];
  requiresDesignReview: boolean;
  supersedesExport: boolean;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("材料变更无效。");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((k) => !keys.includes(k))) throw new Error("材料变更含未知字段。");
  return r;
}
function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}无效。`);
  return value.trim();
}
export function decodeResearchMaterialChangeRequest(value: unknown): ResearchMaterialChangeRequest {
  const r = record(value, ["kind", "sourceId", "candidateMaterialId", "declaration", "reason"]);
  const sourceId = text(r.sourceId, "来源身份"),
    reason = text(r.reason, "变更原因", 6000);
  if (r.kind === "withdraw") {
    if ("candidateMaterialId" in r || "declaration" in r) throw new Error("撤回不能附带替换材料。");
    return { kind: "withdraw", sourceId, reason };
  }
  if (r.kind !== "replace") throw new Error("无效材料变更类型。");
  return {
    kind: "replace",
    sourceId,
    reason,
    candidateMaterialId: text(r.candidateMaterialId, "候选材料"),
    declaration: decodeMaterialAdoptionDeclaration(r.declaration),
  };
}
export function decodeResearchMaterialChangeCommit(value: unknown): ResearchMaterialChangeCommit {
  const r = record(value, ["changeId", "expectedImpactToken", "request"]);
  return {
    changeId: text(r.changeId, "变更身份"),
    expectedImpactToken: text(r.expectedImpactToken, "影响快照"),
    request: decodeResearchMaterialChangeRequest(r.request),
  };
}
