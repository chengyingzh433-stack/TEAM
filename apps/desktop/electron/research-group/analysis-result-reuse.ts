import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import {
  ANALYSIS_ARCHIVE_FILES,
  decodeResearchAnalysisReuseRecords as decodeRecordShapes,
  type AnalysisArchiveHashes,
  type AnalysisNativeContext,
  type AnalysisResultPin,
  type ResearchAnalysisRead,
  type ResearchAnalysisReuseRecords,
  type ResearchAnalysisReviewContext,
  type ResearchAnalysisRunAdoption,
} from "../../contracts/research-analysis-reuse";
import { decodeResearchTaskGraph } from "../../contracts/research-task-graph";
import { decodeResearchAnalysisRegistry } from "./analysis-registry";
import { calculateResearchData, RESEARCH_ANALYSIS_ENGINE } from "./analysis";

export type AnalysisReuseProject = ResearchProject & ResearchAnalysisReuseRecords;
export type AnalysisArchiveReader = (file: string) => Promise<Buffer>;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const equal = isDeepStrictEqual;
function fail(message: string): never {
  throw new Error(`分析结果复用：${message}`);
}
const timestamp = (at: string) => {
  if (!Number.isFinite(Date.parse(at))) fail("无效宿主时间");
  return Date.parse(at);
};
function text(value: string, label: string, max = 6000) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    fail(`${label}无效`);
}
function records(p: AnalysisReuseProject): ResearchAnalysisReuseRecords {
  return {
    analysisRunAdoptions: p.analysisRunAdoptions ?? [],
    analysisReads: p.analysisReads ?? [],
    analysisReviewContexts: p.analysisReviewContexts ?? [],
  };
}
function signed<T extends object>(body: T): T & { integritySha256: string } {
  return { ...body, integritySha256: digest(body) };
}
function intact(row: { integritySha256: string }) {
  const { integritySha256, ...body } = row;
  return digest(body) === integritySha256;
}
function identity(kind: string, context: AnalysisNativeContext, callId: string) {
  text(callId, "callId", 512);
  return `${kind}:${digest([context.projectId, context.attemptId, context.sessionId, callId])}`;
}

