import { useState } from "react";
import {
  RESEARCH_ROLE_LABELS,
  researchStages,
  type ResearchProject,
  type ResearchRole,
} from "../../../../contracts/research-group";
import { projectResearchMaterialAdoptionImpact } from "../../../../contracts/research-material-adoption-impact";
import type {
  ImportedResearchMaterial,
  MaterialAdoptionDeclaration,
  MaterialRecoveryRequest,
  MaterialParseOptions,
} from "../../../../contracts/research-materials";

export function ResearchMaterialItem({
  material,
  project,
  adopted,
  busy,
  onAdopt,
  onOpen,
  onRecover,
}: {
  material: ImportedResearchMaterial;
  project?: ResearchProject;
  adopted: boolean;
  busy: boolean;
  onAdopt: (declaration: MaterialAdoptionDeclaration, expectedImpactToken?: string) => void;
  onOpen?: (path: string) => void;
  onRecover?: (recovery: MaterialRecoveryRequest) => void;
}) {
  const [category, setCategory] = useState<MaterialAdoptionDeclaration["category"]>(
    /\.(?:csv|tsv|xlsx)$/i.test(material.name) ? "data" : "paper",
  );
  const [description, setDescription] = useState(material.metadata.providedBy ?? "");
  const [textScope, setTextScope] =
    useState<NonNullable<MaterialAdoptionDeclaration["textScope"]>>("partial-text");
  const [permission, setPermission] = useState<"" | "public" | "user-authorized">("");
  const [dataKind, setDataKind] = useState<"" | "observed" | "synthetic">("");
  const [tableName, setTableName] = useState(material.tables[0]?.name ?? "");
  const [formulaBasis, setFormulaBasis] = useState("");
  const [encoding, setEncoding] = useState<NonNullable<MaterialParseOptions["encoding"]>>(
    material.parseOptions?.encoding ?? "auto",
  );
  const [delimiter, setDelimiter] = useState<NonNullable<MaterialParseOptions["delimiter"]>>(
    material.parseOptions?.delimiter ?? (/\.tsv$/i.test(material.name) ? "\t" : ","),
  );
  const [headerRow, setHeaderRow] = useState(String(material.parseOptions?.headerRow ?? 1));
  const [retrySheet, setRetrySheet] = useState(material.parseOptions?.sheet ?? "");
  const [supplementLocator, setSupplementLocator] = useState(
    material.locations.find((location) => ["page", "paragraph", "line"].includes(location.kind))
      ?.locator ?? "page:1",
  );
  const [supplementText, setSupplementText] = useState("");
  const [supplementDescription, setSupplementDescription] = useState("");
  const textFormat = /\.(?:txt|md|markdown|json|csv|tsv)$/i.test(material.name);
  const tableFormat = /\.(?:csv|tsv|xlsx)$/i.test(material.name);
  const canSupplement =
    !tableFormat &&
    (material.locations.some((location) => ["page", "paragraph", "line"].includes(location.kind)) ||
      /\.(?:png|jpe?g|webp|gif|tiff?|bmp)$/i.test(material.name));
  const ready = !["failed", "needs-parsing"].includes(material.status);
  const impact = project ? projectResearchMaterialAdoptionImpact(project, category) : undefined;
  const taskLabel = (id: string) => {
    const task = project?.fusion?.tasks.find((item) => item.id === id);
    if (!task || !project) return "历史任务（身份详见项目记录）";
    const stage =
      researchStages(project).find((item) => item.id === task.stage)?.title ?? task.stage;
    return `${stage} · ${RESEARCH_ROLE_LABELS[task.role as ResearchRole] ?? task.role} · 输入版本 ${task.inputVersion}`;
  };
  return (
    <details className="research-material-item" data-material-id={material.id}>
      <summary>
        {material.name} ·{" "}
        {adopted
          ? "已采用"
          : material.status === "ready"
            ? "可读取，待采用"
            : material.status === "partial"
              ? "部分可用"
              : material.status === "needs-parsing"
                ? "待解析"
                : "解析失败"}
        {material.duplicate ? " · 重复原件" : ""}
      </summary>
      {/\.json$/i.test(material.name) ? (
        <p>检索记录原件可供文献任务导入并逐条筛选。题录或摘要记录本身不能充当已读论文全文。</p>
      ) : null}
      <p>{material.error ?? material.warnings.join("；")}</p>
      {onOpen ? (
        <button type="button" onClick={() => onOpen(material.original)}>
          打开保留原件
        </button>
      ) : null}
      <p>
        {material.locations.length} 处可定位内容；解析版本 {material.parserVersion}
      </p>
      {material.locations.length ? (
        <details>
          <summary>位置与正文预览（前 8 处）</summary>
          {material.locations.slice(0, 8).map((location) => (
            <div key={location.locator}>
              <strong>{location.page ? `物理第 ${location.page} 页` : location.locator}</strong>
              <p>
                {location.text.slice(0, 300)}
                {location.text.length > 300 ? "…（本处仅预览前 300 字）" : ""}
              </p>
            </div>
          ))}
        </details>
      ) : null}
      {material.tables.map((table) => (
        <details key={table.name}>
          <summary>
            {table.name}：{table.headers.join("、")}；{table.rows.length} 行，{table.errors.length}{" "}
            个行问题
          </summary>
          <table>
            <thead>
              <tr>
                {table.headers.map((header, i) => (
                  <th key={i}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(table.headerRow, table.headerRow + 8).map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {table.columns
              .map(
                (column) =>
                  `${column.name}：${{ number: "数值", text: "文本", mixed: "混合类型", empty: "空列" }[column.type]}，缺失 ${column.missing}`,
              )
              .join("；")}
          </p>
          {table.errors.map((error, i) => (
            <p key={i}>
              原行 {error.row}：{error.reason}
            </p>
          ))}
        </details>
      ))}
      {onRecover ? (
        <details>
          <summary>处理解析问题或更新文件</summary>
          <p>恢复生成新的候选版本，旧原件、解析和已采用证据保留。采用新版本前仍需查看影响。</p>
          {material.recovery ? (
            <p>
              本版本由
              {material.recovery.kind === "supplement"
                ? "补入定位文本"
                : material.recovery.kind === "replace"
                  ? "选择修正文件"
                  : "重新解析"}
              生成；前一解析版本保留。
            </p>
          ) : null}
          {textFormat ? (
            <label>
              文本编码
              <select
                aria-label={`${material.name} 解析编码`}
                value={encoding}
                onChange={(e) => setEncoding(e.target.value as typeof encoding)}
              >
                <option value="auto">按 BOM 判断，否则 UTF-8</option>
                <option value="utf-8">UTF-8</option>
                <option value="utf-16le">UTF-16 LE</option>
                <option value="utf-16be">UTF-16 BE</option>
                <option value="gb18030">GB18030 / GBK</option>
              </select>
              <small>编码由你选择，不代表系统已经核实文本含义。</small>
            </label>
          ) : null}
          {/\.(?:csv|tsv)$/i.test(material.name) ? (
            <label>
              字段分隔符
              <select
                aria-label={`${material.name} 解析分隔符`}
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value as typeof delimiter)}
              >
                <option value=",">逗号</option>
                <option value=";">分号</option>
                <option value={"\t"}>制表符</option>
              </select>
            </label>
          ) : null}
          {tableFormat ? (
            <label>
              表头原行
              <input
                aria-label={`${material.name} 表头原行`}
                type="number"
                min={1}
                max={100000}
                value={headerRow}
                onChange={(e) => setHeaderRow(e.target.value)}
              />
            </label>
          ) : null}
          {/\.xlsx$/i.test(material.name) ? (
            <label>
              工作表名称（留空读取全部）
              <input
                aria-label={`${material.name} 重新解析工作表`}
                value={retrySheet}
                onChange={(e) => setRetrySheet(e.target.value)}
              />
            </label>
          ) : null}
          <button
            type="button"
            disabled={
              busy ||
              (tableFormat &&
                (!Number.isSafeInteger(Number(headerRow)) ||
                  Number(headerRow) < 1 ||
                  Number(headerRow) > 100000))
            }
            onClick={() =>
              onRecover({
                kind: "reparse",
                ...(textFormat ? { encoding } : {}),
                ...(/\.(?:csv|tsv)$/i.test(material.name) ? { delimiter } : {}),
                ...(tableFormat ? { headerRow: Number(headerRow) } : {}),
                ...(/\.xlsx$/i.test(material.name) ? { sheet: retrySheet.trim() } : {}),
              })
            }
          >
            按所选设置重新解析
          </button>
          <button type="button" disabled={busy} onClick={() => onRecover({ kind: "replace" })}>
            选择修正后的文件
          </button>
          {canSupplement ? (
            <details>
              <summary>补入可定位的提取文本</summary>
              <p>
                填写实际原页、段落或行定位及提取方式。补入文本属于用户提供材料，不会被标为原图或公式已经核验。
              </p>
              <label>
                原文定位
                <input
                  aria-label={`${material.name} 补入文本定位`}
                  value={supplementLocator}
                  onChange={(e) => setSupplementLocator(e.target.value)}
                />
              </label>
              <label>
                提取文本
                <textarea
                  aria-label={`${material.name} 补入提取文本`}
                  value={supplementText}
                  onChange={(e) => setSupplementText(e.target.value)}
                />
              </label>
              <label>
                提取方式及未核验范围
                <textarea
                  aria-label={`${material.name} 提取说明`}
                  value={supplementDescription}
                  onChange={(e) => setSupplementDescription(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={
                  busy ||
                  !supplementLocator.trim() ||
                  !supplementText.trim() ||
                  !supplementDescription.trim()
                }
                onClick={() =>
                  onRecover({
                    kind: "supplement",
                    locator: supplementLocator.trim(),
                    text: supplementText,
                    description: supplementDescription.trim(),
                  })
                }
              >
                保存为新的定位文本版本
              </button>
            </details>
          ) : null}
        </details>
      ) : null}
      {!adopted && ready ? (
        <div>
          <label>
            材料用途
            <select
              aria-label={`${material.name} 材料用途`}
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as MaterialAdoptionDeclaration["category"])
              }
            >
              <option value="paper">研究文献</option>
              <option value="method">方法资料</option>
              <option value="manuscript">待审阅稿件</option>
              <option value="design">已有研究方案</option>
              <option value="data">实际数据</option>
            </select>
          </label>
          <label>
            来源及提供说明
            <textarea
              aria-label={`${material.name} 来源及提供说明`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="来自哪里、允许怎样使用；未知信息明确保留"
            />
          </label>
          {category === "data" ? (
            <>
              <label>
                使用工作表
                <select
                  aria-label={`${material.name} 工作表`}
                  value={tableName}
                  onChange={(e) => setTableName(e.target.value)}
                >
                  {material.tables.map((table) => (
                    <option key={table.name}>{table.name}</option>
                  ))}
                </select>
              </label>
              <label>
                材料性质
                <select
                  aria-label={`${material.name} 材料性质`}
                  value={dataKind}
                  onChange={(e) => setDataKind(e.target.value as typeof dataKind)}
                >
                  <option value="">请选择实际性质</option>
                  <option value="observed">真实观察数据</option>
                  <option value="synthetic">合成演练数据</option>
                </select>
              </label>
              <label>
                使用依据
                <select
                  aria-label={`${material.name} 使用依据`}
                  value={permission}
                  onChange={(e) => setPermission(e.target.value as typeof permission)}
                >
                  <option value="">尚未确认</option>
                  <option value="public">公开且允许本次研究使用</option>
                  <option value="user-authorized">我已取得本次使用授权</option>
                </select>
              </label>
              {material.locations.some((location) => location.formula) ? (
                <label>
                  公式取值核实依据
                  <textarea
                    aria-label={`${material.name} 公式取值核实依据`}
                    value={formulaBasis}
                    onChange={(e) => setFormulaBasis(e.target.value)}
                  />
                </label>
              ) : null}
              <p>
                采用后检查相关设计与分析条件。已接受的问题与无关文献保留；本操作记录你的材料声明，不等于伦理审批。
              </p>
            </>
          ) : (
            <>
              <label>
                提供文本范围
                <select
                  aria-label={`${material.name} 提供文本范围`}
                  value={textScope}
                  onChange={(event) => setTextScope(event.target.value as typeof textScope)}
                >
                  <option value="partial-text">部分文本或范围未确认</option>
                  <option value="metadata">仅题录</option>
                  <option value="abstract">仅摘要</option>
                  <option value="full-text" disabled={material.status !== "ready"}>
                    完整文字来源
                  </option>
                </select>
              </label>
              <p>此项记录提供材料的范围；实际已读区间、图表核对和主张支持关系分别记录。</p>
            </>
          )}
          {impact ? (
            <div data-testid="research-material-adoption-impact">
              <p>{impact.reason}</p>
              {(
                [
                  ["采用后需重审的任务", impact.affectedTaskIds],
                  ["保留的任务", impact.reusableTaskIds],
                ] as const
              ).map(([label, ids]) => (
                <details key={label} open={ids.length > 0 && ids.length <= 6}>
                  <summary>
                    {label} · {ids.length} 项
                  </summary>
                  {ids.length ? (
                    <ul>
                      {ids.map((id) => (
                        <li key={id}>{taskLabel(id)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>无</p>
                  )}
                </details>
              ))}
              {(
                [
                  ["需重审的当前成果", impact.affectedArtifactIds],
                  ["保留原状态的当前成果", impact.reusableArtifactIds],
                ] as const
              ).map(([label, ids]) => (
                <details key={label} open={ids.length > 0 && ids.length <= 6}>
                  <summary>
                    {label} · {ids.length} 份
                  </summary>
                  {ids.length ? (
                    <ul>
                      {ids.map((id) => {
                        const artifact = project?.fusion?.artifacts.find((item) => item.id === id);
                        return (
                          <li key={id}>
                            {artifact
                              ? `${taskLabel(artifact.taskId)} · ${artifact.interim ? "中间成果" : "完整成果"} · 成果版本 ${artifact.taskVersion}`
                              : "成果身份详见项目记录"}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p>无</p>
                  )}
                </details>
              ))}
              <p>原文和历史版本不删除；保留原状态不等于新增专业核验。</p>
              {impact.historicalAffectedTaskIds.length ? (
                <p>
                  另有 {impact.historicalAffectedTaskIds.length}{" "}
                  项历史任务关联同一材料条件；旧输入成果保留为历史，不放行当前任务。
                </p>
              ) : null}
              <p>
                {impact.supersedesExport
                  ? "当前导出稿将转为历史版本，复核完成前不能代表本轮有效稿。"
                  : "本次采用不会撤销当前导出稿。"}
              </p>
              <p>提交时会再次核对本次展示的输入和成果；影响已变化时需重新查看。</p>
            </div>
          ) : null}
          <button
            type="button"
            disabled={
              busy ||
              !description.trim() ||
              (category === "data" && (!dataKind || !permission || !tableName))
            }
            onClick={() =>
              onAdopt(
                {
                  category,
                  sourceDescription: description,
                  ...(category !== "data" ? { textScope } : {}),
                  ...(category === "data" && dataKind && permission
                    ? {
                        dataKind,
                        permission,
                        tableName,
                        ...(formulaBasis ? { formulaValueBasis: formulaBasis } : {}),
                      }
                    : {}),
                },
                impact?.token,
              )
            }
          >
            查看上述影响并采用材料
          </button>
        </div>
      ) : null}
    </details>
  );
}
