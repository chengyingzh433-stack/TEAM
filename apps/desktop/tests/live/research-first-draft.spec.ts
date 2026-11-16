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

const NOTICE =
  "automated-test-operator：AC27真实提供商的软件流程验收，仅S1研究问题卡；来源是实际提供的UCI官方说明副本。模型审阅属于R证据，实质合格与推断边界仍须独立C审查，不代表人类确认或伦理审批。";
const SCOPE =
  "围绕UCI Student Performance中葡萄牙两所学校历史数学课程的G1/G2与G3，提出一个仅涉及观察关联的低风险问题卡。本轮不读取CSV、不计算结果、不声称因果、全国推广、创新性已获证实、已采集或已完成分析，止于S1问题卡。";
const FORBIDDEN_OPERATIONS = new Set([
  "source-search",
  "source-fetch",
  "literature-search",
  "literature-fetch",
  "analyze",
  "register-analysis",
  "run-analysis",
  "request-decision",
]);
const PROMPT = `${NOTICE}\n${SCOPE}
publish 的 refs 只填本人 read 过的本轮成果 artifactId（由 status.artifacts 返回）；首次发稿没有这种成果时 refs=[]。UCI 只能填 sourceIds=["UCI"]；method-package及知识块ID只在正文说明，绝不能放进refs。原始来源与方法依据不是协作成果ID。
共同输入只有本轮提供的UCI原文和固定课程方法库；范围由测试操作者限定，具体变量定义、可回答问题、竞争解释和证据边界须各自实际阅读后判断。不要把本指令当作A的初判，也不能先给B看A的答案。数据说明不是本轮计算，不把页面总样本数直接当数学课程有效样本量；不把已有说明中的关系说成本轮发现。问题卡不要求确立研究创新或执行后续研究，现实材料关口留到相应阶段。
A/B各先status/inputs，source-read UCI从0按真实nextOffset读完本轮所供文本，并各自method-package取得本任务必要的少量课程依据。在本人的独立稿发布前，不read对方任何本阶段成果，不取对方私有方法应用/图像观察，不接收对方问题答案。共同课程正文、原始来源与资料员的纯原文定位可以共同阅读。A据此自行写约400–600字stage-draft问题卡；B据同一原文独立写约250–400字stage-risk，明确自己核对的定义、范围、可答条件和局限，不能用A的文字代替独立判断。均附sourceIds=["UCI"]及真实读取的refs。
资料员只需本人实际读UCI必要原文、取得本任务必要课程包，发布一份约150字stage-material，提供共同原文定位和读取边界即可，不提供A/B问题答案、不新增资料、不凑第二批材料或资料配额。发布后自然结束，不轮询。A/B不必等待该材料才读取UCI原文。
方法记录须完成当前真实门禁。A实际采用的每个包均本人读取必要图片：method-read-image后用本次receiptId逐图method-image-reading，记录具体可见内容与看不清的边界；然后method-apply写清实际方法选择、怎样限定所提交的首稿、未适用条件和局限，scoringClaim=not-scored。为让交接时依据齐备，先完成对应首稿的方法应用，再publish唯一stage-draft；方法ID不等于已应用。A发布首稿后结束当次回复等自动交接，不自行修订，也不循环status等待B。
B先发布独立stage-risk，再实际read A首稿。随后取得A实际采用的同版method-package(packageId)，本人读取必要图片并提交实际观察；method-check实际applicationId，method-opinion给出具体内容意见。若确实无需修改，可以有理由支持并直接publish stage-verification，refs包含真实首稿id，verdict=accept；理由须说明原文位置、变量定义、问题与证据的对应、竞争解释及推断/未执行边界。不要为流程凑stage-critique或stage-revision。若存在实质问题，必须保留有依据的revise/hold或stage-critique；该情况会使本次首稿直接通过验收失败，不能为了测试通过压下问题或伪造support。
导师初次准备后若内部交付未齐就结束回复等自动交接；最终本人source-read UCI完整所供文本，实际read A首稿和B stage-verification，取得A所用同版课程包，本人读取必要图片并记录观察，method-adjudicate引用真实B意见且说明自己的依据，再method-check，最后publish stage-review，refs包含首稿与B复核；确实合格才accept，明确这是导师Agent针对S1问题卡的有限意见。程序完整性、B内容意见、导师模型裁定分别保留，不能把程序通过当内容认证。
只用research_group工具；不联网、不source-search/source-fetch/literature-search/literature-fetch，不analyze/register-analysis/run-analysis，不bash或读取其他文件/旧稿/旧R或C证据，不另起模型循环。工具ID和位置只取实际返回，refs/sourceIds只列本人实际读取对象。必要内部审阅不重复请求人的确认；若真有依赖人的未授权条件则如实request-decision并结束，不自行答复。任何工具错误如实保留并停止当前工作，不反复试错或把失败说成成功。正式publish当前交付后自然结束回复；收到已完成任务的资料通知不重发成果，系统会安排所需后续交接。`;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface NativeCall {
  id: string;
  name: unknown;
  args: Record<string, unknown>;
  at: unknown;
  entryIndex: number;
  resultAt?: unknown;
  isError?: boolean;
  resultText?: string;
}

