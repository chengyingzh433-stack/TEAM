import { randomUUID } from "node:crypto";
import { decodeResearchPathRecord } from "../../contracts/research-m3";
import type { ResearchPathRecord } from "../../contracts/research-m3";
import type {
  ResearchArtifact,
  ResearchProject,
  ResearchRole,
} from "../../contracts/research-group";
import { readPinnedResearchFile, researchHash } from "./materials";
import { researchM3Owner } from "./m3-owner";
import { applyResearchChange, setResearchInput } from "./task-graph";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import { researchStages } from "../../contracts/research-group";

export const isNonNumericResearch = (p: Pick<ResearchProject, "workflowVersion" | "path">) =>
  p.workflowVersion === "fusion-v2" && !!p.path && p.path !== "quantitative";

export function changeResearchPath(
  p: ResearchProject,
  path: ResearchProject["path"],
  at: string,
): void {
  if (!path || (p.path ?? "quantitative") === path) return;
  if (
    !p.fusion ||
    p.fusion.attempts.some((a) => ["prepared", "running", "unknown"].includes(a.state))
  )
    throw new Error("改变路径前需暂停并核实全部在途或未知请求。");
  const graph = p.fusion;
  const inputId = "research-path",
    prior = graph.adoptedInputs.find((i) => i.inputId === inputId);
  const version =
    Math.max(0, ...graph.inputs.filter((i) => i.inputId === inputId).map((i) => i.version)) + 1;
  p.fusion = setResearchInput(graph, {
    inputId,
    version,
    kind: "context",
    actual: false,
    availability: "available",
    label: "研究路径",
    sourceRef: `user-path:${p.id}`,
    digest: researchHash(path),
  });
  const affected = graph.tasks.filter(
    (t) =>
      t.id.startsWith(`v${p.revision}:`) &&
      ["search", "reading", "synthesis", "design", "analysis", "writing", "audit"].includes(
        t.stage,
      ),
  );
  p.fusion = applyResearchChange(p.fusion, {
    id: `path:${p.id}:${version}`,
    at,
    inputId,
    fromVersion: prior?.version ?? null,
    toVersion: version,
    reason: "用户明确改变研究路径，相关方法、稿件与审阅重新核查。",
    authorizedBy: "user",
    authorizationRef: `user-path:${p.id}:${version}`,
    additionalTaskIds: affected.map((t) => t.id),
  });
  for (const task of p.fusion.tasks.filter((t) => affected.some((a) => a.id === t.id))) {
    if (!task.inputs.some((r) => r.inputId === inputId))
      task.inputs.push({ inputId, version, requirement: "available" });
  }
  const first = FUSION_STAGE_IDS.find((stage) => affected.some((t) => t.stage === stage));
  if (first && p.goal !== "task") p.currentStage = first;
  p.path = path;
  // Change current definitions only. Attempts retain their original inputRefs/version and outputs.
  for (const task of p.fusion.tasks.filter(
    (t) => affected.some((a) => a.id === t.id) && !t.role.startsWith("specialist:"),
  )) {
    const quantitativeAnalysis =
      task.stage === "analysis" && task.role === "lead" && path === "quantitative";
    task.kind = quantitativeAnalysis
      ? "analysis"
      : task.stage === "design"
        ? "proposal"
        : "research";
    // Conditions belonged to the old path's task definition. Keep the requests/replies and old
    // attempt pins, but let this newly versioned task reassess applicability rather than force
    // a theory/review task to confirm an old CSV condition. No reply is manufactured.
    task.inputs = task.inputs.filter(
      (i) =>
        i.requirement !== "user-confirmed" &&
        i.inputId !== "implementation-material" &&
        !i.inputId.startsWith("dataset:") &&
        !i.inputId.startsWith("source:"),
    );
    const materialIds = quantitativeAnalysis
      ? ["implementation-material", ...(p.evidence?.datasets ?? []).map((d) => `dataset:${d.id}`)]
      : (p.evidence?.sources ?? []).map((s) => `source:${s.id}`);
    // Retire only pending dependencies of the old definition. Original user text,
    // delivered continuation records and old attempts remain available as history.
    task.continuations = task.continuations.filter(
      (c) =>
        !!c.attemptId ||
        !p.m3?.memberInputs?.some(
          (input) =>
            input.taskId === task.id &&
            input.taskVersion < task.inputVersion &&
            c.id === `member:${input.id}`,
        ),
    );
    for (const inputId of materialIds) {
      const adopted = p.fusion.adoptedInputs.find((i) => i.inputId === inputId);
      if (!adopted) throw new Error("切换路径缺少已登记的材料输入，请先完成材料清点。");
      task.inputs.push({ ...adopted, requirement: "available" });
    }
    const stage = researchStages(p).find((s) => s.id === task.stage);
    if (stage) {
      task.goal = `${stage.goal}\n路径已改变：重新判断旧路径条件是否适用；已有请求及答复保留为历史，不能把改路径当作许可或用户确认。仍适用但未解决的条件须明确重新建立依赖。`;
      task.deliverable = stage.deliverables;
    }
  }
  p.status = "paused";
  p.fusion.paused = true;
  p.error = "研究路径已更新，相关任务及证据关口已重算；检查后恢复执行，原成果保留为历史。";
  if (p.finalPaper) {
    (p.supersededExports ??= []).push({
      files: p.finalPaper,
      at,
      reason: "用户改变研究路径，原交付保留为历史。",
    });
    delete p.finalPaper;
  }
}

