import { expect, test } from "@playwright/test";
import { writeFile, chmod, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { RESEARCH_ROLES, type ResearchProject } from "../../contracts/research-group";
import {
  getDesktopState,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
} from "../helpers/electron-app";

test("real providers collaborate through the configured research scope", async () => {
  const fullPaper = process.env.RESEARCH_RUN_SCOPE === "paper";
  test.setTimeout(fullPaper ? 2_400_000 : 900_000);
  const auth = getRealAuthConfig();
  test.skip(!auth.enabled, auth.skipReason);
  const knowledgeDir = process.env.RESEARCH_KNOWLEDGE_DIR;
  if (!knowledgeDir)
    throw new Error("RESEARCH_KNOWLEDGE_DIR must point to a real external local course library.");
  const provider = process.env.PI_GUI_PROVIDER || "openai-codex",
    modelId = process.env.PI_GUI_MODEL || "gpt-6.1-sol";
  const recommendedModels = process.env.RESEARCH_MODEL_PRESET === "balanced";
  const resumeProfile = process.env.RESEARCH_RESUME_PROFILE;
  const librarianSol = process.env.RESEARCH_LIBRARIAN_MODEL === "sol";
  const conditions = process.env.RESEARCH_RECONSIDER_CONDITIONS;
  const budget = process.env.RESEARCH_MEMBER_TOKEN_BUDGET;
  if (
    resumeProfile &&
    ((await realpath(dirname(resumeProfile))) !== (await realpath(tmpdir())) ||
      !basename(resumeProfile).startsWith("research-live-"))
  )
    throw new Error("Only this test's isolated research-live profiles may be resumed.");
  const profile = resumeProfile ?? (await makeUserDataDir("research-live-"));
  const previous = resumeProfile
    ? (
        JSON.parse(await readFile(join(profile, "research-groups.json"), "utf8")) as {
          projects: ResearchProject[];
        }
      ).projects[0]
    : undefined;
  const workspace = previous?.workspacePath ?? (await makeWorkspace("research-live"));
  console.log("[research-live-profile]", JSON.stringify({ profile, workspace }));
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  const harness = await launchDesktop(profile, {
    initialWorkspaces: [workspace],
    ...(resumeProfile
      ? { agentDir: join(profile, "agent") }
      : { realAuthSourceDir: auth.sourceDir }),
    enabledModels: recommendedModels
      ? ["openai-codex/gpt-6-astra", "openai-codex/gpt-6.1-sol", "deepseek/deepseek-flash"]
      : [`${provider}/${modelId}`],
    testMode: "background",
  });
  // Auth remains in the isolated private profile, never in shared test evidence.
  await chmod(join(profile, "agent", "auth.json"), 0o600);
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    const page = await harness.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 980),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    if (!resumeProfile) {
      await openNewThread(page);
      const panel = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
      await panel.getByLabel("课程知识库目录", { exact: true }).fill(knowledgeDir);
      await panel.getByLabel("研究流程版本", { exact: true }).selectOption("legacy");
      await panel
        .getByLabel("研究运行范围", { exact: true })
        .selectOption(fullPaper ? "paper" : "proposal");
      if (fullPaper) {
        await panel.getByLabel("成员 Token 上限", { exact: true }).fill(budget ?? "8000000");
        if (!process.env.RESEARCH_MATERIALS_DIR)
          throw new Error("RESEARCH_MATERIALS_DIR is required for a real paper run.");
        await panel
          .getByLabel("研究材料目录", { exact: true })
          .fill(process.env.RESEARCH_MATERIALS_DIR);
      }
      await expect(panel.getByLabel("课程知识库目录", { exact: true })).toHaveValue(knowledgeDir);
      if (recommendedModels) {
        await expect(
          panel.getByLabel("阶段 1 导师模型", { exact: true }).locator("option"),
        ).toHaveCount(4);
        await panel.getByRole("button", { name: "应用推荐配模", exact: true }).click();
      } else
        for (const stage of fullPaper ? [1, 2, 3, 4, 5, 6, 7] : [1, 2])
          for (const role of RESEARCH_ROLES) {
            const labels = {
              mentor: "导师",
              lead: "研究者 A · 推进",
              reviewer: "研究者 B · 复核",
              librarian: "资料员",
            };
            await panel
              .getByLabel(`阶段 ${stage} ${labels[role]}模型`, { exact: true })
              .selectOption(JSON.stringify({ provider, modelId }));
          }
      await page.screenshot({ path: test.info().outputPath("stage-model-configuration.png") });
      await panel.getByRole("button", { name: "检查并保存连接与阶段配置" }).click();
      await expect(panel).toBeHidden();
      await expect
        .poll(async () => (await getDesktopState(page)).researchGroups?.config.knowledgeDir)
        .toBe(knowledgeDir);
      const thinking = page
        .locator(".model-selector__badge")
        .filter({ hasText: /^(max|xhigh|high|medium)$/ })
        .first();
      if (await thinking.count()) {
        await thinking.click();
        await page.locator(".model-selector__item").filter({ hasText: /^Low$/i }).click();
      }
      await page
        .getByLabel("New thread prompt")
        .fill(
          fullPaper
            ? "请从这个研究想法推进到完整中文论文：想了解葡萄牙公开中学生数学课程数据中，早期成绩与缺勤和期末成绩有什么观察关联。使用已连接的课程方法库与研究材料目录；目录内有 UCI 原始数学 CSV、官方数据说明、两篇已取得正文的研究文献。先打磨问题并审阅初步方案，再做文献综合、冻结研究设计、实际分析并独立复算、写作与全文审阅。只做公开二手数据的探索性分析，不收集新数据、不声称因果效应或已通过新的伦理审批。区分数学与葡语数据，保留零成绩，不把原文作者的预测或因果结论当作本研究结论；注意样本、编码、时点和缺勤解释。研究者自主确定并审阅一个工具支持的分析计划，所用数字必须由 analyze 实算；工具没有的 p 值、置信区间、交叉验证成绩不能补造。论文包含完整章节、真实来源引用和实际分析引用。中间稿简洁，完整终稿2500–5000中文字。若有可修正问题请具体修订再复核，导师按各阶段范围判断，不把探索性二次分析当成干预研究或论文发表。请使用课题组交接工具完成到终稿导出。"
            : "演练任务：以下情境是测试设定，不是用户真实课堂事实。一所普通高中的物理课，有一个约 40 人的可接触班级，暂无第二班可用、伦理审批与具体材料信息。设想给学生实验报告加入 AI 反馈。原想法是只做一次满意度调查，就写成‘AI 提高了实验报告论证质量’。请推进者提出可行方案，复核者检验关键问题，导师审阅。明确区别满意度与论证质量、前后变化与因果效应，先考虑保守的单班改进研究，不坚持因果结论。未知课堂、材料及审批条件列为待确认，不编文献和结果。交付研究问题卡、初步设计、批评清单、修订与复核裁定；本次仅审阅方案，不执行研究。请使用真实知识库和课题组交接工具完成。",
        );
      await page.getByRole("button", { name: "Start thread", exact: true }).click();
    } else {
      const continueButton = page.getByRole("button", {
        name: conditions ? "补充条件并重新审议本阶段" : "恢复未完成工作",
        exact: true,
      });
      await expect(continueButton).toBeVisible();
      if (librarianSol || budget) {
        await page.getByRole("button", { name: "配置阶段、模型与知识库", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
        if (budget) await editor.getByLabel("成员 Token 上限", { exact: true }).fill(budget);
        if (librarianSol)
          for (let phase = 1; phase <= 7; phase++) {
            await editor
              .getByLabel(`阶段 ${phase} 资料员模型`, { exact: true })
              .selectOption(JSON.stringify({ provider: "openai-codex", modelId: "gpt-6.1-sol" }));
            await editor
              .getByLabel(`阶段 ${phase} 资料员思考强度`, { exact: true })
              .selectOption("low");
          }
        await page.screenshot({
          path: test.info().outputPath("explicit-librarian-sol-recovery.png"),
        });
        await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
        await expect(editor).toBeHidden();
      }
      if (conditions) await page.getByLabel("补充条件与再审理由", { exact: true }).fill(conditions);
      await continueButton.click();
    }
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects.length)
      .toBe(1);
    monitor = setInterval(() => {
      void getDesktopState(page)
        .then((s) => {
          const p = s.researchGroups?.projects[0];
          console.log(
            "[research-live]",
            JSON.stringify(
              p
                ? {
                    status: p.status,
                    stage: p.currentStage,
                    tokens: p.members.map((m) => ({
                      role: m.role,
                      totals:
                        s.sessionUsageBySession[`${m.ref.workspaceId}:${m.ref.sessionId}`]?.totals,
                    })),
                    members: p.members.map((m) => `${m.role}:${m.status}`),
                    artifacts: p.artifacts.map((a) => `${a.kind}:${a.verdict ?? ""}`),
                    events: p.events.length,
                    error: p.error,
                  }
                : {},
            ),
          );
        })
        .catch(() => {});
    }, 20_000);
    await expect
      .poll(
        async () =>
          (await getDesktopState(page)).researchGroups?.projects[0]?.events.filter(
            (e) => e.type === "output",
          ).length,
        { timeout: 180_000 },
      )
      .toBeGreaterThanOrEqual(4);
    await page.screenshot({ path: test.info().outputPath("live-team-working.png") });
    await expect
      .poll(
        async () => {
          const p = (await getDesktopState(page)).researchGroups?.projects[0];
          if (p?.error) throw new Error(p.error);
          if (p?.status === "needs-decision")
            throw new Error(
              "Research decision needed at " +
                p.currentStage +
                ": " +
                p.artifacts.at(-1)?.content.slice(0, 700),
            );
          return fullPaper ? !!p?.finalPaper : p?.artifacts.some((a) => a.kind === "review");
        },
        { timeout: fullPaper ? 2_160_000 : 660_000 },
      )
      .toBe(true);
    const p = (await getDesktopState(page)).researchGroups!.projects[0]!;
    await writeFile(test.info().outputPath("research-project.json"), JSON.stringify(p, null, 2));
    const intervals = p.events
      .filter((e) => e.type === "started" && e.runId)
      .map((e) => ({
        role: e.role,
        runId: e.runId,
        start: e.runtimeAt ?? e.at,
        output: p.events.find((o) => o.type === "output" && o.runId === e.runId)?.runtimeAt,
        end: p.events.find((o) => o.type === "finished" && o.runId === e.runId)?.runtimeAt,
      }));
    const overlapping = intervals
      .filter((i) => i.output)
      .some((a, index, all) =>
        all
          .slice(index + 1)
          .some(
            (b) =>
              a.role !== b.role &&
              b.output &&
              Math.max(Date.parse(a.output!), Date.parse(b.output!)) <
                Math.min(
                  Date.parse(a.end ?? new Date().toISOString()),
                  Date.parse(b.end ?? new Date().toISOString()),
                ),
          ),
      );
    const reads = p.events.filter(
      (e) =>
        e.type === "read" &&
        e.producerRunning &&
        e.producerRunId &&
        e.runId &&
        p.artifacts.find((a) => a.id === e.artifactId)?.role !== e.role,
    );
    const revision = p.artifacts.filter((a) => a.kind === "revision").at(-1)!;
    const verification = p.artifacts.filter((a) => a.kind === "verification").at(-1)!;
    const review = p.artifacts.filter((a) => a.kind === "review").at(-1)!;
    const proof = {
      profile,
      workspace,
      projectId: p.id,
      provider,
      modelId,
      modelPreset: recommendedModels ? "balanced" : "single-model",
      runScope: fullPaper ? "paper" : "proposal",
      resumedExistingProfile: !!resumeProfile,
      explicitLibrarianOverride: librarianSol ? "openai-codex/gpt-6.1-sol low" : undefined,
      priorArtifactIds: previous?.artifacts.map((a) => a.id),
      actualArtifactModels: p.artifacts.map((a) => ({
        id: a.id,
        role: a.role,
        kind: a.kind,
        stage: a.stage,
        model: a.model,
      })),
      nativeIntervals: intervals,
      overlappingModelOutputs: overlapping,
      midRunReads: reads,
      revision: revision?.id,
      verification: verification?.id,
      review: review?.id,
      finalStatus: p.status,
      scope: fullPaper
        ? "real providers + real Electron + public secondary education data; exploratory paper, no new data collection or independent reproduction of cited studies"
        : "real provider + real Electron; synthetic research scenario, no real study data or independent paper verification",
    };
    await writeFile(
      test.info().outputPath("collaboration-proof.json"),
      JSON.stringify(proof, null, 2),
    );
    if (previous) {
      expect(p.id).toBe(previous.id);
      expect(p.members.map((m) => m.ref)).toEqual(previous.members.map((m) => m.ref));
      expect(p.artifacts.slice(0, previous.artifacts.length)).toEqual(previous.artifacts);
    }
    expect(overlapping).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(p.members.map((m) => m.ref.sessionId)).size).toBe(4);
    expect(p.packets.every((k) => k.records.length && k.ids.length)).toBe(true);
    expect(RESEARCH_ROLES.every((role) => p.packets.some((k) => k.role === role))).toBe(true);
    expect(verification.refs).toContain(revision.id);
    expect(review.refs).toEqual(expect.arrayContaining([revision.id, verification.id]));
    expect(
      p.events.some(
        (e) => e.type === "read" && e.role === "lead" && revision.refs.includes(e.artifactId ?? ""),
      ),
    ).toBe(true);
    if (fullPaper) {
      expect(p.scope).toBe("paper");
      expect(p.status).toBe("completed");
      expect(p.finalPaper).toBeTruthy();
      expect(
        p.artifacts
          .filter((a) => a.kind === "stage-review" && a.verdict === "accept")
          .map((a) => a.stage),
      ).toEqual(["literature", "design", "analysis", "writing", "audit"]);
      expect(
        p.analyses?.some(
          (a) =>
            a.role === "lead" &&
            p.analyses!.some((b) => b.role === "reviewer" && b.sha256 === a.sha256),
        ),
      ).toBe(true);
      await writeFile(
        test.info().outputPath("final-paper-paths.json"),
        JSON.stringify(p.finalPaper, null, 2),
      );
    }
    expect(errors).toEqual([]);
    if (recommendedModels) {
      expect(p.artifacts.find((a) => a.kind === "assessment")).toMatchObject({
        stage: "question",
        model: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
      });
      expect(p.artifacts.find((a) => a.kind === "critique")).toMatchObject({
        stage: "review",
        model: { provider: "openai-codex", modelId: "gpt-6-astra", thinkingLevel: "high" },
      });
      expect(p.artifacts.find((a) => a.kind === "material")).toMatchObject({
        model: {
          provider: librarianSol ? "openai-codex" : "deepseek",
          modelId: librarianSol ? "gpt-6.1-sol" : "deepseek-flash",
          thinkingLevel: "low",
        },
      });
    }
    await page.screenshot({ path: test.info().outputPath("live-team-reviewed.png") });
    for (const a of p.artifacts)
      await writeFile(test.info().outputPath(`${a.kind}-${a.id.slice(0, 8)}.md`), a.content);
  } finally {
    if (monitor) clearInterval(monitor);
    try {
      const page = await harness.firstWindow();
      const current = (await getDesktopState(page)).researchGroups;
      await writeFile(
        test.info().outputPath("research-current-state.json"),
        JSON.stringify(current, null, 2),
      );
    } catch {
      /* Preserve the application-owned profile if the window has already closed. */
    }
    // Only this isolated test's application is closed.
    await harness.close();
  }
});
