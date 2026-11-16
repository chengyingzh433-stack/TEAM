import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESEARCH_ROLES, type ResearchRole } from "../../contracts/research-group";
import { decodeResearchLiteratureToolState } from "../../contracts/research-literature-search";
import {
  prepareResearchLiteratureTool,
  applyPreparedResearchLiteratureTool,
  researchLiteratureStatus,
  validateResearchLiteratureProject,
  type LiteratureProject,
  type ResearchLiteratureToolHost,
} from "../../electron/research-group/literature-search-tools";
import {
  createResearchTaskGraph,
  addResearchTask,
  startResearchTask,
  markResearchTaskDispatched,
  setResearchInput,
  applyResearchChange,
} from "../../electron/research-group/task-graph";
import { researchHash } from "../../electron/research-group/materials";
import { publishFusionArtifact } from "../../electron/research-group/fusion-task-runtime";

// Node-only host transport fixtures; these are not actual Crossref requests or research findings.
const epoch = Date.UTC(2026, 10, 7, 0, 0, 0);
const time = (n: number) => new Date(epoch + n * 1000).toISOString();
const strategy = {
  id: "scan",
  version: 1,
  question: "合成检索接口验收",
  concepts: ["absence"],
  synonyms: ["absenteeism"],
  queries: [
    {
      source: "Crossref",
      query: "absence " + "q".repeat(350),
      filters: "计划限制为2020以后；当前连接不执行该限制",
    },
  ],
  inclusionCriteria: ["合成教育研究"],
  exclusionCriteria: ["非相关主题"],
  stopRule: "说明本轮范围与剩余限制",
  changeReason: "初次登记",
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "literature-tools-"));
  const p: LiteratureProject = {
    id: randomUUID(),
    root: { workspaceId: directory, sessionId: "mentor-session" },
    workspacePath: directory,
    objective: "合成软件验收，不是实际研究",
    revision: 1,
    status: "running",
    createdAt: time(0),
    updatedAt: time(0),
    workflowVersion: "fusion-v2",
    methodVersion: "2.0.0",
    entry: "materials",
    goal: "paper",
    path: "review",
    scope: "paper",
    currentStage: "search",
    knowledge: { directory, sha256: "fixture", version: "fixture", count: 0 },
    members: RESEARCH_ROLES.map((role) => ({
      role,
      ref: { workspaceId: directory, sessionId: `${role}-session` },
      status: "running",
    })),
    artifacts: [],
    packets: [],
    events: [],
    sourceReads: [],
    evidence: { directory, sources: [], datasets: [] },
  };
  p.fusion = createResearchTaskGraph(p.id, "2.0.0");
  p.fusion = setResearchInput(p.fusion, {
    inputId: "question",
    version: 1,
    kind: "context",
    availability: "available",
    actual: false,
    label: "题目",
    sourceRef: "fixture:question",
    digest: researchHash("question-v1"),
  });
  p.fusion = applyResearchChange(p.fusion, {
    id: "adopt-question",
    at: time(0),
    inputId: "question",
    fromVersion: null,
    toVersion: 1,
    reason: "合成问题",
    authorizedBy: "existing-authorization",
    authorizationRef: "fixture",
  });
  for (const role of RESEARCH_ROLES) {
    const taskId = `v1:search:${role}`;
    p.fusion = addResearchTask(p.fusion, {
      id: taskId,
      stage: "search",
      role,
      kind: "research",
      goal: "检索适配验收",
      inputs: [{ inputId: "question", version: 1, requirement: "available" }],
      dependencies: [],
      earlyHandoff: "批次",
      deliverable: "可追溯记录",
      reviewRequired: true,
      writeScope: [`literature/${role}`],
    });
    p.fusion = startResearchTask(p.fusion, taskId, {
      id: `attempt-${role}`,
      at: time(0),
      reservedTokens: 0,
      model: { provider: "fixture", modelId: role },
    });
    p.fusion = markResearchTaskDispatched(p.fusion, `attempt-${role}`, time(0));
    p.fusion.attempts.find((row) => row.id === `attempt-${role}`)!.nativeRunId = `native-${role}`;
  }
  let tick = 1;
  const host: ResearchLiteratureToolHost = {
    now: () => time(tick++),
    search: async () => ({
      candidates: [
        { doi: "10.1234/test", title: ["Synthetic"], url: "https://example.test/article" },
      ],
    }),
  };
  return { p, host, directory };
}
async function call(
  p: LiteratureProject,
  host: ResearchLiteratureToolHost,
  id: string,
  input: Record<string, unknown>,
  role: ResearchRole = "librarian",
) {
  return applyPreparedResearchLiteratureTool(
    p,
    await prepareResearchLiteratureTool(p, role, id, input, host),
  );
}
async function register(p: LiteratureProject, host: ResearchLiteratureToolHost) {
  await call(p, host, "strategy", { operation: "literature-strategy", strategy });
}
const searchInput = {
  operation: "literature-search",
  strategyId: "scan",
  strategyVersion: 1,
  queryIndex: 0,
};

