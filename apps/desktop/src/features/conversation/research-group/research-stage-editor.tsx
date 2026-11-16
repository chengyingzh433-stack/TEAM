import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionRef } from "@lancer/session-driver";
import {
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  researchStages,
  type ResearchConfig,
  type ResearchProject,
  type ResearchThinkingLevel,
} from "../../../../contracts/research-group";
import {
  recommendResearchStages,
  RESEARCH_MODEL_GUIDANCE,
  RESEARCH_LATER_STAGE_GUIDANCE,
} from "../../../../contracts/research-model-recommendations";
import {
  RESEARCH_METHOD_VERSION,
  FUSION_STAGE_IDS,
  RESEARCH_ENTRIES,
  RESEARCH_GOALS,
  RESEARCH_PATHS,
  RESEARCH_ENTRY_LABELS,
  RESEARCH_GOAL_LABELS,
  RESEARCH_PATH_LABELS,
  RESEARCH_TASK_KINDS,
  RESEARCH_TASK_LABELS,
  defaultResearchGoal,
  researchExecutionRoute,
  researchEditorWorkflow,
} from "../../../../contracts/research-method";
import type {
  ResearchMethodConfig,
  ResearchSingleTaskKind,
} from "../../../../contracts/research-method";
import type { buildModelOptions } from "../composer-commands";
import "./research-stage-editor.css";

