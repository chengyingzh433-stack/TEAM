import { expect, test } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchArtifact,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { openResearchEvidence, researchHash } from "../../electron/research-group/materials";
import { isCurrentResearchArtifact } from "../../electron/research-group/paper-pipeline";
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
// Reuse only the existing read-only session parser; no numeric/CSV helper is called in this spec.
import {
  evidenceObject as object,
  registeredAnalysisNativeEvidence as readNativeEvidence,
} from "../helpers/research-registered-analysis-evidence";

const INPUT_ID = "INFLIGHT-INPUT";
const BAD_SENTENCE = "studytime四档分别表示1、2、3、4小时。";
const NOTICE =
  "automated-test-operator：AC26有意待核输入的软件在途协作验收。测试操作者提供的陈述尚待原文核查，不是研究发现；A保存原样输入不构成科学独立初判，AC27由另一证据验证。时序与模型内容仅是本次受控R证据，不代表自然研究效果、性能收益、人类确认或伦理审批。";
const DRAFT = `# 测试操作者提供的待核查稿

本稿是操作者为软件引用核查流程准备的输入，包含一条有待核对的编码陈述；尚未经本轮原文验证，不是研究发现，也不是A的独立科学判断。

待核查编码陈述：${BAD_SENTENCE} [SRC:UCI]

此处的引用是输入中保留的候选引用，不能据此声称已经读过UCI或该断言得到支持。本轮须核对原始字典并保留实际依据、修改和复核记录；不读取数据CSV、不计算、不写整篇论文。`;
const SCOPE =
  "仅核对操作者待核查稿的一条studytime编码陈述，并形成UCI、DA2025、SMS2025三份实际提供文本的简短来源/编码/对象/证据类型/局限台账；止于audit引用核查任务，不分析CSV、不扩展为整篇论文。";
