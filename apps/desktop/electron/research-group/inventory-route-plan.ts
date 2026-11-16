import { createHash } from "node:crypto";
import type { ResearchProject } from "../../contracts/research-group";
import { researchDecisionStatus } from "./task-graph";
import {
  FUSION_STAGE_IDS,
  researchExecutionRoute,
  type ResearchEntryInventory,
  type ResearchExecutionRoute,
} from "../../contracts/research-method";

type Stage = (typeof FUSION_STAGE_IDS)[number];
export type ResearchInventoryInput = Pick<
  ResearchProject,
  "entry" | "goal" | "path" | "task" | "importedMaterials" | "evidence" | "fusion"
> & { revision?: number };
export interface ResearchInventoryFileObservation {
  file: string;
  status: "readable" | "missing" | "unreadable";
  /** Hash of bytes actually read by main; never copied from the expected hash. */
  sha256?: string;
}
export interface ResearchInventoryFileCheck {
  file: string;
  kind: "original" | "parsed" | "source" | "dataset";
  ownerId: string;
  expectedSha256?: string;
}
export interface ResearchInventoryItem {
  id: string;
  kind: "candidate" | "source" | "dataset" | "accepted-stage" | "manuscript";
  reason: string;
  evidenceRefs: string[];
}
export interface ResearchInventoryMissing {
  kind:
    | "materials"
    | "adoption"
    | "manuscript"
    | "research-source"
    | "implementation-data"
    | "file-check"
    | "task-scope";
  stage: Stage;
  blocksStart: boolean;
  reason: string;
}
export interface ResearchInventoryRoutePlan {
  status: "not-required" | "waiting-material" | "pending-checks" | "needs-adoption" | "ready";
  canStart: boolean;
  goalSatisfied: boolean;
  route: ResearchExecutionRoute;
  inventory?: ResearchEntryInventory;
  requiredChecks: ResearchInventoryFileCheck[];
  reusable: ResearchInventoryItem[];
  pending: ResearchInventoryItem[];
  missing: ResearchInventoryMissing[];
  nextStage: Stage;
  limitations: string[];
}