test("actual bounded queries are recorded once; applied and in-flight retries cannot repeat the search", async () => {
  const { p, host } = await fixture();
  await register(p, host);
  expect(p.literatureSearch!.batches).toHaveLength(0);
  const queries: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.search = async (query) => {
    queries.push(query);
    await waiting;
    return {
      candidates: [
        { doi: "10.1234/test", title: ["Synthetic"], url: "https://example.test/article" },
      ],
    };
  };
  const first = prepareResearchLiteratureTool(p, "librarian", "query", searchInput, host);
  const retry = prepareResearchLiteratureTool(p, "librarian", "query", searchInput, host);
  release();
  const prepared = await first;
  expect(await retry).toBe(prepared);
  applyPreparedResearchLiteratureTool(p, prepared);
  p.status = "paused";
  await call(p, host, "query", searchInput);
  expect(queries).toEqual([strategy.queries[0]!.query.slice(0, 300)]);
  expect(p.literatureSearch!.batches).toHaveLength(1);
  expect(p.literatureSearch!.batches[0]!.endpoint).toBe(
    `https://api.crossref.org/works?rows=5&query.bibliographic=${encodeURIComponent(queries[0]!)}`,
  );
  expect(p.literatureSearch!.batches[0]!.representation).toBe("returned-candidate-metadata");
  expect(p.literatureRecordReads ?? []).toEqual([]);
  await expect(call(p, host, "query", { ...searchInput, queryIndex: 1 })).rejects.toThrow(
    /同一|身份/,
  );
});

test("late execution appends history and merges intervening batches without making it current", async () => {
  const { p, host } = await fixture();
  await register(p, host);
  const late = await prepareResearchLiteratureTool(p, "librarian", "late", searchInput, host);
  await call(p, host, "other", searchInput);
  p.fusion!.tasks.find((row) => row.role === "librarian")!.inputVersion++;
  const result = applyPreparedResearchLiteratureTool(p, late);
  expect(result.result).toMatchObject({ historical: true });
  expect(p.literatureSearch!.batches).toHaveLength(2);
  expect(p.literatureSearch!.records).toHaveLength(2);
  expect(p.literatureToolOperations!.find((row) => row.callId === "late")!.historical).toBe(true);
  expect(p.evidence!.sources).toEqual([]);
});

