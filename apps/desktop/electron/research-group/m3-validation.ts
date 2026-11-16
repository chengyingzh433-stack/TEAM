import { validateResearchDiscussions } from "../../contracts/research-discussion";
import { validateResearchUsage } from "../../contracts/research-usage";
import { isDeepStrictEqual } from "node:util";
import type { ResearchGroupsState, ResearchProject } from "../../contracts/research-group";
import { RESEARCH_ROLES } from "../../contracts/research-group";
import {
  decodeM3Model,
  decodeResearchM3Action,
  decodeResearchPathRecord,
} from "../../contracts/research-m3";
import { decodeResearchClaimActualRead } from "../../contracts/research-claims";
import { assertResearchScopeFindings, composeResearchScopedText } from "./research-task-scope";
import { researchHash } from "./materials";
import { RESEARCH_TASK_KINDS } from "../../contracts/research-method";

const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max = 20000) => typeof v === "string" && !!v.trim() && v.length <= max;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`M3保存记录无效：${detail}；原文件保留。`);
}
function defaults(value: unknown) {
  assert(!!value && typeof value === "object" && !Array.isArray(value), "默认模型");
  for (const [role, model] of Object.entries(value)) {
    assert(
      RESEARCH_ROLES.some((r) => r === role),
      "未知默认角色",
    );
    decodeM3Model(model);
  }
}
export function validateResearchM3State(state: ResearchGroupsState): void {
  if (state.m3 !== undefined) {
    assert(
      !!state.m3 &&
        typeof state.m3 === "object" &&
        !Array.isArray(state.m3) &&
        Object.keys(state.m3).every((k) =>
          [
            "applicationLimit",
            "defaultModels",
            "legacyExecutions",
            "legacyQueue",
            "legacySettings",
            "modelPresets",
          ].includes(k),
        ),
      "应用执行配置",
    );
    if (state.m3.applicationLimit !== undefined)
      assert(
        Number.isSafeInteger(state.m3.applicationLimit) &&
          state.m3.applicationLimit >= 1 &&
          state.m3.applicationLimit <= 64,
        "应用上限",
      );
    if (state.m3.defaultModels !== undefined) defaults(state.m3.defaultModels);
    if (state.m3.modelPresets !== undefined) {
      assert(
        Array.isArray(state.m3.modelPresets) &&
          state.m3.modelPresets.length <= 3 &&
          new Set(state.m3.modelPresets.map((p) => p.name)).size === state.m3.modelPresets.length,
        "模型预设",
      );
      for (const preset of state.m3.modelPresets) {
        decodeResearchM3Action({
          operation: "save-model-preset",
          name: preset.name,
          models: preset.models,
        });
        assert(date(preset.savedAt), "预设保存时间");
      }
    }
    for (const name of ["legacyExecutions", "legacyQueue", "legacySettings"] as const)
      if (state.m3[name] !== undefined)
        assert(Array.isArray(state.m3[name]) && state.m3[name].length <= 20000, name);
    const ids = new Set<string>(),
      active = new Set<string>();
    for (const call of state.m3.legacyExecutions ?? []) {
      const p = state.projects.find((p) => p.id === call.projectId);
      assert(
        text(call.id) &&
          !ids.has(call.id) &&
          p &&
          p.members.some((m) => m.role === call.role) &&
          Number.isSafeInteger(call.revision) &&
          call.revision >= 1 &&
          call.revision <= p.revision &&
          ["prepared", "running", "unknown", "succeeded", "failed", "cancelled"].includes(
            call.state,
          ) &&
          date(call.preparedAt) &&
          Number.isSafeInteger(call.reservedTokens) &&
          call.reservedTokens >= 0 &&
          (call.usedTokens === undefined ||
            (Number.isSafeInteger(call.usedTokens) && call.usedTokens >= 0)) &&
          (call.sessionTotalTokens === undefined ||
            (Number.isSafeInteger(call.sessionTotalTokens) && call.sessionTotalTokens >= 0)) &&
          (call.nativeRunId === undefined || text(call.nativeRunId)) &&
          (call.finishedAt === undefined || date(call.finishedAt)),
        "旧流程执行身份或结算",
      );
      validateResearchUsage(call);
      ids.add(call.id);
      if (["prepared", "running", "unknown"].includes(call.state)) {
        const key = `${call.projectId}:${call.role}`;
        assert(!active.has(key), "旧流程同角色重复执行");
        active.add(key);
      }
      if (call.resolution)
        assert(
          date(call.resolution.at) &&
            text(call.resolution.reason) &&
            text(call.resolution.evidenceRef),
          "旧流程未知结果核实依据",
        );
    }
    for (const q of state.m3.legacyQueue ?? [])
      assert(
        state.projects.some(
          (p) =>
            p.id === q.projectId &&
            Number.isSafeInteger(q.revision) &&
            q.revision >= 1 &&
            q.revision <= p.revision &&
            p.members.some((m) => m.role === q.role),
        ) &&
          text(q.text, 1000000) &&
          text(q.reason) &&
          date(q.at) &&
          (q.delivery === undefined || ["steer", "followUp"].includes(q.delivery)),
        "旧流程等待队列",
      );
    const settings = new Set<string>();
    for (const s of state.m3.legacySettings ?? []) {
      assert(
        state.projects.some((p) => p.id === s.projectId) &&
          !settings.has(s.projectId) &&
          Number.isSafeInteger(s.projectLimit) &&
          s.projectLimit >= 1 &&
          s.projectLimit <= 16 &&
          (s.tokenBudget === undefined ||
            (Number.isSafeInteger(s.tokenBudget) &&
              s.tokenBudget >= 1000 &&
              s.tokenBudget <= 100000000)),
        "旧流程执行配置",
      );
      settings.add(s.projectId);
    }
  }
  const refs = new Set(state.projects.flatMap((p) => p.members.map((m) => JSON.stringify(m.ref))));
  for (const p of state.projects)
    for (const m of p.m3?.specialists ?? []) {
      const ref = JSON.stringify(m.ref);
      assert(!refs.has(ref), "课题与专项会话身份重复");
      refs.add(ref);
    }
  state.projects.forEach(validateResearchM3Project);
}
export function validateResearchM3Project(p: ResearchProject): void {
  const m = p.m3;
  if (m?.discussions !== undefined) {
    validateResearchDiscussions(m.discussions);
    if (m.discussions.some((t) => t.revision > p.revision))
      throw new Error("研讨不能来自未来版本。");
  }
  if (m === undefined) return;
  assert(
    !!m &&
      typeof m === "object" &&
      !Array.isArray(m) &&
      Object.keys(m).every((k) =>
        [
          "projectLimit",
          "memberInputs",
          "discussions",
          "tokenBudget",
          "defaultModels",
          "taskModels",
          "recoveryPolicies",
          "recoveries",
          "queued",
          "pathRecords",
          "pathReads",
          "pathReviews",
          "scopes",
          "scopePreview",
          "results",
          "specialists",
        ].includes(k),
      ),
    "项目扩展字段",
  );
  if (m.scopePreview)
    assert(
      text(m.scopePreview.sourceId) &&
        hash(m.scopePreview.sourceSha256) &&
        typeof m.scopePreview.body === "string" &&
        researchHash(m.scopePreview.body) === m.scopePreview.bodySha256,
      "范围预览",
    );
  assert(p.workflowVersion === "fusion-v2" && !!p.fusion, "扩展缺少融合任务图");
  if (m.projectLimit !== undefined)
    assert(
      Number.isSafeInteger(m.projectLimit) && m.projectLimit >= 1 && m.projectLimit <= 16,
      "课题上限",
    );
  if (m.tokenBudget !== undefined)
    assert(
      Number.isSafeInteger(m.tokenBudget) && m.tokenBudget >= 1000 && m.tokenBudget <= 100_000_000,
      "课题额度",
    );
  if (m.defaultModels !== undefined) defaults(m.defaultModels);
  for (const name of ["taskModels", "recoveryPolicies"] as const)
    if (m[name] !== undefined)
      assert(!!m[name] && typeof m[name] === "object" && !Array.isArray(m[name]), name);
  for (const name of [
    "memberInputs",
    "recoveries",
    "queued",
    "pathRecords",
    "pathReads",
    "pathReviews",
    "scopes",
    "results",
    "specialists",
  ] as const) {
    if (m[name] !== undefined) assert(Array.isArray(m[name]) && m[name].length <= 20000, name);
  }
  for (const input of m.memberInputs ?? [])
    assert(
      text(input.id) &&
        Number.isSafeInteger(input.revision) &&
        input.revision >= 1 &&
        input.revision <= p.revision &&
        text(input.text) &&
        date(input.at) &&
        ["steer", "followUp"].includes(input.delivery) &&
        Number.isSafeInteger(input.taskVersion) &&
        input.taskVersion >= 1 &&
        p.fusion.tasks.some(
          (t) =>
            t.id === input.taskId && t.role === input.actor && t.inputVersion >= input.taskVersion,
        ) &&
        (input.attemptId === undefined ||
          p.fusion.attempts.some(
            (a) =>
              a.id === input.attemptId &&
              a.taskId === input.taskId &&
              a.taskVersion === input.taskVersion,
          )),
      "成员输入、任务与执行身份",
    );
  for (const input of m.memberInputs ?? [])
    if (input.responses !== undefined) {
      assert(Array.isArray(input.responses) && input.responses.length <= 8, "成员输入处理记录");
      for (const response of input.responses)
        assert(
          text(response.id) &&
            response.kind === "model" &&
            date(response.at) &&
            ["no-manuscript-change", "requires-revision"].includes(response.disposition) &&
            text(response.content) &&
            p.fusion.attempts.some(
              (a) => a.id === response.attemptId && a.taskId === input.taskId,
            ) &&
            p.artifacts.some(
              (a) =>
                a.id === response.artifactId && researchHash(a.content) === response.artifactSha256,
            ),
          "成员处理的模型身份及目标稿",
        );
    }
  for (const artifact of p.artifacts.filter((a) => a.memberInputIds !== undefined))
    assert(
      Array.isArray(artifact.memberInputIds) &&
        artifact.memberInputIds.every((id) =>
          m.memberInputs?.some(
            (input) =>
              input.id === id &&
              input.revision === artifact.revision &&
              input.actor === artifact.role &&
              !!input.attemptId &&
              (artifact.role !== "lead" ||
                input.attemptId ===
                  p.fusion!.artifacts.find((a) => a.id === artifact.id)?.attemptId),
          ),
        ),
      "稿件的实际用户修订依据",
    );
  for (const [taskId, model] of Object.entries(m.taskModels ?? {})) {
    assert(
      p.fusion.tasks.some((t) => t.id === taskId),
      "配模任务不存在",
    );
    decodeM3Model(model);
  }
  for (const [taskId, recovery] of Object.entries(m.recoveryPolicies ?? {})) {
    assert(
      p.fusion.tasks.some((t) => t.id === taskId),
      "恢复任务不存在",
    );
    decodeResearchM3Action({ operation: "task-model", taskId, recovery });
  }
  for (const r of m.recoveries ?? []) {
    assert(
      p.fusion.attempts.some((a) => a.id === r.attemptId && a.taskId === r.taskId) &&
        date(r.retryAt) &&
        text(r.reason),
      "恢复计划",
    );
    decodeM3Model(r.model);
  }
  for (const q of m.queued ?? [])
    assert(
      p.fusion.tasks.some((t) => t.id === q.taskId) && date(q.at) && text(q.reason),
      "等待名额任务",
    );
  for (const r of m.pathRecords ?? []) {
    const task = p.fusion.tasks.find((t) => t.id === r.taskId),
      attempt = p.fusion.attempts.find((a) => a.id === r.attemptId);
    assert(
      text(r.id) &&
        date(r.at) &&
        r.revision <= p.revision &&
        r.revision >= 1 &&
        task &&
        attempt?.taskId === task.id &&
        attempt.taskVersion === r.taskVersion &&
        r.taskVersion <= task.inputVersion &&
        r.role === "lead" &&
        task.role === "lead" &&
        task.stage === "analysis",
      "路径记录执行归属",
    );
    assert(isDeepStrictEqual(decodeResearchPathRecord(r.input), r.input), "路径记录结构");
    assert(
      p.members.some((member) => member.role === r.role && member.ref.sessionId === r.sessionId),
      "路径记录会话",
    );
    assert(
      Array.isArray(r.actualReads) &&
        Array.isArray(r.sources) &&
        r.actualReads.length === r.input.evidence.length &&
        r.sources.length === r.input.evidence.length,
      "路径原文凭据",
    );
    r.actualReads.forEach(decodeResearchClaimActualRead);
    assert(
      Array.isArray(r.excerpts) &&
        r.excerpts.length === r.input.evidence.length &&
        r.excerpts.every(
          (e, i) =>
            e.id === r.input.evidence[i]!.id &&
            typeof e.text === "string" &&
            e.text.length === r.input.evidence[i]!.end - r.input.evidence[i]!.start &&
            researchHash(e.text) === e.sha256,
        ),
      "固定原文片段",
    );
    r.input.evidence.forEach((e, i) => {
      const source = r.sources[i]!,
        read = r.actualReads[i]!;
      assert(
        source.id === e.sourceId &&
          hash(source.sha256) &&
          hash(source.bodySha256) &&
          read.sourceId === e.sourceId &&
          read.sourceSha256 === source.sha256 &&
          read.bodySha256 === source.bodySha256 &&
          read.sessionId === r.sessionId &&
          read.locatorId === e.locatorId &&
          read.start <= e.start &&
          read.end >= e.end &&
          !["metadata", "abstract"].includes(read.depth),
        "路径片段与实际读取不符",
      );
    });
  }
  for (const r of m.pathReads ?? [])
    assert(
      m.pathRecords?.some((record) => record.id === r.recordId) &&
        p.fusion.attempts.some(
          (a) =>
            a.id === r.attemptId &&
            p.fusion!.tasks.some((t) => t.id === a.taskId && t.role === r.role),
        ) &&
        date(r.at),
      "路径阅读记录",
    );
  for (const r of m.pathReviews ?? [])
    assert(
      text(r.id) &&
        m.pathRecords?.some((record) => record.id === r.recordId) &&
        p.artifacts.some(
          (a) =>
            a.id === r.artifactId &&
            researchHash(a.content) === r.artifactSha256 &&
            a.pathRecordId === r.recordId,
        ) &&
        ["reviewer", "mentor"].includes(r.role) &&
        p.fusion.attempts.some(
          (a) =>
            a.id === r.attemptId &&
            p.fusion!.tasks.some((t) => t.id === a.taskId && t.role === r.role),
        ) &&
        ["supported", "limited", "revision-required"].includes(r.verdict) &&
        text(r.reason) &&
        date(r.at),
      "路径具名复核",
    );
  for (const s of m.scopes ?? []) {
    assert(
      text(s.id) &&
        s.revision >= 1 &&
        s.revision <= p.revision &&
        text(s.sourceId) &&
        hash(s.sourceSha256) &&
        typeof s.baseline === "string" &&
        researchHash(s.baseline) === s.bodySha256 &&
        date(s.at),
      "单项原稿快照",
    );
    const decoded = decodeResearchM3Action({
      operation: "task-scope",
      sourceId: s.sourceId,
      sourceSha256: s.sourceSha256,
      ranges: s.ranges,
    });
    assert(
      decoded.operation === "task-scope" && decoded.ranges.every((r) => r.end <= s.baseline.length),
      "单项范围",
    );
  }
  for (const r of m.results ?? []) {
    const scope = m.scopes?.find((s) => s.id === r.scopeId);
    const artifact = p.artifacts.find((a) => a.id === r.artifactId);
    assert(
      text(r.id) &&
        scope &&
        r.revision === scope.revision &&
        p.artifacts.some(
          (a) =>
            a.id === r.artifactId &&
            a.revision === r.revision &&
            researchHash(a.content) === r.artifactSha256 &&
            a.content === r.fullText,
        ) &&
        date(r.at) &&
        researchHash(r.fullText) === r.fullTextSha256 &&
        RESEARCH_TASK_KINDS.includes(r.kind) &&
        (r.kind === "chapter-edit"
          ? composeResearchScopedText(scope, r.edits) === r.fullText
          : r.edits.length === 0 &&
            p.artifacts.some((a) => a.id === r.artifactId && a.content === r.fullText)),
      "单项结果越界或失配",
    );
    assert(
      Array.isArray(r.sourcePins) &&
        r.sourcePins.length > 0 &&
        r.sourcePins.every((pin) => text(pin.id) && hash(pin.sha256)) &&
        r.sourcePins.some(
          (pin) => pin.id === scope.sourceId && pin.sha256 === scope.sourceSha256,
        ) &&
        Array.isArray(r.analysisPins) &&
        r.analysisPins.every((pin) => text(pin.id) && hash(pin.sha256)),
      "单项来源与分析固定指纹",
    );
    assert(
      isDeepStrictEqual(
        [...new Set([scope.sourceId, ...(artifact?.sourceIds ?? [])])].sort(),
        r.sourcePins.map((pin) => pin.id).sort(),
      ) &&
        isDeepStrictEqual(
          [...(artifact?.analysisIds ?? [])].sort(),
          r.analysisPins.map((pin) => pin.id).sort(),
        ),
      "单项交付与采用的证据集合不符",
    );
    if (r.kind === "citations") {
      assertResearchScopeFindings(scope, r.findings);
      assert(
        isDeepStrictEqual(
          p.artifacts.find((a) => a.id === r.artifactId)?.scopeFindings,
          r.findings,
        ),
        "引用核查逐项记录",
      );
    }
    if (r.adoptedAt) assert(date(r.adoptedAt) && text(r.adoptionReason), "单项采用来源");
    for (const adoption of r.adoptions ?? [])
      assert(
        Number.isSafeInteger(adoption.revision) &&
          adoption.revision >= r.revision &&
          adoption.revision <= p.revision &&
          date(adoption.at) &&
          text(adoption.reason),
        "后续采用记录",
      );
  }
  for (const s of m.specialists ?? []) {
    const task = p.fusion.tasks.find((t) => t.id === s.taskId);
    assert(
      text(s.id) &&
        task?.role === `specialist:${s.id}` &&
        task.stage === s.stage &&
        s.revision <= p.revision &&
        s.revision >= 1 &&
        text(s.ref?.workspaceId) &&
        text(s.ref.sessionId) &&
        ["method", "editor", "external-reviewer"].includes(s.kind) &&
        ["lead", "mentor"].includes(s.integrator) &&
        ["pending", "running", "submitted", "failed", "exited"].includes(s.state) &&
        text(s.label) &&
        text(s.objective) &&
        text(s.deliverable) &&
        text(s.exitCondition) &&
        Array.isArray(s.sourceIds) &&
        Array.isArray(s.artifactIds) &&
        Array.isArray(s.reads),
      "专项任务与独立会话",
    );
    if (s.model) decodeM3Model(s.model);
    for (const read of s.reads)
      assert(
        ["source", "artifact", "standards"].includes(read.kind) &&
          text(read.id) &&
          hash(read.sha256) &&
          date(read.at) &&
          p.fusion.attempts.some((a) => a.id === read.attemptId && a.taskId === s.taskId),
        "专项实际读取",
      );
    if (s.initialOpinion)
      assert(
        text(s.initialOpinion.content) &&
          date(s.initialOpinion.at) &&
          p.fusion.artifacts.some(
            (a) =>
              a.id === s.initialOpinion!.id &&
              a.taskId === s.taskId &&
              a.attemptId === s.initialOpinion!.attemptId &&
              a.content === s.initialOpinion!.content,
          ),
        "专项独立意见",
      );
    if (s.discussionOpenedAt)
      assert(
        !!s.initialOpinion &&
          text(s.discussionQuestion) &&
          date(s.discussionOpenedAt) &&
          Date.parse(s.discussionOpenedAt) >= Date.parse(s.initialOpinion.at),
        "外审初判前开放争论",
      );
    for (const opinion of s.followups ?? []) {
      assert(
        !!s.initialOpinion &&
          !!s.discussionOpenedAt &&
          date(opinion.at) &&
          Date.parse(opinion.at) >= Date.parse(s.discussionOpenedAt) &&
          text(opinion.content) &&
          p.fusion.artifacts.some(
            (a) =>
              a.id === opinion.id &&
              a.taskId === s.taskId &&
              a.attemptId === opinion.attemptId &&
              a.content === opinion.content,
          ),
        "专项后续意见",
      );
    }
    if (s.disposition)
      assert(
        !!s.initialOpinion &&
          ["user", "model"].includes(s.disposition.actor) &&
          s.disposition.by === s.integrator &&
          date(s.disposition.at) &&
          ["adopt", "revise", "decline"].includes(s.disposition.verdict) &&
          text(s.disposition.reason) &&
          [s.initialOpinion, ...(s.followups ?? [])].some(
            (o) => o?.id === s.disposition!.opinionId,
          ) &&
          p.artifacts.some(
            (a) =>
              a.id === s.disposition!.artifactId &&
              a.stage === s.stage &&
              (s.disposition!.verdict !== "adopt" || a.refs.includes(s.disposition!.opinionId)),
          ),
        "专项整合决定",
      );
  }
}