const PROMPT = `${NOTICE}\n${SCOPE}
角色成果类型严格使用：A仅stage-draft/stage-revision，B仅stage-risk/stage-critique/stage-verification，导师仅stage-review。本限定任务没有资料员派发，A/B不得publish stage-material；额外阅读笔记写入各自稿件、复核或用message交接。
共同输入是${INPUT_ID}待核查稿、UCI官方说明、DA2025和SMS2025三份真实已提供文本及固定课程库。待核输入不是支持证据；有充分原文依据才批评。不要预设任何正确编码，须本人实际读取UCI条目后判断；若不能证实有误则如实说明，不为验收编造问题。
A先取得本任务必要少量method-package，再实际source-read ${INPUT_ID}。尽早publish唯一stage-draft，content必须逐字保全${INPUT_ID}正文，不加前后语、不预改错误；refs=[]、sourceIds只列已实际读过的${INPUT_ID}，不能假称已读其他来源。这个动作是保存原输入，不是A独立研究初判。必要图片/方法应用可以在后续正式接受前完成，不必在保存输入前扩大工作。
保存原输入后，A在同一次原生工作中继续完成本轮明确要求的有用阅读任务，而不是结束回复等B：先实际读完UCI，再读完DA2025，最后读完SMS2025。每份从offset=0开始，按实际返回的nextOffset逐页继续，读完一份再转下一份；不要猜未返回页、跳过正文、把某页当整篇，或用标题/摘要代替所提供的后续正文。每份形成可定位的简短工作台账，记录来源身份、研究对象/情境、它提供的是变量字典/方法推断/预测还是其他证据、是否明确给出studytime编码、与本条核查的关系和不能确认的部分。没有定义就写未见，不补造；网页提取文字不表示实际看过缺失的表图或PDF。该台账用于防止混淆官方定义、二手转述和预测/因果主张，必须纳入最后的新稿，不是为制造时序而凑阅读配额。
B优先本人实际source-read UCI及${INPUT_ID}，取得本任务必要固定课程包，然后独立publish stage-risk，先不read A观点或私有方法解释。随后立即实际read A原样stage-draft，核对这条陈述。如果确有编码错误，先立刻publish一份具体stage-critique，refs含真实draft.id，sourceIds含本人已读的UCI及原输入；定位原稿错误句，直接摘录UCI中以“14 studytime”开头的完整字典行，标明sourceId、实际source-read返回区间与该字典条目锚点，说明编码与小时的区别、影响和需要怎样纠正。不能猜字符位置。正式方法图片、method-opinion等工作可放在这项实际关键批评交接之后完成，不为准备整套正式接受而拖延已能判定的关键问题。没有充分依据则不要发布虚假批评；本次时序或问题条件不成立会如实验收失败。
A在材料阅读过程中若收到系统的真实B critique交接，应在当前原生工作结束前立即实际read该critique，按已经读到的原文回应其对编码和后续台账的影响，随后继续完成剩余的真实阅读/方法工作，不结束原run把读取留到另一轮。不要为等通知而循环status、sleep、延迟、查询空状态或制造消息。系统负责原生steer交接；若在任务自然结束前没有收到关键问题，如实结束，不假造在途收到。
A实际读到B critique且完成三源阅读后，只publish一份完整stage-revision，refs含真实critique.id及本人已read的相关成果；sourceIds引用原输入和三份已读原文。新稿明确逐条回应：原输入的待核断言、据UCI实际字典如何纠正、纠正理由与推断边界，以及上述三源可定位台账。引用与本次source-read一致的完整“14 studytime”字典原句供复核；不要只保留错误句或把未核查原输入当研究发现。不把有实质编码纠正的过程说成纯语言润色，不新增语言改写链；可在新稿后language-not-applicable说明这是实质核查和修改。
当前方法门禁照实完成：A对实际采用的每个包本人method-read-image及method-image-reading，用真实receiptId记录必要图像观察与局限；method-apply说明如何用于本轮编码核查与三源边界，不只列ID，scoringClaim=not-scored。尽量在发布新稿前完成本稿应用，避免交接时缺依据。B在关键critique发布后取得A所用同版method-package，亲读必要图像并记录观察，method-check/applicationId与method-opinion给具体依据；不把程序检查当内容认证。B收到新稿后必须实际read该版本，重新核对UCI字典及台账所用范围，以stage-verification refs指向新稿；确实合格才accept，材料不足保持真实意见，不强填support。导师也实际读取新稿、B复核和必要原文，取得同包、本人必要图像，method-adjudicate引用真实B意见并method-check后，以stage-review仅对这份编码核查/材料边界稿有限裁定，refs含新稿及B复核；不声称所有论文发现/图表已核验。
此限定任务用实际source-read、具体stage-critique、实质stage-revision及同稿复核保留依据，不另起claim登记配额、分析或纯语言改写。只用research_group；不bash、不联网、不source-search/source-fetch/literature-search/literature-fetch、不analyze/register-analysis/run-analysis，不读CSV、旧R/C、旧稿或认证文件，不创建成员/自定义模型循环。没有待用户决定的新条件不重复请求人的确认；真有条件或工具错误则如实保留并停止，不能自行答复或吞错。完成必要任务后所有成员自然结束，不保持空转，不为时序延长执行。`;
const FORBIDDEN = new Set([
  "source-search",
  "source-fetch",
  "literature-search",
  "literature-fetch",
  "analyze",
  "register-analysis",
  "run-analysis",
  "request-decision",
  "claim-register",
  "claim-review",
  "language-register",
]);

function draftProducer(project: ResearchProject, draft: ResearchArtifact) {
  const record = project.fusion?.artifacts.find((artifact) => artifact.id === draft.id);
  return project.fusion?.attempts.find((attempt) => attempt.id === record?.attemptId);
}