test("UI-imported pinned bytes survive invalid JSON as a failed batch and duplicate records stay intact", async () => {
  const { p, host, directory } = await fixture();
  await register(p, host);
  const original = join(directory, "records.json"),
    bad = "{invalid json\n";
  await writeFile(original, bad);
  p.importedMaterials = [
    {
      id: "imported",
      name: "records.json",
      sha256: researchHash(bad),
      bytes: Buffer.byteLength(bad),
      importedAt: time(0),
      original,
      parsed: join(directory, "parse.json"),
      parserVersion: "fixture",
      duplicate: false,
      metadata: {},
      status: "failed",
      locations: [],
      tables: [],
      warnings: [],
      error: "JSON不是通用材料解析格式",
    },
  ];
  await call(p, host, "bad-import", {
    operation: "literature-import",
    strategyId: "scan",
    strategyVersion: 1,
    materialId: "imported",
  });
  const batch = p.literatureSearch!.batches[0]!;
  expect(batch.status).toBe("failed");
  expect(batch.original.text).toBe(bad);
  expect(batch.original.sha256).toBe(researchHash(bad));
  expect(batch.recordIds).toEqual([]);
  expect(await readFile(original, "utf8")).toBe(bad);
  expect(
    decodeResearchLiteratureToolState({
      literatureSearch: p.literatureSearch,
      literatureToolOperations: p.literatureToolOperations,
      literatureRecordReads: p.literatureRecordReads,
    }),
  ).toMatchObject({ literatureSearch: p.literatureSearch });
  await expect(
    call(p, host, "spoof-path", {
      operation: "literature-import",
      strategyId: "scan",
      strategyVersion: 1,
      materialId: "imported",
      file: "/private/other.json",
    }),
  ).rejects.toThrow(/字段|宿主/);
  const good =
    JSON.stringify(
      [
        { doi: "10.1234/duplicate", title: "A" },
        { doi: "10.1234/duplicate", title: "Different title" },
        { title: "A", url: "https://example.test/other" },
      ],
      null,
      2,
    ) + "\n";
  const goodFile = join(directory, "good.json");
  await writeFile(goodFile, good);
  p.importedMaterials.push({
    ...p.importedMaterials[0]!,
    id: "good",
    name: "good.json",
    original: goodFile,
    sha256: researchHash(good),
    bytes: Buffer.byteLength(good),
  });
  await call(p, host, "good-import", {
    operation: "literature-import",
    strategyId: "scan",
    strategyVersion: 1,
    materialId: "good",
  });
  expect(p.literatureSearch!.records).toHaveLength(3);
  expect(researchLiteratureStatus(p, "librarian")).toMatchObject({
    counts: { allImportedRecords: 3, failedBatches: 1, distinctGroups: 2 },
  });
  expect(
    await readFile(
      join(
        directory,
        ".lancer",
        "research-groups",
        p.id,
        "literature",
        `${researchHash(good)}.json`,
      ),
      "utf8",
    ),
  ).toBe(good);
  expect(await readFile(original, "utf8")).toBe(bad);
});

test("host identity, role-owned stage and sealed receipts cannot be replaced by model fields", async () => {
  const { p, host } = await fixture();
  p.currentStage = "writing"; // The librarian still owns its live search task.
  await register(p, host);
  const op = p.literatureToolOperations![0]!;
  expect(op.scope).toMatchObject({
    role: "librarian",
    stage: "search",
    nativeRunId: "native-librarian",
    model: { provider: "fixture", modelId: "librarian" },
  });
  for (const field of [
    { actor: { kind: "user" } },
    { sha256: "a".repeat(64) },
    { at: time(99) },
    { depth: "full-text" },
    { readIds: [] },
  ]) {
    await expect(
      call(p, host, `spoof-${Object.keys(field)[0]}`, { ...searchInput, ...field }),
    ).rejects.toThrow(/字段|宿主/);
  }
  await expect(call(p, host, "wrong-role", searchInput, "reviewer")).rejects.toThrow("资料员");
  await expect(
    call(p, host, "question-spoof", {
      operation: "literature-strategy",
      strategy: { ...strategy, version: 2, questionVersion: "human-approved" },
    }),
  ).rejects.toThrow("宿主");
  expect(() =>
    applyPreparedResearchLiteratureTool(
      p,
      JSON.parse("{}") as Awaited<ReturnType<typeof prepareResearchLiteratureTool>>,
    ),
  ).toThrow("宿主");
  p.fusion!.attempts.find((row) => row.id === "attempt-librarian")!.nativeRunId = undefined;
  await expect(call(p, host, "missing-native", searchInput)).rejects.toThrow("原生");
});

