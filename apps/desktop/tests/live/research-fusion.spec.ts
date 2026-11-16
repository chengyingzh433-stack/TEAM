import { expect, test } from "@playwright/test";
import { appendFile, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import { researchTaskControlDecisionStatus } from "../../contracts/research-task-controls";
import type { DesktopAppState } from "../../contracts/desktop-state";
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

async function configuredBudget(): Promise<{ value: number; source: string }> {
  let value: unknown = process.env.RESEARCH_MEMBER_TOKEN_BUDGET;
  let source = "RESEARCH_MEMBER_TOKEN_BUDGET";
  if (value === undefined) {
    source =
      process.env.RESEARCH_CONFIG_SOURCE_FILE ??
      join(homedir(), "Library", "Application Support", "Lancer", "research-groups.json");
    const saved: unknown = JSON.parse(await readFile(source, "utf8"));
    if (
      !saved ||
      typeof saved !== "object" ||
      !("config" in saved) ||
      !saved.config ||
      typeof saved.config !== "object" ||
      !("memberTokenBudget" in saved.config)
    )
      throw new Error(
        "No existing memberTokenBudget. Set RESEARCH_MEMBER_TOKEN_BUDGET explicitly; this live test does not invent a budget.",
      );
    value = saved.config.memberTokenBudget;
  }
  const budget =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 10_000_000)
    throw new Error(
      "Research budget must be an existing or explicit integer between 1000 and 10000000.",
    );
  return { value: budget, source };
}

/** Copy only pinned raw sources/data, never prior manuscripts, model history or authentication. */
async function prepareMaterials(destination: string, goal: "design" | "paper") {
  const sourceDirectory =
    process.env.RESEARCH_MATERIALS_DIR ??
    resolve(__dirname, "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料");
  const evidence = await openResearchEvidence(sourceDirectory);
  if (evidence.sources.filter((s) => s.kind === "paper").length < 2)
    throw new Error("The fusion live run requires at least two actual supplied research texts.");
  if (goal === "paper" && !evidence.datasets.some((d) => d.dataKind === "observed"))
    throw new Error(
      "The paper run requires real observed data; synthetic data cannot pass this acceptance.",
    );
  await mkdir(destination, { recursive: true });
  const sources = [];
  for (const source of evidence.sources) {
    const text = await readPinnedResearchFile(source);
    const file = `${source.id}.txt`;
    await writeFile(join(destination, file), text, { flag: "wx" });
    sources.push({
      id: source.id,
      title: source.title,
      authors: source.authors,
      year: source.year,
      url: source.url,
      kind: source.kind,
      file,
    });
  }
  const datasets = [];
  if (goal === "paper")
    for (const dataset of evidence.datasets) {
      if (dataset.dataKind !== "observed")
        throw new Error(
          "Mixed synthetic datasets are not permitted in the real-paper acceptance input.",
        );
      const text = await readPinnedResearchFile(dataset, 10_000_000);
      const file = `${dataset.id}.csv`;
      await writeFile(join(destination, file), text, { flag: "wx" });
      datasets.push({
        id: dataset.id,
        file,
        description: dataset.description,
        sourceId: dataset.sourceId,
        dataKind: dataset.dataKind,
        permission: dataset.permission,
        delimiter: dataset.delimiter,
      });
    }
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify({ version: 1, sources, datasets }, null, 2),
    { flag: "wx" },
  );
  const isolated = await openResearchEvidence(destination);
  expect(isolated.sources.map((s) => s.sha256)).toEqual(evidence.sources.map((s) => s.sha256));
  return { sourceDirectory, original: evidence, isolated };
}