export function ResearchStageEditor({
  initialConfig,
  editingSavedConfig = false,
  options,
  project,
  onSave,
  onClose,
}: {
  initialConfig: ResearchConfig;
  editingSavedConfig?: boolean;
  options: ReturnType<typeof buildModelOptions>;
  project?: ResearchProject;
  onSave: (config: ResearchConfig, target?: SessionRef) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [workflowVersion, setWorkflowVersion] = useState<ResearchMethodConfig["workflowVersion"]>(
    researchEditorWorkflow(
      project ?? initialConfig,
      project ? "project" : editingSavedConfig ? "saved" : "new",
    ),
  );
  const fusion = workflowVersion === "fusion-v2";
  const [entry, setEntry] = useState<NonNullable<ResearchMethodConfig["entry"]>>(
    initialConfig.entry ?? "idea",
  );
  const [goal, setGoal] = useState<NonNullable<ResearchMethodConfig["goal"]>>(
    initialConfig.goal ?? defaultResearchGoal(initialConfig.entry),
  );
  const [taskKind, setTaskKind] = useState<ResearchSingleTaskKind>(
    initialConfig.task?.kind ??
      (initialConfig.entry === "manuscript" ? "manuscript-review" : "reading"),
  );
  const [taskScope, setTaskScope] = useState(initialConfig.task?.scope ?? "");
  const singleTask = goal === "task" || entry === "task";
  const route = researchExecutionRoute({
    workflowVersion,
    entry,
    goal,
    ...(singleTask ? { task: { kind: taskKind, scope: taskScope } } : {}),
  });
  const [path, setPath] = useState<NonNullable<ResearchMethodConfig["path"]> | "">(
    initialConfig.path ?? "",
  );
  const [directory, setDirectory] = useState(initialConfig.knowledgeDir);
  const [materialsDir, setMaterialsDir] = useState(initialConfig.materialsDir ?? "");
  const [scope, setScope] = useState(initialConfig.scope ?? "paper");
  const [memberTokenBudget, setMemberTokenBudget] = useState(
    initialConfig.memberTokenBudget ??
      ((initialConfig.scope ?? "paper") === "paper" ? 8_000_000 : 500_000),
  );
  const [stages, setStages] = useState(() =>
    !workflowVersion && (project || editingSavedConfig) && initialConfig.stages
      ? structuredClone(initialConfig.stages)
      : researchStages({ ...initialConfig, workflowVersion }),
  );
  const stageDrafts = useRef({
    legacy:
      !initialConfig.workflowVersion && initialConfig.stages
        ? structuredClone(initialConfig.stages)
        : researchStages({ ...initialConfig, workflowVersion: undefined }),
    fusion: researchStages({ ...initialConfig, workflowVersion: "fusion-v2" }),
  });
  const [applyCurrent, setApplyCurrent] = useState(!!project && project.status !== "running");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const preset = (kind: "balanced" | "fast") => {
    const proposed = recommendResearchStages(
      options.map((o) => ({ provider: o.providerId, modelId: o.modelId })),
      kind,
      workflowVersion,
    );
    if (proposed.missing.length) {
      setError(
        `本机尚未启用这些模型：${proposed.missing.join("、")}。请接入后再应用建议，或逐项选择现有模型。`,
      );
      return;
    }
    setError("");
    setStages((current) =>
      current.map((stage) => ({
        ...stage,
        models: proposed.stages.find((s) => s.id === stage.id)!.models,
      })),
    );
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (fusion && route.blockedReasons.length) throw new Error(route.blockedReasons.join(" "));
      await onSave(
        {
          knowledgeDir: directory,
          materialsDir,
          scope: fusion ? (goal === "paper" ? "paper" : "proposal") : scope,
          memberTokenBudget,
          stages,
          models: initialConfig.models,
          ...(fusion
            ? {
                workflowVersion,
                methodVersion: RESEARCH_METHOD_VERSION,
                entry,
                goal,
                ...(path ? { path } : {}),
                ...(singleTask ? { task: { kind: taskKind, scope: taskScope.trim() } } : {}),
              }
            : {}),
        },
        applyCurrent ? project?.root : undefined,
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="lancer-dialog research-stage-editor"
      aria-labelledby="research-stage-editor-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save().catch((e) => setError(String(e)));
        }}
      >
        <header>
          <h2 id="research-stage-editor-title">配置课题组阶段与模型</h2>
          <button type="button" aria-label="关闭" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="research-stage-editor__body">
          <p>
            每个阶段可分别配置四位成员。成员保留原会话，按中间成果各自进入下一阶段；设置会在模型请求和工具往返的边界生效。
          </p>
          <label className="research-stage-editor__field">
            本地课程知识库目录
            <input
              aria-label="课程知识库目录"
              value={directory}
              required
              disabled={busy}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="包含“索引”和“溯源”的完整文件夹路径"
            />
          </label>
          {!project ? (
            <label className="research-stage-editor__field">
              流程版本
              <select
                aria-label="研究流程版本"
                value={workflowVersion ?? "legacy"}
                disabled={busy}
                onChange={(e) => {
                  stageDrafts.current[fusion ? "fusion" : "legacy"] = stages;
                  const next = e.target.value === "fusion-v2" ? "fusion-v2" : undefined;
                  setWorkflowVersion(next);
                  setStages(stageDrafts.current[next ? "fusion" : "legacy"]);
                }}
              >
                <option value="fusion-v2">融合版 · S0–S8 方法导航</option>
                <option value="legacy">旧流程 · 保留原阶段配置</option>
              </select>
            </label>
          ) : null}
          {fusion ? (
            <>
              <p className="research-stage-editor__hint">
                共享研究方法 {RESEARCH_METHOD_VERSION} ·
                S0–S8。入口与本轮目标分别选择，阶段是方法导航，不要求每次全部执行。
              </p>
              <label className="research-stage-editor__field">
                从哪里开始
                <select
                  aria-label="研究入口"
                  value={entry}
                  disabled={busy}
                  onChange={(e) =>
                    setEntry(e.target.value as NonNullable<ResearchMethodConfig["entry"]>)
                  }
                >
                  {RESEARCH_ENTRIES.map((value) => (
                    <option key={value} value={value}>
                      {RESEARCH_ENTRY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="research-stage-editor__field">
                本轮做到哪里
                <select
                  aria-label="本轮研究目标"
                  value={goal}
                  disabled={busy}
                  onChange={(e) =>
                    setGoal(e.target.value as NonNullable<ResearchMethodConfig["goal"]>)
                  }
                >
                  {RESEARCH_GOALS.map((value) => (
                    <option key={value} value={value}>
                      {RESEARCH_GOAL_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              {singleTask ? (
                <>
                  <label className="research-stage-editor__field">
                    单项任务类型
                    <select
                      aria-label="单项任务类型"
                      value={taskKind}
                      disabled={busy}
                      onChange={(e) => setTaskKind(e.target.value as ResearchSingleTaskKind)}
                    >
                      {RESEARCH_TASK_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {RESEARCH_TASK_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="research-stage-editor__field">
                    本轮指定范围
                    <textarea
                      aria-label="单项任务范围"
                      value={taskScope}
                      required
                      maxLength={6000}
                      rows={3}
                      disabled={busy}
                      onChange={(e) => setTaskScope(e.target.value)}
                      placeholder="写明论文、三条引用、设计或章节名称，以及允许修改的内容"
                    />
                  </label>
                  <p className="research-stage-editor__hint">
                    这里登记任务范围。实际执行前仍需核对材料与可写范围；登记不表示正文已被修改、章节已受保护或内容已核验。
                  </p>
                </>
              ) : null}
              <p className="research-stage-editor__hint" aria-label="本轮路由说明">
                本轮方法范围：
                {route.needsInventory
                  ? "清点实际材料后确定"
                  : route.stageIds.map((id) => `S${FUSION_STAGE_IDS.indexOf(id)}`).join(" → ")}
                。{route.reason}
                {route.blockedReasons.length ? ` ${route.blockedReasons.join(" ")}` : ""}
              </p>
              <label className="research-stage-editor__field">
                研究路径
                <select
                  aria-label="研究路径"
                  value={path}
                  disabled={busy}
                  onChange={(e) =>
                    setPath(e.target.value as NonNullable<ResearchMethodConfig["path"]>)
                  }
                >
                  <option value="">先聚焦问题，再确定路径</option>
                  {RESEARCH_PATHS.map((value) => (
                    <option key={value} value={value}>
                      {RESEARCH_PATH_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              <p className="research-stage-editor__hint">
                没有数据也可以完成研究方案；实际分析须等待真实材料。已有方案或稿件先清点必要条件，不补造早期研究记录。
              </p>
            </>
          ) : (
            <label className="research-stage-editor__field">
              运行范围
              <select
                aria-label="研究运行范围"
                value={scope}
                disabled={busy}
                onChange={(e) => setScope(e.target.value as "paper" | "proposal")}
              >
                <option value="paper">完整论文流程：七个阶段（旧流程）</option>
                <option value="proposal">只做问题打磨与初步方案（旧流程）</option>
              </select>
            </label>
          )}
          <label className="research-stage-editor__field">
            每位成员累计 Token 上限（包含缓存计数）
            <input
              aria-label="成员 Token 上限"
              type="number"
              min={1000}
              max={10_000_000}
              step={1000}
              value={memberTokenBudget}
              disabled={busy}
              onChange={(e) => setMemberTokenBudget(Number(e.target.value))}
            />
          </label>
          <label className="research-stage-editor__field">
            研究材料目录（来源文本、CSV 数据和材料清单）
            <input
              aria-label="研究材料目录"
              value={materialsDir}
              disabled={busy}
              onChange={(e) => setMaterialsDir(e.target.value)}
              placeholder="可先留空；进入实证分析前需有真实或明确标注的演练数据"
            />
          </label>
          <p className="research-stage-editor__hint">
            材料目录使用 manifest.json
            记录出处、许可及数据类型。原文或数据缺失时会保留研究方案并等待补充，合成数据会在终稿显著标注。
          </p>
          <div className="research-stage-editor__presets">
            <button type="button" disabled={busy} onClick={() => preset("balanced")}>
              应用推荐配模
            </button>
            <button type="button" disabled={busy} onClick={() => preset("fast")}>
              快速试跑：全部 Flash
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setStages(stages.map((s) => ({ ...s, models: {} })))}
            >
              沿用成员当前模型
            </button>
          </div>
          <p className="research-stage-editor__hint">
            推荐：导师与关键复核用 Astra，主研究者用 Sol，资料整理用 Flash；默认 high / low，max
            留给特别棘手的任务。这是初始分工建议，尚未对你的研究任务做系统横向评测。
          </p>
          {stages.map((stage, index) => (
            <fieldset key={stage.id} disabled={busy} data-stage-id={stage.id}>
              <legend>
                阶段 {index + 1} · {stage.title}
              </legend>
              <label className="research-stage-editor__field">
                阶段名称
                <input
                  aria-label={`阶段 ${index + 1} 名称`}
                  required
                  maxLength={40}
                  value={stage.title}
                  onChange={(e) =>
                    setStages(
                      stages.map((s) => (s.id === stage.id ? { ...s, title: e.target.value } : s)),
                    )
                  }
                />
              </label>
              <div className="research-stage-editor__goals">
                <label className="research-stage-editor__field">
                  阶段目标
                  <textarea
                    aria-label={`阶段 ${index + 1} 目标`}
                    rows={3}
                    required
                    maxLength={2000}
                    value={stage.goal}
                    onChange={(e) =>
                      setStages(
                        stages.map((s) => (s.id === stage.id ? { ...s, goal: e.target.value } : s)),
                      )
                    }
                  />
                </label>
                <label className="research-stage-editor__field">
                  交付物与验收
                  <textarea
                    aria-label={`阶段 ${index + 1} 交付物`}
                    rows={3}
                    required
                    maxLength={2000}
                    value={stage.deliverables}
                    onChange={(e) =>
                      setStages(
                        stages.map((s) =>
                          s.id === stage.id ? { ...s, deliverables: e.target.value } : s,
                        ),
                      )
                    }
                  />
                </label>
              </div>
              {RESEARCH_ROLES.map((role) => {
                const model = stage.models[role];
                const key = model
                  ? JSON.stringify({ provider: model.provider, modelId: model.modelId })
                  : "";
                const configured =
                  !!model &&
                  !options.some(
                    (o) => o.providerId === model.provider && o.modelId === model.modelId,
                  );
                return (
                  <div className="research-stage-editor__member" key={role}>
                    <div>
                      <b>{RESEARCH_ROLE_LABELS[role]}</b>
                      <small>{RESEARCH_MODEL_GUIDANCE[role]}</small>
                    </div>
                    <label>
                      模型
                      <select
                        aria-label={`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}模型`}
                        value={key}
                        onChange={(e) => {
                          const selected = options.find(
                            (o) =>
                              JSON.stringify({ provider: o.providerId, modelId: o.modelId }) ===
                              e.target.value,
                          );
                          setStages(
                            stages.map((s) =>
                              s.id === stage.id
                                ? {
                                    ...s,
                                    models: {
                                      ...s.models,
                                      [role]: selected
                                        ? {
                                            provider: selected.providerId,
                                            modelId: selected.modelId,
                                            ...(model?.thinkingLevel
                                              ? { thinkingLevel: model.thinkingLevel }
                                              : {}),
                                          }
                                        : undefined,
                                    },
                                  }
                                : s,
                            ),
                          );
                        }}
                      >
                        <option value="">沿用成员当前模型</option>
                        {configured ? (
                          <option value={key}>
                            {model.provider}/{model.modelId}（当前不可用）
                          </option>
                        ) : null}
                        {options.map((o) => (
                          <option
                            key={`${o.providerId}/${o.modelId}`}
                            value={JSON.stringify({ provider: o.providerId, modelId: o.modelId })}
                          >
                            {o.label} · {o.providerId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      思考强度
                      <select
                        aria-label={`阶段 ${index + 1} ${RESEARCH_ROLE_LABELS[role]}思考强度`}
                        value={model?.thinkingLevel ?? ""}
                        disabled={!model}
                        onChange={(e) =>
                          setStages(
                            stages.map((s) =>
                              s.id === stage.id
                                ? {
                                    ...s,
                                    models: {
                                      ...s.models,
                                      [role]: {
                                        ...model!,
                                        thinkingLevel: e.target.value
                                          ? (e.target.value as ResearchThinkingLevel)
                                          : undefined,
                                      },
                                    },
                                  }
                                : s,
                            ),
                          )
                        }
                      >
                        <option value="">沿用会话</option>
                        <option value="low">low · 较快</option>
                        <option value="high">high · 深度推理</option>
                        <option value="max">max · 最深入</option>
                        {model?.thinkingLevel &&
                        !["low", "high", "max"].includes(model.thinkingLevel) ? (
                          <option value={model.thinkingLevel}>{model.thinkingLevel}</option>
                        ) : null}
                      </select>
                    </label>
                  </div>
                );
              })}
            </fieldset>
          ))}
          <details>
            <summary>完整流程怎样选模型</summary>
            <p className="research-stage-editor__hint">
              下列研究工作已接入完整流程；阶段按审阅结果推进，资料发布后立即交接。
            </p>
            <table>
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>建议模型</th>
                  <th>用途</th>
                </tr>
              </thead>
              <tbody>
                {RESEARCH_LATER_STAGE_GUIDANCE.map((s) => (
                  <tr key={s.title}>
                    <td>{s.title}</td>
                    <td>{s.model}</td>
                    <td>{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          {project ? (
            <label className="research-stage-editor__apply">
              <input
                type="checkbox"
                checked={applyCurrent}
                disabled={busy || project.status === "running"}
                onChange={(e) => setApplyCurrent(e.target.checked)}
              />
              同时用于当前课题的后续运行
            </label>
          ) : null}
          <p className="research-stage-editor__hint">
            保存为新课题模板。
            {project?.status === "running"
              ? "当前课题正在运行，需暂停后才能修改其配置。"
              : "应用到当前课题时保留已有成果、会话和实际模型记录。"}
            知识库变更从新输入版本生效。
          </p>
          {error ? (
            <p role="alert" className="research-group-error">
              {error}
            </p>
          ) : null}
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={busy || !directory.trim()}>
            {busy ? "正在检查…" : "检查并保存连接与阶段配置"}
          </button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
