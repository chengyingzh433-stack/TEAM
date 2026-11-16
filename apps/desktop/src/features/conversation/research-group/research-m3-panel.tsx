import { useState } from "react";
import type { SessionRef } from "@lancer/session-driver";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  type ResearchGroupAction,
  type ResearchGroupsState,
  type ResearchModel,
  type ResearchProject,
  type ResearchRole,
  type ResearchThinkingLevel,
} from "../../../../contracts/research-group";
import {
  researchSelectableTaskRanges,
  type ResearchM3Action,
  type ResearchSpecialist,
} from "../../../../contracts/research-m3";
import type { buildModelOptions } from "../composer-commands";
import { MessageMarkdown } from "../message-markdown";
import { parseResearchControlTokenCount } from "../../../../contracts/research-task-controls";
import { RESEARCH_TASK_LABELS } from "../../../../contracts/research-method";

type Props = {
  project: ResearchProject;
  state: ResearchGroupsState;
  busy: boolean;
  options: ReturnType<typeof buildModelOptions>;
  act: (action: ResearchGroupAction) => Promise<void>;
  onSelect: (target: SessionRef) => void;
};
const modelSources: Record<string, string> = {
  "task-override": "任务覆盖",
  "stage-role": "阶段角色",
  "project-default": "项目默认",
  "application-default": "应用默认",
  "session-current": "原会话选择",
  "authorized-recovery": "已授权恢复候选",
};
const specialistKinds = {
  method: "方法与分析专员",
  editor: "学术编辑",
  "external-reviewer": "阶段独立外审",
};
const specialistStates = {
  pending: "待执行",
  running: "执行中",
  submitted: "已交付，待整合",
  failed: "失败，需核查",
  exited: "已退出",
};