// Read only this new isolated profile's session logs, never auth or earlier R/C outputs.
// During execution a session may not exist yet, and only newline-committed JSONL is inspected.
// The final capture is strict and retains the full actual input/output records for independent C.
async function nativeFirstDraftEvidence(
  profile: string,
  project: ResearchProject,
  settled = false,
) {
  const directory = join(profile, "agent", "sessions");
  const files = await readdir(directory, { recursive: true }).catch((error: unknown) => {
    if (!settled && object(error).code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(
    project.members.map(async (member) => {
      const file = files.find((path) => path.endsWith(`_${member.ref.sessionId}.jsonl`));
      if (!file && settled) throw new Error(`Missing final native log for ${member.role}`);
      const entries: Record<string, unknown>[] = [],
        calls: NativeCall[] = [];
      if (file) {
        const lines = (await readFile(join(directory, file), "utf8")).split("\n");
        if (!settled) lines.pop();
        for (const line of lines.filter((line) => line.trim())) {
          const entry = object(JSON.parse(line)),
            message = object(entry.message),
            content = Array.isArray(message.content) ? message.content.map(object) : [];
          entries.push(entry);
          for (const part of content)
            if (part.type === "toolCall" && typeof part.id === "string")
              calls.push({
                id: part.id,
                name: part.name,
                args: object(part.arguments),
                at: entry.timestamp,
                entryIndex: entries.length - 1,
              });
          if (message.role === "toolResult") {
            const call = calls.find((item) => item.id === message.toolCallId);
            if (call)
              Object.assign(call, {
                resultAt: entry.timestamp,
                isError: message.isError === true,
                resultText: content
                  .filter((part) => typeof part.text === "string")
                  .map((part) => String(part.text))
                  .join("\n"),
              });
          }
        }
      }
      return { role: member.role, ref: member.ref, file: file ?? null, calls, entries };
    }),
  );
}

// Explicitly bounded R exercise: no seeded artifacts/events/verdicts and no provider retry.
test.describe.configure({ retries: 0 });
test("real independent S1 judgments accept a qualified first draft without critique or revision", async () => {
  test.setTimeout(1_200_000);
  const beganAt = new Date().toISOString(),
    deadline = Date.now() + 900_000,
    auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit real-provider authentication required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must select the actual course library");
  if (process.env.RESEARCH_MEMBER_TOKEN_BUDGET !== undefined)
    expect(Number(process.env.RESEARCH_MEMBER_TOKEN_BUDGET)).toBe(8_000_000);
  const knowledge = await ResearchKnowledge.open(knowledgeDir),
    sourceDirectory =
      process.env.RESEARCH_FIRST_DRAFT_SOURCE_DIR ??
      resolve(__dirname, "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料"),
    manifestPath = join(sourceDirectory, "manifest.json"),
    manifestBytes = await readFile(manifestPath),
    manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  // Inspect descriptors only. No CSV, other paper, prior answer or acceptance evidence is opened.
  const originals = (Array.isArray(manifest.sources) ? manifest.sources.map(object) : []).filter(
    (source) => source.id === "UCI",
  );
  expect(originals).toHaveLength(1);
  const originalSource = originals[0]!;
  expect(originalSource).toMatchObject({
    id: "UCI",
    file: "UCI.txt",
    kind: "dataset",
    url: "https://archive.ics.uci.edu/dataset/320/student-performance",
  });
  const originalFile = join(sourceDirectory, "UCI.txt"),
    originalBytes = await readFile(originalFile),
    sourceSha256 = researchHash(originalBytes),
    originalTextLength = originalBytes.toString("utf8").length,
    profile = await makeUserDataDir("research-first-draft-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-first-draft-live"),
    materials = join(workspace, "provided-original-source");
  await mkdir(materials);
  await writeFile(join(materials, "UCI.txt"), originalBytes, { flag: "wx" });
  const providedManifest = {
    version: 1,
    sources: [{ ...originalSource, textScope: "full-text" }],
    datasets: [],
  };
  await writeFile(join(materials, "manifest.json"), JSON.stringify(providedManifest, null, 2), {
    flag: "wx",
  });
  const evidence = await openResearchEvidence(materials);
  expect(evidence.sources).toHaveLength(1);
  expect(evidence.sources[0]!.sha256).toBe(sourceSha256);
  expect(evidence.datasets).toEqual([]);
  const plan = {
    beganAt,
    notice: NOTICE,
    scope: SCOPE,
    profile,
    workspace,
    materials,
    sourceDirectory,
    originalManifestSha256: researchHash(manifestBytes),
    originalSource: { ...originalSource, file: originalFile, sha256: sourceSha256 },
    sourceBytes: originalBytes.length,
    sourceUtf16Length: originalTextLength,
    providedManifest,
    knowledgePin: knowledge.pin,
    route: { entry: "idea", goal: "question", stageIds: ["question"] },
    memberTokenBudget: 8_000_000,
    executionDeadlineMs: 900_000,
    retries: 0,
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
      librarian: "openai-codex/gpt-6.1-sol low",
    },
    contentBoundary:
      "Original source only; no supplied answer, CSV, calculation, causal claim, nationwide inference or certified novelty. R judgments await independent C.",
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
  const rendererErrors: string[] = [];
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
    await editor.getByLabel("研究入口", { exact: true }).selectOption("idea");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("question");
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
          const p = lastState.researchGroups?.projects[0];
          if (rendererErrors.length)
            throw new Error(`Renderer error: ${rendererErrors.join("; ")}`);
          if (lastState.researchGroups?.error) throw new Error(lastState.researchGroups.error);
          if (!p) return false;
          const failed = p.fusion?.attempts.filter((a) =>
            ["failed", "unknown", "cancelled"].includes(a.state),
          );
          if (
            p.error ||
            ["paused", "needs-decision"].includes(p.status) ||
            failed?.length ||
            p.fusion?.tasks.some((task) => ["failed", "waiting-user"].includes(task.state)) ||
            p.fusion?.decisionRequests?.length
          )
            throw new Error(
              JSON.stringify({
                error: p.error,
                status: p.status,
                failed,
                decisionRequests: p.fusion?.decisionRequests,
              }),
            );
          const contrary = p.artifacts.find(
            (a) =>
              ["stage-critique", "stage-revision"].includes(a.kind) ||
              (["stage-verification", "stage-review"].includes(a.kind) && a.verdict !== "accept"),
          );
          if (contrary)
            throw new Error(
              `First-draft direct acceptance not established: ${contrary.kind}/${contrary.verdict ?? "substantive critique"}; preserve the actual judgment for C.`,
            );
          const native = await nativeFirstDraftEvidence(profile, p);
          const errors = native.flatMap((member) =>
            member.calls
              .filter(
                (call) =>
                  call.isError ||
                  call.name !== "research_group" ||
                  FORBIDDEN_OPERATIONS.has(String(call.args.operation)),
              )
              .map((call) => ({ role: member.role, ...call })),
          );
          if (errors.length)
            throw new Error(
              `Actual native tool error or out-of-scope call: ${JSON.stringify(errors)}`,
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
      native = await nativeFirstDraftEvidence(profile, p, true),
      current = p.artifacts.filter((artifact) => isCurrentResearchArtifact(p, artifact));
    expect(researchExecutionRoute(p).stageIds).toEqual(["question"]);
    expect(researchExecutionRoute(p).requiredRoles).toEqual([...RESEARCH_ROLES]);
    expect(p.entry).toBe("idea");
    expect(p.goal).toBe("question");
    expect(p.memberTokenBudget).toBe(8_000_000);
    expect(p.evidence!.sources.map((source) => source.id)).toEqual(["UCI"]);
    expect(p.evidence!.datasets).toEqual([]);
    expect(p.analyses ?? []).toEqual([]);
    expect(p.analysisRegistry?.plans ?? []).toEqual([]);
    expect(p.analysisRegistry?.runs ?? []).toEqual([]);
    expect(p.fusion!.attempts.every((attempt) => attempt.state === "succeeded")).toBe(true);
    for (const attempt of p.fusion!.attempts) {
      const task = p.fusion!.tasks.find((task) => task.id === attempt.taskId)!,
        member = p.members.find((member) => member.role === task.role)!;
      expect(attempt.model).toEqual(
        p.stages!.find((stage) => stage.id === "question")!.models[member.role],
      );
      expect(attempt.nativeRunId).toBeTruthy();
      for (const type of ["started", "finished"] as const)
        expect(
          p.events.some((event) => event.type === type && event.runId === attempt.nativeRunId),
        ).toBe(true);
    }
    expect(p.artifacts.every((artifact) => artifact.stage === "question")).toBe(true);
    expect(current.filter((a) => a.kind === "stage-draft")).toHaveLength(1);
    expect(current.filter((a) => a.kind === "stage-risk")).toHaveLength(1);
    expect(current.filter((a) => a.kind === "stage-verification")).toHaveLength(1);
    expect(current.filter((a) => a.kind === "stage-review")).toHaveLength(1);
    expect(current.filter((a) => a.kind === "stage-material")).toHaveLength(1);
    expect(
      p.artifacts.filter((a) => ["stage-critique", "stage-revision"].includes(a.kind)),
    ).toEqual([]);
    const draft = current.find((a) => a.kind === "stage-draft")!,
      risk = current.find((a) => a.kind === "stage-risk")!,
      verification = current.find((a) => a.kind === "stage-verification")!,
      review = current.find((a) => a.kind === "stage-review")!;
    expect(verification.verdict).toBe("accept");
    expect(verification.refs).toContain(draft.id);
    expect(review.verdict).toBe("accept");
    expect(review.refs).toEqual(expect.arrayContaining([draft.id, verification.id]));
    // Topic/rationale presence only; the independent C review decides their substantive accuracy.
    for (const artifact of [draft, risk, verification])
      for (const variable of ["G1", "G2", "G3"]) expect(artifact.content).toContain(variable);
    expect(verification.content).toContain("UCI");
    for (const artifact of p.artifacts) {
      expect(artifact.model).toEqual(
        p.stages!.find((stage) => stage.id === "question")!.models[artifact.role],
      );
      const member = native.find((member) => member.role === artifact.role)!;
      expect(
        member.calls.some(
          (call) =>
            call.id === artifact.toolCallId &&
            call.name === "research_group" &&
            call.args.operation === "publish" &&
            call.args.kind === artifact.kind &&
            call.args.content === artifact.content &&
            call.resultAt &&
            !call.isError,
        ),
      ).toBe(true);
    }
    const independence = [];
    for (const [role, initial, peer] of [
      ["lead", draft, risk],
      ["reviewer", risk, draft],
    ] as const) {
      const member = native.find((member) => member.role === role)!,
        publication = member.calls.find((call) => call.id === initial.toolCallId)!,
        graphArtifact = p.fusion!.artifacts.find((artifact) => artifact.id === initial.id)!,
        peerApplications = (p.methodApplications ?? [])
          .filter((application) => application.actor.id === `model:${peer.role}`)
          .map((application) => application.id);
      expect(initial.sourceIds).toContain("UCI");
      expect(initial.refs).not.toContain(peer.id);
      expect(graphArtifact.dependencyArtifactIds).not.toContain(peer.id);
      expect(
        p.events.filter(
          (event) =>
            event.type === "read" &&
            event.role === role &&
            event.at <= initial.createdAt &&
            p.artifacts.some(
              (artifact) => artifact.id === event.artifactId && artifact.role === peer.role,
            ),
        ),
      ).toEqual([]);
      expect(
        p.events.filter(
          (event) =>
            event.type === "message" &&
            event.role === peer.role &&
            event.to === role &&
            event.at <= initial.createdAt,
        ),
      ).toEqual([]);
      const inputs = member.entries
        .slice(0, publication.entryIndex)
        .filter((entry) => ["user", "toolResult"].includes(String(object(entry.message).role)));
      const inputText = inputs
        .flatMap((entry) => {
          const content = object(entry.message).content;
          return typeof content === "string"
            ? [content]
            : Array.isArray(content)
              ? content.map(object).map((part) => String(part.text ?? ""))
              : [];
        })
        .join("\n");
      for (const body of [peer.content, JSON.stringify(peer.content).slice(1, -1)])
        expect(inputText).not.toContain(body);
      expect(
        member.calls.filter(
          (call) =>
            call.entryIndex < publication.entryIndex &&
            ["method-check", "method-opinion"].includes(String(call.args.operation)) &&
            peerApplications.includes(String(call.args.applicationId)),
        ),
      ).toEqual([]);
      independence.push({ role, artifactId: initial.id, graphArtifact, publication, inputs });
    }
    // Full coverage is of the supplied official-description text, not the dataset or cited paper.
    for (const [role, cutoff] of [
      ["lead", draft.createdAt],
      ["reviewer", risk.createdAt],
      ["mentor", review.createdAt],
    ] as const) {
      const member = p.members.find((member) => member.role === role)!,
        reads = (p.sourceReads ?? [])
          .filter((read) => read.sessionId === member.ref.sessionId && read.at <= cutoff)
          .sort((a, b) => a.start - b.start);
      let covered = 0;
      for (const read of reads) {
        expect(read.sourceId).toBe("UCI");
        expect(read.sourceSha256).toBe(sourceSha256);
        expect(read.depth).toBe("full-text");
        expect(read.start).toBeLessThanOrEqual(covered);
        covered = Math.max(covered, read.end);
      }
      expect(covered).toBe(originalTextLength);
    }
    for (const [role, artifact, before] of [
      ["reviewer", draft, verification.createdAt],
      ["mentor", draft, review.createdAt],
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
    const leadUses = p.methodPackageUses!.filter((use) => use.role === "lead");
    expect(leadUses.length).toBeGreaterThan(0);
    for (const use of leadUses) {
      const application = p.methodApplications!.find(
        (application) =>
          application.taskId === use.taskId && application.packageId === use.packageId,
      )!;
      expect(application).toBeTruthy();
      expect(application.actor.id).toBe("model:lead");
      expect(application.scoringClaim).toBe("not-scored");
      const opinion = p.methodContentOpinions!.find(
        (opinion) => opinion.applicationId === application.id,
      )!;
      expect(opinion).toMatchObject({
        verdict: "support",
        actor: { id: "model:reviewer", kind: "model" },
      });
      const adjudication = p.methodAdjudications!.find(
        (adjudication) => adjudication.applicationId === application.id,
      )!;
      expect(adjudication).toMatchObject({
        verdict: "accept",
        actor: { id: "model:mentor", kind: "model" },
      });
      expect(adjudication.opinionIds).toContain(opinion.id);
    }
    for (const role of ["reviewer", "mentor"] as const)
      expect(
        p.methodProgramChecks!.some(
          (check) =>
            check.role === role &&
            check.result === "passed-at-snapshot" &&
            check.target?.artifactId === draft.id &&
            check.target.bodySha256 === researchHash(draft.content) &&
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
            FORBIDDEN_OPERATIONS.has(String(call.operation)) ||
            call.isError ||
            !call.resultAt,
        ),
    ).toEqual([]);
    await writeFile(
      test.info().outputPath("independence-inputs.json"),
      JSON.stringify(independence, null, 2),
    );
    await page.screenshot({ path: test.info().outputPath("first-draft-native-ended.png") });
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
            evidenceFailures.push(`Final state capture: ${String(error)}`);
            return lastState;
          });
      const project = lastState?.researchGroups?.projects[0];
      await writeFile(
        test.info().outputPath("research-project.json"),
        JSON.stringify(project ?? null, null, 2),
      );
      const integrity = Object.fromEntries<boolean>(
        await Promise.all(
          [
            ["originalSourceUnchanged", originalFile, sourceSha256],
            ["copiedSourceUnchanged", join(materials, "UCI.txt"), sourceSha256],
            ["originalManifestUnchanged", manifestPath, researchHash(manifestBytes)],
            [
              "providedManifestUnchanged",
              join(materials, "manifest.json"),
              researchHash(JSON.stringify(providedManifest, null, 2)),
            ],
            [
              "knowledgeIndexUnchanged",
              join(knowledgeDir, "索引", "知识块.jsonl"),
              knowledge.pin.sha256,
            ],
          ].map(
            async ([label, file, expected]) =>
              [
                label!,
                await readFile(file!)
                  .then((bytes) => researchHash(bytes) === expected)
                  .catch((error: unknown) => {
                    evidenceFailures.push(`${label}: ${String(error)}`);
                    return false;
                  }),
              ] as const,
          ),
        ),
      );
      if (Object.values(integrity).some((unchanged) => !unchanged))
        evidenceFailures.push(
          "Original source, manifest, supplied copy or knowledge index changed",
        );
      const native = project
        ? await nativeFirstDraftEvidence(profile, project, !!nativeEndedAt).catch(
            (error: unknown) => {
              evidenceFailures.push(`Native evidence capture: ${String(error)}`);
              return null;
            },
          )
        : null;
      const boundary =
        project && lastState ? captureResearchNativeBoundary(lastState, project) : null;
      if (project)
        for (const artifact of project.artifacts)
          await writeFile(test.info().outputPath(`artifact-${artifact.id}.md`), artifact.content);
      await writeFile(
        test.info().outputPath("first-draft-proof.json"),
        JSON.stringify(
          {
            notice: NOTICE,
            assertionFailure: failure ?? null,
            projectSnapshotFile: "research-project.json",
            events: project?.events ?? [],
            sourceReads: project?.sourceReads ?? [],
            methodApplications: project?.methodApplications ?? [],
            methodContentOpinions: project?.methodContentOpinions ?? [],
            methodAdjudications: project?.methodAdjudications ?? [],
            methodProgramChecks: project?.methodProgramChecks ?? [],
            native,
            nativeCaptureMode: nativeEndedAt
              ? "strict-natural-end"
              : "available-records-before-teardown",
            boundary,
            evidenceFailures,
            contentReview:
              "Not independently reviewed. Exact initial inputs, actual tool arguments/results and first-draft judgments are preserved for separate C; structural assertions do not certify semantic quality.",
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
              nativeEndedAt && !failure && !evidenceFailures.length
                ? "R-assertions-passed-awaiting-independent-C"
                : "failed",
            failure: failure ?? (evidenceFailures.length ? evidenceFailures.join("; ") : null),
            finalStatus: project?.status ?? "not-created",
            projectSnapshot: project ?? null,
            integrity,
            evidenceFailures,
            rendererErrors,
            ...(boundary ?? {}),
            contentReview:
              "R only; independent C still required for substantive qualification, source fidelity and inference boundaries.",
            teardownNotice:
              "Any unfinished native work closed after failure is cleanup, never natural completion or successful acceptance.",
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
