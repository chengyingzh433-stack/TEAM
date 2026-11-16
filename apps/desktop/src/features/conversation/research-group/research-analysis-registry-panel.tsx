import type {
  RegisteredResearchAnalysisPlan,
  RegisteredResearchAnalysisReview,
  RegisteredResearchAnalysisRun,
  ResearchAnalysisRegistry,
} from "../../../../contracts/research-analysis-registry";
import type { ResearchDataset } from "../../../../contracts/research-evidence";
import type { ResearchProject } from "../../../../contracts/research-group";

export interface ResearchAnalysisRegistryPanelProps {
  registry: ResearchAnalysisRegistry | undefined;
  datasets: readonly Pick<ResearchDataset, "id" | "sha256">[];
  project?: ResearchProject;
}
const purposeLabels = {
  primary: "主分析",
  comparison: "比较分析",
  descriptive: "描述分析",
  supplementary: "补充分析",
  exploratory: "探索分析",
};
const timingLabels = {
  prospective: "事前登记",
  "post-hoc": "事后登记",
  "legacy-unknown": "原登记时点未知",
};
const methodLabels: Record<string, string> = {
  describe: "描述统计",
  correlation: "相关分析",
  ols: "普通 OLS",
};
const verdictLabels = { accept: "接受意见", revise: "修改意见", hold: "暂缓意见" };
const exclusionLabels = {
  "empty-record": "空记录",
  "not-selected": "未选入指定样本",
  "missing-values": "所需变量缺失",
};

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="research-material-item">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
function ReviewRecord({ review }: { review: RegisteredResearchAnalysisReview }) {
  return (
    <details className="research-material-item">
      <summary>
        {review.kind === "plan-review" ? "计划审阅" : "结果解释审阅"} ·{" "}
        {verdictLabels[review.verdict]} · 记录身份：{review.actor}
      </summary>
      <p>{review.note}</p>
      <p>
        记录时间：<time dateTime={review.at}>{review.at}</time>
      </p>
      <p>出处：{review.evidenceRef}</p>
      <p>身份按原始记录保留；模型意见不代表人类审阅或独立算法核验。</p>
    </details>
  );
}
function dataState(
  id: string,
  hash: string | undefined,
  datasets: ResearchAnalysisRegistryPanelProps["datasets"],
) {
  if (!hash) return "未锁定数据摘要";
  const current = datasets.filter((dataset) => dataset.id === id);
  if (!current.length) return "当前数据不可用";
  if (current.length !== 1) return "当前数据身份待核查";
  return current[0]!.sha256 === hash ? "数据摘要与当前登记一致" : "数据已过期";
}
function RunRecord({
  run,
  registry,
  datasets,
}: { run: RegisteredResearchAnalysisRun; registry: ResearchAnalysisRegistry } & Pick<
  ResearchAnalysisRegistryPanelProps,
  "datasets"
>) {
  const plan = registry.plans.find(
    (item) => item.id === run.planId && item.version === run.planVersion,
  );
  const newerPlan = registry.plans.some(
    (item) => item.id === run.planId && item.version > run.planVersion,
  );
  const reviews = registry.reviews.filter(
    (review) =>
      review.planId === run.planId &&
      review.planVersion === run.planVersion &&
      review.runId === run.id,
  );
  const interpretationReviews = reviews.filter((review) => review.kind === "interpretation-review");
  const state = [
    !plan ? "关联计划缺失" : newerPlan ? "计划版本已过期" : "计划版本未被替代",
    dataState(run.datasetId, run.datasetSha256, datasets),
    interpretationReviews.length
      ? `累计 ${interpretationReviews.length} 条此运行的解释意见，当前适用性另核`
      : "本运行尚无解释审阅记录",
  ];
  const excludedCounts = Object.fromEntries(
    Object.keys(exclusionLabels).map((reason) => [
      reason,
      run.sample.excluded.filter((row) => row.reason === reason).length,
    ]),
  );
  return (
    <details className="research-material-item" data-analysis-run-id={run.id}>
      <summary>
        实际运行 · <time dateTime={run.at}>{run.at}</time> · {state.join("；")}
      </summary>
      <p>
        执行记录身份：{run.actor}；算法：{run.engine}；计划版本 {run.planVersion}。
      </p>
      <p>
        {run.sample.label === "original-all-records" ? "原始全部记录入口" : "明确派生样本入口"}
        ；缺失处理：{run.sample.policy === "per-variable" ? "逐变量纳入" : "完整案例"}。
      </p>
      <table>
        <caption>本次实际样本记录</caption>
        <thead>
          <tr>
            <th scope="col">记录项</th>
            <th scope="col">数量</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">原始数据记录</th>
            <td>{run.sample.originalDataRows}</td>
          </tr>
          <tr>
            <th scope="row">选入的原始行</th>
            <td>{run.sample.selectedSourceLines.length}</td>
          </tr>
          <tr>
            <th scope="row">所需变量完整的原始行</th>
            <td>{run.sample.completeSourceLines.length}</td>
          </tr>
          <tr>
            <th scope="row">排除记录</th>
            <td>{run.sample.excluded.length}</td>
          </tr>
          <tr>
            <th scope="row">含缺失值的记录</th>
            <td>{run.sample.missing.length}</td>
          </tr>
          {Object.entries(run.sample.perVariableSourceLines).map(([variable, lines]) => (
            <tr key={variable}>
              <th scope="row">{variable} · 可用原始行</th>
              <td>{lines.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        排除原因：
        {Object.entries(exclusionLabels)
          .map(([reason, label]) => `${label} ${excludedCounts[reason]}`)
          .join("；")}
        。含缺失值的行与排除行可能重叠，不能相加作为样本总量。
      </p>
      <JsonDetails label="展开实际纳入、排除与缺失的原始行定位" value={run.sample} />
      <details className="research-material-item">
        <summary>
          同引擎复跑记录 ·{" "}
          {run.verification.level === "same-engine-replay"
            ? run.verification.matches
              ? "与所引用运行一致"
              : "与所引用运行不一致"
            : "尚无同引擎复跑记录"}
        </summary>
        <p>同一引擎重放与结果解释审阅分别记录，不能据此声称独立算法验证通过。</p>
        {run.verification.level === "same-engine-replay" && (
          <p>引用运行：{run.verification.replayOf}</p>
        )}
      </details>
      <details className="research-material-item">
        <summary>本次运行的审阅记录 · {reviews.length}</summary>
        {reviews.length ? (
          reviews.map((review) => <ReviewRecord key={review.id} review={review} />)
        ) : (
          <p>尚未登记针对本次运行的审阅；执行完成不等于结果被接受。</p>
        )}
      </details>
      <JsonDetails label="展开实际结果 JSON（只读）" value={run.result} />
      <JsonDetails
        label="展开运行身份、数据及结果摘要"
        value={{
          runId: run.id,
          planId: run.planId,
          planVersion: run.planVersion,
          datasetId: run.datasetId,
          datasetSha256: run.datasetSha256,
          calculationInputSha256: run.calculationInputSha256,
          resultSha256: run.resultSha256,
          runSha256: run.runSha256,
          replay: run.replay,
          parameters: run.parameters,
        }}
      />
    </details>
  );
}
function PlanRecord({
  plan,
  registry,
  datasets,
}: { plan: RegisteredResearchAnalysisPlan; registry: ResearchAnalysisRegistry } & Pick<
  ResearchAnalysisRegistryPanelProps,
  "datasets"
>) {
  const runs = registry.runs.filter(
    (run) => run.planId === plan.id && run.planVersion === plan.version,
  );
  const superseded = registry.plans.some(
    (item) => item.id === plan.id && item.version > plan.version,
  );
  const reviews = registry.reviews.filter(
    (review) => review.planId === plan.id && review.planVersion === plan.version && !review.runId,
  );
  return (
    <details
      className="research-material-item"
      data-analysis-plan-id={plan.id}
      data-plan-version={plan.version}
    >
      <summary>
        {plan.label} · {purposeLabels[plan.purpose]} · 版本 {plan.version} ·{" "}
        {timingLabels[plan.registration.timing]} ·{" "}
        {runs.length ? `已执行 ${runs.length} 次` : "未执行"}
        {superseded ? " · 计划版本已过期" : ""}
      </summary>
      <p>目标：{plan.objective}</p>
      <p>
        登记方法：{methodLabels[plan.method] ?? plan.method}；变量：{plan.columns.join("、")}
        {plan.outcome ? `；因变量：${plan.outcome}` : ""}。
      </p>
      <p>
        数据：{plan.dataset.id} · {dataState(plan.dataset.id, plan.dataset.sha256, datasets)}。
      </p>
      <p>计划输出：{plan.outputs.join("、")}。</p>
      <p>
        样本计划：
        {plan.sample.mode === "all"
          ? "全部原始记录；实际纳入仍按执行时的缺失处理记录"
          : `${plan.sample.sourceLines.length} 个明确指定原始行；${plan.sample.reason}`}
        。
      </p>
      {plan.compareWith && (
        <p>
          比较对象：
          {registry.plans.find(
            (item) =>
              item.id === plan.compareWith!.planId &&
              item.version === plan.compareWith!.planVersion,
          )?.label ?? plan.compareWith.planId}{" "}
          · 版本 {plan.compareWith.planVersion}；
          {plan.compareWith.requireSameSample
            ? "要求相同样本，是否满足须检查实际运行"
            : "未要求相同样本，解释比较时需核对差异"}
          。
        </p>
      )}
      <p>审阅计划：{plan.reviewPlan}</p>
      <details className="research-material-item">
        <summary>登记理由与出处 · {timingLabels[plan.registration.timing]}</summary>
        <p>{plan.registration.reason}</p>
        <p>
          登记时间：<time dateTime={plan.registration.at}>{plan.registration.at}</time>
        </p>
        <p>出处：{plan.registration.sourceRef}</p>
      </details>
      <JsonDetails
        label="展开锁定数据摘要、参数与样本选择"
        value={{
          planId: plan.id,
          version: plan.version,
          dataset: plan.dataset,
          parameters: plan.parameters,
          sample: plan.sample,
          compareWith: plan.compareWith,
        }}
      />
      <details className="research-material-item">
        <summary>计划层审阅记录 · {reviews.length}</summary>
        {reviews.length ? (
          reviews.map((review) => <ReviewRecord key={review.id} review={review} />)
        ) : (
          <p>尚无计划层审阅记录。</p>
        )}
      </details>
      {runs.length ? (
        runs.map((run) => (
          <RunRecord key={run.id} run={run} registry={registry} datasets={datasets} />
        ))
      ) : (
        <p>该计划版本尚无实际执行记录。登记计划不会生成结果。</p>
      )}
    </details>
  );
}

/** Read-only renderer projection. Hash integrity, capability and acceptance gates belong to the host. */
export function ResearchAnalysisRegistryPanel({
  registry,
  datasets,
  project,
}: ResearchAnalysisRegistryPanelProps) {
  const plans = registry?.plans ?? [];
  const orphanRuns =
    registry?.runs.filter(
      (run) => !plans.some((plan) => plan.id === run.planId && plan.version === run.planVersion),
    ) ?? [];
  return (
    <details className="research-group-records" data-testid="research-analysis-registry-panel">
      <summary>
        分析登记 · {new Set(plans.map((plan) => plan.id)).size} 项计划 ·{" "}
        {registry?.runs.length ?? 0} 次实际运行
      </summary>
      <p>每项计划保留登记、实际运行和审阅记录。展开查看样本、缺失处理、结果与复跑依据。</p>
      {project?.analysisRunAdoptions?.length ? (
        <details data-testid="research-analysis-run-adoptions">
          <summary>既有计算的明确采用 · {project.analysisRunAdoptions.length} 次记录</summary>
          <p>
            原计算与本次采用各保留时间和身份。采用不增加运行次数；新稿仍需实际读结果并完成本轮解释审阅。
          </p>
          {project.analysisRunAdoptions.map((adoption) => {
            const task = project.fusion?.tasks.find((entry) => entry.id === adoption.target.taskId);
            const sameInput =
              project.revision === adoption.target.revision &&
              task?.inputVersion === adoption.target.taskInputVersion;
            return (
              <details key={adoption.id} data-analysis-adoption-id={adoption.id}>
                <summary>
                  明确采用 · {adoption.target.role === "lead" ? "研究者 A Agent" : "研究者 B Agent"}{" "}
                  · {adoption.at}
                </summary>
                <p>原运行：{adoption.pin.runId}</p>
                <p>
                  原生源执行：{adoption.source.nativeRunId}；原任务输入版本{" "}
                  {adoption.source.taskInputVersion}
                </p>
                <p>
                  采用任务：{adoption.target.taskId}；采用时输入版本{" "}
                  {adoption.target.taskInputVersion}；
                  {sameInput ? "当前任务仍为此输入版本" : "当前任务已变化，采用资格需重查"}。
                </p>
                <p>{adoption.reason}</p>
                <p>
                  实际采用模型：{adoption.target.model.provider}/{adoption.target.model.modelId}
                </p>
                <details>
                  <summary>采用时核验的计划、数据与归档摘要</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        pin: adoption.pin,
                        fileHashes: adoption.fileHashes,
                        changeIds: adoption.changeIds,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <p>实际文件和新稿仍在正式接受前核验；旧稿、旧解释意见及旧导出各保留原适用范围。</p>
              </details>
            );
          })}
        </details>
      ) : null}
      <p>
        登记方法不代表工具已支持。当前基础计算覆盖描述统计、相关和普通
        OLS；具体参数、输出与样本条件仍需执行前检查，不自动改用其他方法，不提供 p
        值、置信区间或因果识别。
      </p>
      {registry && plans.length ? (
        plans.map((plan) => (
          <PlanRecord
            key={`${plan.id}:${plan.version}`}
            plan={plan}
            registry={registry}
            datasets={datasets}
          />
        ))
      ) : (
        <p>尚未登记结构化分析计划。</p>
      )}
      {!!orphanRuns.length && registry && (
        <details className="research-material-item">
          <summary>关联计划缺失的历史运行 · {orphanRuns.length}</summary>
          {orphanRuns.map((run) => (
            <RunRecord key={run.id} run={run} registry={registry} datasets={datasets} />
          ))}
        </details>
      )}
    </details>
  );
}
