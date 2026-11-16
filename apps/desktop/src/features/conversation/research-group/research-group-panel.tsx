import { ResearchDiscussionPanel } from "./research-discussion-panel";
import { ResearchCurrentHelp } from "./research-current-help";
import { ResearchUsagePanel } from "./research-usage-panel";
import { ResearchArchiveControl } from "./research-archive-control";
import { ResearchTaskControls } from "./research-task-controls";
import { ResearchM3Panel } from "./research-m3-panel";
import { ResearchMaterialItem } from "./research-material-list";
import { ResearchMaterialChangeControl } from "./research-material-change-control";
import { ResearchLegacyMigrationControl } from "./research-legacy-migration-control";
import { useState } from "react";
import { ResearchAnalysisRegistryPanel } from "./research-analysis-registry-panel";
import { ResearchContentChecks } from "./research-content-checks";
import { ResearchClaimsPanel } from "./research-claims-panel";
import { ResearchMethodPackagesPanel } from "./research-method-packages-panel";
import { ResearchLiteraturePanel } from "./research-literature-panel";
import { ResearchLanguagePanel } from "./research-language-panel";
import { ResearchSourcePagesPanel } from "./research-source-pages-panel";
import { ResearchSynthesisPanel } from "./research-synthesis-panel";
import {
  RESEARCH_GROUP_ZONE,
  RESEARCH_ROLES,
  RESEARCH_ROLE_LABELS,
  researchProjectFor,
  researchStages,
  type ResearchConfig,
  type ResearchGroupAction,
} from "../../../../contracts/research-group";
import {
  RESEARCH_ENTRY_LABELS,
  RESEARCH_GOAL_LABELS,
  RESEARCH_PATH_LABELS,
} from "../../../../contracts/research-method";
import { conversationZoneId } from "../../../../contracts/lancer-zones";
import type { LiveProcessInput } from "../lancer-process/live-model";
import { buildModelOptions } from "../composer-commands";
import { MessageMarkdown } from "../message-markdown";
import { ResearchStageEditor } from "./research-stage-editor";
import "./research-group.css";

const kinds: Record<string, string> = {
  plan: "导师边界",
  proposal: "独立初稿",
  assessment: "独立风险判断",
  material: "方法资料",
  critique: "方案批评",
  revision: "修订方案",
  verification: "复核",
  review: "导师裁定",
  "stage-draft": "独立初稿",
  "stage-risk": "独立风险判断",
  "stage-material": "中间资料",
  "stage-critique": "具体批评",
  "stage-revision": "完整修订",
  "stage-verification": "逐条复核",
  "stage-review": "阶段裁定",
};
const statuses = {
  running: "协作进行中",
  paused: "已暂停",
  "needs-decision": "需要决定",
  completed: "本轮审阅完成",
};

export function ResearchGroupPanel({
  input,
  onSelectThread,
}: {
  input: LiveProcessInput;
  onSelectThread: (target: { workspaceId: string; sessionId: string }) => void;
}) {
  const target = { workspaceId: input.workspaceId ?? "", sessionId: input.selectedSessionId };
  const project = researchProjectFor(input.researchGroups, target);
  const session = input.threads.find(
    (t) => t.workspaceId === target.workspaceId && t.session.id === target.sessionId,
  )?.session;
  const zone =
    input.newThreadZone ?? conversationZoneId(session?.title ?? "", input.assistants?.modules);
  if (zone !== RESEARCH_GROUP_ZONE && !project) return null;
  return (
    <ResearchGroupContent
      key={project?.id ?? `${target.workspaceId}:${target.sessionId}`}
      input={input}
      onSelectThread={onSelectThread}
    />
  );
}

