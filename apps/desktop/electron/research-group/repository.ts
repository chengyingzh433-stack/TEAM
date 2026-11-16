import { createResearchDocx } from "./paper-docx";
import { isCurrentResearchAnalysis } from "./paper-pipeline";
import { validateResearchM3State } from "./m3-validation";
import { validateResearchLanguageProject } from "./language-tools";
import { validateSourcePageProject } from "./source-page-tools";
import { validateResearchSynthesisProject } from "./synthesis-tools";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { decodeResearchAnalysisRegistry } from "./analysis-registry";
import { decodeResearchContentChecks } from "../../contracts/research-content-checks";
import { decodeResearchMethodProjectRecords } from "../../contracts/research-method-packages";
import { decodeResearchMethodProgramChecks } from "../../contracts/research-method-checks";
import { validateResearchLiteratureProject } from "./literature-search-tools";
import { decodeAnalysisReuseRecords } from "./analysis-result-reuse";
import {
  decodeResearchClaims,
  decodeResearchClaimActualRead,
} from "../../contracts/research-claims";
import { registeredAnalysisProjectionIntact } from "./analysis-registry-state";
import {
  decodeResearchNumericBindings,
  decodeResearchNumericCandidateReviews,
  decodeResearchResultFieldMetadata,
} from "../../contracts/research-numeric-bindings";
import { decodeResearchMethodConfig } from "../../contracts/research-method";
import { snapshotSharedResearchMethod } from "../../contracts/shared-research-method";
import { decodeResearchTaskGraph } from "../../contracts/research-task-graph";
import { decodeImportedResearchMaterials } from "../../contracts/research-materials";
import { decodeResearchInputHistory } from "../../contracts/research-input-history";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchLegacyMigrationRecord } from "../../contracts/research-legacy-migration";
import {
  RESEARCH_ROLES,
  isResearchStageId,
  decodeResearchAction,
  decodeResearchStages,
  type ResearchGroupsState,
  type ResearchProject,
  type ResearchArtifact,
} from "../../contracts/research-group";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";

