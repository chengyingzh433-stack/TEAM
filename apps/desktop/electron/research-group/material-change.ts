import { createHash } from "node:crypto";
import type { ResearchProject } from "../../contracts/research-group";
import type { ResearchSource, ResearchDataset } from "../../contracts/research-evidence";
import {
  decodeResearchMaterialChangeRequest,
  decodeResearchMaterialChangeCommit,
} from "../../contracts/research-material-impact";
import type {
  ResearchMaterialImpact,
  ResearchMaterialChangeRequest,
  ResearchMaterialChangeCommit,
} from "../../contracts/research-material-impact";
import { applyResearchChange, researchChangeImpact, setResearchInput } from "./task-graph";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
function context(project: ResearchProject, request: ResearchMaterialChangeRequest) {
  if (!project.fusion || !project.evidence) throw new Error("材料变更需要融合任务与已采用证据。");
  const source = project.evidence.sources.find((s) => s.id === request.sourceId);
  if (!source) throw new Error("此来源已不在本轮有效材料中，请刷新影响。");
  const datasets = project.evidence.datasets.filter((d) => d.sourceId === source.id);
  if (request.kind === "replace") {
    const candidate = project.importedMaterials?.find((m) => m.id === request.candidateMaterialId);
    if (!candidate || ["failed", "needs-parsing"].includes(candidate.status))
      throw new Error("替换候选不存在或尚不可用。");
    if (datasets.length > 1) throw new Error("此来源关联多个数据集，需要分别明确替换关系。");
    if (datasets.length > 0 !== (request.declaration.category === "data"))
      throw new Error("替换必须保持数据/文本用途；改变用途请单独采用并撤回旧材料。");
  }
  const inputIds = [`source:${source.id}`, ...datasets.map((d) => `dataset:${d.id}`)];
  if (datasets.length) inputIds.push("implementation-material");
  for (const id of inputIds)
    if (!project.fusion.adoptedInputs.some((i) => i.inputId === id))
      throw new Error(`材料输入未登记：${id}`);
  return { source, datasets, inputIds, graph: project.fusion, evidence: project.evidence };
}
export function previewResearchMaterialChange(
  project: ResearchProject,
  raw: ResearchMaterialChangeRequest,
): ResearchMaterialImpact {
  const request = decodeResearchMaterialChangeRequest(raw);
  const { source, datasets, inputIds, graph, evidence } = context(project, request);
  const extra = datasets.length
    ? graph.tasks
        .filter(
          (t) =>
            t.id.startsWith(`v${project.revision}:`) &&
            ["design", "analysis", "writing", "audit"].includes(t.stage),
        )
        .map((t) => t.id)
    : [];
  const directTaskIds = graph.tasks
    .filter((t) => t.inputs.some((i) => inputIds.includes(i.inputId)) || extra.includes(t.id))
    .map((t) => t.id);
  const affected = new Set(
    inputIds.flatMap((id) => researchChangeImpact(graph, id, extra).affectedTaskIds),
  );
  const impact = {
    sourceId: source.id,
    sourceTitle: source.title,
    inputIds,
    directTaskIds,
    affectedTaskIds: [...affected],
    reusableTaskIds: graph.tasks.filter((t) => !affected.has(t.id)).map((t) => t.id),
    affectedArtifactIds: graph.artifacts.filter((a) => affected.has(a.taskId)).map((a) => a.id),
    requiresDesignReview: datasets.length > 0,
    supersedesExport: !!project.finalPaper && affected.size > 0,
  };
  return {
    ...impact,
    // Authorize the reviewed materials, dependencies and results, not a moment
    // in the native event stream. Recompute the complete impact above so an
    // actually acquired dependency still invalidates an earlier authorization.
    token: hash({
      projectId: project.id,
      revision: project.revision,
      request,
      sources: evidence.sources,
      datasets: evidence.datasets,
      candidate:
        request.kind === "replace"
          ? project.importedMaterials?.find((m) => m.id === request.candidateMaterialId)
          : undefined,
      inputs: graph.inputs,
      adoptedInputs: graph.adoptedInputs,
      methodVersion: graph.methodVersion,
      tasks: graph.tasks.map((task) => ({
        id: task.id,
        stage: task.stage,
        role: task.role,
        kind: task.kind,
        goal: task.goal,
        inputVersion: task.inputVersion,
        inputs: task.inputs,
        dependencies: task.dependencies,
        earlyHandoff: task.earlyHandoff,
        deliverable: task.deliverable,
        reviewRequired: task.reviewRequired,
        writeScope: task.writeScope,
        currentArtifactId: task.currentArtifactId,
      })),
      impact,
      // Keep content and actual review state, including newly published outputs.
      // Merely pinning affected IDs would miss an edit under an existing ID.
      graphArtifacts: graph.artifacts,
      manuscripts: project.artifacts,
      finalPaper: project.finalPaper,
      supersededExports: project.supersededExports?.map(({ files, reason }) => ({ files, reason })),
    }),
  };
}
export interface PreparedResearchMaterialReplacement {
  source: ResearchSource;
  dataset?: ResearchDataset;
  /** Exact declaration used when preparing the immutable working files. */
  declaration: ResearchMaterialChangeRequest & { kind: "replace" };
}
/** Pure plan: caller must atomically persist returned project AND archivedEvidence; no files are deleted. */
export function planResearchMaterialChange(
  project: ResearchProject,
  raw: ResearchMaterialChangeCommit,
  at: string,
  prepared?: PreparedResearchMaterialReplacement,
) {
  const commit = decodeResearchMaterialChangeCommit(raw),
    request = commit.request;
  const prefix = `material-change:${hash(commit.changeId)}:`;
  const authorizationRef = `user-material-change:${hash(request)}`;
  const previous = project.fusion?.changes.filter((c) => c.id.startsWith(prefix)) ?? [];
  if (previous.length) {
    if (previous.some((c) => c.authorizationRef !== authorizationRef))
      throw new Error("变更身份已用于不同操作。");
    return {
      project: structuredClone(project),
      archivedEvidence: { sources: [] as ResearchSource[], datasets: [] as ResearchDataset[] },
      alreadyApplied: true,
    };
  }
  const impact = previewResearchMaterialChange(project, request);
  if (impact.token !== commit.expectedImpactToken)
    throw new Error("材料或依赖成果已变化，请重新查看影响。");
  const { source, datasets, graph } = context(project, request);
  if (
    request.kind === "replace" &&
    (!prepared ||
      hash(prepared.declaration) !== hash(request) ||
      prepared.source.materialImportId !== request.candidateMaterialId ||
      !/^[a-f0-9]{64}$/.test(prepared.source.sha256) ||
      !prepared.source.file ||
      (datasets.length > 0 &&
        (!prepared.dataset ||
          prepared.dataset.materialImportId !== request.candidateMaterialId ||
          !/^[a-f0-9]{64}$/.test(prepared.dataset.sha256) ||
          !prepared.dataset.file)))
  )
    throw new Error("准备副本与替换请求不匹配。");
  if (request.kind === "withdraw" && prepared) throw new Error("撤回不得使用替换副本。");
  const next = structuredClone(project),
    evidence = next.evidence!;
  evidence.sources = evidence.sources.filter((s) => s.id !== source.id);
  evidence.datasets = evidence.datasets.filter((d) => d.sourceId !== source.id);
  delete evidence.manifestSha256;
  if (request.kind === "replace" && prepared) {
    evidence.sources.push({ ...prepared.source, id: source.id });
    if (datasets.length && prepared.dataset)
      evidence.datasets.push({ ...prepared.dataset, id: datasets[0]!.id, sourceId: source.id });
  }
  let fusion = structuredClone(graph);
  for (const inputId of impact.inputIds) {
    const oldVersion = fusion.adoptedInputs.find((i) => i.inputId === inputId)!.version;
    const prior = fusion.inputs.find((i) => i.inputId === inputId && i.version === oldVersion)!;
    const aggregate = inputId === "implementation-material";
    const replacement = inputId.startsWith("dataset:") ? prepared?.dataset : prepared?.source;
    const available = aggregate ? evidence.datasets.length > 0 : request.kind === "replace";
    fusion = setResearchInput(fusion, {
      ...prior,
      version:
        Math.max(...fusion.inputs.filter((i) => i.inputId === inputId).map((i) => i.version)) + 1,
      availability: available ? "available" : "withdrawn",
      actual: available,
      digest: aggregate
        ? hash(evidence.datasets.map((d) => d.sha256))
        : request.kind === "replace"
          ? replacement!.sha256
          : hash({ withdrawn: inputId, changeId: commit.changeId }),
      sourceRef: aggregate
        ? evidence.datasets.map((d) => d.file).join("; ") || "waiting-for-actual-material"
        : request.kind === "replace"
          ? replacement!.file
          : prior.sourceRef,
    });
    fusion = applyResearchChange(fusion, {
      id: `${prefix}${inputId}`,
      at,
      inputId,
      fromVersion: oldVersion,
      toVersion: fusion.inputs.filter((i) => i.inputId === inputId).at(-1)!.version,
      reason: request.reason,
      authorizedBy: "user",
      authorizationRef,
      additionalTaskIds: impact.directTaskIds,
    });
  }
  next.fusion = fusion;
  if (impact.supersedesExport && next.finalPaper) {
    (next.supersededExports ??= []).push({ files: next.finalPaper, at, reason: request.reason });
    delete next.finalPaper;
  }
  if (impact.requiresDesignReview) next.currentStage = "design";
  if (impact.affectedTaskIds.length && next.status === "completed") next.status = "paused";
  next.updatedAt = at;
  return {
    project: next,
    archivedEvidence: { sources: [structuredClone(source)], datasets: structuredClone(datasets) },
    alreadyApplied: false,
  };
}
