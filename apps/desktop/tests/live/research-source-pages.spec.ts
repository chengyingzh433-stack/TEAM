import { expect, test } from "@playwright/test";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS, researchExecutionRoute } from "../../contracts/research-method";
import {
  type ResearchSourcePageReceipt,
  type ResearchSourcePageRecords,
} from "../../contracts/research-source-pages";
import { ResearchKnowledge } from "../../electron/research-group/knowledge";
import { researchHash } from "../../electron/research-group/materials";
import { validateSourcePageProject } from "../../electron/research-group/source-page-tools";
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

const PDF_NAME = "zhou-2025-spaced-learning.pdf";
const PDF_SHA = "f165b4001222a030acdfa5078181bb79d62a6016d01b294be80a448d5662d112";
const DOI = "10.1371/journal.pone.0321552";
const ARTICLE_URL = `https://journals.plos.org/plosone/article?id=${DOI}`;
const PDF_URL = `https://journals.plos.org/plosone/article/file?id=${DOI}&type=printable`;
const TITLE = "The impact of spaced learning within physics lessons in secondary schools";
const AUTHORS = "Yuxi Zhou; Rachel Hartley; Alessio Bernardelli; Andrew Tolmie";
const PAGES = [9, 10] as const;
const NOTICE =
  "automated-test-operator：本轮是实际开放论文PDF原页读取的软件流程验收，模型观察及内容判断另交独立C；不代表完整论文复核、现场研究或伦理审批。";
const SCOPE =
  "只对Zhou等2025论文的指定两页图表作有边界的独立精读与相互核对，不扩展为整篇综述、重新统计或方法效果定论。";
// The prompt identifies the task and pages, never supplies the graph/table answers used by C.
const PROMPT = `${NOTICE}\n${SCOPE}\n实际论文为 ${AUTHORS} (2025), ${TITLE}, PLOS ONE, DOI ${DOI}。测试操作者会通过普通UI导入并采用原始PDF ${PDF_NAME}，再点击恢复；材料采用前保持材料缺失状态，不发模型读取请求或虚构已读。公开PDF来自${PDF_URL}；期刊原页声明CC BY 4.0，需保留作者、来源及许可。\n本次仅精读物理第9、10页。A与B各自先status/inputs取得真实sourceId，再source-pages确认物理页数；用source-read阅读必要文字，保留实际部分范围，不声称整篇已读。随后本人分别source-read-page(sourceId,page:9)及page:10，每次仅一个明确页码。每次返回实际ImageContent后，立即source-page-reading(sourceId,receiptId,observations,remainingLimitations:[])记录本人具体可见内容、图例/横纵轴/表头/组别/缺失位置、图与表对应关系及看不清之处。不能把工具路径、他人观察或可提取文字当成本人看到图片。不同native执行不能借旧receipt自报新看过；后续需要重新判断时可以重读同页，每人每页最多3次、distinct页数仍严格2。不能用课程图片替代论文原页。\nA/B只依据共同原论文及本人必要方法包独立判断，先各发stage-draft/stage-risk再读对方成果。请说明两页图表各覆盖什么样本/测量范围，是否足以直接比较或支持较广说法；用实际页面定位和具体可见信息，不按题名猜结论、不自行填空。不做任何数字复算，不新建结果数值绑定。B独立初判后实际read A初稿，提出可定位且有依据的stage-critique，可以同意；A实际read批评后另发stage-revision，保留原初稿并说明改动或保留原因；B实际read修订后给stage-verification。导师读取最新修订和B复核，必要时本人读同一两页，用stage-review给仅限本范围的模型裁定；材料不足保留限制。refs/sourceIds仅用真实返回且本人已读的ID。\n课程方法包按当前产品要求取得、应用和独立审阅；课程仅用于方法边界，不是这篇论文的实证。图像工具返回、模型观察、程序完整性和内容支持分别记；没有取得某页实际图像就不能称视觉核验完成。A稿各约350字，B稿各约250字，导师约200字，另存具体图像观察。只使用research_group，不联网检索/下载其他论文、不source-search/source-fetch/literature-search、不analyze/run-analysis、不bash、不读CSV/旧R/C，不批量渲染或扩大到其他页，不循环轮询，不请求新的人的许可。正常发布交接后结束该次回复，等待宿主接续。`;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Only owned native logs. Export hashes and tool identities, never base64 image bodies or auth. */
async function pageTransports(
  profile: string,
  project: ResearchProject & ResearchSourcePageRecords,
) {
  const directory = join(profile, "agent", "sessions"),
    paths = await readdir(directory, { recursive: true });
  return Promise.all(
    project.members
      .filter((member) => member.role !== "librarian")
      .map(async (member) => {
        const file = paths.find((path) => path.endsWith(`_${member.ref.sessionId}.jsonl`));
        if (!file) throw new Error(`Missing actual native log for ${member.role}`);
        const calls: {
          id: string;
          args: Record<string, unknown>;
          at: unknown;
          resultAt?: unknown;
          isError?: boolean;
          images?: { mimeType: unknown; bytes: number; sha256: string }[];
          textHasImageBytes?: boolean;
        }[] = [];
        for (const line of (await readFile(join(directory, file), "utf8")).trim().split("\n")) {
          const entry = object(JSON.parse(line)),
            message = object(entry.message),
            content = Array.isArray(message.content) ? message.content.map(object) : [];
          for (const part of content) {
            const args = object(part.arguments);
            if (
              part.type === "toolCall" &&
              part.name === "research_group" &&
              args.operation === "source-read-page" &&
              typeof part.id === "string"
            )
              calls.push({ id: part.id, args, at: entry.timestamp });
          }
          if (message.role !== "toolResult") continue;
          const call = calls.find((row) => row.id === message.toolCallId);
          if (!call) continue;
          call.resultAt = entry.timestamp;
          call.isError = message.isError === true;
          const imageParts = content.filter((part) => part.type === "image");
          call.images = imageParts.map((part) => {
            if (typeof part.data !== "string")
              throw new Error("Native Pi ImageContent missing actual bytes");
            const bytes = Buffer.from(part.data, "base64");
            if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
              throw new Error("Native image is not a PNG");
            return { mimeType: part.mimeType, bytes: bytes.length, sha256: researchHash(bytes) };
          });
          const textAndDetails = JSON.stringify({
            text: content.filter((part) => part.type === "text"),
            details: message.details,
          });
          call.textHasImageBytes = imageParts.some(
            (part) => typeof part.data === "string" && textAndDetails.includes(part.data),
          );
        }
        return { role: member.role, sessionId: member.ref.sessionId, calls };
      }),
  );
}