test("search/fetch never count as reading; failed access and late fetched originals remain separate", async () => {
  const { p, host } = await fixture();
  await register(p, host);
  await call(p, host, "query", searchInput);
  const recordId = p.literatureSearch!.records[0]!.id;
  const screen = {
    operation: "literature-screen",
    recordId,
    strategyId: "scan",
    strategyVersion: 1,
    decision: "include",
    reason: "合成筛选理由",
  };
  await expect(call(p, host, "no-read", screen)).rejects.toThrow("实际读取");
  host.fetch = async () => {
    throw new Error("synthetic HTTP 403");
  };
  await call(p, host, "fetch-failed", {
    operation: "literature-fetch",
    recordId,
    url: "https://example.test/article",
  });
  expect(p.literatureSearch!.accesses[0]!.outcome).toEqual({
    status: "failed",
    error: "synthetic HTTP 403",
  });
  host.fetch = async (input, directory) => {
    const file = join(directory, "fetched.txt"),
      body = "Actual synthetic text ".repeat(30);
    await writeFile(file, body);
    return {
      id: "S-fetched",
      file,
      sha256: researchHash(body),
      title: String(input.title),
      authors: String(input.authors),
      year: String(input.year),
      url: String(input.url),
      kind: "paper",
      access: "retrieved-text",
    };
  };
  const late = await prepareResearchLiteratureTool(
    p,
    "librarian",
    "late-fetch",
    { operation: "literature-fetch", recordId, url: "https://example.test/article" },
    host,
  );
  p.status = "paused";
  expect(applyPreparedResearchLiteratureTool(p, late).result).toMatchObject({
    historical: true,
    access: { outcome: { status: "fetched-text" } },
  });
  expect(p.evidence!.sources).toEqual([]);
  expect(p.literatureToolOperations!.at(-1)!.fetchedSource!.sha256).toBe(
    researchHash(await readFile(p.literatureToolOperations!.at(-1)!.fetchedSource!.file)),
  );
  expect(p.literatureSearch!.batches).toHaveLength(1);
  expect(p.literatureRecordReads).toEqual([]);
  p.status = "running";
  expect(
    (
      await call(p, host, "current-fetch", {
        operation: "literature-fetch",
        recordId,
        url: "https://example.test/article",
      })
    ).result,
  ).toMatchObject({ historical: false });
  expect(p.evidence!.sources).toHaveLength(1);
  await expect(call(p, host, "fetch-not-read", screen)).rejects.toThrow("实际读取");
  p.evidence!.sources[0]!.sha256 = researchHash("replacement");
  expect(researchLiteratureStatus(p, "librarian").accesses.at(-1)!.historical).toBe(true);
});

test("actual candidate reads establish metadata or a real supplied abstract, never self-reported depth", async () => {
  const { p, host } = await fixture();
  await register(p, host);
  await call(p, host, "query", searchInput);
  const recordId = p.literatureSearch!.records[0]!.id;
  await call(p, host, "read", { operation: "literature-record", recordId });
  expect(p.literatureRecordReads![0]!.depth).toBe("metadata");
  const screen = {
    operation: "literature-screen",
    recordId,
    strategyId: "scan",
    strategyVersion: 1,
    decision: "undecided",
    reason: "题录不足以判断方法质量",
  };
  await expect(
    call(p, host, "abstract-spoof", { ...screen, requiredDepth: "abstract" }),
  ).rejects.toThrow("深度");
  await call(p, host, "metadata-screen", screen);
  expect(p.literatureSearch!.screenings[0]!.depth).toBe("metadata");
  await expect(call(p, host, "other-reader", screen, "reviewer")).rejects.toThrow("本人实际读取");
  host.search = async () => ({
    candidates: [
      {
        doi: "10.1234/abstract",
        abstract: "This is an actual synthetic abstract returned by the fixture.",
      },
    ],
  });
  await call(p, host, "abstract-query", searchInput);
  const abstractId = p.literatureSearch!.records.at(-1)!.id;
  await call(p, host, "read-abstract", { operation: "literature-record", recordId: abstractId });
  await call(p, host, "screen-abstract", {
    ...screen,
    recordId: abstractId,
    requiredDepth: "abstract",
  });
  expect(p.literatureSearch!.screenings.at(-1)!.depth).toBe("abstract");
});

