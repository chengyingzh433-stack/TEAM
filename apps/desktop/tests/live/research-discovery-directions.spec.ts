import { expect, test } from "@playwright/test";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RESEARCH_ROLES, RESEARCH_ROLE_LABELS } from "../../contracts/research-group";
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
import {
  captureResearchNativeBoundary,
  researchNativeCallLedger,
} from "../helpers/research-live-evidence";

// R for a source-limited S0 comparison. Fresh independent C is required; this is not M2 retrieval proof.
test("real no-topic entry compares bounded candidate directions from supplied sources and stops at S0", async () => {
  test.setTimeout(1_800_000);
  const auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit real-provider authentication is required.");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must select the actual read-only course library.");
  const sourceDirectory =
    process.env.RESEARCH_DISCOVERY_SOURCE_DIR ??
    resolve(
      __dirname,
      "../../../../.artifacts/fusion-real-design-selected-20261107/live-research-fusion-real--5d7d7-icitly-selected-paper-scope",
    );
  const sourceProjectFile = join(sourceDirectory, "research-project.json");
  // Read metadata solely to pin raw source files and the already authorized budget.
  // No prior objective, manuscript, artifact or review is sent to the new project.
  const sourceProject = decodeResearchState({
    version: 1,
    config: { knowledgeDir },
    projects: [JSON.parse(await readFile(sourceProjectFile, "utf8"))],
  }).projects[0]!;
  expect(sourceProject.memberTokenBudget).toBe(8_000_000);
  if (process.env.RESEARCH_MEMBER_TOKEN_BUDGET !== undefined)
    expect(Number(process.env.RESEARCH_MEMBER_TOKEN_BUDGET)).toBe(sourceProject.memberTokenBudget);
  expect(sourceProject.evidence!.sources.map((source) => source.id).sort()).toEqual([
    "DA2025",
    "SMS2025",
    "UCI",
  ]);
  expect(sourceProject.evidence!.sources.filter((source) => source.kind === "paper")).toHaveLength(
    2,
  );
  const originals = await Promise.all(
    [sourceProjectFile, ...sourceProject.evidence!.sources.map((source) => source.file)].map(
      async (file) => ({ file, sha256: researchHash(await readFile(file)) }),
    ),
  );
  const beganAt = new Date().toISOString(),
    profile = await makeUserDataDir("research-discovery-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-discovery-live"),
    materialsDirectory = join(workspace, "provided-raw-sources");
  await mkdir(materialsDirectory, { recursive: true });
  const sources = [];
  for (const source of sourceProject.evidence!.sources) {
    const file = `${source.id}.txt`;
    await writeFile(join(materialsDirectory, file), await readPinnedResearchFile(source), {
      flag: "wx",
    });
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
  await writeFile(
    join(materialsDirectory, "manifest.json"),
    JSON.stringify({ version: 1, sources, datasets: [] }, null, 2),
    { flag: "wx" },
  );
  const evidence = await openResearchEvidence(materialsDirectory);
  expect(evidence.datasets).toEqual([]);
  expect(evidence.sources.some((source) => ["design", "manuscript"].includes(source.kind))).toBe(
    false,
  );
  for (const source of sourceProject.evidence!.sources)
    expect(evidence.sources.find((copy) => copy.id === source.id)!.sha256).toBe(source.sha256);
  const plan = {
    beganAt,
    profile,
    workspace,
    sourceDirectory,
    route: {
      entry: "discovery",
      goal: "direction",
      stages: ["scan"],
      requiredRoles: [...RESEARCH_ROLES],
    },
    sourceHashes: originals,
    copiedSources: evidence.sources,
    memberTokenBudget: sourceProject.memberTokenBudget,
    budgetOrigin: "existing original real-run per-member ceiling",
    configuredCeilingsSum: sourceProject.memberTokenBudget! * 4,
    budgetNotice:
      "Configured per-member ceilings are not an atomic billing cap; provider usage remains separately reported.",
    models: {
      mentor: "openai-codex/gpt-6-astra high",
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      librarian: "openai-codex/gpt-6.1-sol low",
    },
    proof:
      "AC20 bounded no-topic S0 real-provider run using three supplied sources. New independent C is pending. This is not broad field coverage, established novelty, full M2 search, user direction selection or empirical validation.",
    importsPriorDraft: false,
    importsCsv: false,
    networkSearchAuthorized: false,
    selectsDirectionForUser: false,
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  console.log(
    "[research-discovery-live]",
    JSON.stringify({
      profile,
      workspace,
      memberTokenBudget: sourceProject.memberTokenBudget,
      sources: evidence.sources.map((source) => source.id),
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
          independentContentReview: "pending",
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
    await editor.getByLabel("研究入口", { exact: true }).selectOption("discovery");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("direction");
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
      /本轮方法范围：\s*S0。/,
    );
    await page.screenshot({ path: test.info().outputPath("discovery-direction-config.png") });
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await openNewThread(page);
    const prompt = `我目前没有明确研究题目，也没有选定最终方向。我是高中教师，想先在“高中学生学习与公开教育数据”这一有限范围，了解哪些候选方向有实际线索、哪些其实已有答案、哪些现有材料不足，以及在时间和数据条件上是否可行。本轮只做S0来源有限的方向比较，不替我选定方向、不打磨成S1正式研究问题、不继续写方案或论文。有限量化只是本轮考察公开数据可行性的范围，不代表我已选择某个变量关系或研究题目。\n你们可用材料只有目录中的UCI官方说明及DA2025、SMS2025两篇真实研究正文；没有CSV、学生记录、原项目稿件或既定研究问题。先inputs清点，再source-read实际读取。三份材料集中于同一个公开数据案例，不能因此代表整个高中学习领域，也不能作为独立样本多次验证。请明确写成“基于三份所提供来源的有限候选比较”，不是广泛领域检索、系统综述或新颖性已经确立。\n围绕材料能支持的不同候选角度比较，不预设只有成绩—缺勤关联一个题目。每个候选方向列：实际来源与定位线索、已有答案及重复风险、相反证据/竞争解释、当前可回答与尚不能回答的部分、进一步材料与许可需求、数据可得性/字段时点/方法支持和工作量、适合与不适合的现实条件。可作有条件推荐，但不得代替用户最终选择；开放问题和缺口仍待后续定向检索核查。对来源支持不足的方向可明确不推荐，不能为凑数量杜撰。最终交一份简明候选对照及待用户考虑的取舍，不生成观察结果。\nA先独立提出初步候选对照stage-draft，B先独立发布stage-risk再实际read A稿形成具体stage-critique，A逐项回应并发布stage-revision，B实际read修订后stage-verification；导师实际read最新修订与B复核，仅对这份来源有限的候选比较作stage-review。资料员尽早交第一份实际原文线索stage-material，再继续必要原文定位。A/B至少各自实际读取UCI及研究原文；导师读取其裁定依赖的来源，sourceIds只列本人实际read过的来源。来源ID不是refs，refs只放本轮实际read过的成果ID。各角色成果和裁定标明模型意见；验收比较稿充分，不等于替用户选方向。\n不联网追加检索，不调用source-search/source-fetch或外部命令，不调用analyze，不取得CSV，不做样本统计，不虚构全文读取或已有批准。材料的缺口据实写明，不把摘要或局部读取称全文。无数据不阻止本轮候选比较，不能据此声称实施条件已满足。当前授权仅为基于所供公开资料的方向比较；不联系学生、不干预、不投稿，不把授权当伦理审批。无需为完成比较先询问我最终选题；把选择留在候选稿中，在S0停止。后续M2完整检索及任何正式研究均另行验收。`;
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
          const boundary = captureResearchNativeBoundary(lastState, project);
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
              "[research-discovery-progress]",
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
              `Local decision requires user input: ${JSON.stringify(pending.map((request) => ({ id: request.id, question: request.question })))}`,
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
              "Research accepted while native attempts did not all succeed; cleanup cannot establish completion.",
            );
          nativeEndedAt = new Date().toISOString();
          return true;
        },
        { timeout: 1_500_000, intervals: [1000, 5000] },
      )
      .toBe(true);
    lastState = await getDesktopState(page);
    const project = lastState.researchGroups!.projects[0]!;
    expect(project.id).not.toBe(sourceProject.id);
    expect(project).toMatchObject({
      workflowVersion: "fusion-v2",
      entry: "discovery",
      goal: "direction",
      currentStage: "scan",
      memberTokenBudget: 8_000_000,
    });
    expect(researchExecutionRoute(project).stageIds).toEqual(["scan"]);
    expect(new Set(project.fusion!.tasks.map((task) => task.stage))).toEqual(new Set(["scan"]));
    expect(new Set(project.fusion!.tasks.map((task) => task.role))).toEqual(
      new Set(RESEARCH_ROLES),
    );
    expect(project.artifacts.every((artifact) => artifact.stage === "scan")).toBe(true);
    expect(project.evidence!.sources.map((source) => source.id).sort()).toEqual([
      "DA2025",
      "SMS2025",
      "UCI",
    ]);
    expect(project.evidence!.datasets).toEqual([]);
    expect(project.analyses ?? []).toEqual([]);
    expect(project.analysisPlan).toBeUndefined();
    expect(project.finalPaper).toBeUndefined();
    expect(new Set(project.members.map((member) => member.ref.sessionId)).size).toBe(4);
    expect(
      project.members.every(
        (member) =>
          !sourceProject.members.some((old) => old.ref.sessionId === member.ref.sessionId),
      ),
    ).toBe(true);
    for (const source of evidence.sources)
      expect(
        project.events.some(
          (event) =>
            event.type === "source-read" &&
            event.sourceId === source.id &&
            event.sourceSha256 === source.sha256,
        ),
      ).toBe(true);
    for (const role of RESEARCH_ROLES)
      expect(
        project.events.some(
          (event) => event.type === "started" && event.role === role && event.runId,
        ),
      ).toBe(true);
    for (const role of ["lead", "reviewer"] as const) {
      expect(
        project.events.some(
          (event) =>
            event.type === "source-read" && event.role === role && event.sourceId === "UCI",
        ),
      ).toBe(true);
      expect(
        project.events.some(
          (event) =>
            event.type === "source-read" &&
            event.role === role &&
            ["DA2025", "SMS2025"].includes(event.sourceId ?? ""),
        ),
      ).toBe(true);
    }
    const revised = project.artifacts
      .filter((artifact) => artifact.kind === "stage-revision")
      .at(-1)!;
    expect(revised).toBeTruthy();
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
    expect(
      project.artifacts.some(
        (artifact) => artifact.kind === "stage-material" && artifact.role === "librarian",
      ),
    ).toBe(true);
    for (const artifact of project.artifacts)
      expect(artifact.model).toEqual(
        project.stages!.find((stage) => stage.id === artifact.stage)!.models[artifact.role],
      );
    expect(project.fusion!.decisions.filter((decision) => decision.actor === "user")).toEqual([]);
    const nativeTools = await researchNativeCallLedger(profile, project);
    expect(
      nativeTools
        .flatMap((member) => member.calls)
        .filter(
          (call) =>
            call.name !== "research_group" ||
            ["source-search", "source-fetch", "analyze"].includes(String(call.operation)),
        ),
    ).toEqual([]);
    expect(captureResearchNativeBoundary(lastState, project).activeNativeAtCapture).toEqual([]);
    expect(rendererErrors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("bounded-directions-native-ended.png") });
    await writeFile(test.info().outputPath("candidate-directions.md"), revised.content);
    await writeFile(
      test.info().outputPath("independent-content-review-needed.json"),
      JSON.stringify(
        {
          status: "pending-independent-C",
          projectId: project.id,
          candidateArtifactId: revised.id,
          sourceHashes: evidence.sources.map(({ id, sha256 }) => ({ id, sha256 })),
          checks: [
            "Each candidate has actual supplied-source support and locators",
            "Candidate range is limited to this source set, not broad field coverage",
            "Known answers and competing/counter evidence are represented fairly",
            "Feasibility separates available source descriptions from unavailable CSV and future implementation",
            "Novelty is tentative and awaits later retrieval",
            "No direction is falsely attributed to user selection",
            "No invented data, effects, causal findings or human/ethics approval",
            "Critique/revision meaning and source interpretation are substantively correct",
          ],
          limitation:
            "Automatic execution/read/ref assertions establish bounded R only; no independent C acceptance or full M2 search is claimed.",
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
              ...captureResearchNativeBoundary(lastState, project),
              reads: project.events.filter((event) => ["source-read", "read"].includes(event.type)),
              refs: project.artifacts.map(({ id, kind, role, refs, sourceIds, model }) => ({
                id,
                kind,
                role,
                refs,
                sourceIds,
                model,
              })),
              attempts: project.fusion?.attempts,
              projectErrors: project.events.filter((event) => event.type === "error"),
              nativeTools: await researchNativeCallLedger(profile, project).catch(
                (error: unknown) => ({ audit: "incomplete", failure: String(error) }),
              ),
              errorCoverage:
                "Project error events do not include all rejected tool calls; inspect nativeTools.",
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
            independentContentReview: "pending-independent-C",
            originalIntegrity,
            copiedIntegrity,
            ...(project && lastState ? captureResearchNativeBoundary(lastState, project) : {}),
            teardownNotice:
              "Closing active/unknown requests after failure is cleanup, not natural completion.",
            scopeBoundary:
              "Only M1 supplied-source direction comparison; no M2 full search, user-selected direction, S1 execution or empirical validation.",
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
