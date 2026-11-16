import { expect, test } from "@playwright/test";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { researchTaskControlDecisionStatus } from "../../contracts/research-task-controls";
import type { ResearchCandidateGap } from "../../contracts/research-synthesis";
import { readPinnedResearchFile, researchHash } from "../../electron/research-group/materials";
import {
  assertResearchSynthesisAcceptance,
  validateResearchSynthesisProject,
  type SynthesisProject,
} from "../../electron/research-group/synthesis-tools";
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

const CHECKPOINT = "AC24新增材料检查点";
const CONTINUE = "continue-with-source";
const TITLE = "A three-stage machine learning and inference approach for educational data";
const DA_URL = "https://www.nature.com/articles/s41598-025-89394-2";
const SMS_URL = "https://www.nature.com/articles/s41598-025-19159-4";
const NOTICE =
  "automated-test-operator：这是新建、真实公开文献的有边界反证流程R，不是完整综述、统计复算或人类学术评审。初始材料和后加入材料严格分开；内容质量另交独立C核查。";
const SCOPE =
  "对葡萄牙中学生公开材料中的缺勤与数学/葡语成绩关系作限定文献综合；初始结论只针对本轮已经取得的材料，不写成无人研究、创新已证或因果定论。";
const PROMPT = `${NOTICE}\n${SCOPE}
上述问题范围与已取得材料是测试操作者的输入，不是模型已经完成或已经接受的研究阶段。本轮从普通materials入口、goal=design开始；宿主对实际来源清点后合法从S3阅读→S4综合接受，S5仅作为新增材料先后顺序检查点；之后局部重审S4，不另验整份S5方案。S0/S1/S2未执行，不重跑或虚构其稿件、检索、完成和接受历史。初始材料仍只有SMS2025已取得网页正文与UCI官方字段/来源说明，datasets为空。没有CSV，不计算，不读旧R/C或旧稿，不联网补文献，不bash/外部命令；只使用research_group。课程包仅作必要方法背景；不能当作原论文实证，UCI数据说明也不冒充论文。
S3只读判断本问题所需的相关片段。SMS中性导航是字符区间[0,2500]及[34000,38000]：可先用source-read的真实offset=0、offset=34000，在工具实际返回片段中定位；这只是阅读位置，不提供结果或结论。source-read没有自造的limit/end参数；按实际返回的完整范围及depth留证，不能把导航区间或部分读取冒称全文核验。两份原文文件继续完整可读、没有裁剪，必要时可真实读取其他位置；不为凑全文阅读重复调用。
第一次取得与本问题有关的必要固定方法包，后续按同一packageId复用并遵守本native实际取得凭据要求，不重复扩大根检索或重建同一包。method-check参数必须是{operation:'method-check',packageId,applicationId?}，packageId用真实返回值；需要查综合状态时synthesis-context只能传{operation:'synthesis-context'}，不得加artifactId或request。新稿方法应用、B内容意见、导师裁定仍须按本稿完成，不能因缩短路由绕过。
需要独立核查的候选缺口是：“当前已取得材料是否还缺直接讨论单科缺勤关联方向与学科差异的研究论文？”这是一项待验证的材料范围假设，不是要求你们同意的结论；如果SMS本身已经回答，就依据原文纠正这个假设，不伪造缺口。尤其区分预测特征重要性、关联方向、统计未显著、零效应和因果解释。实际读到什么才说什么，未取得的原图/表不宣称核验。
A/B各自source-read实际来源并按当前阶段独立判断，再互评。S4中A先实际发表本阶段stage-draft，B先实际发表本阶段stage-risk，再按需要synthesis-context；本人初判前不读peer意见或全部综合context。A以实际stage-draft/stage-revision保存有界综合，用本人read当前稿后synthesis-matrix登记七列原文矩阵（研究问题、对象情境、概念测量、设计证据、发现、局限、与问题的关系）；不可见项显式unavailable。来源引用用本人的真实source-read范围与实际深度。若上述候选缺口在当前材料集中尚未获回答，用synthesis-gap登记pending-validation并限定范围及不确定性；未做反向检索不能登记supported-in-scope。本轮以候选缺口本身作为关键待核主张：同稿矩阵和gap固定来源、位置、范围与不确定性，后续counterevidence/response/review/resolution保存前后稿及本人读取、核查者、具体理由和影响。不要再把每个背景来源事实复制成另一套独立claim对象，重复执行本轮范围之外的全量引用审阅；AC09另有专门验收。B仍须本人读原文和当前稿，逐项说明与本缺口直接相关的事实支持、限制和反例，不能以此范围说明免除实质内容核查。若另行提出超出该缺口链的独立关键主张，仍须处理其必要证据与意见，不能绕过产品门禁。B可以有理由地同意A，不能为了测试凑反对。按实际A/B核查结果由导师接受或明确说明不合格，不能预先保证候选成立。
S4综合正式接受后，S5导师马上先status读取实际taskId，通过request-decision提出一次新的局部条件，question必须包含“${CHECKPOINT}”，conditionId=ac24-new-evidence，taskIds只包含本轮S5导师自己的实际taskId；问题是是否已完成操作者计划的新增材料步骤并在同revision中复核。options两项：id=${CONTINUE},label=新增材料已采用，继续读取核查,outcome=confirmed；id=defer,label=暂缓后续裁定,outcome=deferred。推荐${CONTINUE}，但请求后结束本次运行，不代答、不循环status、不发表S5最终接受。这个条件只为本次先后加入文献的验收顺序，不是学术证据或新的研究许可，不回头阻塞已接受S4。本次只验反证局部重审，S5不是新的方案验收；A/B/资料员在S5收到派发时只核对既有成果和本次材料顺序，不另写一套方案/全量引用审阅或反复轮询，正常结束本次回复。新增原文后完成受影响S4的必要工作；无关已接受成果仍保留。真实UI答复后沿用同一条件及答复记录，不换conditionId重问。本次不以等待或同时亮灯声明AC26并发收益。
操作者将在S4接受后从普通UI导入采用另一篇真实论文，再答复上述条件；初始阶段不要猜那篇论文的结论。新来源出现后，由B（资料员也可先定位）本人source-read相关Case/结果具体位置，独立决定它是否真正削弱原候选缺口。若确实削弱，以synthesis-counterevidence明确关联原synthesis-gap及必要claim，reason说明只影响哪项材料缺口/问题或设计，materialChange=true；不把论文仅附进参考文献。若原稿因既有变更变为needs-review，先真实read那份已接受历史基线；它仅作被挑战对象，不能用于当前支持。别把新来源当作使所有旧事实无效的理由。
局部重开后A必须在受影响任务当前版本发表实际新稿，按新证据维持/收窄/撤销原候选创新理由，并保留旧稿；新矩阵/缺口用supersedesId保存前后版本，然后synthesis-respond逐项关联before/after、给实际新稿UTF-16位置和具体回应。B重新本人读原反证以及当前新稿，使用synthesis-review定位具体回应、说明addressed或unresolved，不能借他人或旧native读取。导师本人读同一原反证及最新A/B成果，以synthesis-resolve具名处理materialChange；未关闭不得用stage-review accept绕过。顺序上B先提交synthesis-review并message通知导师；导师本人source-read原文、read新A稿、synthesis-context取得具名B复核后先resolve。关闭之后B才发布stage-verification/accept，导师再正式接受同一当前S4稿；不要让导师等验证稿而B等反证关闭形成循环。若是实质问题/设计方向改变，遵守FR24已采用的真实用户决定，原授权不等于伦理审批。新文献若只缩小材料缺口而不改变研究对象，可明确narrow并保留条件，不强造方向改变。
本轮结束点是当前S4新稿的逐项回应、B本人复核和导师synthesis-resolve具名处理全部完成，再补齐本稿必要方法意见/裁定并对同一当前S4新稿正式stage-review accept，保留程序门禁；然后各自正常结束原生回复。不再为完成整份S5方案而追加设计接受/分析/写作阶段；S4接受后若收到S5派发，只说明本轮局部工作已完成、后续方案未执行并正常结束，不另发稿或循环status。剩余研究任务明确保留待继续，不称整项课题或研究方案完成。不执行分析，不生成本研究系数/p值。引用论文作者结论时明确是作者报告；不能把未显著写成零效应、把预测写成方向或把另一目标估计写成同一效应相反。本轮各A稿约500-900字，B稿约200-400字，导师约200字；具体位置/限制写入结构化记录。所有裁定均标模型判断，正常发布后结束并让宿主接续。`;

