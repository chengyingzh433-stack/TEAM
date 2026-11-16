import { expect, test } from "@playwright/test";
import { appendFile, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { researchTaskControlDecisionStatus } from "../../contracts/research-task-controls";
import type { DesktopAppState } from "../../contracts/desktop-state";
import { decodeResearchState } from "../../electron/research-group/repository";
import {
  openResearchEvidence,
  readPinnedResearchFile,
  researchHash,
} from "../../electron/research-group/materials";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
} from "../helpers/electron-app";

const ORIGINAL_DESIGN_ID = "e6182007-20d6-42cb-a41b-d6a881687491";
const DESIGN_SOURCE_ID = "PRIOR-DESIGN";
const REVIEW_SCOPE =
  "只复核原方案中G3评分构成的确定程度及直接相关表述，提交局部替换段落、修改前后对照及其余边界逐项核对；未选正文保留，不采集或分析数据，不追加网络检索，不重跑S1–S4或进入S6–S8。";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function captureBoundary(state: DesktopAppState, project: ResearchProject) {
  const requiredRoles = researchExecutionRoute(project).requiredRoles;
  const activeNativeAtCapture = project.members.flatMap((member) => {
    const session = state.workspaces
      .find((item) => item.id === member.ref.workspaceId)
      ?.sessions.find((item) => item.id === member.ref.sessionId);
    const attempts =
      project.fusion?.attempts.filter(
        (attempt) =>
          project.fusion!.tasks.find((task) => task.id === attempt.taskId)?.role === member.role &&
          ["prepared", "running", "unknown"].includes(attempt.state),
      ) ?? [];
    const unfinishedRunIds = project.events
      .filter(
        (event) =>
          event.type === "started" &&
          event.role === member.role &&
          event.runId &&
          !project.events.some((end) => end.type === "finished" && end.runId === event.runId),
      )
      .map((event) => event.runId);
    return !session ||
      session.status === "running" ||
      member.status === "running" ||
      attempts.length ||
      unfinishedRunIds.length
      ? [
          {
            role: member.role,
            sessionStatus: session?.status ?? "unknown",
            memberStatus: member.status,
            attempts,
            unfinishedRunIds,
          },
        ]
      : [];
  });
  const usage = project.members.map((member) => {
    const value = state.sessionUsageBySession[`${member.ref.workspaceId}:${member.ref.sessionId}`];
    return {
      role: member.role,
      requiredForThisTask: requiredRoles.includes(member.role),
      ref: member.ref,
      usage: value ?? null,
      moneySpent: value && !value.subscription ? value.totals.cost : null,
    };
  });
  const unknownUsageAttempts =
    project.fusion?.attempts
      .filter((attempt) => attempt.usedTokens === undefined)
      .map((attempt) => attempt.id) ?? [];
  return {
    activeNativeAtCapture,
    usage,
    usageFinality: activeNativeAtCapture.length
      ? "provisional-native-unsettled"
      : usage.some((item) => item.requiredForThisTask && !item.usage) || unknownUsageAttempts.length
        ? "native-ended-usage-incomplete"
        : "native-ended-provider-reported",
    unknownUsageAttempts,
    usageNotice:
      "Provider usage is not an independently verified bill; absent usage stays unknown, subscription estimates are not money spent.",
  };
}