/** Pure plan only: main performs the returned file checks and persists any resulting route decision. */
export function planResearchEntryInventory(
  input: ResearchInventoryInput,
  observations: readonly ResearchInventoryFileObservation[] = [],
): ResearchInventoryRoutePlan {
  const requested = researchExecutionRoute(input);
  const checks: ResearchInventoryFileCheck[] = [];
  const reusable: ResearchInventoryItem[] = [],
    pending: ResearchInventoryItem[] = [];
  const missing: ResearchInventoryMissing[] = [];
  const limitations = [
    "文件登记、解析、实际模型读取和内容支持判断分别记录；本清点不代表已读全文或学术接受。",
    "候选材料不自动成为已采用证据；跳过的导航阶段不生成历史执行或接受记录。",
  ];
  const check = (item: ResearchInventoryFileCheck): boolean => {
    checks.push(item);
    const observation = observations.filter((seen) => seen.file === item.file).at(-1);
    return (
      !!observation &&
      observation.status === "readable" &&
      (!item.expectedSha256 || observation.sha256 === item.expectedSha256)
    );
  };
  const checkedCandidates = new Set<string>(),
    manuscripts = new Set<string>();
  for (const candidate of input.importedMaterials ?? []) {
    const originalOk = check({
      file: candidate.original,
      kind: "original",
      ownerId: candidate.id,
      expectedSha256: candidate.sha256,
    });
    const parsedOk = check({ file: candidate.parsed, kind: "parsed", ownerId: candidate.id });
    const readable =
      ["ready", "partial"].includes(candidate.status) &&
      candidate.locations.some((location) => location.text.trim());
    const item: ResearchInventoryItem = {
      id: candidate.id,
      kind: "candidate",
      reason: !readable
        ? "解析尚无可用正文；需要恢复解析或补入实际定位文本。"
        : !originalOk || !parsedOk
          ? "原件摘要和解析副本尚待实际读取核对。"
          : "已检查的解析候选；尚未因此取得来源支持或实际分析资格。",
      evidenceRefs: [candidate.original, candidate.parsed],
    };
    pending.push(item);
    if (originalOk && parsedOk && readable) {
      checkedCandidates.add(candidate.id);
      if (candidate.metadata.category === "manuscript") manuscripts.add(candidate.id);
    }
  }
  const sourceIds = new Set<string>(),
    researchSourceIds = new Set<string>(),
    adoptedManuscripts = new Set<string>(),
    adoptedDesigns = new Set<string>();
  for (const source of input.evidence?.sources ?? []) {
    const fileOk = check({
      file: source.file,
      kind: "source",
      ownerId: source.id,
      expectedSha256: source.sha256,
    });
    const linkedOk = !source.materialImportId || checkedCandidates.has(source.materialImportId);
    const item: ResearchInventoryItem = {
      id: source.id,
      kind: "source",
      reason:
        fileOk && linkedOk
          ? "已采用来源文件与锁定摘要相符；阅读深度及支持关系仍需实际任务核验。"
          : "已登记来源尚未核对文件，或关联候选已不可用。",
      evidenceRefs: [source.file],
    };
    if (fileOk && linkedOk) {
      reusable.push(item);
      sourceIds.add(source.id);
      if (source.kind === "paper" || source.kind === "method") researchSourceIds.add(source.id);
      if (source.kind === "manuscript") {
        adoptedManuscripts.add(source.id);
        reusable.push({
          ...item,
          kind: "manuscript",
          reason: "已采用稿件可做有边界审阅；不因此认定支持原文、数据和结果均已核验。",
        });
      }
      if (source.kind === "design") adoptedDesigns.add(source.id);
    } else pending.push(item);
  }
  const datasets = new Set<string>();
  for (const dataset of input.evidence?.datasets ?? []) {
    const fileOk = check({
      file: dataset.file,
      kind: "dataset",
      ownerId: dataset.id,
      expectedSha256: dataset.sha256,
    });
    const ready =
      fileOk &&
      sourceIds.has(dataset.sourceId) &&
      (!dataset.materialImportId || checkedCandidates.has(dataset.materialImportId));
    const item: ResearchInventoryItem = {
      id: dataset.id,
      kind: "dataset",
      reason: ready
        ? "已采用数据和来源可用；与方案一致性、质量及方法适用性仍待分析关口检查。"
        : "数据文件、来源或关联解析尚未核实，不能作为实际分析条件。",
      evidenceRefs: [dataset.file, `source:${dataset.sourceId}`],
    };
    if (ready) {
      datasets.add(dataset.id);
      reusable.push(item);
    } else pending.push(item);
  }
  const accepted = new Set<Stage>();
  const graph = input.fusion;
  if (graph) {
    const valid = (artifactId: string, visiting = new Set<string>()): boolean => {
      if (visiting.has(artifactId)) return false;
      const artifact = graph.artifacts.find((item) => item.id === artifactId);
      const task = artifact && graph.tasks.find((item) => item.id === artifact.taskId);
      if (
        !artifact ||
        !task ||
        artifact.interim ||
        artifact.reviewState !== "accepted" ||
        task.currentArtifactId !== artifact.id ||
        task.inputVersion !== artifact.taskVersion
      )
        return false;
      if (
        artifact.inputRefs.some(
          (ref) =>
            !graph.adoptedInputs.some(
              (current) => current.inputId === ref.inputId && current.version === ref.version,
            ),
        )
      )
        return false;
      if (
        artifact.inputRefs.some((ref) => {
          const current = graph.inputs.find(
            (item) => item.inputId === ref.inputId && item.version === ref.version,
          );
          if (!current) return true;
          if (current.kind === "decision") {
            const request = graph.decisionRequests?.find(
              (item) => item.inputId === ref.inputId && item.version === ref.version,
            );
            return request
              ? researchDecisionStatus(graph, request.id) !== "confirmed"
              : !graph.decisions.some(
                  (decision) =>
                    decision.inputId === ref.inputId &&
                    decision.version === ref.version &&
                    decision.actor === "user" &&
                    (decision.outcome === undefined || decision.outcome === "confirmed"),
                );
          }
          if (current.availability !== "available") return true;
          if (ref.inputId.startsWith("source:")) return !sourceIds.has(ref.inputId.slice(7));
          if (ref.inputId.startsWith("dataset:")) return !datasets.has(ref.inputId.slice(8));
          return ref.inputId === "implementation-material" && !datasets.size;
        })
      )
        return false;
      const next = new Set(visiting).add(artifactId);
      return artifact.dependencyArtifactIds.every((id) => valid(id, next));
    };
    for (const task of graph.tasks) {
      if (
        task.role !== "mentor" ||
        (input.revision !== undefined && !task.id.startsWith(`v${input.revision}:`)) ||
        !FUSION_STAGE_IDS.includes(task.stage as Stage) ||
        !task.currentArtifactId ||
        !valid(task.currentArtifactId)
      )
        continue;
      accepted.add(task.stage as Stage);
      reusable.push({
        id: task.currentArtifactId,
        kind: "accepted-stage",
        reason: `当前 ${task.stage} 成果已经接受且输入版本有效；不会补造其他阶段历史。`,
        evidenceRefs: [`artifact:${task.currentArtifactId}`],
      });
    }
  }
  for (const id of manuscripts) {
    const candidate = input.importedMaterials!.find((item) => item.id === id)!;
    pending.push({
      id,
      kind: "manuscript",
      reason: "明确标记为稿件的解析候选；采用后才会提供给实际阅读工具，不能由候选身份推定已采用。",
      evidenceRefs: [candidate.original, candidate.parsed],
    });
  }
  const hasManuscript =
    adoptedManuscripts.size > 0 || accepted.has("writing") || accepted.has("audit");
  const entryNeedsMaterials =
    input.entry === "materials" || input.entry === "manuscript" || requested.mode === "single-task";
  let firstMissing = requested.startStage;
  if (input.entry === "materials" && requested.mode !== "single-task") {
    const lastAccepted = FUSION_STAGE_IDS.filter((stage) => accepted.has(stage)).at(-1);
    firstMissing = lastAccepted
      ? FUSION_STAGE_IDS[
          Math.min(FUSION_STAGE_IDS.indexOf(lastAccepted) + 1, FUSION_STAGE_IDS.length - 1)
        ]!
      : researchSourceIds.size
        ? "reading"
        : datasets.size || adoptedDesigns.size
          ? "design"
          : adoptedManuscripts.size
            ? "audit"
            : "question";
    if (researchSourceIds.size && !accepted.has("synthesis"))
      limitations.push(
        "可以先阅读已有来源；检索范围、问题与综合充分性仍需内容核查，不把已有文献当作检索或综合已完成。",
      );
    if (datasets.size && !accepted.has("design"))
      limitations.push(
        "仅有数据不能直接分析；先检查问题、方案和数据的适配。缺少早期聊天不要求伪造或机械重跑早期研究。",
      );
  }
  const need = (
    kind: ResearchInventoryMissing["kind"],
    stage: Stage,
    blocksStart: boolean,
    reason: string,
  ) => missing.push({ kind, stage, blocksStart, reason });
  for (const reason of requested.blockedReasons)
    need("task-scope", requested.startStage, true, reason);
  const task = input.task?.kind;
  if (input.entry === "manuscript" || task === "chapter-edit" || task === "manuscript-review") {
    if (!hasManuscript)
      need(
        manuscripts.size ? "adoption" : "manuscript",
        requested.startStage,
        true,
        "请提供并明确标记稿件用途，或选用当前有效的写作成果；仅选择稿件入口、文件名或普通文献不证明已有稿件。",
      );
    if (!researchSourceIds.size)
      need(
        "research-source",
        "audit",
        false,
        "缺少已核实可用的支持原文，只能进行有边界的结构和论证审查，不能宣称引文或结论已全部核验。",
      );
    if ((input.path ?? "quantitative") === "quantitative" && !datasets.size)
      need(
        "implementation-data",
        "analysis",
        false,
        "缺少实际数据，现有稿件的数值结果暂不能复算；不阻止明确标注范围的审阅。",
      );
  } else if (task === "reading" || task === "citations") {
    if (!researchSourceIds.size)
      need(
        "research-source",
        requested.startStage,
        true,
        "请先采用并核对指定来源；候选文件或引用文字不等于已取得可阅读原文。",
      );
  } else if (task === "design-review") {
    if (!adoptedDesigns.size && !adoptedManuscripts.size && !accepted.has("design"))
      need(
        "materials",
        "design",
        true,
        "设计评估需要实际提供的方案文本或当前有效方案；任务名称不代替方案材料。",
      );
    limitations.push("设计评估只核对所提供文本；不把一般方法文献自动认定为已接受方案。");
  } else if (
    input.entry === "materials" &&
    !researchSourceIds.size &&
    !adoptedDesigns.size &&
    !adoptedManuscripts.size &&
    !datasets.size &&
    !accepted.size
  ) {
    need(
      checkedCandidates.size ? "adoption" : checks.length ? "file-check" : "materials",
      firstMissing,
      true,
      checkedCandidates.size
        ? "已有解析候选，先确认用途并采用所需材料后再接续；不会把候选自动当作文献或数据。"
        : checks.length
          ? "已有登记项但尚无核实可用的输入；请核对实际文件、恢复失败解析或补齐缺失材料。"
          : "材料入口尚无实际材料或有效成果，请先导入；不能假称已完成文献、方案或分析。",
    );
  }
  if (
    input.goal === "paper" &&
    (input.path ?? "quantitative") === "quantitative" &&
    !datasets.size &&
    input.entry !== "manuscript"
  ) {
    need(
      "implementation-data",
      "analysis",
      firstMissing === "analysis",
      "实际量化分析等待真实材料、来源和质量核对；方案可先完成，独立文献工作仍可继续。",
    );
  }
  const hasInspectedBasis = reusable.length > 0 || checkedCandidates.size > 0;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        checks,
        observations,
        refs: reusable.map((item) => item.evidenceRefs),
        firstMissing,
      }),
    )
    .digest("hex");
  const inventory: ResearchEntryInventory | undefined = hasInspectedBasis
    ? { firstMissingStage: firstMissing, evidenceRef: `inventory:${fingerprint}` }
    : undefined;
  const route = researchExecutionRoute(input, inventory);
  const blocked = missing.some((item) => item.blocksStart);
  const status: ResearchInventoryRoutePlan["status"] = !entryNeedsMaterials
    ? "not-required"
    : !blocked
      ? "ready"
      : missing.some((item) => item.kind === "adoption")
        ? "needs-adoption"
        : checks.length && !hasInspectedBasis
          ? "pending-checks"
          : "waiting-material";
  return {
    status,
    canStart: !blocked && !route.needsInventory,
    goalSatisfied: accepted.has(route.endStage),
    route,
    ...(inventory ? { inventory } : {}),
    requiredChecks: checks,
    reusable,
    pending,
    missing,
    nextStage: route.startStage,
    limitations,
  };
}
