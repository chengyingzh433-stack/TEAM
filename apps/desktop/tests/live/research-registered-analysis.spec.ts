import { expect, test } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import type { RegisteredResearchAnalysisRun } from "../../contracts/research-analysis-registry";
import { ANALYSIS_ARCHIVE_FILES } from "../../contracts/research-analysis-reuse";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { researchHash } from "../../electron/research-group/materials";
import {
  isCurrentResearchAnalysis,
  stageManuscript,
} from "../../electron/research-group/paper-pipeline";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  type DesktopHarness,
} from "../helpers/electron-app";
import {
  captureResearchNativeBoundary,
  researchNativeCallLedger,
} from "../helpers/research-live-evidence";
import {
  evidenceObject as object,
  publicUciNumericAudit,
  registeredAnalysisNativeEvidence,
  registeredAnalysisStageBoundary,
} from "../helpers/research-registered-analysis-evidence";

const CSV_SHA256 = "e47f9ee225e1ee6e69b7564e6dac7123e80b8486677fe111f351964cef5dec80";
const SOURCE_SHA256 = "8ada3beb8183194cb44000a153db2aea7eb6c03db28babf899aa98c2c7aadf26";
const PLAN_IDS = ["uci-descriptive", "uci-primary-g1", "uci-comparison-g1-g2"] as const;
const NOTICE =
  "automated-test-operator：AC07真实提供商登记分析软件验收，使用实际公开UCI数学课程CSV。范围为实际S5设计审阅至S6分析接受；S7由操作者普通UI暂停。R与离线数值核对不代表独立C、整篇论文完成、因果识别或人类/伦理审批。";
const DESIGN = `# 本轮操作者指定的最小观察分析方案（尚未经本轮课题组接受）
仅使用本轮提供的UCI Student Performance数学课程CSV与UCI官方说明，研究葡萄牙两所学校历史数学课程中G1/G2与G3的观察关联。该说明是本轮任务约束，不是旧接受记录、已有结果或研究发现。
固定三项计划，版本均为1；dataset.id/sha256必须取实际采用材料，不猜DATA身份：
1. ${PLAN_IDS[0]}：purpose=descriptive，method=describe，columns=[G1,G2,G3,absences]，parameters={missingPolicy:per-variable}，outputs=[descriptive,sample-accounting]。
2. ${PLAN_IDS[1]}：purpose=primary，method=ols，columns=[G1]，outcome=G3，parameters={missingPolicy:complete-case,intercept:true}，outputs=[regression.coefficients,regression.rSquared,regression.sampleSize,sample-accounting]。
3. ${PLAN_IDS[2]}：purpose=comparison，method=ols，columns=[G1,G2]，outcome=G3，同样的截距/缺失参数与OLS输出，compareWith={planId:${PLAN_IDS[1]},planVersion:1,requireSameSample:true}。
三计划均事前固定sample={mode:all}，保留零成绩，不根据结果删行、换变量或改版本；描述逐变量审计缺失，OLS各按所选变量完整案例。比较必须由实际行记录核对同一样本，若实际缺失导致不同样本则如实不接受比较，不能静默换样本。登记顺序须保证主计划先于比较计划。所有计划应在首次实际计算前登记，timing=prospective，说明本任务给定的登记理由；不倒填时间或声称已知外部计算结果。
S5先核对问题、变量定义、来源/许可、三计划及适用边界后形成真实设计稿与导师裁定；没有既有接受记录，不能伪造跳过设计。
S6 A实际run-analysis三计划各一次；B本人read-registered-analysis A每项实际运行，再以相同planId/planVersion和replayOf=A实际id各复跑一次，另用review-analysis逐项提交有理由的解释意见。同引擎一致不是独立算法或科学有效性证明。文字修订不重算未变化的计划。只有全部实际执行、B复跑和内容意见齐备后才能接受S6。
只能报告宿主实际返回的样本、缺失、描述统计、回归系数与R²等受支持输出；不口算p值/置信区间/显著性，不声称因果、全国推广、教学干预效果、研究创新已被证实或原文作者的其他结果已验证。G1/G2可能只是既有成绩信息，适用性和限制需要实际审阅。
本轮不写S7全文，不导出论文。进入S7后由操作者暂停全组；已经自然结束的S6原生运行与后继写作的实际取消分别记录。`;
const PROMPT = `${NOTICE}\n${DESIGN}
UCI官方说明通过常规材料目录提供；操作者将通过普通UI导入并采用本轮短方案和公开CSV。模型只用research_group，不bash、不联网、不读旧稿/旧R或C、不创建成员或自定义模型循环；CSV只由真实宿主登记分析工具读取，不以模型口算替代。来源及DATA身份从inputs获得。
实际入口是materials、目标paper；待普通UI导入、采用并清点后，从真实缺失的S5设计开始，不能虚构既有接受。A在S5用register-analysis按本方案登记三项v1；不要使用旧analyze/analysisPlan代替。每项objective、reviewPlan、registrationReason说明实际目的与审阅动作，时间与在先运行见证由宿主生成。B先根据共同原始说明/本轮方案独立stage-risk，再读A稿及登记计划。资料员只需每阶段一份简短原文/字段定位，不找新数据或额外文献，不凑额外资料配额。
每阶段的A/B/导师/资料员均实际source-read本阶段引用的UCI说明、操作者方案及数据来源声明；包括资料员在内，每个新阶段发布成果前都须在本人当前任务取得适用的固定方法包，可按status的methodPackageSummary用packageId复用同包，不要求重建。资料员仅交原文定位，不替A填写方法应用或替B/导师发表内容意见；页未读完按nextOffset继续，保留实际读取边界。先按需method-package取得本阶段必要少量课程依据，必要图片本人method-read-image并用本次receiptId提交method-image-reading，不把路径或他人观察当本人读图。A对每个本阶段实际采用包method-apply写清实际应用、未适用条件和限制，scoringClaim=not-scored；尽量在publish稿件前完成，避免交接时应用尚未齐备。B独立stage-risk后才read A观点或取得其私有方法解释；随后同包method-check、method-opinion给具体意见，允许有理由支持。导师实际read本阶段最新A完整稿与B复核，取得同包和必要图像，method-adjudicate引用真实B意见并method-check后再stage-review。程序完整性、B内容意见与导师模型裁定分别保留。
S5只审设计和事前计划，不计算。本轮S6只做登记分析、实际结果说明与B复跑解释；numeric-render/numeric-bind/numeric-check、数值候选/单位元数据工具及全文导出另由AC08/31的独立L/E验收，不在本R调用。S6正文中的数值直接引用本人已read的实际run.result，不加未返回指标。S6 A先核对已接受S5裁定和analysis-registry，再以run-analysis执行三项已冻结计划各一次，把真实id与输出写进完整stage-draft，analysisIds列本人实际运行。B在S6先独立stage-risk；收到A稿后实际read，并对每项A运行依次read-registered-analysis、run-analysis(planId,planVersion:1,replayOf:该A运行id)、review-analysis(planId,planVersion:1,analysisId:该A运行id,verdict,content:具体解释审阅)。B核对实际原始行/工作副本与缺失、零成绩保留、完整案例、同样本比较、截距/系数与R²解释及替代解释，区分宿主完整审计与工具仅展示前100行定位，不声称逐行看过未返回部分。模型意见必须真实，不能为测试强填accept；确有问题给revise/hold及依据。
有实质问题才stage-critique；A实际read并用stage-revision回应，B实际read后复核，未变数据/计划不再run-analysis。无实质问题可直接stage-verification accept引用实际首稿，不强制修订。S6稿中每项数据说明与数值必须来自对应实际run，analysisIds保持当前版本；B复核与导师也须本人read-registered-analysis相关A结果，导师读最新A稿/B复核后仅对S6范围给有依据裁定。不要把聊天结束当接受。
各角色完成当次工作就自然结束等自动交接，不轮询等人、不伪造答复。若工具错误或真正需要人的未知条件则如实保留并停止，不吞错、不反复试错。S7不执行分析、不取得新包、不publish稿件，简短说明本轮边界后结束，等待操作者UI暂停；不要为保持运行而睡眠或制造人的确认。`;
const FORBIDDEN = new Set([
  "analyze",
  "source-search",
  "source-fetch",
  "literature-search",
  "literature-fetch",
  "reuse-analysis",
  "numeric-render",
  "numeric-bind",
  "numeric-check",
  "numeric-candidate-review",
  "declare-result-field",
  "review-result-field",
  "request-decision",
]);