async function nativeCallLedger(profile: string, project: ResearchProject) {
  const directory = join(profile, "agent", "sessions");
  const paths = await readdir(directory, { recursive: true });
  return Promise.all(
    project.members.map(async (member) => {
      const file = paths.find((path) => path.endsWith(`_${member.ref.sessionId}.jsonl`));
      if (!file && !researchExecutionRoute(project).requiredRoles.includes(member.role))
        return {
          role: member.role,
          file: null,
          audit: "role-not-dispatched-no-session-log",
          calls: [],
          errors: [],
        };
      if (!file)
        throw new Error(
          `Native session log missing for ${member.role}; cannot claim tool coverage.`,
        );
      const calls: {
        id: string;
        name: unknown;
        operation: unknown;
        sourceId: unknown;
        artifactId: unknown;
        kind: unknown;
        at: unknown;
        resultAt?: unknown;
        isError?: boolean;
        errorText?: string;
      }[] = [];
      for (const line of (await readFile(join(directory, file), "utf8")).trim().split("\n")) {
        const entry = object(JSON.parse(line)),
          message = object(entry.message);
        const content = Array.isArray(message.content) ? message.content.map(object) : [];
        for (const part of content)
          if (part.type === "toolCall" && typeof part.id === "string") {
            const args = object(part.arguments);
            calls.push({
              id: part.id,
              name: part.name,
              operation: args.operation,
              sourceId: args.sourceId,
              artifactId: args.artifactId,
              kind: args.kind,
              at: entry.timestamp,
            });
          }
        if (message.role === "toolResult") {
          const call = calls.find((item) => item.id === message.toolCallId);
          if (call)
            Object.assign(call, {
              resultAt: entry.timestamp,
              isError: message.isError === true,
              ...(message.isError === true
                ? {
                    errorText: content
                      .filter((part) => typeof part.text === "string")
                      .map((part) => String(part.text))
                      .join("\n"),
                  }
                : {}),
            });
        }
      }
      return { role: member.role, file, calls, errors: calls.filter((call) => call.isError) };
    }),
  );
}

