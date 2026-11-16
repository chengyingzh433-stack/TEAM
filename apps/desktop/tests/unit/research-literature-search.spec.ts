import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeResearchLiteratureSearch,
  type ResearchLiteratureHost,
} from "../../contracts/research-literature-search";
import {
  createResearchLiteratureAccessReceipt,
  recordResearchLiteratureAccess,
  createResearchLiteratureSearch,
  registerResearchLiteratureStrategy,
  createResearchLiteratureExecutionReceipt,
  recordResearchLiteratureExecution,
  importResearchLiteratureRecords,
  saveResearchLiteratureOriginal,
  screenResearchLiteratureRecord,
  stopResearchLiteratureSearch,
  locateResearchLiteratureRecord,
  reportResearchLiteratureSearch,
  type ResearchLiteratureBatchReceipt,
  type ResearchLiteratureReadingContext,
} from "../../electron/research-group/literature-search";

// L-only synthetic adapter observations. These tests make no network request and prove no live search.
const time = (n: number) => new Date(Date.UTC(2026, 10, 7, 20, 0, n)).toISOString();
const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const host = (id: string, n = 10): ResearchLiteratureHost => ({
  id,
  at: time(n),
  actor: {
    kind: "model",
    id: "model:librarian",
    sessionId: "fixture-session",
    evidenceRef: `synthetic-tool:${id}`,
  },
});
const plan = {
  id: "search",
  version: 1,
  questionVersion: "question-v1",
  question: "合成软件检索流程，非真实研究结论",
  concepts: ["absence"],
  synonyms: ["absenteeism"],
  queries: [
    {
      source: "Crossref",
      query: "absence achievement",
      filters: "无服务端年份过滤；当前连接最多5条候选",
    },
  ],
  inclusionCriteria: ["涉及缺勤与成绩"],
  exclusionCriteria: ["非教育情境"],
  stopRule: "限定范围达到可说明的覆盖后人工或模型说明停止理由",
  changeReason: "初次策略",
};
function initial() {
  return registerResearchLiteratureStrategy(
    createResearchLiteratureSearch(),
    plan,
    host("strategy-v1", 0),
  );
}
const raw = [
  {
    DOI: "10.1234/ABC",
    title: ["Synthetic absence study"],
    abstract: "Synthetic abstract only.",
    URL: "https://doi.org/10.1234/ABC",
    customOriginal: { pages: "1-8" },
  },
  { title: "Same title", URL: "https://example.test/paper?version=1" },
];
function receipt(id = "batch", records: unknown[] = raw) {
  return createResearchLiteratureExecutionReceipt({
    host: host(id),
    query: "actual executed query",
    endpoint: "https://api.crossref.org/works?rows=5&query.bibliographic=actual",
    startedAt: time(1),
    completedAt: time(9),
    outcome: { status: "succeeded", records },
    limitations: ["合成宿主结果夹具；不是联网R证据", "返回候选元数据，不是原HTTP响应或全文"],
  });
}
const ref = { id: "search", version: 1 };
const context = (): ResearchLiteratureReadingContext => {
  const body = "Synthetic original method and findings, with explicitly limited coverage.";
  return {
    sources: [
      {
        id: "SRC",
        body,
        bodySha256: hash(body),
        sha256: hash("original-file-bytes"),
        available: true,
        locators: [
          {
            id: "paragraph-1",
            label: "synthetic paragraph 1",
            start: 0,
            end: body.length,
            depth: "full-text",
          },
        ],
      },
    ],
    reads: [
      {
        id: "READ",
        sourceId: "SRC",
        sourceSha256: hash("original-file-bytes"),
        bodySha256: hash(body),
        locatorId: "paragraph-1",
        start: 0,
        end: body.length,
        depth: "full-text",
        sessionId: "fixture-session",
        at: time(12),
        evidenceRef: "synthetic-tool:source-read",
      },
    ],
    recordSources: [{ recordId: "batch:record:0", sourceId: "SRC" }],
  };
};
const screen = {
  recordId: "batch:record:0",
  strategyId: "search",
  strategyVersion: 1,
  decision: "include",
  depth: "full-text",
  reason: "合成测试：实际提供的范围满足此条纳入判断；不声称全文质量已程序证明。",
  readIds: ["READ"],
};

