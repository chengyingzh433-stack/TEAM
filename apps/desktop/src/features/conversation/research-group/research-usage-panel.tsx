import type { ResearchGroupsState, ResearchProject } from "../../../../contracts/research-group";
import {
  researchUsageRows,
  researchUsageSummary,
} from "../../../../contracts/research-usage-report";

export function ResearchUsagePanel({
  state,
  project,
}: {
  state: ResearchGroupsState;
  project: ResearchProject;
}) {
  const rows = researchUsageRows(state, project),
    summary = researchUsageSummary(rows);
  const global = researchUsageSummary(state.projects.flatMap((p) => researchUsageRows(state, p)));
  const count = (value: number) => value.toLocaleString();
  return (
    <details>
      <summary>投入与未结算用量</summary>
      <p>
        本课题已知 {count(summary.knownTokens)} Token；未结算 {summary.unresolved} 次，保留预留{" "}
        {count(summary.reservedTokens)} Token。失败、取消和重试均计入原执行记录。
      </p>
      <p>
        全部课题：已知 {count(global.knownTokens)} Token，未结算预留 {count(global.reservedTokens)}{" "}
        Token。预留用于后续准入，不是实际账单，也不保证在途消费硬封顶。
      </p>
      <p>
        已知分项：输入 {count(summary.buckets.input)}，输出 {count(summary.buckets.output)}
        ，缓存读取 {count(summary.buckets.cacheRead)}，缓存写入 {count(summary.buckets.cacheWrite)}
        。另有 {summary.missingBreakdown} 次仅知总数；未结算与缺少分项不按零消耗解释。
      </p>
      <p>金额未知：当前执行记录没有可核实的计价依据，不将订阅服务的估算 cost 当作已付款金额。</p>
      <ul>
        {[...new Set(rows.map((row) => row.member))].map((member) => {
          const usage = researchUsageSummary(rows.filter((row) => row.member === member));
          return (
            <li key={member}>
              {member}：已知 {count(usage.knownTokens)} Token；输入／输出／缓存读／缓存写{" "}
              {Object.values(usage.buckets).map(count).join(" / ")}；未结算 {usage.unresolved}{" "}
              次，缺分项 {usage.missingBreakdown} 次。
            </li>
          );
        })}
      </ul>
      <table>
        <thead>
          <tr>
            <th>成员／任务</th>
            <th>状态</th>
            <th>已知 Token</th>
            <th>输入／输出／缓存读／缓存写</th>
            <th>未结算预留</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {row.member} · {row.task}
                <br />
                {row.id}
              </td>
              <td>{row.state}</td>
              <td>{row.usedTokens === undefined ? "未知" : count(row.usedTokens)}</td>
              <td>
                {row.tokenUsage
                  ? [
                      row.tokenUsage.input,
                      row.tokenUsage.output,
                      row.tokenUsage.cacheRead,
                      row.tokenUsage.cacheWrite,
                    ]
                      .map(count)
                      .join(" / ")
                  : "分项未知"}
              </td>
              <td>{row.usedTokens === undefined ? count(row.reservedTokens) : "已结算"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