export function currentResearchPathRecord(p: ResearchProject, id: unknown): ResearchPathRecord {
  const record = p.m3?.pathRecords?.find((r) => r.id === id);
  const task = p.fusion?.tasks.find((t) => t.id === record?.taskId);
  if (
    !record ||
    record.revision !== p.revision ||
    record.input.path !== p.path ||
    !task ||
    task.inputVersion !== record.taskVersion ||
    record.sources.some(
      (s) => !p.evidence?.sources.some((a) => a.id === s.id && a.sha256 === s.sha256),
    )
  )
    throw new Error("非数值证据记录不存在或已过期，请按当前路径和原文重新分析。");
  return record;
}

async function verifyRecordSources(p: ResearchProject, record: ResearchPathRecord): Promise<void> {
  for (const [i, pin] of record.sources.entries()) {
    const source = p.evidence?.sources.find((s) => s.id === pin.id && s.sha256 === pin.sha256);
    if (!source) throw new Error("路径原文已撤回或变版。");
    const body = await readPinnedResearchFile(source),
      evidence = record.input.evidence[i]!;
    if (
      researchHash(body) !== pin.bodySha256 ||
      body.slice(evidence.start, evidence.end) !== record.excerpts[i]?.text
    )
      throw new Error("路径原文或固定片段已变化，不能使用旧记录放行当前稿。");
  }
}

export async function verifyResearchPathPublication(
  p: ResearchProject,
  input: Record<string, unknown>,
): Promise<void> {
  if (
    !isNonNumericResearch(p) ||
    p.goal === "task" ||
    p.entry === "manuscript" ||
    !["analysis", "writing", "audit"].includes(p.currentStage ?? "")
  )
    return;
  const draft = ["stage-draft", "stage-revision"].includes(String(input.kind));
  const accepting = input.kind === "stage-review" && input.verdict === "accept";
  if (!draft && !accepting) return;
  const target = accepting
    ? p.artifacts
        .filter(
          (a) =>
            a.revision === p.revision &&
            a.stage === p.currentStage &&
            a.role === "lead" &&
            p.fusion?.tasks.some((t) => t.currentArtifactId === a.id),
        )
        .at(-1)?.pathRecordId
    : input.pathRecordId;
  await verifyRecordSources(p, currentResearchPathRecord(p, target));
}

export function researchPathInstruction(p: ResearchProject): string {
  if (!isNonNumericResearch(p)) return "";
  const common =
    "本路径不要求CSV、统计运行或数值结果；仍须实读来源、固定范围和具名内容复核。S6中A用path-record(record:{path,scope,approach,limitations,evidence:[{id,sourceId,locatorId,start,end,interpretation}],...})保存可定位分析；来源范围须已由本人source-read实际取得。发布S6/S7/S8稿须带pathRecordId。B独立初判后用path-read(recordId)实读、read当前A稿，再path-review(recordId,artifactId,verdict:supported|limited|revision-required,reason)。导师读取同稿和复核后裁定；新稿重新核查，历史意见不放行新稿。";
  if (p.path === "review")
    return `${common} 范围明确的综述：record另含review:{inclusionCriteria,qualityAssessment,selectionLimitations}；至少两份已读来源，逐项说明支持与相反材料。S5明确纳排与综合方法，S6完成材料比较和局限，不把有限检索包装为完整系统综述，不编造命中数。`;
  if (p.path === "qualitative")
    return `${common} 已有文本质性采用明确的反思性主题分析：record另含qualitative:{approach:reflexive-thematic-analysis,researcherPosition,codes:[{id,label,evidenceIds,interpretation}],themes:[{id,label,codeIds,claim,counterEvidenceIds}],negativeCaseSearch,reflexivity}。从片段到编码、主题与主张逐级可追溯；记录实际反例检索，即使未找到也说明查找范围。主题是研究者的解释性建构；B质疑解释依据和取向一致性，不把一致率或Kappa设为统一通过标准。许可不足保持待决定。`;
  return `${common} 理论／概念路径：record另含theoretical:{concepts:[{id,definition,evidenceIds}],arguments:[{id,proposition,premiseIds,steps,evidenceIds,competingExplanation,counterexample}]}。明确概念定义、前提、推导、竞争解释和反例，不编造实验、样本或经验结果。S7/S8交付论证稿，写清贡献及适用边界。`;
}

