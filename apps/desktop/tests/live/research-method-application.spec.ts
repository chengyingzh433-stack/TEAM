import { expect, test } from "@playwright/test";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import { decodeResearchMethodPackage } from "../../contracts/research-method-packages";
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
} from "../helpers/electron-app";
import {
  captureResearchNativeBoundary,
  researchNativeCallLedger,
} from "../helpers/research-live-evidence";

const ROOT_ID = "EDU-N02-2-5";
const SOURCE_ID = "SYNTHETIC-METHOD-PLAN";
const NOTICE =
  "automated-test-operator：本轮是开发验收的合成方法方案审阅；没有真实研究评分/筛选结果，不新增人类研究许可，不是伦理审批。模型内容判断另交独立C审阅。";
const SCOPE =
  "只审阅所提供文献质量评估方案的方法适用性与实施边界，保留原文和修订，不执行评分或筛选。";
const ORIGINAL = `# 文献质量评估方案副本\n\n${NOTICE}\n\n## 待审方案（合成输入，尚未实施）\n\nP1：拟对拟纳入文献使用当前取得的可见质量评价指标逐项评分。\nP2：把这些可见指标得分直接相加，按完整版36/42总分对应分档解释。\nP3：统一排除低档文献，各研究类型适用同一规则。\n\n尚未执行评分或筛选，没有真实文献样本、数据或研究结果。请核查这一方法方案，保留条款定位并另交修订稿。\n`;
const INSTRUCTION = `${NOTICE}\n${SCOPE}\n唯一待审对象是 ${SOURCE_ID}，它是明确标注的合成方案副本，不是旧稿或实证发现。各角色先status/inputs并实际source-read该原文。实际method-package以ids=["${ROOT_ID}"]取得课程包，依据工具返回的递归必要上下文与图片清单审阅，不自行扩大检索。课程内容是方法/案例依据，不是原始实证。相同版本使用同包，不能写回课程库或覆盖方案原件。\nA与B先依据共同原始方案/课程独立初判：A先stage-draft，B先stage-risk，在自己独立稿发布前不读对方观点或私有方法解释。A/B都须本人method-read-image实际取得包内必要图片，再用返回receiptId逐图method-image-reading，记录具体可见内容、位置和无法确认的边界；不能把文件路径、可读字节或他人观察当本人读图。没有看清就明确待核，不能编造观察。\n完成独立初判后，B实际read A初稿，针对其具体文字给位置、依据、影响和建议，发布stage-critique；可以有依据同意，不强制凑反对。A读取B批评后另发stage-revision，逐条说明保留/修改/待核及原因，原件和初稿均保留。A用method-apply记录当前方案的实际方法选择、适用解释、未适用条件与局限，scoringClaim按实际交付填写not-scored或partial-indicators-only。B实际read最新修订，method-check核查当前应用，method-opinion记录本人内容意见，再发布stage-verification。导师本人取得同版课程包，实际read A最新修订和B复核，结合应用与B意见method-adjudicate并method-check，最后给有限stage-review。工具ID只取真实返回/status，refs/sourceIds只引用实际读取对象。\n程序完整性、模型方法意见和导师裁定分开；不能用程序通过声称完整工具总分已认证。材料不足应保留限制或收窄交付，不能为流程通过伪造判断。初稿/修订各约500字，B独立/批评/复核各约250字，导师约250字，图像观察另存具体记录；不循环轮询，交接后结束当次回复等待自动接续。只用research_group；不联网、不source-search/source-fetch、不analyze/run-analysis、不bash、不读CSV/旧R/C/其他论文，不做整篇论文，不请求新授权或声称已获伦理批准。`;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Read-only file manifest: full course tree before/after; never follow a symlink. */
async function fileManifest(directory: string) {
  const rows: { path: string; bytes: number; sha256: string }[] = [];
  const walk = async (relative: string) => {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(directory, path));
      if (info.isSymbolicLink()) throw new Error(`Evidence tree contains a symlink: ${path}`);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        const bytes = await readFile(join(directory, path));
        rows.push({ path, bytes: bytes.length, sha256: researchHash(bytes) });
      } else throw new Error(`Unsupported evidence file: ${path}`);
    }
  };
  await walk("");
  return { files: rows, sha256: researchHash(JSON.stringify(rows)) };
}