function assertNumericResult(
  run: RegisteredResearchAnalysisRun,
  oracle: ReturnType<typeof publicUciNumericAudit>,
) {
  expect(run.result.totalRows).toBe(oracle.originalRows);
  expect(run.result.completeRows).toBe(oracle.originalRows);
  expect(run.result.excludedRows).toBe(0);
  const descriptive = object(run.result.descriptive);
  for (const column of [...run.spec.columns, ...(run.spec.outcome ? [run.spec.outcome] : [])]) {
    const actual = object(descriptive[column]),
      expected = object(oracle.descriptive[column]);
    for (const field of ["n", "missing", "mean", "sd", "median", "min", "max"]) {
      expect(typeof actual[field]).toBe("number");
      expect(actual[field], `${run.planId}/${column}/${field}`).toBeCloseTo(
        Number(expected[field]),
        9,
      );
    }
  }
  if (run.spec.method === "ols") {
    const actual = object(run.result.regression),
      expected = run.planId === PLAN_IDS[1] ? oracle.primary : oracle.comparison;
    for (const [name, value] of Object.entries(expected.coefficients)) {
      expect(typeof object(actual.coefficients)[name]).toBe("number");
      expect(object(actual.coefficients)[name], `${run.planId}/coefficient/${name}`).toBeCloseTo(
        value,
        9,
      );
    }
    for (const field of ["rSquared", "sampleSize", "residualDf", "residualRmse"] as const) {
      expect(typeof actual[field]).toBe("number");
      expect(actual[field], `${run.planId}/${field}`).toBeCloseTo(expected[field], 9);
    }
  }
}