test("plans and amendments remain immutable and never count as executed searches", () => {
  const one = initial();
  expect(reportResearchLiteratureSearch(one)).toMatchObject({
    plannedStrategyVersions: 1,
    successfulSearches: 0,
    returnedRecords: 0,
    importedRecords: 0,
  });
  const two = registerResearchLiteratureStrategy(
    one,
    {
      ...plan,
      version: 2,
      queries: [{ ...plan.queries[0]!, query: "absence grades competing explanations" }],
      changeReason: "扩展竞争解释检索",
    },
    host("strategy-v2", 11),
  );
  expect(one.strategies).toHaveLength(1);
  expect(two.strategies[0]).toEqual(one.strategies[0]);
  expect(reportResearchLiteratureSearch(two).successfulSearches).toBe(0);
  expect(() =>
    registerResearchLiteratureStrategy(two, { ...plan, version: 4 }, host("skip")),
  ).toThrow("连续新版本");
  expect(() =>
    registerResearchLiteratureStrategy(
      two,
      { ...plan, question: "overwrite" },
      host("strategy-v1", 0),
    ),
  ).toThrow("不能重写");
  for (const extra of [{ actor: { kind: "user" } }, { executed: true }, { count: 100 }])
    expect(() =>
      registerResearchLiteratureStrategy(one, { ...plan, ...extra }, host("spoof")),
    ).toThrow("未知字段");
});

test("host-only receipts retain actual query and returned originals; failed batches preserve prior success", () => {
  const one = initial(),
    proof = receipt();
  expect(() =>
    recordResearchLiteratureExecution(one, ref, JSON.parse("{}") as ResearchLiteratureBatchReceipt),
  ).toThrow("宿主单独");
  const next = recordResearchLiteratureExecution(one, ref, proof);
  expect(recordResearchLiteratureExecution(next, ref, proof)).toEqual(next);
  expect(next.batches[0]).toMatchObject({
    query: "actual executed query",
    representation: "returned-candidate-metadata",
    recordIds: ["batch:record:0", "batch:record:1"],
  });
  expect(JSON.parse(next.records[0]!.rawJson)).toEqual(raw[0]);
  expect(next.batches[0]!.original.sha256).toBe(hash(next.batches[0]!.original.text));
  const failed = createResearchLiteratureExecutionReceipt({
    host: host("failed", 20),
    query: "unavailable query",
    endpoint: "https://example.test/search",
    startedAt: time(15),
    completedAt: time(19),
    outcome: { status: "failed", error: "HTTP 503 synthetic failure" },
    limitations: ["本批接口不可用，不计作成功检索"],
  });
  const after = recordResearchLiteratureExecution(next, ref, failed);
  expect(after.records).toEqual(next.records);
  expect(reportResearchLiteratureSearch(after)).toMatchObject({
    successfulSearches: 1,
    returnedRecords: 2,
    importedRecords: 0,
  });
  expect(reportResearchLiteratureSearch(after).failures).toHaveLength(1);
  expect(() => recordResearchLiteratureExecution(after, ref, receipt("batch", []))).toThrow(
    "不能重写",
  );
});

test("real JSON import preserves original bytes and every duplicate record without title-based merging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "literature-import-")),
    file = join(dir, "records.json");
  const imported = [
    { doi: "https://doi.org/10.1234/abc", title: "Different title same DOI" },
    { title: "Same title", url: "https://example.test/paper?version=1#anchor" },
    { title: "Same title", url: "https://example.test/paper?version=2" },
    { title: "Same title" },
  ];
  const original = JSON.stringify({ message: { items: imported } }, null, 2) + "\n";
  await writeFile(file, original);
  const before = recordResearchLiteratureExecution(initial(), ref, receipt());
  const state = recordResearchLiteratureExecution(
    before,
    ref,
    await importResearchLiteratureRecords(file, host("import", 20), [
      "合成记录文件，不代表当前宿主访问过数据库",
    ]),
  );
  expect(state.records).toHaveLength(6);
  const report = reportResearchLiteratureSearch(state);
  expect(report).toMatchObject({ successfulSearches: 1, returnedRecords: 2, importedRecords: 4 });
  expect(report.groups).toHaveLength(4);
  expect(locateResearchLiteratureRecord(state, "batch:record:0").duplicateRecordIds).toEqual([
    "batch:record:0",
    "import:record:0",
  ]);
  const batch = state.batches[1]!;
  expect(batch).toMatchObject({ origin: "import", query: null, endpoint: null });
  expect(batch.original.text).toBe(original);
  expect(batch.original.sha256).toBe(hash(await readFile(file)));
  const saved = await saveResearchLiteratureOriginal(join(dir, "archive"), batch);
  expect(await readFile(saved.file, "utf8")).toBe(original);
  expect(await saveResearchLiteratureOriginal(join(dir, "archive"), batch)).toEqual(saved);
  expect(await readFile(file, "utf8")).toBe(original);
});