function collaborationEvidence(p: ResearchProject, observedAt: string) {
  const intervals = p.events
    .filter((e) => e.type === "started" && e.runId)
    .map((start) => ({
      role: start.role,
      runId: start.runId,
      start: start.runtimeAt ?? start.at,
      output: p.events.find((e) => e.type === "output" && e.runId === start.runId),
      finish: p.events.find((e) => e.type === "finished" && e.runId === start.runId),
    }));
  const overlaps = intervals.flatMap((a, index) =>
    intervals
      .slice(index + 1)
      .filter(
        (b) =>
          a.role !== b.role &&
          a.output &&
          b.output &&
          Math.max(
            Date.parse(a.output.runtimeAt ?? a.output.at),
            Date.parse(b.output.runtimeAt ?? b.output.at),
          ) <
            Math.min(
              Date.parse(a.finish?.runtimeAt ?? a.finish?.at ?? observedAt),
              Date.parse(b.finish?.runtimeAt ?? b.finish?.at ?? observedAt),
            ),
      )
      .map((b) => ({ left: a.runId, right: b.runId, roles: [a.role, b.role] })),
  );
  const midRunReads = p.events.filter(
    (e) =>
      e.type === "read" &&
      e.producerRunning &&
      e.runId &&
      e.producerRunId &&
      p.artifacts.find((a) => a.id === e.artifactId)?.role !== e.role,
  );
  const responseChains = p.artifacts
    .filter((a) => a.role === "reviewer" && ["critique", "stage-critique"].includes(a.kind))
    .flatMap((critique) => {
      const initial = p.artifacts.find((a) => a.role === "lead" && critique.refs.includes(a.id));
      return p.artifacts
        .filter((a) => a.role === "lead" && a.refs.includes(critique.id))
        .map((revision) => ({
          critiqueId: critique.id,
          stage: critique.stage,
          initialId: initial?.id,
          revisionId: revision.id,
          actualRead: p.events.some(
            (e) => e.type === "read" && e.role === "lead" && e.artifactId === critique.id,
          ),
          textChanged: !!initial && initial.content !== revision.content,
          verificationIds: p.artifacts
            .filter(
              (a) =>
                a.role === "reviewer" &&
                ["verification", "stage-verification"].includes(a.kind) &&
                a.refs.includes(revision.id),
            )
            .map((a) => a.id),
        }));
    });
  return {
    intervals,
    overlaps,
    midRunReads,
    responseChains,
    contentReview: {
      status: "pending-independent-review",
      identity: "No independent reviewer has been invoked by this test",
      limitation:
        "References and changed text establish a response chain, not that B's argument is substantively correct. Assess the preserved texts independently.",
    },
  };
}

function usageEvidence(state: DesktopAppState, p: ResearchProject) {
  return p.members.map((member) => {
    const usage = state.sessionUsageBySession[`${member.ref.workspaceId}:${member.ref.sessionId}`];
    return {
      role: member.role,
      session: member.ref,
      usage: usage ?? null,
      consumptionKnown: !!usage,
      moneySpent: usage && !usage.subscription ? usage.totals.cost : null,
      moneyNotice:
        "Provider-reported cost is not an independently verified bill; subscription estimates are not money spent. Missing usage remains unknown.",
    };
  });
}

/** Accepted research is not a native completion boundary or a final usage receipt. */
function nativeCaptureBoundary(state: DesktopAppState, p: ResearchProject) {
  const activeNativeAtCapture = p.members.flatMap((member) => {
    const session = state.workspaces
      .find((workspace) => workspace.id === member.ref.workspaceId)
      ?.sessions.find((session) => session.id === member.ref.sessionId);
    const attempts =
      p.fusion?.attempts.filter(
        (attempt) =>
          p.fusion!.tasks.find((task) => task.id === attempt.taskId)?.role === member.role &&
          ["prepared", "running", "unknown"].includes(attempt.state),
      ) ?? [];
    const unfinishedRunIds = p.events
      .filter(
        (event) =>
          event.type === "started" &&
          event.role === member.role &&
          event.runId &&
          !p.events.some((finish) => finish.type === "finished" && finish.runId === event.runId),
      )
      .map((event) => event.runId);
    return member.status === "running" ||
      !session ||
      session.status === "running" ||
      attempts.length ||
      unfinishedRunIds.length
      ? [
          {
            role: member.role,
            session: member.ref,
            memberStatus: member.status,
            nativeSessionStatus: session?.status ?? "unavailable",
            attempts: attempts.map((attempt) => ({
              id: attempt.id,
              state: attempt.state,
              nativeRunId: attempt.nativeRunId,
            })),
            unfinishedRunIds,
          },
        ]
      : [];
  });
  const incompleteUsageRoles = p.members
    .filter(
      (member) => !state.sessionUsageBySession[`${member.ref.workspaceId}:${member.ref.sessionId}`],
    )
    .map((member) => member.role);
  const unsettledUsageAttemptIds =
    p.fusion?.attempts
      .filter((attempt) => attempt.usedTokens === undefined)
      .map((attempt) => attempt.id) ?? [];
  return {
    activeNativeAtCapture,
    usageFinality: {
      status: activeNativeAtCapture.length
        ? "provisional-native-unsettled"
        : incompleteUsageRoles.length || unsettledUsageAttemptIds.length
          ? "native-ended-usage-incomplete"
          : "native-ended-provider-reported",
      incompleteUsageRoles,
      unsettledUsageAttemptIds,
      limitation:
        "Native completion permits a final application snapshot, not an independently verified bill. Missing provider or attempt usage remains unknown; tool errors are audited separately from project error events.",
    },
  };
}

