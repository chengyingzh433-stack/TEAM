# FR16／AC18：18 次真实协作对照准备

状态：仅准备，18 次均未运行，AC18 未验收。不得从模板、单元夹具或构建结果推导速度／质量结论。当前能力见 [统一说明](education-research-group.md)，新融合完整研究见 [AC33 演练清单](education-research-group-m4-full-flow.md)。两者分别留证，不能以 18 个小任务替代 AC33 全流程。

## 预登记：先固定，再运行

三类任务为问题与方案（question-design）、文献综合（literature-synthesis）、已有数据分析与写作（analysis-writing）。每类同一材料包、工具权限、角色模型／思考强度、目标、交付、质量标准、停止规则和人工干预规则；串行／协作各三次，共 18 次。原始材料保存只读副本、SHA256 与许可，不使用旧最终稿作为新产物。

串行条件保留导师、A、B、资料员及全部核查，把**本课题同时执行上限设为 1**，按同样依赖顺序执行；不删除 B、简化任务或改为一个作者包办。协作条件固定预登记的更高项目容量，允许原有依赖下独立执行与中途交接。使用独立实验配置／新课题，避免其他课题占用全局容量；记录应用上限、排队及外部负载。不要为实验修改常用课题配置。

每次全新课题和会话，避免前一运行成果泄漏；同一原始材料包可复用。真实模型缓存不能假定清空，记录预热、缓存、服务排队、时间段和价格来源。禁止看见结果后换模型、换标准或删掉失败。需要改变协议时停止本批，另建批次并保留原记录。

预算登记必须写清 18 次规模、实际模型、准入额度、费用上限及未知计价处理、停止条件、操作者确认与时间。工具不启动模型、不设置预算、不自动授权；真实运行由用户承担。受预算／服务限制未完成时仍为未验收。

## 交错顺序

记录生成器按下列顺序生成固定编号。S 为串行，C 为协作；每对使用完全相同任务与材料。不同条件交错，避免把全部串行集中在同一时间；三次重复不足以消除时段和缓存影响，结论须披露。

| 次序  | 重复 | 类别       | 条件顺序 |
| ----- | ---- | ---------- | -------- |
| 1–2   | 1    | 问题与方案 | S → C    |
| 3–4   | 1    | 文献综合   | C → S    |
| 5–6   | 1    | 分析与写作 | S → C    |
| 7–8   | 2    | 问题与方案 | C → S    |
| 9–10  | 2    | 文献综合   | S → C    |
| 11–12 | 2    | 分析与写作 | C → S    |
| 13–14 | 3    | 问题与方案 | S → C    |
| 15–16 | 3    | 文献综合   | C → S    |
| 17–18 | 3    | 分析与写作 | S → C    |

失败或人工中止仍占原计划位置，保留实际耗时、输出、费用和原因；追加探索性重试另立文件、关联原编号，不覆盖原失败、不悄悄补成成功。一次任务中的自动重试属于该次运行的用量和返工。

## 准备记录文件

在仓库根运行以下离线命令，目标目录须已存在，文件名须是新的：

```sh
node scripts/research-evaluation.mjs init /absolute/evidence/experiment-01.json
node scripts/research-evaluation.mjs summarize /absolute/evidence/experiment-01.json /absolute/evidence/summary-01.json
```

`init` 只创建 18 条 pending 记录；`summarize` 校验后生成 JSON 汇总，不修改输入。两种写入均排他创建，已有文件或同名输入拒绝覆盖。失败不会清理文件。汇总随记录更新使用新的文件名。可审阅的空模板另见 [18 次计划模板](education-research-group-evaluation-template.json)。

顶层 `protocol` 初始 null；运行前填对象，全部字段为非空字符串：

| 字段                                     | 内容                                                         |
| ---------------------------------------- | ------------------------------------------------------------ |
| registeredAt                             | ISO 时间，早于任何运行                                       |
| operator                                 | 操作者身份                                                   |
| budgetApproval / budgetAndScale          | 确认记录位置；规模、额度、费用与停止边界                     |
| environment                              | 源码提交、应用版本、平台、工具版本、隔离目录、全局容量与负载 |
| serialProcedure / collaborativeProcedure | 两条件容量、同一角色／依赖／核查流程、实际操作规则           |
| cachePolicy                              | 预热、缓存、跨次材料与会话隔离方法                           |
| reviewerIndependence                     | 作者身份规则、独立评阅者与盲评方式／局限                     |

