import { expect, test } from "@playwright/test";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { researchTaskControlDecisionStatus } from "../../contracts/research-task-controls";
import {
  openResearchEvidence,
  readPinnedResearchFile,
  researchHash,
} from "../../electron/research-group/materials";
import { isCurrentResearchArtifact } from "../../electron/research-group/paper-pipeline";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
} from "../helpers/electron-app";
import {
  captureResearchNativeBoundary,
  researchNativeCallLedger,
} from "../helpers/research-live-evidence";

const CONDITION = "software-flow-final-material-scope";
const CONTINUE = "继续现有公开材料范围，不进行现场采集";
const SCOPE =
  "仅依据 UCI、DA2025、SMS2025 原文评估合成题干的材料与变量边界；最终裁定的材料范围交由一次新的局部决定选择，不采集、不计算、不投稿。";
const NOTICE =
  "automated-test-operator：这是已授权开发验收范围内的软件流程验证；自动化UI操作不是新增人类研究许可，不是伦理审批，也不证明方案学术质量。";
const BRIEF = `# 合成待审方案题干\n\n${NOTICE}\n\n拟讨论：仅根据已提供的 UCI 学生成绩说明及 DA2025、SMS2025 两篇原文，怎样限定一个关于学习支持与成绩关联的探索性问题？请指出变量时点、样本适用范围、缺勤窗口和零成绩处理有哪些证据边界。此题干不提供答案、事实结论、数据或旧研究成果。最终材料范围尚待本轮局部选项明确；现场采集和未提供的记录均不获本题干授权。\n`;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Read only this owned run's native session logs, never auth or unrelated profile files.
async function decisionToolEvidence(profile: string, project: ResearchProject) {
  const directory = join(profile, "agent", "sessions"),
    files = await readdir(directory, { recursive: true });
  return Promise.all(
    project.members
      .filter((member) => member.role !== "librarian")
      .map(async (member) => {
        const file = files.find((path) => path.endsWith(`_${member.ref.sessionId}.jsonl`));
        if (!file) throw new Error(`Missing native log for ${member.role}`);
        const calls: {
          id: string;
          operation: unknown;
          decision?: unknown;
          resultAt?: unknown;
          isError?: boolean;
          observedInputIds?: string[];
          observedDecisionIds?: string[];
        }[] = [];
        for (const line of (await readFile(join(directory, file), "utf8")).trim().split("\n")) {
          const entry = object(JSON.parse(line)),
            message = object(entry.message);
          const content = Array.isArray(message.content) ? message.content.map(object) : [];
          for (const part of content) {
            const args = object(part.arguments);
            if (
              part.type === "toolCall" &&
              part.name === "research_group" &&
              typeof part.id === "string" &&
              ["status", "request-decision"].includes(String(args.operation))
            )
              calls.push({
                id: part.id,
                operation: args.operation,
                ...(args.decision ? { decision: args.decision } : {}),
              });
          }
          if (message.role === "toolResult") {
            const call = calls.find((item) => item.id === message.toolCallId);
            if (call) {
              const text = content
                .filter((part) => typeof part.text === "string")
                .map((part) => part.text)
                .join("\n");
              Object.assign(call, {
                resultAt: entry.timestamp,
                isError: message.isError === true,
                observedInputIds: text.includes("inputHistory")
                  ? (project.inputHistory
                      ?.filter(
                        (input) => text.includes(input.id) && text.includes(input.source.kind),
                      )
                      .map((input) => input.id) ?? [])
                  : [],
                observedDecisionIds:
                  call.operation === "status"
                    ? (project.fusion?.decisions
                        .filter(
                          (decision) =>
                            text.includes(decision.id) && text.includes(decision.evidenceRef),
                        )
                        .map((decision) => decision.id) ?? [])
                    : [],
              });
            }
          }
        }
        return { role: member.role, calls };
      }),
  );
}