test("bad imports fail only their batch and unsupported encodings preserve actual bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "literature-failed-import-")),
    file = join(dir, "bad.json");
  const prior = recordResearchLiteratureExecution(initial(), ref, receipt());
  for (const bytes of [Buffer.from("{broken json"), Buffer.from([0xff, 0xfe, 0x00, 0x41])]) {
    await writeFile(file, bytes);
    const state = recordResearchLiteratureExecution(
      prior,
      ref,
      await importResearchLiteratureRecords(file, host("bad-import", 20), ["解析失败仅影响本批"]),
    );
    expect(state.records).toEqual(prior.records);
    expect(state.batches[1]!.status).toBe("failed");
    expect(reportResearchLiteratureSearch(state).importedRecords).toBe(0);
    const saved = await saveResearchLiteratureOriginal(join(dir, "archive"), state.batches[1]!);
    expect(await readFile(saved.file)).toEqual(bytes);
  }
});

test("screening requires actual matching original reads; abstract and fetched text cannot self-upgrade", () => {
  const state = recordResearchLiteratureExecution(initial(), ref, receipt()),
    actual = context();
  const metadata = screenResearchLiteratureRecord(
    state,
    { ...screen, depth: "metadata", readIds: [] },
    host("metadata", 20),
    actual,
  );
  const abstract = screenResearchLiteratureRecord(
    metadata,
    { ...screen, depth: "abstract", readIds: [] },
    host("abstract", 21),
    actual,
  );
  expect(abstract.screenings.map((row) => row.depth)).toEqual(["metadata", "abstract"]);
  expect(() =>
    screenResearchLiteratureRecord(state, { ...screen, readIds: [] }, host("no-read", 20), actual),
  ).toThrow("实际原文读取");
  expect(() =>
    screenResearchLiteratureRecord(
      state,
      { ...screen, depth: "abstract", recordId: "batch:record:1", readIds: [] },
      host("no-abstract", 20),
      actual,
    ),
  ).toThrow("没有实际摘要");
  for (const mutate of [
    (c: ResearchLiteratureReadingContext) => {
      c.reads[0]!.depth = "abstract";
    },
    (c: ResearchLiteratureReadingContext) => {
      c.sources[0]!.sha256 = hash("new-source");
    },
    (c: ResearchLiteratureReadingContext) => {
      c.sources[0]!.body += "changed";
    },
    (c: ResearchLiteratureReadingContext) => {
      c.sources[0]!.locators[0]!.depth = "partial-text";
    },
    (c: ResearchLiteratureReadingContext) => {
      c.sources[0]!.available = false;
    },
    (c: ResearchLiteratureReadingContext) => {
      c.reads[0]!.sessionId = "other-model";
    },
    (c: ResearchLiteratureReadingContext) => {
      c.recordSources = [];
    },
  ]) {
    const changed = structuredClone(actual);
    mutate(changed);
    expect(() =>
      screenResearchLiteratureRecord(state, screen, host("reject", 20), changed),
    ).toThrow("实际读取范围");
  }
  const screened = screenResearchLiteratureRecord(
    abstract,
    screen,
    host("full-screen", 22),
    actual,
  );
  expect(screened.screenings.at(-1)!.host.actor.kind).toBe("model");
  expect(screened.screenings.at(-1)!.readings[0]).toMatchObject({
    readId: "READ",
    locatorId: "paragraph-1",
    sourceSha256: actual.sources[0]!.sha256,
  });
  expect(() =>
    screenResearchLiteratureRecord(
      state,
      { ...screen, actor: { kind: "user" } },
      host("spoof", 20),
      actual,
    ),
  ).toThrow("未知字段");
  expect(decodeResearchLiteratureSearch(screened)).toEqual(screened);
});