export function decodeResearchState(value: unknown): ResearchGroupsState {
  const s = value as ResearchGroupsState;
  if (
    !s ||
    s.version !== 1 ||
    typeof s.config?.knowledgeDir !== "string" ||
    !Array.isArray(s.projects)
  )
    throw new Error("课题组保存文件无效，原文件已保留。");
  if (s.config.knowledgeDir) decodeResearchAction({ kind: "configure", config: s.config });
  for (const p of s.projects) {
    if (
      !p ||
      !/^[a-f0-9-]{36}$/.test(p.id) ||
      typeof p.root?.sessionId !== "string" ||
      typeof p.root.workspaceId !== "string" ||
      typeof p.workspacePath !== "string" ||
      typeof p.objective !== "string" ||
      !Number.isInteger(p.revision) ||
      !["running", "paused", "needs-decision", "completed"].includes(p.status) ||
      typeof p.knowledge?.sha256 !== "string" ||
      typeof p.knowledge.directory !== "string" ||
      !Array.isArray(p.members) ||
      !Array.isArray(p.artifacts) ||
      !Array.isArray(p.events) ||
      !Array.isArray(p.packets)
    )
      throw new Error("课题组项目记录无效，原文件已保留。");
    decodeResearchMethodConfig(p);
    if (p.inputHistory !== undefined) {
      const history = decodeResearchInputHistory(p.inputHistory);
      if (
        history.some(
          (entry) =>
            entry.revision > p.revision ||
            (entry.source.kind === "existing-migration" &&
              (entry.source.migrationId !== p.legacyMigration?.id ||
                entry.source.recordFile !== p.legacyMigration.recordFile)),
        )
      )
        throw new Error("用户输入上下文与项目版本或迁移出处不一致。");
    }
    if (
      p.legacyMigration !== undefined &&
      (!p.legacyMigration ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(p.legacyMigration.id) ||
        !/^[a-f0-9-]{36}$/.test(p.legacyMigration.sourceProjectId) ||
        p.legacyMigration.sourceProjectId === p.id ||
        typeof p.legacyMigration.recordFile !== "string" ||
        !p.legacyMigration.recordFile.trim() ||
        p.workflowVersion !== "fusion-v2")
    )
      throw new Error("旧项目迁移来源记录无效，原项目保留。");
    if (
      p.sharedMethod !== undefined &&
      snapshotSharedResearchMethod(p.sharedMethod).version !== p.methodVersion
    )
      throw new Error("共享规则快照与课题方法版本不一致，原记录保留。");
    if (p.fusion !== undefined) {
      decodeResearchTaskGraph(p.fusion);
      if (
        p.fusion.projectId !== p.id ||
        p.workflowVersion !== "fusion-v2" ||
        p.fusion.methodVersion !== p.methodVersion
      )
        throw new Error("研究任务图与项目身份或流程不符。");
    }
    if (p.importedMaterials !== undefined) decodeImportedResearchMaterials(p.importedMaterials);
    if (p.analysisRegistry !== undefined) decodeResearchAnalysisRegistry(p.analysisRegistry);
    decodeAnalysisReuseRecords(
      {
        analysisRunAdoptions: p.analysisRunAdoptions,
        analysisReads: p.analysisReads,
        analysisReviewContexts: p.analysisReviewContexts,
      },
      p,
    );
    if (p.contentChecks !== undefined) decodeResearchContentChecks(p.contentChecks);
    validateResearchLiteratureProject(p);
    validateResearchLanguageProject(p);
    validateSourcePageProject(p);
    validateResearchSynthesisProject(p);
    for (const operation of p.literatureToolOperations ?? []) {
      const scope = operation.scope;
      const task = p.fusion?.tasks.find((entry) => entry.id === scope.taskId);
      const attempt = p.fusion?.attempts.find((entry) => entry.id === scope.attemptId);
      if (
        scope.projectId !== p.id ||
        scope.revision > p.revision ||
        !task ||
        !attempt ||
        task.role !== scope.role ||
        task.stage !== scope.stage ||
        scope.taskVersion > task.inputVersion ||
        attempt.taskId !== task.id ||
        attempt.taskVersion !== scope.taskVersion ||
        attempt.nativeRunId !== scope.nativeRunId ||
        attempt.model?.provider !== scope.model.provider ||
        attempt.model.modelId !== scope.model.modelId ||
        scope.inputs.some(
          (ref) =>
            !p.fusion!.inputs.some(
              (input) =>
                input.inputId === ref.inputId &&
                input.version === ref.version &&
                input.digest === ref.digest,
            ),
        )
      )
        throw new Error("文献操作与实际项目、任务或原生身份不符，原记录保留。");
    }
    const methods = decodeResearchMethodProjectRecords({
      methodPackages: p.methodPackages,
      methodPackageUses: p.methodPackageUses,
      methodApplications: p.methodApplications,
      methodImageReadings: p.methodImageReadings,
      methodImageReceipts: p.methodImageReceipts,
      methodContentOpinions: p.methodContentOpinions,
      methodAdjudications: p.methodAdjudications,
    });
    for (const row of [
      ...(methods.methodPackageUses ?? []),
      ...(methods.methodApplications ?? []),
      ...(methods.methodImageReadings ?? []),
      ...(methods.methodImageReceipts ?? []),
      ...(methods.methodContentOpinions ?? []),
      ...(methods.methodAdjudications ?? []),
    ]) {
      if (row.projectId !== p.id || !p.fusion?.tasks.some((task) => task.id === row.taskId))
        throw new Error("方法记录与项目或实际任务不符，原记录保留。");
      if ("actor" in row) {
        if (row.actor.kind !== "model" || !row.actor.evidenceRef.startsWith("host-method:"))
          throw new Error("当前方法记录缺少具名模型的实际执行来源，原记录保留。");
        let origin: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(row.actor.evidenceRef.slice("host-method:".length));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          origin = parsed as Record<string, unknown>;
        } catch {
          throw new Error("方法内容记录的执行来源无效，原记录保留。");
        }
        const task = p.fusion.tasks.find((task) => task.id === origin.taskId);
        const scopedTask = p.fusion.tasks.find((task) => task.id === row.taskId)!;
        const attempt = p.fusion.attempts.find((attempt) => attempt.id === origin.attemptId);
        if (
          !task ||
          !attempt ||
          attempt.taskId !== task.id ||
          attempt.taskVersion !== origin.taskVersion ||
          attempt.nativeRunId !== origin.nativeRunId ||
          !isDeepStrictEqual(attempt.model, origin.model) ||
          row.actor.id !== `model:${task.role}` ||
          typeof origin.sessionId !== "string" ||
          !origin.sessionId.trim() ||
          typeof origin.callId !== "string" ||
          !origin.callId.trim() ||
          task.stage !== scopedTask.stage ||
          task.id.split(":")[0] !== scopedTask.id.split(":")[0] ||
          (!("applicationId" in row) && task.id !== row.taskId) ||
          ("role" in row && row.role !== task.role)
        )
          throw new Error("方法内容记录与实际角色、阶段或原生执行不符，原记录保留。");
      }
      if ("attemptId" in row) {
        const task = p.fusion.tasks.find((task) => task.id === row.taskId)!;
        const attempt = p.fusion.attempts.find((attempt) => attempt.id === row.attemptId);
        if (
          !attempt ||
          attempt.taskId !== row.taskId ||
          attempt.taskVersion !== row.taskInputVersion ||
          attempt.nativeRunId !== row.nativeRunId ||
          row.taskInputVersion > task.inputVersion ||
          ("role" in row && row.role !== task.role) ||
          !isDeepStrictEqual(attempt.model, row.model)
        )
          throw new Error("方法采用或图像传送缺少同版实际原生执行，原记录保留。");
      }
    }
    if (p.methodProgramChecks !== undefined) {
      const checks = decodeResearchMethodProgramChecks(p.methodProgramChecks);
      for (const check of checks) {
        const task = p.fusion?.tasks.find((entry) => entry.id === check.taskId);
        const attempt = p.fusion?.attempts.find((entry) => entry.id === check.attemptId);
        if (
          (check.result === "passed-at-snapshot" && (!task || !attempt)) ||
          (task && (task.role !== check.role || task.stage !== check.stage)) ||
          (attempt &&
            (!task ||
              attempt.taskId !== task.id ||
              attempt.taskVersion !== check.taskInputVersion ||
              attempt.nativeRunId !== check.nativeRunId ||
              (check.taskInputVersion ?? 0) > task.inputVersion ||
              !isDeepStrictEqual(attempt.model, check.model))) ||
          (check.target &&
            !p.artifacts.some((artifact) => artifact.id === check.target!.artifactId)) ||
          check.packages.some(
            (entry) =>
              !p.methodPackages?.some(
                (pkg) => pkg.id === entry.packageId && pkg.packageSha256 === entry.packageSha256,
              ),
          )
        )
          throw new Error("方法程序检查与实际任务、模型或方法包不符，原记录保留。");
      }
    }
    if (p.claims !== undefined) decodeResearchClaims(p.claims);
    if (p.sourceReads !== undefined) {
      if (
        !Array.isArray(p.sourceReads) ||
        new Set(p.sourceReads.map((entry) => entry?.id)).size !== p.sourceReads.length
      )
        throw new Error("原文实际读取凭据无效，原记录保留。");
      p.sourceReads.forEach((entry) => decodeResearchClaimActualRead(entry));
    }
    if (p.numericBindings !== undefined) decodeResearchNumericBindings(p.numericBindings);
    if (p.numericFieldMetadata !== undefined)
      decodeResearchResultFieldMetadata(p.numericFieldMetadata);
    if (p.numericCandidateReviews !== undefined)
      decodeResearchNumericCandidateReviews(p.numericCandidateReviews);
    if (
      p.activeAnalysisPlans !== undefined &&
      (!Array.isArray(p.activeAnalysisPlans) ||
        new Set(p.activeAnalysisPlans.map((ref) => ref?.id)).size !==
          p.activeAnalysisPlans.length ||
        p.activeAnalysisPlans.some(
          (ref) =>
            !ref ||
            typeof ref.id !== "string" ||
            !Number.isSafeInteger(ref.version) ||
            !p.analysisRegistry?.plans.some(
              (plan) => plan.id === ref.id && plan.version === ref.version,
            ),
        ))
    )
      throw new Error("本轮采用的分析计划引用无效，原记录保留。");
    if (p.entryInventory !== undefined) {
      const inventory = p.entryInventory;
      if (
        !inventory ||
        !Number.isSafeInteger(inventory.revision) ||
        inventory.revision < 0 ||
        typeof inventory.checkedAt !== "string" ||
        !Number.isFinite(Date.parse(inventory.checkedAt)) ||
        typeof inventory.canStart !== "boolean" ||
        !isResearchStageId(inventory.firstMissingStage) ||
        typeof inventory.evidenceRef !== "string" ||
        !inventory.evidenceRef.trim() ||
        [inventory.reusable, inventory.pending, inventory.missing, inventory.limitations].some(
          (items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"),
        )
      )
        throw new Error("材料清点记录无效，原文件保留。");
    }
    if (
      p.materialHistory !== undefined &&
      (!Array.isArray(p.materialHistory) ||
        p.materialHistory.some(
          (entry) =>
            !entry ||
            typeof entry.changeId !== "string" ||
            !entry.changeId ||
            typeof entry.at !== "string" ||
            !entry.evidence ||
            !Array.isArray(entry.evidence.sources) ||
            !Array.isArray(entry.evidence.datasets) ||
            [...entry.evidence.sources, ...entry.evidence.datasets].some(
              (item) =>
                !item ||
                typeof item.id !== "string" ||
                typeof item.file !== "string" ||
                !/^[a-f0-9]{64}$/.test(item.sha256),
            ),
        ))
    )
      throw new Error("材料变更历史无效，原文件保留。");
    if (
      p.supersededExports !== undefined &&
      (!Array.isArray(p.supersededExports) ||
        p.supersededExports.some(
          (item) =>
            !item ||
            typeof item.at !== "string" ||
            typeof item.reason !== "string" ||
            !item.files ||
            ![item.files.markdown, item.files.html, item.files.provenance].every(
              (file) => typeof file === "string" && file.length > 0,
            ),
        ))
    )
      throw new Error("历史导出记录无效，原文件保留。");
    for (const receipt of [...(p.archives ?? []), ...(p.archiveOrigin ? [p.archiveOrigin] : [])]) {
      if (
        !receipt ||
        typeof receipt.directory !== "string" ||
        !receipt.directory ||
        !/^[a-f0-9]{64}$/.test(receipt.manifestSha256) ||
        !/^[a-f0-9-]{36}$/.test(receipt.sourceProjectId) ||
        !Number.isSafeInteger(receipt.revision) ||
        receipt.revision < 0
      )
        throw new Error("归档交付记录无效，原文件保留。");
    }
    const validFiles = (files: NonNullable<ResearchProject["finalPaper"]>) =>
      !!files &&
      [files.markdown, files.html, files.provenance].every(
        (file) => typeof file === "string" && !!file,
      ) &&
      (files.docx === undefined || (typeof files.docx === "string" && !!files.docx));
    if (
      (p.finalPaper !== undefined && !validFiles(p.finalPaper)) ||
      p.supersededExports?.some((item) => !validFiles(item.files)) ||
      (p.reviewPapers !== undefined &&
        (!Array.isArray(p.reviewPapers) ||
          p.reviewPapers.some(
            (item) =>
              !item ||
              typeof item.manuscriptId !== "string" ||
              !item.manuscriptId ||
              !Number.isSafeInteger(item.revision) ||
              item.revision < 0 ||
              !validFiles(item.files),
          )))
    )
      throw new Error("稿件交付记录无效，原文件保留。");
    if (p.stages !== undefined) decodeResearchStages(p.stages, p.workflowVersion);
    if (p.scope !== undefined && !["proposal", "paper"].includes(p.scope))
      throw new Error("研究范围记录无效。");
    if (p.currentStage !== undefined && !isResearchStageId(p.currentStage))
      throw new Error("研究阶段记录无效。");
    if (
      p.evidence &&
      (!Array.isArray(p.evidence.sources) ||
        !Array.isArray(p.evidence.datasets) ||
        p.evidence.sources.some(
          (s) =>
            !s.id ||
            typeof s.file !== "string" ||
            !/^[a-f0-9]{64}$/.test(s.sha256) ||
            (s.textScope !== undefined &&
              !["metadata", "abstract", "partial-text", "full-text"].includes(s.textScope)),
        ) ||
        p.evidence.datasets.some(
          (d) => !d.id || typeof d.file !== "string" || !/^[a-f0-9]{64}$/.test(d.sha256),
        ))
    )
      throw new Error("研究材料记录无效，原文件保留。");
    if (
      p.analyses &&
      (!Array.isArray(p.analyses) ||
        p.analyses.some(
          (a) =>
            !a.id ||
            !Number.isInteger(a.revision) ||
            !a.spec ||
            typeof a.result !== "object" ||
            !/^[a-f0-9]{64}$/.test(a.sha256),
        ))
    )
      throw new Error("分析记录无效，原文件保留。");
    if (p.analyses?.some((run) => !registeredAnalysisProjectionIntact(p, run)))
      throw new Error("登记分析投影与实际运行内容不一致，原文件保留。");
    if (
      p.members.length !== 4 ||
      new Set(p.members.map((m) => m.role)).size !== 4 ||
      p.members.some(
        (m) =>
          !RESEARCH_ROLES.includes(m.role) ||
          typeof m.ref?.sessionId !== "string" ||
          typeof m.ref.workspaceId !== "string",
      )
    )
      throw new Error("课题组成员记录无效。");
    const ids = new Set(p.artifacts.map((a) => a.id));
    const referenceIds = new Set([
      ...ids,
      ...(p.m3?.specialists?.flatMap((s) => [
        ...(s.initialOpinion ? [s.initialOpinion.id] : []),
        ...(s.followups ?? []).map((o) => o.id),
      ]) ?? []),
    ]);
    if (
      ids.size !== p.artifacts.length ||
      p.artifacts.some(
        (a) =>
          !/^[a-f0-9-]{36}$/.test(a.id) ||
          !RESEARCH_ROLES.includes(a.role) ||
          typeof a.content !== "string" ||
          !Array.isArray(a.refs) ||
          a.refs.some((id) => !referenceIds.has(id)),
      )
    )
      throw new Error("课题组成果或交接引用无效。");
    if (
      p.events.some((e) => typeof e.at !== "string" || typeof e.detail !== "string") ||
      p.packets.some((k) => !Array.isArray(k.records) || !Array.isArray(k.ids))
    )
      throw new Error("课题组证据记录无效。");
  }
  validateResearchM3State(s);
  return structuredClone(s);
}