test("ordinary UI adopts a real open paper PDF and A/B independently receive specified original pages as native Pi images", async () => {
  test.setTimeout(900_000); // Bounded below the existing live 40-minute ceiling; never expand on failure.
  const deadline = Date.now() + 780_000,
    auth = getRealAuthConfig();
  if (!auth.enabled || !auth.sourceDir)
    throw new Error(auth.skipReason ?? "Explicit live auth opt-in required");
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must select the actual course library");
  const knowledge = await ResearchKnowledge.open(knowledgeDir),
    preparation =
      process.env.RESEARCH_SOURCE_PAGES_PREPARATION_DIR ??
      resolve(__dirname, "../../../..", ".artifacts/m2-source-pages/paper-preparation-20261108"),
    originalPdf = join(preparation, PDF_NAME),
    bytes = await readFile(originalPdf),
    sourceManifest: unknown = JSON.parse(
      await readFile(join(preparation, "source-manifest.json"), "utf8"),
    ),
    article = await readFile(join(preparation, "article.html"), "utf8");
  expect(bytes.length).toBe(610225);
  expect(researchHash(bytes)).toBe(PDF_SHA);
  expect(sourceManifest).toMatchObject({
    source: PDF_URL,
    article: ARTICLE_URL,
    doi: DOI,
    sha256: PDF_SHA,
    pageCount: 14,
    license: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  });
  expect(article).toContain("creativecommons.org/licenses/by/4.0/");
  expect(article).toContain(TITLE);
  const profile = await makeUserDataDir("research-source-pages-live-");
  await chmod(profile, 0o700);
  const workspace = await makeWorkspace("research-source-pages-live"),
    selectedPdf = join(workspace, PDF_NAME);
  await writeFile(selectedPdf, bytes, { flag: "wx" });
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  const plan = {
    beganAt: new Date().toISOString(),
    notice: NOTICE,
    profile,
    workspace,
    originalPdf,
    selectedPdf,
    source: {
      title: TITLE,
      authors: AUTHORS,
      year: "2025",
      doi: DOI,
      article: ARTICLE_URL,
      pdf: PDF_URL,
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      bytes: bytes.length,
      sha256: PDF_SHA,
      pageCount: 14,
    },
    physicalPages: PAGES,
    route: "task/reading, S3 only",
    knowledgePin: knowledge.pin,
    memberTokenBudget: 8_000_000,
    models: {
      lead: "openai-codex/gpt-6.1-sol high",
      reviewer: "openai-codex/gpt-6-astra high",
      mentor: "openai-codex/gpt-6-astra high",
    },
    maxImageReadsPerRole: 6,
    targetDuration: "3–5 minutes aspirational, preserve actual duration and failures",
    timeoutPolicy: "900s fixed, no escalation",
    proofBoundary:
      "UI importer/adoption are real; native OS file-picker result alone is a labelled fixture. Actual provider ImageContent and model observations are R. Semantic quality remains pending independent C.",
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
    await editor.getByLabel("研究材料目录", { exact: true }).fill("");
    await editor.getByLabel("研究入口", { exact: true }).selectOption("task");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("task");
    await editor.getByLabel("单项任务类型", { exact: true }).selectOption("reading");
    await editor.getByLabel("单项任务范围", { exact: true }).fill(SCOPE);
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    await editor.getByLabel("成员 Token 上限", { exact: true }).fill("8000000");
    for (let index = 0; index < FUSION_STAGE_IDS.length; index++)
      for (const role of RESEARCH_ROLES) {
        const modelId = role === "mentor" || role === "reviewer" ? "gpt-6-astra" : "gpt-6.1-sol";
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
      .poll(async () => {
        lastState = await getDesktopState(page);
        const p = lastState.researchGroups?.projects[0];
        return !!p && p.status === "paused" && p.entryInventory?.canStart === false;
      })
      .toBe(true);
    expect(lastState!.researchGroups!.projects[0]!.fusion?.attempts).toEqual([]);
    const panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
    // Picker-result fixture only; actual importer, persisted original and adoption use ordinary UI.
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [selectedPdf],
    );
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).researchGroups?.projects[0]?.importedMaterials?.length,
      )
      .toBe(1);
    const summary = panel
      .locator("summary")
      .filter({ hasText: new RegExp(`^${PDF_NAME.replace(/\./g, "\\.")} ·`) })
      .first();
    await summary.click();
    const item = summary.locator("..");
    await item.getByLabel(`${PDF_NAME} 材料用途`, { exact: true }).selectOption("paper");
    await item
      .getByLabel(`${PDF_NAME} 来源及提供说明`, { exact: true })
      .fill(
        `${AUTHORS} (2025). ${TITLE}. DOI ${DOI}. ${ARTICLE_URL}. 原站PDF公开CC BY 4.0（https://creativecommons.org/licenses/by/4.0/）；保留作者/出处/许可，原件无改动。本次软件验收只读取指定物理9/10页，不称全文已读。`,
      );
    await item.getByLabel(`${PDF_NAME} 提供文本范围`, { exact: true }).selectOption("partial-text");
    await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).researchGroups?.projects[0]?.evidence?.sources.length,
      )
      .toBe(1);
    await expect(summary).toContainText("已采用");
    lastState = await getDesktopState(page);
    const before = lastState.researchGroups!.projects[0]!,
      imported = before.importedMaterials![0]!;
    expect(imported.sha256).toBe(PDF_SHA);
    expect(researchHash(await readFile(imported.original))).toBe(PDF_SHA);
    expect(before.evidence!.sources[0]).toMatchObject({
      materialImportId: imported.id,
      kind: "paper",
      textScope: "partial-text",
    });
    expect(before.fusion!.attempts).toEqual([]);
    await writeFile(
      test.info().outputPath("ui-import-and-adoption.json"),
      JSON.stringify(before, null, 2),
    );
    await page.screenshot({
      path: test.info().outputPath("pdf-imported-and-adopted-before-provider.png"),
    });
    await panel.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    // The click starts an async owner mutation. Wait for actual dispatch before treating
    // the initial paused snapshot as a terminal failure.
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).researchGroups?.projects[0]?.fusion?.attempts.length ?? 0,
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          const p = lastState.researchGroups!.projects[0]!,
            failed = p.fusion!.attempts.filter((attempt) =>
              ["failed", "unknown"].includes(attempt.state),
            );
          if (
            lastState.researchGroups?.error ||
            ["paused", "needs-decision"].includes(p.status) ||
            failed.length
          )
            throw new Error(
              JSON.stringify({
                error: lastState.researchGroups?.error ?? p.error,
                status: p.status,
                failed,
              }),
            );
          const receipts =
            (p as ResearchProject & ResearchSourcePageRecords).sourcePageReceipts ?? [];
          for (const role of ["lead", "reviewer", "mentor"] as const)
            if (receipts.filter((row) => row.role === role).length > 6)
              throw new Error(
                "Bounded source-image read budget exceeded; preserve evidence without further attempts",
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
    const final: ResearchProject & ResearchSourcePageRecords =
      lastState!.researchGroups!.projects[0]!;
    validateSourcePageProject(final);
    expect(researchExecutionRoute(final).stageIds).toEqual(["reading"]);
    expect(researchExecutionRoute(final).requiredRoles).toEqual(["lead", "reviewer", "mentor"]);
    expect(final.evidence!.sources).toHaveLength(1);
    expect(final.evidence!.datasets).toEqual([]);
    expect(final.analyses ?? []).toEqual([]);
    expect(final.analysisRegistry?.runs ?? []).toEqual([]);
    expect(final.fusion!.attempts.every((attempt) => attempt.state === "succeeded")).toBe(true);
    const transports = await pageTransports(profile, final),
      ledger = await researchNativeCallLedger(profile, final),
      receipts = final.sourcePageReceipts ?? [],
      readings = final.sourcePageReadings ?? [];
    for (const role of ["lead", "reviewer"] as const) {
      const own = receipts.filter((row) => row.role === role),
        independent = final.artifacts.find(
          (artifact) =>
            artifact.role === role &&
            artifact.kind === (role === "lead" ? "stage-draft" : "stage-risk"),
        );
      expect(independent).toBeTruthy();
      expect([...new Set(own.map((row) => row.page))].sort((a, b) => a - b)).toEqual([...PAGES]);
      for (const physicalPage of PAGES) {
        const receipt = own.find(
          (row) => row.page === physicalPage && row.at <= independent!.createdAt,
        );
        expect(
          receipt,
          `${role} actually received physical page ${physicalPage} before independent judgment`,
        ).toBeTruthy();
        expect(
          readings.some(
            (reading) =>
              reading.receiptId === receipt!.id &&
              reading.role === role &&
              reading.at <= independent!.createdAt,
          ),
        ).toBe(true);
      }
    }
    for (const receipt of receipts) {
      expect(PAGES).toContain(receipt.page);
      expect(receipt).toMatchObject({
        originalSha256: PDF_SHA,
        pageCount: 14,
        materialImportId: imported.id,
        mimeType: "image/png",
      });
      const call = transports
        .find((row) => row.role === receipt.role)!
        .calls.find((row) => row.id === receipt.callId);
      expect(call).toMatchObject({
        args: { operation: "source-read-page", sourceId: receipt.sourceId, page: receipt.page },
        isError: false,
        textHasImageBytes: false,
        images: [{ mimeType: "image/png", bytes: receipt.bytes, sha256: receipt.imageSha256 }],
      });
      const cacheImage = join(
          workspace,
          ".lancer",
          "research-groups",
          final.id,
          "source-pages",
          receipt.cacheKey,
          "page.png",
        ),
        png = await readFile(cacheImage);
      expect(researchHash(png)).toBe(receipt.imageSha256);
      expect(png.readUInt32BE(16)).toBe(receipt.width);
      expect(png.readUInt32BE(20)).toBe(receipt.height);
      expect(JSON.stringify(final)).not.toContain(png.toString("base64"));
    }
    expect(new Set(receipts.map((receipt) => receipt.cacheKey)).size).toBe(2);
    expect(
      ledger
        .flatMap((member) => member.calls)
        .filter(
          (call) =>
            call.name !== "research_group" ||
            [
              "source-search",
              "source-fetch",
              "literature-search",
              "analyze",
              "run-analysis",
              "request-decision",
            ].includes(String(call.operation)),
        ),
    ).toEqual([]);
    expect(researchHash(await readFile(imported.original))).toBe(PDF_SHA);
    expect(researchHash(await readFile(selectedPdf))).toBe(PDF_SHA);
    expect(researchHash(await readFile(originalPdf))).toBe(PDF_SHA);
    expect(rendererErrors).toEqual([]);
    await writeFile(
      test.info().outputPath("native-pi-source-image-transport.json"),
      JSON.stringify(transports, null, 2),
    );
    await writeFile(
      test.info().outputPath("native-tool-call-ledger.json"),
      JSON.stringify(ledger, null, 2),
    );
    await writeFile(
      test.info().outputPath("project-with-original-page-receipts.json"),
      JSON.stringify(final, null, 2),
    );
    const firstReceipt = (physicalPage: number): ResearchSourcePageReceipt =>
      receipts.find((row) => row.page === physicalPage)!;
    const cHandoff = {
      identity: "pending-independent-content-review",
      notice: NOTICE,
      originalPdf,
      pdfSha256: PDF_SHA,
      sourceMetadata: plan.source,
      physicalPages: PAGES,
      sourcePreviewFiles: PAGES.map((physicalPage) =>
        join(preparation, `page-${physicalPage}.png`),
      ),
      actualCachedPages: PAGES.map((physicalPage) => ({
        page: physicalPage,
        file: join(
          workspace,
          ".lancer",
          "research-groups",
          final.id,
          "source-pages",
          firstReceipt(physicalPage).cacheKey,
          "page.png",
        ),
        sha256: firstReceipt(physicalPage).imageSha256,
      })),
      observations: readings,
      artifacts: final.artifacts,
      questions: [
        "Compare each role's actual page observations with the source image, including graphic legends, axes, table headers, missing cells and page mapping.",
        "Check whether text distinguishes the graph's sample from the adjacent table's sample and limits any cross-figure inference.",
        "Check independent first judgments, precise criticism, justified revisions or retained wording, and final review on the same submitted version.",
      ],
      boundary:
        "This file does not award semantic acceptance; a separate reviewer must inspect original pages and outputs independently.",
    };
    await writeFile(
      test.info().outputPath("independent-C-handoff.json"),
      JSON.stringify(cHandoff, null, 2),
    );
    await page.screenshot({
      path: test.info().outputPath("source-page-reading-final-project.png"),
    });
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw error;
  } finally {
    try {
      if (lastState) {
        const p = lastState.researchGroups?.projects[0];
        if (p) {
          await writeFile(
            test.info().outputPath("last-observed-project.json"),
            JSON.stringify(p, null, 2),
          );
          await writeFile(
            test.info().outputPath("native-boundary.json"),
            JSON.stringify(captureResearchNativeBoundary(lastState, p), null, 2),
          );
          await writeFile(
            test.info().outputPath("native-tool-call-ledger-at-exit.json"),
            JSON.stringify(
              await researchNativeCallLedger(profile, p).catch((error: unknown) => ({
                unavailable: String(error),
              })),
              null,
              2,
            ),
          );
        }
      }
      await writeFile(
        test.info().outputPath("run-outcome.json"),
        JSON.stringify(
          {
            beganAt: plan.beganAt,
            endedAt: new Date().toISOString(),
            nativeEndedAt: nativeEndedAt ?? null,
            failure: failure ?? null,
            independentContentReview: "pending-separate-reviewer",
            profilePreserved: true,
            workspacePreserved: true,
            originalsPreserved: true,
            rendererErrors,
          },
          null,
          2,
        ),
      );
    } finally {
      await harness.close();
    }
  }
});
