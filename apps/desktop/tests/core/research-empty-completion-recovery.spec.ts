import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import { setupResearchEmptyCompletionFixture } from "../helpers/research-empty-completion-provider";

// AC06/FR14 E: actual Electron actions and native Pi tools; synthetic local provider only.
// Nothing seeds attempts/artifacts or injects runCompleted. This does not establish R/C quality.
test("explicit UI resume recovers a successful empty native completion once, preserving other members' delivery across restart", async () => {
  test.setTimeout(120_000);
  const fixture = await setupResearchEmptyCompletionFixture();
  let harness = await fixture.launch();
  let page = await harness.firstWindow();
  const snapshots: Record<string, ResearchProject> = {};
  const current = async () => (await getDesktopState(page)).researchGroups!.projects[0]!;
  const settled = (p: ResearchProject) =>
    !p.fusion!.attempts.some((a) => ["prepared", "running", "unknown"].includes(a.state)) &&
    p.members.every((m) => m.status !== "running");
  try {
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(fixture.kb);
    await editor.getByLabel("研究材料目录", { exact: true }).fill(fixture.materials);
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("fusion-v2");
    await editor.getByLabel("研究入口", { exact: true }).selectOption("idea");
    await editor.getByLabel("本轮研究目标", { exact: true }).selectOption("question");
    await editor.getByLabel("研究路径", { exact: true }).selectOption("quantitative");
    await editor.getByLabel("成员 Token 上限", { exact: true }).fill("500000");
    for (const role of RESEARCH_ROLES) {
      await editor
        .getByLabel(`阶段 2 ${RESEARCH_ROLE_LABELS[role]}模型`, { exact: true })
        .selectOption(
          JSON.stringify({ provider: "research-recovery-fixture", modelId: "gpt-6.1-sol" }),
        );
      await editor
        .getByLabel(`阶段 2 ${RESEARCH_ROLE_LABELS[role]}思考强度`, { exact: true })
        .selectOption("low");
    }
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await page
      .getByLabel("New thread prompt")
      .fill(
        "确定性软件验收：仅研究实验报告中的证据使用问题卡，不进入后续阶段。导师首轮正常结束但不发布裁定；A、B和资料员照常交付，等用户显式恢复后导师读已有成果完成裁定。材料都是合成测试文本。",
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects.length)
      .toBe(1);
    // A real handoff can legitimately create another native turn. Quiescence after those
    // handoffs, not a fixed number of provider turns, is the no-automatic-replay barrier.
    // No elapsed sleep or injected terminal state is used to establish absence of replay.
    await expect
      .poll(
        async () => {
          const p = await current();
          return (
            p.status === "needs-decision" &&
            settled(p) &&
            p.fusion!.attempts.every((a) => a.state === "succeeded") &&
            p.fusion!.attempts.filter((a) => a.taskId === "v1:question:mentor").at(-1)?.state ===
              "succeeded" &&
            p.fusion!.tasks.find((t) => t.id === "v1:question:mentor")?.state === "pending" &&
            !p.artifacts.some((a) => a.role === "mentor") &&
            p.artifacts.some((a) => a.kind === "stage-verification")
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const before = (snapshots.beforeExplicitResume = await current());
    const taskId = "v1:question:mentor";
    const empty = before.fusion!.attempts.filter((a) => a.taskId === taskId).at(-1)!;
    expect(empty.nativeRunId).toBeTruthy();
    expect(empty.finishedAt).toBeTruthy();
    expect(before.status).toBe("needs-decision");
    expect(new Set(before.fusion!.attempts.map((a) => a.taskId))).toEqual(
      new Set(RESEARCH_ROLES.map((role) => `v1:question:${role}`)),
    );
    expect(before.fusion!.tasks.some((t) => t.continuations.some((c) => !c.attemptId))).toBe(false);
    expect(before.fusion!.tasks.find((t) => t.id === taskId)).toMatchObject({
      state: "pending",
      continuations: [],
    });
    expect(before.artifacts.filter((a) => a.role === "mentor")).toEqual([]);
    expect(new Set(before.artifacts.map((a) => a.kind))).toEqual(
      new Set([
        "stage-material",
        "stage-draft",
        "stage-risk",
        "stage-critique",
        "stage-revision",
        "stage-verification",
      ]),
    );
    for (const role of ["lead", "reviewer", "librarian"])
      expect(before.fusion!.tasks.find((t) => t.id === `v1:question:${role}`)?.state).toBe(
        "completed",
      );
    const originalMembers = before.members.map((m) => m.ref);
    const firstJournal = await fixture.readJournal();
    // Text responses deliberately have no tool operation; they are real stop completions.
    expect(
      firstJournal.some(
        (e) =>
          e.role === "mentor" && e.type === "response" && !e.operation && e.attemptId === empty.id,
      ),
    ).toBe(true);
    expect(firstJournal.some((e) => e.role === "mentor" && e.operation === "publish")).toBe(false);
    await expect(
      page.getByText("EMPTY_COMPLETION: 本次正常结束，尚未发布导师裁定。", { exact: true }).last(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "恢复未完成工作", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("empty-completion-before-resume.png") });
    const stable = (snapshots.quiescentBeforeClick = await current());
    expect(stable.fusion!.attempts).toEqual(before.fusion!.attempts);
    expect(stable.artifacts).toEqual(before.artifacts);
    expect(stable.events.filter((e) => e.type === "handoff")).toEqual(
      before.events.filter((e) => e.type === "handoff"),
    );
    expect(await fixture.readJournal()).toEqual(firstJournal);
    await page.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = await current();
          return p.status === "completed" && settled(p);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const completed = (snapshots.afterExplicitResume = await current());
    expect(completed.revision).toBe(1);
    expect(completed.currentStage).toBe("question");
    expect(completed.members.map((m) => m.ref)).toEqual(originalMembers);
    const added = completed.fusion!.attempts.filter(
      (a) => !before.fusion!.attempts.some((old) => old.id === a.id),
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ taskId, state: "succeeded" });
    expect(added[0]!.nativeRunId).toBeTruthy();
    expect(added[0]!.nativeRunId).not.toBe(empty.nativeRunId);
    expect(completed.fusion!.attempts.filter((a) => a.taskId !== taskId)).toEqual(
      before.fusion!.attempts.filter((a) => a.taskId !== taskId),
    );
    expect(completed.fusion!.attempts.find((a) => a.id === empty.id)).toEqual(empty);
    const continuation = completed.fusion!.tasks.find((t) => t.id === taskId)!.continuations;
    expect(continuation).toEqual([
      {
        id: `fusion-user-resume:${taskId}:v${empty.taskVersion}:${empty.id}`,
        at: expect.any(String),
        reason: expect.stringContaining("用户显式恢复"),
        attemptId: added[0]!.id,
      },
    ]);
    for (const artifact of before.artifacts)
      expect(completed.artifacts.filter((a) => a.id === artifact.id)).toEqual([artifact]);
    const reviews = completed.artifacts.filter((a) => a.kind === "stage-review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ role: "mentor", stage: "question", verdict: "accept" });
    const required = before.artifacts.filter((a) =>
      ["stage-revision", "stage-verification"].includes(a.kind),
    );
    expect(reviews[0]!.refs).toEqual(expect.arrayContaining(required.map((a) => a.id)));
    for (const artifact of required)
      expect(
        completed.events.some(
          (e) =>
            e.type === "read" && e.role === "mentor" && e.artifactId === artifact.id && e.runId,
        ),
      ).toBe(true);
    expect(
      new Set(
        completed.events
          .filter((e) => e.type === "source-read" && e.role === "mentor")
          .map((e) => e.sourceId),
      ),
    ).toEqual(new Set(["RECOVERY-A", "RECOVERY-B"]));
    const completedJournal = await fixture.readJournal();
    const newRequests = completedJournal.filter(
      (e) => e.type === "request" && !firstJournal.some((old) => old.requestId === e.requestId),
    );
    expect(newRequests.length).toBeGreaterThan(0);
    expect(new Set(newRequests.map((e) => e.role))).toEqual(new Set(["mentor"]));
    expect(newRequests.filter((e) => e.operation === "publish").map((e) => e.kind)).toEqual([
      "stage-review",
    ]);
    await page.screenshot({ path: test.info().outputPath("empty-completion-recovered.png") });
    await harness.close();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    await expect.poll(async () => (await current()).status).toBe("completed");
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await page
      .locator(`.research-project[data-project-id="${completed.id}"] .research-project__name`)
      .click();
    await expect(page.getByRole("button", { name: "恢复未完成工作", exact: true })).toBeHidden();
    const restarted = (snapshots.afterRestart = await current());
    expect(restarted.artifacts).toEqual(completed.artifacts);
    expect(restarted.fusion!.attempts).toEqual(completed.fusion!.attempts);
    expect(restarted.fusion!.tasks.find((t) => t.id === taskId)!.continuations).toEqual(
      continuation,
    );
    expect(restarted.members.map((m) => m.ref)).toEqual(originalMembers);
    expect(await fixture.readJournal()).toEqual(completedJournal);
  } finally {
    try {
      await writeFile(
        test.info().outputPath("empty-completion-evidence.json"),
        JSON.stringify(
          {
            evidenceLevel:
              "E: deterministic local provider with real Electron/Pi tools; synthetic source, no external R/content C claim",
            profile: fixture.profile,
            snapshots,
            lastProject: await current().catch(() => undefined),
            providerJournal: await fixture.readJournal(),
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