export async function applyResearchPathTool(
  p: ResearchProject,
  role: ResearchRole,
  input: Record<string, unknown>,
  at: string,
): Promise<unknown> {
  if (!isNonNumericResearch(p)) throw new Error("当前课题未选择非数值研究路径。");
  const owner = researchM3Owner(p, role);
  const m3 = (p.m3 ??= {});
  if (input.operation === "path-context")
    return {
      path: p.path,
      instruction: researchPathInstruction(p),
      records: (m3.pathRecords ?? [])
        .filter((r) => r.revision === p.revision)
        .map((r) => ({ id: r.id, path: r.input.path, taskId: r.taskId, role: r.role, at: r.at })),
      reviews: (m3.pathReviews ?? []).filter(
        (r) =>
          r.role === role ||
          p.events.some(
            (e) => e.type === "read" && e.role === role && e.artifactId === r.artifactId,
          ),
      ),
    };
  if (input.operation === "path-record") {
    if (role !== "lead" || owner.task.stage !== "analysis")
      throw new Error("路径分析记录由S6当前A执行任务提交。");
    const recordInput = decodeResearchPathRecord(input.record);
    if (recordInput.path !== p.path) throw new Error("分析记录与当前路径不符。");
    const reads = [];
    const excerpts = [];
    const sources = [];
    for (const evidence of recordInput.evidence) {
      const source = p.evidence?.sources.find((s) => s.id === evidence.sourceId);
      if (!source) throw new Error("分析片段来源未登记。");
      const body = await readPinnedResearchFile(source),
        bodySha256 = researchHash(body);
      const receipt = p.sourceReads?.find(
        (r) =>
          r.sourceId === source.id &&
          r.sourceSha256 === source.sha256 &&
          r.bodySha256 === bodySha256 &&
          r.sessionId === owner.ref.sessionId &&
          r.locatorId === evidence.locatorId &&
          r.start <= evidence.start &&
          r.end >= evidence.end &&
          !["metadata", "abstract"].includes(r.depth) &&
          Date.parse(r.at) <= Date.parse(at),
      );
      if (!receipt || evidence.end > body.length)
        throw new Error("分析片段需要本人已读的当前部分正文／全文位置，不能用摘要或伪造定位代替。");
      reads.push(structuredClone(receipt));
      const text = body.slice(evidence.start, evidence.end);
      excerpts.push({ id: evidence.id, text, sha256: researchHash(text) });
      sources.push({ id: source.id, sha256: source.sha256, bodySha256 });
    }
    const record: ResearchPathRecord = {
      id: randomUUID(),
      revision: p.revision,
      taskId: owner.task.id,
      taskVersion: owner.task.inputVersion,
      attemptId: owner.attempt.id,
      role,
      sessionId: owner.ref.sessionId,
      at,
      input: recordInput,
      actualReads: reads,
      excerpts,
      sources,
    };
    (m3.pathRecords ??= []).push(record);
    return structuredClone(record);
  }
  const record = currentResearchPathRecord(p, input.recordId);
  await verifyRecordSources(p, record);
  if (input.operation === "path-read") {
    if (
      role === "reviewer" &&
      !p.artifacts.some(
        (a) =>
          a.role === "reviewer" &&
          a.stage === owner.task.stage &&
          a.kind === "stage-risk" &&
          a.revision === p.revision,
      )
    )
      throw new Error("B先提交当前阶段独立判断，再读取A的路径分析。");
    (m3.pathReads ??= []).push({ recordId: record.id, role, attemptId: owner.attempt.id, at });
    return structuredClone(record);
  }
  if (input.operation !== "path-review") throw new Error("未知路径分析操作。");
  if (role !== "reviewer" && role !== "mentor") throw new Error("路径内容复核由B或导师具名提交。");
  if (
    record.input.evidence.some(
      (e, i) =>
        !p.sourceReads?.some(
          (read) =>
            read.sessionId === owner.ref.sessionId &&
            read.sourceId === e.sourceId &&
            read.sourceSha256 === record.sources[i]!.sha256 &&
            read.bodySha256 === record.sources[i]!.bodySha256 &&
            read.locatorId === e.locatorId &&
            read.start <= e.start &&
            read.end >= e.end &&
            !["metadata", "abstract"].includes(read.depth),
        ),
    )
  )
    throw new Error("路径复核还需本人实际读取所用原文片段，不能借用A的阅读凭据。");
  const artifact = p.artifacts.find((a) => a.id === input.artifactId && a.revision === p.revision);
  const graphArtifact = p.fusion?.artifacts.find((a) => a.id === artifact?.id);
  const producer = p.fusion?.tasks.find((t) => t.id === graphArtifact?.taskId);
  if (
    !artifact ||
    artifact.pathRecordId !== record.id ||
    !producer ||
    producer.currentArtifactId !== artifact.id ||
    producer.inputVersion !== graphArtifact?.taskVersion ||
    !m3.pathReads?.some(
      (r) => r.recordId === record.id && r.role === role && r.attemptId === owner.attempt.id,
    ) ||
    !p.events.some(
      (e) =>
        e.type === "read" &&
        e.artifactId === artifact.id &&
        e.role === role &&
        e.runId === owner.attempt.nativeRunId,
    )
  )
    throw new Error("请在本次原生运行中实读当前A稿及其路径记录后复核。");
  if (
    !["supported", "limited", "revision-required"].includes(String(input.verdict)) ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 20 ||
    input.reason.length > 12000
  )
    throw new Error("路径复核需明确结论及至少20字具体依据与局限。");
  const review = {
    id: randomUUID(),
    recordId: record.id,
    artifactId: artifact.id,
    artifactSha256: researchHash(artifact.content),
    role,
    attemptId: owner.attempt.id,
    at,
    verdict: input.verdict as "supported" | "limited" | "revision-required",
    reason: input.reason.trim(),
  };
  (m3.pathReviews ??= []).push(review);
  return review;
}