export function ResearchM3Panel({ project: p, state, busy, options, act, onSelect }: Props) {
  const [error, setError] = useState("");
  const [applicationLimit, setApplicationLimit] = useState(state.m3?.applicationLimit ?? 8);
  const [projectLimit, setProjectLimit] = useState(p.m3?.projectLimit ?? 4);
  const [tokenBudget, setTokenBudget] = useState(p.m3?.tokenBudget?.toString() ?? "");
  const [taskId, setTaskId] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [thinking, setThinking] = useState<ResearchThinkingLevel>("high");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [defaultLevel, setDefaultLevel] = useState<"project" | "application">("project");
  const [defaultRole, setDefaultRole] = useState<ResearchRole>("lead");
  const [sourceId, setSourceId] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [kind, setKind] = useState<ResearchSpecialist["kind"]>("method");
  const [label, setLabel] = useState("");
  const [objective, setObjective] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [exitCondition, setExitCondition] = useState("");
  const [integrator, setIntegrator] = useState<"lead" | "mentor">("lead");
  const [specialSources, setSpecialSources] = useState<string[]>([]);
  const [specialArtifacts, setSpecialArtifacts] = useState<string[]>([]);
  const [adoptionReason, setAdoptionReason] = useState("");
  const [discussionQuestions, setDiscussionQuestions] = useState<Record<string, string>>({});
  const [presetName, setPresetName] = useState<"balanced" | "economy" | "review">("balanced");
  const [presetModels, setPresetModels] = useState<Partial<Record<ResearchRole, string>>>({});
  const submit = (input: ResearchM3Action) => {
    setError("");
    void act({ kind: "m3", target: p.root, input }).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };
  const model = (key: string): ResearchModel | undefined => {
    const selected = options.find((o) => o.value === key);
    return selected
      ? { provider: selected.providerId, modelId: selected.modelId, thinkingLevel: thinking }
      : undefined;
  };
  const picker = (name: string, value: string, change: (value: string) => void) => (
    <label>
      {name}
      <select value={value} onChange={(event) => change(event.target.value)}>
        <option value="">沿用继承配置</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const preview = p.m3?.scopePreview;
  const ranges = preview ? researchSelectableTaskRanges(preview.body, p.task?.kind ?? "") : [];
  const currentTasks = p.fusion?.tasks.filter((t) => t.id.startsWith(`v${p.revision}:`)) ?? [];
  const currentManuscripts = p.artifacts.filter(
    (a) =>
      a.revision === p.revision &&
      a.role === "lead" &&
      ["stage-draft", "stage-revision"].includes(a.kind) &&
      p.fusion?.tasks.some((t) => t.currentArtifactId === a.id),
  );
  const savedPreset = state.m3?.modelPresets?.find((preset) => preset.name === presetName);
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
  if (p.workflowVersion !== "fusion-v2")
    return <ResearchLegacyExecutionPanel project={p} state={state} busy={busy} act={act} />;
  return (
    <div className="research-m3">
      <details className="research-group-records" data-testid="research-m3-execution">
        <summary>执行容量与任务配模</summary>
        <p>
          新调用遵循任务覆盖 → 阶段角色 → 项目默认 → 应用默认 →
          原会话选择。在途调用保留原模型；降低名额只影响后续派发。额度按已知用量和预留准入，实际结算仍可能超出配置。
        </p>
        <label>
          应用同时执行上限
          <input
            type="number"
            min={1}
            max={64}
            value={applicationLimit}
            onChange={(e) => setApplicationLimit(Number(e.target.value))}
          />
        </label>
        <label>
          本课题同时执行上限
          <input
            type="number"
            min={1}
            max={16}
            value={projectLimit}
            onChange={(e) => setProjectLimit(Number(e.target.value))}
          />
        </label>
        <label>
          本课题累计 Token 准入额度（可选）
          <input
            type="number"
            min={1000}
            max={100000000}
            value={tokenBudget}
            onChange={(e) => setTokenBudget(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            submit({
              operation: "execution-settings",
              applicationLimit,
              projectLimit,
              tokenBudget: tokenBudget ? Number(tokenBudget) : null,
            })
          }
        >
          保存执行名额与额度
        </button>
        {p.m3?.queued?.map((q) => (
          <p key={q.taskId}>
            排队：{currentTasks.find((t) => t.id === q.taskId)?.goal ?? q.taskId} · {q.reason}
          </p>
        ))}
        <label>
          选择当前任务
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">选择任务</option>
            {currentTasks.map((t) => (
              <option value={t.id} key={t.id}>
                {t.stage} ·{" "}
                {RESEARCH_ROLE_LABELS[t.role as ResearchRole] ??
                  p.m3?.specialists?.find((s) => s.taskId === t.id)?.label ??
                  t.role}
              </option>
            ))}
          </select>
        </label>
        {picker("指定模型", modelKey, setModelKey)}
        <label>
          思考强度
          <select
            value={thinking}
            onChange={(e) => setThinking(e.target.value as ResearchThinkingLevel)}
          >
            {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        {picker("临时服务错误的已授权替代模型（可选）", recoveryKey, setRecoveryKey)}
        <p>候选只用于可恢复临时错误，最多一次；认证、模型不存在和未知用量保留待处理。</p>
        <button
          type="button"
          disabled={busy || !taskId}
          onClick={() =>
            submit({
              operation: "task-model",
              taskId,
              model: model(modelKey),
              ...(model(recoveryKey)
                ? { recovery: { candidates: [model(recoveryKey)!], maxRetries: 1 } }
                : {}),
            })
          }
        >
          保存任务覆盖与恢复候选
        </button>
        <label>
          默认配置层级
          <select
            value={defaultLevel}
            onChange={(e) => setDefaultLevel(e.target.value as "project" | "application")}
          >
            <option value="project">本课题</option>
            <option value="application">应用</option>
          </select>
        </label>
        <label>
          默认角色
          <select
            value={defaultRole}
            onChange={(e) => setDefaultRole(e.target.value as ResearchRole)}
          >
            {RESEARCH_ROLES.map((role) => (
              <option value={role} key={role}>
                {RESEARCH_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            submit({
              operation: "default-model",
              level: defaultLevel,
              role: defaultRole,
              model: model(modelKey),
            })
          }
        >
          保存所选角色默认模型
        </button>
        <details>
          <summary>保存与应用配模预设</summary>
          <p>
            从你实际可用的模型保存角色配置。应用前预览只补齐空缺的项目默认；阶段、任务覆盖和已有项目默认保留。在途调用使用原模型。
          </p>
          <label>
            预设名称
            <select
              value={presetName}
              onChange={(e) => setPresetName(e.target.value as typeof presetName)}
            >
              <option value="balanced">均衡</option>
              <option value="economy">节约</option>
              <option value="review">重审</option>
            </select>
          </label>
          {RESEARCH_ROLES.map((role) => (
            <div key={role}>
              {picker(
                `${RESEARCH_ROLE_LABELS[role]}的预设模型`,
                presetModels[role] ?? "",
                (value) => setPresetModels((models) => ({ ...models, [role]: value })),
              )}
            </div>
          ))}
          <p>新保存的选择采用上方思考强度 {thinking}；未指定的角色不写入预设。</p>
          <button
            type="button"
            disabled={busy || !RESEARCH_ROLES.some((role) => model(presetModels[role] ?? ""))}
            onClick={() =>
              submit({
                operation: "save-model-preset",
                name: presetName,
                models: Object.fromEntries(
                  RESEARCH_ROLES.flatMap((role) => {
                    const selected = model(presetModels[role] ?? "");
                    return selected ? [[role, selected]] : [];
                  }),
                ),
              })
            }
          >
            保存这些选择为预设
          </button>
          {savedPreset ? (
            <>
              <p>应用变化预览（{savedPreset.savedAt} 保存）：</p>
              {RESEARCH_ROLES.map((role) => (
                <p key={role}>
                  {RESEARCH_ROLE_LABELS[role]}：
                  {p.m3?.defaultModels?.[role]
                    ? "保留已有项目默认"
                    : savedPreset.models[role]
                      ? `补入 ${savedPreset.models[role]!.provider}/${savedPreset.models[role]!.modelId} · ${savedPreset.models[role]!.thinkingLevel ?? "原强度"}`
                      : "没有预设选择，保留继承"}
                </p>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => submit({ operation: "apply-model-preset", name: presetName })}
              >
                按预览补齐项目默认
              </button>
            </>
          ) : (
            <p>该预设尚未保存。</p>
          )}
        </details>
        {p.fusion?.attempts
          .filter((a) => a.taskId.startsWith(`v${p.revision}:`))
          .map((a) => (
            <p key={a.id}>
              {a.taskId} · {a.state} ·{" "}
              {a.model ? `${a.model.provider}/${a.model.modelId}` : "待确认实际模型"} ·{" "}
              {modelSources[a.modelSource ?? "session-current"]} ·{" "}
              {a.usedTokens === undefined
                ? `预留 ${a.reservedTokens}，结算未知`
                : `已知 ${a.usedTokens}`}
            </p>
          ))}
      </details>
      {p.goal === "task" && p.task ? (
        <details className="research-group-records" data-testid="research-m3-scope">
          <summary>指定材料与修改范围</summary>
          <p>
            先暂停课题，查看实际原文并选择本轮范围。原稿保留，未选正文由程序原样拼回；改变已执行任务的范围需要新输入版本。
          </p>
          <label>
            目标材料
            <select
              value={sourceId}
              onChange={(e) => {
                setSourceId(e.target.value);
                setSelected([]);
              }}
            >
              <option value="">选择已采用材料</option>
              {p.evidence?.sources.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || !sourceId}
            onClick={() => {
              setSelected([]);
              submit({ operation: "preview-task-source", sourceId });
            }}
          >
            查看目标原文
          </button>
          {preview?.sourceId === sourceId ? (
            <>
              {ranges.map((range, i) => (
                <label key={`${preview.bodySha256}:${i}`}>
                  <input
                    type="checkbox"
                    checked={selected.includes(i)}
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(i) ? current.filter((n) => n !== i) : [...current, i],
                      )
                    }
                  />
                  {range.label}
                </label>
              ))}
              <details>
                <summary>查看完整原文</summary>
                <pre>{preview.body}</pre>
              </details>
              <button
                type="button"
                disabled={busy || p.status === "running" || !selected.length}
                onClick={() =>
                  submit({
                    operation: "task-scope",
                    sourceId: preview.sourceId,
                    sourceSha256: preview.sourceSha256,
                    ranges: ranges.filter((_, i) => selected.includes(i)),
                  })
                }
              >
                固定选定范围
              </button>
            </>
          ) : null}
          {p.m3?.scopes
            ?.filter((s) => s.revision === p.revision)
            .map((s) => (
              <p key={s.id}>本轮范围：{s.ranges.map((r) => r.label).join("；")}</p>
            ))}
        </details>
      ) : null}
      {p.m3?.memberInputs?.length ? (
        <details className="research-group-records">
          <summary>成员补充与处理记录</summary>
          <p>
            成员对话的补充使用同一课题名额。下一轮发送等待当前运行结束；外审初判前的问题先保存，初判后再开放。模型说明与用户许可分别记录。
          </p>
          {p.m3.memberInputs.map((input) => (
            <article key={input.id}>
              <p>
                输入版本 {input.revision} ·{" "}
                {RESEARCH_ROLE_LABELS[input.actor as ResearchRole] ??
                  p.m3?.specialists?.find((s) => `specialist:${s.id}` === input.actor)?.label ??
                  input.actor}{" "}
                · 任务版本 {input.taskVersion} ·{" "}
                {input.delivery === "steer" ? "尽快交接" : "下一轮接续"} ·{" "}
                {input.attemptId ? "已记录投送" : "待投送或已转历史"}
              </p>
              <MessageMarkdown text={input.text} />
              {input.responses?.map((response) => (
                <details key={response.id}>
                  <summary>
                    模型处理说明 ·{" "}
                    {response.disposition === "no-manuscript-change" ? "无需改稿" : "需要修订"}
                  </summary>
                  <MessageMarkdown text={response.content} />
                </details>
              ))}
            </article>
          ))}
        </details>
      ) : null}
      {p.m3?.results?.length ? (
        <details className="research-group-records">
          <summary>单项报告与后续采用</summary>
          <p>采用前检查原稿、支持材料和分析文件。采用只增加参考材料，后续任务仍需独立核查。</p>
          <label>
            采用理由
            <input value={adoptionReason} onChange={(e) => setAdoptionReason(e.target.value)} />
          </label>
          {p.m3.results.map((result) => (
            <details key={result.id}>
              <summary>
                输入版本 {result.revision} · {RESEARCH_TASK_LABELS[result.kind]} ·{" "}
                {result.adoptedAt ? "曾采用" : "待核对采用"}
              </summary>
              <MessageMarkdown text={result.fullText} />
              <button
                type="button"
                disabled={
                  busy ||
                  !adoptionReason.trim() ||
                  !!result.adoptions?.some((a) => a.revision === p.revision)
                }
                onClick={() =>
                  submit({
                    operation: "adopt-task-result",
                    resultId: result.id,
                    reason: adoptionReason,
                  })
                }
              >
                作为新材料采用，保留原稿
              </button>
            </details>
          ))}
        </details>
      ) : null}
      <details className="research-group-records" data-testid="research-m3-specialists">
        <summary>专项成员与独立外审</summary>
        <p>
          专项成员使用新会话和限定输入，提交意见后交指定整合人。外审先提交独立意见，再由你开放旧争论。
        </p>
        <label>
          成员类型
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ResearchSpecialist["kind"])}
          >
            {Object.entries(specialistKinds).map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <label>
          成员名称
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          专项任务
          <textarea value={objective} onChange={(e) => setObjective(e.target.value)} />
        </label>
        <label>
          交付要求
          <textarea value={deliverable} onChange={(e) => setDeliverable(e.target.value)} />
        </label>
        <label>
          退出条件
          <input value={exitCondition} onChange={(e) => setExitCondition(e.target.value)} />
        </label>
        <label>
          整合责任人
          <select
            value={integrator}
            onChange={(e) => setIntegrator(e.target.value as "lead" | "mentor")}
          >
            <option value="lead">研究者 A</option>
            <option value="mentor">导师</option>
          </select>
        </label>
        {picker("专项模型", modelKey, setModelKey)}
        <fieldset>
          <legend>允许读取的原始材料</legend>
          {p.evidence?.sources.map((source) => (
            <label key={source.id}>
              <input
                type="checkbox"
                checked={specialSources.includes(source.id)}
                onChange={() => setSpecialSources(toggle(specialSources, source.id))}
              />
              {source.title}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>当前待审稿</legend>
          {currentManuscripts.map((a) => (
            <label key={a.id}>
              <input
                type="checkbox"
                checked={specialArtifacts.includes(a.id)}
                onChange={() => setSpecialArtifacts(toggle(specialArtifacts, a.id))}
              />
              {a.stage} · {a.kind} · {a.createdAt}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          disabled={
            busy ||
            !label.trim() ||
            !objective.trim() ||
            !deliverable.trim() ||
            !exitCondition.trim() ||
            !specialSources.length ||
            p.status === "completed"
          }
          onClick={() =>
            submit({
              operation: "add-specialist",
              kind,
              label,
              objective,
              deliverable,
              exitCondition,
              integrator,
              sourceIds: specialSources,
              artifactIds: specialArtifacts,
              model: model(modelKey),
            })
          }
        >
          加入专项成员
        </button>
        {p.m3?.specialists?.map((s) => (
          <article key={s.id}>
            <p>
              {s.label} · {specialistKinds[s.kind]} · {specialistStates[s.state]}
            </p>
            <p>{s.objective}</p>
            <button type="button" onClick={() => onSelect(s.ref)}>
              打开该成员对话
            </button>
            {s.initialOpinion && !s.discussionOpenedAt ? (
              <label>
                开放后需要处理的具体问题
                <input
                  value={discussionQuestions[s.id] ?? ""}
                  onChange={(e) =>
                    setDiscussionQuestions((q) => ({ ...q, [s.id]: e.target.value }))
                  }
                  placeholder="留空则围绕原专项问题复核新增意见"
                />
              </label>
            ) : null}
            <button
              type="button"
              disabled={busy || !s.initialOpinion || !!s.discussionOpenedAt || s.state === "exited"}
              onClick={() =>
                submit({
                  operation: "open-specialist-discussion",
                  specialistId: s.id,
                  ...(discussionQuestions[s.id]?.trim()
                    ? { question: discussionQuestions[s.id] }
                    : {}),
                })
              }
            >
              独立初判后开放讨论
            </button>
            <button
              type="button"
              disabled={busy || s.state === "exited"}
              onClick={() => submit({ operation: "exit-specialist", specialistId: s.id })}
            >
              结束专项任务，保留记录
            </button>
            {s.error ? <p role="alert">{s.error}</p> : null}
            {s.initialOpinion ? (
              <details>
                <summary>独立意见</summary>
                <MessageMarkdown text={s.initialOpinion.content} />
              </details>
            ) : null}
            {s.followups?.map((opinion, index) => (
              <details key={opinion.id}>
                <summary>
                  后续意见 {index + 1} · {opinion.at}
                </summary>
                <MessageMarkdown text={opinion.content} />
              </details>
            ))}
            {s.disposition ? (
              <p>
                整合处理：{s.disposition.verdict} · {s.disposition.reason}
              </p>
            ) : null}
          </article>
        ))}
      </details>
      {p.m3?.pathRecords?.length ? (
        <details className="research-group-records">
          <summary>非数值分析证据与复核</summary>
          {p.m3.pathRecords.map((record) => (
            <article key={record.id}>
              <p>
                {record.input.path} · {record.input.scope} · {record.input.approach}
              </p>
              <details>
                <summary>查看片段、编码／综合／论证及局限</summary>
                <p>
                  范围：{record.input.scope}；取向：{record.input.approach}
                </p>
                {record.input.evidence.map((e) => (
                  <blockquote key={e.id}>
                    <p>{record.excerpts.find((x) => x.id === e.id)?.text}</p>
                    <p>
                      {e.sourceId} · {e.locatorId} · {e.start}–{e.end}：{e.interpretation}
                    </p>
                  </blockquote>
                ))}
                {record.input.review ? (
                  <>
                    <p>纳排：{record.input.review.inclusionCriteria}</p>
                    <p>质量判断：{record.input.review.qualityAssessment}</p>
                    <p>选择局限：{record.input.review.selectionLimitations}</p>
                  </>
                ) : null}
                {record.input.qualitative ? (
                  <>
                    <p>研究者立场：{record.input.qualitative.researcherPosition}</p>
                    {record.input.qualitative.codes.map((c) => (
                      <p key={c.id}>
                        编码 {c.label}（{c.evidenceIds.join("、")}）：{c.interpretation}
                      </p>
                    ))}
                    {record.input.qualitative.themes.map((t) => (
                      <p key={t.id}>
                        主题 {t.label}：{t.claim}；编码 {t.codeIds.join("、")}；反例{" "}
                        {t.counterEvidenceIds.join("、") || "未发现，见搜索说明"}
                      </p>
                    ))}
                    <p>反例搜索：{record.input.qualitative.negativeCaseSearch}</p>
                    <p>反思：{record.input.qualitative.reflexivity}</p>
                  </>
                ) : null}
                {record.input.theoretical ? (
                  <>
                    {record.input.theoretical.concepts.map((c) => (
                      <p key={c.id}>
                        概念 {c.id}：{c.definition}（{c.evidenceIds.join("、")}）
                      </p>
                    ))}
                    {record.input.theoretical.arguments.map((a) => (
                      <div key={a.id}>
                        <p>
                          命题：{a.proposition}；前提 {a.premiseIds.join("、")}
                        </p>
                        <ol>
                          {a.steps.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ol>
                        <p>竞争解释：{a.competingExplanation}</p>
                        <p>反例：{a.counterexample}</p>
                      </div>
                    ))}
                  </>
                ) : null}
                <p>局限：{record.input.limitations}</p>
              </details>
              {p.m3?.pathReviews
                ?.filter((r) => r.recordId === record.id)
                .map((r) => (
                  <p key={r.id}>
                    {RESEARCH_ROLE_LABELS[r.role]} · {r.verdict}：{r.reason}
                  </p>
                ))}
            </article>
          ))}
        </details>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function ResearchLegacyExecutionPanel({
  project: p,
  state,
  busy,
  act,
}: Pick<Props, "project" | "state" | "busy" | "act">) {
  const settings = state.m3?.legacySettings?.find((s) => s.projectId === p.id);
  const [applicationLimit, setApplicationLimit] = useState(state.m3?.applicationLimit ?? 8);
  const [projectLimit, setProjectLimit] = useState(settings?.projectLimit ?? 4);
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [tokens, setTokens] = useState("");
  const [error, setError] = useState("");
  const submit = (action: ResearchGroupAction) => {
    setError("");
    void act(action).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <details className="research-group-records research-m3">
      <summary>旧流程的共享执行名额</summary>
      <p>沿用当前课题流程，所有研究课题和专项成员共享应用名额。未知执行先核实，未结算用量保留。</p>
      <label>
        应用上限
        <input
          type="number"
          min={1}
          max={64}
          value={applicationLimit}
          onChange={(e) => setApplicationLimit(Number(e.target.value))}
        />
      </label>
      <label>
        课题上限
        <input
          type="number"
          min={1}
          max={16}
          value={projectLimit}
          onChange={(e) => setProjectLimit(Number(e.target.value))}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          submit({
            kind: "m3",
            target: p.root,
            input: { operation: "execution-settings", applicationLimit, projectLimit },
          })
        }
      >
        保存执行名额
      </button>
      {state.m3?.legacyQueue
        ?.filter((q) => q.projectId === p.id && q.revision === p.revision)
        .map((q, i) => (
          <p key={i}>
            {RESEARCH_ROLE_LABELS[q.role]}：{q.reason}
          </p>
        ))}
      {state.m3?.legacyExecutions
        ?.filter((a) => a.projectId === p.id)
        .map((a) => (
          <p key={a.id}>
            {RESEARCH_ROLE_LABELS[a.role]} · {a.state} ·{" "}
            {a.usedTokens === undefined
              ? `预留 ${a.reservedTokens}，结算未知`
              : `已知 ${a.usedTokens}`}{" "}
            · {a.nativeRunId ?? "原生身份待核"}
          </p>
        ))}
      {state.m3?.legacyExecutions?.some((a) => a.projectId === p.id && a.state === "unknown") ? (
        <>
          <label>
            核实依据
            <input value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} />
          </label>
          <label>
            核实说明
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label>
            实际 Token（未知留空）
            <input value={tokens} onChange={(e) => setTokens(e.target.value)} />
          </label>
          {state.m3.legacyExecutions
            .filter((a) => a.projectId === p.id && a.state === "unknown")
            .map((a) => (
              <div key={a.id}>
                <p>
                  {RESEARCH_ROLE_LABELS[a.role]} · {a.id}
                </p>
                {(["succeeded", "failed", "cancelled"] as const).map((outcome) => (
                  <button
                    key={outcome}
                    type="button"
                    disabled={busy || !reason.trim() || !evidenceRef.trim()}
                    onClick={() => {
                      try {
                        submit({
                          kind: "resolve-attempt",
                          target: p.root,
                          input: {
                            attemptId: a.id,
                            outcome,
                            reason,
                            evidenceRef,
                            usedTokens: parseResearchControlTokenCount(tokens),
                          },
                        });
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    确认
                    {outcome === "succeeded" ? "已结束" : outcome === "failed" ? "失败" : "取消"}
                  </button>
                ))}
              </div>
            ))}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
