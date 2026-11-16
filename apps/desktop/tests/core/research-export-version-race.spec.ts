import { expect, test } from "@playwright/test";
import { access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DesktopAppState } from "../../contracts/desktop-state";
import type { ResearchProject } from "../../contracts/research-group";
import {
  getDesktopState,
  launchDesktop,
  openNewThread,
  type DesktopHarness,
} from "../helpers/electron-app";
import { captureResearchNativeBoundary } from "../helpers/research-live-evidence";
import { registeredAnalysisNativeEvidence } from "../helpers/research-registered-analysis-evidence";
import {
  EXPORT_RACE_NEW_CLAIM,
  EXPORT_RACE_NEW_INPUT,
  EXPORT_RACE_OLD_REFS_CALL_ID,
  EXPORT_RACE_OLD_REFS_ERROR,
  EXPORT_RACE_V2_PROPOSAL_READY,
  installResearchExportVersionRace,
  readResearchExportVersionRace,
  readResearchExportVersionRaceSdkProbe,
  releaseResearchExportVersionRace,
  setupResearchExportVersionRace,
  type ExportVersionRaceSnapshot,
} from "../helpers/research-export-version-race";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const NOTICE =
  "E deterministic native-tool/real filesystem/UI proof using the existing synthetic seven-stage legacy fixture and shared coordinator/export implementation. No repository/coordinator/state-result mock, no real provider, no Word/DOCX or native OS-open claim. The filesystem barrier controls only when the real first export mkdir proceeds; all file data and results pass through unchanged.";

async function exists(file: string) {
  return access(file)
    .then(() => true)
    .catch((error: unknown) => {
      if (object(error).code === "ENOENT") return false;
      throw error;
    });
}

