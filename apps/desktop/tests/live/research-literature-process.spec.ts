import { expect, test } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { reportResearchLiteratureSearch } from "../../electron/research-group/literature-search";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { openResearchEvidence, researchHash } from "../../electron/research-group/materials";
import {
  captureResearchNativeBoundary,
  researchNativeCallLedger,
} from "../helpers/research-live-evidence";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
} from "../helpers/electron-app";

const NOTICE =
  "automated-test-operator：真实提供商与真实有限检索的软件流程验收；候选方向不是人类已选题目，不构成领域穷尽、系统综述完成或伦理审批。";
const IMPORT_NAME = "provided-bibliographic-records.json";
const PROMPT = `${NOTICE}\n目前只有一个宽泛兴趣：教学情境中，学习支持与学生成绩之间可以提出哪些有边界、值得进一步限定的问题？本轮仅S0候选方向，比较两个候选并保留待用户以后选择，不做整篇论文、数据分析或自动定题。已提供UCI说明、DA2025、SMS2025原文；它们是有限来源，不代表领域覆盖。测试操作者会在项目创建后立即用普通UI导入${IMPORT_NAME}，这是从同一真实材料manifest投影的题录副本及原样重复项，非数据库原始导出，不是新论文或新研究发现。\n资料员先status/inputs，实际建立literature-strategy v1（id本轮固定、questionVersion由host给），概念/同义词/纳排/停止规则写清。至少调用一次literature-search对Crossref做实际查询，整轮最多2次，建议只1次，queryIndex从0开始；计划过滤未实际执行不可说已筛选。实际literature-record读取返回候选，至少一条按可证实深度literature-screen（可undecided，理由不能超出题录），然后尽早publish第一份stage-material，明确批次/候选/已读深度，允许A/B立刻使用，不等后续工作。\n第一批交付后继续做有限且真实的有用工作：从已取得候选原记录的真实URL中选1至最多3次literature-fetch（全程合计最多3，不用source-fetch绕过）；成功后实际source-read必要范围，获取不等于读取。失败必须保留真实错误及其影响；如果都成功，明确本轮没有观察到访问失败，不能捏造404或虚构候选。首次实际获取之后可查一次status了解A/B进展，同时继续剩余有限工作；不睡眠或循环轮询等人。随后保持同一个strategy id登记v2并说明调整理由，不改旧策略/执行；用literature-context中实际materialId对${IMPORT_NAME}执行literature-import，保留重复记录和原始字节身份，不把导入算Crossref查询。实际literature-record并对导入记录作有出处的有限筛选；读到题录只能按metadata，摘要才可abstract，只有实际取得并覆盖所提供全文读取才可full-text。最后literature-stop记录当前版本停止理由和剩余局限，publish第二份stage-material汇总新增批次和深度/失败边界。只交两份材料后结束，不等整组。\nA/B独立初判只依据共同原文、本人课程包和首批资料：actual read第一份stage-material、literature-record至少一条首批候选、source-read必要本地原文，然后各自stage-draft/stage-risk，refs引用所用首批成果，不能等资料员所有批次完成，也不能先读对方观点/筛选结论。B先独立后read A初稿，给具体位置/依据/影响/建议，允许有依据同意。A实际read批评和后批次，发布有前后变化说明的stage-revision；B实际read修订并复核。导师最后实际read最新修订/B复核，有限裁定只针对方向候选与证据边界，不替人定题。\n各角色按当前产品方法工具取本任务必要的少量课程包；采用的包依实际图像/方法应用/B意见/导师裁定要求完成，不借旧检索记录冒充。来源与成果refs只用本人实际读取ID。结果篇幅短：A各约400字，B各约200字，资料员每批约250字，导师约200字。不得bash/读CSV/旧R或C/调用外部工具另起检索，不扩大到未提供旧稿。首批正常交接后继续有用工作，禁止为了制造并发而伪造数据或故意失败。`;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

