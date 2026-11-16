import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { FUSION_STAGE_IDS } from "../../contracts/research-method";
import type {
  ResearchNumericBinding,
  ResearchResultFieldMetadata,
  ResearchNumericCandidateReview,
} from "../../contracts/research-numeric-bindings";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import { REGISTRY_CSV } from "../helpers/research-analysis-registry-provider";
import { setupResearchNumericBindingFixture } from "../helpers/research-numeric-binding-provider";

type NumericProject = ResearchProject & {
  numericBindings?: ResearchNumericBinding[];
  numericFieldMetadata?: ResearchResultFieldMetadata[];
  numericCandidateReviews?: ResearchNumericCandidateReview[];
};
interface Receipt {
  role: string;
  callId: string;
  args: Record<string, unknown>;
  result: unknown;
  error: boolean;
}
interface CheckReport {
  artifactId: string;
  blocksFormalAcceptance: boolean;
  deterministic: { checks: { bindingId: string; valid: boolean }[]; blockers: unknown[] };
  semantic: {
    unbound: { start: number; end: number; text: string }[];
    reviewedNonResults: { text: string }[];
  };
}
function receipt(value: unknown): Receipt {
  if (
    !value ||
    typeof value !== "object" ||
    !("role" in value) ||
    typeof value.role !== "string" ||
    !("callId" in value) ||
    typeof value.callId !== "string" ||
    !("args" in value) ||
    !value.args ||
    typeof value.args !== "object" ||
    !("error" in value) ||
    typeof value.error !== "boolean" ||
    !("result" in value)
  )
    throw new Error("Invalid fixture receipt");
  return value as Receipt;
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// AC08 E: actual model tools with local deterministic responses and synthetic data.
// The private gate delays only A's second draft response; it never changes product state.
test("four numeric errors block real model acceptance, corrected second revision rebinds without recalculation and survives restart", async () => {
  test.setTimeout(180_000);
  const fixture = await setupResearchNumericBindingFixture();
  let harness = await fixture.launch();
  let page = await harness.firstWindow();
  const snapshots: Record<string, NumericProject> = {};
  const current = async (): Promise<NumericProject> =>
    (await getDesktopState(page)).researchGroups!.projects[0]!;
  const receipts = async () => (await fixture.readNumericReceipts()).map(receipt);
  try {
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(fixture.kb);
    await editor.getByLabel("研究材料目录", { exact: true }).fill("");
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("研究入口", { exact: true }).selectOption("materials");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("paper");
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    await editor.getByLabel("成员 Token 上限", { exact: true }).fill("500000");
    for (let index = 0; index < FUSION_STAGE_IDS.length; index++)
      for (const role of RESEARCH_ROLES) {
        await editor
          .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}模型`, { exact: true })
          .selectOption(
            JSON.stringify({ provider: "research-recovery-fixture", modelId: "gpt-6.1-sol" }),
          );
        await editor
          .getByLabel(`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}思考强度`, { exact: true })
          .selectOption("low");
      }
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await page
      .getByLabel("New thread prompt")
      .fill(
        "FR06合成软件验收：采用已有方案与CSV，真实完成分析后在S7核对数值引用；第一修订故意包含四类错误，程序必须阻断模型接受。只准第二轮纠正重绑重审，不增加分析运行；不宣称完整论文或真实研究结论。",
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects[0]?.status)
      .toBe("paused");
    expect((await current()).fusion!.attempts).toEqual([]);
    const group = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await harness.electronApp.evaluate(
      ({ dialog }, filePaths) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths };
        };
      },
      [fixture.design, fixture.csv],
    );
    await group.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(2);
    for (const file of [fixture.design, fixture.csv]) {
      const name = basename(file);
      const imported = (await current()).importedMaterials!.find((item) => item.name === name)!;
      const item = group.locator(`[data-material-id="${imported.id}"]`);
      await item.locator(":scope > summary").click();
      await item
        .getByLabel(`${name} 来源及提供说明`, { exact: true })
        .fill("本地人工合成的软件验收材料，不是真实观察结论；使用原始文件与缺失记录检验分析链。");
      if (file === fixture.design)
        await item.getByLabel(`${name} 材料用途`, { exact: true }).selectOption("design");
      else {
        await item.getByLabel(`${name} 材料性质`, { exact: true }).selectOption("synthetic");
        await item.getByLabel(`${name} 使用依据`, { exact: true }).selectOption("user-authorized");
      }
      await item.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
      await expect
        .poll(async () => (await current()).evidence!.sources.length)
        .toBe(file === fixture.design ? 1 : 2);
      await item.locator(":scope > summary").click();
    }
    await group.getByRole("button", { name: "清点实际材料", exact: true }).click();
    await expect
      .poll(async () => (await current()).entryInventory?.firstMissingStage)
      .toBe("design");
    const adopted = (snapshots.adoptedBeforeExecution = await current());
    expect(adopted.entryInventory!.canStart).toBe(true);
    expect(adopted.artifacts).toEqual([]);
    expect(adopted.evidence!.datasets).toHaveLength(1);
    const dataset = adopted.evidence!.datasets[0]!;
    expect(dataset.sha256).toBe(hash(REGISTRY_CSV));
    await group.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = await current();
          const failed = p.fusion!.attempts.filter((a) => ["failed", "unknown"].includes(a.state));
          if (failed.length) throw new Error(JSON.stringify(failed));
          const logs = await receipts();
          return (
            p.currentStage === "writing" &&
            p.artifacts.some(
              (a) =>
                a.stage === "writing" &&
                a.kind === "stage-verification" &&
                a.round === 1 &&
                a.verdict === "revise",
            ) &&
            logs.some((r) => r.callId.endsWith("_bad-accept") && r.error)
          );
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    const blocked = (snapshots.badRevisionBlocked = await current());
    const bad = blocked.artifacts.find(
      (a) => a.stage === "writing" && a.kind === "stage-revision" && a.round === 1,
    )!;
    expect(bad.content).toContain("BAD_NUMERIC_REVISION");
    expect(blocked.analysisRegistry!.runs).toHaveLength(6);
    expect(blocked.artifacts.some((a) => a.stage === "audit")).toBe(false);
    expect(
      blocked.artifacts.some(
        (a) =>
          a.stage === "writing" &&
          ["stage-verification", "stage-review"].includes(a.kind) &&
          a.verdict === "accept",
      ),
    ).toBe(false);
    const beforeRuns = structuredClone(blocked.analysisRegistry!.runs);
    const beforeAnalyses = structuredClone(blocked.analyses);
    const badLogs = await receipts();
    const failures = [
      ...new Map(
        badLogs.filter((r) => r.callId.includes("_bad-bind-")).map((r) => [r.callId, r]),
      ).values(),
    ];
    expect(failures).toHaveLength(4);
    for (const key of ["r2", "n", "sign", "unit"]) {
      const failure = failures.find((r) => r.callId.endsWith(`_bad-bind-${key}`))!;
      expect(failure.error, key).toBe(true);
      expect(JSON.stringify(failure.result)).toMatch(
        key === "unit" ? /unit-mismatch/ : /display-mismatch/,
      );
      const binding = failure.args.binding as Record<string, unknown>;
      expect(binding.artifactId).toBe(bad.id);
      const exact = bad.content.slice(Number(binding.start), Number(binding.end));
      if (key === "r2") expect(exact).toBe("0.123");
      if (key === "n") expect(exact).toBe("99");
      if (key === "sign") expect(exact).toMatch(/^-/);
      if (key === "unit") {
        expect(exact).toMatch(/ 小时$/);
        expect(exact).not.toContain("分/小时");
      }
    }
    const badCheckReceipt = badLogs
      .filter(
        (r) =>
          r.args.operation === "numeric-check" &&
          r.args.artifactId === bad.id &&
          r.role === "reviewer",
      )
      .at(-1)!;
    expect(badCheckReceipt.result).toMatchObject({
      artifactId: bad.id,
      blocksFormalAcceptance: true,
      semantic: { reviewedNonResults: expect.any(Array), unbound: expect.any(Array) },
    });
    const badCheck = badCheckReceipt.result as CheckReport;
    expect(badCheck.semantic.unbound).toHaveLength(4);
    expect(new Set(badCheck.semantic.reviewedNonResults.map((c) => c.text))).toEqual(
      new Set(["2026", "17"]),
    );
    for (const failure of failures) {
      const binding = failure.args.binding as Record<string, unknown>;
      expect(
        badCheck.semantic.unbound.some(
          (c) => c.start === binding.start && c.end <= Number(binding.end),
        ),
      ).toBe(true);
    }
    const legalOld = blocked.numericBindings!.filter((b) => b.artifactId === bad.id);
    expect(legalOld).toHaveLength(1);
    expect(legalOld[0]).toMatchObject({
      quantity: "r-squared",
      decimalPlaces: 2,
      rounding: "half-away-from-zero",
    });
    expect(badCheck.deterministic.checks).toContainEqual(
      expect.objectContaining({ bindingId: legalOld[0]!.id, valid: true }),
    );
    const reject = badLogs.find((r) => r.callId.endsWith("_bad-accept"))!;
    expect(reject).toMatchObject({
      role: "reviewer",
      error: true,
      args: { operation: "publish", kind: "stage-verification", verdict: "accept", refs: [bad.id] },
    });
    expect(JSON.stringify(reject.result)).toMatch(/数值|数字|绑定|numeric/);
    const blockedRecord = blocked
      .contentChecks!.filter(
        (record) => record.kind === "numeric-acceptance" && record.target?.artifactId === bad.id,
      )
      .at(-1)!;
    expect(blockedRecord).toMatchObject({
      kind: "numeric-acceptance",
      program: { kind: "program", id: "numeric-acceptance-1" },
      target: { artifactId: bad.id, bodySha256: hash(bad.content) },
      result: "blocked",
      role: "reviewer",
    });
    expect(
      blockedRecord.unboundCandidates.map((candidate) => candidate.start).sort((a, b) => a - b),
    ).toEqual(badCheck.semantic.unbound.map((candidate) => candidate.start).sort((a, b) => a - b));
    const programUI = page.getByTestId("research-content-checks");
    await programUI.locator(":scope > summary").click();
    const blockedUI = programUI
      .locator('[data-check-result="blocked"]')
      .filter({ hasText: bad.id })
      .filter({ hasText: "numeric-acceptance-1" });
    await blockedUI.locator(":scope > summary").click();
    await expect(blockedUI).toContainText("检查时仍有问题");
    await expect(blockedUI).toContainText("程序检查；研究者 B 的内容意见与导师 Agent 裁定另行保留");
    await blockedUI.getByText("检查版本", { exact: true }).click();
    await expect(blockedUI.getByText(`稿件：${bad.id}`, { exact: true })).toBeVisible();
    await blockedUI.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("numeric-program-blocked.png") });
    const artifactsUI = group
      .locator(".research-group-records")
      .filter({ has: page.locator("summary", { hasText: "成果与审阅链" }) });
    if (!(await artifactsUI.evaluate((element) => element.hasAttribute("open"))))
      await artifactsUI.locator(":scope > summary").click();
    const badUI = artifactsUI.locator(".research-group-artifact").filter({ hasText: bad.id });
    await badUI.locator(":scope > summary").click();
    await expect(badUI).toContainText("BAD_NUMERIC_REVISION");
    await expect(badUI).toContainText("0.123");
    await page.screenshot({ path: test.info().outputPath("numeric-four-errors-blocked.png") });
    // Only release the private provider response gate after observing actual rejection.
    await fixture.releaseCorrected();
    await expect
      .poll(
        async () => {
          const p = await current();
          const failed = p.fusion!.attempts.filter((a) => ["failed", "unknown"].includes(a.state));
          if (failed.length) throw new Error(JSON.stringify(failed));
          return (
            p.currentStage === "audit" &&
            p.status === "needs-decision" &&
            p.members.every((m) => m.status !== "running") &&
            p.fusion!.attempts.every((a) => a.state === "succeeded")
          );
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    const corrected = (snapshots.correctedWithoutRecalculation = await current());
    const good = corrected.artifacts.find(
      (a) => a.stage === "writing" && a.kind === "stage-revision" && a.round === 2,
    )!;
    expect(good.content).toContain("CORRECT_NUMERIC_REVISION");
    expect(good.content).not.toContain("BAD_NUMERIC_REVISION");
    expect(
      corrected.artifacts.filter((a) => a.stage === "writing" && a.kind === "stage-revision"),
    ).toHaveLength(2);
    expect(corrected.artifacts.find((a) => a.id === bad.id)).toEqual(bad);
    expect(corrected.analysisRegistry!.runs).toEqual(beforeRuns);
    expect(corrected.analyses).toEqual(beforeAnalyses);
    const goodBindings = corrected.numericBindings!.filter((b) => b.artifactId === good.id);
    expect(goodBindings).toHaveLength(5);
    expect(corrected.numericBindings!.filter((b) => b.artifactId === bad.id)).toEqual(legalOld);
    for (const binding of goodBindings) {
      expect(good.content.slice(binding.start, binding.end)).toBe(binding.exactText);
      expect(binding.bodySha256).toBe(hash(good.content));
      expect(binding.runId).toBe(
        beforeRuns.find((r) => r.planId === "registry-primary" && r.actor === "model:lead")!.id,
      );
      if (binding.quantity === "coefficient") {
        expect(binding.unit).toBe("分/小时");
        const metadata = corrected.numericFieldMetadata!.find(
          (m) => m.id === binding.fieldMetadataId,
        )!;
        expect(metadata).toMatchObject({
          status: "verified",
          provenance: { actor: "model", actorId: "model:reviewer" },
        });
      }
    }
    expect(goodBindings.find((b) => b.path.at(-1) === "x")!.exactText).not.toMatch(/^-/);
    expect(goodBindings.find((b) => b.quantity === "sample-size")!.exactText).toBe("6");
    const goodReviews = corrected.numericCandidateReviews!.filter((r) => r.artifactId === good.id);
    expect(goodReviews).toHaveLength(2);
    expect(new Set(goodReviews.map((r) => r.exactText))).toEqual(new Set(["2026", "17"]));
    for (const review of goodReviews)
      expect(review).toMatchObject({
        classification: "non-result-number",
        bodySha256: hash(good.content),
        provenance: { actor: "model", actorId: "model:reviewer" },
      });
    const finalLogs = await receipts();
    expect(blocked.claims?.claims ?? []).toEqual([]);
    const claim = corrected.claims!.claims.find((entry) => entry.artifactId === good.id)!;
    expect(corrected.claims!.claims).toHaveLength(1);
    expect(claim).toMatchObject({
      id: `numeric-result:${good.id}`,
      category: "research-result",
      bodySha256: hash(good.content),
    });
    expect(claim.exactText).toBe(good.content.slice(claim.start, claim.end));
    expect(claim.exactText).toMatch(/^R²=.*；n=.*；x系数=.*；z系数=.*；合法舍入R²=.*。$/);
    const primary = beforeRuns.find(
      (run) => run.planId === "registry-primary" && run.actor === "model:lead",
    )!;
    expect(claim.evidence).toEqual(
      [
        ["regression", "rSquared"],
        ["regression", "sampleSize"],
        ["regression", "coefficients", "x"],
        ["regression", "coefficients", "z"],
      ].map((path) => ({ kind: "result", runId: primary.id, runSha256: primary.runSha256, path })),
    );
    const claimReviews = corrected.claims!.reviews.filter((review) => review.claimId === claim.id);
    expect(claimReviews).toHaveLength(1);
    expect(claimReviews[0]).toMatchObject({
      conclusion: "supported",
      judgment: "model-semantic-review",
      resolvesReviewIds: [],
      actor: {
        kind: "model",
        role: "reviewer",
        provider: "research-recovery-fixture",
        modelId: "gpt-6.1-sol",
        sessionId: corrected.members.find((member) => member.role === "reviewer")!.ref.sessionId,
      },
    });
    expect(claimReviews[0]!.reason).toContain("不证明真实研究");
    expect(
      corrected.fusion!.attempts.some(
        (attempt) => attempt.nativeRunId === claimReviews[0]!.actor.runId,
      ),
    ).toBe(true);
    for (const operation of ["claim-register", "claim-review", "claim-check"])
      expect(
        finalLogs.some((entry) => entry.args.operation === operation && !entry.error),
        operation,
      ).toBe(true);
    expect(
      finalLogs
        .filter((entry) => entry.args.operation === "claim-check" && entry.role === "reviewer")
        .at(-1)!.result,
    ).toMatchObject({ blocksFormalAcceptance: false, blockers: [], requiresContentReview: true });
    const goodChecks = finalLogs.filter(
      (r) => r.args.operation === "numeric-check" && r.args.artifactId === good.id,
    );
    for (const role of ["reviewer", "mentor"]) {
      const check = goodChecks.filter((r) => r.role === role).at(-1)!;
      expect(check.result).toMatchObject({
        artifactId: good.id,
        blocksFormalAcceptance: false,
        deterministic: { blockers: [] },
        semantic: { unbound: [] },
      });
    }
    expect(
      corrected.artifacts
        .filter((a) => a.stage === "writing" && a.kind === "stage-verification")
        .map((a) => a.verdict),
    ).toEqual(["revise", "accept"]);
    expect(
      corrected.artifacts.find((a) => a.stage === "writing" && a.kind === "stage-review"),
    ).toMatchObject({ verdict: "accept", refs: expect.arrayContaining([good.id]) });
    expect(corrected.artifacts.some((a) => a.stage === "audit")).toBe(false);
    const passedRecords = corrected.contentChecks!.filter(
      (record) =>
        record.kind === "numeric-acceptance" &&
        record.target?.artifactId === good.id &&
        record.result === "passed-at-snapshot",
    );
    for (const role of ["reviewer", "mentor"])
      expect(passedRecords).toContainEqual(
        expect.objectContaining({
          kind: "numeric-acceptance",
          role,
          program: { kind: "program", id: "numeric-acceptance-1" },
          target: { artifactId: good.id, bodySha256: hash(good.content) },
          issues: [],
          unboundCandidates: [],
        }),
      );
    expect(corrected.contentChecks!.find((record) => record.id === blockedRecord.id)).toEqual(
      blockedRecord,
    );
    const claimRecords = corrected.contentChecks!.filter(
      (record) => record.kind === "claim-acceptance" && record.target?.artifactId === good.id,
    );
    for (const role of ["reviewer", "mentor"])
      expect(claimRecords).toContainEqual(
        expect.objectContaining({
          role,
          result: "passed-at-snapshot",
          program: { kind: "program", id: "claim-acceptance-1" },
          target: { artifactId: good.id, bodySha256: hash(good.content) },
          issues: [],
        }),
      );
    expect(
      claimRecords.every((record) => !passedRecords.some((numeric) => numeric.id === record.id)),
    ).toBe(true);
    const passedUI = programUI
      .locator('[data-check-result="passed-at-snapshot"]')
      .filter({ hasText: good.id })
      .filter({ hasText: "numeric-acceptance-1" })
      .first();
    await passedUI.locator(":scope > summary").click();
    await expect(passedUI).toContainText("检查时无数值阻断");
    await expect(passedUI).toContainText("程序检查；研究者 B 的内容意见与导师 Agent 裁定另行保留");
    await expect(programUI).toContainText(
      "新的稿件或数据需要重新检查；数值一致不代表结论或全文已通过审阅",
    );
    await passedUI.getByText("检查版本", { exact: true }).click();
    await expect(passedUI.getByText(`稿件：${good.id}`, { exact: true })).toBeVisible();
    await passedUI.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("numeric-program-passed.png") });
    expect(await readFile(fixture.csv, "utf8")).toBe(REGISTRY_CSV);
    expect(hash(await readFile(dataset.file))).toBe(dataset.sha256);
    const goodUI = artifactsUI.locator(".research-group-artifact").filter({ hasText: good.id });
    await goodUI.locator(":scope > summary").click();
    await expect(goodUI).toContainText("CORRECT_NUMERIC_REVISION");
    await expect(goodUI).toContainText("分/小时");
    await page.screenshot({ path: test.info().outputPath("numeric-corrected-and-rebound.png") });
    const nativeJournal = await fixture.readJournal();
    await harness.close();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    await expect.poll(async () => (await current()).status).toBe("needs-decision");
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await page
      .locator(`.research-project[data-project-id="${corrected.id}"] .research-project__name`)
      .click();
    const restarted = (snapshots.restarted = await current());
    expect(restarted.artifacts).toEqual(corrected.artifacts);
    expect(restarted.analysisRegistry).toEqual(corrected.analysisRegistry);
    expect(restarted.numericBindings).toEqual(corrected.numericBindings);
    expect(restarted.numericFieldMetadata).toEqual(corrected.numericFieldMetadata);
    expect(restarted.numericCandidateReviews).toEqual(corrected.numericCandidateReviews);
    expect(restarted.claims).toEqual(corrected.claims);
    expect(restarted.contentChecks).toEqual(corrected.contentChecks);
    expect(restarted.fusion!.attempts).toEqual(corrected.fusion!.attempts);
    expect(await receipts()).toEqual(finalLogs);
    expect(await fixture.readJournal()).toEqual(nativeJournal);
  } finally {
    try {
      await writeFile(
        test.info().outputPath("numeric-binding-evidence.json"),
        JSON.stringify(
          {
            evidenceLevel:
              "E local deterministic provider, real Pi tools, synthetic CSV; no R/C or complete-paper claim",
            profile: fixture.profile,
            snapshots,
            lastProject: await current().catch(() => undefined),
            numericReceipts: await receipts(),
            nativeJournal: await fixture.readJournal(),
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