test.describe.configure({ retries: 0 });
test("a new UI claim arrives during export and its real published v2 manuscript cannot inherit v1 acceptance", async () => {
  test.setTimeout(150_000);
  const fixture = await setupResearchExportVersionRace();
  const plan = {
    notice: NOTICE,
    profile: fixture.profile,
    workspace: fixture.workspace,
    materials: fixture.materials,
    newInput: EXPORT_RACE_NEW_INPUT,
    boundary:
      "Ordinary composer input must arrive at the actual main IPC handler while export mkdir is held. The request remains unresolved and v1 stays unchanged until release. A real sending-guard rejection is recorded and only that branch permits one later UI resubmission; no blind retry or sleep.",
    v2Fixture:
      "Actual v2 native tools save A's new proposal and B's independent pending assessment. A then messages the real proposal ID to the mentor, who reads it and attempts exactly one stale-v1-ref accept that must be rejected. No v2 accept or new seven-stage run is supplied; this is not content-quality coverage.",
    sdkProbe:
      "Test-only passthrough SessionSupervisor emit/mapAgentEvent metadata, scoped to the owned workspace. Nonzero actual counters are required; no messages, tool content, auth or product state is captured or changed. Full metadata is retained separately from the polling summary.",
  };
  await writeFile(test.info().outputPath("run-plan.json"), JSON.stringify(plan, null, 2));
  let harness: DesktopHarness | undefined,
    lastState: DesktopAppState | undefined,
    failure: string | undefined;
  let lastControl: ExportVersionRaceSnapshot | null = null;
  let instrumentationInstalled = false;
  let sdkProbeReadError: string | null = null;
  const snapshots: Record<string, ResearchProject> = {},
    rendererErrors: string[] = [],
    packetHashes: Record<string, string> = {};
  let submissionBranch: "queued-and-applied" | "queued-then-sending-guard-ui-resubmission" | null =
    null;
  try {
    harness = await launchDesktop(fixture.profile, {
      agentDir: fixture.agentDir,
      initialWorkspaces: [fixture.workspace],
      testMode: "background",
      scrubProviderEnv: true,
    });
    const page = await harness.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    // launchDesktop can return before main IPC registration finishes. Wait for the
    // actual renderer/preload and a successful native state request before wrapping IPC.
    lastState = await getDesktopState(page);
    await installResearchExportVersionRace(harness, fixture);
    instrumentationInstalled = true;
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await openNewThread(page);
    const editor = page.getByRole("dialog", { name: "配置课题组阶段与模型", exact: true });
    await editor.getByLabel("课程知识库目录", { exact: true }).fill(fixture.kb);
    await editor.getByLabel("研究流程版本", { exact: true }).selectOption("legacy");
    await editor.getByLabel("研究运行范围", { exact: true }).selectOption("paper");
    await editor.getByLabel("研究材料目录", { exact: true }).fill(fixture.materials);
    await editor.getByRole("button", { name: "应用推荐配模", exact: true }).click();
    await editor.getByRole("button", { name: "检查并保存连接与阶段配置", exact: true }).click();
    await expect(editor).toBeHidden();
    await page
      .getByLabel("New thread prompt")
      .fill(
        "AC31第一版合成软件演练：完成既有七阶段工具链与有限关联稿，检查同版Markdown、HTML和溯源导出。不能声称因果或推广至所有学校。所有数据和提供商回复均为明确的本地合成fixture。",
      );
    await page.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          const p = lastState.researchGroups?.projects[0];
          if (p?.error || lastState.researchGroups?.error)
            throw new Error(p?.error ?? lastState.researchGroups!.error);
          lastControl = await readResearchExportVersionRace(harness!);
          return lastControl.held && !!lastControl.enteredAt && !!lastControl.exportDirectory;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const held = lastControl!,
      before = (snapshots.exportHeldBeforeNewInput = lastState!.researchGroups!.projects[0]!);
    expect(
      held.sdkProbe.emitCalls,
      "SDK emit probe must observe the actual cached class",
    ).toBeGreaterThan(0);
    expect(
      held.sdkProbe.mapCalls,
      "SDK mapping probe must observe actual agent events",
    ).toBeGreaterThan(0);
    expect(before.revision).toBe(1);
    expect(before.status).toBe("running");
    expect(before.finalPaper).toBeUndefined();
    const manuscript = before.artifacts
      .filter(
        (artifact) =>
          artifact.stage === "audit" &&
          artifact.role === "lead" &&
          ["stage-draft", "stage-revision"].includes(artifact.kind),
      )
      .at(-1)!;
    expect(manuscript.revision).toBe(1);
    expect(held.exportDirectory).toBe(
      join(fixture.workspace, ".lancer", "research-groups", before.id, `paper-v1-${manuscript.id}`),
    );
    expect(await exists(join(held.exportDirectory!, "论文终稿.md"))).toBe(false);
    expect(lastState!.selectedSessionId).toBe(before.root.sessionId);
    expect(lastState!.selectedWorkspaceId).toBe(before.root.workspaceId);
    const composer = page.getByTestId("composer");
    await composer.fill(EXPORT_RACE_NEW_INPUT);
    await composer.press("Enter");
    await expect
      .poll(async () => {
        lastControl = await readResearchExportVersionRace(harness!);
        return lastControl.submissions.length;
      })
      .toBe(1);
    const arrived = lastControl!;
    expect(arrived.held).toBe(true);
    expect(arrived.releaseRequestedAt).toBeNull();
    expect(arrived.submissions[0]).toMatchObject({
      text: EXPORT_RACE_NEW_INPUT,
      outcome: "pending",
      settledAt: null,
    });
    expect(arrived.writes).toEqual([]);
    lastState = await getDesktopState(page);
    const queued = (snapshots.newInputArrivedWhileExportHeld =
      lastState.researchGroups!.projects[0]!);
    expect(queued.revision).toBe(1);
    expect(queued.inputHistory).toEqual(before.inputHistory);
    expect(queued.artifacts).toEqual(before.artifacts);
    expect(queued.finalPaper).toBeUndefined();
    expect(await exists(join(held.exportDirectory!, "论文终稿.md"))).toBe(false);
    await writeFile(
      test.info().outputPath("arrival-during-export.json"),
      JSON.stringify(
        {
          held,
          arrived,
          project: queued,
          assertion:
            "Actual UI IPC call arrived while actual export mkdir was held; request unresolved, no new revision applied. Internal queue timing is not injected.",
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: test.info().outputPath("new-input-arrived-export-held.png") });
    await releaseResearchExportVersionRace(harness);
    await expect
      .poll(
        async () => {
          lastControl = await readResearchExportVersionRace(harness!);
          return lastControl.submissions[0]?.outcome !== "pending";
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const first = lastControl!.submissions[0]!;
    if (first.outcome === "rejected") {
      expect(first.error).toContain("成员仍在停止");
      submissionBranch = "queued-then-sending-guard-ui-resubmission";
      await expect(composer).toHaveValue(EXPORT_RACE_NEW_INPUT);
      await expect
        .poll(
          async () => {
            lastState = await getDesktopState(page);
            const p = lastState.researchGroups!.projects[0]!;
            return (
              p.revision === 1 &&
              p.status === "completed" &&
              captureResearchNativeBoundary(lastState, p).activeNativeAtCapture.length === 0
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      snapshots.firstSubmitRejectedAndDraftRetained = lastState!.researchGroups!.projects[0]!;
      await page.screenshot({
        path: test.info().outputPath("sending-guard-retained-ui-draft.png"),
      });
      // Exactly one ordinary UI resubmission, only after the observed real guard rejection.
      await composer.press("Enter");
      await expect
        .poll(
          async () => {
            lastControl = await readResearchExportVersionRace(harness!);
            return (
              lastControl.submissions.length === 2 &&
              lastControl.submissions[1]!.outcome !== "pending"
            );
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      expect(lastControl!.submissions[1]!.outcome).toBe("resolved");
    } else {
      expect(first.outcome).toBe("resolved");
      submissionBranch = "queued-and-applied";
    }
    await expect
      .poll(
        async () => {
          lastState = await getDesktopState(page);
          const p = lastState.researchGroups!.projects[0]!;
          if (p.members.some((member) => member.status === "failed"))
            throw new Error(JSON.stringify(p.members));
          return (
            p.revision === 2 &&
            p.status === "needs-decision" &&
            captureResearchNativeBoundary(lastState, p).activeNativeAtCapture.length === 0
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const current = (snapshots.versionTwoPendingReview = lastState!.researchGroups!.projects[0]!);
    lastControl = await readResearchExportVersionRace(harness);
    expect(current.id).toBe(before.id);
    expect(current.members.map((member) => member.ref)).toEqual(
      before.members.map((member) => member.ref),
    );
    expect(current.revision).toBe(2);
    expect(current.objective).toContain(EXPORT_RACE_NEW_INPUT);
    expect(
      current.inputHistory!.filter((input) => input.text === EXPORT_RACE_NEW_INPUT),
    ).toHaveLength(1);
    expect(current.inputHistory!.at(-1)).toMatchObject({
      revision: 2,
      text: EXPORT_RACE_NEW_INPUT,
      source: { kind: "explicit-submit" },
    });
    expect(current.currentStage).toBe("question");
    expect(current.finalPaper).toBeUndefined();
    const v2Artifacts = current.artifacts.filter((artifact) => artifact.revision === 2),
      proposal = v2Artifacts.find(
        (artifact) => artifact.role === "lead" && artifact.kind === "proposal",
      )!,
      assessment = v2Artifacts.find(
        (artifact) => artifact.role === "reviewer" && artifact.kind === "assessment",
      )!;
    expect(v2Artifacts).toHaveLength(2);
    expect(proposal).toBeTruthy();
    expect(assessment).toBeTruthy();
    expect(proposal.content).toContain(EXPORT_RACE_NEW_CLAIM);
    expect(proposal.content).toContain("待审");
    expect(assessment.content).toContain("独立待审意见");
    expect(v2Artifacts.some((artifact) => artifact.verdict === "accept")).toBe(false);
    expect(v2Artifacts.some((artifact) => ["review", "stage-review"].includes(artifact.kind))).toBe(
      false,
    );
    expect(current.error).toContain("审阅链尚未闭合");
    const oldAudit = current.artifacts.find(
      (artifact) =>
        artifact.revision === 1 &&
        artifact.stage === "audit" &&
        artifact.kind === "stage-review" &&
        artifact.verdict === "accept",
    )!;
    expect(oldAudit).toBeTruthy();
    const inputAt = current.inputHistory!.at(-1)!.at;
    expect(Date.parse(proposal.createdAt)).toBeGreaterThanOrEqual(Date.parse(inputAt));
    expect(Date.parse(proposal.createdAt)).toBeGreaterThanOrEqual(
      Date.parse(lastControl!.resumedAt!),
    );
    const native = await registeredAnalysisNativeEvidence(fixture.profile, current, true);
    const nativeResult = (text: string | undefined) => {
      const parsed = object(JSON.parse(text ?? "null"));
      return parsed.nextStage ? object(parsed.result) : parsed;
    };
    const nativeRunFor = (role: string, at: string, resultAt: string | undefined) => {
      expect(resultAt).toBeTruthy();
      const starts = current.events.filter(
        (event) =>
          event.type === "started" &&
          event.role === role &&
          event.revision === 2 &&
          !!event.runId &&
          Date.parse(event.runtimeAt ?? event.at) <= Date.parse(at),
      );
      const start = starts
        .filter((start) =>
          current.events.some(
            (event) =>
              event.type === "finished" &&
              event.role === role &&
              event.runId === start.runId &&
              Date.parse(event.runtimeAt ?? event.at) >= Date.parse(resultAt!),
          ),
        )
        .at(-1);
      expect(start, `Actual native interval missing for ${role} call at ${at}`).toBeTruthy();
      return start!.runId!;
    };
    const roleCalls = (role: string) => native.find((member) => member.role === role)!.calls;
    const v2Calls = native.flatMap((member) =>
      member.calls
        .filter((call) => Date.parse(call.at) >= Date.parse(inputAt))
        .map((call) => ({ role: member.role, ...call })),
    );
    for (const member of native) expect(member.file).toBeTruthy();
    const proposalCall = roleCalls("lead").find((call) => call.id === proposal.toolCallId)!;
    const assessmentCall = roleCalls("reviewer").find((call) => call.id === assessment.toolCallId)!;
    for (const [role, artifact, call] of [
      ["lead", proposal, proposalCall],
      ["reviewer", assessment, assessmentCall],
    ] as const) {
      expect(call).toMatchObject({
        name: "research_group",
        isError: false,
        args: {
          operation: "publish",
          revision: 2,
          kind: artifact.kind,
          content: artifact.content,
          refs: [],
        },
      });
      expect(nativeResult(call.resultText).id).toBe(artifact.id);
      const runId = nativeRunFor(role, call.at, call.resultAt);
      const knowledgeCall = roleCalls(role).find(
        (item) =>
          item.args.operation === "knowledge" &&
          !item.isError &&
          Date.parse(item.at) >= Date.parse(inputAt) &&
          Date.parse(item.resultAt ?? "") <= Date.parse(artifact.createdAt) &&
          nativeResult(item.resultText).revision === 2,
      )!;
      expect(knowledgeCall).toBeTruthy();
      expect(nativeRunFor(role, knowledgeCall.at, knowledgeCall.resultAt)).toBe(runId);
      const packet = current.packets.find(
        (packet) => packet.id === nativeResult(knowledgeCall.resultText).id,
      )!;
      expect(packet).toMatchObject({ role, revision: 2 });
      expect(packet.records.length).toBeGreaterThan(0);
    }
    for (const sourceId of ["FIXTURE-A", "FIXTURE-B"]) {
      const call = roleCalls("lead").find(
        (call) =>
          call.args.operation === "source-read" &&
          call.args.sourceId === sourceId &&
          !call.isError &&
          Date.parse(call.at) >= Date.parse(inputAt) &&
          Date.parse(call.resultAt ?? "") <= Date.parse(proposal.createdAt),
      )!;
      expect(call).toBeTruthy();
      expect(nativeRunFor("lead", call.at, call.resultAt)).toBe(
        nativeRunFor("lead", proposalCall.at, proposalCall.resultAt),
      );
      expect(
        current.sourceReads!.some(
          (read) =>
            read.sessionId ===
              current.members.find((member) => member.role === "lead")!.ref.sessionId &&
            read.sourceId === sourceId &&
            read.sourceSha256 ===
              current.evidence!.sources.find((source) => source.id === sourceId)!.sha256 &&
            read.evidenceRef === `tool:${call.id}` &&
            read.at >= inputAt &&
            read.at <= proposal.createdAt,
        ),
      ).toBe(true);
    }
    const negativeCalls = v2Calls.filter((call) => call.id === EXPORT_RACE_OLD_REFS_CALL_ID);
    expect(negativeCalls).toHaveLength(1);
    const negative = negativeCalls[0]!;
    expect(negative).toMatchObject({
      role: "mentor",
      name: "research_group",
      isError: true,
      args: {
        operation: "publish",
        revision: 2,
        kind: "review",
        verdict: "accept",
        refs: oldAudit.refs,
      },
    });
    expect(negative.resultText?.trim()).toBe(EXPORT_RACE_OLD_REFS_ERROR);
    const mentorRead = roleCalls("mentor").find(
      (call) =>
        call.args.operation === "read" &&
        call.args.artifactId === proposal.id &&
        !call.isError &&
        Date.parse(call.at) >= Date.parse(proposal.createdAt) &&
        Date.parse(call.resultAt ?? "") <= Date.parse(negative.at),
    )!;
    expect(mentorRead).toBeTruthy();
    expect(nativeRunFor("mentor", mentorRead.at, mentorRead.resultAt)).toBe(
      nativeRunFor("mentor", negative.at, negative.resultAt),
    );
    const mentorKnowledge = roleCalls("mentor").find(
      (call) =>
        call.args.operation === "knowledge" &&
        !call.isError &&
        Date.parse(call.at) >= Date.parse(inputAt) &&
        Date.parse(call.resultAt ?? "") <= Date.parse(negative.at) &&
        nativeResult(call.resultText).revision === 2,
    );
    expect(mentorKnowledge).toBeTruthy();
    const readyMessage = roleCalls("lead").find(
      (call) =>
        call.args.operation === "message" &&
        call.args.to === "mentor" &&
        String(call.args.content).includes(`${EXPORT_RACE_V2_PROPOSAL_READY}${proposal.id}`) &&
        !call.isError,
    );
    expect(readyMessage).toBeTruthy();
    expect(Date.parse(readyMessage!.at)).toBeGreaterThanOrEqual(Date.parse(proposal.createdAt));
    expect(v2Calls.filter((call) => call.isError).map((call) => call.id)).toEqual([
      EXPORT_RACE_OLD_REFS_CALL_ID,
    ]);
    expect(v2Calls.filter((call) => call.name !== "research_group" || !call.resultAt)).toEqual([]);
    expect(
      native.flatMap((member) =>
        member.calls.filter((call) => call.isError).map((call) => call.id),
      ),
    ).toEqual([EXPORT_RACE_OLD_REFS_CALL_ID]);
    expect(
      current.artifacts.some((artifact) => artifact.toolCallId === EXPORT_RACE_OLD_REFS_CALL_ID),
    ).toBe(false);
    await writeFile(
      test.info().outputPath("v2-published-manuscript-acceptance-proof.json"),
      JSON.stringify(
        {
          proposal,
          assessment,
          proposalSha256: hash(proposal.content),
          inputAt,
          exportReleasedAt: lastControl!.resumedAt,
          arrivalIsNotPublication:
            "The UI input arrived while export was held. The actual current proposal was saved only after release and v2 input admission.",
          oldAcceptedRefs: oldAudit.refs,
          rejectedOldRefsCall: negative,
          mentorRead,
          readyMessage,
          native,
        },
        null,
        2,
      ),
    );
    const history = current.supersededExports!.find(
      (item) => item.files.markdown === join(held.exportDirectory!, "论文终稿.md"),
    )!;
    expect(history).toBeTruthy();
    expect(history.reason).toContain("输入版本 2");
    const [markdown, html, provenanceText] = await Promise.all([
      readFile(history.files.markdown, "utf8"),
      readFile(history.files.html, "utf8"),
      readFile(history.files.provenance, "utf8"),
    ]);
    const provenance = object(JSON.parse(provenanceText));
    expect(markdown).toBe(manuscript.content + "\n");
    expect(html).toContain("输入版本 1");
    expect(html).not.toContain("AC31_V2_PENDING_CLAIM");
    expect(provenance).toMatchObject({
      format: "lancer-research-provenance/2",
      projectId: before.id,
      revision: 1,
      manuscriptId: manuscript.id,
      manuscriptSha256: hash(manuscript.content),
    });
    expect(provenanceText).not.toContain("AC31_V2_PENDING_CLAIM");
    const reviews = Array.isArray(provenance.reviews) ? provenance.reviews.map(object) : [];
    expect(
      reviews.some(
        (review) =>
          review.id === oldAudit.id && review.revision === 1 && review.verdict === "accept",
      ),
    ).toBe(true);
    expect(reviews.every((review) => review.revision === 1)).toBe(true);
    for (const [key, content] of [
      ["markdown", markdown],
      ["html", html],
      ["provenance", provenanceText],
    ] as const) {
      const file = history.files[key],
        write = lastControl.writes.find((write) => write.file === file)!;
      expect(write).toBeTruthy();
      expect(write.finishedAt).toBeTruthy();
      expect(write.payloadSha256).toBe(hash(content));
      expect(Date.parse(write.startedAt)).toBeGreaterThanOrEqual(
        Date.parse(lastControl.resumedAt!),
      );
      expect(Date.parse(first.settledAt!)).toBeGreaterThanOrEqual(Date.parse(write.finishedAt!));
      expect(Date.parse(current.inputHistory!.at(-1)!.at)).toBeGreaterThanOrEqual(
        Date.parse(write.finishedAt!),
      );
      packetHashes[key] = hash(content);
    }
    expect(lastControl.writes).toHaveLength(3);
    expect(Date.parse(lastControl.submissions[0]!.arrivedAt)).toBeLessThan(
      Date.parse(lastControl.releaseRequestedAt!),
    );
    expect(Date.parse(first.settledAt!)).toBeGreaterThanOrEqual(
      Date.parse(lastControl.mkdirCompletedAt!),
    );
    expect(lastControl.submissions).toHaveLength(submissionBranch === "queued-and-applied" ? 1 : 2);
    const starts = current.events.filter((event) => event.type === "started" && event.runId);
    const finishes = current.events.filter((event) => event.type === "finished" && event.runId);
    expect(new Set(starts.map((event) => `${event.role}:${event.runId}`)).size).toBe(starts.length);
    expect(finishes).toHaveLength(starts.length);
    for (const start of starts) {
      const ended = finishes.filter(
        (event) => event.role === start.role && event.runId === start.runId,
      );
      expect(ended).toHaveLength(1);
      expect(ended[0]!.revision).toBe(start.revision);
      expect(Date.parse(ended[0]!.runtimeAt!)).toBeGreaterThanOrEqual(Date.parse(start.runtimeAt!));
      if (start.revision === 1)
        expect(Date.parse(ended[0]!.at)).toBeLessThanOrEqual(Date.parse(inputAt));
    }
    for (const member of current.members)
      expect(starts.some((event) => event.revision === 2 && event.role === member.role)).toBe(true);
    expect(captureResearchNativeBoundary(lastState!, current).activeNativeAtCapture).toEqual([]);
    const persisted = object(
        JSON.parse(await readFile(join(fixture.profile, "research-groups.json"), "utf8")),
      ),
      persistedProjects = Array.isArray(persisted.projects) ? persisted.projects.map(object) : [];
    const persistedProject = persistedProjects.find((project) => project.id === current.id)!;
    expect(persistedProject).toMatchObject({
      revision: 2,
      status: "needs-decision",
      supersededExports: current.supersededExports,
    });
    expect(persistedProject.finalPaper).toBeUndefined();
    expect(
      (Array.isArray(persistedProject.artifacts)
        ? persistedProject.artifacts.map(object)
        : []
      ).filter((artifact) => artifact.revision === 2),
    ).toEqual(v2Artifacts);
    await page
      .getByRole("region", { name: "教育研究课题组", exact: true })
      .getByText("历史交付 · 当前研究已需重审", { exact: true })
      .click();
    const oldExportButton = page.getByRole("button", { name: "打开旧版接受稿", exact: true });
    await expect(oldExportButton).toBeVisible();
    await oldExportButton.scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "打开论文终稿", exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("v2-pending-old-export-traceable.png") });
    expect(rendererErrors).toEqual([]);
    await writeFile(
      test.info().outputPath("export-version-race-proof.json"),
      JSON.stringify(
        {
          ...plan,
          submissionBranch,
          control: lastControl,
          snapshots,
          packetHashes,
          sameVersionPacket: {
            files: history.files,
            revision: 1,
            manuscriptId: manuscript.id,
            manuscriptSha256: hash(manuscript.content),
          },
          currentVersion: {
            revision: current.revision,
            status: current.status,
            finalPaper: current.finalPaper ?? null,
            currentReviewArtifacts: current.artifacts.filter((artifact) => artifact.revision === 2),
          },
          queueBoundary:
            "Actual native composer IPC arrival and unresolved promise were observed while export was blocked. New input changed the real coordinator state only after release; no internal queue state was fabricated.",
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
      if (harness && instrumentationInstalled) {
        lastControl = await readResearchExportVersionRace(harness).catch(() => lastControl);
        try {
          const probe = await readResearchExportVersionRaceSdkProbe(harness);
          await writeFile(
            test.info().outputPath("sdk-event-metadata.json"),
            JSON.stringify(probe, null, 2),
          );
        } catch (error) {
          // Retain the primary test failure; an unreadable probe remains explicit evidence.
          sdkProbeReadError = String(error);
        }
      }
      if (harness) {
        lastState = await harness
          .firstWindow()
          .then(getDesktopState)
          .catch(() => lastState);
      }
      await writeFile(
        test.info().outputPath("run-outcome.json"),
        JSON.stringify(
          {
            ...plan,
            endedAt: new Date().toISOString(),
            failure: failure ?? null,
            instrumentationInstalled,
            submissionBranch,
            controlBeforeCleanup: lastControl,
            sdkProbeReadError,
            snapshots,
            lastProject: lastState?.researchGroups?.projects[0] ?? null,
            nativeBoundary: lastState?.researchGroups?.projects[0]
              ? captureResearchNativeBoundary(lastState, lastState.researchGroups.projects[0])
              : null,
            packetHashes,
            rendererErrors,
            boundary:
              "Failures remain failures. Releasing a held real export during teardown is cleanup, not successful race proof. v2 saves a real current proposal and pending assessment, then one explicitly named old-ref acceptance attempt must fail. New input arrival during the lock is not manuscript publication during the lock.",
          },
          null,
          2,
        ),
      );
    } finally {
      if (harness) {
        let cleanupFailure: string | null = null;
        try {
          if (instrumentationInstalled) {
            await releaseResearchExportVersionRace(harness, true);
            const cleanup = await readResearchExportVersionRace(harness);
            const probe = await readResearchExportVersionRaceSdkProbe(harness);
            await writeFile(
              test.info().outputPath("sdk-event-metadata.json"),
              JSON.stringify(probe, null, 2),
            );
            await writeFile(
              test.info().outputPath("instrumentation-cleanup.json"),
              JSON.stringify(cleanup, null, 2),
            );
            expect(cleanup.restoredAt).toBeTruthy();
            expect(probe.restoredAt).toBe(cleanup.restoredAt);
          } else {
            await writeFile(
              test.info().outputPath("instrumentation-cleanup.json"),
              JSON.stringify(
                {
                  installed: false,
                  skipped: "Installation did not complete; no read/restore attempted",
                  primaryFailure: failure ?? null,
                },
                null,
                2,
              ),
            );
          }
        } catch (error) {
          cleanupFailure = String(error);
          await writeFile(
            test.info().outputPath("instrumentation-cleanup-error.json"),
            JSON.stringify(
              {
                error: String(error),
                primaryFailure: failure ?? null,
                lastObservedControl: lastControl,
              },
              null,
              2,
            ),
          );
        } finally {
          await harness.close();
        }
        // Preserve an existing primary failure. A genuine cleanup failure remains recorded,
        // and still fails an otherwise successful test.
        if (!failure) expect(cleanupFailure).toBeNull();
      }
    }
  }
});
