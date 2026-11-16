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

const NOTICE =
  "合成验收稿／待核查：以下三条不是已经确认的研究结论。真实模型工具执行是 R 证据，来源支持与修订质量仍需独立 C 审查。";
const SCOPE =
  "仅核查合成待核查稿的三条引用与定位，A修订、B复核、导师有限裁定；不写整篇论文，不计算，不读取CSV，不扩展题目。";
const STATEMENTS = [
  "studytime=1/2/3/4 分别对应每周 <2、2–5、5–10、>10 小时。[SMS2025]",
  "DA2025 的研究结果表明，控制其他变量后，每周学习时间越长，学生成绩必然越高。[DA2025]",
  "DA2025 最终阶段开展三个案例研究以说明三阶段设计的有效性。[DA2025，候选定位 UTF-16 [1014,1100)]",
];
const DRAFT = `# 三条引用待核查稿\n\n${NOTICE}\n\n${STATEMENTS.join("\n\n")}`;
const originalSpans = STATEMENTS.map((text, index) => ({
  id: `audit-original-${index + 1}`,
  start: DRAFT.indexOf(text),
  end: DRAFT.indexOf(text) + text.length,
}));
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Only this newly created profile's native logs; never prior R/C evidence or credentials.
async function claimToolEvidence(profile: string, project: ResearchProject) {
  const directory = join(profile, "agent", "sessions");
  const files = await readdir(directory, { recursive: true });
  return Promise.all(
    project.members
      .filter((m) => m.role !== "librarian")
      .map(async (member) => {
        const file = files.find((path) => path.endsWith(`_${member.ref.sessionId}.jsonl`));
        if (!file) throw new Error(`Missing native log for ${member.role}`);
        const calls: {
          id: string;
          operation: unknown;
          args: Record<string, unknown>;
          at: unknown;
          isError?: boolean;
          resultAt?: unknown;
          resultText?: string;
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
              calls.push({ id: part.id, operation: args.operation, args, at: entry.timestamp });
          }
          if (message.role === "toolResult") {
            const call = calls.find((item) => item.id === message.toolCallId);
            if (call)
              Object.assign(call, {
                isError: message.isError === true,
                resultAt: entry.timestamp,
                resultText: content
                  .filter((part) => typeof part.text === "string")
                  .map((part) => part.text)
                  .join("\n"),
              });
          }
        }
        return { role: member.role, sessionId: member.ref.sessionId, file, calls };
      }),
  );
}

