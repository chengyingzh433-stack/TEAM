import { isDeepStrictEqual } from "node:util";
import type { ResearchProject, ResearchRole } from "../../contracts/research-group";
import {
  assertResearchMethodFields,
  decodeResearchMethodProjectRecords,
  decodeResearchMethodApplication,
  decodeResearchMethodContentOpinion,
  decodeResearchMethodAdjudication,
  type ResearchMethodPackageUse,
} from "../../contracts/research-method-packages";
import {
  decodeResearchMethodProgramChecks,
  type ResearchMethodProgramCheck,
  type ResearchMethodProgramPackageCheck,
} from "../../contracts/research-method-checks";
import { activeFusionAttempt, fusionRoleStage } from "./fusion-task-runtime";
import {
  applyMethodPackageTool,
  isCurrentResearchMethodPackageUse,
  researchMethodReviewReadiness,
} from "./method-package-tools";
import { researchHash } from "./materials";
import { stageManuscript } from "./paper-pipeline";

const authorities = new Set<string>();
const stageFor = (p: ResearchProject, role: ResearchRole) =>
  fusionRoleStage(p, role) ?? p.currentStage;
function usesForStage(p: ResearchProject, role: ResearchRole) {
  const stage = stageFor(p, role);
  // Keep stale uses in the gate: removing them here would turn invalid input into a silent bypass.
  const uses = (p.methodPackageUses ?? []).filter(
    (use) =>
      use.role === "lead" &&
      use.revision === p.revision &&
      p.fusion?.tasks.some(
        (task) => task.id === use.taskId && task.stage === stage && task.role === "lead",
      ),
  );
  const replaced = new Set(
    uses.flatMap(
      (use) => p.methodPackages?.find((pkg) => pkg.id === use.packageId)?.supersedesPackageId ?? [],
    ),
  );
  const latest = new Map<string, ResearchMethodPackageUse>();
  for (const use of uses) if (!replaced.has(use.packageId)) latest.set(use.packageId, use);
  return [...latest.values()];
}
export function requiresMethodAcceptance(
  p: ResearchProject,
  role: ResearchRole,
  input: Record<string, unknown>,
) {
  return (
    p.workflowVersion === "fusion-v2" &&
    input.verdict === "accept" &&
    ["stage-verification", "stage-review"].includes(String(input.kind)) &&
    usesForStage(p, role).length > 0
  );
}
function target(p: ResearchProject, role: ResearchRole) {
  const stage = stageFor(p, role);
  return p.artifacts
    .filter((artifact) => {
      const record = p.fusion?.artifacts.find((item) => item.id === artifact.id),
        task = p.fusion?.tasks.find((item) => item.id === record?.taskId),
        attempt = p.fusion?.attempts.find((item) => item.id === record?.attemptId);
      return (
        artifact.revision === p.revision &&
        artifact.stage === stage &&
        artifact.role === "lead" &&
        artifact.id === stageManuscript(p, stage)?.id &&
        !!record &&
        !!task &&
        task.currentArtifactId === artifact.id &&
        task.role === "lead" &&
        task.stage === stage &&
        task.id.startsWith(`v${p.revision}:`) &&
        task.inputVersion === record.taskVersion &&
        record.content === artifact.content &&
        !["superseded", "needs-review"].includes(record.reviewState) &&
        attempt?.taskId === task.id &&
        attempt.taskVersion === task.inputVersion &&
        !!attempt.nativeRunId &&
        !!attempt.model &&
        record.inputRefs.every((ref) =>
          p.fusion!.adoptedInputs.some(
            (input) => input.inputId === ref.inputId && input.version === ref.version,
          ),
        )
      );
    })
    .at(-1);
}
const pin = (artifact: ReturnType<typeof target>) =>
  artifact ? { artifactId: artifact.id, bodySha256: researchHash(artifact.content) } : null;
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
const digest = (value: unknown) => researchHash(JSON.stringify(stable(value)));
const failure = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 6000);
const detail = (issues: string[]) =>
  issues.length
    ? `方法依据核验未通过：${issues.join("；")}`
    : "本次方法包程序完整性检查在快照通过；仍不认证完整工具总分，模型内容意见不是人类/伦理审批。";