test("full-text screening needs host scope and complete actual character coverage of pinned bytes", async () => {
  const { p, host, directory } = await fixture();
  await register(p, host);
  await call(p, host, "query", searchInput);
  const recordId = p.literatureSearch!.records[0]!.id,
    body = "Methods and findings.\nSecond half with limitations. 🧪",
    file = join(directory, "source.txt");
  await writeFile(file, body);
  p.evidence!.sources.push({
    id: "S",
    file,
    sha256: researchHash(body),
    title: "synthetic",
    authors: "fixture",
    year: "2026",
    url: "https://example.test/article",
    kind: "paper",
    access: "provided-text",
    textScope: "full-text",
  });
  p.sourceReads = [
    {
      id: "R1",
      sourceId: "S",
      sourceSha256: researchHash(body),
      bodySha256: researchHash(body),
      locatorId: "text:S",
      start: 0,
      end: 20,
      depth: "full-text",
      sessionId: "librarian-session",
      at: time(1),
      evidenceRef: "tool:actual-first-range",
    },
  ];
  const screen = {
    operation: "literature-screen",
    recordId,
    strategyId: "scan",
    strategyVersion: 1,
    decision: "include",
    reason: "合成原文核查",
    requiredDepth: "full-text",
  };
  await expect(call(p, host, "only-part", screen)).rejects.toThrow(/深度|范围/);
  p.sourceReads.push({
    ...p.sourceReads[0]!,
    id: "R2",
    start: 20,
    end: body.length,
    evidenceRef: "tool:actual-second-range",
  });
  await call(p, host, "full", screen);
  expect(
    p.literatureSearch!.screenings.at(-1)!.readings.map((row) => [row.start, row.end]),
  ).toEqual([
    [0, 20],
    [20, body.length],
  ]);
  const trimmed = structuredClone({
    literatureSearch: p.literatureSearch,
    literatureToolOperations: p.literatureToolOperations,
    literatureRecordReads: p.literatureRecordReads,
  });
  trimmed.literatureSearch!.screenings.at(-1)!.readings.pop();
  trimmed.literatureSearch!.screenings.at(-1)!.readIds.pop();
  expect(() => decodeResearchLiteratureToolState(trimmed)).toThrow("全文筛选未覆盖");
  p.evidence!.sources[0]!.textScope = "abstract";
  await expect(call(p, host, "scope-downgrade", screen)).rejects.toThrow(/深度|范围|读取/);
  p.evidence!.sources[0]!.textScope = "full-text";
  await writeFile(file, body + "changed");
  await expect(call(p, host, "changed-bytes", screen)).rejects.toThrow(/深度|范围|读取/);
});

test("B can inspect shared originals but cannot see A screening judgments until a valid independent initial", async () => {
  const { p, host } = await fixture();
  await register(p, host);
  await call(p, host, "query", searchInput);
  const recordId = p.literatureSearch!.records[0]!.id;
  await call(p, host, "A-read", { operation: "literature-record", recordId }, "lead");
  await call(
    p,
    host,
    "A-screen",
    {
      operation: "literature-screen",
      recordId,
      strategyId: "scan",
      strategyVersion: 1,
      decision: "include",
      reason: "A_PRIVATE_JUDGMENT",
    },
    "lead",
  );
  const before = researchLiteratureStatus(p, "reviewer");
  expect(JSON.stringify(before)).not.toContain("A_PRIVATE_JUDGMENT");
  expect(before).toMatchObject({ records: [{ id: recordId }], independentJudgmentsHidden: true });
  const read = await call(
    p,
    host,
    "B-read",
    { operation: "literature-record", recordId },
    "reviewer",
  );
  expect(JSON.stringify(read)).not.toContain("A_PRIVATE_JUDGMENT");
  expect(read.result).toMatchObject({ raw: { doi: "10.1234/test" } });
  const initial = {
    id: "B-initial",
    role: "reviewer" as const,
    kind: "stage-risk" as const,
    revision: 1,
    round: 0,
    createdAt: time(20),
    content: "B independent fixture judgment",
    refs: [],
    toolCallId: "fixture-publish",
    stage: "search" as const,
  };
  publishFusionArtifact(p, initial);
  p.artifacts.push(initial);
  expect(JSON.stringify(researchLiteratureStatus(p, "reviewer"))).toContain("A_PRIVATE_JUDGMENT");
  p.fusion!.tasks.find((row) => row.role === "reviewer")!.inputVersion++;
  expect(JSON.stringify(researchLiteratureStatus(p, "reviewer"))).not.toContain(
    "A_PRIVATE_JUDGMENT",
  );
});