// A new bounded R task, not a rewrite/resume of the historical project and not independent C.
test("real existing-design task reviews the G3 certainty finding within S5 and ends native requests naturally", async () => {
  test.setTimeout(2_400_000);
  const auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit real-provider authentication is required.");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must select the actual read-only course library.");
  const sourceDirectory =
    process.env.RESEARCH_DESIGN_REVIEW_SOURCE_DIR ??
    resolve(
      __dirname,
      "../../../../.artifacts/fusion-real-design-selected-20261107/live-research-fusion-real--5d7d7-icitly-selected-paper-scope",
    );
  const projectFile = join(sourceDirectory, "research-project.json"),
    designFile = join(sourceDirectory, `artifact-${ORIGINAL_DESIGN_ID}.md`),
    contentReviewFile = join(sourceDirectory, "independent-content-review.json");
  const sourceProject = decodeResearchState({
    version: 1,
    config: { knowledgeDir },
    projects: [JSON.parse(await readFile(projectFile, "utf8"))],
  }).projects[0]!;
  const design = sourceProject.artifacts.find((artifact) => artifact.id === ORIGINAL_DESIGN_ID);
  if (!design || design.kind !== "stage-revision" || design.stage !== "design")
    throw new Error("The selected source is not the retained real-run final design revision.");
  const originalText = await readFile(designFile, "utf8");
  expect(originalText).toBe(design.content);
  expect(originalText).toContain("G3不是独立单次期末考");
  expect(sourceProject.memberTokenBudget).toBe(8_000_000);
  if (process.env.RESEARCH_MEMBER_TOKEN_BUDGET !== undefined)
    expect(Number(process.env.RESEARCH_MEMBER_TOKEN_BUDGET)).toBe(sourceProject.memberTokenBudget);
  const originalReview = object(JSON.parse(await readFile(contentReviewFile, "utf8")));
  const finding = (
    Array.isArray(originalReview.findings) ? originalReview.findings.map(object) : []
  ).find((item) => item.id === "C-01");
  if (
    !finding ||
    finding.severity !== "P2" ||
    typeof finding.observed !== "string" ||
    typeof finding.recommendation !== "string"
  )
    throw new Error("The independent model C-01 P2 finding must be retained before local review.");
  const originalFiles = [
    projectFile,
    designFile,
    contentReviewFile,
    ...sourceProject.evidence!.sources.map((source) => source.file),
  ];
  const originals = await Promise.all(
    originalFiles.map(async (file) => ({ file, sha256: researchHash(await readFile(file)) })),
  );
  const beganAt = new Date().toISOString();
  const profile = await makeUserDataDir("research-design-local-review-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-design-local-review-live"),
    materialsDirectory = join(workspace, "provided-design-review");
  await mkdir(materialsDirectory, { recursive: true });
  const sourceManifest = [];
  expect(sourceProject.evidence!.sources.map((source) => source.id).sort()).toEqual([
    "DA2025",
    "SMS2025",
    "UCI",
  ]);
  for (const source of sourceProject.evidence!.sources) {
    const text = await readPinnedResearchFile(source);
    const file = `${source.id}.txt`;
    await writeFile(join(materialsDirectory, file), text, { flag: "wx" });
    sourceManifest.push({
      id: source.id,
      title: source.title,
      authors: source.authors,
      year: source.year,
      url: source.url,
      kind: source.kind,
      file,
    });
  }
  await writeFile(join(materialsDirectory, "original-design.md"), originalText, { flag: "wx" });
  sourceManifest.push({
    id: DESIGN_SOURCE_ID,
    title: "原真实R方案修订：待独立局部复核",
    authors: "原研究者 A 模型；不是本轮已接受方案",
    year: "2026",
    url: `urn:lancer:research-artifact:${ORIGINAL_DESIGN_ID}`,
    kind: "design",
    file: "original-design.md",
  });
  await writeFile(
    join(materialsDirectory, "manifest.json"),
    JSON.stringify({ version: 1, sources: sourceManifest, datasets: [] }, null, 2),
    { flag: "wx" },
  );
  const evidence = await openResearchEvidence(materialsDirectory);
  expect(evidence.datasets).toEqual([]);
  for (const source of sourceProject.evidence!.sources)
    expect(evidence.sources.find((item) => item.id === source.id)!.sha256).toBe(source.sha256);
  expect(evidence.sources.find((source) => source.id === DESIGN_SOURCE_ID)!.sha256).toBe(
    researchHash(originalText),
  );
  const plan = {
    beganAt,
    scope: REVIEW_SCOPE,
    profile,
    workspace,
    sourceProjectId: sourceProject.id,
    sourceArtifactId: design.id,
    sourceDirectory,
    sourceHashes: originals,
    copiedSources: evidence.sources,
    route: {
      entry: "task",
      goal: "task",
      kind: "design-review",
      stages: ["design"],
      requiredRoles: ["lead", "reviewer", "mentor"],
      inactiveRetainedRole: "librarian",
    },
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
      librarian: "openai-codex/gpt-6.1-sol low; retained idle, not dispatched",
    },
    budget: {
      memberTokenBudget: sourceProject.memberTokenBudget,
      origin: "retained original R project",
      configuredCeilingsSum: sourceProject.memberTokenBudget! * 4,
      notice: "Not an atomic billing cap.",
    },
    reviewOrigin: {
      identity: originalReview.reviewIdentity,
      independenceBoundary: originalReview.independenceBoundary,
      finding,
    },
    proof:
      "New real-provider bounded S5 design-review task. Prior C is independent model feedback, not human approval. New output requires a fresh independent content review before claiming the correction passed.",
    modifiesHistoricalProject: false,
    externalSearchAuthorized: false,
    empiricalAnalysisAuthorized: false,
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  console.log(
    "[research-design-local-review]",
    JSON.stringify({
      profile,
      workspace,
      sourceDirectory,
      memberTokenBudget: sourceProject.memberTokenBudget,
    }),
  );
  const harness = await launchDesktop(profile, {
    initialWorkspaces: [workspace],
    realAuthSourceDir: auth.sourceDir,
    enabledModels: ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-astra"],
    testMode: "background",
  }).catch(async (error: unknown) => {
    await writeFile(
      test.info().outputPath("run-outcome.json"),
      JSON.stringify(
        {
          ...plan,
          endedAt: new Date().toISOString(),
          failure: String(error),
          finalStatus: "launch-failed",
          independentContentReview: "pending; no new execution or correction proof",
        },
        null,
        2,
      ),
    );
    throw error;
  });
  let lastState: DesktopAppState | undefined,
    failure: string | undefined,
    acceptedAt: string | undefined,
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
    await expect(editor).toBeVisible();
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(knowledgeDir);
    await editor.getByLabel("研究材料目录", { exact: true }).fill(materialsDirectory);
    await editor.getByLabel("研究入口", { exact: true }).selectOption("task");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("task");
    await editor.getByLabel("单项任务类型", { exact: true }).selectOption("design-review");
    await editor.getByLabel("单项任务范围", { exact: true }).fill(REVIEW_SCOPE);
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    await editor
      .getByLabel("成员 Token 上限", { exact: true })
      .fill(String(sourceProject.memberTokenBudget));
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
    await expect(editor.getByLabel("本轮路由说明", { exact: true })).toContainText(
      /本轮方法范围：\s*S5。/,
    );
    await page.screenshot({ path: test.info().outputPath("bounded-design-review-config.png") });
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await openNewThread(page);
    const prompt = `这是新建的局部方案复核任务，不是重新执行旧课题，也不能覆盖旧项目或原稿。材料目录有PRIOR-DESIGN（原真实运行方案修订${ORIGINAL_DESIGN_ID}，kind design）及UCI、DA2025、SMS2025三个当时实际取得的原文副本，没有数据文件。本轮范围：${REVIEW_SCOPE}\n独立内容审阅C的身份：未担任原轮A/B/导师的独立模型审阅者，不是人类领域专家或外部团队审计；其P2意见是待你们对照原文独立复核的反馈，不是用户新证实的事实。C-01观察：${finding.observed}\n建议：${finding.recommendation}\nUCI现有文本未交代G3具体评分构成。请辨明“不能预设为独立单次考试”和“已知不是独立单次考试”的确定程度差别；也不能由未知反向断言它是独立考试。核对原方案相关语句及后续限制段落的一致性。\nA/B先各自实际source-read PRIOR-DESIGN及UCI，再形成局部判断，必要时只从已提供DA2025/SMS2025定位其他边界；本单任务只派发A/B/导师，资料员会话保留但不请求其运行。A初稿列原句、依据、拟替换段落及保留不动内容，B给具体逐项意见，A回应后发布局部修订（保留足够上下文和修改前后对照），B实际read最新修订再复核，导师先实际source-read PRIOR-DESIGN及UCI，再实际read修订与B复核后仅对本范围裁定。所有稿件/修订sourceIds引用实际读取的PRIOR-DESIGN，论据引用实际读过的UCI等来源；refs只引用本新任务实际read过的成果，不把原旧artifact ID当本轮refs。\n其余边界逐项核对但不得擅自扩大改写：数学/葡语与总体区分；合法零成绩和缺勤保留；absences窗口和原因未知；paid/failures编码；固定样本的相关与OLS均只是未来计划；缺失与选择偏倚；观察关联不作因果；文章/数据许可和人的授权/伦理审批分开；不把未发现当首创。若发现新实质问题，仅报告与定位，不暗中重写其他段落。\n不联网追加检索，不调用source-search/source-fetch，不运行bash或外部命令，不调用analyze，不导入CSV，不生成样本统计、系数、p值或新实证结论。已有公共材料局部文本复核已获本次任务范围授权；不联系学生、不干预、不投稿。只在S5完成本单项任务，无需等待数据，不补造早期执行记录，不进入S6–S8。模型accept仅表示本轮模型裁定；修订正确与否仍留待新的独立C核查。`;
    await writeFile(test.info().outputPath("initial-instruction.txt"), prompt);
    await page.getByLabel("New thread prompt").fill(prompt);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    let lastLogged = 0;
    await expect
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          const project = lastState.researchGroups?.projects[0];
          if (!project) return false;
          const boundary = captureBoundary(lastState, project);
          if (Date.now() - lastLogged >= 20_000) {
            lastLogged = Date.now();
            await appendFile(
              test.info().outputPath("progress.jsonl"),
              JSON.stringify({
                at: new Date().toISOString(),
                status: project.status,
                stage: project.currentStage,
                artifacts: project.artifacts.length,
                ...boundary,
              }) + "\n",
            );
            console.log(
              "[research-design-review-progress]",
              JSON.stringify({
                status: project.status,
                stage: project.currentStage,
                artifacts: project.artifacts.length,
                activeNative: boundary.activeNativeAtCapture.length,
              }),
            );
          }
          const pending =
            project.fusion?.decisionRequests?.filter(
              (request) =>
                researchTaskControlDecisionStatus(project.fusion!, request.id) === "pending",
            ) ?? [];
          if (pending.length)
            throw new Error(
              `Local decision required: ${JSON.stringify(pending.map((request) => ({ id: request.id, question: request.question })))}`,
            );
          if (
            lastState.researchGroups?.error ||
            project.status === "paused" ||
            project.status === "needs-decision"
          )
            throw new Error(lastState.researchGroups?.error ?? project.error ?? project.status);
          if (project.status !== "completed") return false;
          acceptedAt ??= new Date().toISOString();
          if (boundary.activeNativeAtCapture.length) return false;
          if (project.fusion?.attempts.some((attempt) => attempt.state !== "succeeded"))
            throw new Error(
              "Accepted output has non-successful native attempts; cleanup is not completion.",
            );
          nativeEndedAt = new Date().toISOString();
          return true;
        },
        { timeout: 2_100_000, intervals: [1000, 5000] },
      )
      .toBe(true);
    lastState = await getDesktopState(page);
    const project = lastState.researchGroups!.projects[0]!;
    expect(project.id).not.toBe(sourceProject.id);
    expect(project).toMatchObject({
      workflowVersion: "fusion-v2",
      entry: "task",
      goal: "task",
      task: { kind: "design-review", scope: REVIEW_SCOPE },
      currentStage: "design",
      memberTokenBudget: 8_000_000,
    });
    expect(researchExecutionRoute(project).stageIds).toEqual(["design"]);
    expect(new Set(project.fusion!.tasks.map((task) => task.stage))).toEqual(new Set(["design"]));
    expect(new Set(project.fusion!.tasks.map((task) => task.role))).toEqual(
      new Set(["lead", "reviewer", "mentor"]),
    );
    expect(
      project.events.some((event) => event.type === "started" && event.role === "librarian"),
    ).toBe(false);
    expect(project.artifacts.every((artifact) => artifact.stage === "design")).toBe(true);
    expect(project.evidence!.datasets).toEqual([]);
    expect(project.analyses ?? []).toEqual([]);
    expect(project.finalPaper).toBeUndefined();
    expect(new Set(project.members.map((member) => member.ref.sessionId)).size).toBe(4);
    expect(
      project.members.every(
        (member) =>
          !sourceProject.members.some((old) => old.ref.sessionId === member.ref.sessionId),
      ),
    ).toBe(true);
    for (const role of ["lead", "reviewer", "mentor"] as const)
      for (const sourceId of [DESIGN_SOURCE_ID, "UCI"])
        expect(
          project.events.some(
            (event) =>
              event.type === "source-read" &&
              event.role === role &&
              event.sourceId === sourceId &&
              event.sourceSha256 ===
                evidence.sources.find((source) => source.id === sourceId)!.sha256,
          ),
        ).toBe(true);
    const revised = project.artifacts
      .filter((artifact) => artifact.kind === "stage-revision")
      .at(-1)!;
    expect(revised).toBeTruthy();
    expect(revised.sourceIds).toContain(DESIGN_SOURCE_ID);
    const critique = project.artifacts.find(
      (artifact) => artifact.kind === "stage-critique" && revised.refs.includes(artifact.id),
    )!;
    expect(critique).toBeTruthy();
    expect(
      project.events.some(
        (event) =>
          event.type === "read" && event.role === "lead" && event.artifactId === critique.id,
      ),
    ).toBe(true);
    const verification = project.artifacts.find(
      (artifact) =>
        artifact.kind === "stage-verification" &&
        artifact.verdict === "accept" &&
        artifact.refs.includes(revised.id),
    )!;
    expect(verification).toBeTruthy();
    expect(
      project.artifacts.some(
        (artifact) =>
          artifact.kind === "stage-review" &&
          artifact.verdict === "accept" &&
          artifact.refs.includes(revised.id) &&
          artifact.refs.includes(verification.id),
      ),
    ).toBe(true);
    for (const artifact of project.artifacts)
      expect(artifact.model).toEqual(
        project.stages!.find((stage) => stage.id === artifact.stage)!.models[artifact.role],
      );
    const ledger = await nativeCallLedger(profile, project);
    expect(
      ledger
        .flatMap((member) => member.calls)
        .filter(
          (call) =>
            call.name !== "research_group" ||
            ["source-search", "source-fetch", "analyze"].includes(String(call.operation)),
        ),
    ).toEqual([]);
    expect(captureBoundary(lastState, project).activeNativeAtCapture).toEqual([]);
    expect(rendererErrors).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("bounded-design-review-native-ended.png"),
    });
    await writeFile(test.info().outputPath("new-local-revision.md"), revised.content);
    await writeFile(
      test.info().outputPath("content-review-needed.json"),
      JSON.stringify(
        {
          status: "pending-independent-C",
          originalDesignId: design.id,
          newProjectId: project.id,
          newRevisionId: revised.id,
          finding,
          originalDesignHash: researchHash(originalText),
          revisedHash: researchHash(revised.content),
          notice:
            "Tool/read/ref/model-chain assertions are R execution evidence. No automated phrase match establishes correct uncertainty or preservation of unrelated content; independently compare original, new local text and actual sources.",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      try {
        lastState = await getDesktopState(await harness.firstWindow());
      } catch (error) {
        failure ??= String(error);
      }
      const project = lastState?.researchGroups?.projects[0];
      const originalIntegrity = await Promise.all(
        originals.map(async (item) => ({
          ...item,
          unchanged: researchHash(await readFile(item.file)) === item.sha256,
        })),
      );
      const copiedIntegrity = await Promise.all(
        evidence.sources.map(async (source) => ({
          id: source.id,
          file: source.file,
          sha256: source.sha256,
          unchanged: researchHash(await readFile(source.file)) === source.sha256,
        })),
      );
      if (project && lastState) {
        await writeFile(
          test.info().outputPath("research-project.json"),
          JSON.stringify(project, null, 2),
        );
        for (const artifact of project.artifacts)
          await writeFile(test.info().outputPath(`artifact-${artifact.id}.md`), artifact.content);
        await writeFile(
          test.info().outputPath("reads-refs-usage-errors.json"),
          JSON.stringify(
            {
              capturedAt: new Date().toISOString(),
              acceptedAt,
              nativeEndedAt,
              ...captureBoundary(lastState, project),
              reads: project.events.filter((event) => ["source-read", "read"].includes(event.type)),
              artifacts: project.artifacts.map(({ id, role, kind, refs, sourceIds, model }) => ({
                id,
                role,
                kind,
                refs,
                sourceIds,
                model,
              })),
              attempts: project.fusion?.attempts,
              projectErrors: project.events.filter((event) => event.type === "error"),
              nativeTools: await nativeCallLedger(profile, project).catch((error: unknown) => ({
                audit: "incomplete",
                failure: String(error),
              })),
              errorCoverage:
                "Project error events do not include every rejected tool call; nativeTools retains actual tool-call errors.",
              rendererErrors,
            },
            null,
            2,
          ),
        );
      }
      await writeFile(
        test.info().outputPath("run-outcome.json"),
        JSON.stringify(
          {
            ...plan,
            endedAt: new Date().toISOString(),
            acceptedAt,
            nativeEndedAt,
            failure,
            finalStatus: project?.status ?? "not-created",
            independentContentReview: "pending; do not claim correction passed before new C",
            originalIntegrity,
            copiedIntegrity,
            ...(project && lastState ? captureBoundary(lastState, project) : {}),
            teardownNotice:
              "Closing an active/unknown request after failure is cleanup, not natural successful completion.",
          },
          null,
          2,
        ),
      );
      expect(originalIntegrity.every((item) => item.unchanged)).toBe(true);
      expect(copiedIntegrity.every((item) => item.unchanged)).toBe(true);
    } finally {
      await harness.close();
    }
  }
});