/** Read only the four isolated session JSONLs, never the auth directory or complete prompts. */
async function nativeToolErrorEvidence(profile: string, p: ResearchProject) {
  const root = join(profile, "agent", "sessions");
  const paths = await readdir(root, { recursive: true });
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Promise.all(
    p.members.map(async (member) => {
      const relative = paths.find((path) => path.endsWith(`_${member.ref.sessionId}.jsonl`));
      if (!relative)
        return {
          role: member.role,
          audit: "session-log-unavailable",
          toolResults: null,
          toolErrors: null,
        };
      const lines = (await readFile(join(root, relative), "utf8")).trim().split("\n");
      const calls = new Map<
        string,
        { name: unknown; operation: unknown; stage: unknown; kind: unknown }
      >();
      const errors: {
        line: number;
        at: unknown;
        toolCallId: unknown;
        call: unknown;
        errorText: string;
      }[] = [];
      let toolResults = 0;
      for (let index = 0; index < lines.length; index++) {
        const entry = object(JSON.parse(lines[index]!)),
          message = object(entry.message);
        const content = Array.isArray(message.content) ? message.content.map(object) : [];
        for (const part of content) {
          if (part.type !== "toolCall" || typeof part.id !== "string") continue;
          const args = object(part.arguments);
          calls.set(part.id, {
            name: part.name,
            operation: args.operation,
            stage: args.stage,
            kind: args.kind,
          });
        }
        if (message.role !== "toolResult") continue;
        toolResults++;
        if (message.isError === true)
          errors.push({
            line: index + 1,
            at: entry.timestamp,
            toolCallId: message.toolCallId,
            call:
              typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined,
            errorText: content
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => String(part.text))
              .join("\n"),
          });
      }
      return {
        role: member.role,
        audit: "persisted-native-session",
        sessionFile: relative,
        toolResults,
        toolErrors: errors,
      };
    }),
  );
}

