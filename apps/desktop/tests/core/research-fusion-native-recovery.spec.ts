import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchProject,
} from "../../contracts/research-group";
import { getDesktopState, openNewThread } from "../helpers/electron-app";
import { setupResearchFusionRecoveryFixture } from "../helpers/research-fusion-recovery-provider";

// AC05/06 E: real Electron controls + Pi native runs/tools with a deterministic local provider.
// No seeded task state, injected native events, external-provider R, or research-quality C claim.
test("published material survives a native failure, local retry and multi-run pause/restart resume only unfinished work", async () => {
  test.setTimeout(180_000);
  const fixture = await setupResearchFusionRecoveryFixture();
  let harness = await fixture.launch();
  let page = await harness.firstWindow();
  const snapshots: Record<string, ResearchProject> = {};
  const current = async () => (await getDesktopState(page)).researchGroups!.projects[0]!;
  const capture = async (name: string) => {
    snapshots[name] = await current();
    return snapshots[name]!;
  };
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
        "仅为确定性软件验收：研究实验报告的证据使用，只有合成原文，目标止于问题卡。资料员先交第一批，后续失败时A/B继续使用已交批次；恢复时不重复合入成果。",
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).researchGroups?.projects.length)
      .toBe(1);
    const initialMembers = (await current()).members.map((member) => member.ref);
    expect(new Set(initialMembers.map((ref) => `${ref.workspaceId}/${ref.sessionId}`)).size).toBe(
      4,
    );
    await expect
      .poll(
        async () => (await current()).artifacts.filter((a) => a.kind === "stage-material").length,
        { timeout: 30_000 },
      )
      .toBe(1);
    const firstBatch = (await capture("first-batch-published")).artifacts.find(
      (a) => a.kind === "stage-material",
    )!;
    expect(firstBatch.content).toContain("第一批材料");
    await fixture.setGates({ failLibrarianAfterFirstBatch: true, finishRemainingWork: false });
    await expect
      .poll(async () =>
        (await current()).fusion!.attempts.some(
          (a) => a.taskId === "v1:question:librarian" && a.state === "failed",
        ),
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const p = await current();
          return (
            ["lead", "reviewer"].every((role) =>
              p.events.some(
                (event) =>
                  event.type === "read" &&
                  event.role === role &&
                  event.artifactId === firstBatch.id,
              ),
            ) &&
            p.artifacts.some((a) => a.kind === "stage-draft") &&
            p.artifacts.some((a) => a.kind === "stage-critique")
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const failed = await capture("failed-producer-consumed-batch");
    const failedAttempt = failed.fusion!.attempts.find(
      (a) => a.taskId === "v1:question:librarian" && a.state === "failed",
    )!;
    expect(failedAttempt.nativeRunId).toBeTruthy();
    expect(failedAttempt.finishedAt).toBeTruthy();
    expect(failedAttempt.error).toContain("RECOVERY_FIXTURE_NATIVE_FAILURE_AFTER_PUBLISHED_BATCH");
    for (const role of ["lead", "reviewer"] as const) {
      const receipt = failed.events.find(
        (event) =>
          event.type === "read" && event.role === role && event.artifactId === firstBatch.id,
      )!;
      expect(receipt.runId).toBeTruthy();
      expect(Date.parse(receipt.at)).toBeGreaterThanOrEqual(Date.parse(failedAttempt.finishedAt!));
      const output = failed.artifacts.find(
        (a) => a.kind === (role === "lead" ? "stage-draft" : "stage-critique"),
      )!;
      expect(Date.parse(output.createdAt)).toBeGreaterThanOrEqual(Date.parse(receipt.at));
    }
    expect(failed.artifacts.find((a) => a.id === firstBatch.id)).toEqual(firstBatch);
    expect(failed.status).toBe("running");
    expect(failed.fusion!.tasks.find((task) => task.id === "v1:question:librarian")!.state).toBe(
      "failed",
    );

    const controls = page.getByTestId("research-task-controls");
    await controls.locator(":scope > summary").click();
    const retry = controls.locator('[data-task-id="v1:question:librarian"]');
    await retry.locator("summary").click();
    await retry
      .getByLabel("恢复说明", { exact: true })
      .fill("只继续资料员未完成的第二批，第一批和A/B已交成果保留。");
    await retry.getByRole("button", { name: "只恢复这项任务", exact: true }).click();
    await expect
      .poll(
        async () => {
          const p = await current();
          const attempts = p.fusion!.attempts.filter((a) => a.taskId === "v1:question:librarian");
          return (
            p.artifacts.filter((a) => a.kind === "stage-material").length === 2 &&
            attempts.length === 2 &&
            attempts.at(-1)?.state === "succeeded" &&
            p.fusion!.tasks.find((t) => t.id === "v1:question:librarian")?.state === "completed"
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const retried = await capture("local-retry-completed");
    const addedAttempts = retried.fusion!.attempts.filter(
      (attempt) => !failed.fusion!.attempts.some((old) => old.id === attempt.id),
    );
    expect(addedAttempts.map((attempt) => attempt.taskId)).toEqual(["v1:question:librarian"]);
    expect(retried.fusion!.retryRequests).toHaveLength(1);
    expect(retried.artifacts.filter((a) => a.id === firstBatch.id)).toEqual([firstBatch]);
    expect(
      retried.artifacts.filter(
        (a) => a.kind === "stage-material" && a.content.includes("第一批材料"),
      ),
    ).toHaveLength(1);

    // Wait for distinct real native runs, not merely task state or fixture response timers.
    await expect
      .poll(async () => {
        const p = await current();
        return new Set(
          p
            .fusion!.attempts.filter(
              (a) => a.state === "running" && a.nativeRunId && a.taskId !== "v1:question:librarian",
            )
            .map((a) => a.nativeRunId),
        ).size;
      })
      .toBeGreaterThanOrEqual(2);
    const beforePause = await capture("multiple-native-runs-before-pause");
    const activeBeforePause = beforePause.fusion!.attempts.filter(
      (a) => a.state === "running" && a.nativeRunId,
    );
    expect(new Set(activeBeforePause.map((a) => a.taskId)).size).toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "暂停全组", exact: true }).click();
    await expect
      .poll(async () => {
        const p = await current();
        return (
          p.status === "paused" &&
          !p.fusion!.attempts.some((a) => ["prepared", "running", "unknown"].includes(a.state)) &&
          p.members.every((m) => m.status !== "running")
        );
      })
      .toBe(true);
    const paused = await capture("paused-native-cancellations-confirmed");
    for (const attempt of activeBeforePause)
      expect(paused.fusion!.attempts.find((a) => a.id === attempt.id)?.state).toBe("cancelled");
    expect(paused.artifacts).toEqual(beforePause.artifacts);
    expect(paused.members.map((member) => member.ref)).toEqual(initialMembers);
    await page.screenshot({ path: test.info().outputPath("fusion-recovery-paused.png") });
    const requestsBeforeRestart = (await fixture.readJournal()).filter(
      (event) => event.type === "request",
    );
    await harness.close();
    harness = await fixture.launch();
    page = await harness.firstWindow();
    await expect.poll(async () => (await current()).status).toBe("paused");
    const restarted = await capture("restarted-without-replay");
    expect(restarted.members.map((member) => member.ref)).toEqual(initialMembers);
    expect(restarted.artifacts).toEqual(paused.artifacts);
    expect(restarted.fusion!.attempts).toEqual(paused.fusion!.attempts);
    expect((await fixture.readJournal()).filter((event) => event.type === "request")).toEqual(
      requestsBeforeRestart,
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await page
      .locator(`.research-project[data-project-id="${restarted.id}"] .research-project__name`)
      .click();
    await expect(page.getByRole("button", { name: "恢复未完成工作", exact: true })).toBeVisible();
    // The provider gate permits remaining responses only; the product must actually dispatch them.
    await fixture.setGates({ failLibrarianAfterFirstBatch: true, finishRemainingWork: true });
    await page.getByRole("button", { name: "恢复未完成工作", exact: true }).click();
    await expect.poll(async () => (await current()).status, { timeout: 30_000 }).toBe("completed");
    const completed = await capture("only-unfinished-work-resumed");
    expect(completed.currentStage).toBe("question");
    expect(completed.members.map((member) => member.ref)).toEqual(initialMembers);
    expect(completed.fusion!.attempts.filter((a) => a.taskId === "v1:question:librarian")).toEqual(
      paused.fusion!.attempts.filter((a) => a.taskId === "v1:question:librarian"),
    );
    const resumed = completed.fusion!.attempts.filter(
      (a) => !paused.fusion!.attempts.some((old) => old.id === a.id),
    );
    expect(resumed.length).toBeGreaterThanOrEqual(2);
    expect(resumed.every((a) => activeBeforePause.some((old) => old.taskId === a.taskId))).toBe(
      true,
    );
    for (const artifact of paused.artifacts)
      expect(completed.artifacts.filter((a) => a.id === artifact.id)).toEqual([artifact]);
    expect(completed.artifacts.filter((a) => a.kind === "stage-material")).toHaveLength(2);
    for (const kind of [
      "stage-draft",
      "stage-risk",
      "stage-critique",
      "stage-revision",
      "stage-verification",
      "stage-review",
    ])
      expect(
        completed.artifacts.filter((a) => a.kind === kind),
        `${kind} is not merged twice`,
      ).toHaveLength(1);
    const nativeIds = completed.fusion!.attempts.flatMap((a) =>
      a.nativeRunId ? [a.nativeRunId] : [],
    );
    expect(new Set(nativeIds).size).toBe(nativeIds.length);
    const state = await getDesktopState(page);
    for (const ref of initialMembers)
      expect(
        state.workspaces
          .find((workspace) => workspace.id === ref.workspaceId)!
          .sessions.filter((session) => session.id === ref.sessionId),
      ).toHaveLength(1);
    const afterRestartRequests = (await fixture.readJournal()).filter(
      (event) =>
        event.type === "request" &&
        !requestsBeforeRestart.some((old) => old.requestId === event.requestId),
    );
    expect(afterRestartRequests.some((event) => event.role === "librarian")).toBe(false);
    await page.screenshot({ path: test.info().outputPath("fusion-recovery-completed.png") });
  } finally {
    try {
      const state = await getDesktopState(page).catch(() => undefined);
      await writeFile(
        test.info().outputPath("fusion-native-recovery-evidence.json"),
        JSON.stringify(
          {
            evidenceLevel:
              "E deterministic local provider/native Pi tools; no external R or content C claim",
            profile: fixture.profile,
            snapshots,
            finalState: state?.researchGroups,
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