function contextExists(
  p: AnalysisReuseProject,
  context: AnalysisNativeContext,
  current: boolean,
): boolean {
  const task = p.fusion?.tasks.find((task) => task.id === context.taskId),
    attempt = p.fusion?.attempts.find((attempt) => attempt.id === context.attemptId);
  return (
    p.id === context.projectId &&
    context.revision <= p.revision &&
    (!current || context.revision === p.revision) &&
    !!task &&
    !!attempt &&
    task.role === context.role &&
    task.id.startsWith(`v${context.revision}:`) &&
    task.inputVersion >= context.taskInputVersion &&
    (!current || task.inputVersion === context.taskInputVersion) &&
    attempt.taskId === task.id &&
    attempt.taskVersion === context.taskInputVersion &&
    attempt.nativeRunId === context.nativeRunId &&
    equal(attempt.model, context.model) &&
    p.members.some(
      (member) => member.role === context.role && member.ref.sessionId === context.sessionId,
    ) &&
    (!current || ["running", "succeeded"].includes(attempt.state))
  );
}
/** Capture before the actual native operation; compare this same token again at completion. */
export function captureAnalysisNativeContext(
  p: AnalysisReuseProject,
  role: ResearchRole,
): AnalysisNativeContext {
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    !p.fusion ||
    p.fusion.projectId !== p.id
  )
    fail("需要正在运行的融合课题");
  const active = p.fusion.attempts.filter(
    (attempt) =>
      ["prepared", "running", "unknown"].includes(attempt.state) &&
      p.fusion!.tasks.some((task) => task.id === attempt.taskId && task.role === role),
  );
  const attempt = active[0],
    task = p.fusion.tasks.find((task) => task.id === attempt?.taskId),
    members = p.members.filter((member) => member.role === role);
  if (
    active.length !== 1 ||
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !attempt.model ||
    members.length !== 1 ||
    !task.id.startsWith(`v${p.revision}:`) ||
    task.inputVersion !== attempt.taskVersion ||
    [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].some(
      (ref) =>
        !p.fusion!.adoptedInputs.some((adopted) =>
          equal(adopted, { inputId: ref.inputId, version: ref.version }),
        ),
    )
  )
    fail("当前native/角色/任务输入版本无效或仍有unknown请求");
  return {
    projectId: p.id,
    revision: p.revision,
    role,
    taskId: task.id,
    taskInputVersion: task.inputVersion,
    attemptId: attempt.id,
    nativeRunId: attempt.nativeRunId,
    sessionId: members[0]!.ref.sessionId,
    model: structuredClone(attempt.model),
  };
}
function hostTime(p: AnalysisReuseProject, context: AnalysisNativeContext, at: string) {
  const attempt = p.fusion?.attempts.find((attempt) => attempt.id === context.attemptId);
  if (
    !attempt ||
    timestamp(at) < timestamp(attempt.dispatchedAt ?? attempt.preparedAt) ||
    (attempt.finishedAt && timestamp(at) > timestamp(attempt.finishedAt))
  )
    fail("操作时间不在实际native执行范围内");
}
function assertOwner(p: AnalysisReuseProject, context: AnalysisNativeContext) {
  if (!equal(captureAnalysisNativeContext(p, context.role), context))
    fail("操作期间native或任务输入身份已变化");
}
function basis(p: AnalysisReuseProject, analysisId: string) {
  if (!p.analysisRegistry || !p.fusion) fail("缺少实际注册运行或任务图");
  const registry = decodeResearchAnalysisRegistry(p.analysisRegistry);
  decodeResearchTaskGraph(p.fusion);
  const run = registry.runs.find((run) => run.id === analysisId),
    projections = p.analyses?.filter((projection) => projection.id === analysisId) ?? [],
    projection = projections[0];
  if (
    !run ||
    projections.length !== 1 ||
    !projection ||
    !projection.taskId ||
    !projection.attemptId ||
    !Number.isSafeInteger(projection.taskInputVersion)
  )
    fail("运行/projection缺失、重复或没有原执行身份");
  const attempt = p.fusion.attempts.find((attempt) => attempt.id === projection.attemptId),
    task = p.fusion.tasks.find((task) => task.id === projection.taskId),
    member = p.members.find((member) => member.role === projection.role);
  if (
    !attempt ||
    !task ||
    !member ||
    !["lead", "reviewer"].includes(projection.role) ||
    task.stage !== "analysis" ||
    task.role !== projection.role ||
    attempt.taskId !== task.id ||
    attempt.taskVersion !== projection.taskInputVersion ||
    !attempt.model ||
    !attempt.nativeRunId ||
    !task.id.startsWith(`v${projection.revision}:`) ||
    run.actor !== `model:${projection.role}` ||
    run.at !== projection.createdAt ||
    run.engine !== projection.engine ||
    (projection.replayScriptSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(projection.replayScriptSha256)) ||
    run.datasetSha256 !== projection.datasetSha256 ||
    run.resultSha256 !== projection.sha256 ||
    digest(projection.result) !== run.resultSha256 ||
    !equal(projection.result, run.result) ||
    !equal(projection.spec, run.spec) ||
    timestamp(run.at) < timestamp(attempt.preparedAt) ||
    (attempt.finishedAt && timestamp(run.at) > timestamp(attempt.finishedAt))
  )
    fail("固定运行与原始执行/projection不一致");
  const plan = registry.plans.find(
    (plan) => plan.id === run.planId && plan.version === run.planVersion,
  )!;
  const closure: AnalysisResultPin["plans"] = [];
  const add = (id: string, version: number) => {
    if (closure.some((entry) => entry.id === id)) fail("比较计划依赖环或重复身份");
    const item = registry.plans.find((plan) => plan.id === id && plan.version === version);
    if (!item) fail("比较计划闭包断引用");
    const sha256 = digest(item),
      inputId = `analysis-plan:${id}`,
      input = p.fusion!.inputs.filter(
        (input) => input.inputId === inputId && input.digest === sha256,
      );
    if (input.length !== 1) fail("计划缺少唯一固定输入");
    closure.push({ id, version, sha256, inputId, inputVersion: input[0]!.version });
    if (item.compareWith) add(item.compareWith.planId, item.compareWith.planVersion);
  };
  add(plan.id, plan.version);
  const refs = [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])],
    datasetInput = refs.find((ref) => ref.inputId === `dataset:${run.datasetId}`);
  if (
    !datasetInput ||
    !p.fusion.inputs.some(
      (input) =>
        input.inputId === datasetInput.inputId &&
        input.version === datasetInput.version &&
        input.digest === run.datasetSha256 &&
        input.actual,
    ) ||
    !refs.some(
      (ref) => ref.inputId === closure[0]!.inputId && ref.version === closure[0]!.inputVersion,
    )
  )
    fail("原执行没有实际数据及本计划输入凭据");
  const pin: AnalysisResultPin = {
    runId: run.id,
    runSha256: run.runSha256,
    projectionSha256: digest(projection),
    planId: plan.id,
    planVersion: plan.version,
    planSha256: digest(plan),
    datasetId: run.datasetId,
    datasetSha256: run.datasetSha256,
    datasetInput: { inputId: datasetInput.inputId, version: datasetInput.version },
    engine: run.engine,
    adapter: run.adapter,
    plans: closure,
  };
  const source: AnalysisNativeContext = {
    projectId: p.id,
    revision: projection.revision,
    role: projection.role,
    taskId: task.id,
    taskInputVersion: projection.taskInputVersion!,
    attemptId: attempt.id,
    nativeRunId: attempt.nativeRunId,
    sessionId: member.ref.sessionId,
    model: structuredClone(attempt.model),
  };
  return { run, projection, plan, pin, source, attempt, task, registry };
}
function dependenciesCurrent(p: AnalysisReuseProject, value: ReturnType<typeof basis>) {
  const { pin, run, projection } = value;
  if (
    projection.revision !== p.revision ||
    run.engine !== RESEARCH_ANALYSIS_ENGINE ||
    run.adapter !== "analysis-registry-1"
  )
    return false;
  if (
    !p.evidence?.datasets.some(
      (dataset) =>
        dataset.id === pin.datasetId &&
        dataset.sha256 === pin.datasetSha256 &&
        dataset.delimiter === run.replay.dataset.delimiter,
    )
  )
    return false;
  const adopted = (inputId: string, version: number, sha256: string) =>
    p.fusion!.adoptedInputs.some((ref) => ref.inputId === inputId && ref.version === version) &&
    p.fusion!.inputs.some(
      (input) =>
        input.inputId === inputId &&
        input.version === version &&
        input.digest === sha256 &&
        input.availability === "available",
    );
  return (
    adopted(pin.datasetInput.inputId, pin.datasetInput.version, pin.datasetSha256) &&
    pin.plans.every(
      (plan) =>
        p.activeAnalysisPlans?.some(
          (active) => active.id === plan.id && active.version === plan.version,
        ) &&
        value.registry.plans.filter((item) => item.id === plan.id).at(-1)?.version ===
          plan.version &&
        adopted(plan.inputId, plan.inputVersion, plan.sha256),
    )
  );
}
function reuseChanges(
  p: AnalysisReuseProject,
  value: ReturnType<typeof basis>,
  target: AnalysisNativeContext,
) {
  const { source, attempt, pin } = value;
  if (
    source.projectId !== target.projectId ||
    source.revision !== target.revision ||
    source.role !== target.role ||
    source.taskId !== target.taskId ||
    source.taskInputVersion >= target.taskInputVersion
  )
    fail("仅支持同revision同角色原任务的旧结果显式采用");
  if (
    attempt.state !== "succeeded" ||
    !attempt.finishedAt ||
    p.fusion!.attemptResolutions?.some((resolution) => resolution.attemptId === attempt.id) ||
    !p.events.some(
      (event) =>
        event.type === "finished" &&
        event.runId === attempt.nativeRunId &&
        event.role === source.role &&
        event.revision === source.revision &&
        timestamp(event.runtimeAt ?? event.at) >=
          timestamp(attempt.dispatchedAt ?? attempt.preparedAt) &&
        timestamp(event.runtimeAt ?? event.at) <= timestamp(attempt.finishedAt!),
    )
  )
    fail("源native须已自然成功结束；unknown或人工补结论不能替代");
  const targetAttempt = p.fusion!.attempts.find((item) => item.id === target.attemptId);
  if (!targetAttempt) fail("目标native断引用");
  const changes = p.fusion!.changes.filter(
    (change) =>
      change.affectedTaskIds.includes(source.taskId) &&
      timestamp(change.at) >= timestamp(attempt.preparedAt) &&
      timestamp(change.at) <= timestamp(targetAttempt.preparedAt),
  );
  if (
    changes.length !== target.taskInputVersion - source.taskInputVersion ||
    !changes.length ||
    changes.some(
      (change) =>
        timestamp(change.at) <= timestamp(attempt.finishedAt!) ||
        !change.inputId.startsWith("analysis-plan:") ||
        pin.plans.some((plan) => plan.inputId === change.inputId) ||
        !p.fusion!.inputs.some(
          (input) =>
            input.inputId === change.inputId &&
            input.version === change.toVersion &&
            value.registry.plans.some(
              (plan) =>
                `analysis-plan:${plan.id}` === change.inputId && digest(plan) === input.digest,
            ),
        ),
    )
  )
    fail("只支持源native结束后其他分析计划导致的完整可解释版本变化；其余变化需重新核查");
  return changes.map((change) => change.id);
}
/** Structural + original-hash + canonical cross-reference validation; never repairs saved hashes. */
export function decodeAnalysisReuseRecords(
  value: unknown,
  p: AnalysisReuseProject,
): ResearchAnalysisReuseRecords {
  const decoded = decodeRecordShapes(value),
    calls = new Set<string>();
  for (const row of [
    ...(decoded.analysisRunAdoptions ?? []),
    ...(decoded.analysisReads ?? []),
    ...(decoded.analysisReviewContexts ?? []),
  ]) {
    if (!intact(row)) fail("凭据原始integrity摘要不符");
    const context = "target" in row ? row.target : row.context,
      key = `${context.attemptId}:${context.sessionId}:${row.callId}`;
    if (calls.has(key) || !contextExists(p, context, false)) fail("调用身份重复或native凭据断引用");
    calls.add(key);
    const prefix =
      row.kind === "analysis-result-reuse"
        ? "analysis-adoption"
        : row.kind === "analysis-operation-receipt"
          ? "analysis-read"
          : "analysis-review-context";
    if (row.id !== identity(prefix, context, row.callId)) fail("凭据ID与实际调用身份不一致");
    hostTime(p, context, row.at);
    if ("pin" in row) {
      const value = basis(p, row.pin.runId);
      if (!equal(value.pin, row.pin)) fail("凭据固定run/plan/dataset与原件登记不一致");
      if (timestamp(row.at) < timestamp(value.run.at)) fail("凭据时间早于实际运行");
      if (
        "source" in row &&
        (!equal(value.source, row.source) ||
          !Object.entries(expectedArchiveHashes(value)).every(
            ([name, sha]) => row.fileHashes[name as keyof AnalysisArchiveHashes] === sha,
          ) ||
          !equal(row.changeIds, reuseChanges(p, value, row.target)))
      )
        fail("复用源执行或变更断引用");
      if (row.kind === "analysis-operation-receipt") {
        if (row.operation === "run-analysis" && !equal(value.source, context))
          fail("实际执行返回身份与源native不一致");
        const adoption = decoded.analysisRunAdoptions?.find((item) => item.id === row.adoptionId);
        if (row.usableForCurrentInputs) {
          const epoch = adoption?.target ?? value.source;
          if (
            epoch.revision !== context.revision ||
            p.fusion!.changes.some(
              (change) =>
                change.affectedTaskIds.includes(epoch.taskId) &&
                timestamp(change.at) > timestamp(adoption?.at ?? value.run.at) &&
                timestamp(change.at) <= timestamp(row.at),
            )
          )
            fail("实际读取已经跨过输入失效边界");
        }
      }
    } else {
      const review = p.analysisRegistry?.reviews.find((review) => review.id === row.reviewId);
      if (
        !review ||
        digest(review) !== row.reviewSha256 ||
        review.runId !== row.runId ||
        review.actor !== `model:${context.role}` ||
        review.kind !== "interpretation-review" ||
        review.evidenceRef !== `tool:${row.callId}` ||
        review.at !== row.at
      )
        fail("解释审阅凭据与原始模型意见不一致");
    }
  }
  return decoded;
}
function adoptionFor(
  p: AnalysisReuseProject,
  analysisId: string,
  seen = new Set<string>(),
): ResearchAnalysisRunAdoption | undefined {
  if (seen.has(analysisId)) return undefined;
  seen.add(analysisId);
  const value = basis(p, analysisId);
  if (!dependenciesCurrent(p, value)) return undefined;
  return p.analysisRunAdoptions
    ?.filter((adoption) => adoption.pin.runId === analysisId)
    .slice()
    .reverse()
    .find((adoption) => {
      if (
        !intact(adoption) ||
        !equal(adoption.pin, value.pin) ||
        !equal(adoption.source, value.source) ||
        !contextExists(p, adoption.target, true)
      )
        return false;
      try {
        if (!equal(reuseChanges(p, value, adoption.target), adoption.changeIds)) return false;
      } catch {
        return false;
      }
      const verification = value.run.verification;
      return (
        value.source.role !== "reviewer" ||
        (verification.level === "same-engine-replay" &&
          verification.matches &&
          currentResult(p, verification.replayOf, seen))
      );
    });
}
function currentResult(
  p: AnalysisReuseProject,
  analysisId: string,
  seen = new Set<string>(),
): boolean {
  const value = basis(p, analysisId);
  if (!dependenciesCurrent(p, value)) return false;
  return contextExists(p, value.source, true) || !!adoptionFor(p, analysisId, seen);
}
/** Pure metadata predicate for the existing pipeline's explicit-adoption fallback; files remain checked at gates. */
export function hasCurrentAnalysisRunAdoption(
  p: AnalysisReuseProject,
  analysisId: string,
): boolean {
  try {
    decodeAnalysisReuseRecords(records(p), p);
    return !!adoptionFor(p, analysisId);
  } catch {
    return false;
  }
}
export function evaluateAnalysisReuse(
  p: AnalysisReuseProject,
  role: ResearchRole,
  analysisId: string,
) {
  try {
    decodeAnalysisReuseRecords(records(p), p);
    const target = captureAnalysisNativeContext(p, role),
      value = basis(p, analysisId);
    if (
      !["lead", "reviewer"].includes(role) ||
      p.fusion!.tasks.find((task) => task.id === target.taskId)!.stage !== "analysis" ||
      !dependenciesCurrent(p, value)
    )
      fail("计划、比较闭包、数据、engine或当前角色不符合复用边界");
    if (!value.projection.replayScriptSha256)
      fail("旧执行没有固定复跑脚本指纹；需重新计算，不能据当前构建补造原指纹");
    const changeIds = reuseChanges(p, value, target),
      verification = value.run.verification;
    if (
      role === "reviewer" &&
      (verification.level !== "same-engine-replay" ||
        !verification.matches ||
        !currentResult(p, verification.replayOf))
    )
      fail("B须采用本人已匹配复跑，且其A原运行已当前有效");
    return { eligible: true as const, source: value.source, target, pin: value.pin, changeIds };
  } catch (error) {
    return {
      eligible: false as const,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}
/** Byte-identical to the existing registered-analysis writer; root can reuse this generator when wiring. */
export function registeredAnalysisReplayScript(): string {
  return `import {readFileSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\nconst hash=s=>createHash('sha256').update(s).digest('hex');\nconst run=JSON.parse(readFileSync(new URL('./registered-run.json',import.meta.url),'utf8'));\nconst original=readFileSync(new URL('./input.csv',import.meta.url),'utf8');\nconst csv=readFileSync(new URL('./calculation-input.csv',import.meta.url),'utf8');\nif(hash(original)!==run.datasetSha256||hash(csv)!==run.calculationInputSha256)throw Error('Analysis input changed');\nconst calculate=${calculateResearchData.toString()};\nconst result=calculate(csv,run.replay.dataset.delimiter,run.spec);\nif(hash(JSON.stringify(result))!==run.resultSha256)throw Error('Replay result differs');\nconsole.log(JSON.stringify({verification:'same-engine-replay',result},null,2));\n`;
}
function expectedArchiveHashes(value: ReturnType<typeof basis>): Partial<AnalysisArchiveHashes> {
  return {
    dataset: value.run.datasetSha256,
    "input.csv": value.run.datasetSha256,
    "calculation-input.csv": value.run.calculationInputSha256,
    "plan.json": hash(JSON.stringify(value.plan, null, 2)),
    "registered-run.json": hash(JSON.stringify(value.run, null, 2)),
    "result.json": hash(JSON.stringify(value.projection, null, 2)),
    // The producer's pinned bytes remain authoritative across bundlers/builds.
    ...(value.projection.replayScriptSha256
      ? { "replay.mjs": value.projection.replayScriptSha256 }
      : {}),
  };
}
/** Read/verify, never execute the statistics engine or overwrite any archive file. */
export async function verifyAnalysisResultFiles(
  p: AnalysisReuseProject,
  analysisId: string,
  reader: AnalysisArchiveReader = readFile,
): Promise<AnalysisArchiveHashes> {
  const value = basis(p, analysisId),
    { run, projection, plan } = value;
  if (!projection.replayScriptSha256) fail("旧执行未固定复跑脚本指纹，不能核验为当前可采用结果");
  const expectedHashes = expectedArchiveHashes(value);
  if (!dependenciesCurrent(p, value)) fail("实际文件核验需要当前固定计划、数据和engine");
  if (![p.id, run.id].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(id)))
    fail("归档身份路径无效");
  const relative = [".lancer", "research-groups", p.id, "analysis", run.id],
    directory = join(p.workspacePath, ...relative);
  if (
    resolve(projection.file) !== resolve(directory, "result.json") ||
    (await realpath(directory)) !== join(await realpath(p.workspacePath), ...relative)
  )
    fail("归档路径或符号链接已变化");
  const bytes = async (file: string) => {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 25_000_000)
      fail("归档文件类型/大小无效");
    const data = await reader(file);
    if (data.length > 25_000_000) fail("归档读取超限");
    return data;
  };
  const dataset = p.evidence!.datasets.find((dataset) => dataset.id === run.datasetId)!,
    original = await bytes(dataset.file);
  if (hash(original) !== run.datasetSha256) fail("实际数据已变化：SHA不符");
  const hashes = { dataset: hash(original) } as AnalysisArchiveHashes;
  for (const name of ANALYSIS_ARCHIVE_FILES) {
    const data = await bytes(join(directory, name));
    hashes[name] = hash(data);
    const expected =
      name === "input.csv"
        ? original
        : name === "calculation-input.csv"
          ? undefined
          : name === "replay.mjs"
            ? undefined
            : Buffer.from(
                name === "plan.json"
                  ? JSON.stringify(plan, null, 2)
                  : name === "registered-run.json"
                    ? JSON.stringify(run, null, 2)
                    : JSON.stringify(projection, null, 2),
              );
    if (expected ? !data.equals(expected) : hash(data) !== expectedHashes[name])
      fail(`实际归档${name}字节与固定执行不一致`);
  }
  return hashes;
}
function token(p: AnalysisReuseProject) {
  return digest({
    id: p.id,
    revision: p.revision,
    status: p.status,
    members: p.members,
    fusion: p.fusion,
    registry: p.analysisRegistry,
    active: p.activeAnalysisPlans,
    analyses: p.analyses,
    evidence: p.evidence,
    records: records(p),
  });
}
function existingCall(p: AnalysisReuseProject, context: AnalysisNativeContext, callId: string) {
  return [
    ...(p.analysisRunAdoptions ?? []),
    ...(p.analysisReads ?? []),
    ...(p.analysisReviewContexts ?? []),
  ].find((row) => {
    const c = "target" in row ? row.target : row.context;
    return (
      c.attemptId === context.attemptId &&
      c.sessionId === context.sessionId &&
      row.callId === callId
    );
  });
}
export async function reuseRegisteredResearchAnalysis(
  p: AnalysisReuseProject,
  context: AnalysisNativeContext,
  callId: string,
  analysisId: string,
  reason: string,
  at: string,
  reader?: AnalysisArchiveReader,
): Promise<ResearchAnalysisRunAdoption> {
  text(reason, "显式复用理由");
  timestamp(at);
  assertOwner(p, context);
  hostTime(p, context, at);
  const eligibility = evaluateAnalysisReuse(p, context.role, analysisId);
  if (!eligibility.eligible) fail(eligibility.issues.join("；"));
  const prior = existingCall(p, context, callId);
  if (
    prior &&
    (prior.kind !== "analysis-result-reuse" ||
      prior.pin.runId !== analysisId ||
      prior.reason !== reason ||
      !equal(prior.target, context))
  )
    fail("同一调用身份不能改变复用请求");
  if (
    prior &&
    prior.kind === "analysis-result-reuse" &&
    !hasCurrentAnalysisRunAdoption(p, analysisId)
  )
    fail("历史调用不能重新授权已过期的采用");
  const before = token(p),
    fileHashes = await verifyAnalysisResultFiles(p, analysisId, reader);
  assertOwner(p, context);
  if (token(p) !== before) fail("读取归档期间课题/输入/采用记录变化");
  if (prior) {
    if (prior.kind !== "analysis-result-reuse" || !equal(prior.fileHashes, fileHashes))
      fail("原采用所核字节已变化");
    return structuredClone(prior);
  }
  const adopted: ResearchAnalysisRunAdoption = signed({
    id: identity("analysis-adoption", context, callId),
    kind: "analysis-result-reuse" as const,
    at,
    callId,
    reason,
    source: eligibility.source,
    target: structuredClone(context),
    pin: eligibility.pin,
    changeIds: eligibility.changeIds,
    fileHashes,
  });
  decodeAnalysisReuseRecords(
    { ...records(p), analysisRunAdoptions: [...(p.analysisRunAdoptions ?? []), adopted] },
    p,
  );
  (p.analysisRunAdoptions ??= []).push(adopted);
  return structuredClone(adopted);
}
/** Trusted host hook AFTER a genuine operation returns; no model-facing operation may create receipts. */
export async function recordAnalysisOperationReceipt(
  p: AnalysisReuseProject,
  context: AnalysisNativeContext,
  callId: string,
  operation: ResearchAnalysisRead["operation"],
  analysisId: string,
  at: string,
  reader?: AnalysisArchiveReader,
): Promise<ResearchAnalysisRead> {
  timestamp(at);
  assertOwner(p, context);
  hostTime(p, context, at);
  decodeAnalysisReuseRecords(records(p), p);
  if (!["run-analysis", "read-analysis", "read-registered-analysis"].includes(operation))
    fail("不能自报其他操作为实际读取");
  const value = basis(p, analysisId),
    usableForCurrentInputs = currentResult(p, analysisId),
    adoption = usableForCurrentInputs ? adoptionFor(p, analysisId) : undefined;
  if (operation === "run-analysis" && (!usableForCurrentInputs || !equal(value.source, context)))
    fail("实算返回必须属于本次实际native，不能借历史运行登记执行");
  const prior = existingCall(p, context, callId);
  if (
    prior &&
    (prior.kind !== "analysis-operation-receipt" ||
      prior.operation !== operation ||
      prior.pin.runId !== analysisId ||
      !equal(prior.context, context))
  )
    fail("同一调用不能改作其他读取或运行");
  const before = token(p);
  if (usableForCurrentInputs) await verifyAnalysisResultFiles(p, analysisId, reader);
  assertOwner(p, context);
  if (token(p) !== before) fail("实际返回登记期间输入变化");
  if (prior) {
    if (
      prior.kind !== "analysis-operation-receipt" ||
      (prior.usableForCurrentInputs &&
        (!usableForCurrentInputs || prior.adoptionId !== adoption?.id))
    )
      fail("历史读取调用不能重新授权变化后的输入");
    return structuredClone(prior);
  }
  const receipt: ResearchAnalysisRead = signed({
    id: identity("analysis-read", context, callId),
    kind: "analysis-operation-receipt" as const,
    at,
    callId,
    operation,
    context: structuredClone(context),
    pin: value.pin,
    ...(adoption ? { adoptionId: adoption.id } : {}),
    usableForCurrentInputs,
  });
  decodeAnalysisReuseRecords(
    { ...records(p), analysisReads: [...(p.analysisReads ?? []), receipt] },
    p,
  );
  (p.analysisReads ??= []).push(receipt);
  return structuredClone(receipt);
}
function currentRead(
  p: AnalysisReuseProject,
  context: AnalysisNativeContext,
  analysisId: string,
): ResearchAnalysisRead | undefined {
  if (!currentResult(p, analysisId)) return undefined;
  const adoption = adoptionFor(p, analysisId),
    pin = basis(p, analysisId).pin;
  return p.analysisReads
    ?.slice()
    .reverse()
    .find(
      (read) =>
        read.usableForCurrentInputs &&
        intact(read) &&
        equal(read.context, context) &&
        equal(read.pin, pin) &&
        read.adoptionId === adoption?.id &&
        (!adoption || timestamp(read.at) >= timestamp(adoption.at)),
    );
}
export function hasCurrentAnalysisRead(
  p: AnalysisReuseProject,
  role: ResearchRole,
  analysisId: string,
): boolean {
  try {
    decodeAnalysisReuseRecords(records(p), p);
    return !!currentRead(p, captureAnalysisNativeContext(p, role), analysisId);
  } catch {
    return false;
  }
}
/** Bind an already recorded, genuinely returned model review; never retimestamp or adopt an old review. */
export function recordAnalysisReviewContext(
  p: AnalysisReuseProject,
  context: AnalysisNativeContext,
  callId: string,
  reviewId: string,
  at: string,
): ResearchAnalysisReviewContext {
  timestamp(at);
  assertOwner(p, context);
  hostTime(p, context, at);
  decodeAnalysisReuseRecords(records(p), p);
  const review = p.analysisRegistry?.reviews.find((review) => review.id === reviewId);
  if (
    !["reviewer", "mentor"].includes(context.role) ||
    !review ||
    review.kind !== "interpretation-review" ||
    !review.runId ||
    review.actor !== `model:${context.role}` ||
    review.at !== at ||
    review.evidenceRef !== `tool:${callId}`
  )
    fail("只能绑定本次真实模型解释意见；旧审阅不能重包装");
  const read = currentRead(p, context, review.runId);
  if (!read || timestamp(read.at) > timestamp(at)) fail("本次native尚无当前结果的实际取得凭据");
  const prior = existingCall(p, context, callId);
  if (prior) {
    if (
      prior.kind !== "analysis-interpretation-context" ||
      prior.reviewId !== reviewId ||
      prior.reviewSha256 !== digest(review)
    )
      fail("审阅调用身份不能改写");
    return structuredClone(prior);
  }
  const receipt: ResearchAnalysisReviewContext = signed({
    id: identity("analysis-review-context", context, callId),
    kind: "analysis-interpretation-context" as const,
    at,
    callId,
    reviewId,
    reviewSha256: digest(review),
    context: structuredClone(context),
    runId: review.runId,
    runSha256: read.pin.runSha256,
    readId: read.id,
    ...(read.adoptionId ? { adoptionId: read.adoptionId } : {}),
  });
  decodeAnalysisReuseRecords(
    { ...records(p), analysisReviewContexts: [...(p.analysisReviewContexts ?? []), receipt] },
    p,
  );
  (p.analysisReviewContexts ??= []).push(receipt);
  return structuredClone(receipt);
}
/** Usable after B naturally finishes; it remains bound to B's current task/input epoch. */
export function hasCurrentAnalysisReviewContext(
  p: AnalysisReuseProject,
  reviewId: string,
): boolean {
  try {
    decodeAnalysisReuseRecords(records(p), p);
    const context = p.analysisReviewContexts?.find((entry) => entry.reviewId === reviewId);
    return (
      !!context &&
      contextExists(p, context.context, true) &&
      p.analysisReads?.some(
        (read) =>
          read.id === context.readId &&
          read.usableForCurrentInputs &&
          equal(read.context, context.context) &&
          currentResult(p, read.pin.runId) &&
          equal(read.pin, basis(p, read.pin.runId).pin) &&
          read.adoptionId === adoptionFor(p, read.pin.runId)?.id,
      ) === true
    );
  } catch {
    return false;
  }
}

/** A saved model review must cite a real read from that native, still valid for its task epoch. */
export function hasAnalysisReadForNativeReview(
  p: AnalysisReuseProject,
  owner: { role: ResearchRole; sessionId: string; nativeRunId: string; at: string },
  analysisId: string,
): boolean {
  try {
    decodeAnalysisReuseRecords(records(p), p);
    const pin = basis(p, analysisId).pin,
      adoption = adoptionFor(p, analysisId);
    return (
      currentResult(p, analysisId) &&
      (p.analysisReads ?? []).some(
        (read) =>
          read.usableForCurrentInputs &&
          read.pin.runId === analysisId &&
          equal(read.pin, pin) &&
          read.context.role === owner.role &&
          read.context.sessionId === owner.sessionId &&
          read.context.nativeRunId === owner.nativeRunId &&
          contextExists(p, read.context, true) &&
          timestamp(read.at) <= timestamp(owner.at) &&
          read.adoptionId === adoption?.id,
      )
    );
  } catch {
    return false;
  }
}