test("real fusion flow accepts an evidence-based design without data or completes the explicitly selected paper scope", async () => {
  const goal = process.env.RESEARCH_FUSION_GOAL ?? "design";
  if (goal !== "design" && goal !== "paper")
    throw new Error("RESEARCH_FUSION_GOAL must be design or paper.");
  test.setTimeout(goal === "paper" ? 3_600_000 : 2_400_000);
  const beganAt = new Date().toISOString();
  const interventionLog: { at: string; actor: string; action: string }[] = [];
  const preflight = {
    beganAt,
    goal,
    projects: 1,
    sustainedRoles: [...RESEARCH_ROLES],
    flow: "fusion-v2",
    entry: "idea",
    evidenceLevel: "R plus Electron, not independent C or native installation N",
    automaticRetry: false,
    priorManuscriptImported: false,
    interventions: interventionLog,
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(preflight, null, 2));
  const auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit real-provider authentication opt-in is required.");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must name the actual read-only course library.");
  const budget = await configuredBudget();
  const profile = await makeUserDataDir("research-fusion-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-fusion-live");
  const materials = await prepareMaterials(join(workspace, "fusion-inputs"), goal);
  await writeFile(
    test.info().outputPath("run-plan.json"),
    JSON.stringify(
      {
        ...preflight,
        profile,
        workspace,
        budget,
        configuredMemberTokenCeilingsSum: budget.value * 4,
        budgetNotice:
          "Existing per-member token ceilings, including cache counts; this sum is not an atomic project reservation or a billing cap.",
        materials: materials.isolated,
        models: {
          mentor: "openai-codex/gpt-6-astra high",
          lead: "openai-codex/gpt-6.1-sol high",
          reviewer: "Astra high for S0/S1/S4/S5/S6/S8; Sol high otherwise",
          librarian: "openai-codex/gpt-6.1-sol low",
        },
        runScale:
          goal === "design"
            ? "One idea-to-design run, S1–S5, zero datasets, no execution of empirical analysis"
            : "One new idea-to-paper run, S1–S8, real observed data; not the 18-run comparison study",
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  console.log(
    "[research-fusion-live]",
    JSON.stringify({
      profile,
      workspace,
      goal,
      memberTokenBudget: budget.value,
      budgetSource: budget.source,
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
          ...preflight,
          profile,
          workspace,
          endedAt: new Date().toISOString(),
          finalStatus: "launch-failed",
          failure: String(error),
          interventions: interventionLog,
        },
        null,
        2,
      ),
    );
    throw error;
  });
  let lastState: DesktopAppState | undefined;
  let failure: string | undefined;
  let acceptedAt: string | undefined;
  let nativeEndedAt: string | undefined;
  const rendererErrors: string[] = [];
  try {
    await chmod(join(profile, "agent"), 0o700);
    await chmod(join(profile, "agent", "auth.json"), 0o600);
    const page = await harness.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 980),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(knowledgeDir);
    await editor.getByLabel("研究入口", { exact: true }).selectOption("idea");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption(goal);
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    await editor.getByLabel("成员 Token 上限", { exact: true }).fill(String(budget.value));
    await editor.getByLabel("研究材料目录", { exact: true }).fill(materials.isolated.directory);
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
    await page.screenshot({ path: test.info().outputPath("fusion-model-config.png") });
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    const prompt = `请使用融合版流程从这个想法开始：想了解葡萄牙中学生数学课程的早期成绩、缺勤与期末成绩有什么观察关联。沿用课程方法库，以本次材料目录中的 UCI 官方说明和两篇已取得正文的研究文献作为实际阅读来源，不导入旧演练稿。${goal === "design" ? "本轮只完成合格研究方案，实际数据尚未提供。清点目录应确认 datasets 为空，不能执行 analyze 或编造观察结果。需要取得的数据、许可、字段、质量检查与分析计划均作为未来条件，方案可先接受；不要因为没有CSV而让方案永远停留。" : "本轮推进至完整论文。目录包含真实 UCI 数学数据，冻结计划后运行实际分析和 B 复算，随后写作、终审并导出。"}先从已有问题 S1 开始，不做宽泛 S0；进行实际定向检索或如实说明访问限制、分级阅读、反证和综合后设计。对公共二手材料的探索性研究已获本次任务范围授权，不联系学生、不开展干预、不投稿，不把这种授权写成伦理审批。保留零成绩，区分数学与葡语样本，审查变量时点、样本、编码、缺勤解释与结论边界。研究者 A/B 先独立判断再互评；B 对现有证据与未来分析提出有依据的具体意见，A 逐条回应并修订真实受到影响的内容，不为了测试凑问题。资料员先发布可用批次并继续原文核查，下游实际读取、使用，不等全员结束。统计工具未支持的p值、置信区间和因果解释不得编造。只通过research_group工具提交成果与裁定；完整方案明确问题—证据—材料获取—变量—分析—可行性—伦理安排—结论边界与已知缺口。所有评阅身份标为模型评阅，未收到的人的回复保持未知。中间成果简洁；${goal === "design" ? "最终研究方案约1500–3000中文字并附实施待办。" : "完整终稿约2500–5000中文字，保留真实来源和可复算数字。"}`;
    await writeFile(test.info().outputPath("initial-instruction.txt"), prompt);
    interventionLog.push({
      at: new Date().toISOString(),
      actor: "test operator under existing user authorization",
      action:
        "Configured explicitly recorded models and existing budget, then submitted the preserved initial instruction; no subsequent intervention is automated.",
    });
    await page.getByLabel("New thread prompt").fill(prompt);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    let lastLogged = 0;
    await expect
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          const p = lastState.researchGroups?.projects[0];
          const boundary = p ? nativeCaptureBoundary(lastState, p) : undefined;
          const pendingDecisions =
            p?.fusion?.decisionRequests?.filter(
              (request) => researchTaskControlDecisionStatus(p.fusion!, request.id) === "pending",
            ) ?? [];
          if (p && Date.now() - lastLogged >= 20_000) {
            lastLogged = Date.now();
            const snapshot = {
              at: new Date().toISOString(),
              status: p.status,
              stage: p.currentStage,
              artifacts: p.artifacts.length,
              errors: p.events.filter((e) => e.type === "error"),
              usage: usageEvidence(lastState, p),
              ...boundary,
              pendingDecisions,
            };
            await appendFile(
              test.info().outputPath("progress.jsonl"),
              JSON.stringify(snapshot) + "\n",
            );
            console.log(
              "[research-fusion-progress]",
              JSON.stringify({
                at: snapshot.at,
                status: p.status,
                stage: p.currentStage,
                artifacts: p.artifacts.length,
                errors: snapshot.errors.length,
              }),
            );
          }
          if (lastState.researchGroups?.error) throw new Error(lastState.researchGroups.error);
          if (p?.status === "needs-decision" || p?.status === "paused")
            throw new Error(`Run requires an explicit recovery/decision: ${p.error ?? p.status}`);
          if (pendingDecisions.length)
            throw new Error(
              `Task-local human decision pending: ${JSON.stringify(pendingDecisions.map((request) => ({ id: request.id, question: request.question, affectedTaskIds: request.affectedTaskIds })))}`,
            );
          if (p?.status !== "completed") return false;
          acceptedAt ??= new Date().toISOString();
          if (boundary!.activeNativeAtCapture.length) return false;
          const abnormal =
            p.fusion?.attempts.filter((attempt) =>
              ["failed", "cancelled", "unknown"].includes(attempt.state),
            ) ?? [];
          if (abnormal.length)
            throw new Error(
              `Research accepted but native attempts did not all end successfully: ${JSON.stringify(abnormal.map((attempt) => ({ id: attempt.id, state: attempt.state })))}`,
            );
          nativeEndedAt = new Date().toISOString();
          return true;
        },
        { timeout: goal === "paper" ? 3_300_000 : 2_100_000, intervals: [1000, 5000] },
      )
      .toBe(true);
    lastState = await getDesktopState(page);
    const p = lastState.researchGroups!.projects[0]!;
    expect(p).toMatchObject({
      workflowVersion: "fusion-v2",
      methodVersion: "2.0.0",
      entry: "idea",
      goal,
      memberTokenBudget: budget.value,
    });
    expect(new Set(p.members.map((m) => m.ref.sessionId)).size).toBe(4);
    expect(p.events.filter((e) => e.type === "source-read").length).toBeGreaterThan(0);
    expect(p.events.some((e) => e.type === "source-read" && e.role === "reviewer")).toBe(true);
    const proof = collaborationEvidence(p, new Date().toISOString());
    expect(proof.overlaps.length).toBeGreaterThan(0);
    expect(proof.midRunReads.length).toBeGreaterThan(0);
    expect(
      proof.responseChains.some(
        (chain) => chain.actualRead && chain.textChanged && chain.verificationIds.length,
      ),
    ).toBe(true);
    const designReview = p.artifacts
      .filter((a) => a.stage === "design" && a.kind === "stage-review" && a.verdict === "accept")
      .at(-1);
    expect(designReview).toBeTruthy();
    for (const artifact of p.artifacts) {
      const configured = p.stages?.find((s) => s.id === artifact.stage)?.models[artifact.role];
      expect(artifact.model, `Actual model of ${artifact.id}`).toEqual(configured);
    }
    if (goal === "design") {
      expect(p.evidence?.datasets).toEqual([]);
      expect(p.analyses ?? []).toHaveLength(0);
      expect(p.currentStage).toBe("design");
      expect(p.finalPaper).toBeUndefined();
    } else {
      expect(p.finalPaper).toBeTruthy();
      expect(
        p.artifacts.some(
          (a) => a.stage === "audit" && a.kind === "stage-review" && a.verdict === "accept",
        ),
      ).toBe(true);
      expect(
        p.analyses?.some(
          (a) =>
            a.role === "lead" &&
            p.analyses!.some((b) => b.role === "reviewer" && a.sha256 === b.sha256),
        ),
      ).toBe(true);
      for (const file of Object.values(p.finalPaper!))
        expect((await readFile(file)).length).toBeGreaterThan(0);
    }
    expect(rendererErrors).toEqual([]);
    const capture = nativeCaptureBoundary(lastState, p);
    expect(capture.activeNativeAtCapture).toEqual([]);
    await writeFile(
      test.info().outputPath("capture-boundary.json"),
      JSON.stringify(
        { capturedAt: new Date().toISOString(), acceptedAt, nativeEndedAt, ...capture },
        null,
        2,
      ),
    );
    await page.screenshot({ path: test.info().outputPath("fusion-reviewed.png") });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      lastState = await getDesktopState(await harness.firstWindow());
    } catch (error) {
      failure ??= `Final state unavailable; private profile retained: ${String(error)}`;
    }
    try {
      const p = lastState?.researchGroups?.projects[0];
      if (p && lastState) {
        const nativeTools = await nativeToolErrorEvidence(profile, p).catch((error: unknown) => ({
          audit: "incomplete",
          failure: String(error),
          limitation: "No zero-tool-error claim is possible.",
        }));
        await writeFile(
          test.info().outputPath("research-project.json"),
          JSON.stringify(p, null, 2),
        );
        await writeFile(
          test.info().outputPath("collaboration-proof.json"),
          JSON.stringify(collaborationEvidence(p, new Date().toISOString()), null, 2),
        );
        await writeFile(
          test.info().outputPath("usage-and-failures.json"),
          JSON.stringify(
            {
              usage: usageEvidence(lastState, p),
              ...nativeCaptureBoundary(lastState, p),
              acceptedAt,
              nativeEndedAt,
              nativeTools,
              attempts: p.fusion?.attempts ?? null,
              attemptCoverage: p.fusion
                ? "Persisted application attempt records"
                : "No per-attempt ledger exposed; session usage and native events retained, do not claim full attempt accounting.",
              errors: p.events.filter((e) => e.type === "error"),
              errorCoverage:
                "Project error events exclude rejected native tool calls. See nativeTools for persisted isError tool results; recovered tool errors are still recorded.",
              failure,
              rendererErrors,
              interventions: interventionLog,
            },
            null,
            2,
          ),
        );
        for (const artifact of p.artifacts)
          await writeFile(test.info().outputPath(`artifact-${artifact.id}.md`), artifact.content);
      }
      const originalsUnchanged = await Promise.all(
        [...materials.original.sources, ...materials.original.datasets].map(async (item) => ({
          file: item.file,
          unchanged: researchHash(await readFile(item.file)) === item.sha256,
        })),
      );
      await writeFile(
        test.info().outputPath("run-outcome.json"),
        JSON.stringify(
          {
            ...preflight,
            endedAt: new Date().toISOString(),
            elapsedMs: Date.now() - Date.parse(beganAt),
            failure,
            profile,
            workspace,
            finalStatus: p?.status ?? "not-created",
            acceptedAt,
            nativeEndedAt,
            ...(p && lastState
              ? nativeCaptureBoundary(lastState, p)
              : { activeNativeAtCapture: null, usageFinality: { status: "unavailable" } }),
            teardownNotice:
              "Harness close occurs after evidence capture. Closing an active or unknown native request is cleanup, never evidence of successful natural completion.",
            empiricalStatus:
              goal === "design"
                ? "Not executed: design-only goal, empirical implementation awaits actual supplied data"
                : "See actual analysis records and independent review; completion is not publication or human acceptance",
            originalMaterials: originalsUnchanged,
            researchApprovalIdentity:
              "mentor Agent and reviewer Agent; no human research confirmation",
            independentContentReview: "pending; this harness cannot establish AC25 C or AC33 C",
            acceptedArtifactIds: p?.artifacts
              .filter((a) => a.verdict === "accept")
              .map((a) => a.id),
            finalPaper: p?.finalPaper,
            interventions: interventionLog,
          },
          null,
          2,
        ),
      );
      expect(originalsUnchanged.every((item) => item.unchanged)).toBe(true);
    } finally {
      await harness.close();
    }
  }
});