test.describe.configure({ retries: 0 });
test("real critical dictionary critique reaches A's original running producer and changes the reviewed citation report", async () => {
  test.setTimeout(2_400_000);
  const deadline = Date.now() + 2_100_000,
    auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit real-provider authentication required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must select the actual read-only course library");
  if (process.env.RESEARCH_MEMBER_TOKEN_BUDGET !== undefined)
    expect(Number(process.env.RESEARCH_MEMBER_TOKEN_BUDGET)).toBe(8_000_000);
  const knowledge = await ResearchKnowledge.open(knowledgeDir),
    sourceDirectory =
      process.env.RESEARCH_INFLIGHT_SOURCE_DIR ??
      resolve(__dirname, "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料");
  const manifestFile = join(sourceDirectory, "manifest.json"),
    manifestBytes = await readFile(manifestFile),
    manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  // Only real provided source descriptors/texts. The manifest's CSV is never opened or copied.
  const originals = (Array.isArray(manifest.sources) ? manifest.sources.map(object) : []).filter(
    (source) => ["UCI", "DA2025", "SMS2025"].includes(String(source.id)),
  );
  expect(originals.map((source) => source.id).sort()).toEqual(["DA2025", "SMS2025", "UCI"]);
  const profile = await makeUserDataDir("research-inflight-critique-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-inflight-critique-live"),
    materials = join(workspace, "provided-citation-materials");
  await mkdir(materials);
  const hashes: {
    id: string;
    file: string;
    sha256: string;
    bytes: number;
    utf16Length: number;
    expectedPagesAtCurrentHostLimit: number;
  }[] = [];
  let dictionaryLine = "",
    dictionaryStart = -1;
  for (const source of originals) {
    expect(source.file).toBe(`${String(source.id)}.txt`);
    const file = join(sourceDirectory, String(source.file)),
      bytes = await readFile(file),
      body = bytes.toString("utf8");
    hashes.push({
      id: String(source.id),
      file,
      sha256: researchHash(bytes),
      bytes: bytes.length,
      utf16Length: body.length,
      expectedPagesAtCurrentHostLimit: Math.ceil(body.length / 10_000),
    });
    await writeFile(join(materials, String(source.file)), bytes, { flag: "wx" });
    if (source.id === "UCI") {
      dictionaryLine = body.split(/\r?\n/).find((line) => line.startsWith("14 studytime - ")) ?? "";
      dictionaryStart = body.indexOf(dictionaryLine);
      expect(dictionaryLine).toMatch(/weekly study time/);
      expect(dictionaryStart).toBeGreaterThanOrEqual(0);
    }
  }
  await writeFile(join(materials, `${INPUT_ID}.txt`), DRAFT, { flag: "wx" });
  const providedManifest = {
    version: 1,
    sources: [
      ...originals.map((source) => ({ ...source, textScope: "full-text" })),
      {
        id: INPUT_ID,
        title: "操作者待核查稿（非研究发现、非A科学初判）",
        authors: "automated-test-operator",
        year: "2026",
        url: "local:operator-supplied-inflight-citation-input",
        file: `${INPUT_ID}.txt`,
        kind: "manuscript",
        textScope: "full-text",
      },
    ],
    datasets: [],
  };
  await writeFile(join(materials, "manifest.json"), JSON.stringify(providedManifest, null, 2), {
    flag: "wx",
  });
  const evidence = await openResearchEvidence(materials);
  expect(evidence.datasets).toEqual([]);
  const plan = {
    beganAt: new Date().toISOString(),
    notice: NOTICE,
    scope: SCOPE,
    profile,
    workspace,
    materials,
    sourceDirectory,
    originalManifestSha256: researchHash(manifestBytes),
    originalSources: hashes,
    providedManifest,
    operatorInput: {
      id: INPUT_ID,
      sha256: researchHash(DRAFT),
      deliberatelyPendingClaim: BAD_SENTENCE,
      identity:
        "Test operator's intentionally questionable input, preserved verbatim by A; no claim of A scientific independent initial judgment",
    },
    dictionaryOracle: {
      sourceId: "UCI",
      start: dictionaryStart,
      end: dictionaryStart + dictionaryLine.length,
      exactText: dictionaryLine,
      boundary:
        "Offline evaluation only; correct definition is not included in provider instruction",
    },
    knowledgePin: knowledge.pin,
    memberTokenBudget: 8_000_000,
    executionDeadlineMs: 2_100_000,
    retries: 0,
    route: "task/citations/audit, no librarian dispatch or CSV",
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
    },
    workRationale:
      "Complete three supplied texts and a useful source/encoding/object/evidence/limitations ledger; no sleeps, time gates, fixture model responses or empty polling to manufacture overlap",
    timingClaim:
      "Must be observed: B reads draft with producerRunning=true; actual B critique and A read of it precede the original A producer's native finish. No timing guarantee from task size.",
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(test.info().outputPath("initial-instruction.txt"), PROMPT);
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  let harness: DesktopHarness | undefined,
    lastState: DesktopAppState | undefined,
    failure: string | undefined,
    nativeEndedAt: string | undefined;
  const rendererErrors: string[] = [],
    snapshots: Record<string, ResearchProject> = {};
  let timingProof: Record<string, unknown> | null = null;
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
    await editor.getByLabel("研究入口", { exact: true }).selectOption("task");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("task");
    await editor.getByLabel("单项任务类型", { exact: true }).selectOption("citations");
    await editor.getByLabel("单项任务范围", { exact: true }).fill(SCOPE);
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
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          if (rendererErrors.length || lastState.researchGroups?.error)
            throw new Error(rendererErrors.join("; ") || lastState.researchGroups!.error);
          const p = lastState.researchGroups?.projects[0];
          if (!p) return false;
          if (
            p.error ||
            ["paused", "needs-decision"].includes(p.status) ||
            p.fusion?.attempts.some((attempt) =>
              ["failed", "unknown", "cancelled"].includes(attempt.state),
            ) ||
            p.fusion?.tasks.some((task) => task.state === "waiting-user") ||
            p.fusion?.decisionRequests?.length
          )
            throw new Error(
              JSON.stringify({
                status: p.status,
                error: p.error,
                attempts: p.fusion?.attempts,
                requests: p.fusion?.decisionRequests,
              }),
            );
          const native = await readNativeEvidence(profile, p),
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
            throw new Error(`Actual tool error or out-of-scope call: ${JSON.stringify(invalid)}`);
          const draft = p.artifacts.find((artifact) => artifact.kind === "stage-draft"),
            critique = p.artifacts.find((artifact) => artifact.kind === "stage-critique");
          if (draft) {
            snapshots.firstDraft ??= structuredClone(p);
            const producer = draftProducer(p, draft)!;
            const bRead = p.events.find(
              (event) =>
                event.type === "read" && event.role === "reviewer" && event.artifactId === draft.id,
            );
            if (bRead && (!bRead.producerRunning || bRead.producerRunId !== producer.nativeRunId))
              throw new Error(
                "B's draft read did not observe the original A producer running; AC26 timing not established",
              );
            if (critique) snapshots.critiqueObserved ??= structuredClone(p);
            if (producer.finishedAt) {
              const aRead =
                critique &&
                p.events.find(
                  (event) =>
                    event.type === "read" &&
                    event.role === "lead" &&
                    event.artifactId === critique.id &&
                    event.runId === producer.nativeRunId,
                );
              if (
                !critique ||
                Date.parse(critique.createdAt) >= Date.parse(producer.finishedAt) ||
                !aRead ||
                Date.parse(aRead.at) >= Date.parse(producer.finishedAt)
              )
                throw new Error(
                  "The original A run ended before a concrete B critique was published and actually read by A; retain this failed timing attempt, do not extend the timeout",
                );
            }
          }
          if (p.artifacts.filter((artifact) => artifact.kind === "stage-revision").length > 1)
            throw new Error(
              "This bounded exercise allows only the one substantive correction report",
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
    const p = (snapshots.nativeEnded = lastState!.researchGroups!.projects[0]!),
      native = await readNativeEvidence(profile, p, true),
      current = p.artifacts.filter((artifact) => isCurrentResearchArtifact(p, artifact));
    expect(researchExecutionRoute(p).stageIds).toEqual(["audit"]);
    expect(researchExecutionRoute(p).requiredRoles).toEqual(["lead", "reviewer", "mentor"]);
    expect(p.memberTokenBudget).toBe(8_000_000);
    expect(p.evidence!.datasets).toEqual([]);
    expect(p.analyses ?? []).toEqual([]);
    expect(p.analysisRegistry?.runs ?? []).toEqual([]);
    expect(p.fusion!.attempts.every((attempt) => attempt.state === "succeeded")).toBe(true);
    expect(p.events.some((event) => event.role === "librarian" && event.type === "started")).toBe(
      false,
    );
    expect(p.artifacts.every((artifact) => artifact.stage === "audit")).toBe(true);
    for (const kind of [
      "stage-draft",
      "stage-risk",
      "stage-critique",
      "stage-revision",
      "stage-verification",
      "stage-review",
    ] as const)
      expect(current.filter((artifact) => artifact.kind === kind)).toHaveLength(1);
    const draft = current.find((artifact) => artifact.kind === "stage-draft")!,
      risk = current.find((artifact) => artifact.kind === "stage-risk")!,
      critique = current.find((artifact) => artifact.kind === "stage-critique")!,
      revision = current.find((artifact) => artifact.kind === "stage-revision")!,
      verification = current.find((artifact) => artifact.kind === "stage-verification")!,
      review = current.find((artifact) => artifact.kind === "stage-review")!;
    expect(draft.content).toBe(DRAFT);
    expect(draft.refs).toEqual([]);
    expect(draft.sourceIds).toEqual([INPUT_ID]);
    expect(critique.refs).toContain(draft.id);
    expect(critique.sourceIds).toContain("UCI");
    expect(critique.content).toContain("studytime");
    expect(critique.content).toMatch(/编码|类别|档|小时|categor|hour/i);
    expect(critique.content).toContain(dictionaryLine);
    expect(critique.content).toContain("UCI");
    expect(revision.refs).toContain(critique.id);
    expect(revision.content).not.toBe(DRAFT);
    expect(revision.content).toContain(dictionaryLine);
    expect(revision.sourceIds).toEqual(
      expect.arrayContaining([INPUT_ID, "UCI", "DA2025", "SMS2025"]),
    );
    for (const id of ["UCI", "DA2025", "SMS2025"]) expect(revision.content).toContain(id);
    expect(verification.verdict).toBe("accept");
    expect(verification.refs).toContain(revision.id);
    expect(review.verdict).toBe("accept");
    expect(review.refs).toEqual(expect.arrayContaining([revision.id, verification.id]));
    const producer = draftProducer(p, draft)!,
      aNative = native.find((member) => member.role === "lead")!,
      bNative = native.find((member) => member.role === "reviewer")!,
      critiqueCall = bNative.calls.find((call) => call.id === critique.toolCallId)!,
      draftCall = aNative.calls.find((call) => call.id === draft.toolCallId)!;
    expect(producer.state).toBe("succeeded");
    expect(producer.nativeRunId).toBeTruthy();
    expect(producer.finishedAt).toBeTruthy();
    const finished = p.events.find(
      (event) => event.type === "finished" && event.runId === producer.nativeRunId,
    )!;
    expect(finished).toBeTruthy();
    expect(finished.runtimeAt).toBe(producer.finishedAt);
    const bRead = p.events.find(
        (event) =>
          event.type === "read" && event.role === "reviewer" && event.artifactId === draft.id,
      )!,
      aRead = p.events.find(
        (event) =>
          event.type === "read" &&
          event.role === "lead" &&
          event.artifactId === critique.id &&
          event.runId === producer.nativeRunId,
      )!;
    expect(bRead).toMatchObject({ producerRunning: true, producerRunId: producer.nativeRunId });
    expect(Date.parse(bRead.at)).toBeLessThan(Date.parse(producer.finishedAt!));
    expect(critiqueCall).toMatchObject({
      name: "research_group",
      args: { operation: "publish", kind: "stage-critique", content: critique.content },
      isError: false,
    });
    expect(Date.parse(critiqueCall.at)).toBeLessThan(Date.parse(producer.finishedAt!));
    expect(Date.parse(critiqueCall.resultAt!)).toBeLessThan(Date.parse(producer.finishedAt!));
    expect(Date.parse(critique.createdAt)).toBeLessThan(Date.parse(producer.finishedAt!));
    expect(aRead).toBeTruthy();
    expect(Date.parse(aRead.at)).toBeGreaterThanOrEqual(Date.parse(critique.createdAt));
    expect(Date.parse(aRead.at)).toBeLessThan(Date.parse(producer.finishedAt!));
    expect(Date.parse(revision.createdAt)).toBeGreaterThanOrEqual(Date.parse(aRead.at));
    const aCritiqueReadCall = aNative.calls.find(
      (call) =>
        call.args.operation === "read" &&
        call.args.artifactId === critique.id &&
        call.attemptId === producer.id,
    )!;
    expect(aCritiqueReadCall).toBeTruthy();
    expect(aCritiqueReadCall.isError).toBe(false);
    expect(Date.parse(aCritiqueReadCall.resultAt!)).toBeLessThan(Date.parse(producer.finishedAt!));
    const bMember = p.members.find((member) => member.role === "reviewer")!,
      uci = hashes.find((source) => source.id === "UCI")!;
    const dictionaryRead = p.sourceReads!.find(
      (read) =>
        read.sessionId === bMember.ref.sessionId &&
        read.sourceId === "UCI" &&
        read.sourceSha256 === uci.sha256 &&
        read.start <= dictionaryStart &&
        read.end >= dictionaryStart + dictionaryLine.length &&
        read.at <= critique.createdAt,
    )!;
    expect(dictionaryRead).toBeTruthy();
    expect(Date.parse(dictionaryRead.at)).toBeLessThanOrEqual(Date.parse(risk.createdAt));
    expect(
      p.sourceReads!.some(
        (read) =>
          read.sessionId === bMember.ref.sessionId &&
          read.sourceId === INPUT_ID &&
          read.sourceSha256 === researchHash(DRAFT) &&
          read.start === 0 &&
          read.end === DRAFT.length &&
          read.at <= risk.createdAt,
      ),
    ).toBe(true);
    expect(
      bNative.calls.some(
        (call) =>
          dictionaryRead.evidenceRef === `tool:${call.id}` &&
          call.args.operation === "source-read" &&
          call.args.sourceId === "UCI" &&
          call.resultAt &&
          !call.isError,
      ),
    ).toBe(true);
    expect(Date.parse(risk.createdAt)).toBeLessThanOrEqual(Date.parse(bRead.at));
    expect(
      p.events.some(
        (event) =>
          event.type === "read" &&
          event.role === "reviewer" &&
          event.artifactId === draft.id &&
          event.at < risk.createdAt,
      ),
    ).toBe(false);
    const mentor = p.members.find((member) => member.role === "mentor")!;
    expect(
      p.sourceReads!.some(
        (read) =>
          read.sessionId === mentor.ref.sessionId &&
          read.sourceId === "UCI" &&
          read.sourceSha256 === uci.sha256 &&
          read.start <= dictionaryStart &&
          read.end >= dictionaryStart + dictionaryLine.length &&
          read.at <= review.createdAt,
      ),
    ).toBe(true);
    // All substantive A source work is actual and belongs to the original producer, after preservation.
    const sourceCoverage = hashes.map((source) => {
      const reads = p
        .sourceReads!.filter(
          (read) =>
            read.sourceId === source.id &&
            aNative.calls.some(
              (call, callIndex) =>
                call.attemptId === producer.id &&
                callIndex > aNative.calls.indexOf(draftCall) &&
                read.evidenceRef === `tool:${call.id}` &&
                call.args.operation === "source-read" &&
                !call.isError,
            ),
        )
        .sort((a, b) => a.start - b.start);
      let covered = 0;
      for (const read of reads) {
        expect(read.sourceSha256).toBe(source.sha256);
        expect(read.start).toBeLessThanOrEqual(covered);
        expect(read.at >= draft.createdAt).toBe(true);
        expect(read.at <= revision.createdAt).toBe(true);
        covered = Math.max(covered, read.end);
      }
      expect(covered).toBe(source.utf16Length);
      return {
        sourceId: source.id,
        actualReadCount: reads.length,
        expectedMinimumAtCurrentHostLimit: source.expectedPagesAtCurrentHostLimit,
        coveredUtf16: covered,
        reads,
      };
    });
    expect(
      aNative.calls
        .filter(
          (call, callIndex) =>
            callIndex < aNative.calls.indexOf(draftCall) && call.args.operation === "source-read",
        )
        .map((call) => call.args.sourceId),
    ).toEqual([INPUT_ID]);
    for (const [role, artifact, before] of [
      ["reviewer", revision, verification.createdAt],
      ["mentor", revision, review.createdAt],
      ["mentor", verification, review.createdAt],
    ] as const)
      expect(
        p.events.some(
          (event) =>
            event.type === "read" &&
            event.role === role &&
            event.artifactId === artifact.id &&
            event.at >= artifact.createdAt &&
            event.at <= before,
        ),
      ).toBe(true);
    for (const artifact of p.artifacts) {
      expect(artifact.model).toEqual(
        p.stages!.find((stage) => stage.id === "audit")!.models[artifact.role],
      );
      expect(
        native
          .find((member) => member.role === artifact.role)!
          .calls.some(
            (call) =>
              call.id === artifact.toolCallId &&
              call.args.operation === "publish" &&
              call.args.content === artifact.content &&
              call.resultAt &&
              !call.isError,
          ),
      ).toBe(true);
    }
    for (const role of ["reviewer", "mentor"] as const)
      expect(
        p.methodProgramChecks!.some(
          (check) =>
            check.role === role &&
            check.result === "passed-at-snapshot" &&
            check.target?.artifactId === revision.id &&
            check.target.bodySha256 === researchHash(revision.content) &&
            check.issues.length === 0,
        ),
      ).toBe(true);
    const ledger = await researchNativeCallLedger(profile, p);
    expect(
      ledger
        .flatMap((member) => member.calls)
        .filter(
          (call) =>
            call.name !== "research_group" ||
            FORBIDDEN.has(String(call.operation)) ||
            call.isError ||
            !call.resultAt,
        ),
    ).toEqual([]);
    timingProof = {
      originalDraft: {
        id: draft.id,
        role: draft.role,
        toolCallId: draft.toolCallId,
        interpretation: "Operator input preservation only, not A scientific independent judgment",
      },
      producer,
      producerFinishedEvent: finished,
      bReadDraft: bRead,
      bCritique: {
        artifact: critique,
        nativeCall: critiqueCall,
        actualDictionaryRead: dictionaryRead,
      },
      aReadCritique: { event: aRead, nativeCall: aCritiqueReadCall },
      finalRevision: {
        id: revision.id,
        refs: revision.refs,
        sha256: researchHash(revision.content),
      },
      verification,
      review,
      sourceCoverage,
      observedLeadMs: {
        bCritiqueBeforeProducerEnd:
          Date.parse(producer.finishedAt!) - Date.parse(critique.createdAt),
        aReadBeforeProducerEnd: Date.parse(producer.finishedAt!) - Date.parse(aRead.at),
      },
      scope:
        "One controlled live overlap, not natural-research quality/performance benefit; ledger semantic adequacy and corrected content await C",
    };
    await writeFile(
      test.info().outputPath("inflight-timing-proof.json"),
      JSON.stringify(timingProof, null, 2),
    );
    await page.screenshot({ path: test.info().outputPath("inflight-critique-native-ended.png") });
    expect(rendererErrors).toEqual([]);
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
            evidenceFailures.push(`Final state: ${String(error)}`);
            return lastState;
          });
      const project = lastState?.researchGroups?.projects[0];
      await writeFile(
        test.info().outputPath("research-project.json"),
        JSON.stringify(project ?? null, null, 2),
      );
      const checks: [string, string, string][] = [
        ["originalManifest", manifestFile, researchHash(manifestBytes)],
        [
          "providedManifest",
          join(materials, "manifest.json"),
          researchHash(JSON.stringify(providedManifest, null, 2)),
        ],
        ["operatorInput", join(materials, `${INPUT_ID}.txt`), researchHash(DRAFT)],
        ["knowledgeIndex", join(knowledgeDir, "索引", "知识块.jsonl"), knowledge.pin.sha256],
      ];
      for (const source of hashes) {
        checks.push([`original:${source.id}`, source.file, source.sha256]);
        checks.push([`copy:${source.id}`, join(materials, `${source.id}.txt`), source.sha256]);
      }
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
        evidenceFailures.push("Original, supplied copy or course index changed");
      const native = project
        ? await readNativeEvidence(profile, project, !!nativeEndedAt).catch((error: unknown) => {
            evidenceFailures.push(`Native evidence: ${String(error)}`);
            return null;
          })
        : null;
      const boundary =
        project && lastState ? captureResearchNativeBoundary(lastState, project) : null;
      if (project)
        for (const artifact of project.artifacts)
          await writeFile(test.info().outputPath(`artifact-${artifact.id}.md`), artifact.content);
      await writeFile(
        test.info().outputPath("inflight-critique-proof.json"),
        JSON.stringify(
          {
            notice: NOTICE,
            assertionFailure: failure ?? null,
            projectSnapshotFile: "research-project.json",
            snapshots,
            native,
            timingProof,
            events: project?.events ?? [],
            sourceReads: project?.sourceReads ?? [],
            boundary,
            integrity,
            evidenceFailures,
            independentInitialJudgmentCoverage:
              "A is intentionally preserving operator input; no AC27 scientific independent-initial-judgment claim",
            contentReview:
              "R only, awaiting separate independent C for concrete dictionary support, meaningful feedback, source-ledger usefulness and corrected text. No natural research or performance-benefit claim.",
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
            nativeEndedAt: nativeEndedAt ?? null,
            automatedAcceptance:
              nativeEndedAt && timingProof && !failure && !evidenceFailures.length
                ? "AC26-controlled-R-passed-awaiting-C"
                : "failed",
            failure: failure ?? (evidenceFailures.length ? evidenceFailures.join("; ") : null),
            finalStatus: project?.status ?? "not-created",
            projectSnapshot: project ?? null,
            timingProof,
            integrity,
            evidenceFailures,
            rendererErrors,
            ...(boundary ?? {}),
            contentBoundary:
              "Intentionally pending operator statement; no scientific independent-A or natural collaboration effectiveness claim",
            teardownNotice:
              "Any unfinished native requests closed after a failed timing attempt are cleanup, never natural completion. No timeout increase, artificial delay, skip or hidden retry may convert failure to success.",
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