// The run stops at a real accepted S6 boundary; the project's paper goal remains unfinished.
test.describe.configure({ retries: 0 });
test("real registered UCI descriptive and two OLS plans retain actual B replay, interpretation and S6 acceptance", async () => {
  test.setTimeout(2_400_000);
  const deadline = Date.now() + 2_100_000,
    auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit live authentication required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir) throw new Error("Actual read-only RESEARCH_KNOWLEDGE_DIR required");
  if (process.env.RESEARCH_MEMBER_TOKEN_BUDGET !== undefined)
    expect(Number(process.env.RESEARCH_MEMBER_TOKEN_BUDGET)).toBe(8_000_000);
  const knowledge = await ResearchKnowledge.open(knowledgeDir),
    sourceDirectory =
      process.env.RESEARCH_REGISTERED_ANALYSIS_SOURCE_DIR ??
      resolve(__dirname, "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料");
  const manifestFile = join(sourceDirectory, "manifest.json"),
    manifestBytes = await readFile(manifestFile),
    manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  const source = (Array.isArray(manifest.sources) ? manifest.sources.map(object) : []).find(
    (source) => source.id === "UCI",
  )!;
  const declaredDataset = (
    Array.isArray(manifest.datasets) ? manifest.datasets.map(object) : []
  ).find((dataset) => dataset.id === "UCI-MATH")!;
  expect(source).toMatchObject({
    id: "UCI",
    file: "UCI.txt",
    kind: "dataset",
    url: "https://archive.ics.uci.edu/dataset/320/student-performance",
  });
  expect(declaredDataset).toMatchObject({
    id: "UCI-MATH",
    file: "student-mat.csv",
    sourceId: "UCI",
    dataKind: "observed",
    permission: "public",
    delimiter: ";",
  });
  const originalSource = join(sourceDirectory, "UCI.txt"),
    originalCsv = join(sourceDirectory, "student-mat.csv"),
    sourceBytes = await readFile(originalSource),
    csvBytes = await readFile(originalCsv);
  expect(researchHash(sourceBytes)).toBe(SOURCE_SHA256);
  expect(researchHash(csvBytes)).toBe(CSV_SHA256);
  expect(sourceBytes.toString("utf8")).toContain("Creative Commons Attribution 4.0 International");
  const oracle = publicUciNumericAudit(csvBytes.toString("utf8"));
  expect(oracle.originalRows).toBe(395);
  expect(oracle.columnCount).toBe(33);
  expect(oracle.zeroG3SourceLines.length).toBeGreaterThan(0);
  const profile = await makeUserDataDir("research-registered-analysis-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-registered-analysis-live"),
    materials = join(workspace, "provided-dataset-description"),
    csvCopy = join(workspace, "student-mat.csv"),
    designFile = join(workspace, "operator-analysis-design.txt");
  await mkdir(materials);
  await writeFile(join(materials, "UCI.txt"), sourceBytes, { flag: "wx" });
  const providedManifest = {
    version: 1,
    sources: [{ ...source, textScope: "full-text" }],
    datasets: [],
  };
  await writeFile(join(materials, "manifest.json"), JSON.stringify(providedManifest, null, 2), {
    flag: "wx",
  });
  await writeFile(csvCopy, csvBytes, { flag: "wx" });
  await writeFile(designFile, DESIGN, { flag: "wx" });
  const plan = {
    beganAt: new Date().toISOString(),
    notice: NOTICE,
    profile,
    workspace,
    materials,
    sourceDirectory,
    originalManifestSha256: researchHash(manifestBytes),
    originalSource: { file: originalSource, sha256: SOURCE_SHA256 },
    originalDataset: { ...declaredDataset, file: originalCsv, sha256: CSV_SHA256 },
    copiedCsv: csvCopy,
    operatorDesign: {
      file: designFile,
      sha256: researchHash(DESIGN),
      identity:
        "Current operator's prospective instructions, not accepted historical research or empirical data",
    },
    knowledgePin: knowledge.pin,
    route:
      "materials/paper: actual S5 acceptance -> S6 execution/acceptance -> ordinary UI pause at S7",
    memberTokenBudget: 8_000_000,
    executionDeadlineMs: 2_100_000,
    retries: 0,
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
      librarian: "openai-codex/gpt-6.1-sol low",
    },
    verificationBoundary:
      "Pinned public original and normalized working CSV have separate hashes. Offline closed-form numerical oracle is not sent to models. Same-engine B replay, semantic review and independent C are distinct.",
    coverage: {
      AC07: "Three prospective registered plans, actual A execution and B replay/interpretation",
      actualResultProvenance:
        "Original/working/row maps and plan/run/result/script archives support AC07; numeric binding and paper export require separate AC08/31 L/E",
    },
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(test.info().outputPath("initial-instruction.txt"), PROMPT);
  await writeFile(
    test.info().outputPath("offline-numeric-oracle.json"),
    JSON.stringify(oracle, null, 2),
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  let harness: DesktopHarness | undefined,
    lastState: DesktopAppState | undefined,
    failure: string | undefined,
    analysisNativeEndedAt: string | undefined,
    pauseRequestedAt: string | undefined,
    pauseObservedAt: string | undefined;
  const rendererErrors: string[] = [],
    snapshots: Record<string, ResearchProject> = {},
    archiveProof: Record<string, unknown>[] = [];
  try {
    harness = await launchDesktop(profile, {
      initialWorkspaces: [workspace],
      realAuthSourceDir: auth.sourceDir,
      enabledModels: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-astra"],
      testMode: "background",
    });
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
    await editor.getByLabel("研究入口", { exact: true }).selectOption("materials");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("paper");
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
    const current = async () => {
      lastState = await getDesktopState(page);
      return lastState.researchGroups!.projects[0]!;
    };
    await expect.poll(async () => (await current())?.status).toBe("paused");
    expect((await current()).fusion!.attempts).toEqual([]);
    expect((await current()).evidence!.datasets).toEqual([]);
    const group = page.getByRole("region", { name: "教育研究课题组", exact: true });
    // Only the OS picker selection is a labelled fixture. Import, recovery and adoption use UI.
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [designFile, csvCopy],
    );
    await group.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(2);
    const firstCsv = (await current()).importedMaterials!.find(
      (material) => material.name === basename(csvCopy),
    )!;
    snapshots.defaultCsvParse = await current();
    let adoptedCsv = firstCsv;
    if (firstCsv.tables[0]?.headers.length !== oracle.columnCount || firstCsv.status !== "ready") {
      const item = group.locator(`[data-material-id="${firstCsv.id}"]`);
      await item.locator(":scope > summary").click();
      await item.locator("summary").filter({ hasText: "处理解析问题或更新文件" }).click();
      await item.getByLabel(`${firstCsv.name} 解析分隔符`, { exact: true }).selectOption(";");
      await item.getByRole("button", { name: "按所选设置重新解析", exact: true }).click();
      await expect.poll(async () => (await current()).importedMaterials?.length).toBe(3);
      adoptedCsv = (await current()).importedMaterials!.find(
        (material) =>
          material.recovery?.fromImportId === firstCsv.id && material.recovery.kind === "reparse",
      )!;
      expect(adoptedCsv.status).toBe("ready");
      expect(adoptedCsv.sha256).toBe(CSV_SHA256);
      await item.locator(":scope > summary").click();
    }
    expect(adoptedCsv.tables[0]!.headers).toHaveLength(33);
    const designMaterial = (await current()).importedMaterials!.find(
      (material) => material.name === basename(designFile),
    )!;
    for (const material of [designMaterial, adoptedCsv]) {
      const item = group.locator(`[data-material-id="${material.id}"]`);
      await item.locator(":scope > summary").click();
      await item
        .getByLabel(`${material.name} 来源及提供说明`, { exact: true })
        .fill(
          material.id === adoptedCsv.id
            ? "UCI Student Performance数学课程公开观察数据，原始材料manifest声明observed/public；UCI官方说明列CC BY 4.0，署名Paulo Cortez，来源https://archive.ics.uci.edu/dataset/320/student-performance。保留原件、所有原始记录与零成绩；只允许本轮有限观察关联分析，不构成独立许可或伦理认证。"
            : "本轮automated-test-operator提供的前瞻任务方案；不是旧稿、旧接受或实际结果。只约束三项已支持的观察分析，仍须本轮S5审阅。",
        );
      await item
        .getByLabel(`${material.name} 材料用途`, { exact: true })
        .selectOption(material.id === adoptedCsv.id ? "data" : "design");
      if (material.id === adoptedCsv.id) {
        await item
          .getByLabel(`${material.name} 材料性质`, { exact: true })
          .selectOption("observed");
        await item.getByLabel(`${material.name} 使用依据`, { exact: true }).selectOption("public");
      } else
        await item
          .getByLabel(`${material.name} 提供文本范围`, { exact: true })
          .selectOption("full-text");
      await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
      await expect
        .poll(async () =>
          (await current()).evidence!.sources.some(
            (source) => source.materialImportId === material.id,
          ),
        )
        .toBe(true);
      await item.locator(":scope > summary").click();
    }
    await group.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect
      .poll(async () => (await current()).entryInventory?.firstMissingStage)
      .toBe("design");
    const adopted = (snapshots.adoptedBeforeExecution = await current()),
      dataset = adopted.evidence!.datasets[0]!;
    expect(adopted.entryInventory!.canStart).toBe(true);
    expect(adopted.fusion!.attempts).toEqual([]);
    expect(adopted.artifacts).toEqual([]);
    expect(adopted.evidence!.datasets).toHaveLength(1);
    expect(dataset).toMatchObject({
      materialImportId: adoptedCsv.id,
      dataKind: "observed",
      permission: "public",
      delimiter: ",",
    });
    const workingBytes = await readFile(dataset.file),
      rowMap = object(
        JSON.parse(await readFile(join(dirname(dataset.file), "row-map.json"), "utf8")),
      ),
      mapRows = Array.isArray(rowMap.rows) ? rowMap.rows.map(object) : [];
    expect(researchHash(workingBytes)).toBe(dataset.sha256);
    expect(rowMap).toMatchObject({
      originalSha256: CSV_SHA256,
      outputSha256: dataset.sha256,
      importId: adoptedCsv.id,
    });
    expect(researchHash(JSON.stringify(mapRows.map((row) => row.cells)))).toBe(
      oracle.originalCellsSha256,
    );
    expect(mapRows.map((row) => row.original)).toEqual(
      Array.from({ length: oracle.originalRows + 1 }, (_, i) => `line:${i + 1}`),
    );
    expect(mapRows.map((row) => row.outputRow)).toEqual(
      Array.from({ length: oracle.originalRows + 1 }, (_, i) => i + 1),
    );
    archiveProof.push({
      kind: "UI-adoption",
      datasetId: dataset.id,
      originalSha256: CSV_SHA256,
      workingSha256: dataset.sha256,
      rowMapFile: join(dirname(dataset.file), "row-map.json"),
      rowsPreserved: mapRows.length - 1,
      cellMatrixPreserved: true,
    });
    await group.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    // The UI action is asynchronous; an unchanged paused snapshot immediately
    // after the click is not a failed native run or a new decision request.
    await expect.poll(async () => (await current()).status).toBe("running");
    await expect
      .poll(
        async () => {
          const p = await current();
          if (rendererErrors.length || lastState!.researchGroups?.error)
            throw new Error(rendererErrors.join("; ") || lastState!.researchGroups!.error);
          const failed = p.fusion!.attempts.filter((attempt) =>
            ["failed", "unknown", "cancelled"].includes(attempt.state),
          );
          if (
            p.error ||
            failed.length ||
            ["paused", "needs-decision"].includes(p.status) ||
            p.fusion!.tasks.some((task) => task.state === "waiting-user") ||
            p.fusion!.decisionRequests?.length
          )
            throw new Error(
              JSON.stringify({
                status: p.status,
                stage: p.currentStage,
                error: p.error,
                failed,
                decisionRequests: p.fusion!.decisionRequests,
              }),
            );
          if (
            (p.analysisRegistry?.plans.length ?? 0) > 3 ||
            (p.analysisRegistry?.runs.length ?? 0) > 6
          )
            throw new Error("Bounded plan/run count exceeded; no extra calculations allowed");
          const native = await registeredAnalysisNativeEvidence(profile, p),
            invalid = native.flatMap((member) =>
              member.calls
                .filter(
                  (call) =>
                    call.isError ||
                    call.name !== "research_group" ||
                    FORBIDDEN.has(String(call.args.operation)),
                )
                .map((call) => ({ role: member.role, ...call })),
            );
          if (invalid.length)
            throw new Error(`Actual tool error/out-of-scope call: ${JSON.stringify(invalid)}`);
          if (
            p.artifacts.some(
              (artifact) =>
                artifact.stage === "design" &&
                artifact.kind === "stage-review" &&
                artifact.verdict === "accept",
            )
          )
            snapshots.designAccepted ??= structuredClone(p);
          const accepted = p.artifacts.find(
            (artifact) =>
              artifact.stage === "analysis" &&
              artifact.kind === "stage-review" &&
              artifact.verdict === "accept",
          );
          return (
            !!accepted &&
            p.currentStage === "writing" &&
            registeredAnalysisStageBoundary(p, "analysis").naturalNativeEndObserved
          );
        },
        { timeout: Math.max(1, deadline - Date.now()), intervals: [1000, 3000] },
      )
      .toBe(true);
    analysisNativeEndedAt = new Date().toISOString();
    const boundaryProject = (snapshots.analysisAcceptedBeforePause = await current());
    await writeFile(
      test.info().outputPath("analysis-natural-boundary.json"),
      JSON.stringify(
        {
          capturedAt: analysisNativeEndedAt,
          project: boundaryProject,
          analysis: registeredAnalysisStageBoundary(boundaryProject, "analysis"),
          wholeProject: captureResearchNativeBoundary(lastState!, boundaryProject),
          scope:
            "S6 native runs ended naturally; successor writing may still be active and will be paused by UI",
        },
        null,
        2,
      ),
    );
    pauseRequestedAt = new Date().toISOString();
    await group.getByRole("button", { name: "暂停全组", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = await current();
          return (
            p.status === "paused" &&
            captureResearchNativeBoundary(lastState!, p).activeNativeAtCapture.length === 0
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    pauseObservedAt = new Date().toISOString();
    const p = (snapshots.pausedAfterAnalysis = await current()),
      registry = p.analysisRegistry!,
      native = await registeredAnalysisNativeEvidence(profile, p, true);
    expect(p.goal).toBe("paper");
    expect(p.entry).toBe("materials");
    expect(p.status).toBe("paused");
    expect(p.currentStage).toBe("writing");
    expect(p.memberTokenBudget).toBe(8_000_000);
    expect(researchExecutionRoute(p, p.entryInventory).stageIds).toEqual([
      "design",
      "analysis",
      "writing",
      "audit",
    ]);
    expect(p.finalPaper).toBeUndefined();
    expect(registry.plans.map((plan) => plan.id).sort()).toEqual([...PLAN_IDS].sort());
    expect(registry.runs).toHaveLength(6);
    expect(p.analyses).toHaveLength(6);
    expect(
      registry.reviews.filter(
        (review) => review.kind === "interpretation-review" && review.actor === "model:reviewer",
      ),
    ).toHaveLength(3);
    expect(p.analysisRunAdoptions ?? []).toEqual([]);
    expect(registry).toEqual(boundaryProject.analysisRegistry);
    expect(
      p.artifacts.every((artifact) => ["design", "analysis"].includes(artifact.stage ?? "")),
    ).toBe(true);
    const acceptedDesign = p.artifacts.find(
        (artifact) =>
          artifact.stage === "design" &&
          artifact.kind === "stage-review" &&
          artifact.verdict === "accept",
      )!,
      acceptedAnalysis = p.artifacts.find(
        (artifact) =>
          artifact.stage === "analysis" &&
          artifact.kind === "stage-review" &&
          artifact.verdict === "accept",
      )!,
      manuscript = stageManuscript(p, "analysis")!;
    expect(acceptedDesign).toBeTruthy();
    expect(acceptedAnalysis.refs).toContain(manuscript.id);
    expect(registeredAnalysisStageBoundary(p, "design").naturalNativeEndObserved).toBe(true);
    expect(registeredAnalysisStageBoundary(p, "analysis").naturalNativeEndObserved).toBe(true);
    const targetCalls = native.flatMap((member) =>
      member.calls
        .filter((call) => ["design", "analysis"].includes(call.stage ?? ""))
        .map((call) => ({ role: member.role, ...call })),
    );
    expect(
      targetCalls.filter(
        (call) =>
          call.isError ||
          !call.resultAt ||
          call.name !== "research_group" ||
          FORBIDDEN.has(String(call.args.operation)),
      ),
    ).toEqual([]);
    expect(targetCalls.filter((call) => call.args.operation === "register-analysis")).toHaveLength(
      3,
    );
    expect(targetCalls.filter((call) => call.args.operation === "run-analysis")).toHaveLength(6);
    for (const registered of registry.plans) {
      expect(registered.version).toBe(1);
      expect(registered.dataset).toEqual({ id: dataset.id, sha256: dataset.sha256 });
      expect(registered.registration).toMatchObject({
        timing: "prospective",
        sourceRef: expect.stringMatching(/^tool:/),
        observedPriorRunIds: [],
      });
      expect(registered.sample).toEqual({ mode: "all" });
      expect(p.activeAnalysisPlans).toContainEqual({ id: registered.id, version: 1 });
      expect(registered.parameters).toEqual(
        registered.method === "describe"
          ? { missingPolicy: "per-variable" }
          : { missingPolicy: "complete-case", intercept: true },
      );
      const runs = registry.runs.filter((run) => run.planId === registered.id),
        original = runs.find((run) => run.actor === "model:lead")!,
        replay = runs.find((run) => run.actor === "model:reviewer")!;
      expect(runs).toHaveLength(2);
      expect(original.verification).toEqual({ level: "unreviewed" });
      expect(replay.verification).toEqual({
        level: "same-engine-replay",
        replayOf: original.id,
        matches: true,
      });
      expect(replay.resultSha256).toBe(original.resultSha256);
      expect(replay.sample).toEqual(original.sample);
      expect(Date.parse(original.at)).toBeGreaterThanOrEqual(Date.parse(acceptedDesign.createdAt));
      for (const registeredPlan of registry.plans)
        expect(Date.parse(registeredPlan.registration.at)).toBeLessThanOrEqual(
          Date.parse(original.at),
        );
      for (const run of runs) {
        expect(run.sample.originalDataRows).toBe(oracle.originalRows);
        expect(run.sample.selectedSourceLines).toEqual(oracle.sourceLines);
        expect(run.sample.completeSourceLines).toEqual(oracle.sourceLines);
        expect(run.sample.missing).toEqual([]);
        expect(run.sample.excluded).toEqual([]);
        expect(run.sample.label).toBe("original-all-records");
        for (const lines of Object.values(run.sample.perVariableSourceLines))
          expect(lines).toEqual(oracle.sourceLines);
        for (const sourceLine of oracle.zeroG3SourceLines)
          expect(run.sample.completeSourceLines).toContain(sourceLine);
        expect(run.adapter).toBe("analysis-registry-1");
        expect(run.datasetSha256).toBe(dataset.sha256);
        expect(run.replay.planSha256).toBe(researchHash(JSON.stringify(registered)));
        expect(run.resultSha256).toBe(researchHash(JSON.stringify(run.result)));
        const { runSha256, ...contents } = run;
        expect(runSha256).toBe(researchHash(JSON.stringify(contents)));
        assertNumericResult(run, oracle);
        const projection = p.analyses!.find((projection) => projection.id === run.id)!;
        expect(isCurrentResearchAnalysis(p, projection)).toBe(true);
        const attempt = p.fusion!.attempts.find((attempt) => attempt.id === projection.attemptId)!;
        expect(attempt.state).toBe("succeeded");
        expect(attempt.nativeRunId).toBeTruthy();
        expect(attempt.taskVersion).toBe(projection.taskInputVersion);
        const archiveDirectory = dirname(projection.file),
          hashes: Record<string, string> = {};
        for (const file of ANALYSIS_ARCHIVE_FILES)
          hashes[file] = researchHash(await readFile(join(archiveDirectory, file)));
        expect(hashes["input.csv"]).toBe(dataset.sha256);
        expect(hashes["calculation-input.csv"]).toBe(run.calculationInputSha256);
        expect(hashes["replay.mjs"]).toBe(projection.replayScriptSha256);
        expect(
          JSON.parse(
            await readFile(join(archiveDirectory, "registered-run.json"), "utf8"),
          ) as unknown,
        ).toEqual(run);
        expect(
          JSON.parse(await readFile(join(archiveDirectory, "plan.json"), "utf8")) as unknown,
        ).toEqual(registered);
        expect(JSON.parse(await readFile(projection.file, "utf8")) as unknown).toEqual(projection);
        archiveProof.push({
          runId: run.id,
          planId: run.planId,
          version: run.planVersion,
          archiveDirectory,
          hashes,
          originalInputIdentity:
            "UI-normalized working CSV; immutable semicolon original linked by row-map/provenance",
          noAdditionalReplayExecution: true,
        });
        expect(Date.parse(run.at)).toBeLessThanOrEqual(Date.parse(acceptedAnalysis.createdAt));
      }
      const read = p.analysisReads!.find(
          (read) =>
            read.operation === "read-registered-analysis" &&
            read.context.role === "reviewer" &&
            read.pin.runId === original.id,
        )!,
        review = registry.reviews.find(
          (review) =>
            review.kind === "interpretation-review" &&
            review.actor === "model:reviewer" &&
            review.runId === original.id,
        )!;
      expect(read).toBeTruthy();
      expect(Date.parse(read.at)).toBeLessThanOrEqual(Date.parse(replay.at));
      expect(review).toMatchObject({
        planId: registered.id,
        planVersion: 1,
        verdict: "accept",
        evidenceRef: expect.stringMatching(/^tool:/),
      });
      expect(review.note.trim().length).toBeGreaterThan(80);
      const context = p.analysisReviewContexts!.find((context) => context.reviewId === review.id)!;
      expect(context.context).toMatchObject({
        role: "reviewer",
        model: { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "high" },
      });
      const reviewRead = p.analysisReads!.find((read) => read.id === context.readId)!;
      expect(reviewRead).toMatchObject({
        operation: "read-registered-analysis",
        context: { role: "reviewer" },
        pin: { runId: original.id },
      });
      expect(Date.parse(reviewRead.at)).toBeLessThanOrEqual(Date.parse(review.at));
      expect(Date.parse(review.at)).toBeLessThanOrEqual(Date.parse(acceptedAnalysis.createdAt));
      expect(
        targetCalls.some(
          (call) =>
            call.role === "reviewer" &&
            call.id === read.callId &&
            call.args.analysisId === original.id &&
            call.args.operation === "read-registered-analysis" &&
            !call.isError,
        ),
      ).toBe(true);
      expect(
        targetCalls.some(
          (call) =>
            call.role === "reviewer" &&
            call.args.operation === "run-analysis" &&
            call.args.replayOf === original.id &&
            call.args.planId === registered.id &&
            !call.isError,
        ),
      ).toBe(true);
      expect(
        targetCalls.some(
          (call) =>
            call.role === "reviewer" &&
            call.id === context.callId &&
            call.args.operation === "review-analysis" &&
            call.args.analysisId === original.id &&
            !call.isError,
        ),
      ).toBe(true);
      expect(
        p.analysisReads!.some(
          (read) =>
            read.context.role === "mentor" &&
            read.pin.runId === original.id &&
            read.operation === "read-registered-analysis" &&
            Date.parse(read.at) <= Date.parse(acceptedAnalysis.createdAt),
        ),
      ).toBe(true);
    }
    expect(registry.plans.find((plan) => plan.id === PLAN_IDS[0])).toMatchObject({
      purpose: "descriptive",
      method: "describe",
      columns: ["G1", "G2", "G3", "absences"],
    });
    expect(registry.plans.find((plan) => plan.id === PLAN_IDS[1])).toMatchObject({
      purpose: "primary",
      method: "ols",
      columns: ["G1"],
      outcome: "G3",
    });
    expect(registry.plans.find((plan) => plan.id === PLAN_IDS[2])).toMatchObject({
      purpose: "comparison",
      method: "ols",
      columns: ["G1", "G2"],
      outcome: "G3",
      compareWith: { planId: PLAN_IDS[1], planVersion: 1, requireSameSample: true },
    });
    expect(
      registry.runs.find((run) => run.planId === PLAN_IDS[1])!.sample.completeSourceLines,
    ).toEqual(registry.runs.find((run) => run.planId === PLAN_IDS[2])!.sample.completeSourceLines);
    for (const artifact of p.artifacts)
      expect(artifact.model).toEqual(
        p.stages!.find((stage) => stage.id === artifact.stage)!.models[artifact.role],
      );
    for (const stage of ["design", "analysis"] as const) {
      const accepted = p.artifacts.find(
          (artifact) =>
            artifact.stage === stage &&
            artifact.kind === "stage-review" &&
            artifact.verdict === "accept",
        )!,
        latest = stageManuscript(p, stage)!;
      const verification = p.artifacts
        .filter(
          (artifact) =>
            artifact.stage === stage &&
            artifact.kind === "stage-verification" &&
            artifact.refs.includes(latest.id),
        )
        .at(-1)!;
      expect(verification.verdict).toBe("accept");
      expect(accepted.refs).toEqual(expect.arrayContaining([latest.id, verification.id]));
      for (const role of ["lead", "reviewer", "mentor"] as const)
        expect(
          p.events.some(
            (event) =>
              event.type === "source-read" &&
              event.stage === stage &&
              event.role === role &&
              event.sourceId === "UCI" &&
              event.sourceSha256 === SOURCE_SHA256 &&
              event.at <= accepted.createdAt,
          ),
        ).toBe(true);
      for (const [role, artifact, before] of [
        ["reviewer", latest, verification.createdAt],
        ["mentor", latest, accepted.createdAt],
        ["mentor", verification, accepted.createdAt],
      ] as const)
        expect(
          p.events.some(
            (event) =>
              event.type === "read" &&
              event.stage === stage &&
              event.role === role &&
              event.artifactId === artifact.id &&
              event.at >= artifact.createdAt &&
              event.at <= before,
          ),
        ).toBe(true);
      if (stage === "analysis")
        expect(latest.analysisIds).toEqual(
          expect.arrayContaining(
            registry.runs.filter((run) => run.actor === "model:lead").map((run) => run.id),
          ),
        );
      for (const role of ["reviewer", "mentor"] as const)
        expect(
          p.methodProgramChecks!.some(
            (check) =>
              check.role === role &&
              check.stage === stage &&
              check.result === "passed-at-snapshot" &&
              check.target?.artifactId === latest.id &&
              check.target.bodySha256 === researchHash(latest.content) &&
              check.issues.length === 0,
          ),
        ).toBe(true);
      expect(Date.parse(accepted.createdAt)).toBeLessThanOrEqual(Date.parse(analysisNativeEndedAt));
    }
    const panel = page.getByTestId("research-analysis-registry-panel");
    await panel.locator(":scope > summary").click();
    await expect(panel.locator(":scope > summary")).toContainText("3 项计划");
    await page.screenshot({ path: test.info().outputPath("registered-analysis-paused-at-S7.png") });
    expect(rendererErrors).toEqual([]);
    expect(
      (await researchNativeCallLedger(profile, p))
        .flatMap((member) => member.calls)
        .filter((call) => call.name !== "research_group" || FORBIDDEN.has(String(call.operation))),
    ).toEqual([]);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      const evidenceFailures: string[] = [];
      if (harness)
        lastState = await harness
          .firstWindow()
          .then(getDesktopState)
          .catch((error: unknown) => {
            evidenceFailures.push(`Final snapshot: ${String(error)}`);
            return lastState;
          });
      const project = lastState?.researchGroups?.projects[0];
      await writeFile(
        test.info().outputPath("research-project.json"),
        JSON.stringify(project ?? null, null, 2),
      );
      const checks: [string, string, string][] = [
        ["originalCsv", originalCsv, CSV_SHA256],
        ["originalSource", originalSource, SOURCE_SHA256],
        ["originalManifest", manifestFile, researchHash(manifestBytes)],
        ["copiedCsv", csvCopy, CSV_SHA256],
        ["copiedSource", join(materials, "UCI.txt"), SOURCE_SHA256],
        ["operatorDesign", designFile, researchHash(DESIGN)],
        [
          "providedManifest",
          join(materials, "manifest.json"),
          researchHash(JSON.stringify(providedManifest, null, 2)),
        ],
        ["knowledgeIndex", join(knowledgeDir, "索引", "知识块.jsonl"), knowledge.pin.sha256],
      ];
      for (const material of project?.importedMaterials ?? [])
        checks.push([`imported:${material.id}`, material.original, material.sha256]);
      for (const dataset of project?.evidence?.datasets ?? [])
        checks.push([`working:${dataset.id}`, dataset.file, dataset.sha256]);
      const integrity = Object.fromEntries<boolean>(
        await Promise.all(
          checks.map(
            async ([label, file, expected]) =>
              [
                label,
                await readFile(file)
                  .then((bytes) => researchHash(bytes) === expected)
                  .catch((error: unknown) => {
                    evidenceFailures.push(`${label}: ${String(error)}`);
                    return false;
                  }),
              ] as const,
          ),
        ),
      );
      if (Object.values(integrity).some((value) => !value))
        evidenceFailures.push("Source/working/imported/knowledge integrity check failed");
      const native = project
        ? await registeredAnalysisNativeEvidence(profile, project, !!pauseObservedAt).catch(
            (error: unknown) => {
              evidenceFailures.push(`Native evidence: ${String(error)}`);
              return null;
            },
          )
        : null;
      if (project)
        for (const artifact of project.artifacts)
          await writeFile(test.info().outputPath(`artifact-${artifact.id}.md`), artifact.content);
      const boundaries =
        project && lastState
          ? {
              design: registeredAnalysisStageBoundary(project, "design"),
              analysis: registeredAnalysisStageBoundary(project, "analysis"),
              wholeProject: captureResearchNativeBoundary(lastState, project),
              successorAttempts: project.fusion?.attempts.filter(
                (attempt) =>
                  project.fusion!.tasks.find((task) => task.id === attempt.taskId)?.stage ===
                  "writing",
              ),
            }
          : null;
      await writeFile(
        test.info().outputPath("registered-analysis-proof.json"),
        JSON.stringify(
          {
            notice: NOTICE,
            assertionFailure: failure ?? null,
            snapshots,
            native,
            archiveProof,
            boundaries,
            integrity,
            evidenceFailures,
            contentReview:
              "R actual tools plus offline numeric oracle only. Interpretation notes, current S6 manuscript and method judgments await separate independent C. Post-S6 pause/cancellation is not natural completion of all members or a complete paper.",
          },
          null,
          2,
        ),
      );
      await writeFile(
        test.info().outputPath("run-outcome.json"),
        JSON.stringify(
          {
            ...plan,
            endedAt: new Date().toISOString(),
            analysisNativeEndedAt: analysisNativeEndedAt ?? null,
            pauseRequestedAt: pauseRequestedAt ?? null,
            pauseObservedAt: pauseObservedAt ?? null,
            automatedAcceptance:
              analysisNativeEndedAt && pauseObservedAt && !failure && !evidenceFailures.length
                ? "S6-R-passed-awaiting-C-project-paused-at-S7"
                : "failed",
            failure: failure ?? (evidenceFailures.length ? evidenceFailures.join("; ") : null),
            finalStatus: project?.status ?? "not-created",
            projectSnapshot: project ?? null,
            boundaries,
            integrity,
            rendererErrors,
            evidenceFailures,
            allNativeNaturalCompletionClaimed: false,
            completePaperClaimed: false,
            teardownNotice:
              "UI pause may cancel successor writing. Closing unfinished native work on any failure is cleanup, never successful natural S6 completion.",
          },
          null,
          2,
        ),
      );
      expect(evidenceFailures).toEqual([]);
    } finally {
      await harness?.close();
    }
  }
});