test("real Crossref execution and UI-imported original citations retain versioned screening provenance", async () => {
  test.setTimeout(2_400_000);
  const deadline = Date.now() + 2_100_000,
    auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit live auth opt-in required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir) throw new Error("Actual course library required");
  const knowledge = await ResearchKnowledge.open(knowledgeDir);
  const sourceDirectory =
    process.env.RESEARCH_LITERATURE_SOURCE_DIR ??
    resolve(__dirname, "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料");
  const manifestBytes = await readFile(join(sourceDirectory, "manifest.json")),
    manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  // Inspect only source descriptors and their actual texts. The manifest's CSV is never opened.
  const originals = (Array.isArray(manifest.sources) ? manifest.sources.map(object) : []).filter(
    (source) => ["UCI", "DA2025", "SMS2025"].includes(String(source.id)),
  );
  expect(originals.map((source) => source.id).sort()).toEqual(["DA2025", "SMS2025", "UCI"]);
  const profile = await makeUserDataDir("research-literature-process-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-literature-process-live"),
    materials = join(workspace, "provided-originals");
  await mkdir(materials);
  const sourceHashes: {
    id: string;
    file: string;
    sha256: string;
    metadata: Record<string, unknown>;
  }[] = [];
  for (const source of originals) {
    expect(source.file).toBe(`${String(source.id)}.txt`);
    for (const key of ["title", "authors", "year", "url"])
      expect(typeof source[key]).toBe("string");
    const file = join(sourceDirectory, String(source.file)),
      bytes = await readFile(file);
    expect(bytes.toString("utf8").toLowerCase()).toContain(String(source.title).toLowerCase());
    sourceHashes.push({
      id: String(source.id),
      file,
      sha256: researchHash(bytes),
      metadata: {
        id: source.id,
        title: source.title,
        authors: source.authors,
        year: source.year,
        url: source.url,
      },
    });
    await writeFile(join(materials, String(source.file)), bytes, { flag: "wx" });
  }
  await writeFile(
    join(materials, "manifest.json"),
    JSON.stringify({ version: 1, sources: originals, datasets: [] }, null, 2),
  );
  const evidence = await openResearchEvidence(materials);
  expect(evidence.datasets).toEqual([]);
  // No invented abstract/DOI. Duplicate is the exact SMS manifest projection, preserved twice.
  const importRows = [
    ...sourceHashes.map((source) => source.metadata),
    sourceHashes.find((source) => source.id === "SMS2025")!.metadata,
  ];
  const importedBytes = Buffer.from(JSON.stringify({ candidates: importRows }, null, 2)),
    importFile = join(workspace, IMPORT_NAME);
  await writeFile(importFile, importedBytes, { flag: "wx" });
  const plan = {
    beganAt: new Date().toISOString(),
    notice: NOTICE,
    profile,
    workspace,
    sourceDirectory,
    originalManifestSha256: researchHash(manifestBytes),
    originalSources: sourceHashes,
    importFile,
    importedSha256: researchHash(importedBytes),
    importIdentity:
      "Host projection of real provided manifest metadata, not a database export; duplicate retained verbatim; no generated abstract/DOI",
    knowledgePin: knowledge.pin,
    route: "discovery/direction S0 scan, four roles",
    memberTokenBudget: 8_000_000,
    queryMaximum: 2,
    sourceFetchMaximum: 3,
    targetDuration: "A few minutes aspirational; retain actual duration, no timeout increase",
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
      librarian: "openai-codex/gpt-6.1-sol low",
    },
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(test.info().outputPath("original-source-manifest.json"), manifestBytes);
  await writeFile(test.info().outputPath(IMPORT_NAME), importedBytes);
  await writeFile(test.info().outputPath("initial-instruction.txt"), PROMPT);
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  const harness = await launchDesktop(profile, {
    initialWorkspaces: [workspace],
    realAuthSourceDir: auth.sourceDir,
    enabledModels: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-astra"],
    testMode: "background",
  });
  let lastState: DesktopAppState | undefined,
    failure: string | undefined,
    nativeEndedAt: string | undefined;
  const rendererErrors: string[] = [];
  try {
    await chmod(join(profile, "agent"), 0o700);
    await chmod(join(profile, "agent", "auth.json"), 0o600);
    const page = await harness.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(knowledgeDir);
    await editor.getByLabel("研究材料目录", { exact: true }).fill(materials);
    await editor.getByLabel("研究入口", { exact: true }).selectOption("discovery");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("direction");
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    await editor.getByLabel("成员 Token 上限", { exact: true }).fill("8000000");
    for (let index = 0; index < FUSION_STAGE_IDS.length; index++)
      for (const role of RESEARCH_ROLES) {
        const critical = ["scan", "question", "synthesis", "design", "analysis", "audit"].includes(
          FUSION_STAGE_IDS[index]!,
        );
        const modelId =
          role === "mentor" || (role === "reviewer" && critical) ? "gpt-6-astra" : "gpt-6.1-sol";
        await editor
          .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}模型`, { exact: true })
          .selectOption(JSON.stringify({ provider: "openai-codex", modelId }));
        await editor
          .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}思考强度`, { exact: true })
          .selectOption(role === "librarian" ? "low" : "high");
      }
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await openNewThread(page);
    await page.getByLabel("New thread prompt").fill(PROMPT);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(async () => {
        lastState = await getDesktopState(page);
        return !!lastState.researchGroups?.projects[0];
      })
      .toBe(true);
    // Real UI import/host parser; only native file-picker selection is a labelled test fixture.
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [importFile],
    );
    await page
      .getByRole("region", { name: "教育研究课题组", exact: true })
      .getByRole("button", { name: "导入研究材料", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).researchGroups?.projects[0]?.importedMaterials?.length,
      )
      .toBe(1);
    await expect
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          const p = lastState.researchGroups!.projects[0]!;
          const failed = p.fusion!.attempts.filter((attempt) =>
            ["failed", "unknown"].includes(attempt.state),
          );
          if (
            lastState.researchGroups?.error ||
            ["paused", "needs-decision"].includes(p.status) ||
            failed.length
          )
            throw new Error(
              JSON.stringify({
                error: lastState.researchGroups?.error ?? p.error,
                status: p.status,
                failed,
              }),
            );
          if (
            (p.literatureSearch?.batches.filter((batch) => batch.origin === "execution").length ??
              0) > 2 ||
            (p.literatureSearch?.accesses.length ?? 0) > 3
          )
            throw new Error(
              "Bounded real query/fetch budget exceeded; retain evidence, no extra attempts",
            );
          return (
            p.status === "completed" &&
            captureResearchNativeBoundary(lastState, p).activeNativeAtCapture.length === 0
          );
        },
        { timeout: Math.max(1, deadline - Date.now()), intervals: [1000, 3000] },
      )
      .toBe(true);
    nativeEndedAt = new Date().toISOString();
    const p = lastState!.researchGroups!.projects[0]!,
      ledger = p.literatureSearch!,
      report = reportResearchLiteratureSearch(ledger);
    expect(researchExecutionRoute(p).stageIds).toEqual(["scan"]);
    expect(researchExecutionRoute(p).requiredRoles).toEqual([...RESEARCH_ROLES]);
    expect(p.memberTokenBudget).toBe(8_000_000);
    expect(p.evidence!.datasets).toEqual([]);
    expect(p.analyses ?? []).toEqual([]);
    expect(p.analysisRegistry?.runs ?? []).toEqual([]);
    expect(ledger.strategies.map((strategy) => strategy.version)).toEqual([1, 2]);
    expect(new Set(ledger.strategies.map((strategy) => strategy.id)).size).toBe(1);
    const executed = ledger.batches.filter((batch) => batch.origin === "execution"),
      imported = ledger.batches.filter((batch) => batch.origin === "import");
    expect(executed.length).toBeGreaterThanOrEqual(1);
    expect(executed.length).toBeLessThanOrEqual(2);
    expect(
      executed.some((batch) => batch.status === "succeeded" && batch.recordIds.length > 0),
    ).toBe(true);
    for (const batch of executed) {
      expect(batch.query).toBeTruthy();
      expect(batch.endpoint).toBe(
        `https://api.crossref.org/works?rows=5&query.bibliographic=${encodeURIComponent(batch.query!)}`,
      );
      expect(batch.representation).toBe("returned-candidate-metadata");
      expect(batch.host.actor.kind).toBe("model");
    }
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      strategyVersion: 2,
      status: "succeeded",
      query: null,
      endpoint: null,
      original: {
        available: true,
        encoding: "utf8",
        sha256: researchHash(importedBytes),
        text: importedBytes.toString("utf8"),
      },
    });
    expect(
      ledger.records
        .filter((record) => record.batchId === imported[0]!.id)
        .map((record): unknown => JSON.parse(record.rawJson)),
    ).toEqual(importRows);
    expect(
      report.groups.some(
        (group) => group.recordIds.filter((id) => imported[0]!.recordIds.includes(id)).length === 2,
      ),
    ).toBe(true);
    expect(ledger.accesses.length).toBeGreaterThanOrEqual(1);
    expect(ledger.accesses.length).toBeLessThanOrEqual(3);
    expect(ledger.screenings.length).toBeGreaterThanOrEqual(2);
    for (const screen of ledger.screenings) {
      expect(screen.reason.trim()).not.toBe("");
      expect(screen.host.actor.kind).toBe("model");
      expect(
        p.literatureToolOperations!.some(
          (op) => op.id === screen.host.id && op.operation === "literature-screen",
        ),
      ).toBe(true);
      if (screen.depth === "full-text") {
        expect(screen.readings.length).toBeGreaterThan(0);
        expect(
          screen.readings.every(
            (reading) =>
              reading.depth === "full-text" &&
              p.sourceReads!.some(
                (actual) =>
                  actual.id === reading.readId &&
                  actual.sourceSha256 === reading.sourceSha256 &&
                  actual.bodySha256 === reading.bodySha256,
              ),
          ),
        ).toBe(true);
      }
    }
    expect(
      ledger.stops.some(
        (stop) =>
          stop.strategyVersion === 2 && stop.reason.trim() && stop.remainingLimitations.length,
      ),
    ).toBe(true);
    const batches = p.artifacts.filter(
      (artifact) => artifact.kind === "stage-material" && artifact.role === "librarian",
    );
    expect(batches).toHaveLength(2);
    const firstBatch = executed.find(
      (batch) => batch.status === "succeeded" && batch.recordIds.length,
    )!;
    expect(firstBatch.strategyVersion).toBe(1);
    expect(firstBatch.completedAt <= batches[0]!.createdAt).toBe(true);
    expect(batches[0]!.createdAt <= imported[0]!.startedAt).toBe(true);
    expect(imported[0]!.completedAt <= batches[1]!.createdAt).toBe(true);
    expect(
      p.literatureRecordReads!.some(
        (read) =>
          firstBatch.recordIds.includes(read.recordId) &&
          read.host.actor.sessionId ===
            p.members.find((member) => member.role === "librarian")!.ref.sessionId &&
          read.host.at <= batches[0]!.createdAt,
      ),
    ).toBe(true);
    for (const role of ["lead", "reviewer"] as const) {
      const independent = p.artifacts.find(
        (artifact) =>
          artifact.role === role &&
          artifact.kind === (role === "lead" ? "stage-draft" : "stage-risk"),
      )!;
      expect(independent).toBeTruthy();
      expect(independent.refs).toContain(batches[0]!.id);
      const read = p.events.find(
        (event) =>
          event.type === "read" && event.role === role && event.artifactId === batches[0]!.id,
      )!;
      expect(read).toBeTruthy();
      expect(read.at <= independent.createdAt).toBe(true);
      expect(
        p.literatureRecordReads!.some(
          (record) =>
            firstBatch.recordIds.includes(record.recordId) &&
            record.host.actor.sessionId ===
              p.members.find((member) => member.role === role)!.ref.sessionId &&
            record.host.at <= independent.createdAt,
        ),
      ).toBe(true);
      // Actual overlap only; no synthetic delay, forced HTTP failure or sleep to manufacture it.
      expect(
        p.literatureToolOperations!.some(
          (op) =>
            op.scope.role === "librarian" &&
            op.completedAt > read.at &&
            op.completedAt > independent.createdAt,
        ),
      ).toBe(true);
      const other = role === "lead" ? "reviewer" : "lead";
      expect(
        p.events.some(
          (event) =>
            event.type === "read" &&
            event.role === role &&
            event.at < independent.createdAt &&
            p.artifacts.some(
              (artifact) => artifact.id === event.artifactId && artifact.role === other,
            ),
        ),
      ).toBe(false);
    }
    const native = await researchNativeCallLedger(profile, p);
    expect(
      native
        .flatMap((member) => member.calls)
        .filter(
          (call) =>
            call.name !== "research_group" ||
            ["source-search", "source-fetch", "analyze", "run-analysis"].includes(
              String(call.operation),
            ),
        ),
    ).toEqual([]);
    for (const op of p.literatureToolOperations!)
      expect(
        native
          .find((member) => member.role === op.scope.role)!
          .calls.some(
            (call) =>
              call.id === op.callId &&
              call.operation === op.operation &&
              call.resultAt &&
              !call.isError,
          ),
      ).toBe(true);
    for (const artifact of p.artifacts)
      expect(artifact.model).toEqual(
        p.stages!.find((stage) => stage.id === "scan")!.models[artifact.role],
      );
    expect(p.fusion!.attempts.every((attempt) => attempt.state === "succeeded")).toBe(true);
    const panel = page.getByTestId("research-literature-process");
    await panel.locator(":scope > summary").click();
    for (const batch of ledger.batches)
      await panel.locator(`[data-literature-batch-id="${batch.id}"] > summary`).click();
    await page.screenshot({ path: test.info().outputPath("literature-actual-batches.png") });
    await panel
      .locator("summary")
      .filter({ hasText: /^重复候选/ })
      .click();
    await panel
      .locator("summary")
      .filter({ hasText: /^候选与逐条筛选/ })
      .click();
    const screened = panel.locator(
      `[data-literature-record-id="${ledger.screenings[0]!.recordId}"]`,
    );
    await screened.locator(":scope > summary").click();
    await panel
      .locator("summary")
      .filter({ hasText: /^停止记录与剩余限制/ })
      .click();
    await screened.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("literature-depth-and-stop.png") });
    await panel
      .locator("summary")
      .filter({ hasText: /^重复候选/ })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("literature-duplicate-originals.png") });
    await panel
      .locator("summary")
      .filter({ hasText: /^停止记录与剩余限制/ })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("literature-remaining-limits.png") });
    await writeFile(
      test.info().outputPath("collaboration-proof.json"),
      JSON.stringify(
        {
          notice: NOTICE,
          report,
          native,
          materialIds: batches.map((artifact) => artifact.id),
          accesses: ledger.accesses,
          accessFailureCoverage: report.sourceAccessFailures.length
            ? "Observed actual candidate URL access failure; retained host error"
            : "NOT COVERED: every attempted access succeeded; no artificial failure and no claim that all AC22 branches passed",
          boundary:
            "Candidate scope only, not exhaustive search or scientific acceptance; substantive direction/content remains independently reviewable.",
        },
        null,
        2,
      ),
    );
    expect(rendererErrors).toEqual([]);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      lastState = await getDesktopState(await harness.firstWindow()).catch(() => lastState);
      const p = lastState?.researchGroups?.projects[0];
      const integrity = await Promise.all(
        sourceHashes.map(async (source) => ({
          id: source.id,
          unchanged: researchHash(await readFile(source.file)) === source.sha256,
          copiedUnchanged:
            researchHash(await readFile(join(materials, `${source.id}.txt`))) === source.sha256,
        })),
      );
      const manifestUnchanged =
          researchHash(await readFile(join(sourceDirectory, "manifest.json"))) ===
          researchHash(manifestBytes),
        importUnchanged = researchHash(await readFile(importFile)) === researchHash(importedBytes),
        knowledgeUnchanged =
          researchHash(await readFile(join(knowledgeDir, "索引", "知识块.jsonl"))) ===
          knowledge.pin.sha256;
      const importedOriginalIntegrity = await Promise.all(
        (p?.importedMaterials ?? []).map(async (material) => ({
          id: material.id,
          unchanged: await readFile(material.original)
            .then((bytes) => researchHash(bytes) === material.sha256)
            .catch(() => false),
        })),
      );
      if (p) {
        await writeFile(
          test.info().outputPath("research-project.json"),
          JSON.stringify(p, null, 2),
        );
        for (const artifact of p.artifacts)
          await writeFile(test.info().outputPath(`artifact-${artifact.id}.md`), artifact.content);
        await writeFile(
          test.info().outputPath("native-literature-tools.json"),
          JSON.stringify(
            await researchNativeCallLedger(profile, p).catch((error: unknown) => ({
              incomplete: String(error),
            })),
            null,
            2,
          ),
        );
      }
      const failedAccesses =
        p?.literatureSearch?.accesses.filter((access) => access.outcome.status === "failed") ?? [];
      await writeFile(
        test.info().outputPath("run-outcome.json"),
        JSON.stringify(
          {
            ...plan,
            endedAt: new Date().toISOString(),
            nativeEndedAt,
            failure,
            finalStatus: p?.status ?? "not-created",
            integrity,
            manifestUnchanged,
            importUnchanged,
            importedOriginalIntegrity,
            knowledgeUnchanged,
            accessFailureCoverage: failedAccesses.length
              ? { observed: true, failedAccesses }
              : {
                  observed: false,
                  limitation:
                    "No actual access failure observed; this branch of AC22 remains unverified.",
                },
            rendererErrors,
            ...(p && lastState ? captureResearchNativeBoundary(lastState, p) : {}),
            teardownNotice:
              "Closing unfinished native requests after failure is cleanup, not successful natural completion.",
          },
          null,
          2,
        ),
      );
      expect(integrity.every((source) => source.unchanged && source.copiedUnchanged)).toBe(true);
      expect(manifestUnchanged && importUnchanged && knowledgeUnchanged).toBe(true);
      expect(importedOriginalIntegrity.every((material) => material.unchanged)).toBe(true);
    } finally {
      await harness.close();
    }
  }
});