// This is a new, opt-in R exercise. It does not seed claims, reviews, native events or outcomes.
test("real bounded citation audit preserves abstract depth, invalid locator and independent claim reviews", async () => {
  test.setTimeout(2_400_000);
  const deadline = Date.now() + 2_100_000;
  const auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit real-provider authentication required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must select the actual read-only course library");
  if (process.env.RESEARCH_MEMBER_TOKEN_BUDGET !== undefined)
    expect(Number(process.env.RESEARCH_MEMBER_TOKEN_BUDGET)).toBe(8_000_000);
  const sourceDirectory =
    process.env.RESEARCH_CLAIM_SOURCE_DIR ??
    resolve(__dirname, "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料");
  const manifest = object(
    JSON.parse(await readFile(join(sourceDirectory, "manifest.json"), "utf8")),
  );
  const originals = Array.isArray(manifest.sources)
    ? manifest.sources
        .map(object)
        .filter((source) => ["UCI", "SMS2025", "DA2025"].includes(String(source.id)))
    : [];
  expect(originals.map((source) => source.id).sort()).toEqual(["DA2025", "SMS2025", "UCI"]);
  const profile = await makeUserDataDir("research-claim-audit-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-claim-audit-live"),
    materials = join(workspace, "provided-audit-materials");
  await mkdir(materials, { recursive: true });
  const hashes: {
    id: string;
    file: string;
    sha256: string;
    suppliedSha256: string;
    suppliedLength: number;
    originalLength: number;
  }[] = [];
  const sources: Record<string, unknown>[] = [];
  for (const source of originals) {
    const id = String(source.id),
      file = `${id}.txt`;
    expect(source.file).toBe(file);
    const original = join(sourceDirectory, file),
      bytes = await readFile(original),
      body = bytes.toString("utf8");
    const supplied = id === "DA2025" ? Buffer.from(body.slice(1041, 2055), "utf8") : bytes;
    if (id === "DA2025") {
      expect(supplied.toString("utf8")).toHaveLength(1014);
      expect(supplied.toString("utf8")).toMatch(/^A central task in educational studies/);
      expect(supplied.toString("utf8")).toMatch(/potentially causal research question\.$/);
    }
    await writeFile(join(materials, file), supplied, { flag: "wx" });
    hashes.push({
      id,
      file: original,
      sha256: researchHash(bytes),
      suppliedSha256: researchHash(supplied),
      originalLength: body.length,
      suppliedLength: supplied.toString("utf8").length,
    });
    sources.push({ ...source, file, textScope: id === "DA2025" ? "abstract" : "full-text" });
  }
  await writeFile(join(materials, "SYNTHETIC-AUDIT.txt"), DRAFT, { flag: "wx" });
  sources.push({
    id: "SYNTHETIC-AUDIT",
    title: "合成验收稿：三条引用待核查",
    authors: "automated-test-operator",
    year: "2026",
    url: "local:synthetic-audit-input",
    file: "SYNTHETIC-AUDIT.txt",
    kind: "manuscript",
    textScope: "full-text",
  });
  await writeFile(
    join(materials, "manifest.json"),
    JSON.stringify({ version: 1, sources, datasets: [] }, null, 2),
    { flag: "wx" },
  );
  const evidence = await openResearchEvidence(materials);
  expect(evidence.datasets).toEqual([]);
  expect(
    await readPinnedResearchFile(evidence.sources.find((source) => source.id === "DA2025")!),
  ).toHaveLength(1014);
  const plan = {
    beganAt: new Date().toISOString(),
    profile,
    workspace,
    materials,
    sourceDirectory,
    boundary: NOTICE,
    scope: SCOPE,
    originalSpans,
    originalHashes: hashes,
    abstractDerivation: {
      sourceId: "DA2025",
      originalUtf16: [1041, 2055],
      suppliedUtf16: [0, 1014],
      textScope: "abstract",
    },
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
    },
    memberTokenBudget: 8_000_000,
    noCSVOrPriorResearchOutputs: true,
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
    const prompt = `${NOTICE}\n${SCOPE}
仅使用本轮提供的UCI、SMS2025文本、DA2025摘要以及SYNTHETIC-AUDIT待核查稿；副本清单是材料边界，不是支持判断。所有来源均是未经本轮内容裁判的材料。不要联网补全文、读取旧稿或旧审阅。DA2025只提供摘要；不得声称看过其他部分。此任务无CSV，不analyze/register-analysis/run-analysis，不source-search/source-fetch，不bash/外部命令。只使用research_group工具，止于audit单项任务。
各角色首次发布前先实际method-package取得本任务课程依据；独立判断的课程正文可共同读取，其他成员私有方法应用须在独立初判之后再看。导师本轮仅发布stage-review，准备说明可留在最终回复中等待交接，不把stage-material当导师笔记。
A与B都必须先独立source-read三份来源及待核查稿，再read对方成果。读取分页按实际nextOffset继续到所供文本末尾，不能把某一页当整篇，不能以来源题名或A的意见替代B自己的核查。导师也须实际source-read所引来源。B可以支持有依据的内容，不要求故意反对；给出支持/部分支持/不支持/材料不足的具体理由及未核验边界。
第一稿是待核查输入的保全：A用stage-draft原样发布SYNTHETIC-AUDIT全文（不加前后文字、不预改三条），随后read真实draft并claim-context。稿内三个UTF16范围由合成输入确定：${JSON.stringify(originalSpans)}。用三个id分别claim-register category=source-fact，artifactId使用真实draft.id。前两条引用维持原稿来源，证据范围从实际读取及claim-context获得，不预换来源。第三条待验证候选为sourceId=DA2025、locatorId使用宿主返回值、start=1014,end=1100,requiredDepth=abstract,relation=support。先实际调用一次source-read(sourceId=DA2025,offset=1014)验证该候选起点，真实返回不论成功失败都如实记录，不伪造工具错误；再将该候选作为第三条claim证据登记并claim-check，保留原始定位审计。若该候选不可用，不能宣称已在该位置读到文字，后续只在新稿用新claim身份修复。不要重试相同失效起点，不要覆盖原始claim。claim-register的登记成功不等于支持或定位有效。
B先保留独立原文判断stage-risk，再read初稿并核对三claim及claim-check。对于可实际核查的claim，以claim-review逐项记录真实判断与理由：review={claimId,conclusion,reason,resolvesReviewIds:[]}；reason指出实际来源、原文位置、相关原文或缺失依据以及已读范围；位置统一写明sourceId与UTF-16 [start,end)，这是记录格式，不是支持结论。若定位本身不可用，保留check blocker，在stage-critique说明位置限制，不通过虚假的claim-review掩盖。stage-critique引用真实初稿与必要risk，分别写清三项审阅，不增加第四个问题。A在发布draft后如尚无B实际critique则正常结束，等待真实交接，勿循环status或自写B意见。
A实际read B critique后发布一份stage-revision（约400字）：逐条给修订文本、来源与实际位置，保留材料不足和不能验证的内容边界，不把需要核查的原句直接改成已确认结论。只有初稿加一份修订，不添加第二份修订以掩盖失败。然后read该新稿、claim-context，对修订的三项分别用新的唯一id和真实稿内UTF16范围登记claim，不复用旧稿hash/claim身份，不引用合成题干作为研究证据。B随后实际read新稿并逐项claim-review，reason给出处与位置；依据实际结果claim-check后发布stage-verification。导师实际读取新稿、B复核和claim-check，给只涵盖三条引用的stage-review有限裁定，不写整篇论文、不推演未提供结果。若仍不足则明确待核查，不以accept包装学术确认。所有refs均指向实际read过的成果；不要把程序检查与模型语义判断混为同一证据。新稿的支持判断由B据原文作出，不沿用旧稿review。
claim工具返回必须如实保留。除候选起点验证外，任何工具失败都解释原因并保留；不能假装执行成功，不为测试凑裁定，不自行向用户补造答复。`;
    await writeFile(test.info().outputPath("initial-instruction.txt"), prompt);
    await page.getByLabel("New thread prompt").fill(prompt);
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          const p = lastState.researchGroups?.projects[0];
          if (!p) return false;
          if (
            lastState.researchGroups?.error ||
            p.status === "paused" ||
            p.fusion?.attempts.some((a) => ["failed", "unknown"].includes(a.state))
          )
            throw new Error(
              lastState.researchGroups?.error ?? p.error ?? "Native attempt failed/unknown",
            );
          const settled =
            captureResearchNativeBoundary(lastState, p).activeNativeAtCapture.length === 0;
          if (settled && p.status === "needs-decision")
            throw new Error("Audit stopped pending a decision; preserve the unresolved R evidence");
          return settled && p.status === "completed";
        },
        { timeout: Math.max(1, deadline - Date.now()), intervals: [1000, 3000] },
      )
      .toBe(true);
    nativeEndedAt = new Date().toISOString();
    lastState = await getDesktopState(page);
    const p = lastState.researchGroups!.projects[0]!;
    expect(researchExecutionRoute(p).stageIds).toEqual(["audit"]);
    expect(researchExecutionRoute(p).requiredRoles).toEqual(["lead", "reviewer", "mentor"]);
    expect(p.memberTokenBudget).toBe(8_000_000);
    expect(p.evidence!.datasets).toEqual([]);
    expect(p.analyses ?? []).toEqual([]);
    expect(p.analysisRegistry?.runs ?? []).toEqual([]);
    expect(p.fusion!.attempts.every((a) => a.state === "succeeded")).toBe(true);
    expect(p.events.some((event) => event.role === "librarian" && event.type === "started")).toBe(
      false,
    );
    expect(p.artifacts.every((a) => a.stage === "audit")).toBe(true);
    for (const artifact of p.artifacts)
      expect(artifact.model).toEqual(
        p.stages!.find((stage) => stage.id === artifact.stage)!.models[artifact.role],
      );
    const draft = p.artifacts.find((a) => a.kind === "stage-draft")!;
    expect(draft.content).toBe(DRAFT);
    const revisions = p.artifacts.filter((a) => a.kind === "stage-revision");
    expect(revisions).toHaveLength(1);
    const revised = revisions[0]!;
    expect(revised.content).not.toBe(draft.content);
    const checks = await claimToolEvidence(profile, p),
      allCalls = checks.flatMap((member) => member.calls);
    const errors = checks.flatMap((member) =>
      member.calls.filter((call) => call.isError).map((call) => ({ ...call, role: member.role })),
    );
    const boundaryErrors = errors.filter(
      (call) =>
        ["lead", "reviewer"].includes(call.role) &&
        call.operation === "source-read" &&
        call.args.sourceId === "DA2025" &&
        call.args.offset === 1014 &&
        call.resultText?.includes("原文读取位置无效"),
    );
    // Both independent readers may validate the same supplied invalid locator once.
    expect(boundaryErrors.some((call) => call.role === "lead")).toBe(true);
    expect(new Set(boundaryErrors.map((call) => call.role)).size).toBe(boundaryErrors.length);
    const recoveredPublicationErrors = errors.filter((call) => {
      if (boundaryErrors.includes(call)) return false;
      const wrongKind =
        call.role === "mentor" &&
        call.operation === "publish" &&
        call.args.kind === "stage-material" &&
        call.resultText === "当前角色不能发布这种成果。";
      const missingMethod =
        call.role === "reviewer" &&
        call.operation === "publish" &&
        call.args.kind === "stage-risk" &&
        call.resultText?.includes("请先取得本任务的固定方法包");
      if (!wrongKind && !missingMethod) return false;
      // A rejected call must create no artifact; later real valid work must complete its role.
      expect(p.artifacts.some((artifact) => artifact.toolCallId === call.id)).toBe(false);
      const actual = p.artifacts.find(
        (artifact) =>
          artifact.role === call.role &&
          artifact.kind === (wrongKind ? "stage-review" : "stage-risk"),
      );
      expect(actual).toBeTruthy();
      if (missingMethod)
        expect(
          p.methodPackageUses?.some(
            (use) => use.role === "reviewer" && use.at <= actual!.createdAt,
          ),
        ).toBe(true);
      return true;
    });
    expect(recoveredPublicationErrors.length).toBeLessThanOrEqual(2);
    expect(
      errors.filter(
        (call) => !boundaryErrors.includes(call) && !recoveredPublicationErrors.includes(call),
      ),
    ).toEqual([]);
    const invalid = p.claims!.claims.find((claim) => claim.id === originalSpans[2]!.id)!;
    expect(invalid.evidence).toContainEqual(
      expect.objectContaining({
        kind: "source",
        sourceId: "DA2025",
        start: 1014,
        end: 1100,
        requiredDepth: "abstract",
      }),
    );
    expect(
      allCalls.some(
        (call) =>
          call.operation === "claim-check" &&
          call.args.artifactId === draft.id &&
          call.resultText?.includes("source-location-stale"),
      ),
    ).toBe(true);
    for (const role of ["lead", "reviewer"] as const) {
      const member = p.members.find((m) => m.role === role)!;
      const firstOtherRead = p.events.find(
        (event) =>
          event.type === "read" &&
          event.role === role &&
          p.artifacts.some((a) => a.id === event.artifactId && a.role !== role),
      );
      expect(firstOtherRead).toBeTruthy();
      for (const source of hashes) {
        const reads = (p.sourceReads ?? [])
          .filter(
            (r) =>
              r.sessionId === member.ref.sessionId &&
              r.sourceId === source.id &&
              r.at <= firstOtherRead!.at,
          )
          .sort((a, b) => a.start - b.start);
        let covered = 0;
        for (const read of reads) {
          expect(read.sourceSha256).toBe(source.suppliedSha256);
          expect(read.start).toBeLessThanOrEqual(covered);
          covered = Math.max(covered, read.end);
          expect(read.depth).toBe(source.id === "DA2025" ? "abstract" : "full-text");
        }
        expect(covered).toBe(source.suppliedLength);
      }
    }
    expect(
      p
        .sourceReads!.filter((r) => r.sourceId === "DA2025")
        .every((r) => r.depth === "abstract" && r.end <= 1014),
    ).toBe(true);
    for (const [index, span] of originalSpans.entries()) {
      const claim = p.claims!.claims.find((c) => c.id === span.id)!;
      expect(claim.artifactId).toBe(draft.id);
      expect(claim.exactText).toBe(STATEMENTS[index]);
      if (index === 2) continue;
      expect(
        claim.evidence.every(
          (e) => e.kind === "source" && e.sourceId === (index === 0 ? "SMS2025" : "DA2025"),
        ),
      ).toBe(true);
      const review = p.claims!.reviews.find(
        (r) => r.claimId === claim.id && r.actor.role === "reviewer",
      )!;
      expect(review).toBeTruthy();
      // These are evaluation assertions, not verdicts supplied to the live models.
      expect(
        index === 0
          ? ["unsupported", "partially-supported"]
          : ["insufficient-material", "partially-supported", "unsupported"],
      ).toContain(review.conclusion);
      expect(review.reason.length).toBeGreaterThan(40);
      expect(review.reason).toContain(index === 0 ? "SMS2025" : "DA2025");
      expect(review.reason).toMatch(/\[\d+\s*,\s*\d+\)/);
      expect(review.reason).toMatch(index === 0 ? /studytime|学习时间/iu : /摘要|abstract/iu);
      expect(review.actualReads.length).toBeGreaterThan(0);
    }
    const revisedClaims = p.claims!.claims.filter((c) => c.artifactId === revised.id);
    expect(revisedClaims).toHaveLength(3);
    for (const claim of revisedClaims) {
      expect(originalSpans.map((span) => span.id)).not.toContain(claim.id);
      expect(claim.bodySha256).toBe(researchHash(revised.content));
      expect(claim.exactText).toBe(revised.content.slice(claim.start, claim.end));
      const review = p.claims!.reviews.find(
        (r) => r.claimId === claim.id && r.actor.role === "reviewer",
      )!;
      expect(review).toBeTruthy();
      expect(review.reason.length).toBeGreaterThan(40);
      expect(review.judgment).toBe("model-semantic-review");
      expect(review.actor.modelId).toBe("gpt-6-astra");
      expect(p.fusion!.attempts.some((a) => a.nativeRunId === review.actor.runId)).toBe(true);
      expect(review.actualReads.length).toBeGreaterThan(0);
    }
    for (const kind of ["stage-critique", "stage-verification", "stage-review"] as const) {
      const artifact = p.artifacts
        .filter((a) => a.kind === kind && isCurrentResearchArtifact(p, a))
        .at(-1)!;
      expect(artifact).toBeTruthy();
      expect(artifact.refs).toContain(kind === "stage-critique" ? draft.id : revised.id);
      expect(
        p.events.some(
          (e) =>
            e.type === "read" &&
            e.role === artifact.role &&
            e.artifactId === (kind === "stage-critique" ? draft.id : revised.id),
        ),
      ).toBe(true);
    }
    expect(
      allCalls.some(
        (c) =>
          c.operation === "claim-check" &&
          c.args.artifactId === revised.id &&
          !c.isError &&
          c.resultAt,
      ),
    ).toBe(true);
    const ledger = await researchNativeCallLedger(profile, p);
    expect(
      ledger
        .flatMap((m) => m.calls)
        .filter(
          (c) =>
            c.name !== "research_group" ||
            [
              "source-search",
              "source-fetch",
              "analyze",
              "register-analysis",
              "run-analysis",
            ].includes(String(c.operation)),
        ),
    ).toEqual([]);
    expect(rendererErrors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("claim-audit-native-ended.png") });
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
          test.info().outputPath("claim-tools-and-reviews.json"),
          JSON.stringify(
            {
              boundary: NOTICE,
              nativeTools: await researchNativeCallLedger(profile, project).catch((e: unknown) => ({
                incomplete: String(e),
              })),
              detailedTools: await claimToolEvidence(profile, project).catch((e: unknown) => ({
                incomplete: String(e),
              })),
              claims: project.claims,
              sourceReads: project.sourceReads,
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
            originalIntegrity,
            copiedIntegrity,
            ...(project && lastState ? captureResearchNativeBoundary(lastState, project) : {}),
            contentReview:
              "Not independently reviewed. These live-model judgments are R evidence awaiting separate C, not program proof of semantic support.",
            teardownNotice:
              "Closing unfinished native work after failure is cleanup, not natural completion.",
          },
          null,
          2,
        ),
      );
      expect(originalIntegrity.every((s) => s.unchanged)).toBe(true);
      expect(copiedIntegrity.every((s) => s.unchanged)).toBe(true);
    } finally {
      await harness.close();
    }
  }
});