export function assertNonNumericPublication(
  p: ResearchProject,
  role: ResearchRole,
  input: Record<string, unknown>,
): void {
  if (!isNonNumericResearch(p) || p.goal === "task" || p.entry === "manuscript") return;
  const stage = p.currentStage;
  if (
    ["analysis", "writing", "audit"].includes(stage ?? "") &&
    role === "lead" &&
    ["stage-draft", "stage-revision"].includes(String(input.kind))
  ) {
    const record = currentResearchPathRecord(p, input.pathRecordId);
    if (stage === "analysis" && record.taskId !== `v${p.revision}:analysis:lead`)
      throw new Error("S6稿必须使用本阶段A的当前路径记录。");
    const sources = Array.isArray(input.sourceIds) ? input.sourceIds : [];
    if (record.sources.some((s) => !sources.includes(s.id)))
      throw new Error("路径稿需列出实际分析所依据的全部来源。");
  }
  if (
    ["analysis", "writing", "audit"].includes(stage ?? "") &&
    input.kind === "stage-review" &&
    input.verdict === "accept"
  ) {
    const manuscript = p.artifacts
      .filter(
        (a) =>
          a.revision === p.revision &&
          a.stage === stage &&
          a.role === "lead" &&
          ["stage-draft", "stage-revision"].includes(a.kind),
      )
      .filter((a) => p.fusion?.tasks.some((t) => t.currentArtifactId === a.id))
      .at(-1);
    if (!manuscript) throw new Error("缺少当前路径稿件。");
    currentResearchPathRecord(p, manuscript.pathRecordId);
    const review = p.m3?.pathReviews
      ?.filter(
        (r) =>
          r.role === "reviewer" &&
          r.artifactId === manuscript.id &&
          r.artifactSha256 === researchHash(manuscript.content),
      )
      .at(-1);
    const attempt = p.fusion?.attempts.find((a) => a.id === review?.attemptId);
    if (
      !review ||
      review.verdict === "revision-required" ||
      !attempt ||
      !p.fusion?.tasks.some(
        (t) => t.id === attempt.taskId && t.inputVersion === attempt.taskVersion,
      )
    )
      throw new Error("非数值路径稿尚无B针对同稿的有效具名复核。");
  }
}

export function nonNumericManuscriptIssues(
  p: ResearchProject,
  artifact: Pick<ResearchArtifact, "content">,
): string[] {
  const body = artifact.content;
  const issues: string[] = [];
  if (!/^# /m.test(body) || !/摘要|Abstract/i.test(body) || !/参考文献|References/i.test(body))
    issues.push("需包含题目、摘要及参考文献");
  if (p.path === "review" && (!/范围|纳入|筛选/.test(body) || !/综合|分歧|反证/.test(body)))
    issues.push("综述需说明范围、筛选及综合／分歧");
  if (p.path === "qualitative" && (!/主题|theme/i.test(body) || !/反思|reflexiv/i.test(body)))
    issues.push("质性报告需说明主题和研究者反思");
  if (
    p.path === "theoretical" &&
    (!/概念|定义/.test(body) || !/前提|推导|命题/.test(body) || !/竞争|反例|替代/.test(body))
  )
    issues.push("概念稿需说明定义、论证及竞争解释／反例");
  return issues;
}