/** Only the three owned native session logs; emit hashes, never image base64 or credentials. */
async function imageTransportEvidence(profile: string, project: ResearchProject) {
  const directory = join(profile, "agent", "sessions"),
    paths = await readdir(directory, { recursive: true });
  return Promise.all(
    project.members
      .filter((member) => member.role !== "librarian")
      .map(async (member) => {
        const file = paths.find((path) => path.endsWith(`_${member.ref.sessionId}.jsonl`));
        if (!file) throw new Error(`Missing owned native log: ${member.role}`);
        const calls: {
          id: string;
          operation: string;
          args: Record<string, unknown>;
          at: unknown;
          resultAt?: unknown;
          isError?: boolean;
          imageContents?: { type: "image"; mimeType: unknown; bytes: number; sha256: string }[];
          programBoundary?: { fullInstrumentScoring: unknown; methodApplicability: unknown };
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
              typeof part.id === "string"
            )
              calls.push({
                id: part.id,
                operation: String(args.operation),
                args,
                at: entry.timestamp,
              });
          }
          if (message.role !== "toolResult") continue;
          const call = calls.find((item) => item.id === message.toolCallId);
          if (!call) continue;
          call.resultAt = entry.timestamp;
          call.isError = message.isError === true;
          call.imageContents = content
            .filter((part) => part.type === "image")
            .map((part) => {
              if (typeof part.data !== "string")
                throw new Error("ImageContent has no actual bytes");
              const bytes = Buffer.from(part.data, "base64");
              return {
                type: "image",
                mimeType: part.mimeType,
                bytes: bytes.length,
                sha256: researchHash(bytes),
              };
            });
          if (call.operation === "method-check" && !call.isError) {
            const text = content
              .filter((part) => typeof part.text === "string")
              .map((part) => part.text)
              .join("\n");
            const envelope = object(JSON.parse(text));
            const result = "nextStage" in envelope ? object(envelope.result) : envelope;
            call.programBoundary = {
              fullInstrumentScoring: result.fullInstrumentScoring,
              methodApplicability: result.methodApplicability,
            };
          }
        }
        return { role: member.role, sessionId: member.ref.sessionId, calls };
      }),
  );
}