export class ResearchRepository {
  /** Backup may predate a dispatched request; coordinator must not resume it as current truth. */
  recoveredFromBackup = false;
  private readonly path: string;
  private readonly migrationDirectory: string;
  constructor(userDataDir: string) {
    this.path = join(userDataDir, "research-groups.json");
    this.migrationDirectory = join(userDataDir, "research-migrations");
  }
  legacyMigrationRecordFile(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("无效迁移身份。");
    return join(this.migrationDirectory, `${id}.json`);
  }
  async loadLegacyMigration(id: string): Promise<ResearchLegacyMigrationRecord | undefined> {
    const result = await readJsonWithBackup(this.legacyMigrationRecordFile(id));
    if (result.corrupted && !result.recovered)
      throw new Error("迁移恢复文件已损坏，请保留原项目并恢复有效快照。");
    if (result.value === undefined) return undefined;
    const { decodeLegacyResearchMigrationRecord } = await import("./legacy-migration.js");
    const record = decodeLegacyResearchMigrationRecord(result.value);
    if (
      record.id !== id ||
      record.createdProject.legacyMigration?.recordFile !== this.legacyMigrationRecordFile(id)
    )
      throw new Error("迁移恢复文件身份或位置不一致。");
    return record;
  }
  async saveLegacyMigration(record: ResearchLegacyMigrationRecord): Promise<string> {
    const { decodeLegacyResearchMigrationRecord } = await import("./legacy-migration.js");
    const checked = decodeLegacyResearchMigrationRecord(record);
    const file = this.legacyMigrationRecordFile(checked.id);
    if (checked.createdProject.legacyMigration?.recordFile !== file)
      throw new Error("迁移恢复路径不一致。");
    const prior = await this.loadLegacyMigration(checked.id);
    if (prior) {
      if (prior.recordSha256 !== checked.recordSha256) throw new Error("已有迁移快照不可覆盖。");
      return file;
    }
    await writeFileAtomicQueued(file, JSON.stringify(checked, null, 2) + "\n", (value) => {
      const existing = decodeLegacyResearchMigrationRecord(value);
      if (existing.recordSha256 !== checked.recordSha256) throw new Error("已有迁移快照不可覆盖。");
      return existing;
    });
    return file;
  }
  async load(): Promise<ResearchGroupsState> {
    const r = await readJsonWithBackup(this.path);
    this.recoveredFromBackup = r.recovered;
    if (r.corrupted && !r.recovered)
      throw new Error("课题组文件损坏；未覆盖文件，请恢复有效备份。");
    return r.value === undefined
      ? { version: 1, config: { knowledgeDir: "" }, projects: [] }
      : decodeResearchState(r.value);
  }
  async save(state: ResearchGroupsState): Promise<void> {
    decodeResearchState(state);
    await writeFileAtomicQueued(
      this.path,
      JSON.stringify(state, null, 2) + "\n",
      decodeResearchState,
    );
  }
  async writeArtifact(project: ResearchProject, artifact: ResearchArtifact): Promise<void> {
    const dir = join(project.workspacePath, ".lancer", "research-groups", project.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${artifact.id}.md`),
      `# ${artifact.kind} · ${artifact.role}\n\n课题：${project.objective}\n\n输入版本：${artifact.revision}；轮次：${artifact.round}；时间：${artifact.createdAt}\n\n阶段：${artifact.stage ?? "未记录"}；实际模型：${artifact.model ? `${artifact.model.provider}/${artifact.model.modelId} · ${artifact.model.thinkingLevel ?? "会话默认"}` : "未记录"}\n\n引用：${artifact.refs.join(", ") || "无"}\n\n${artifact.content}\n`,
      { flag: "wx" },
    );
  }
  async writeFinalPaper(
    projectValue: ResearchProject,
    manuscriptValue: ResearchArtifact,
    deliveryStatus: "accepted" | "review" = "accepted",
  ): Promise<NonNullable<ResearchProject["finalPaper"]>> {
    // Pin every exported byte before the first IO yield. Callers can advance their live project.
    const project = structuredClone(projectValue);
    const manuscript = structuredClone(manuscriptValue);
    if (
      !manuscript ||
      (deliveryStatus === "accepted" && manuscript.stage !== "audit") ||
      !["stage-revision", "stage-draft"].includes(manuscript.kind) ||
      manuscript.revision !== project.revision ||
      !project.artifacts.some((artifact) => isDeepStrictEqual(artifact, manuscript))
    )
      throw new Error("缺少同版全文审阅阶段的完整终稿。");
    const directoryPrefix = join(
      project.workspacePath,
      ".lancer",
      "research-groups",
      project.id,
      `${deliveryStatus === "review" ? "review" : "paper"}-v${project.revision}-${manuscript.id}`,
    );
    await mkdir(join(directoryPrefix, ".."), { recursive: true });
    const directory = await mkdtemp(directoryPrefix + "-");
    const basename = deliveryStatus === "review" ? "论文审阅稿" : "论文终稿";
    const files = {
      docx: join(directory, `${basename}.docx`),
      markdown: join(directory, `${basename}.md`),
      html: join(directory, `${basename}.html`),
      provenance: join(directory, "研究溯源.json"),
    };
    const sources =
      project.evidence?.sources.filter((s) => manuscript.sourceIds?.includes(s.id)) ?? [];
    const analyses = project.analyses?.filter((a) => isCurrentResearchAnalysis(project, a)) ?? [];
    const docx = createResearchDocx(project, manuscript, deliveryStatus);
    const provenance = {
      deliveryStatus,
      docxSha256: createHash("sha256").update(docx).digest("hex"),
      format: "lancer-research-provenance/2",
      projectId: project.id,
      revision: project.revision,
      manuscriptId: manuscript.id,
      path: project.path ?? "quantitative",
      manuscriptSha256: createHash("sha256").update(manuscript.content).digest("hex"),
      scope: project.scope,
      datasets: project.evidence?.datasets,
      sources,
      analyses,
      analysisRegistry: project.analysisRegistry,
      activeAnalysisPlans: project.activeAnalysisPlans,
      analysisRunAdoptions: project.analysisRunAdoptions,
      analysisReads: project.analysisReads,
      analysisReviewContexts: project.analysisReviewContexts,
      numericBindings: project.numericBindings,
      numericFieldMetadata: project.numericFieldMetadata,
      numericCandidateReviews: project.numericCandidateReviews,
      claims: project.claims,
      sourceReads: project.sourceReads,
      contentChecks: project.contentChecks,
      methodPackages: project.methodPackages,
      methodPackageUses: project.methodPackageUses,
      methodApplications: project.methodApplications,
      methodImageReceipts: project.methodImageReceipts,
      methodImageReadings: project.methodImageReadings,
      methodContentOpinions: project.methodContentOpinions,
      methodAdjudications: project.methodAdjudications,
      methodProgramChecks: project.methodProgramChecks,
      literatureSearch: project.literatureSearch,
      literatureToolOperations: project.literatureToolOperations,
      literatureRecordReads: project.literatureRecordReads,
      languageScopes: project.languageScopes,
      languageRevisions: project.languageRevisions,
      languageReads: project.languageReads,
      languageDispositions: project.languageDispositions,
      sourcePageReceipts: project.sourcePageReceipts,
      sourcePageReadings: project.sourcePageReadings,
      synthesis: project.synthesis,
      m3: project.m3,
      readEvents: project.events.filter(
        (e) =>
          ["source-read", "analysis", "read"].includes(e.type) && e.revision === project.revision,
      ),
      reviews: project.artifacts.filter(
        (a) =>
          a.revision === project.revision &&
          ["review", "stage-review", "stage-verification"].includes(a.kind),
      ),
      notice: "由多模型课题组辅助完成的研究稿。审阅通过不代替作者核验、研究许可或发表审查。",
    };
    const escape = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const toc: { id: string; text: string }[] = [];
    let index = 0;
    const lines = manuscript.content.split(/\r?\n/),
      html: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!,
        heading = line.match(/^(#{1,3})\s+(.+)/);
      if (heading) {
        const id = `section-${++index}`;
        toc.push({ id, text: heading[2]! });
        html.push(
          `<h${heading[1]!.length} id="${id}">${escape(heading[2]!)}</h${heading[1]!.length}>`,
        );
      } else if (line.trim().startsWith("|")) {
        const rows: string[] = [];
        while (i < lines.length && lines[i]!.trim().startsWith("|")) {
          const current = lines[i++]!;
          if (!/^\s*\|[\s|:\-]+\|\s*$/.test(current))
            rows.push(
              `<tr>${current
                .trim()
                .replace(/^\||\|$/g, "")
                .split("|")
                .map((cell) => `<td>${escape(cell.trim())}</td>`)
                .join("")}</tr>`,
            );
        }
        i--;
        html.push(`<div class="table"><table>${rows.join("")}</table></div>`);
      } else if (line.trim()) html.push(`<p>${escape(line)}</p>`);
    }
    const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>教育研究论文终稿</title><style>body{margin:auto;max-width:1100px;padding:32px;color:#222;font:16px/1.85 system-ui,sans-serif;background:#faf9f5}nav{padding:16px;background:#fff;border:1px solid #ddd}article{margin-top:24px;padding:32px;background:white}h1,h2,h3{line-height:1.4;scroll-margin-top:20px}p{white-space:pre-wrap;overflow-wrap:anywhere}.table{overflow:auto}table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:8px}a{color:#215d8a}@media(max-width:650px){body{padding:12px}article{padding:16px}}@media print{nav{display:none}body,article{padding:0;background:white}}</style><nav><b>论文目录</b><ol>${toc.map((t) => `<li><a href="#${t.id}">${escape(t.text)}</a></li>`).join("")}</ol></nav><article><p>${deliveryStatus === "review" ? "审阅稿 · 待核验，尚未作为本轮接受稿交付" : "本轮接受稿"}；输入版本 ${project.revision}；稿件 ${escape(manuscript.id)}</p>${html.join("\n")}<h2>来源与复现记录</h2><ul>${sources.map((s) => `<li>[SRC:${escape(s.id)}] ${escape(s.authors)} (${escape(s.year)}). ${escape(s.title)}. ${/^https?:\/\//.test(s.url) ? `<a href="${escape(s.url)}">原始来源</a>` : escape(s.url)}</li>`).join("")}</ul><p>项目 ${escape(project.id)}，输入版本 ${project.revision}。${(project.path ?? "quantitative") === "quantitative" ? "分析程序、数据副本与参数见项目的 analysis 文件夹；" : "本稿采用非数值路径，固定文本片段与分析记录见研究溯源；"}完整来源、摘要、读取记录与审阅链见研究溯源.json。</p></article></html>`;
    await writeFile(files.markdown, manuscript.content + "\n", { flag: "wx" });
    await writeFile(files.html, body, { flag: "wx" });
    await writeFile(files.docx, docx, { flag: "wx" });
    await writeFile(files.provenance, JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
    return files;
  }
  async exportProject(project: ResearchProject): Promise<void> {
    const dir = join(project.workspacePath, ".lancer", "research-groups", project.id);
    await mkdir(dir, { recursive: true });
    await writeFileAtomicQueued(
      join(dir, "project.json"),
      JSON.stringify(project, null, 2) + "\n",
      (value) => {
        if (!value || typeof value !== "object" || !("id" in value) || value.id !== project.id)
          throw new Error("项目导出文件无效。");
        return value;
      },
    );
  }
}