function ResearchGroupContent({ input, onSelectThread }: Parameters<typeof ResearchGroupPanel>[0]) {
  const target = { workspaceId: input.workspaceId ?? "", sessionId: input.selectedSessionId };
  const state = input.researchGroups;
  const project = researchProjectFor(state, target);
  const [editing, setEditing] = useState(!state?.config.knowledgeDir);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [allEvents, setAllEvents] = useState(false);
  const [conditions, setConditions] = useState("");
  const options = buildModelOptions(input.runtime);
  const act = async (action: ResearchGroupAction) => {
    setBusy(true);
    setError("");
    try {
      if (!window.piApp) throw new Error("桌面连接不可用。");
      const next = await window.piApp.researchGroupAction(action);
      if (next.lastError) throw new Error(next.lastError);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const artifacts = project?.artifacts.filter((a) => a.revision === project.revision) ?? [];
  const decision = artifacts
    .filter(
      (a) =>
        ["review", "stage-review"].includes(a.kind) &&
        (!a.stage || a.stage === project?.currentStage),
    )
    .at(-1);
  const needsNewInput =
    project?.status === "needs-decision" &&
    (decision?.verdict === "hold" ||
      (decision?.verdict === "revise" &&
        artifacts.filter(
          (a) =>
            ["revision", "stage-revision"].includes(a.kind) &&
            (!a.stage || a.stage === project?.currentStage),
        ).length >= 2));
  const run = (action: ResearchGroupAction) => {
    void act(action).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section
      className="research-group"
      aria-label="教育研究课题组"
      data-status={project?.status ?? "ready"}
    >
      <ResearchCurrentHelp />
      {project?.fusion && (
        <ResearchDiscussionPanel
          project={project}
          busy={busy}
          onSend={(input) => act({ kind: "discussion", target, input })}
        />
      )}
      {project && project.workflowVersion !== "fusion-v2" && state ? (
        <ResearchLegacyMigrationControl
          project={project}
          config={state.config}
          busy={busy}
          onPreview={async (input) => {
            if (!window.piApp) throw new Error("桌面连接不可用。");
            return window.piApp.previewResearchLegacyMigration({
              kind: "preview-legacy-migration",
              target,
              input,
            });
          }}
          onApply={(input) => act({ kind: "apply-legacy-migration", target, input })}
        />
      ) : null}
      <div className="research-group-heading">
        <div>
          <strong>教育研究课题组</strong>
          <span>{project ? statuses[project.status] : "从研究想法到论文终稿"}</span>
        </div>
        <div className="research-group-actions">
          <button
            type="button"
            onClick={() => {
              setEditing(true);
            }}
          >
            配置阶段、模型与知识库
          </button>
          {project ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run({ kind: "import-materials", target })}
            >
              导入研究材料
            </button>
          ) : null}
          {project?.fusion ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run({ kind: "inspect-materials", target })}
            >
              清点实际材料
            </button>
          ) : null}
          {project?.status === "running" ? (
            <button type="button" disabled={busy} onClick={() => run({ kind: "pause", target })}>
              暂停全组
            </button>
          ) : project && project.status !== "completed" && !needsNewInput ? (
            <button type="button" disabled={busy} onClick={() => run({ kind: "resume", target })}>
              {project.revision === 0 ? "开始新修改任务" : "恢复未完成工作"}
            </button>
          ) : null}
          {project && project.root.sessionId !== target.sessionId ? (
            <button type="button" onClick={() => onSelectThread(project.root)}>
              返回导师会话
            </button>
          ) : null}
        </div>
      </div>
      {editing ? (
        <ResearchStageEditor
          initialConfig={{
            ...(state?.config ?? { knowledgeDir: "" }),
            ...(project?.stages ? { stages: project.stages } : {}),
            ...(project
              ? {
                  workflowVersion: project.workflowVersion,
                  methodVersion: project.methodVersion,
                  entry: project.entry,
                  goal: project.goal,
                  path: project.path,
                  task: project.task,
                  scope: project.scope ?? "proposal",
                  materialsDir:
                    project.materialsDir ??
                    project.evidence?.directory ??
                    state?.config.materialsDir,
                  memberTokenBudget: project.memberTokenBudget,
                }
              : {}),
          }}
          options={options}
          project={project}
          onClose={() => setEditing(false)}
          onSave={async (config: ResearchConfig, target) => {
            if (!window.piApp) throw new Error("桌面连接不可用。");
            const next = await window.piApp.researchGroupAction({
              kind: "configure",
              config,
              ...(target ? { target } : {}),
            });
            if (next.lastError) throw new Error(next.lastError);
          }}
        />
      ) : null}
      {error || state?.error || project?.error ? (
        <p className="research-group-error" role="alert">
          {error || state?.error || project?.error}
        </p>
      ) : null}
      {!project ? (
        <p className="research-group-intro">
          连接知识库并选择入口与本轮目标后，在下方填写想法、已有材料或指定任务。导师、研究者
          A、研究者
          B、资料员各有独立会话；按任务需要交接和复核。没有数据可以先完成方案，实际分析须等待真实材料。
        </p>
      ) : (
        <>
          {project.workflowVersion === "fusion-v2" ? (
            <p className="research-group-source">
              方法 {project.methodVersion} · {RESEARCH_ENTRY_LABELS[project.entry ?? "idea"]} ·
              本轮：{RESEARCH_GOAL_LABELS[project.goal ?? "design"]} ·{" "}
              {project.path ? RESEARCH_PATH_LABELS[project.path] : "路径待确定"}
            </p>
          ) : (
            <p className="research-group-source">旧研究流程 · 原阶段配置与历史保留</p>
          )}
          {project.fusion ? (
            <ResearchTaskControls
              graph={project.fusion}
              busy={busy}
              onAnswer={(input) => act({ kind: "answer-decision", target, input })}
              onReuse={(input) => act({ kind: "reuse-decision", target, input })}
              onRetry={(input) => act({ kind: "retry-task", target, input })}
              onResolve={(input) => act({ kind: "resolve-attempt", target, input })}
            />
          ) : null}
          {project.fusion ? (
            <details className="research-group-records">
              <summary>
                任务进度与等待条件 ·{" "}
                {
                  project.fusion.tasks.filter((task) =>
                    ["waiting-dependency", "waiting-user", "failed"].includes(task.state),
                  ).length
                }{" "}
                项待处理
              </summary>
              {project.fusion.tasks.map((task) => (
                <div key={task.id}>
                  <strong>
                    {researchStages(project).find((stage) => stage.id === task.stage)?.title ??
                      task.stage}{" "}
                    ·{" "}
                    {RESEARCH_ROLES.find((role) => role === task.role)
                      ? RESEARCH_ROLE_LABELS[RESEARCH_ROLES.find((role) => role === task.role)!]
                      : task.role}
                  </strong>{" "}
                  ·{" "}
                  {
                    {
                      pending: "待开始",
                      running: "执行中",
                      "waiting-dependency": "等待材料或前置成果",
                      "waiting-user": "等你的决定",
                      paused: "已暂停",
                      failed: "服务失败",
                      completed: "已执行完",
                      cancelled: "已取消",
                    }[task.state]
                  }
                  <p>
                    {task.blockers.map((blocker) => blocker.reason).join("；") || task.error || ""}
                  </p>
                  {task.currentArtifactId ? (
                    <p>
                      成果审阅：
                      {
                        {
                          draft: "草稿",
                          "pending-review": "待审阅",
                          "revision-required": "需修订",
                          accepted: "已接受",
                          "needs-review": "需重审",
                          superseded: "历史版本",
                        }[
                          project.fusion!.artifacts.find((a) => a.id === task.currentArtifactId)
                            ?.reviewState ?? "draft"
                        ]
                      }
                    </p>
                  ) : null}
                </div>
              ))}
            </details>
          ) : null}
          {project.importedMaterials?.length ? (
            <details className="research-group-records" open>
              <summary>导入材料 · {project.importedMaterials.length} 项</summary>
              {project.importedMaterials.map((m) => (
                <ResearchMaterialItem
                  key={m.id}
                  material={m}
                  project={project}
                  busy={busy}
                  adopted={
                    !!project.evidence?.sources.some((source) => source.materialImportId === m.id)
                  }
                  onAdopt={(declaration, expectedImpactToken) =>
                    run({
                      kind: "adopt-material",
                      target,
                      materialId: m.id,
                      declaration,
                      expectedImpactToken,
                    })
                  }
                  onRecover={(recovery) =>
                    run({ kind: "recover-material", target, materialId: m.id, recovery })
                  }
                  onOpen={
                    input.onOpenDeliverable
                      ? (path) =>
                          void input.onOpenDeliverable!(path).catch((e) => setError(String(e)))
                      : undefined
                  }
                />
              ))}
            </details>
          ) : null}
          {project.entryInventory ? (
            <details
              open={!project.entryInventory.canStart}
              className="research-material-item"
              data-testid="research-entry-inventory"
            >
              <summary>
                材料清点 · {project.entryInventory.canStart ? "可按范围继续" : "入口条件待补齐"}
              </summary>
              <p>
                实际检查时间：{project.entryInventory.checkedAt}。后续从{" "}
                {
                  researchStages(project).find(
                    (stage) => stage.id === project.entryInventory!.firstMissingStage,
                  )?.title
                }{" "}
                接续。
              </p>
              {(
                [
                  ["可复用", project.entryInventory.reusable],
                  ["待核查", project.entryInventory.pending],
                  ["缺失条件", project.entryInventory.missing],
                  ["范围与限制", project.entryInventory.limitations],
                ] as const
              ).map(([title, items]) => (
                <div key={title}>
                  <strong>{title}</strong>
                  <ul>
                    {items.length ? items.map((item, i) => <li key={i}>{item}</li>) : <li>无</li>}
                  </ul>
                </div>
              ))}
            </details>
          ) : null}
          <ResearchMaterialChangeControl
            project={project}
            busy={busy}
            onPreview={async (request) => {
              if (!window.piApp) throw new Error("桌面连接不可用。");
              return window.piApp.previewResearchMaterialChange({
                kind: "preview-material-change",
                target,
                input: request,
              });
            }}
            onApply={(commit) => act({ kind: "apply-material-change", target, input: commit })}
          />
          <ol className="research-group-stages" aria-label="研究阶段进度">
            {researchStages({ stages: project.stages, workflowVersion: project.workflowVersion })
              .filter(
                (_, i) =>
                  project.workflowVersion === "fusion-v2" || project.scope === "paper" || i < 2,
              )
              .map((stage) => (
                <li
                  key={stage.id}
                  aria-current={stage.id === project.currentStage ? "step" : undefined}
                >
                  {stage.title}
                  {stage.id === project.currentStage ? " · 当前" : ""}
                </li>
              ))}
          </ol>
          {project.supersededExports?.length ? (
            <details className="research-group-records">
              <summary>历史交付 · 当前研究已需重审</summary>
              {project.supersededExports.map((item) => (
                <div key={item.files.markdown}>
                  <p>
                    {item.reason}（{new Date(item.at).toLocaleString()}）
                  </p>
                  {input.onOpenDeliverable ? (
                    <button
                      type="button"
                      onClick={() =>
                        void input.onOpenDeliverable!(item.files.html).catch((e) =>
                          setError(String(e)),
                        )
                      }
                    >
                      打开旧版接受稿
                    </button>
                  ) : null}
                </div>
              ))}
            </details>
          ) : null}
          {artifacts.some(
            (a) => a.role === "lead" && ["stage-draft", "stage-revision"].includes(a.kind),
          ) ? (
            <div className="research-group-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const manuscript = artifacts
                    .filter(
                      (a) =>
                        a.role === "lead" && ["stage-draft", "stage-revision"].includes(a.kind),
                    )
                    .at(-1)!;
                  run({ kind: "export-review", target, input: { manuscriptId: manuscript.id } });
                }}
              >
                导出当前审阅稿（待核验）
              </button>
            </div>
          ) : null}
          {project.reviewPapers?.length && input.onOpenDeliverable ? (
            <details>
              <summary>审阅稿交付（不代表接受）</summary>
              {project.reviewPapers.map((paper) => (
                <div key={paper.files.provenance}>
                  输入版本 {paper.revision} · 稿件 {paper.manuscriptId}
                  {Object.entries(paper.files).map(([format, file]) => (
                    <button
                      key={format}
                      type="button"
                      onClick={() =>
                        void input.onOpenDeliverable!(file).catch((e) => setError(String(e)))
                      }
                    >
                      {format}
                    </button>
                  ))}
                </div>
              ))}
            </details>
          ) : null}
          {project.finalPaper && input.onOpenDeliverable ? (
            <div className="research-group-actions">
              {Object.entries({
                ...(project.finalPaper.docx ? { docx: "打开可编辑 Word" } : {}),
                markdown: "打开论文终稿",
                html: "打开带目录论文",
                provenance: "查看研究溯源",
              }).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    void input.onOpenDeliverable!(
                      project.finalPaper![key as keyof typeof project.finalPaper]!,
                    ).catch((e) => setError(String(e)))
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          {state ? <ResearchUsagePanel state={state} project={project} /> : null}
          <ResearchArchiveControl
            project={project}
            busy={busy}
            run={run}
            open={input.onOpenDeliverable}
          />
          <p className="research-group-objective">{project.objective}</p>
          {needsNewInput ? (
            project.scope === "paper" &&
            !["question", "review"].includes(project.currentStage ?? "question") ? (
              <div className="research-group-reconsider">
                <p>
                  导师已暂缓本阶段。补充条件或说明再审理由后，可以在当前阶段继续修订与复核；原裁定、计算和成果会保留。更换问题或分析方法时，请在导师会话提交新输入版本。
                </p>
                <label>
                  补充条件与再审理由
                  <textarea
                    aria-label="补充条件与再审理由"
                    value={conditions}
                    onChange={(e) => setConditions(e.target.value)}
                    maxLength={6000}
                    rows={4}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || conditions.trim().length < 20}
                  onClick={() => run({ kind: "reconsider", target, conditions })}
                >
                  补充条件并重新审议本阶段
                </button>
              </div>
            ) : (
              <p>
                导师已完成本轮审阅并暂缓推进。请在导师会话补充条件后提交，新一轮会保留原问题、成员及已有成果。
              </p>
            )
          ) : null}
          <div className="research-group-members">
            {project.members.map((m) => (
              <button
                type="button"
                key={m.role}
                onClick={() => onSelectThread(m.ref)}
                aria-label={`打开${RESEARCH_ROLE_LABELS[m.role]}会话`}
                data-running={m.status === "running"}
              >
                <span>
                  <i />
                  {RESEARCH_ROLE_LABELS[m.role]}
                </span>
                {m.stage ? (
                  <small>{project.stages?.find((s) => s.id === m.stage)?.title}</small>
                ) : null}
                <small>
                  {m.status === "running"
                    ? "正在工作"
                    : m.status === "failed"
                      ? "运行出错"
                      : "等待交接 / 已提交"}
                </small>
                <small>
                  {m.model ? `${m.model.provider} / ${m.model.modelId}` : "会话默认模型"}
                </small>
              </button>
            ))}
          </div>
          <p className="research-group-source">
            输入版本 {project.revision} · 课程库 {project.knowledge.version} ·{" "}
            {project.knowledge.count} 块 · 索引 {project.knowledge.sha256.slice(0, 12)}
            <br />
            课程方法整理与研究证据分开；原文读取、实算与审阅以本课题的记录为准。
          </p>
          {project.evidence ? (
            <details className="research-group-records">
              <summary>
                研究原文与数据 · {project.evidence.sources.length} 个来源 ·{" "}
                {project.evidence.datasets.length} 个数据集
              </summary>
              {project.evidence.sources.map((source) => (
                <p key={source.id} className="research-group-source">
                  <b>{source.title}</b>
                  <br />
                  {source.authors}（{source.year}） · {source.id}
                  <br />
                  {/^https?:\/\//.test(source.url) ? (
                    <a href={source.url} target="_blank" rel="noreferrer">
                      原始出处
                    </a>
                  ) : (
                    source.url
                  )}
                  {" · "}
                  {source.access === "retrieved-text" ? "已取得网页文本" : "已提供原文文本"} · 摘要{" "}
                  {source.sha256.slice(0, 12)}
                  <br />
                  已读取：
                  {[
                    ...new Set(
                      project.events
                        .filter(
                          (e) =>
                            e.type === "source-read" &&
                            e.revision === project.revision &&
                            e.sourceId === source.id,
                        )
                        .map((e) => RESEARCH_ROLE_LABELS[e.role!]),
                    ),
                  ].join("、") || "尚无读取记录"}
                </p>
              ))}
              {project.evidence.datasets.map((data) => (
                <p key={data.id} className="research-group-source">
                  <b>{data.id}</b> ·{" "}
                  {data.dataKind === "synthetic" ? "合成演练数据" : "观察或实测数据"} · 使用声明：
                  {data.permission === "public" ? "公开" : "用户授权"}
                  <br />
                  {data.description}
                  <br />
                  来源 {data.sourceId} · 数据摘要 {data.sha256.slice(0, 12)}
                </p>
              ))}
            </details>
          ) : null}
          <ResearchContentChecks records={project.contentChecks} />
          {state ? (
            <ResearchM3Panel
              key={`${project.id}:${project.revision}`}
              project={project}
              state={state}
              busy={busy}
              options={options}
              act={act}
              onSelect={onSelectThread}
            />
          ) : null}
          <ResearchLanguagePanel project={project} busy={busy} act={act} />
          <ResearchSourcePagesPanel project={project} />
          <ResearchSynthesisPanel project={project} />
          <ResearchClaimsPanel ledger={project.claims} />
          <ResearchMethodPackagesPanel project={project} />
          <ResearchLiteraturePanel project={project} />
          <ResearchAnalysisRegistryPanel
            registry={project.analysisRegistry}
            datasets={project.evidence?.datasets ?? []}
            project={project}
          />
          {project.analyses?.some((a) => a.revision === project.revision) ? (
            <details className="research-group-records">
              <summary>
                实际分析与复算 ·{" "}
                {project.analyses.filter((a) => a.revision === project.revision).length} 次运行
              </summary>
              {project.analyses
                .filter((a) => a.revision === project.revision)
                .map((run) => (
                  <div key={run.id} className="research-group-source">
                    <p>
                      <b>
                        {RESEARCH_ROLE_LABELS[run.role]} · {run.spec.method}
                      </b>{" "}
                      · {run.spec.datasetId}
                      <br />
                      变量：{run.spec.columns.join("、")}
                      {run.spec.outcome ? ` → ${run.spec.outcome}` : ""}
                      <br />
                      完整案例 {String(run.result.completeRows)} / {String(run.result.totalRows)} ·
                      结果摘要 {run.sha256.slice(0, 12)}
                    </p>
                    {input.onOpenDeliverable ? (
                      <button
                        type="button"
                        onClick={() =>
                          void input.onOpenDeliverable!(run.file).catch((e) => setError(String(e)))
                        }
                      >
                        查看实际结果
                      </button>
                    ) : null}
                  </div>
                ))}
            </details>
          ) : null}
          <details
            className="research-group-records"
            open={project.status !== "running" && artifacts.length > 0}
          >
            <summary>成果与审阅链 · {artifacts.length} 份</summary>
            {artifacts.map((a) => (
              <details key={a.id} className="research-group-artifact">
                <summary>
                  {RESEARCH_ROLE_LABELS[a.role]} · {kinds[a.kind]}
                  {a.round ? ` · 第 ${a.round} 轮` : ""}
                  {a.verdict
                    ? ` · ${{ accept: "通过", revise: "需修订", hold: "暂缓" }[a.verdict]}`
                    : ""}
                  <small>
                    {project.events
                      .filter((e) => e.type === "read" && e.artifactId === a.id)
                      .map((e) => RESEARCH_ROLE_LABELS[e.role!])
                      .filter((v, i, all) => all.indexOf(v) === i)
                      .join("、") || "尚无人读取"}
                  </small>
                </summary>
                {a.stage || a.model ? (
                  <p className="research-group-source">
                    {project.stages?.find((stage) => stage.id === a.stage)?.title ?? ""}
                    {a.model
                      ? ` · ${a.model.provider}/${a.model.modelId} · ${a.model.thinkingLevel ?? "会话默认"}`
                      : ""}
                  </p>
                ) : null}
                <MessageMarkdown text={a.content} />
                <p className="research-group-source">
                  {a.id} · {new Date(a.createdAt).toLocaleString()}
                  <br />
                  引用：
                  {a.refs
                    .map((id) => kinds[artifacts.find((x) => x.id === id)?.kind ?? ""] ?? id)
                    .join("、") || "独立判断 / 课程方法"}
                </p>
                {input.onOpenDeliverable ? (
                  <button
                    type="button"
                    onClick={() =>
                      void input.onOpenDeliverable!(
                        `${project.workspacePath}/.lancer/research-groups/${project.id}/${a.id}.md`,
                      ).catch((e) => setError(String(e)))
                    }
                  >
                    打开成果文档
                  </button>
                ) : null}
              </details>
            ))}
          </details>
          <details className="research-group-records" open>
            <summary>协作记录 · {project.events.length} 条</summary>
            <ol>
              {(allEvents ? project.events : project.events.slice(-6)).map((e) => (
                <li key={e.id}>
                  <time>{new Date(e.at).toLocaleTimeString()}</time>
                  <span>
                    {e.role ? RESEARCH_ROLE_LABELS[e.role] : "课题组"}
                    {e.to ? ` → ${RESEARCH_ROLE_LABELS[e.to]}` : ""}：{e.detail}
                    {e.type === "read" && e.producerRunning ? "（生产者仍在运行）" : ""}
                  </span>
                </li>
              ))}
            </ol>
            {project.events.length > 6 ? (
              <button type="button" onClick={() => setAllEvents(!allEvents)}>
                {allEvents ? "只看最近记录" : "展开完整记录"}
              </button>
            ) : null}
          </details>
          <details className="research-group-records">
            <summary>知识包与来源 · {project.packets.length} 次检索</summary>
            {project.packets.map((k) => (
              <details key={k.id}>
                <summary>
                  {RESEARCH_ROLE_LABELS[k.role]} · {k.query}
                </summary>
                <pre>{JSON.stringify({ ids: k.ids, records: k.records }, null, 2)}</pre>
              </details>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