三个 `tasks[].registration` 初始 null；各填非空字符串字段：`objective`、`materialsManifest`（文件、SHA、许可）、`modelAssignments`（全部角色及阶段）、`tools`、`deliverables`、`qualityRubric`、`interventionRule`、`stopRule`。同一类别的两条件共享该登记，不能各自换材料或质量要求。

`runs` 的 id/order/task/repeat/condition 固定，不能删除、调换或重命名。未运行为 `status: "pending", observation: null`。一次运行终止后设 completed／failed／aborted，填下面的 observation（示意字段，不是实测结果）：

```json
{
  "projectId": "实际新课题 ID",
  "sessionEvidence": "四角色会话及请求身份记录位置",
  "timingEvidence": "实际开始结束、请求重叠及关键路径图位置",
  "usageEvidence": "全部尝试的用量账本位置，含失败及未知",
  "cacheConditions": "实际预热与缓存条件；未知则说明",
  "interventions": "实际干预明细或明确无干预",
  "failures": "失败原因与证据；无失败时明确记录",
  "deviations": "协议偏离与影响；无偏离时明确记录",
  "resultEvidence": "全部输出及指纹；失败也保留部分输出／错误记录",
  "unknownReasons": "每个 null 指标的原因；无缺失时明确记录",
  "authorIds": ["实际参与作者身份"],
  "startedAt": "实际 ISO 开始时间",
  "endedAt": "实际 ISO 结束时间",
  "metrics": {
    "elapsedSeconds": null,
    "criticalPathSeconds": null,
    "inputTokens": null,
    "outputTokens": null,
    "cacheReadTokens": null,
    "cacheWriteTokens": null,
    "money": null,
    "humanMinutes": null,
    "reworkCount": null
  },
  "quality": null
}
```

开始／结束包含排队到交付或终止的同一口径，`elapsedSeconds` 必须是两时间的秒差。关键路径给出实际依赖链及计时依据，不把所有成员时长相加；无法确定则 null。用量记录所有尝试，不把 null 填 0；人工分钟和返工次数也按预登记口径。若 `money` 为数值，另填 `currency` 与 `pricingEvidence`；不同币种不合并，订阅 SDK 的 cost 不自动视为账单。

## 独立内容评阅

每个完成、失败或中止运行都保留独立评阅；无可评稿件时按同一预登记规则评“交付未完成”，并说明局限。评阅者不参与该稿作者角色；使用去条件标记的副本、随机评阅编号，映射单独保留。无法盲评须披露。仅字符串身份检查不能证明真正独立，操作者需核实身份及实际阅读。

统一 0–100 分可预登记为：问题／设计适配 20、来源可核验与使用准确 25、分析／推理有效性 25、反馈处理与限制披露 20、交付完整与可读性 10。各类别先固定具体判据；无需统计的任务以论证适配评分，不惩罚没有回归计算。未执行必要工作不能靠文字流畅补分。高风险事实／引用／数字错误单独列出。

将 observation.quality 从 null 填为 `{ reviewerId, rubricEvidence, reviewEvidence, limitations, score }`；前四项为实际非空字符串，score 为 0–100。评阅保存理由、原稿指纹与问题定位，不能只留总分。工具拒绝 reviewerId 与 authorIds 重合，但不判断内容真伪。

## 汇总与结论边界

汇总每类×条件的全部原记录、完成／失败／中止／未运行数，以及耗时、关键路径、四项 Token、费用、干预、返工及质量的已知数量、中位数、最小／最大值和缺失数。失败纳入指标，不能只展示成功耗时；未运行和未知不算零。少于三条已知值时统计仍显示样本数，不冒充三次测量。混合币种不给合计或中位数。

18 次均有终态及评阅时只标 `ready-for-human-review`；其他情况为 `incomplete`。这不是 AC18 自动通过，程序不核验外部证据路径是否真实，不把自报分数当独立内容证明，也不计算预设提速百分比或显著性。

最终人工报告须逐类列出全部值、配对差异、质量与失败代价、未知和缓存局限，判断何时适合协作／小团队／串行。效果不稳定也可如实完成评估；数据缺失、评阅不独立或条件不一致时明确未验收。关联 AC33、AC34 的实际证据，最终常用安装验收另记，保留所有原始文件和失败记录。
