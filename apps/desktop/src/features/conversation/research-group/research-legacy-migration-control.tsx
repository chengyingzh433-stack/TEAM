import { useRef, useState } from "react";
import {
  RESEARCH_ROLE_LABELS,
  type ResearchConfig,
  type ResearchProject,
} from "../../../../contracts/research-group";
import {
  RESEARCH_ENTRY_LABELS,
  RESEARCH_GOAL_LABELS,
  RESEARCH_PATH_LABELS,
  type ResearchMethodConfig,
  RESEARCH_METHOD_VERSION,
} from "../../../../contracts/research-method";
import type {
  ResearchLegacyMigrationCommit,
  ResearchLegacyMigrationIntent,
  ResearchLegacyMigrationPreview,
} from "../../../../contracts/research-legacy-migration";

type ResearchEntry = NonNullable<ResearchMethodConfig["entry"]>;
type ResearchGoal = NonNullable<ResearchMethodConfig["goal"]>;
type ResearchPath = NonNullable<ResearchMethodConfig["path"]>;

export function ResearchLegacyMigrationControl({
  project,
  config,
  busy,
  onPreview,
  onApply,
}: {
  project: ResearchProject;
  config: ResearchConfig;
  busy: boolean;
  onPreview: (input: ResearchLegacyMigrationIntent) => Promise<ResearchLegacyMigrationPreview>;
  onApply: (input: ResearchLegacyMigrationCommit) => Promise<void>;
}) {
  const [objective, setObjective] = useState("");
  const [entry, setEntry] = useState<ResearchEntry>("materials");
  const [goal, setGoal] = useState<ResearchGoal>("design");
  const [path, setPath] = useState<ResearchPath>("quantitative");
  const [preview, setPreview] = useState<ResearchLegacyMigrationPreview>();
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const migrationId = useRef(crypto.randomUUID());
  const intent: ResearchLegacyMigrationIntent = {
    objective,
    method: {
      workflowVersion: "fusion-v2",
      methodVersion: RESEARCH_METHOD_VERSION,
      entry,
      goal,
      path,
    },
    defaultModels: config.models,
  };
  const invalidate = () => {
    setPreview(undefined);
    setError("");
    migrationId.current = crypto.randomUUID();
  };
  const available =
    project.status !== "running" && !project.members.some((member) => member.status === "running");
  return (
    <details className="research-material-controls" data-testid="research-legacy-migration">
      <summary>以新流程建立修改任务</summary>
      <p>
        先保存旧项目恢复快照，再建立独立的九阶段任务。旧会话、正文、模型与裁定保留；旧成果需按本次目标核查。
      </p>
      {!available ? <p>请先暂停旧项目并等待成员停止。</p> : null}
      <label>
        新修改任务目标
        <textarea
          aria-label="新修改任务目标"
          value={objective}
          onChange={(event) => {
            setObjective(event.target.value);
            invalidate();
          }}
        />
      </label>
      <label>
        接续入口
        <select
          aria-label="接续入口"
          value={entry}
          onChange={(event) => {
            setEntry(event.target.value as ResearchEntry);
            invalidate();
          }}
        >
          {Object.entries(RESEARCH_ENTRY_LABELS)
            .filter(([id]) => id !== "task")
            .map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
        </select>
      </label>
      <label>
        接续目标
        <select
          aria-label="接续目标"
          value={goal}
          onChange={(event) => {
            setGoal(event.target.value as ResearchGoal);
            invalidate();
          }}
        >
          {Object.entries(RESEARCH_GOAL_LABELS)
            .filter(([id]) => id !== "task")
            .map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
        </select>
      </label>
      <label>
        接续研究路径
        <select
          aria-label="接续研究路径"
          value={path}
          onChange={(event) => {
            setPath(event.target.value as ResearchPath);
            invalidate();
          }}
        >
          {Object.entries(RESEARCH_PATH_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={busy || checking || !available || !objective.trim()}
        onClick={() => {
          setChecking(true);
          setError("");
          setPreview(undefined);
          void onPreview(intent)
            .then(setPreview)
            .catch((e: unknown) => setError(String(e)))
            .finally(() => setChecking(false));
        }}
      >
        查看阶段映射与待核查项
      </button>
      {preview ? (
        <div data-testid="research-legacy-migration-preview">
          <p>
            源输入版本 {preview.sourceRevision} · 映射 {preview.mappingVersion}
          </p>
          <ul>
            {preview.mappings.map((mapping, index) => (
              <li key={index}>
                {mapping.sourceStageId ?? "新增"} →{" "}
                {mapping.targetStageIds.join("、") || "历史保留"}：{mapping.note}
              </li>
            ))}
          </ul>
          <ul>
            {preview.pending.map((item) => (
              <li key={item.id}>{item.message}</li>
            ))}
          </ul>
          <details>
            <summary>查看九阶段配置（新任务建立后可编辑）</summary>
            {preview.stages.map((stage) => (
              <div key={stage.id}>
                <strong>{stage.title}</strong>
                <p>{stage.goal}</p>
                <p>{stage.deliverables}</p>
                <ul>
                  {Object.entries(stage.models).map(([role, model]) => (
                    <li key={role}>
                      {RESEARCH_ROLE_LABELS[role as keyof typeof RESEARCH_ROLE_LABELS]}：
                      {model
                        ? `${model.provider}/${model.modelId} · ${model.thinkingLevel ?? "会话默认"}`
                        : "会话默认"}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </details>
          <p>
            新任务先保持暂停。请清点并导入拟沿用材料，检查配置后再开始；本操作不会启动模型请求。
          </p>
          <button
            type="button"
            disabled={busy || checking || !available}
            onClick={() => {
              setChecking(true);
              setError("");
              void onApply({
                migrationId: migrationId.current,
                expectedPreviewToken: preview.token,
                intent,
              })
                .catch((e: unknown) => setError(String(e)))
                .finally(() => setChecking(false));
            }}
          >
            保存恢复快照并建立新任务
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
