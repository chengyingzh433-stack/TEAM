import { useRef, useState } from "react";
import {
  RESEARCH_ROLE_LABELS,
  researchStages,
  type ResearchProject,
  type ResearchRole,
} from "../../../../contracts/research-group";
import type { MaterialAdoptionDeclaration } from "../../../../contracts/research-materials";
import { decodeResearchMaterialChangeRequest } from "../../../../contracts/research-material-impact";
import type {
  ResearchMaterialChangeRequest,
  ResearchMaterialChangeCommit,
  ResearchMaterialImpact,
} from "../../../../contracts/research-material-impact";

export interface ResearchMaterialChangeControlProps {
  project: ResearchProject;
  busy: boolean;
  onPreview: (request: ResearchMaterialChangeRequest) => Promise<ResearchMaterialImpact>;
  onApply: (commit: ResearchMaterialChangeCommit) => Promise<void>;
}

/** Form state belongs to one project; switching projects cannot carry a previous approval. */
export function ResearchMaterialChangeControl(props: ResearchMaterialChangeControlProps) {
  if (!props.project.fusion || !props.project.evidence?.sources.length) return null;
  return <MaterialChangeForm key={props.project.id} {...props} />;
}

function MaterialChangeForm({
  project,
  busy,
  onPreview,
  onApply,
}: ResearchMaterialChangeControlProps) {
  const [sourceId, setSourceId] = useState("");
  const [kind, setKind] = useState<"replace" | "withdraw">("replace");
  const [candidateMaterialId, setCandidateMaterialId] = useState("");
  const [category, setCategory] = useState<MaterialAdoptionDeclaration["category"]>("paper");
  const [sourceDescription, setSourceDescription] = useState("");
  const [tableName, setTableName] = useState("");
  const [dataKind, setDataKind] = useState<"" | "observed" | "synthetic">("");
  const [permission, setPermission] = useState<"" | "public" | "user-authorized">("");
  const [formulaValueBasis, setFormulaValueBasis] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{
    impact: ResearchMaterialImpact;
    commit: ResearchMaterialChangeCommit;
  }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const lock = useRef(false);
  const changeId = useRef(crypto.randomUUID());
  const disabled = busy || pending;
  const source = project.evidence?.sources.find((item) => item.id === sourceId);
  const candidate = project.importedMaterials?.find((item) => item.id === candidateMaterialId);
  const dataSource = project.evidence?.datasets.some((item) => item.sourceId === sourceId) ?? false;
  const candidates = (project.importedMaterials ?? []).filter(
    (item) =>
      ["ready", "partial"].includes(item.status) &&
      item.id !== source?.materialImportId &&
      (!dataSource || item.tables.length > 0),
  );
  const changed = () => {
    setPreview(undefined);
    setError("");
    setResult("");
    changeId.current = crypto.randomUUID();
  };
  const execute = (action: () => Promise<void>) => {
    if (disabled || lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    void action().then(
      () => {
        lock.current = false;
        setPending(false);
      },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "操作未完成，请检查后重试。");
        lock.current = false;
        setPending(false);
      },
    );
  };
  const taskLabel = (id: string) => {
    const task = project.fusion?.tasks.find((item) => item.id === id);
    if (!task) return "历史任务（详细身份见项目记录）";
    const stage =
      researchStages(project).find((item) => item.id === task.stage)?.title ?? task.stage;
    const role = RESEARCH_ROLE_LABELS[task.role as ResearchRole] ?? task.role;
    return `${stage} · ${role} · 输入版本 ${task.inputVersion}`;
  };
  const artifactLabel = (id: string) => {
    const artifact = project.fusion?.artifacts.find((item) => item.id === id);
    return artifact
      ? `${taskLabel(artifact.taskId)} · 成果版本 ${artifact.taskVersion}`
      : "历史成果（详细身份见项目记录）";
  };
  const canPreview =
    !!source &&
    !!reason.trim() &&
    (kind === "withdraw" ||
      (!!candidate &&
        !!sourceDescription.trim() &&
        (category !== "data" || (!!dataKind && !!permission && !!tableName))));
  return (
    <details className="research-material-item" data-testid="research-material-change-control">
      <summary>替换或撤回本轮采用材料</summary>
      <p>旧原件、旧稿和使用记录保留。先查看当前任务与成果的具体影响，再应用这次变更。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          execute(async () => {
            setPreview(undefined);
            const request = decodeResearchMaterialChangeRequest(
              kind === "withdraw"
                ? { kind, sourceId, reason }
                : {
                    kind,
                    sourceId,
                    candidateMaterialId,
                    reason,
                    declaration: {
                      category,
                      sourceDescription,
                      ...(category === "data"
                        ? {
                            tableName,
                            dataKind,
                            permission,
                            ...(formulaValueBasis.trim() ? { formulaValueBasis } : {}),
                          }
                        : {}),
                    },
                  },
            );
            const impact = await onPreview(request);
            setPreview({
              impact,
              commit: { changeId: changeId.current, expectedImpactToken: impact.token, request },
            });
            setResult("");
          });
        }}
      >
        <label>
          当前采用来源
          <select
            aria-label="当前采用来源"
            value={sourceId}
            disabled={disabled}
            required
            onChange={(event) => {
              changed();
              const id = event.target.value;
              const selected = project.evidence?.sources.find((item) => item.id === id);
              setSourceId(id);
              setCandidateMaterialId("");
              setTableName("");
              setSourceDescription("");
              setDataKind("");
              setPermission("");
              setFormulaValueBasis("");
              const hasData = project.evidence?.datasets.some((item) => item.sourceId === id);
              setCategory(
                hasData
                  ? "data"
                  : selected?.kind === "dataset"
                    ? "method"
                    : (selected?.kind ?? "paper"),
              );
            }}
          >
            <option value="">请选择要变更的已采用来源</option>
            {project.evidence?.sources.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.sha256.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label>
          变更方式
          <select
            aria-label="变更方式"
            value={kind}
            disabled={disabled}
            onChange={(event) => {
              changed();
              setKind(event.target.value as "replace" | "withdraw");
            }}
          >
            <option value="replace">替换本轮采用版本</option>
            <option value="withdraw">撤回本轮使用</option>
          </select>
        </label>
        {kind === "replace" && (
          <>
            <label>
              替换候选
              <select
                aria-label="替换候选"
                value={candidateMaterialId}
                disabled={disabled}
                required
                onChange={(event) => {
                  changed();
                  setCandidateMaterialId(event.target.value);
                  setTableName("");
                  setFormulaValueBasis("");
                }}
              >
                <option value="">请选择已解析的候选版本</option>
                {candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.sha256.slice(0, 8)} · {item.importedAt}
                  </option>
                ))}
              </select>
            </label>
            {!candidates.length && (
              <p>请先导入或恢复一个可用候选版本；候选不会自动替换当前来源。</p>
            )}
            {candidate?.warnings.length ? (
              <p>候选解析限制：{candidate.warnings.join("；")}</p>
            ) : null}
            <label>
              替换材料用途
              <select
                aria-label="替换材料用途"
                value={category}
                disabled={disabled || dataSource}
                onChange={(event) => {
                  changed();
                  setCategory(event.target.value as MaterialAdoptionDeclaration["category"]);
                }}
              >
                {dataSource ? (
                  <option value="data">实际数据</option>
                ) : (
                  <>
                    <option value="paper">研究文献</option>
                    <option value="method">方法资料</option>
                    <option value="manuscript">待审阅稿件</option>
                    <option value="design">已有研究方案</option>
                  </>
                )}
              </select>
            </label>
            <label>
              替换材料来源及提供说明
              <textarea
                aria-label="替换材料来源及提供说明"
                value={sourceDescription}
                maxLength={8000}
                required
                disabled={disabled}
                onChange={(event) => {
                  changed();
                  setSourceDescription(event.target.value);
                }}
              />
            </label>
            {category === "data" && (
              <>
                <label>
                  替换数据工作表
                  <select
                    aria-label="替换数据工作表"
                    value={tableName}
                    disabled={disabled}
                    required
                    onChange={(event) => {
                      changed();
                      setTableName(event.target.value);
                    }}
                  >
                    <option value="">请选择实际使用的工作表</option>
                    {candidate?.tables.map((table) => (
                      <option key={table.name} value={table.name}>
                        {table.name} · {table.headers.join("、")}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  替换数据性质
                  <select
                    aria-label="替换数据性质"
                    value={dataKind}
                    disabled={disabled}
                    required
                    onChange={(event) => {
                      changed();
                      setDataKind(event.target.value as typeof dataKind);
                    }}
                  >
                    <option value="">请选择实际数据性质</option>
                    <option value="observed">真实观察材料</option>
                    <option value="synthetic">合成演练材料</option>
                  </select>
                </label>
                <label>
                  替换数据使用许可
                  <select
                    aria-label="替换数据使用许可"
                    value={permission}
                    disabled={disabled}
                    required
                    onChange={(event) => {
                      changed();
                      setPermission(event.target.value as typeof permission);
                    }}
                  >
                    <option value="">请选择已有许可</option>
                    <option value="public">公开允许研究使用</option>
                    <option value="user-authorized">用户已取得使用授权</option>
                  </select>
                </label>
                <label>
                  公式缓存取值核实依据（含公式时必填）
                  <textarea
                    aria-label="替换数据公式取值依据"
                    value={formulaValueBasis}
                    maxLength={8000}
                    disabled={disabled}
                    onChange={(event) => {
                      changed();
                      setFormulaValueBasis(event.target.value);
                    }}
                  />
                </label>
                <p>这些是用户的材料与用途声明，不代替独立真实性核验或伦理审批。</p>
              </>
            )}
          </>
        )}
        <label>
          变更原因
          <textarea
            aria-label="材料变更原因"
            value={reason}
            maxLength={6000}
            required
            disabled={disabled}
            onChange={(event) => {
              changed();
              setReason(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={disabled || !canPreview}>
          查看此次变更的具体影响
        </button>
      </form>
      {preview && (
        <div data-testid="research-material-impact-preview">
          <p>
            {preview.commit.request.kind === "replace" ? "替换" : "撤回"}：
            {preview.impact.sourceTitle}
          </p>
          {(
            [
              ["直接影响的任务", preview.impact.directTaskIds, taskLabel],
              [
                "后续受影响任务",
                preview.impact.affectedTaskIds.filter(
                  (id) => !preview.impact.directTaskIds.includes(id),
                ),
                taskLabel,
              ],
              ["保留的任务", preview.impact.reusableTaskIds, taskLabel],
              ["需重审的成果与历史版本", preview.impact.affectedArtifactIds, artifactLabel],
            ] as const
          ).map(([title, ids, label]) => (
            <details key={title} open={ids.length > 0 && ids.length <= 6}>
              <summary>
                {title} · {ids.length} 项
              </summary>
              {ids.length ? (
                <ul>
                  {ids.map((id) => (
                    <li key={id}>{label(id)}</li>
                  ))}
                </ul>
              ) : (
                <p>无</p>
              )}
            </details>
          ))}
          {preview.impact.requiresDesignReview && (
            <p>数据变化需要重新核对方案与实际字段；原分析计划保留，相关分析和下游成果进入重审。</p>
          )}
          <p>
            {preview.impact.supersedesExport
              ? "现有交付稿将保留为历史，不再代表当前有效版本。"
              : "本次预览未发现需要作废的当前导出稿。"}
          </p>
          <p>影响按预览时的输入与成果计算；运行中出现新成果后，提交可能要求重新查看影响。</p>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              execute(async () => {
                await onApply(preview.commit);
                setPreview(undefined);
                setCandidateMaterialId("");
                setTableName("");
                setReason("");
                changeId.current = crypto.randomUUID();
                setResult("材料变更已应用；旧原件与历史记录已保留。");
              })
            }
          >
            {preview.commit.request.kind === "replace"
              ? "应用以上影响并替换版本"
              : "应用以上影响并撤回使用"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="research-group-error">
          {error} 输入已保留；如影响已变化，请重新预览。
        </p>
      )}
      {result && <p role="status">{result}</p>}
    </details>
  );
}