test("strategy revisions preserve prior queries and a stop does not prove unexecuted work", async () => {
  const { p, host } = await fixture();
  await register(p, host);
  await call(p, host, "stop-zero", {
    operation: "literature-stop",
    strategyId: "scan",
    strategyVersion: 1,
    reason: "仅登记策略后暂停",
    remainingLimitations: ["本轮尚无实际查询"],
  });
  expect(researchLiteratureStatus(p, "librarian")).toMatchObject({
    counts: { allRecordedSearches: 0 },
    stops: [{ reason: "仅登记策略后暂停" }],
  });
  const prepared = await prepareResearchLiteratureTool(
    p,
    "librarian",
    "old-query",
    searchInput,
    host,
  );
  await call(p, host, "strategy-v2", {
    operation: "literature-strategy",
    strategy: { ...strategy, version: 2, changeReason: "补充竞争解释" },
  });
  expect(applyPreparedResearchLiteratureTool(p, prepared).result).toMatchObject({
    historical: true,
  });
  await expect(call(p, host, "new-old-query", searchInput)).rejects.toThrow("历史策略");
  await call(p, host, "strategy", { operation: "literature-strategy", strategy });
  expect(p.literatureSearch!.strategies.map((row) => row.version)).toEqual([1, 2]);
  expect(researchLiteratureStatus(p, "librarian")).toMatchObject({
    counts: { allRecordedSearches: 1, currentSearches: 0 },
  });
});

test("real search observations survive a separate archive-copy failure and failed searches remain failures", async () => {
  const { p, host, directory } = await fixture();
  await register(p, host);
  const records = [{ doi: "10.1234/archive", title: ["synthetic"] }];
  const archive = join(directory, ".lancer", "research-groups", p.id, "literature");
  await mkdir(archive, { recursive: true });
  const original = JSON.stringify({ status: "succeeded", records });
  const collision = join(archive, `${researchHash(original)}.json`);
  await writeFile(collision, "existing wrong bytes must not be overwritten");
  let calls = 0;
  host.search = async () => {
    calls++;
    return { candidates: records };
  };
  const outcome = await call(p, host, "archive-fails", searchInput);
  expect(outcome.result).toMatchObject({
    archiveError: expect.stringContaining("实际字节仍保留"),
    batch: { status: "succeeded" },
  });
  expect(p.literatureSearch!.batches[0]!.original.text).toBe(original);
  await call(p, host, "archive-fails", searchInput);
  expect(calls).toBe(1);
  expect(await readFile(collision, "utf8")).toBe("existing wrong bytes must not be overwritten");
  host.search = async () => {
    calls++;
    throw new Error("synthetic Crossref unavailable");
  };
  await call(p, host, "failed-query", searchInput);
  await call(p, host, "failed-query", searchInput);
  expect(calls).toBe(2);
  expect(p.literatureSearch!.batches[1]).toMatchObject({
    status: "failed",
    failure: "synthetic Crossref unavailable",
    recordIds: [],
  });
  expect(researchLiteratureStatus(p, "librarian")).toMatchObject({
    counts: { allRecordedSearches: 1, failedBatches: 1 },
  });
});

