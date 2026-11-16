import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import type { ResearchSource } from "../../contracts/research-evidence";
import type {
  ResearchClaimDepth,
  ResearchClaimSourceSnapshot,
} from "../../contracts/research-claims";
import {
  RESEARCH_LITERATURE_TOOL_OPERATIONS,
  decodeResearchLiteratureStrategyRequest,
  decodeResearchLiteratureToolState,
  type ResearchLiteratureHost,
  type ResearchLiteratureRecordReading,
  type ResearchLiteratureScreenRequest,
  type ResearchLiteratureStrategyRequest,
  type ResearchLiteratureToolOperation,
  type ResearchLiteratureToolScope,
  type ResearchLiteratureToolState,
} from "../../contracts/research-literature-search";
import {
  createResearchLiteratureAccessReceipt,
  createResearchLiteratureExecutionReceipt,
  createResearchLiteratureSearch,
  importResearchLiteratureRecords,
  locateResearchLiteratureRecord,
  recordResearchLiteratureAccess,
  recordResearchLiteratureExecution,
  registerResearchLiteratureStrategy,
  reportResearchLiteratureSearch,
  saveResearchLiteratureOriginal,
  screenResearchLiteratureRecord,
  stopResearchLiteratureSearch,
  RESEARCH_LITERATURE_BOUNDARY,
  type ResearchLiteratureAccessReceipt,
  type ResearchLiteratureBatchReceipt,
  type ResearchLiteratureReadingContext,
} from "./literature-search";
import { activeFusionAttempt } from "./fusion-task-runtime";
import { researchClaimSourceDepth } from "./claim-tools";
import {
  readPinnedResearchFile,
  researchHash,
  retrieveResearchSource,
  searchResearchSources,
} from "./materials";

export type LiteratureProject = ResearchProject & ResearchLiteratureToolState;
export const LITERATURE_OPERATIONS = RESEARCH_LITERATURE_TOOL_OPERATIONS;
/** Main-process injection seam for Node tests. Never filled from model arguments. */
export interface ResearchLiteratureToolHost {
  now?: () => string;
  search?: (query: string) => Promise<unknown>;
  fetch?: (input: Record<string, unknown>, directory: string) => Promise<ResearchSource>;
}
declare const preparedBrand: unique symbol;
export interface PreparedResearchLiteratureTool {
  readonly [preparedBrand]: true;
}
type Operation = ResearchLiteratureToolOperation;
interface PreparedData {
  projectId: string;
  workspacePath: string;
  scope: ResearchLiteratureToolScope;
  request: Record<string, unknown>;
  op?: Operation;
  replayId?: string;
  batch?: ResearchLiteratureBatchReceipt;
  access?: ResearchLiteratureAccessReceipt;
  reading?: ResearchLiteratureRecordReading;
  strategy?: ResearchLiteratureStrategyRequest;
  screen?: ResearchLiteratureScreenRequest;
  readingContext?: ResearchLiteratureReadingContext;
  sourcePins?: ResearchSource[];
}
const preparedData = new WeakMap<PreparedResearchLiteratureTool, PreparedData>();
// Unapplied observations are retained, never expired into a second external request.
const pending = new Map<
  string,
  { requestSha256: string; promise: Promise<PreparedResearchLiteratureTool> }
>();
const depthRank = { metadata: 0, abstract: 1, "partial-text": 2, "full-text": 3 };
const stages = ["literature", "scan", "search", "reading", "synthesis"];
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const digest = (value: unknown) => researchHash(JSON.stringify(canonical(value)));
const operationId = (p: LiteratureProject, role: ResearchRole, callId: string) =>
  `literature:${digest([p.id, role, callId])}`;
