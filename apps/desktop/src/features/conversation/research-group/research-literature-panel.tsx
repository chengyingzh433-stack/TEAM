import type { ResearchProject } from "../../../../contracts/research-group";

const depth = {
  metadata: "题录",
  abstract: "摘要",
  "partial-text": "部分正文",
  "full-text": "所提供全文",
};
const decision = { include: "纳入", exclude: "排除", undecided: "待判断" };
function title(rawJson: string) {
  try {
    const value: unknown = JSON.parse(rawJson);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const raw = (value as Record<string, unknown>).title;
      if (typeof raw === "string") return raw.slice(0, 300);
      if (Array.isArray(raw) && raw.every((part) => typeof part === "string"))
        return raw.join("；").slice(0, 300);
    }
  } catch {
    /* The original remains available even if the preview cannot be read. */
  }
  return "候选原记录";
}
export function ResearchLiteraturePanel({ project }: { project: ResearchProject }) {
  const ledger = project.literatureSearch;
  if (!ledger) return null;
  const operations = project.literatureToolOperations ?? [];
  const duplicateGroups = new Map<string, string[]>();
  for (const record of ledger.records) {
    const group = duplicateGroups.get(record.dedupeKey) ?? [];
    group.push(record.id);
    duplicateGroups.set(record.dedupeKey, group);
  }
  const duplicates = [...duplicateGroups].filter(([, ids]) => ids.length > 1);
  const searches = ledger.batches.filter((batch) => batch.origin === "execution");
  const imports = ledger.batches.filter((batch) => batch.origin === "import");
  return (
    <details className="research-group-records" data-testid="research-literature-process">
      <summary>
        文献检索与筛选 · {searches.length} 次查询记录 · {imports.length} 批导入 ·{" "}
        {ledger.records.length} 条候选
      </summary>
      <p>
        检索计划、实际返回、访问、阅读与筛选分别记录。旧策略和旧输入的执行保留历史；这里的记录数量不代表当前版本已充分检索或已读全文。
      </p>
      {ledger.strategies.map((strategy) => (
        <details
          key={`${strategy.id}:${strategy.version}`}
          data-literature-strategy-id={strategy.id}
          data-literature-strategy-version={strategy.version}
        >
          <summary>
            计划 · {strategy.question} · v{strategy.version}
          </summary>
          <p>变更理由：{strategy.changeReason}</p>
          <p>
            概念：{strategy.concepts.join("；")}；同义词：{strategy.synonyms.join("；")}
          </p>
          {strategy.queries.map((query, index) => (
            <p key={index}>
              拟查询 {query.source}：{query.query}；计划过滤：{query.filters}
            </p>
          ))}
          <p>纳入条件：{strategy.inclusionCriteria.join("；")}</p>
          <p>排除条件：{strategy.exclusionCriteria.join("；")}</p>
          <p>停止条件：{strategy.stopRule}</p>
          <p>登记时间：{strategy.recordedBy.at}</p>
        </details>
      ))}
      {ledger.batches.map((batch) => {
        const operation = operations.find((entry) => entry.id === batch.id);
        return (
          <details
            className="research-material-item"
            key={batch.id}
            data-literature-batch-id={batch.id}
            data-literature-batch-status={batch.status}
          >
            <summary>
              {batch.origin === "execution" ? "实际查询" : "实际导入"} ·{" "}
              {batch.status === "succeeded" ? `${batch.recordIds.length} 条返回` : "失败记录"} ·{" "}
              {batch.completedAt}
              {operation?.historical ? " · 到达时已属历史" : ""}
            </summary>
            {batch.query ? <p>实际检索式：{batch.query}</p> : null}
            {batch.endpoint ? <p>实际端点：{batch.endpoint}</p> : null}
            <p>
              策略：{batch.strategyId} v{batch.strategyVersion}
            </p>
            <p>
              开始：{batch.startedAt}；结束：{batch.completedAt}
            </p>
            {batch.failure ? <p>{batch.failure}</p> : null}
            {batch.limitations.length ? (
              <ul>
                {batch.limitations.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : null}
            {operation?.archiveError ? <p>{operation.archiveError}</p> : null}
            {operation?.historyReason ? <p>历史原因：{operation.historyReason}</p> : null}
            <details>
              <summary>实际原记录与摘要</summary>
              <p>
                {batch.representation === "returned-candidate-metadata"
                  ? "返回候选元数据 JSON；不是完整 HTTP 响应或论文全文。"
                  : "实际导入的 JSON 原记录。"}
              </p>
              <p>原件：{batch.original.name}</p>
              <p>SHA：{batch.original.sha256}</p>
              <p>
                {batch.original.available
                  ? "原始返回或导入字节已取得并保留。"
                  : "未取得原件，不用空内容冒充成功。"}
              </p>
            </details>
          </details>
        );
      })}
      {duplicates.length ? (
        <details>
          <summary>重复候选 · {duplicates.length} 组，原记录均保留</summary>
          <p>仅按 DOI 或完整 URL 归组；没有以相似标题自动合并。</p>
          {duplicates.map(([key, ids]) => (
            <p key={key}>
              {key} · {ids.length} 条：{ids.join("、")}
            </p>
          ))}
        </details>
      ) : null}
      <details>
        <summary>候选与逐条筛选 · {ledger.records.length} 条</summary>
        {ledger.records.map((record) => (
          <details key={record.id} data-literature-record-id={record.id}>
            <summary>{title(record.rawJson)}</summary>
            <p>
              候选：{record.id}；原记录摘要：{record.rawSha256}
            </p>
            <details>
              <summary>候选原记录</summary>
              <pre>{record.rawJson}</pre>
            </details>
            {(project.literatureRecordReads ?? [])
              .filter((read) => read.recordId === record.id)
              .map((read) => (
                <p key={read.id}>
                  实际返回阅读 · {depth[read.depth]} · {read.host.actor.id} · {read.host.at}
                </p>
              ))}
            {ledger.accesses
              .filter((access) => access.recordId === record.id)
              .map((access) => (
                <p key={access.host.id}>
                  访问 · {access.url} ·{" "}
                  {access.outcome.status === "failed"
                    ? `失败：${access.outcome.error}`
                    : `取得文本：${access.outcome.sourceId}；取得不等于已读。`}
                </p>
              ))}
            {ledger.screenings
              .filter((screen) => screen.recordId === record.id)
              .map((screen) => (
                <blockquote key={screen.host.id}>
                  <p>
                    {decision[screen.decision]} · {depth[screen.depth]} · {screen.host.actor.id} ·{" "}
                    {screen.host.at}
                  </p>
                  <p>{screen.reason}</p>
                  {screen.readings.map((reading) => (
                    <p key={reading.readId}>
                      {reading.sourceId} · {reading.locatorId} · 字符 {reading.start}–{reading.end}{" "}
                      · {depth[reading.depth]}
                    </p>
                  ))}
                  <p>模型筛选意见；只覆盖所列材料与读取范围。</p>
                </blockquote>
              ))}
          </details>
        ))}
      </details>
      <details>
        <summary>停止记录与剩余限制 · {ledger.stops.length} 条</summary>
        {ledger.stops.map((stop) => (
          <blockquote key={stop.host.id}>
            <p>{stop.reason}</p>
            <p>{stop.remainingLimitations.join("；")}</p>
            <p>
              {stop.strategyId} v{stop.strategyVersion} · {stop.host.actor.id} · {stop.host.at}
            </p>
          </blockquote>
        ))}
      </details>
    </details>
  );
}