test("strict host-state decoding rejects forged actors, erased read evidence and unsupported depth", async () => {
  const { p, host } = await fixture();
  await register(p, host);
  await call(p, host, "query", searchInput);
  const recordId = p.literatureSearch!.records[0]!.id;
  await call(p, host, "read", { operation: "literature-record", recordId });
  await call(p, host, "screen", {
    operation: "literature-screen",
    recordId,
    strategyId: "scan",
    strategyVersion: 1,
    decision: "undecided",
    reason: "真实题录不足以做完整质量评价",
  });
  const persisted = {
    literatureSearch: p.literatureSearch,
    literatureToolOperations: p.literatureToolOperations,
    literatureRecordReads: p.literatureRecordReads,
  };
  expect(decodeResearchLiteratureToolState(JSON.parse(JSON.stringify(persisted)))).toEqual(
    persisted,
  );
  const actor = structuredClone(persisted);
  actor.literatureToolOperations![0]!.scope.model.provider = "human-expert";
  expect(() => decodeResearchLiteratureToolState(actor)).toThrow("宿主身份");
  const depth = structuredClone(persisted);
  depth.literatureRecordReads![0]!.depth = "abstract";
  expect(() => decodeResearchLiteratureToolState(depth)).toThrow("实际返回的摘要");
  const erased = structuredClone(persisted),
    readId = erased.literatureRecordReads![0]!.id;
  erased.literatureRecordReads = [];
  erased.literatureToolOperations = erased.literatureToolOperations!.filter(
    (op) => op.id !== readId,
  );
  expect(() => decodeResearchLiteratureToolState(erased)).toThrow("实际候选阅读");
  expect(() => decodeResearchLiteratureToolState({ ...persisted, humanApproved: true })).toThrow(
    "未知字段",
  );
});

test("a source or actual-read change during preparation preserves an old screening only as history", async () => {
  const { p, host, directory } = await fixture();
  await register(p, host);
  await call(p, host, "query", searchInput);
  const recordId = p.literatureSearch!.records[0]!.id,
    body = "Actual synthetic partial source text.",
    file = join(directory, "source.txt");
  await writeFile(file, body);
  p.evidence!.sources.push({
    id: "S",
    file,
    sha256: researchHash(body),
    title: "synthetic",
    authors: "fixture",
    year: "2026",
    url: "https://example.test/article",
    kind: "paper",
    access: "provided-text",
  });
  p.sourceReads = [
    {
      id: "READ",
      sourceId: "S",
      sourceSha256: researchHash(body),
      bodySha256: researchHash(body),
      locatorId: "text:S",
      start: 0,
      end: body.length,
      depth: "partial-text",
      sessionId: "reviewer-session",
      at: time(1),
      evidenceRef: "tool:actual-source-read",
    },
  ];
  const input = {
    operation: "literature-screen",
    recordId,
    strategyId: "scan",
    strategyVersion: 1,
    decision: "undecided",
    reason: "仅已提供部分正文",
    requiredDepth: "partial-text",
  };
  const prepared = await prepareResearchLiteratureTool(
    p,
    "reviewer",
    "screen-old-source",
    input,
    host,
  );
  p.evidence!.sources[0]!.sha256 = researchHash("replacement source");
  expect(applyPreparedResearchLiteratureTool(p, prepared).result).toMatchObject({
    historical: true,
    screening: { readings: [{ sourceSha256: researchHash(body) }] },
  });
  expect(p.literatureToolOperations!.at(-1)!.sourceChecks).toEqual([
    {
      sourceId: "S",
      sourceSha256: researchHash(body),
      bodySha256: researchHash(body),
      characters: body.length,
      depth: "partial-text",
    },
  ]);
  await expect(call(p, host, "screen-new-source", input, "reviewer")).rejects.toThrow("实际读取");
});

test("project validation reads paused historical executions without an active owner or mutation", async () => {
  const { p, host } = await fixture();
  await register(p, host);
  const late = await prepareResearchLiteratureTool(p, "librarian", "late", searchInput, host);
  p.status = "paused";
  applyPreparedResearchLiteratureTool(p, late);
  for (const attempt of p.fusion!.attempts) attempt.state = "succeeded";
  const restored = JSON.parse(JSON.stringify(p)) as LiteratureProject;
  const before = structuredClone(restored);

  expect(restored.literatureToolOperations!.at(-1)!.historical).toBe(true);
  expect(validateResearchLiteratureProject(restored)).toBeUndefined();
  expect(restored).toEqual(before);
});