function gapDescends(gaps: ResearchCandidateGap[], afterId: string, beforeId: string): boolean {
  const seen = new Set<string>();
  let id: string | undefined = afterId;
  while (id && !seen.has(id)) {
    if (id === beforeId) return true;
    seen.add(id);
    id = gaps.find((gap) => gap.id === id)?.supersedesId;
  }
  return false;
}

function assertMaterialsRouteHistory(p: ResearchProject) {
  const stages = new Set(["reading", "synthesis", "design"]);
  expect(p.entry).toBe("materials");
  expect(p.goal).toBe("design");
  expect(p.fusion!.tasks.length).toBeGreaterThan(0);
  expect(p.fusion!.tasks.filter((task) => !stages.has(task.stage))).toEqual([]);
  expect(p.artifacts.filter((artifact) => !artifact.stage || !stages.has(artifact.stage))).toEqual(
    [],
  );
  expect(
    p.events.filter(
      (event) =>
        ["started", "finished", "published"].includes(event.type) &&
        (!event.stage || !stages.has(event.stage)),
    ),
  ).toEqual([]);
  // Supplied question/material context is not a completed or accepted S1/S2 artifact.
  expect(
    p.artifacts.filter((artifact) => ["scan", "question", "search"].includes(artifact.stage ?? "")),
  ).toEqual([]);
}