function object(value: unknown, keys?: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null) ||
    (keys && Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)))
  )
    throw new Error("检索请求含未知字段或宿主专有字段。");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("检索请求需要非空文本。");
  return value;
}
function integer(value: unknown, min = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < min)
    throw new Error("检索请求版本或序号无效。");
  return Number(value);
}
function request(input: Record<string, unknown>) {
  const kind = input.operation;
  if (!LITERATURE_OPERATIONS.some((name) => name === kind)) throw new Error("未知文献登记操作。");
  const keys: Record<string, string[]> = {
    "literature-context": [],
    "literature-strategy": ["strategy"],
    "literature-search": ["strategyId", "strategyVersion", "queryIndex"],
    "literature-import": ["strategyId", "strategyVersion", "materialId"],
    "literature-record": ["recordId"],
    "literature-fetch": ["recordId", "url"],
    "literature-screen": [
      "recordId",
      "strategyId",
      "strategyVersion",
      "decision",
      "reason",
      "requiredDepth",
    ],
    "literature-stop": ["strategyId", "strategyVersion", "reason", "remainingLimitations"],
  };
  object(input, ["operation", "executionModel", ...keys[String(kind)]!]);
  const { executionModel: ignored, ...raw } = input;
  void ignored; // Native attempt identity is authoritative, never this projection.
  const result = structuredClone(raw);
  if (kind === "literature-strategy") {
    const plan = object(result.strategy);
    if ("questionVersion" in plan) throw new Error("问题输入版本由宿主固定，不能自报。");
    const { questionVersion: unused, ...modelPlan } = decodeResearchLiteratureStrategyRequest({
      ...plan,
      questionVersion: "host-pending",
    });
    void unused;
    result.strategy = modelPlan;
  }
  if (keys[String(kind)]!.includes("strategyId")) {
    result.strategyId = text(result.strategyId);
    result.strategyVersion = integer(result.strategyVersion);
  }
  for (const key of ["recordId", "materialId", "reason", "url"])
    if (keys[String(kind)]!.includes(key)) result[key] = text(result[key]);
  if (kind === "literature-search") result.queryIndex = integer(result.queryIndex, 0);
  if (kind === "literature-screen") {
    if (!["include", "exclude", "undecided"].includes(String(result.decision)))
      throw new Error("纳排决定无效。");
    if (
      result.requiredDepth !== undefined &&
      !Object.hasOwn(depthRank, String(result.requiredDepth))
    )
      throw new Error("要求的阅读深度无效。");
  }
  if (kind === "literature-stop") {
    if (
      !Array.isArray(result.remainingLimitations) ||
      !result.remainingLimitations.length ||
      result.remainingLimitations.length > 100
    )
      throw new Error("停止必须保留剩余限制。");
    result.remainingLimitations.forEach((entry) => text(entry));
  }
  return result;
}
function state(p: LiteratureProject) {
  const saved = decodeResearchLiteratureToolState({
    literatureSearch: p.literatureSearch,
    literatureToolOperations: p.literatureToolOperations,
    literatureRecordReads: p.literatureRecordReads,
  });
  const ledger = saved.literatureSearch ?? createResearchLiteratureSearch();
  reportResearchLiteratureSearch(ledger); // Verify actual raw and candidate digests too.
  for (const op of saved.literatureToolOperations ?? []) {
    if (
      op.id !== operationId(p, op.scope.role, op.callId) ||
      op.scope.projectId !== p.id ||
      (op.strategy &&
        digest(
          ledger.strategies.find(
            (row) => row.id === op.strategy!.id && row.version === op.strategy!.version,
          ),
        ) !== op.strategy.sha256)
    )
      throw new Error("检索宿主调用或策略固定摘要不符。");
    if (op.material) {
      const batch = ledger.batches.find((row) => row.id === op.id);
      if (
        !batch ||
        batch.original.sha256 !== op.material.sha256 ||
        Buffer.from(batch.original.text, batch.original.encoding).byteLength !== op.material.bytes
      )
        throw new Error("实际导入字节与UI原件固定摘要或字节数不符。");
    }
  }
  return ledger;
}
/** Synchronous read-only persistence validation, including historical and paused projects. */
export function validateResearchLiteratureProject(p: LiteratureProject): void {
  state(p);
}
function owner(p: LiteratureProject, role: ResearchRole): ResearchLiteratureToolScope {
  const member = p.members.find((row) => row.role === role),
    attempt = activeFusionAttempt(p, role);
  const task = p.fusion?.tasks.find((row) => row.id === attempt?.taskId);
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.status !== "running" ||
    !member ||
    !attempt ||
    !task ||
    attempt.state !== "running" ||
    !attempt.nativeRunId ||
    !attempt.model ||
    task.role !== role ||
    attempt.taskVersion !== task.inputVersion ||
    !task.id.startsWith(`v${p.revision}:`)
  )
    throw new Error("检索操作需要当前输入版本的真实原生执行尝试。");
  const pins = new Map<string, ResearchLiteratureToolScope["inputs"][number]>();
  for (const ref of [...task.inputs, ...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])]) {
    const input = p.fusion!.inputs.find(
      (row) => row.inputId === ref.inputId && row.version === ref.version,
    );
    if (
      !input ||
      !p.fusion!.adoptedInputs.some(
        (row) => row.inputId === ref.inputId && row.version === ref.version,
      ) ||
      (pins.has(ref.inputId) && pins.get(ref.inputId)!.version !== ref.version)
    )
      throw new Error("检索尝试的实际输入已失效。");
    pins.set(ref.inputId, { inputId: ref.inputId, version: ref.version, digest: input.digest });
  }
  return {
    projectId: p.id,
    revision: p.revision,
    role,
    stage: task.stage,
    sessionId: member.ref.sessionId,
    taskId: task.id,
    taskVersion: task.inputVersion,
    attemptId: attempt.id,
    nativeRunId: attempt.nativeRunId,
    model: { provider: attempt.model.provider, modelId: attempt.model.modelId },
    inputs: [...pins.values()].sort((a, b) => a.inputId.localeCompare(b.inputId)),
  };
}
function scopeCurrent(p: LiteratureProject, scope: ResearchLiteratureToolScope) {
  const task = p.fusion?.tasks.find((row) => row.id === scope.taskId),
    attempt = p.fusion?.attempts.find((row) => row.id === scope.attemptId);
  return (
    p.id === scope.projectId &&
    p.revision === scope.revision &&
    task?.inputVersion === scope.taskVersion &&
    task.role === scope.role &&
    task.stage === scope.stage &&
    attempt?.nativeRunId === scope.nativeRunId &&
    attempt.taskVersion === scope.taskVersion &&
    attempt.model?.provider === scope.model.provider &&
    attempt.model.modelId === scope.model.modelId &&
    p.members.some((row) => row.role === scope.role && row.ref.sessionId === scope.sessionId) &&
    scope.inputs.every(
      (pin) =>
        p.fusion!.adoptedInputs.some(
          (row) => row.inputId === pin.inputId && row.version === pin.version,
        ) &&
        p.fusion!.inputs.some(
          (row) =>
            row.inputId === pin.inputId && row.version === pin.version && row.digest === pin.digest,
        ),
    )
  );
}
function hostFor(op: Operation): ResearchLiteratureHost {
  return {
    id: op.id,
    at: op.completedAt,
    actor: {
      kind: "model",
      id: `model:${op.scope.role}:${op.scope.model.provider}/${op.scope.model.modelId}`,
      sessionId: op.scope.sessionId,
      evidenceRef: `tool:${op.callId};native:${op.scope.nativeRunId};attempt:${op.scope.attemptId}`,
    },
  };
}
function currentReason(p: LiteratureProject, op: Operation): string | undefined {
  if (op.historical) return op.historyReason;
  if (!scopeCurrent(p, op.scope)) return "任务、原生执行身份或输入版本已变化。";
  if (op.strategy) {
    const plan = p.literatureSearch?.strategies.find(
      (row) => row.id === op.strategy!.id && row.version === op.strategy!.version,
    );
    if (
      !plan ||
      digest(plan) !== op.strategy.sha256 ||
      p.literatureSearch!.strategies.filter((row) => row.id === plan.id).at(-1)?.version !==
        plan.version
    )
      return "策略已更新；此记录仍属于原策略版本。";
  }
  if (
    op.record &&
    !p.literatureSearch?.records.some(
      (row) => row.id === op.record!.id && row.rawSha256 === op.record!.rawSha256,
    )
  )
    return "候选原记录版本已变化。";
  if (op.material) {
    const material = p.importedMaterials?.find((row) => row.id === op.material!.id);
    if (
      !material ||
      material.original !== op.material.original ||
      material.sha256 !== op.material.sha256 ||
      material.bytes !== op.material.bytes
    )
      return "已导入原件的固定版本已变化。";
  }
  if (
    op.fetchedSource &&
    p.literatureToolOperations?.some((entry) => entry.id === op.id) &&
    !p.evidence?.sources.some(
      (source) =>
        source.id === op.fetchedSource!.id &&
        source.sha256 === op.fetchedSource!.sha256 &&
        source.file === op.fetchedSource!.file,
    )
  )
    return "取得的来源已不属于当前固定来源版本。";
  if (op.operation === "literature-screen") {
    const screen = p.literatureSearch?.screenings.find((row) => row.host.id === op.id);
    if (
      screen?.readings.some(
        (read) =>
          !p.evidence?.sources.some(
            (source) =>
              source.id === read.sourceId &&
              source.sha256 === read.sourceSha256 &&
              depthRank[researchClaimSourceDepth(source)] >= depthRank[screen.depth],
          ) ||
          !p.sourceReads?.some(
            (actual) =>
              actual.id === read.readId &&
              actual.sourceSha256 === read.sourceSha256 &&
              actual.bodySha256 === read.bodySha256 &&
              actual.sessionId === op.scope.sessionId &&
              actual.start === read.start &&
              actual.end === read.end &&
              actual.depth === read.depth,
          ),
      )
    )
      return "筛选依据的实际读取或来源版本已变化。";
  }
  return undefined;
}
function independentDone(p: LiteratureProject, role: ResearchRole) {
  if (role !== "lead" && role !== "reviewer") return true;
  const attempt = activeFusionAttempt(p, role),
    stage = p.fusion?.tasks.find((row) => row.id === attempt?.taskId)?.stage ?? p.currentStage;
  return p.artifacts.some((artifact) => {
    if (
      artifact.role !== role ||
      artifact.revision !== p.revision ||
      artifact.stage !== stage ||
      artifact.kind !== (role === "lead" ? "stage-draft" : "stage-risk")
    )
      return false;
    const record = p.fusion?.artifacts.find((row) => row.id === artifact.id),
      task = p.fusion?.tasks.find((row) => row.id === record?.taskId);
    return (
      record &&
      task?.inputVersion === record.taskVersion &&
      record.content === artifact.content &&
      !["superseded", "needs-review"].includes(record.reviewState)
    );
  });
}
function canSeeJudgment(p: LiteratureProject, role: ResearchRole, id: string) {
  return (
    independentDone(p, role) ||
    p.literatureToolOperations?.some((op) => op.id === id && op.scope.role === role)
  );
}
export function researchLiteratureStatus(p: LiteratureProject, role: ResearchRole) {
  const ledger = state(p),
    report = reportResearchLiteratureSearch(ledger);
  const current = (id: string) => {
    const op = p.literatureToolOperations?.find((row) => row.id === id);
    return !!op && !currentReason(p, op);
  };
  return {
    strategies: ledger.strategies.map((plan) => ({
      ...plan,
      historical: !current(plan.recordedBy.id),
    })),
    batches: ledger.batches.map(({ original, ...batch }) => ({
      ...batch,
      original: {
        name: original.name,
        sha256: original.sha256,
        encoding: original.encoding,
        available: original.available,
      },
      historical: !current(batch.id),
    })),
    records: ledger.records.map(({ rawJson: _raw, ...record }) => record),
    accesses: ledger.accesses.map((row) => ({ ...row, historical: !current(row.host.id) })),
    screenings: ledger.screenings
      .filter((row) => canSeeJudgment(p, role, row.host.id))
      .map((row) => ({ ...row, historical: !current(row.host.id) })),
    stops: ledger.stops
      .filter((row) => canSeeJudgment(p, role, row.host.id))
      .map((row) => ({ ...row, historical: !current(row.host.id) })),
    counts: {
      allRecordedSearches: report.successfulSearches,
      allReturnedRecords: report.returnedRecords,
      allImportedRecords: report.importedRecords,
      currentSearches: ledger.batches.filter(
        (row) => row.origin === "execution" && row.status === "succeeded" && current(row.id),
      ).length,
      failedBatches: report.failures.length,
      failedAccesses: report.sourceAccessFailures.length,
      fetchedRecords: report.fetchedRecords,
      distinctGroups: report.groups.length,
    },
    materialIds: (p.importedMaterials ?? []).map(({ id, name, sha256, bytes }) => ({
      id,
      name,
      sha256,
      bytes,
    })),
    independentJudgmentsHidden: !independentDone(p, role),
    boundary: RESEARCH_LITERATURE_BOUNDARY,
    note: "历史数量包括旧版本，仅当前标记批次可用于本版本执行证明。使用literature-record实际读候选；正文仍用source-read。",
  };
}
function seal(data: PreparedData): PreparedResearchLiteratureTool {
  const result = Object.freeze({}) as PreparedResearchLiteratureTool;
  preparedData.set(result, data);
  return result;
}
function strategyPin(p: LiteratureProject, input: Record<string, unknown>) {
  const ledger = state(p),
    plan = ledger.strategies.find(
      (row) => row.id === input.strategyId && row.version === input.strategyVersion,
    );
  const recorded = plan && p.literatureToolOperations?.find((row) => row.id === plan.recordedBy.id);
  if (!plan || !recorded || currentReason(p, recorded))
    throw new Error("请先登记当前输入的有效检索策略版本；历史策略不能冒充当前。");
  return { plan, pin: { id: plan.id, version: plan.version, sha256: digest(plan) } };
}
async function privateDirectory(p: LiteratureProject) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(p.id)) throw new Error("项目存储身份无效。");
  let parent = await realpath(p.workspacePath);
  for (const part of [".lancer", "research-groups", p.id, "literature"]) {
    const requested = join(parent, part);
    await mkdir(requested, { recursive: true });
    const actual = await realpath(requested),
      inside = relative(parent, actual);
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("文献私有目录不能通过链接越界。");
    parent = actual;
  }
  return parent;
}
async function immutableBytes(directory: string, bytes: Buffer) {
  const file = join(directory, `${researchHash(bytes)}.json`);
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if (
      !(error && typeof error === "object" && "code" in error && error.code === "EEXIST") ||
      (await realpath(file)) !== file ||
      !(await readFile(file)).equals(bytes)
    )
      throw error;
  }
  return file;
}
function urls(raw: Record<string, unknown>): string[] {
  const values: unknown[] = [raw.url, raw.URL],
    doi = raw.doi ?? raw.DOI;
  if (typeof doi === "string" && /^10\.\d{4,9}\/\S+$/i.test(doi))
    values.push(`https://doi.org/${doi}`);
  for (const list of [raw.links, raw.link])
    if (Array.isArray(list))
      for (const link of list) {
        if (link && typeof link === "object") {
          const item = link as Record<string, unknown>;
          values.push(item.URL, item.url);
        }
      }
  return [
    ...new Set(
      values.flatMap((value) => {
        if (typeof value !== "string") return [];
        try {
          const url = new URL(value);
          return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
            ? [url.href]
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ];
}
function sourceMatches(
  p: LiteratureProject,
  recordId: string,
  source: ResearchSource,
  raw: Record<string, unknown>,
) {
  if (
    p.literatureSearch?.accesses.some(
      (access) =>
        access.recordId === recordId &&
        access.outcome.status === "fetched-text" &&
        access.outcome.sourceId === source.id &&
        access.outcome.sourceSha256 === source.sha256,
    )
  )
    return true;
  try {
    const url = new URL(source.url);
    url.hash = "";
    return urls(raw).some((candidate) => {
      const other = new URL(candidate);
      other.hash = "";
      return other.href === url.href;
    });
  } catch {
    return false;
  }
}
async function prepareScreen(p: LiteratureProject, data: PreparedData) {
  const op = data.op!,
    input = data.request,
    ledger = state(p),
    record = ledger.records.find((row) => row.id === op.record!.id)!;
  const raw = object(JSON.parse(record.rawJson));
  const context: ResearchLiteratureReadingContext = { sources: [], reads: [], recordSources: [] },
    sourcePins: ResearchSource[] = [];
  for (const source of p.evidence?.sources ?? []) {
    if (!sourceMatches(p, record.id, source, raw)) continue;
    const reads = (p.sourceReads ?? []).filter(
      (read) =>
        read.sourceId === source.id &&
        read.sourceSha256 === source.sha256 &&
        read.sessionId === op.scope.sessionId &&
        Date.parse(read.at) <= Date.parse(op.completedAt),
    );
    if (!reads.length) continue;
    try {
      const body = await readPinnedResearchFile(source),
        bodySha256 = researchHash(body),
        depth = researchClaimSourceDepth(source);
      const valid = reads.filter(
        (read) =>
          read.bodySha256 === bodySha256 &&
          read.locatorId === `text:${source.id}` &&
          read.start >= 0 &&
          read.end <= body.length &&
          read.end > read.start &&
          depthRank[read.depth] <= depthRank[depth],
      );
      if (!valid.length) continue;
      const snapshot: ResearchClaimSourceSnapshot = {
        id: source.id,
        sha256: source.sha256,
        body,
        bodySha256,
        available: true,
        locators: [
          { id: `text:${source.id}`, label: source.title, start: 0, end: body.length, depth },
        ],
      };
      context.sources.push(snapshot);
      context.reads.push(...valid);
      context.recordSources.push({ recordId: record.id, sourceId: source.id });
      sourcePins.push(structuredClone(source));
    } catch {
      /* Unavailable/changed originals cannot establish reading evidence. */
    }
  }
  const candidateReads = (p.literatureRecordReads ?? []).filter(
    (read) =>
      read.recordId === record.id &&
      read.rawSha256 === record.rawSha256 &&
      read.host.actor.sessionId === op.scope.sessionId &&
      Date.parse(read.host.at) <= Date.parse(op.completedAt) &&
      p.literatureToolOperations?.some(
        (operation) => operation.id === read.id && !currentReason(p, operation),
      ),
  );
  const covered = new Set(
    context.sources
      .filter((source) => {
        if (source.locators[0]?.depth !== "full-text") return false;
        let end = 0;
        for (const read of context.reads
          .filter((entry) => entry.sourceId === source.id && entry.depth === "full-text")
          .sort((a, b) => a.start - b.start)) {
          if (read.start > end) return false;
          end = Math.max(end, read.end);
        }
        return end === source.body.length;
      })
      .map((source) => source.id),
  );
  const actualDepth = Math.max(
    -1,
    ...context.reads.map((read) =>
      read.depth === "full-text" && !covered.has(read.sourceId) ? 2 : depthRank[read.depth],
    ),
    ...candidateReads.map((read) => depthRank[read.depth]),
  );
  const requested = input.requiredDepth as ResearchClaimDepth | undefined;
  if (actualDepth < 0 || (requested !== undefined && depthRank[requested] > actualDepth))
    throw new Error("筛选缺少本人实际读取凭据，或要求深度超出当前可核验范围；获取不等于阅读。");
  const depth =
    requested ??
    (Object.keys(depthRank) as ResearchClaimDepth[]).find(
      (name) => depthRank[name] === actualDepth,
    )!;
  const readIds = context.reads
    .filter(
      (read) =>
        depthRank[read.depth] >= depthRank[depth] &&
        (depth !== "full-text" || covered.has(read.sourceId)),
    )
    .map((read) => read.id);
  data.screen = {
    recordId: record.id,
    strategyId: op.strategy!.id,
    strategyVersion: op.strategy!.version,
    decision: input.decision as ResearchLiteratureScreenRequest["decision"],
    reason: String(input.reason),
    depth,
    readIds,
  };
  context.reads = context.reads.filter((read) => readIds.includes(read.id));
  context.sources = context.sources.filter((source) =>
    context.reads.some((read) => read.sourceId === source.id),
  );
  context.recordSources = context.recordSources.filter((link) =>
    context.sources.some((source) => source.id === link.sourceId),
  );
  data.readingContext = context;
  data.sourcePins = sourcePins.filter((pin) =>
    context.sources.some((source) => source.id === pin.id),
  );
  if (readIds.length)
    op.sourceChecks = context.sources
      .filter((source) =>
        context.reads.some((read) => read.sourceId === source.id && readIds.includes(read.id)),
      )
      .map((source) => ({
        sourceId: source.id,
        sourceSha256: source.sha256,
        bodySha256: source.bodySha256,
        characters: source.body.length,
        depth: source.locators[0]!.depth,
      }));
  screenResearchLiteratureRecord(ledger, data.screen, hostFor(op), context);
}

/** LOCK OUTSIDE: network/file IO uses a detached snapshot. The returned token is host-only. */
export async function prepareResearchLiteratureTool(
  p: LiteratureProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  actualHost: ResearchLiteratureToolHost = {},
): Promise<PreparedResearchLiteratureTool> {
  text(callId, 1000);
  const normalized = request(input),
    id = operationId(p, role, callId),
    requestSha256 = digest(normalized);
  state(p);
  const prior = p.literatureToolOperations?.find((row) => row.id === id);
  if (prior) {
    if (prior.requestSha256 !== requestSha256)
      throw new Error("同一宿主调用身份不能用于不同请求。");
    return seal({
      projectId: p.id,
      workspacePath: p.workspacePath,
      scope: prior.scope,
      request: normalized,
      replayId: id,
    });
  }
  const existing = pending.get(id);
  if (existing) {
    if (existing.requestSha256 !== requestSha256)
      throw new Error("同一宿主调用身份正在执行不同请求。");
    return existing.promise;
  }
  const scope = owner(p, role);
  if (
    !["literature-context", "literature-record", "literature-screen"].includes(
      String(normalized.operation),
    ) &&
    (role !== "librarian" || !stages.includes(scope.stage))
  )
    throw new Error("检索策略、执行、导入、获取与停止由文献阶段资料员操作。");
  const snapshot = structuredClone(p);
  if (normalized.operation === "literature-context")
    return seal({ projectId: p.id, workspacePath: p.workspacePath, scope, request: normalized });
  if (pending.size >= 64) throw new Error("待保存的文献操作已达上限；请先保存已有真实结果。");
  const work = prepareActual(snapshot, scope, callId, normalized, requestSha256, actualHost);
  pending.set(id, { requestSha256, promise: work });
  try {
    return await work;
  } catch (error) {
    pending.delete(id);
    throw error;
  }
}
async function prepareActual(
  p: LiteratureProject,
  scope: ResearchLiteratureToolScope,
  callId: string,
  input: Record<string, unknown>,
  requestSha256: string,
  actual: ResearchLiteratureToolHost,
) {
  const clock = actual.now ?? (() => new Date().toISOString()),
    at = clock();
  if (!Number.isFinite(Date.parse(at))) throw new Error("宿主时间无效。");
  const op: Operation = {
    id: operationId(p, scope.role, callId),
    callId,
    operation: input.operation as Operation["operation"],
    requestSha256,
    scope,
    startedAt: at,
    completedAt: at,
    historical: false,
  };
  const data: PreparedData = {
      projectId: p.id,
      workspacePath: p.workspacePath,
      scope,
      request: input,
      op,
    },
    ledger = state(p);
  if (
    ["literature-search", "literature-import", "literature-screen", "literature-stop"].includes(
      op.operation,
    )
  )
    op.strategy = strategyPin(p, input).pin;
  if (["literature-record", "literature-fetch", "literature-screen"].includes(op.operation)) {
    const record = locateResearchLiteratureRecord(ledger, String(input.recordId)).record;
    op.record = { id: record.id, rawSha256: record.rawSha256 };
  }
  if (op.operation === "literature-strategy") {
    data.strategy = decodeResearchLiteratureStrategyRequest({
      ...object(input.strategy),
      questionVersion: `project:${p.id}:revision:${scope.revision}:inputs:${digest(scope.inputs)}`,
    });
    const next = registerResearchLiteratureStrategy(ledger, data.strategy, hostFor(op));
    op.strategy = {
      id: data.strategy.id,
      version: data.strategy.version,
      sha256: digest(next.strategies.at(-1)),
    };
  } else if (op.operation === "literature-search") {
    const plan = strategyPin(p, input).plan,
      queryPlan = plan.queries[Number(input.queryIndex)];
    if (!queryPlan) throw new Error("计划查询序号不存在。");
    if (!/^crossref$/i.test(queryPlan.source.trim()))
      throw new Error("当前真实检索连接仅支持Crossref；其他数据库不能冒称已执行。");
    const query = queryPlan.query.slice(0, 300),
      endpoint = `https://api.crossref.org/works?rows=5&query.bibliographic=${encodeURIComponent(query)}`;
    let outcome: { status: "succeeded"; records: unknown[] } | { status: "failed"; error: string };
    try {
      const result = object(await (actual.search ?? searchResearchSources)(query));
      if (!Array.isArray(result.candidates) || result.candidates.length > 5)
        throw new Error("真实检索连接未返回有效的最多5条候选列表。");
      result.candidates.forEach((row) => object(row));
      outcome = { status: "succeeded", records: result.candidates };
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    op.completedAt = clock();
    data.batch = createResearchLiteratureExecutionReceipt({
      host: hostFor(op),
      query,
      endpoint,
      startedAt: op.startedAt,
      completedAt: op.completedAt,
      outcome,
      limitations: [
        "Crossref bibliographic查询最多返回5条；仅固定实际返回候选的JSON字节，不是完整HTTP原响应或数据库覆盖。",
        "未执行年份、语言、文献类型等服务端过滤；策略filters仅是计划声明。",
        ...(queryPlan.query.length > 300 ? ["实际检索式按现有连接截为前300个UTF-16字符。"] : []),
      ],
    });
  } else if (op.operation === "literature-import") {
    const material = p.importedMaterials?.find((row) => row.id === input.materialId);
    if (!material) throw new Error("只能使用UI已经导入的材料ID，不能指定私有路径。");
    const info = await stat(material.original);
    if (!info.isFile() || info.size > 10_000_000)
      throw new Error("检索原件不是普通文件或超过10MB。");
    const bytes = await readFile(material.original);
    if (
      bytes.length > 10_000_000 ||
      bytes.length !== material.bytes ||
      researchHash(bytes) !== material.sha256
    )
      throw new Error("UI已导入原件的实际字节已变化；不能冒充固定版本。");
    op.material = {
      id: material.id,
      name: material.name,
      original: material.original,
      sha256: material.sha256,
      bytes: material.bytes,
    };
    const copy = await immutableBytes(await privateDirectory(p), bytes);
    // The pure importer records one host checkpoint, not an invented import duration.
    op.startedAt = op.completedAt = clock();
    data.batch = await importResearchLiteratureRecords(copy, hostFor(op), [
      "来自用户已经导入的实际JSON字节；不证明本宿主访问过原数据库。",
      "只支持记录数组、candidates或Crossref message.items；重复项保留。",
    ]);
  } else if (op.operation === "literature-record") {
    const raw = object(JSON.parse(ledger.records.find((row) => row.id === op.record!.id)!.rawJson));
    data.reading = {
      id: op.id,
      recordId: op.record!.id,
      rawSha256: op.record!.rawSha256,
      depth: typeof raw.abstract === "string" && raw.abstract.trim() ? "abstract" : "metadata",
      host: hostFor(op),
    };
  } else if (op.operation === "literature-fetch") {
    if ((p.evidence?.sources.length ?? 0) >= 40) throw new Error("最多登记40个来源。");
    const raw = object(JSON.parse(ledger.records.find((row) => row.id === op.record!.id)!.rawJson)),
      url = new URL(String(input.url)).href;
    if (!urls(raw).includes(url)) throw new Error("获取URL必须来自该候选实际返回的URL或links。");
    let outcome:
      | { status: "fetched-text"; sourceId: string; sourceSha256: string }
      | { status: "failed"; error: string };
    try {
      const directory = await privateDirectory(p),
        title = Array.isArray(raw.title)
          ? raw.title.filter((value): value is string => typeof value === "string").join("; ")
          : raw.title;
      const authors =
        typeof raw.authors === "string"
          ? raw.authors
          : Array.isArray(raw.author)
            ? raw.author
                .map((value) => {
                  const author = object(value);
                  return [author.given, author.family]
                    .filter((v) => typeof v === "string")
                    .join(" ");
                })
                .join("; ")
            : "候选未提供作者";
      const published =
        raw.published && typeof raw.published === "object"
          ? (raw.published as Record<string, unknown>)
          : undefined;
      const dates = published?.["date-parts"],
        year =
          Array.isArray(dates) && Array.isArray(dates[0]) ? (dates[0][0] as unknown) : undefined;
      const source = await (actual.fetch ?? retrieveResearchSource)(
        {
          url,
          title:
            typeof title === "string" && title.trim() ? title.slice(0, 1000) : "候选未提供题名",
          authors: authors.slice(0, 2000) || "候选未提供作者",
          year:
            typeof raw.year === "string"
              ? raw.year.slice(0, 40)
              : Number.isSafeInteger(year)
                ? String(year)
                : "候选未提供年份",
        },
        directory,
      );
      const sourceFile = await realpath(source.file),
        part = relative(directory, sourceFile);
      if (
        !part ||
        part.startsWith("..") ||
        isAbsolute(part) ||
        source.kind !== "paper" ||
        source.access !== "retrieved-text"
      )
        throw new Error("获取结果不是宿主私有目录内的实际来源。");
      await readPinnedResearchFile(source);
      op.fetchedSource = {
        id: source.id,
        title: source.title,
        authors: source.authors,
        year: source.year,
        url: source.url,
        file: source.file,
        sha256: source.sha256,
        kind: "paper",
        access: "retrieved-text",
      };
      outcome = { status: "fetched-text", sourceId: source.id, sourceSha256: source.sha256 };
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    op.completedAt = clock();
    data.access = createResearchLiteratureAccessReceipt({
      recordId: op.record!.id,
      url,
      host: hostFor(op),
      outcome,
    });
  } else if (op.operation === "literature-screen") await prepareScreen(p, data);
  else if (op.operation === "literature-stop")
    stopResearchLiteratureSearch(
      ledger,
      {
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        reason: input.reason,
        remainingLimitations: input.remainingLimitations,
      },
      hostFor(op),
    );
  if (data.batch) {
    const next = recordResearchLiteratureExecution(ledger, op.strategy!, data.batch),
      batch = next.batches.find((row) => row.id === op.id)!;
    if (batch.original.available) {
      try {
        await saveResearchLiteratureOriginal(await privateDirectory(p), batch);
      } catch (error) {
        op.archiveError = `独立原件副本保存失败；实际字节仍保留在私有登记记录：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return seal(data);
}
function resultFor(p: LiteratureProject, op: Operation) {
  const ledger = state(p),
    historyReason = currentReason(p, op);
  const common = {
    operationId: op.id,
    historical: !!historyReason,
    ...(historyReason ? { historyReason } : {}),
    ...(op.archiveError ? { archiveError: op.archiveError } : {}),
    boundary: RESEARCH_LITERATURE_BOUNDARY,
  };
  if (op.operation === "literature-strategy")
    return {
      ...common,
      strategy: ledger.strategies.find(
        (row) => row.id === op.strategy!.id && row.version === op.strategy!.version,
      ),
    };
  if (op.operation === "literature-search" || op.operation === "literature-import") {
    const batch = ledger.batches.find((row) => row.id === op.id)!,
      { original, ...summary } = batch;
    return {
      ...common,
      batch: {
        ...summary,
        original: {
          name: original.name,
          sha256: original.sha256,
          available: original.available,
          encoding: original.encoding,
        },
      },
      records: ledger.records
        .filter((row) => row.batchId === op.id)
        .map(({ rawJson: _raw, ...record }) => record),
      note: "本操作没有登记模型阅读。请literature-record读取候选，source-read读取正文。",
    };
  }
  if (op.operation === "literature-record") {
    const { record, batch, duplicateRecordIds } = locateResearchLiteratureRecord(
        ledger,
        op.record!.id,
      ),
      origin = p.literatureToolOperations?.find((row) => row.id === batch.id);
    return {
      ...common,
      record,
      raw: JSON.parse(record.rawJson) as unknown,
      duplicateRecordIds,
      originHistorical: !origin || !!currentReason(p, origin),
      reading: p.literatureRecordReads!.find((row) => row.id === op.id),
    };
  }
  if (op.operation === "literature-fetch") {
    const source = op.fetchedSource,
      publicSource = source && {
        id: source.id,
        title: source.title,
        authors: source.authors,
        year: source.year,
        url: source.url,
        sha256: source.sha256,
        kind: source.kind,
        access: source.access,
      };
    return {
      ...common,
      access: ledger.accesses.find((row) => row.host.id === op.id),
      ...(publicSource ? { source: publicSource } : {}),
      note: "获取仅代表取得文本，不代表模型已读；历史获取不会加入当前来源。",
    };
  }
  return {
    ...common,
    ...(op.operation === "literature-screen"
      ? { screening: ledger.screenings.find((row) => row.host.id === op.id) }
      : { stop: ledger.stops.find((row) => row.host.id === op.id) }),
  };
}
/** LOCK INSIDE: synchronous merge into the latest owned draft. No network or filesystem IO. */
export function applyPreparedResearchLiteratureTool(
  p: LiteratureProject,
  prepared: PreparedResearchLiteratureTool,
): { result: unknown; detail?: string } {
  const data = preparedData.get(prepared);
  if (!data || p.id !== data.projectId || p.workspacePath !== data.workspacePath)
    throw new Error("只能应用本项目的宿主准备凭据。");
  const ledger = state(p),
    id = data.replayId ?? data.op?.id,
    prior = id && p.literatureToolOperations?.find((row) => row.id === id);
  if (prior) {
    if (prior.requestSha256 !== digest(data.request)) throw new Error("同一宿主调用身份不能重写。");
    pending.delete(prior.id);
    return { result: resultFor(p, prior), detail: "已保存调用重放，保留原始执行身份与版本。" };
  }
  if (data.replayId) throw new Error("原宿主调用记录已缺失，不能重新执行或伪造重放。");
  let ownerChanged = false;
  try {
    ownerChanged = !isDeepStrictEqual(owner(p, data.scope.role), data.scope);
  } catch {
    ownerChanged = true;
  }
  if (!data.op) {
    if (ownerChanged) throw new Error("读取期间当前任务已变化，请读取最新状态。");
    return { result: researchLiteratureStatus(p, data.scope.role) };
  }
  const op = structuredClone(data.op);
  let reason = ownerChanged
    ? "真实操作完成时，原生执行尝试或输入版本已经变化。"
    : currentReason(p, op);
  // This new strategy cannot be found in the ledger until this very mutation.
  if (op.operation === "literature-strategy" && !ownerChanged && scopeCurrent(p, op.scope))
    reason = undefined;
  if (
    data.sourcePins?.some(
      (pin) => !p.evidence?.sources.some((source) => isDeepStrictEqual(source, pin)),
    ) ||
    data.readingContext?.reads.some(
      (read) => !p.sourceReads?.some((current) => isDeepStrictEqual(current, read)),
    )
  )
    reason = "准备期间来源或实际读取凭据已变化。";
  if (op.fetchedSource && (p.evidence?.sources.length ?? 0) >= 40)
    reason = "获取完成时当前来源已达上限；实际结果保留为历史。";
  if (reason) {
    op.historical = true;
    op.historyReason = reason;
  }
  let next = ledger;
  if (data.strategy) next = registerResearchLiteratureStrategy(next, data.strategy, hostFor(op));
  else if (data.batch) next = recordResearchLiteratureExecution(next, op.strategy!, data.batch);
  else if (data.access) next = recordResearchLiteratureAccess(next, data.access);
  else if (data.screen)
    next = screenResearchLiteratureRecord(next, data.screen, hostFor(op), data.readingContext!);
  else if (op.operation === "literature-stop")
    next = stopResearchLiteratureSearch(
      next,
      {
        strategyId: data.request.strategyId,
        strategyVersion: data.request.strategyVersion,
        reason: data.request.reason,
        remainingLimitations: data.request.remainingLimitations,
      },
      hostFor(op),
    );
  const merged = decodeResearchLiteratureToolState({
    literatureSearch: next,
    literatureToolOperations: [...(p.literatureToolOperations ?? []), op],
    literatureRecordReads: [
      ...(p.literatureRecordReads ?? []),
      ...(data.reading ? [data.reading] : []),
    ],
  });
  if (op.fetchedSource && !op.historical) {
    const duplicate = p.evidence?.sources.find((source) => source.id === op.fetchedSource!.id);
    if (duplicate && !isDeepStrictEqual(duplicate, op.fetchedSource))
      throw new Error("获取来源身份冲突；旧来源保留。");
    if (!duplicate)
      (p.evidence ??= { directory: "", sources: [], datasets: [] }).sources.push(
        structuredClone(op.fetchedSource),
      );
  }
  Object.assign(p, merged);
  pending.delete(op.id);
  return {
    result: resultFor(p, op),
    detail: op.historical
      ? "真实操作保留为历史，未采用为当前版本证明。"
      : "已登记真实宿主操作与固定版本；内容判断仍需模型审阅。",
  };
}