async function cacheEvidence(workspace: string, project: ResearchProject) {
  const directory = join(workspace, ".lancer", "research-method-packages");
  const manifest = await fileManifest(directory);
  const expected: string[] = [];
  for (const pkg of project.methodPackages ?? []) {
    const saved = decodeResearchMethodPackage(
      JSON.parse(await readFile(join(directory, pkg.packageSha256, "package.json"), "utf8")),
    );
    expect(saved).toEqual(pkg); // Strict whitelist decoder rejects private applications/actors/decisions.
    expected.push(`${pkg.packageSha256}/package.json`);
    for (const image of pkg.images) {
      const path = `${pkg.packageSha256}/images/${image.path}`;
      expected.push(path);
      const file = manifest.files.find((row) => row.path === path)!;
      expect(file).toMatchObject({ sha256: image.actualSha256, bytes: image.bytes });
      const bytes = await readFile(join(directory, path));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  }
  expect(manifest.files.map((file) => file.path).sort()).toEqual(expected.sort());
  return {
    ...manifest,
    boundary: "Only strict course package JSON and original PNG bytes; no private project ledger.",
  };
}

test("real providers inspect course images and revise a synthetic quality-assessment method plan", async () => {
  test.setTimeout(2_400_000); // Existing S5 ceiling, not enlarged for this exercise.
  const deadline = Date.now() + 2_100_000;
  const auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit live auth opt-in required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must select the actual course library");
  const knowledge = await ResearchKnowledge.open(knowledgeDir),
    kbBefore = await fileManifest(knowledgeDir);
  const closure = knowledge.retrieveWithRoots("", "lead", [ROOT_ID]);
  expect(closure.records.some((record) => record.id === "EDU-N02-2-4")).toBe(true);
  // Audit oracle only. Never put page counts, missing-item answers or C's judgment into prompts.
  const requiredImagePaths = [39, 40, 41, 42].map(
    (page) => `素材/原图/0801_p${String(page).padStart(3, "0")}.png`,
  );
  const originalImages = requiredImagePaths.map((path) => {
    const file = kbBefore.files.find((row) => row.path === path);
    expect(file, `Actual course image ${path}`).toBeTruthy();
    return file!;
  });
  const profile = await makeUserDataDir("research-method-application-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-method-application-live"),
    materials = join(workspace, "provided-plan");
  await mkdir(materials);
  const originalPath = join(materials, "synthetic-quality-assessment-plan.md");
  await writeFile(originalPath, ORIGINAL, { flag: "wx" });
  await writeFile(
    join(materials, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        sources: [
          {
            id: SOURCE_ID,
            title: "文献质量评估方案副本（合成软件验收对象）",
            authors: "automated-test-operator",
            year: "2026",
            url: "urn:lancer:software-flow:method-application",
            kind: "design",
            file: "synthetic-quality-assessment-plan.md",
          },
        ],
        datasets: [],
      },
      null,
      2,
    ),
  );
  const evidence = await openResearchEvidence(materials);
  expect(evidence.sources).toHaveLength(1);
  expect(evidence.datasets).toEqual([]);
  const plan = {
    beganAt: new Date().toISOString(),
    notice: NOTICE,
    identity: "automated-test-operator",
    profile,
    workspace,
    originalPath,
    originalSha256: researchHash(ORIGINAL),
    knowledgePin: knowledge.pin,
    route: "task/design-review, S5 only",
    memberTokenBudget: 8_000_000,
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
    },
    targetDuration: "3–5 minutes aspirational; retain actual duration, no timeout escalation",
    boundary:
      "Real-provider software/method workflow. Synthetic plan, no empirical results; semantic quality requires independent C.",
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(
    test.info().outputPath("knowledge-before.json"),
    JSON.stringify(kbBefore, null, 2),
  );
  await writeFile(test.info().outputPath("original-synthetic-plan.md"), ORIGINAL);
  await writeFile(test.info().outputPath("initial-instruction.txt"), INSTRUCTION);
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
    await page.getByLabel("New thread prompt").fill(INSTRUCTION);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          const p = lastState.researchGroups?.projects[0];
          if (!p) return false;
          const failed = p.fusion?.attempts.filter((attempt) =>
            ["failed", "unknown"].includes(attempt.state),
          );
          if (
            lastState.researchGroups?.error ||
            ["paused", "needs-decision"].includes(p.status) ||
            failed?.length
          )
            throw new Error(
              JSON.stringify({
                error: lastState.researchGroups?.error ?? p.error,
                status: p.status,
                failed,
              }),
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
    const final = lastState!.researchGroups!.projects[0]!;
    expect(final.memberTokenBudget).toBe(8_000_000);
    expect(researchExecutionRoute(final).stageIds).toEqual(["design"]);
    expect(researchExecutionRoute(final).requiredRoles).toEqual(["lead", "reviewer", "mentor"]);
    expect(final.evidence!.sources.map((source) => source.id)).toEqual([SOURCE_ID]);
    expect(final.evidence!.datasets).toEqual([]);
    expect(final.analyses ?? []).toEqual([]);
    expect(final.analysisRegistry?.runs ?? []).toEqual([]);
    expect(final.fusion!.decisionRequests ?? []).toEqual([]);
    expect(final.fusion!.attempts.every((attempt) => attempt.state === "succeeded")).toBe(true);
    expect(
      final.events.some((event) => event.role === "librarian" && event.type === "started"),
    ).toBe(false);
    expect(final.inputHistory![0]).toMatchObject({
      text: INSTRUCTION,
      source: { kind: "explicit-submit" },
    });
    const transport = await imageTransportEvidence(profile, final);
    const nativeCalls = await researchNativeCallLedger(profile, final);
    expect(
      nativeCalls
        .flatMap((member) => member.calls)
        .filter(
          (call) =>
            call.name !== "research_group" ||
            [
              "source-search",
              "source-fetch",
              "analyze",
              "run-analysis",
              "request-decision",
            ].includes(String(call.operation)),
        ),
    ).toEqual([]);
    const pkg = final.methodPackages!.find((item) => item.rootIds.includes(ROOT_ID))!;
    expect(pkg).toBeTruthy();
    expect(pkg.knowledge.sha256).toBe(knowledge.pin.sha256);
    expect(pkg.records.map((record) => record.id).sort()).toEqual(
      closure.records.map((record) => record.id).sort(),
    );
    for (const record of pkg.records) {
      const original = closure.records.find((item) => item.id === record.id)!;
      expect(record.text).toBe(original.text);
      expect(record.title).toBe(original.title);
      expect(record.requiredContextIds).toEqual(original.required_context_ids);
    }
    expect(pkg.images.map((image) => image.path).sort()).toEqual([...requiredImagePaths].sort());
    expect(new Set(final.methodPackageUses!.map((use) => use.packageSha256))).toEqual(
      new Set([pkg.packageSha256]),
    );
    const current = final.artifacts.filter((artifact) =>
      isCurrentResearchArtifact(final, artifact),
    );
    const draft = current.find((artifact) => artifact.kind === "stage-draft")!,
      risk = current.find((artifact) => artifact.kind === "stage-risk")!;
    const revision = current.filter((artifact) => artifact.kind === "stage-revision").at(-1)!,
      critique = current.filter((artifact) => artifact.kind === "stage-critique").at(-1)!;
    const verification = current
        .filter((artifact) => artifact.kind === "stage-verification")
        .at(-1)!,
      review = current.filter((artifact) => artifact.kind === "stage-review").at(-1)!;
    for (const artifact of [draft, risk, critique, revision, verification, review]) {
      expect(artifact).toBeTruthy();
      expect(artifact.stage).toBe("design");
      expect(artifact.model).toEqual(
        final.stages!.find((stage) => stage.id === "design")!.models[artifact.role],
      );
    }
    expect(revision.content).not.toBe(draft.content);
    expect(revision.refs).toContain(critique.id);
    expect(critique.refs).toContain(draft.id);
    expect(verification.refs).toContain(revision.id);
    expect(review.refs).toEqual(expect.arrayContaining([revision.id, verification.id]));
    for (const role of ["lead", "reviewer", "mentor"] as const) {
      expect(
        final.events.some(
          (event) =>
            event.type === "source-read" &&
            event.role === role &&
            event.sourceId === SOURCE_ID &&
            event.sourceSha256 === researchHash(ORIGINAL),
        ),
      ).toBe(true);
      expect(
        final.methodPackageUses!.some(
          (use) =>
            use.role === role && use.packageId === pkg.id && use.operation === "method-package",
        ),
      ).toBe(true);
    }
    for (const [role, independent] of [
      ["lead", draft],
      ["reviewer", risk],
    ] as const) {
      expect(independent.sourceIds).toContain(SOURCE_ID);
      expect(
        final.events.some(
          (event) =>
            event.type === "source-read" &&
            event.role === role &&
            event.sourceId === SOURCE_ID &&
            event.sourceSha256 === researchHash(ORIGINAL) &&
            event.at <= independent.createdAt,
        ),
      ).toBe(true);
      expect(
        final.methodPackageUses!.some(
          (use) =>
            use.role === role &&
            use.packageId === pkg.id &&
            use.operation === "method-package" &&
            use.at <= independent.createdAt,
        ),
      ).toBe(true);
      const otherRole = role === "lead" ? "reviewer" : "lead";
      expect(
        final.events.filter(
          (event) =>
            event.type === "read" &&
            event.role === role &&
            event.at < independent.createdAt &&
            final.artifacts.some(
              (artifact) => artifact.id === event.artifactId && artifact.role === otherRole,
            ),
        ),
      ).toEqual([]);
      const member = transport.find((item) => item.role === role)!;
      if (role === "reviewer")
        expect(
          member.calls.filter(
            (call) =>
              !call.isError &&
              call.resultAt &&
              String(call.at) < independent.createdAt &&
              ["method-opinion", "method-check"].includes(call.operation) &&
              call.args.applicationId,
          ),
        ).toEqual([]);
      for (const image of originalImages) {
        const receipt = final.methodImageReceipts!.find(
          (row) =>
            row.actor.id === `model:${role}` && row.packageId === pkg.id && row.path === image.path,
        )!;
        expect(receipt).toMatchObject({
          imageSha256: image.sha256,
          bytes: image.bytes,
          mimeType: "image/png",
          actor: { kind: "model" },
        });
        const delivered = member.calls.find((call) => call.id === receipt.callId)!;
        expect(delivered).toMatchObject({
          operation: "method-read-image",
          isError: false,
          imageContents: [
            { type: "image", mimeType: "image/png", bytes: image.bytes, sha256: image.sha256 },
          ],
        });
        const observation = member.calls.find(
          (call) =>
            call.operation === "method-image-reading" &&
            call.args.receiptId === receipt.id &&
            !call.isError &&
            call.resultAt,
        )!;
        expect(observation).toBeTruthy();
        expect(String(observation.at) >= String(delivered.resultAt)).toBe(true);
        const reading = final.methodImageReadings!.find(
          (row) =>
            row.actor.id === `model:${role}` &&
            row.packageId === pkg.id &&
            row.path === image.path &&
            row.observations === observation.args.observations,
        )!;
        expect(reading).toMatchObject({ imageSha256: image.sha256, actor: { kind: "model" } });
        expect(reading.observations.trim().length).toBeGreaterThan(20); // Presence/sequence only; specificity and correctness belong to C.
        expect(reading.at <= independent.createdAt).toBe(true);
      }
    }
    const application = final
      .methodApplications!.filter(
        (row) => row.actor.id === "model:lead" && row.packageId === pkg.id,
      )
      .at(-1)!;
    expect(["not-scored", "partial-indicators-only"]).toContain(application.scoringClaim);
    const opinion = final
      .methodContentOpinions!.filter((row) => row.applicationId === application.id)
      .at(-1)!;
    expect(opinion).toMatchObject({
      verdict: "support",
      actor: { kind: "model", id: "model:reviewer" },
    });
    const adjudication = final
      .methodAdjudications!.filter((row) => row.applicationId === application.id)
      .at(-1)!;
    expect(adjudication).toMatchObject({
      verdict: "accept",
      actor: { kind: "model", id: "model:mentor" },
    });
    expect(adjudication.opinionIds).toContain(opinion.id);
    for (const role of ["reviewer", "mentor"] as const) {
      expect(
        final.methodProgramChecks!.some(
          (check) =>
            check.role === role &&
            check.result === "passed-at-snapshot" &&
            check.target?.artifactId === revision.id &&
            check.target.bodySha256 === researchHash(revision.content) &&
            check.issues.length === 0,
        ),
      ).toBe(true);
      const checks = transport
        .find((member) => member.role === role)!
        .calls.filter(
          (call) =>
            call.operation === "method-check" &&
            call.args.applicationId === application.id &&
            !call.isError,
        );
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks)
        expect(check.programBoundary).toEqual({
          fullInstrumentScoring: "not-certified",
          methodApplicability: "not-assessed",
        });
    }
    await writeFile(
      test.info().outputPath("collaboration-proof.json"),
      JSON.stringify(
        {
          notice: NOTICE,
          originalSha256: researchHash(ORIGINAL),
          draftId: draft.id,
          independentRiskId: risk.id,
          critiqueId: critique.id,
          revisionId: revision.id,
          verificationId: verification.id,
          reviewId: review.id,
          packageId: pkg.id,
          packageSha256: pkg.packageSha256,
          applicationId: application.id,
          opinionId: opinion.id,
          adjudicationId: adjudication.id,
          originalImages,
          transport,
          cache: await cacheEvidence(workspace, final),
          boundary:
            "Structure and actual image transport verified; text/visual interpretation and substantive correction require independent C.",
        },
        null,
        2,
      ),
    );
    const panel = page.getByTestId("research-method-packages");
    await expect(panel).toBeVisible();
    if (!(await panel.evaluate((element) => element.hasAttribute("open"))))
      await panel.locator(":scope > summary").click();
    await page.screenshot({ path: test.info().outputPath("method-application-native-ended.png") });
    expect(rendererErrors).toEqual([]);
    expect(captureResearchNativeBoundary(lastState!, final).usageFinality).not.toBe(
      "provisional-native-unsettled",
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      lastState = await getDesktopState(await harness.firstWindow()).catch(() => lastState);
      const project = lastState?.researchGroups?.projects[0];
      const kbAfter = await fileManifest(knowledgeDir),
        originalAfter = researchHash(await readFile(originalPath));
      await writeFile(
        test.info().outputPath("knowledge-after.json"),
        JSON.stringify(kbAfter, null, 2),
      );
      if (project) {
        await writeFile(
          test.info().outputPath("research-project.json"),
          JSON.stringify(project, null, 2),
        );
        for (const artifact of project.artifacts)
          await writeFile(test.info().outputPath(`artifact-${artifact.id}.md`), artifact.content);
        await writeFile(
          test.info().outputPath("native-method-evidence.json"),
          JSON.stringify(
            {
              nativeCalls: await researchNativeCallLedger(profile, project).catch(
                (error: unknown) => ({ incomplete: String(error) }),
              ),
              imageTransport: await imageTransportEvidence(profile, project).catch(
                (error: unknown) => ({ incomplete: String(error) }),
              ),
              cache: await cacheEvidence(workspace, project).catch((error: unknown) => ({
                incomplete: String(error),
              })),
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
            nativeEndedAt,
            failure,
            finalStatus: project?.status ?? "not-created",
            knowledgeUnchanged: kbBefore.sha256 === kbAfter.sha256,
            originalUnchanged: originalAfter === researchHash(ORIGINAL),
            ...(project && lastState ? captureResearchNativeBoundary(lastState, project) : {}),
            contentReview:
              "Pending independent C; transport/ledger completion does not establish scientific correctness, human expertise or ethical permission.",
            teardownNotice:
              "Closing an unfinished native request after failure is cleanup, not natural completion.",
          },
          null,
          2,
        ),
      );
      expect(kbAfter).toEqual(kbBefore);
      expect(originalAfter).toBe(researchHash(ORIGINAL));
    } finally {
      await harness.close();
    }
  }
});