test("stopping records the exact strategy version, rationale and remaining limits without claiming completeness", () => {
  const before = recordResearchLiteratureExecution(initial(), ref, receipt());
  const state = stopResearchLiteratureSearch(
    before,
    {
      strategyId: "search",
      strategyVersion: 1,
      reason: "本次范围扫描预算已用尽，停止自动检索",
      remainingLimitations: ["仅Crossref有限候选，无其他数据库覆盖；不能得出前人从未研究"],
    },
    host("stop", 30),
  );
  expect(before.stops).toEqual([]);
  expect(state.stops[0]!.host.actor.id).toBe("model:librarian");
  expect(reportResearchLiteratureSearch(state).boundary).toContain("不代表");
  expect(() =>
    stopResearchLiteratureSearch(
      state,
      { strategyId: "search", strategyVersion: 1, reason: "", remainingLimitations: [] },
      host("blank", 30),
    ),
  ).toThrow();
  expect(() =>
    stopResearchLiteratureSearch(
      state,
      {
        strategyId: "search",
        strategyVersion: 1,
        reason: "done",
        remainingLimitations: ["none"],
        searchedCount: 100,
      },
      host("spoof", 30),
    ),
  ).toThrow("自报");
});

test("persisted malformed counts, origins, reading depth and changed raw snapshots are rejected", () => {
  const state = screenResearchLiteratureRecord(
    recordResearchLiteratureExecution(initial(), ref, receipt()),
    screen,
    host("screen", 20),
    context(),
  );
  const counts = structuredClone(state);
  counts.batches[0]!.recordIds.pop();
  expect(() => decodeResearchLiteratureSearch(counts)).toThrow("返回数");
  const changed = structuredClone(state);
  changed.records[0]!.rawJson = JSON.stringify({ title: "tamper" });
  expect(() => reportResearchLiteratureSearch(changed)).toThrow(/摘要|原记录不一致/);
  const depth = structuredClone(state);
  depth.screenings[0]!.readings[0]!.depth = "abstract";
  expect(() => decodeResearchLiteratureSearch(depth)).toThrow("阅读范围");
  const identity = structuredClone(state);
  (identity.screenings[0]!.host.actor as { kind: string }).kind = "human-expert";
  expect(() => decodeResearchLiteratureSearch(identity)).toThrow("身份");
});

test("source access failures and successful fetches stay distinct from searches and actual full-text reading", async () => {
  const before = recordResearchLiteratureExecution(initial(), ref, receipt());
  const failed = createResearchLiteratureAccessReceipt({
    recordId: "batch:record:0",
    url: "https://example.test/article",
    host: host("access-failed", 20),
    outcome: { status: "failed", error: "合成403访问拒绝" },
  });
  const accessed = recordResearchLiteratureAccess(before, failed);
  const fetched = recordResearchLiteratureAccess(
    accessed,
    createResearchLiteratureAccessReceipt({
      recordId: "batch:record:0",
      url: "https://example.test/article",
      host: host("access-ok", 21),
      outcome: {
        status: "fetched-text",
        sourceId: "SRC",
        sourceSha256: context().sources[0]!.sha256,
      },
    }),
  );
  expect(reportResearchLiteratureSearch(fetched)).toMatchObject({
    successfulSearches: 1,
    returnedRecords: 2,
    fetchedRecords: 1,
    screenedRecords: 0,
  });
  expect(reportResearchLiteratureSearch(fetched).sourceAccessFailures).toHaveLength(1);
  expect(locateResearchLiteratureRecord(fetched, "batch:record:0").accesses).toHaveLength(2);
  expect(() =>
    screenResearchLiteratureRecord(
      fetched,
      { ...screen, readIds: [] },
      host("read-spoof", 22),
      context(),
    ),
  ).toThrow("实际原文读取");
  expect(fetched.records).toEqual(before.records);
  const missing = await importResearchLiteratureRecords(
    join(await mkdtemp(join(tmpdir(), "missing-literature-")), "missing.json"),
    host("missing", 23),
    ["原件不可读"],
  );
  const missingState = recordResearchLiteratureExecution(fetched, ref, missing);
  expect(missingState.batches.at(-1)!.original.available).toBe(false);
  await expect(
    saveResearchLiteratureOriginal(tmpdir(), missingState.batches.at(-1)!),
  ).rejects.toThrow("未取得原件");
});