// R software-flow proof only: every provider call is real, every pending condition is model-created,
// and the sole answer is a labelled automated test operator action through the ordinary UI.
test("real providers preserve input provenance and continue after an explicit local scope choice", async () => {
  test.setTimeout(2_400_000); // Existing bounded S5 live ceiling; do not increase for a slow/failed run.
  const deadline = Date.now() + 2_100_000;
  const auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit real-auth opt-in required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must select the actual course library");
  const sourceDirectory =
    process.env.RESEARCH_DECISION_SOURCE_DIR ??
    resolve(__dirname, "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料");
  // The original manifest also lists a CSV. Inspect source descriptors only; never open that CSV.
  const manifest = object(
    JSON.parse(await readFile(join(sourceDirectory, "manifest.json"), "utf8")),
  );
  const originals = (Array.isArray(manifest.sources) ? manifest.sources.map(object) : []).filter(
    (source) => ["UCI", "DA2025", "SMS2025"].includes(String(source.id)),
  );
  expect(originals.map((source) => source.id).sort()).toEqual(["DA2025", "SMS2025", "UCI"]);
  const profile = await makeUserDataDir("research-decision-continuation-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-decision-continuation-live"),
    materials = join(workspace, "provided-originals");
  await mkdir(materials);
  const hashes: { id: string; file: string; sha256: string }[] = [];
  for (const source of originals) {
    expect(source.file).toBe(`${String(source.id)}.txt`);
    const file = join(sourceDirectory, String(source.file)),
      bytes = await readFile(file);
    hashes.push({ id: String(source.id), file, sha256: researchHash(bytes) });
    await writeFile(join(materials, String(source.file)), bytes, { flag: "wx" });
  }
  await writeFile(join(materials, "synthetic-task-brief.md"), BRIEF, { flag: "wx" });
  await writeFile(
    join(materials, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        sources: [
          ...originals,
          {
            id: "SYNTHETIC-TASK-BRIEF",
            title: "软件流程验收的合成待审题干（非研究成果）",
            authors: "automated-test-operator",
            year: "2026",
            url: "urn:lancer:software-flow:decision-continuation",
            kind: "design",
            file: "synthetic-task-brief.md",
          },
        ],
        datasets: [],
      },
      null,
      2,
    ),
  );
  const evidence = await openResearchEvidence(materials);
  expect(evidence.datasets).toEqual([]);
  for (const source of evidence.sources) await readPinnedResearchFile(source);
  const plan = {
    beganAt: new Date().toISOString(),
    identity: "automated-test-operator",
    notice: NOTICE,
    profile,
    workspace,
    sourceDirectory,
    originalHashes: hashes,
    sourceKinds: {
      researchEvidence: ["UCI", "DA2025", "SMS2025"],
      syntheticTaskInput: "SYNTHETIC-TASK-BRIEF",
    },
    scope: SCOPE,
    route: "task/design-review, S5 only, lead/reviewer/mentor",
    targetDuration: "3–5 minutes aspirational; actual timings retained, no timeout increase",
    memberTokenBudget: 8_000_000,
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
      librarian: "retained idle",
    },
    answerLabel: CONTINUE,
    noDataOrOldDrafts: true,
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
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
    waitingAt: string | undefined,
    answeredAt: string | undefined,
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
    await editor.getByLabel("研究入口", { exact: true }).selectOption("task");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("task");
    await editor.getByLabel("单项任务类型", { exact: true }).selectOption("design-review");
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
    const prompt = `${NOTICE}\n这是新的短任务，不是旧稿修订。研究证据仅UCI、DA2025、SMS2025；SYNTHETIC-TASK-BRIEF只是明确标注的合成题干，不是研究结论。${SCOPE}\n初始范围允许A/B读取三原文并评估合成题干，没有数据、现场采集、联网、投稿或伦理审批授权。各角色第一步实际调用status，检查真实inputHistory原文/来源和已有条件；不能把原输入转成confirmed答复，也不要重复询问已经明确允许的公开原文核查。先实际source-read三原文和题干，输出保持简短：A初稿/修订各约400字，B批评/复核各约200字，导师裁定约200字。核对研究问题、G1/G2/G3时点与未知评分构成、两学科样本、缺勤窗口与零成绩；不生成统计数值、不补造事实。\n导师在读取status后立即提出一个新的局部材料范围决定：最终裁定是否只涵盖当前三公开原文，排除现场采集/未提供材料？这不是再次询问原文读取权限。用真实request-decision，conditionId=${CONDITION}，taskIds只包含status中本轮design导师自己的实际taskId；不要阻塞A/B。options严格两项：id=public-only,label=${CONTINUE},outcome=confirmed,consequence=只解除导师最终材料范围条件，不授权现场采集；id=defer,label=暂缓最终范围裁定,outcome=deferred,consequence=导师继续等待。recommendedOptionId=public-only。context和impact明确${NOTICE}。请求后本轮导师立即结束，不发表最终裁定，不循环轮询，不代答，不把推荐或等待当同意。若恢复后status已有这个condition及实际答复，沿用其真实记录，不换conditionId重问。\nA/B不等待导师新条件：实际读取原文后正常初稿→B批评→A修订→B实际读取修订并复核，refs引用实际read过的成果，sourceIds引用实际source-read过的来源。B只核查A已有文字，不扩题。未答期间允许这些无关成果继续产生。测试操作者稍后会经真实UI选择上述public-only选项；这句话仅说明测试安排，绝不是预先答复。导师只有宿主记录实际选择后才读取最新A修订/B复核并作有边界的最终裁定；不冒称人类许可或伦理批准。\n不联网，不source-search/source-fetch，不analyze，不bash/外部命令，不读CSV/旧稿；只在S5完成。所有参与者保持实际工具/产出证据；模型accept不等于独立学术验收。`;
    await writeFile(test.info().outputPath("initial-instruction.txt"), prompt);
    await page.getByLabel("New thread prompt").fill(prompt);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    const current = async () => {
      lastState = await getDesktopState(page);
      return lastState.researchGroups?.projects[0];
    };
    const pending = (p: ResearchProject) =>
      p.fusion?.decisionRequests?.filter(
        (request) => researchTaskControlDecisionStatus(p.fusion!, request.id) === "pending",
      ) ?? [];
    const poll = async (check: () => Promise<boolean>) =>
      expect
        .poll(check, { timeout: Math.max(1, deadline - Date.now()), intervals: [1000, 3000] })
        .toBe(true);
    await poll(async () => {
      const p = await current();
      if (!p) return false;
      if (lastState?.researchGroups?.error || p.status === "paused")
        throw new Error(lastState?.researchGroups?.error ?? p.error ?? "Unexpected pause");
      const requests = p.fusion?.decisionRequests ?? [];
      if (
        requests.length > 1 ||
        requests.some((request) => request.inputId !== `human-condition:${CONDITION}`)
      )
        throw new Error("Unexpected/repeated scope request; preserve evidence, do not auto-answer");
      if (p.fusion?.decisions.length)
        throw new Error("A decision appeared before the test operator's UI action");
      const request = pending(p)[0];
      if (!request) {
        if (p.status === "completed")
          throw new Error("Completed without the required real local condition");
        return false;
      }
      expect(request.requestedBy).toBe("agent:mentor");
      const mentorTask = p.fusion!.tasks.find(
        (task) => task.role === "mentor" && task.stage === "design",
      )!;
      expect(request.taskIds).toEqual([mentorTask.id]);
      expect(request.affectedTaskIds).toEqual([mentorTask.id]);
      // Observable barrier: unrelated post-request A/B artifacts and all old native runs ended.
      return (
        ["lead", "reviewer"].every((role) =>
          p.artifacts.some(
            (artifact) => artifact.role === role && artifact.createdAt >= request.at,
          ),
        ) &&
        p.artifacts.some((artifact) => artifact.kind === "stage-verification") &&
        captureResearchNativeBoundary(lastState!, p).activeNativeAtCapture.length === 0
      );
    });
    const waiting = (await current())!,
      request = pending(waiting)[0]!;
    waitingAt = new Date().toISOString();
    expect(waiting.inputHistory).toHaveLength(1);
    expect(waiting.inputHistory![0]).toMatchObject({
      text: prompt,
      source: { kind: "explicit-submit" },
    });
    expect(waiting.fusion!.decisions).toEqual([]);
    expect(
      waiting.artifacts.some(
        (artifact) =>
          artifact.kind === "stage-review" &&
          artifact.verdict === "accept" &&
          isCurrentResearchArtifact(waiting, artifact),
      ),
    ).toBe(false);
    await writeFile(
      test.info().outputPath("unanswered-waiting-snapshot.json"),
      JSON.stringify(
        {
          identity: "automated-test-operator",
          notice: NOTICE,
          capturedAt: waitingAt,
          project: waiting,
          ...captureResearchNativeBoundary(lastState!, waiting),
        },
        null,
        2,
      ),
    );
    const toolEvidence = await decisionToolEvidence(profile, waiting);
    for (const member of toolEvidence)
      expect(
        member.calls.some(
          (call) =>
            call.operation === "status" &&
            !call.isError &&
            call.observedInputIds?.includes(waiting.inputHistory![0]!.id),
        ),
      ).toBe(true);
    expect(
      toolEvidence.flatMap((member) =>
        member.calls.filter((call) => call.operation === "request-decision" && !call.isError),
      ),
    ).toHaveLength(1);
    const mentorCalls = toolEvidence.find((member) => member.role === "mentor")!.calls;
    expect(
      mentorCalls.findIndex(
        (call) =>
          call.operation === "status" &&
          call.observedInputIds?.includes(waiting.inputHistory![0]!.id),
      ),
    ).toBeLessThan(mentorCalls.findIndex((call) => call.operation === "request-decision"));
    const controls = page.getByTestId("research-task-controls");
    await controls.locator(":scope > summary").click();
    const card = controls.locator(`[data-decision-id="${request.id}"]`);
    await card.locator(":scope > summary").click();
    await expect(card.getByLabel("我的选择", { exact: true })).toHaveValue("");
    await page.screenshot({ path: test.info().outputPath("unanswered-waiting.png") });
    const option = request.options.find((item) => item.id === "public-only");
    expect(option).toMatchObject({ label: CONTINUE, outcome: "confirmed" });
    await card.getByLabel("我的选择", { exact: true }).selectOption("public-only");
    await card
      .getByLabel("补充说明（选填）")
      .fill(`${NOTICE} 本次只选择现有公开材料范围；不新增材料、不现场采集。`);
    expect((await current())!.fusion!.decisions).toEqual([]);
    answeredAt = new Date().toISOString();
    await card.getByRole("button", { name: "提交我的决定", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await current())!.fusion!.decisions.filter(
            (decision) => decision.requestId === request.id,
          ).length,
      )
      .toBe(1);
    await poll(async () => {
      const p = (await current())!;
      if (pending(p).length || p.fusion!.decisionRequests!.length !== 1)
        throw new Error("A scope question remains or was repeated after explicit answer");
      if (lastState?.researchGroups?.error || ["paused", "needs-decision"].includes(p.status))
        throw new Error(lastState?.researchGroups?.error ?? p.error ?? p.status);
      if (
        p.status !== "completed" ||
        captureResearchNativeBoundary(lastState!, p).activeNativeAtCapture.length
      )
        return false;
      nativeEndedAt = new Date().toISOString();
      return true;
    });
    const final = (await current())!,
      answer = final.fusion!.decisions.find((decision) => decision.requestId === request.id)!;
    expect(answer).toMatchObject({
      actor: "user",
      origin: "new-reply",
      optionId: "public-only",
      outcome: "confirmed",
    });
    expect(answer.text).toContain("automated-test-operator");
    expect(answer.evidenceRef).toBe(`user-action:${answer.id}`);
    expect(final.inputHistory).toEqual(waiting.inputHistory);
    const finalDecisionTools = await decisionToolEvidence(profile, final);
    expect(
      finalDecisionTools.flatMap((member) =>
        member.calls.filter((call) => call.operation === "request-decision"),
      ),
    ).toHaveLength(1);
    expect(
      finalDecisionTools
        .find((member) => member.role === "mentor")!
        .calls.some(
          (call) =>
            call.operation === "status" &&
            !call.isError &&
            call.observedDecisionIds?.includes(answer.id),
        ),
    ).toBe(true);
    expect(final.memberTokenBudget).toBe(8_000_000);
    expect(researchExecutionRoute(final).stageIds).toEqual(["design"]);
    expect(researchExecutionRoute(final).requiredRoles).toEqual(["lead", "reviewer", "mentor"]);
    expect(final.evidence!.datasets).toEqual([]);
    expect(final.analyses ?? []).toEqual([]);
    expect(final.fusion!.attempts.every((attempt) => attempt.state === "succeeded")).toBe(true);
    expect(
      final.events.some((event) => event.role === "librarian" && event.type === "started"),
    ).toBe(false);
    for (const role of ["lead", "reviewer", "mentor"])
      for (const source of hashes)
        expect(
          final.events.some(
            (event) =>
              event.type === "source-read" &&
              event.role === role &&
              event.sourceId === source.id &&
              event.sourceSha256 === source.sha256,
          ),
        ).toBe(true);
    for (const artifact of final.artifacts)
      expect(artifact.model).toEqual(
        final.stages!.find((stage) => stage.id === artifact.stage)!.models[artifact.role],
      );
    expect(
      final.artifacts.some(
        (artifact) =>
          artifact.kind === "stage-review" &&
          artifact.verdict === "accept" &&
          artifact.createdAt >= answer.at,
      ),
    ).toBe(true);
    for (const artifact of waiting.artifacts)
      expect(final.artifacts.find((item) => item.id === artifact.id)).toEqual(artifact);
    for (const task of waiting.fusion!.tasks.filter((task) => task.role !== "mentor"))
      expect(final.fusion!.tasks.find((item) => item.id === task.id)!.inputVersion).toBe(
        task.inputVersion,
      );
    const finalReview = final.artifacts
      .filter(
        (artifact) =>
          artifact.kind === "stage-review" && isCurrentResearchArtifact(final, artifact),
      )
      .at(-1)!;
    for (const kind of ["stage-revision", "stage-verification"]) {
      const referred = final.artifacts.find(
        (artifact) => artifact.kind === kind && finalReview.refs.includes(artifact.id),
      );
      expect(referred).toBeTruthy();
      expect(
        final.events.some(
          (event) =>
            event.type === "read" && event.role === "mentor" && event.artifactId === referred!.id,
        ),
      ).toBe(true);
    }
    const ledger = await researchNativeCallLedger(profile, final);
    expect(
      ledger
        .flatMap((member) => member.calls)
        .filter(
          (call) =>
            call.name !== "research_group" ||
            ["source-search", "source-fetch", "analyze"].includes(String(call.operation)),
        ),
    ).toEqual([]);
    expect(rendererErrors).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("decision-continuation-native-ended.png"),
    });
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
        hashes.map(async (source) => ({
          ...source,
          unchanged: researchHash(await readFile(source.file)) === source.sha256,
        })),
      );
      const copiedIntegrity = await Promise.all(
        evidence.sources.map(async (source) => ({
          id: source.id,
          unchanged: researchHash(await readFile(source.file)) === source.sha256,
        })),
      );
      if (project) {
        await writeFile(
          test.info().outputPath("research-project.json"),
          JSON.stringify(project, null, 2),
        );
        for (const artifact of project.artifacts)
          await writeFile(test.info().outputPath(`artifact-${artifact.id}.md`), artifact.content);
        await writeFile(
          test.info().outputPath("native-tools-and-decisions.json"),
          JSON.stringify(
            {
              notice: NOTICE,
              nativeTools: await researchNativeCallLedger(profile, project).catch(
                (error: unknown) => ({ incomplete: String(error) }),
              ),
              decisionTools: await decisionToolEvidence(profile, project).catch(
                (error: unknown) => ({ incomplete: String(error) }),
              ),
              inputHistory: project.inputHistory,
              requests: project.fusion?.decisionRequests,
              decisions: project.fusion?.decisions,
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
            waitingAt,
            answeredAt,
            nativeEndedAt,
            failure,
            finalStatus: project?.status ?? "not-created",
            originalIntegrity,
            copiedIntegrity,
            ...(project && lastState ? captureResearchNativeBoundary(lastState, project) : {}),
            contentReview:
              "Not independently reviewed; software-flow R does not establish research correctness or human permission",
            teardownNotice:
              "Closing an unfinished native request after failure is cleanup, not successful natural completion",
          },
          null,
          2,
        ),
      );
      expect(originalIntegrity.every((source) => source.unchanged)).toBe(true);
      expect(copiedIntegrity.every((source) => source.unchanged)).toBe(true);
    } finally {
      await harness.close();
    }
  }
});