/** Never execute together with another build/Electron run. No state seeding, fake transcript or fixed sleep. */
test("a newly adopted actual paper changes a bounded accepted gap through A/B/mentor local review", async () => {
  test.setTimeout(1_800_000); // Fixed 30-minute ceiling; preserve failure rather than extending it.
  const deadline = Date.now() + 1_650_000;
  const auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit real-provider opt-in required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  const budget = Number(process.env.RESEARCH_MEMBER_TOKEN_BUDGET);
  if (!knowledgeDir || budget !== 8_000_000)
    throw new Error(
      "Provide actual RESEARCH_KNOWLEDGE_DIR and explicit RESEARCH_MEMBER_TOKEN_BUDGET=8000000; this bounded rerun must preserve the original per-member cap",
    );
  const originalDirectory =
    process.env.RESEARCH_COUNTEREVIDENCE_MATERIALS_DIR ??
    resolve(__dirname, "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料");
  // Read only these three original source texts. Never open the original CSV, old manuscript, R/C or credentials.
  const original = Object.fromEntries(
    await Promise.all(
      ["SMS2025", "UCI", "DA2025"].map(
        async (id) => [id, await readFile(join(originalDirectory, `${id}.txt`))] as const,
      ),
    ),
  );
  expect(original.SMS2025!.toString()).toContain("Top 5 feature importances");
  expect(original.DA2025!.toString()).toContain("Case # 3. Class absences");
  expect(original.DA2025!.toString()).toContain(TITLE);
  const profile = await makeUserDataDir("research-counterevidence-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-counterevidence-live"),
    initialDirectory = join(workspace, "initial-sources");
  await mkdir(initialDirectory);
  await Promise.all(
    ["SMS2025", "UCI"].map((id) =>
      writeFile(join(initialDirectory, `${id}.txt`), original[id]!, { flag: "wx" }),
    ),
  );
  await writeFile(
    join(initialDirectory, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        sources: [
          {
            id: "SMS2025",
            file: "SMS2025.txt",
            title:
              "Artificial intelligence in student management systems to enhance academic performance monitoring and intervention",
            authors: "Yueying Wang",
            year: "2025",
            url: SMS_URL,
            kind: "paper",
            textScope: "partial-text",
          },
          {
            id: "UCI",
            file: "UCI.txt",
            title: "Student Performance",
            authors: "Paulo Cortez",
            year: "2008",
            url: "https://archive.ics.uci.edu/dataset/320/student-performance",
            kind: "dataset",
            textScope: "partial-text",
          },
        ],
        datasets: [],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  const plan = {
    beganAt: new Date().toISOString(),
    notice: NOTICE,
    scope: SCOPE,
    entry: "materials",
    goal: "design",
    expectedRoute: ["reading", "synthesis", "design"],
    unexecutedStages: ["scan", "question", "search"],
    profile,
    workspace,
    initialIds: ["SMS2025", "UCI"],
    withheldUntilAccepted: "DA2025",
    sourcePins: Object.fromEntries(
      Object.entries(original).map(([id, bytes]) => [
        id,
        { sha256: researchHash(bytes), bytes: bytes.length },
      ]),
    ),
    addedPaper: { title: TITLE, author: "Ting Da", year: "2025", url: DA_URL },
    memberTokenBudget: budget,
    timeoutPolicy: "30 minutes fixed; no skip, retries, sleep-based checkpoint or extension",
    boundary:
      "AC24 only: actual accepted S4 baseline followed by new-source local A/B/mentor review; no complete S5 design or project-completion claim. Real UI importer/adoption and actual provider calls; OS picker-result is a labelled fixture; semantics remain for independent C; no AC26 concurrency claim",
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(test.info().outputPath("initial-instruction.txt"), PROMPT);
  const harness = await launchDesktop(profile, {
    initialWorkspaces: [workspace],
    realAuthSourceDir: auth.sourceDir,
    enabledModels: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-astra"],
    testMode: "background",
  });
  let lastState: DesktopAppState | undefined,
    initialProject: SynthesisProject | undefined,
    baseline: SynthesisProject | undefined,
    finalProject: SynthesisProject | undefined,
    failure: string | undefined;
  const interventions: { at: string; action: string }[] = [],
    rendererErrors: string[] = [];
  try {
    const page = await harness.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(knowledgeDir);
    await editor.getByLabel("研究材料目录", { exact: true }).fill(initialDirectory);
    await editor.getByLabel("研究入口", { exact: true }).selectOption("materials");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("design");
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    await editor.getByLabel("成员 Token 上限", { exact: true }).fill(String(budget));
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
      return lastState.researchGroups?.projects[0] as SynthesisProject | undefined;
    };
    const pending = (p: ResearchProject) =>
      p.fusion?.decisionRequests?.filter(
        (request) => researchTaskControlDecisionStatus(p.fusion!, request.id) === "pending",
      ) ?? [];
    let lastLogged = 0;
    const observe = async (phase: string, allowLocalQuiescence = false) => {
      const p = await current();
      if (lastState?.researchGroups?.error) throw new Error(lastState.researchGroups.error);
      if (p && Date.now() - lastLogged >= 20_000) {
        lastLogged = Date.now();
        await appendFile(
          test.info().outputPath("progress.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            phase,
            revision: p.revision,
            stage: p.currentStage,
            status: p.status,
            artifacts: p.artifacts.length,
            matrices: p.synthesis?.matrices.length,
            gaps: p.synthesis?.gaps.length,
            counterevidence: p.synthesis?.counterevidence.length,
            errors: p.events.filter((event) => event.type === "error"),
            pending: pending(p).map((request) => ({ id: request.id, question: request.question })),
            ...captureResearchNativeBoundary(lastState!, p),
          }) + "\n",
        );
      }
      if (
        p &&
        (p.status === "paused" ||
          (p.status === "needs-decision" && !allowLocalQuiescence) ||
          p.fusion?.attempts.some((attempt) =>
            ["failed", "unknown", "cancelled"].includes(attempt.state),
          ))
      )
        throw new Error(
          `Real run requires explicit recovery; retain evidence: ${p.error ?? p.status}`,
        );
      return p;
    };
    await expect
      .poll(
        async () => {
          const p = await current();
          if (lastState?.researchGroups?.error) throw new Error(lastState.researchGroups.error);
          if (p?.entryInventory && !p.entryInventory.canStart)
            throw new Error(
              `Actual material inventory cannot start: ${JSON.stringify(p.entryInventory)}`,
            );
          return !!p?.entryInventory?.canStart;
        },
        { timeout: Math.max(1, deadline - Date.now()), intervals: [1000, 2500] },
      )
      .toBe(true);
    initialProject = structuredClone((await current())!);
    const initialRoute = researchExecutionRoute(initialProject, initialProject.entryInventory);
    expect(initialProject.entryInventory).toMatchObject({
      revision: initialProject.revision,
      canStart: true,
      firstMissingStage: "reading",
    });
    expect(initialRoute).toMatchObject({
      startStage: "reading",
      endStage: "design",
      stageIds: ["reading", "synthesis", "design"],
      needsInventory: false,
      blockedReasons: [],
    });
    expect(initialProject.evidence!.sources.map((source) => source.id).sort()).toEqual([
      "SMS2025",
      "UCI",
    ]);
    expect(initialProject.evidence!.datasets).toEqual([]);
    for (const source of initialProject.evidence!.sources)
      expect(source.sha256).toBe(researchHash(original[source.id]!));
    assertMaterialsRouteHistory(initialProject);
    await writeFile(
      test.info().outputPath("actual-materials-entry-project.json"),
      JSON.stringify(
        {
          project: initialProject,
          route: initialRoute,
          unexecutedStages: ["scan", "question", "search"],
          boundary:
            "Actual inventory locates S3 from matching supplied paper bytes; no earlier research work or acceptance is seeded or claimed.",
        },
        null,
        2,
      ),
    );
    await expect
      .poll(
        async () => {
          const p = await observe("initial-synthesis");
          if (!p) return false;
          if (p.evidence?.sources.some((source) => source.title === TITLE || source.url === DA_URL))
            throw new Error("Withheld paper leaked into initial evidence");
          const gap = p.synthesis?.gaps.find(
            (entry) =>
              entry.draft.taskId === `v${p.revision}:synthesis:lead` &&
              p.fusion?.artifacts.some(
                (artifact) =>
                  artifact.id === entry.artifactId && artifact.reviewState === "accepted",
              ),
          );
          const checkpoint = pending(p).find((request) => request.question.includes(CHECKPOINT));
          if (p.status === "completed" && !checkpoint)
            throw new Error("Run ended without the explicit ordinary-UI material checkpoint");
          if (gap && checkpoint) {
            baseline = structuredClone(p);
            return true;
          }
          return false;
        },
        { timeout: Math.max(1, deadline - Date.now()), intervals: [1000, 2500] },
      )
      .toBe(true);
    const before = baseline!,
      oldGap = before.synthesis!.gaps.find((gap) =>
        before.fusion!.artifacts.some(
          (artifact) => artifact.id === gap.artifactId && artifact.reviewState === "accepted",
        ),
      )!;
    assertMaterialsRouteHistory(before);
    expect(before.events.find((event) => event.type === "started")?.stage).toBe("reading");
    expect(
      before.artifacts.some(
        (artifact) =>
          artifact.stage === "reading" &&
          artifact.kind === "stage-review" &&
          artifact.verdict === "accept",
      ),
    ).toBe(true);
    expect(oldGap.state).toBe("pending-validation");
    expect(before.evidence!.datasets).toEqual([]);
    await writeFile(
      test.info().outputPath("before-counterevidence-project.json"),
      JSON.stringify(before, null, 2),
    );
    await page.screenshot({
      path: test.info().outputPath("accepted-synthesis-before-added-paper.png"),
    });
    // The local decision is real. Drain actual native completions before material-impact preview;
    // this is an observed readiness condition, not a sleep or a claim of live collaboration.
    await expect
      .poll(
        async () => {
          const p = await observe("awaiting-ordinary-ui-material");
          return (
            !!p &&
            pending(p).some((entry) => entry.question.includes(CHECKPOINT)) &&
            captureResearchNativeBoundary(lastState!, p).activeNativeAtCapture.length === 0
          );
        },
        { timeout: Math.max(1, deadline - Date.now()), intervals: [1000, 2500] },
      )
      .toBe(true);
    const selected = join(workspace, "DA2025-new-paper.txt");
    await writeFile(selected, original.DA2025!, { flag: "wx" });
    const panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
    // OS picker result is a fixture. Actual parsing, original preservation, declaration and adoption are UI actions.
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [selected],
    );
    interventions.push({
      at: new Date().toISOString(),
      action:
        "After actual S4 acceptance, imported the newly copied original DA source via ordinary material UI; no manuscript or state insertion",
    });
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect
      .poll(async () =>
        (await current())?.importedMaterials?.some(
          (material) => material.name === "DA2025-new-paper.txt",
        ),
      )
      .toBe(true);
    const summary = panel
      .locator("summary")
      .filter({ hasText: /^DA2025-new-paper\.txt ·/ })
      .first();
    await summary.click();
    const item = summary.locator("..");
    await item.getByLabel("DA2025-new-paper.txt 材料用途", { exact: true }).selectOption("paper");
    await item
      .getByLabel("DA2025-new-paper.txt 来源及提供说明", { exact: true })
      .fill(
        `Ting Da (2025). ${TITLE}. ${DA_URL}. 新增的真实公开网页原文副本，保留原件及来源；文本未含可读原图/表，不声称全文图表核验。请本人读取Case #3的研究范围、实际结果叙述与限制后独立判断是否影响既有候选缺口；这条提供说明不预设其支持方向。`,
      );
    await item
      .getByLabel("DA2025-new-paper.txt 提供文本范围", { exact: true })
      .selectOption("partial-text");
    await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect
      .poll(async () => {
        const p = await current();
        return p?.evidence?.sources.some(
          (source) =>
            source.materialImportId ===
            p.importedMaterials?.find((material) => material.name === "DA2025-new-paper.txt")?.id,
        );
      })
      .toBe(true);
    const adopted = (await current())!,
      imported = adopted.importedMaterials!.find(
        (material) => material.name === "DA2025-new-paper.txt",
      )!,
      addedSource = adopted.evidence!.sources.find(
        (source) => source.materialImportId === imported.id,
      )!;
    expect(imported.sha256).toBe(researchHash(original.DA2025!));
    expect(researchHash(await readFile(imported.original))).toBe(imported.sha256);
    expect(adopted.revision).toBe(before.revision);
    // Additive text adoption must preserve the accepted baseline until a human/model declares impact.
    if (!adopted.synthesis?.counterevidence.length)
      expect(
        adopted.fusion!.artifacts.find((artifact) => artifact.id === oldGap.artifactId)!
          .reviewState,
      ).toBe("accepted");
    await writeFile(
      test.info().outputPath("ordinary-ui-new-paper-adoption.json"),
      JSON.stringify(adopted, null, 2),
    );
    const request = pending(adopted).find((entry) => entry.question.includes(CHECKPOINT));
    if (!request)
      throw new Error("The explicit ordinary-UI checkpoint was lost before its actual answer");
    const controls = page.getByTestId("research-task-controls");
    await controls.locator(":scope > summary").click();
    const card = controls.locator(`[data-decision-id="${request.id}"]`);
    await card.locator(":scope > summary").click();
    await card.getByLabel("我的选择", { exact: true }).selectOption(CONTINUE);
    // Neutral navigation only, derived from the actual adopted text after its
    // SHA check. The full source remains available; this creates no model read.
    const adoptedText = await readPinnedResearchFile(addedSource),
      caseHeading = adoptedText.indexOf("Case # 3. Class absences");
    expect(caseHeading).toBeGreaterThan(0);
    const caseOffset = Math.max(0, caseHeading - 200);
    await writeFile(
      test.info().outputPath("operator-neutral-source-navigation.json"),
      JSON.stringify({
        sourceId: addedSource.id,
        sourceSha256: addedSource.sha256,
        heading: "Case # 3. Class absences",
        start: caseOffset,
        boundary:
          "Heading location only, not a supplied result, read receipt or semantic judgment; each model must source-read the actual adopted source itself.",
      }),
    );
    await card
      .getByLabel("补充说明（选填）")
      .fill(
        `${NOTICE} 新公开论文已通过普通UI采用，sourceId=${addedSource.id}。中性导航：采用文本的“Case # 3. Class absences”标题附近可从source-read offset=${caseOffset}开始；这里只提供标题位置，不提供结果或支持判断，全部原文继续可读，也不构成任何成员的实际读取。现在本人读取相关原文并独立检查旧候选缺口；本答复只解除本次顺序检查点，不预先同意任何研究结论，不改变研究对象、不授权采集或因果声称。`,
      );
    interventions.push({
      at: new Date().toISOString(),
      action:
        "Answered the actual local material checkpoint through ordinary decision UI after adoption; no pre-answer or automatic approval inference",
    });
    await card.getByRole("button", { name: "提交我的决定", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = await observe("counterevidence-response-review", true);
          if (!p) return false;
          const unexpected = pending(p).filter((entry) => !entry.question.includes(CHECKPOINT));
          if (unexpected.length)
            throw new Error(
              `Additional real user decision is needed: ${unexpected.map((entry) => entry.question).join("; ")}`,
            );
          const challenge = p.synthesis?.counterevidence.find(
            (entry) => entry.source.sourceId === addedSource.id && entry.gapIds.includes(oldGap.id),
          );
          const response = p.synthesis?.responses
            .filter((entry) => entry.counterevidenceId === challenge?.id)
            .at(-1);
          const review = p.synthesis?.reviews
            .filter((entry) => entry.responseId === response?.id)
            .at(-1);
          const resolution = p.synthesis?.resolutions
            .filter((entry) => entry.reviewId === review?.id)
            .at(-1);
          const closed = review?.conclusion === "addressed" && resolution?.decision === "close";
          const accepted =
            closed &&
            p.fusion!.artifacts.some(
              (entry) => entry.id === response?.artifactId && entry.reviewState === "accepted",
            ) &&
            p.artifacts.some(
              (entry) =>
                entry.role === "mentor" &&
                entry.stage === "synthesis" &&
                entry.kind === "stage-review" &&
                entry.verdict === "accept" &&
                entry.refs.includes(response!.artifactId) &&
                Date.parse(entry.createdAt) >= Date.parse(resolution!.host.at),
            );
          if (["needs-decision", "completed"].includes(p.status) && !accepted)
            throw new Error(
              "Native work ended before the required local counterevidence chain closed",
            );
          const boundary = captureResearchNativeBoundary(lastState!, p);
          for (const [role, stillRequired] of [
            ["lead", !response],
            ["reviewer", !review],
            ["mentor", !accepted],
          ] as const) {
            if (
              !stillRequired ||
              boundary.activeNativeAtCapture.some((entry) => entry.role === role)
            )
              continue;
            const taskIds = new Set(
              p.fusion!.tasks.filter((task) => task.role === role).map((task) => task.id),
            );
            const known = p
              .fusion!.attempts.filter(
                (attempt) => taskIds.has(attempt.taskId) && attempt.usedTokens !== undefined,
              )
              .reduce((sum, attempt) => sum + attempt.usedTokens!, 0);
            if (known >= budget)
              throw new Error(
                `${role} already settled ${known} tokens against unchanged ${budget}; the required new review cannot be dispatched. Retain this failure without extending the deadline or budget.`,
              );
          }
          return (
            accepted &&
            boundary.activeNativeAtCapture.length === 0 &&
            boundary.unknownUsageAttempts.length === 0
          );
        },
        { timeout: Math.max(1, deadline - Date.now()), intervals: [1000, 2500] },
      )
      .toBe(true);
    finalProject = (await current())!;
    const final = finalProject;
    assertMaterialsRouteHistory(final);
    expect(["synthesis", "design"]).toContain(final.currentStage);
    validateResearchSynthesisProject(final);
    expect(
      final.fusion!.attempts.every(
        (attempt) => attempt.state === "succeeded" && !!attempt.finishedAt && !!attempt.nativeRunId,
      ),
    ).toBe(true);
    expect(final.revision).toBe(before.revision);
    expect(final.evidence!.datasets).toEqual([]);
    expect(final.synthesis!.gaps.find((gap) => gap.id === oldGap.id)).toEqual(oldGap);
    const challenge = final.synthesis!.counterevidence.find(
      (entry) => entry.source.sourceId === addedSource.id && entry.gapIds.includes(oldGap.id),
    );
    expect(
      challenge,
      "A paper reference alone cannot establish the counterevidence chain",
    ).toBeDefined();
    expect(challenge!.host.owner.role).toBe("reviewer");
    expect(challenge!.materialChange).toBe(true);
    expect(challenge!.source.exactText).toContain("not significant");
    const response = final
      .synthesis!.responses.filter((entry) => entry.counterevidenceId === challenge!.id)
      .at(-1)!;
    expect(response).toBeDefined();
    expect(response.draft.artifactId).not.toBe(oldGap.artifactId);
    expect(response.draft.taskId).toBe(oldGap.draft.taskId);
    expect(response.draft.taskVersion).toBeGreaterThan(oldGap.draft.taskVersion);
    const replacement = response.gapReplacements.find((pair) => pair.beforeId === oldGap.id)!;
    const newGap = final.synthesis!.gaps.find((gap) => gap.id === replacement.afterId)!;
    expect(gapDescends(final.synthesis!.gaps, newGap.id, oldGap.id)).toBe(true);
    expect(newGap.state).toBe("weakened-or-rejected");
    expect(newGap.statement).not.toBe(oldGap.statement);
    const review = final
      .synthesis!.reviews.filter((entry) => entry.responseId === response.id)
      .at(-1)!;
    const resolution = final
      .synthesis!.resolutions.filter((entry) => entry.reviewId === review.id)
      .at(-1)!;
    expect(review).toMatchObject({
      conclusion: "addressed",
      host: { owner: { role: "reviewer", stage: "synthesis" } },
    });
    expect(resolution).toMatchObject({
      decision: "close",
      host: { owner: { role: "mentor", stage: "synthesis" } },
    });
    for (const id of challenge!.impact.reusableTaskIds) {
      const old = before.fusion!.tasks.find((task) => task.id === id),
        current = final.fusion!.tasks.find((task) => task.id === id);
      if (old?.state === "completed")
        expect({ version: current?.inputVersion, artifactId: current?.currentArtifactId }).toEqual({
          version: old.inputVersion,
          artifactId: old.currentArtifactId,
        });
    }
    expect(
      final.fusion!.artifacts.find((entry) => entry.id === response.artifactId)!.reviewState,
    ).toBe("accepted");
    expect(
      final.artifacts.some(
        (entry) =>
          entry.role === "mentor" &&
          entry.stage === "synthesis" &&
          entry.kind === "stage-review" &&
          entry.verdict === "accept" &&
          entry.refs.includes(response.artifactId) &&
          Date.parse(entry.createdAt) >= Date.parse(resolution.host.at),
      ),
    ).toBe(true);
    await assertResearchSynthesisAcceptance(final, response.artifactId);
    const native = await researchNativeCallLedger(profile, final);
    expect(
      native.flatMap((member) => member.calls).filter((call) => call.name !== "research_group"),
    ).toEqual([]);
    for (const operation of [
      "synthesis-matrix",
      "synthesis-gap",
      "synthesis-counterevidence",
      "synthesis-respond",
      "synthesis-review",
      "synthesis-resolve",
    ])
      expect(
        native.some((member) =>
          member.calls.some((call) => call.operation === operation && !call.isError),
        ),
      ).toBe(true);
    for (const [id, bytes] of Object.entries(original))
      expect(researchHash(await readFile(join(originalDirectory, `${id}.txt`)))).toBe(
        researchHash(bytes),
      );
    expect(rendererErrors).toEqual([]);
    await writeFile(
      test.info().outputPath("counterevidence-native-tools.json"),
      JSON.stringify(native, null, 2),
    );
    await writeFile(
      test.info().outputPath("after-counterevidence-project.json"),
      JSON.stringify(final, null, 2),
    );
    const synthesisPanel = page.getByTestId("research-synthesis-panel");
    await synthesisPanel.locator(":scope > summary").click();
    const counterCard = synthesisPanel
      .locator(":scope > details")
      .filter({
        has: page.locator("summary", { hasText: "新增反证" }),
      })
      .last();
    await counterCard.locator(":scope > summary").click();
    await expect(counterCard.getByText(response.reason, { exact: false })).toBeVisible();
    await expect(counterCard.getByText("B 的具名复核", { exact: true })).toBeVisible();
    await expect(counterCard.getByText("导师 Agent 处理", { exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("counterevidence-closed-local-review.png"),
    });
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    const p = finalProject ?? lastState?.researchGroups?.projects[0];
    await writeFile(
      test.info().outputPath("run-outcome.json"),
      JSON.stringify(
        {
          ...plan,
          endedAt: new Date().toISOString(),
          outcome: failure ? "failed" : "local-review-complete-awaiting-independent-C",
          failure,
          interventions,
          rendererErrors,
          baselineProjectId: baseline?.id,
          actualInitialProject: initialProject,
          current: p,
          nativeBoundary: p && lastState ? captureResearchNativeBoundary(lastState, p) : undefined,
          nativeTools: p
            ? await researchNativeCallLedger(profile, p).catch((error) => ({
                error: String(error),
              }))
            : undefined,
        },
        null,
        2,
      ),
    );
    await harness.close();
  }
});