function snapshot(p: ResearchProject, role: ResearchRole, input: Record<string, unknown>) {
  const stage = stageFor(p, role),
    uses = usesForStage(p, role),
    packages = new Set(uses.map((use) => use.packageId)),
    artifact = target(p, role);
  const tasks =
    p.fusion?.tasks.filter(
      (task) =>
        task.stage === stage &&
        task.id.startsWith(`v${p.revision}:`) &&
        ["lead", "reviewer", "mentor"].includes(task.role),
    ) ?? [];
  const taskIds = new Set(tasks.map((task) => task.id));
  const attempts = p.fusion?.attempts.filter((attempt) => taskIds.has(attempt.taskId)) ?? [];
  const dependencies = new Set([
    ...tasks.flatMap((task) => task.inputs.map((ref) => ref.inputId)),
    ...attempts.flatMap((attempt) =>
      [...attempt.inputRefs, ...(attempt.acquiredInputs ?? [])].map((ref) => ref.inputId),
    ),
  ]);
  return digest({
    projectId: p.id,
    workspace: p.workspacePath,
    revision: p.revision,
    status: p.status,
    workflow: p.workflowVersion,
    role,
    stage,
    input,
    target: artifact,
    graphTarget: p.fusion?.artifacts.find((item) => item.id === artifact?.id),
    tasks: tasks.map((task) => ({
      id: task.id,
      inputVersion: task.inputVersion,
      inputs: task.inputs,
      currentArtifactId: task.currentArtifactId,
    })),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      taskId: attempt.taskId,
      taskVersion: attempt.taskVersion,
      nativeRunId: attempt.nativeRunId,
      model: attempt.model,
      inputRefs: attempt.inputRefs,
      acquiredInputs: attempt.acquiredInputs,
      state: attempt.id === activeFusionAttempt(p, role)?.id ? attempt.state : undefined,
    })),
    inputs: p.fusion?.adoptedInputs.filter((ref) => dependencies.has(ref.inputId)),
    members: p.members
      .filter((member) => ["lead", "reviewer", "mentor"].includes(member.role))
      .map((member) => ({ role: member.role, ref: member.ref })),
    uses: p.methodPackageUses?.filter(
      (use) => packages.has(use.packageId) && taskIds.has(use.taskId),
    ),
    packages: p.methodPackages?.filter((pkg) => packages.has(pkg.id)),
    applications: p.methodApplications?.filter(
      (row) => packages.has(row.packageId) && taskIds.has(row.taskId),
    ),
    readings: p.methodImageReadings?.filter(
      (row) => packages.has(row.packageId) && taskIds.has(row.taskId),
    ),
    receipts: p.methodImageReceipts?.filter(
      (row) => packages.has(row.packageId) && taskIds.has(row.taskId),
    ),
    opinions: p.methodContentOpinions?.filter(
      (row) => packages.has(row.packageId) && taskIds.has(row.taskId),
    ),
    adjudications: p.methodAdjudications?.filter(
      (row) => packages.has(row.packageId) && taskIds.has(row.taskId),
    ),
    read: p.events
      .filter(
        (event) =>
          event.type === "read" &&
          event.role === role &&
          event.artifactId === artifact?.id &&
          event.revision === p.revision,
      )
      .at(-1),
  });
}
function report(value: unknown) {
  assertResearchMethodFields(value, [
    "kind",
    "actor",
    "projectId",
    "taskId",
    "packageId",
    "packageSha256",
    "requiredContextComplete",
    "images",
    "blockers",
    "methodApplicability",
    "fullInstrumentScoring",
    "sourceIdentity",
    "boundary",
    "actualCacheIssues",
    "application",
    "opinions",
    "adjudications",
  ]);
  if (
    value.kind !== "program-integrity-check" ||
    value.requiredContextComplete !== true ||
    value.fullInstrumentScoring !== "not-certified" ||
    value.methodApplicability !== "not-assessed" ||
    !Array.isArray(value.blockers) ||
    value.blockers.some((item) => typeof item !== "string") ||
    !Array.isArray(value.images) ||
    !Array.isArray(value.opinions) ||
    !Array.isArray(value.adjudications)
  )
    throw new Error("方法检查返回结构或完整性身份无效。");
  assertResearchMethodFields(value.actor, ["kind", "id"]);
  if (value.actor.kind !== "program" || value.actor.id !== "method-packages-1")
    throw new Error("方法检查不是预期的程序身份。");
  const images = value.images.map((entry: unknown) => {
    assertResearchMethodFields(entry, ["path", "byteState", "readingReports"]);
    if (typeof entry.path !== "string" || !Array.isArray(entry.readingReports))
      throw new Error("图像检查结构无效。");
    const readingIds = entry.readingReports.map((item: unknown) => {
      assertResearchMethodFields(item, ["id", "actor", "observations"]);
      if (typeof item.id !== "string") throw new Error("读图身份无效。");
      return item.id;
    });
    return { path: entry.path, readingIds };
  });
  return {
    projectId: value.projectId,
    taskId: value.taskId,
    packageId: value.packageId,
    packageSha256: value.packageSha256,
    application: decodeResearchMethodApplication(value.application),
    blockers: value.blockers as string[],
    images,
    opinions: value.opinions.map(decodeResearchMethodContentOpinion),
    adjudications: value.adjudications.map(decodeResearchMethodAdjudication),
  };
}
async function evaluate(
  p: ResearchProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
) {
  const artifact = target(p, role),
    issues: string[] = [],
    stage = stageFor(p, role),
    owner = activeFusionAttempt(p, role),
    task = p.fusion?.tasks.find((item) => item.id === owner?.taskId);
  const ownerValid =
    !!owner &&
    !!task &&
    owner.state === "running" &&
    !!owner.nativeRunId &&
    !!owner.model &&
    owner.taskVersion === task.inputVersion &&
    task.id.startsWith(`v${p.revision}:`) &&
    task.role === role &&
    p.status === "running" &&
    input.revision === p.revision &&
    input.stage === stage &&
    (input.kind === "stage-verification" ? role === "reviewer" : role === "mentor") &&
    [...owner.inputRefs, ...(owner.acquiredInputs ?? [])].every((ref) =>
      p.fusion!.adoptedInputs.some(
        (item) => item.inputId === ref.inputId && item.version === ref.version,
      ),
    );
  if (!ownerValid) issues.push("需要当前阶段B/导师的真实原生执行、实际模型和输入版本。");
  if (
    ["snapshotToken", "methodProgramChecks", "methodAcceptance", "methodProgramCheck"].some(
      (key) => key in input,
    )
  )
    issues.push("模型不能自报宿主方法程序检查或快照凭据。");
  if (!artifact) issues.push("本阶段尚无最新有效、正文与graph一致的A修订。");
  if (artifact && (!Array.isArray(input.refs) || !input.refs.includes(artifact.id)))
    issues.push("正式接受须引用本阶段最新A修订。");
  if (
    artifact &&
    !p.events.some(
      (event) =>
        event.type === "read" &&
        event.role === role &&
        event.artifactId === artifact.id &&
        event.revision === p.revision &&
        event.stage === stage &&
        Date.parse(event.at) >= Date.parse(artifact.createdAt) &&
        Date.parse(event.at) <= Date.parse(at),
    )
  )
    issues.push("接受者尚未实际读取当前A修订，旧稿或早于稿件的读取不能沿用。");
  const packages: ResearchMethodProgramPackageCheck[] = [];
  try {
    decodeResearchMethodProjectRecords({
      methodPackages: p.methodPackages,
      methodPackageUses: p.methodPackageUses,
      methodApplications: p.methodApplications,
      methodImageReadings: p.methodImageReadings,
      methodImageReceipts: p.methodImageReceipts,
      methodContentOpinions: p.methodContentOpinions,
      methodAdjudications: p.methodAdjudications,
    });
  } catch (error) {
    issues.push(failure(error));
    return { packages, issues, target: pin(artifact), owner, task, stage };
  }
  for (const use of usesForStage(p, role)) {
    const pkg = p.methodPackages?.find((item) => item.id === use.packageId),
      producer = p.fusion?.tasks.find((item) => item.id === use.taskId);
    const check: ResearchMethodProgramPackageCheck = {
      packageId: use.packageId,
      packageSha256: use.packageSha256,
      taskId: use.taskId,
      taskInputVersion: producer?.inputVersion ?? use.taskInputVersion,
      imageReadings: [],
      opinionIds: [],
      adjudicationIds: [],
      issues: [],
    };
    packages.push(check);
    if (
      !pkg ||
      pkg.packageSha256 !== use.packageSha256 ||
      !producer ||
      !isCurrentResearchMethodPackageUse(p, use)
    ) {
      check.issues.push(
        "方法采用的包、真实native身份或任务输入版本已变化，需当前任务明确取得依据。",
      );
      continue;
    }
    const app = p.methodApplications
      ?.filter(
        (item) =>
          item.projectId === p.id &&
          item.taskId === producer.id &&
          item.packageId === pkg.id &&
          item.packageSha256 === pkg.packageSha256,
      )
      .at(-1);
    if (!app) {
      check.issues.push("尚无当前任务的实际方法应用说明，知识块ID不能代替应用。");
      continue;
    }
    check.applicationId = app.id;
    if (!ownerValid) {
      check.issues.push("当前接受者执行身份无效，未代其执行新的方法检查。");
      continue;
    }
    try {
      const effect = await applyMethodPackageTool(
          p,
          undefined,
          role,
          `${callId}:check:${pkg.id}`,
          { operation: "method-check", packageId: pkg.id, applicationId: app.id },
          at,
        ),
        checked = report(effect.result);
      if (
        checked.projectId !== p.id ||
        checked.taskId !== producer.id ||
        checked.packageId !== pkg.id ||
        checked.packageSha256 !== pkg.packageSha256 ||
        !isDeepStrictEqual(checked.application, app)
      )
        throw new Error("程序检查返回了其他任务或版本的报告。");
      check.issues.push(...checked.blockers);
      check.imageReadings = checked.images;
      check.opinionIds = checked.opinions.map((item) => item.id);
      check.adjudicationIds = checked.adjudications.map((item) => item.id);
      const latest = p.methodContentOpinions
          ?.filter((item) => item.applicationId === app.id)
          .at(-1),
        opinion = checked.opinions.at(-1),
        adjudication = checked.adjudications.at(-1);
      if (!opinion || opinion.id !== latest?.id || opinion.verdict !== "support")
        check.issues.push("本方法应用尚无最新且当前有效的B支持意见，或B仍要求修订/暂缓。");
      if (opinion)
        check.issues.push(
          ...researchMethodReviewReadiness(p, pkg, opinion.actor, opinion.at, true),
        );
      if (role === "mentor") {
        const latestDecision = p.methodAdjudications
          ?.filter((item) => item.applicationId === app.id)
          .at(-1);
        if (
          !adjudication ||
          adjudication.id !== latestDecision?.id ||
          adjudication.verdict !== "accept" ||
          !opinion ||
          !adjudication.opinionIds.includes(opinion.id)
        )
          check.issues.push("导师尚未基于最新B支持完成当前应用的接受裁定。");
        if (adjudication)
          check.issues.push(
            ...researchMethodReviewReadiness(p, pkg, adjudication.actor, adjudication.at, false),
          );
      }
    } catch (error) {
      check.issues.push(failure(error));
    }
  }
  issues.push(
    ...packages.flatMap((pkg) => pkg.issues.map((issue) => `${pkg.packageId}: ${issue}`)),
  );
  return { packages, issues, target: pin(artifact), owner, task, stage };
}
function prefix(
  p: ResearchProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
) {
  return `method-check:${digest({ projectId: p.id, revision: p.revision, role, callId, input })}:`;
}
function recordHash(record: Omit<ResearchMethodProgramCheck, "id">) {
  return digest(record);
}
export async function prepareMethodAcceptance(
  p: ResearchProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
) {
  if (!requiresMethodAcceptance(p, role, input))
    return {
      required: false,
      blocked: false,
      detail: "本次没有采用需核验的方法包。",
      record: undefined,
    };
  if (!callId.trim() || !Number.isFinite(Date.parse(at)))
    throw new Error("宿主检查调用身份或时间无效。");
  const before = snapshot(p, role, input),
    checked = await evaluate(p, role, callId, input, at),
    token = snapshot(p, role, input);
  if (before !== token)
    checked.issues.push("方法检查期间局部任务/稿件/依据变化，请对新快照重新核验。");
  const content: Omit<ResearchMethodProgramCheck, "id"> = {
    at,
    programVersion: "method-acceptance-1",
    role,
    revision: p.revision,
    stage: checked.stage!,
    callId,
    ...(checked.owner
      ? {
          attemptId: checked.owner.id,
          taskId: checked.owner.taskId,
          taskInputVersion: checked.owner.taskVersion,
        }
      : {}),
    ...(checked.owner?.nativeRunId ? { nativeRunId: checked.owner.nativeRunId } : {}),
    ...(checked.owner?.model ? { model: structuredClone(checked.owner.model) } : {}),
    snapshotToken: token,
    target: checked.target,
    result: checked.issues.length ? "blocked" : "passed-at-snapshot",
    packages: checked.packages,
    issues: checked.issues,
  };
  const idPrefix = prefix(p, role, callId, input);
  const prior = p.methodProgramChecks?.find(
    (row) =>
      row.id.startsWith(idPrefix) &&
      isDeepStrictEqual(
        { ...row, id: undefined, at: undefined },
        { ...content, id: undefined, at: undefined },
      ),
  );
  if (prior) content.at = prior.at;
  const record: ResearchMethodProgramCheck = {
    id: `${idPrefix}${recordHash(content)}`,
    ...content,
  };
  decodeResearchMethodProgramChecks([record]);
  if (!p.methodProgramChecks?.some((row) => row.id === record.id))
    (p.methodProgramChecks ??= []).push(structuredClone(record));
  if (record.result === "passed-at-snapshot") authorities.add(record.id);
  return {
    required: true,
    blocked: record.result === "blocked",
    detail: detail(checked.issues),
    record,
  };
}
/** Fresh files and the same private host-minted snapshot, without new native calls, uses or history writes. */
export async function assertMethodAcceptance(
  p: ResearchProject,
  role: ResearchRole,
  callId: string,
  input: Record<string, unknown>,
  at: string,
) {
  const idPrefix = prefix(p, role, callId, input),
    prepared = p.methodProgramChecks?.filter((row) => row.id.startsWith(idPrefix)).at(-1),
    required = requiresMethodAcceptance(p, role, input);
  if (!required && !prepared) return;
  if (
    !required ||
    !prepared ||
    prepared.result !== "passed-at-snapshot" ||
    !authorities.has(prepared.id)
  )
    throw new Error("方法依据核验未通过：没有本次宿主生成的通过检查或采用范围已变化。");
  decodeResearchMethodProgramChecks([prepared]);
  const { id, ...contents } = prepared;
  if (
    id !== `${idPrefix}${recordHash(contents)}` ||
    prepared.snapshotToken !== snapshot(p, role, input)
  )
    throw new Error("方法依据/目标稿件快照已变化或检查记录摘要无效，请重新核验。");
  const current = await evaluate(p, role, callId, input, at);
  if (
    current.issues.length ||
    prepared.snapshotToken !== snapshot(p, role, input) ||
    !isDeepStrictEqual(prepared.target, current.target) ||
    !isDeepStrictEqual(prepared.packages, current.packages)
  )
    throw new Error(
      detail(current.issues.length ? current.issues : ["正式发布前目标或方法依据发生变化。"]),
    );
}
