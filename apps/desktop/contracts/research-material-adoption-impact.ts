import type { ResearchProject } from "./research-group";
import type { MaterialAdoptionDeclaration } from "./research-materials";

export interface ResearchMaterialAdoptionImpact {
  /** Stable serialized impact state, not a signature or a claim that files were checked. */
  token: string;
  directTaskIds: string[];
  affectedTaskIds: string[];
  affectedArtifactIds: string[];
  reusableTaskIds: string[];
  reusableArtifactIds: string[];
  historicalAffectedTaskIds: string[];
  requiresDesignReview: boolean;
  supersedesExport: boolean;
  reason: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

/** Mirrors additive adoption: a new text source does not replace any existing source identity. */
export function projectResearchMaterialAdoptionImpact(
  project: ResearchProject,
  category: MaterialAdoptionDeclaration["category"],
): ResearchMaterialAdoptionImpact {
  const graph = project.fusion;
  const current = (id: string) => id.startsWith(`v${project.revision}:`);
  const data = category === "data" && project.workflowVersion === "fusion-v2";
  // Adoption allocates a fresh dataset identity, so it cannot already be the frozen plan's dataset.
  const requiresDesignReview =
    data && ["design", "analysis", "writing", "audit"].includes(project.currentStage ?? "");
  const changedInputIds = data
    ? ["implementation-material", ...(requiresDesignReview ? ["design-material-fit"] : [])]
    : [];
  const hasImplementation = !!graph?.inputs.some(
    (input) => input.inputId === "implementation-material",
  );
  const direct = new Set(
    (graph?.tasks ?? [])
      .filter(
        (task) =>
          task.inputs.some((input) => changedInputIds.includes(input.inputId)) ||
          (current(task.id) &&
            (requiresDesignReview
              ? ["design", "analysis", "writing", "audit"].includes(task.stage)
              : data &&
                hasImplementation &&
                ["analysis", "writing", "audit"].includes(task.stage))),
      )
      .map((task) => task.id),
  );
  const affected = new Set(direct);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of graph?.tasks ?? []) {
      if (
        !affected.has(task.id) &&
        task.dependencies.some((dependency) => affected.has(dependency.taskId))
      ) {
        affected.add(task.id);
        grew = true;
      }
    }
  }
  const tasks = graph?.tasks.filter((task) => current(task.id)) ?? [];
  const affectedTasks = tasks.filter((task) => affected.has(task.id));
  const reusableTasks = tasks.filter((task) => !affected.has(task.id));
  const token = JSON.stringify(
    stable({
      category,
      projectId: project.id,
      revision: project.revision,
      workflowVersion: project.workflowVersion,
      currentStage: project.currentStage,
      status: project.status,
      objective: project.objective,
      methodVersion: project.methodVersion,
      sharedMethod: project.sharedMethod,
      path: project.path,
      analysisPlan: project.analysisPlan,
      finalPaper: project.finalPaper,
      evidence: project.evidence,
      materials: project.importedMaterials?.map(({ id, sha256, original, parsed, status }) => ({
        id,
        sha256,
        original,
        parsed,
        status,
      })),
      inputs: graph?.inputs,
      adoptedInputs: graph?.adoptedInputs,
      tasks: graph?.tasks,
      attempts: graph?.attempts.map(({ id, taskId, taskVersion, state }) => ({
        id,
        taskId,
        taskVersion,
        state,
      })),
      artifacts: graph?.artifacts.map(
        ({ id, taskId, taskVersion, reviewState, inputRefs, dependencyArtifactIds }) => ({
          id,
          taskId,
          taskVersion,
          reviewState,
          inputRefs,
          dependencyArtifactIds,
        }),
      ),
    }),
  );
  return {
    token,
    directTaskIds: tasks.filter((task) => direct.has(task.id)).map((task) => task.id),
    affectedTaskIds: affectedTasks.map((task) => task.id),
    affectedArtifactIds: affectedTasks.flatMap((task) =>
      task.currentArtifactId ? [task.currentArtifactId] : [],
    ),
    reusableTaskIds: reusableTasks.map((task) => task.id),
    reusableArtifactIds: reusableTasks.flatMap((task) =>
      task.currentArtifactId ? [task.currentArtifactId] : [],
    ),
    historicalAffectedTaskIds: (graph?.tasks ?? [])
      .filter((task) => !current(task.id) && affected.has(task.id))
      .map((task) => task.id),
    requiresDesignReview,
    supersedesExport: requiresDesignReview && !!project.finalPaper,
    reason: requiresDesignReview
      ? "新增数据将从设计适配复核继续，并重审相关分析、写作与终审；原分析计划和历史成果保留。"
      : data
        ? "新增数据更新实际材料条件；已存在的分析及其下游任务按依赖重审，不自动重新裁定研究问题。"
        : "新增可读来源，不替换原采用身份，不自动使旧成果失效；实际阅读和支持判断另行记录。",
  };
}
