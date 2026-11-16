# Lancer 所有权地图（短表） / Ownership map

**第一真相** Source of truth for “改哪”。长 RULING / plan 降级为归档。  
**目标** 提效：找文件快、并行少冲突、改一处不炸全身。换 UI 仅为附带能力。

路径相对 `apps/desktop/`，除非写明 `packages/`。

## 竖切一览 Feature → Renderer → IPC → Electron → Persistence

| Feature / 域           | Renderer                                                                     | Contracts（宜按域拆后）                                   | Electron owner                                               | Persistence / 备注                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 壳 / App shell         | `src/app/`                                                                   | `theme.ts`, **新增** `layout.ts` / `typography.ts`        | `windows/`, `application/`                                   | UI-state                                                                                  |
| 侧栏 / Zones & threads | `src/features/threads/`（含 `lancer-zone-sidebar`, `lancer-recent-threads`） | `lancer-zones.ts`, thread 相关从 `ipc.ts` 抽出            | `workspace/`, conversation 读路径                            | catalog + UI-state                                                                        |
| 对话 / Conversation    | `src/features/conversation/`（composer、timeline、model-reel）               | composer-* , timeline-types；IPC conversation 组          | `conversation/`                                              | drafts / attachments                                                                      |
| 接力树 / Process tree  | `src/features/conversation/lancer-process/` + `session-trajectory/`          | 树事件/回放类型（可新建 `process-tree.ts`）；几何与皮分家 | 多为 renderer + 现有 lane/runtime；勿塞进胖 `ipc`            | demo replay 与 live 数据契约分开                                                          |
| 代码跑层 / 玻璃状态    | 底部 run 区（handoff mock）+ 相关 hooks                                      | 状态条只消费 layout token                                 | `control/`（若已有）                                         | 勿与树几何混写                                                                            |
| Orb 桌面小球           | orb 相关 renderer + `electron/windows` / `control`                           | 独立窗口契约                                              | `windows/` / `control/`                                      | 独立于主壳几何                                                                            |
| Workbench / Review     | `src/features/workbench/`                                                    | `workbench.ts`, `review.ts`                               | `workbench/`                                                 | reviewed-files / checkpoints                                                              |
| Extensions             | `src/features/extensions/`                                                   | `extension-views.ts`                                      | `extensions/`                                                | Chord 连接生命周期                                                                        |
| Settings               | `src/features/settings/`                                                     | settings 组从 `ipc` 抽出                                  | settings 路径 / platform                                     | UI-state                                                                                  |
| Scheduled tasks        | `src/features/scheduled-tasks/`                                              | `scheduled-tasks.ts`                                      | `scheduled-tasks/`                                           | `scheduled-tasks.json`                                                                    |
| Doubao / 外部绑定      | 对应 feature                                                                 | `doubao-app.ts`                                           | `doubao-app/`                                                | 宿主适配                                                                                  |
| Agent loop             | **禁止**放 desktop 厚逻辑                                                    | session-driver 类型                                       | 经 `packages/pi-sdk-driver`                                  | upstream pi-mono                                                                          |
| 教育研究课题组         | `src/features/conversation/research-group/`                                  | `research-group.ts`、独立窄 IPC 动作                      | `electron/research-group/coordinator.ts`，宿主只适配 Pi 会话 | `repository.ts` 唯一写入 `research-groups.json` 及项目导出；`knowledge.ts` 只读外部课程库 |

## 热点文件（优先拆）

| 文件                                       | 约量     | 建议                                                                                                                             |
| ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/ipc.ts`                         | ~884 LOC | 按域拆：`ipc/conversation.ts`, `ipc/workspace.ts`, `ipc/workbench.ts`, `ipc/lancer-process.ts`, …；`ipc.ts` 或 `register` 只聚合 |
| `contracts/desktop-state.ts`               | ~439 LOC | 按投影切片；禁止继续堆全能 state                                                                                                 |
| `src/styles/*.css`（含 `lancer.css` ~355） | 集中     | 域 CSS 迁到 `features/<domain>/`；`tokens.css` + 新增 layout/type token 只留全局                                                 |
| 长 `~/Projects/lancer-relay/RULING-*.md`   | 多篇     | 归档；决策进本表或一页 `STRUCTURE-ALIGN.md`                                                                                      |

## 边界（机检优先）

1. Renderer **不得** import Electron / Node。
2. Contracts **不得**依赖 React 或 host 实现。
3. 装饰皮（orb、光线、渐变）**不得**改写几何测量（虚拟列表、pane resize、tree 坐标）。
4. 多 worktree（`lancer-relay-a` / `lanes-d` / `ui-shell`…）是并行手段，**不是**产品拓扑；所有权以本表为准。

## 怎么用

- 新人 / agent：「改 X」→ 先查本表一行，再打开对应三列路径。
- PR：标题带域名（如 `process-tree:`）；禁止无关域顺手改胖 `ipc.ts` / 全局 css。
- 与 `docs/architecture`（若同步自上游）冲突时：**以本表 + 仓库 guards 为准**，长文次之。

## 2026-10-28 助手与并行会话

助手配置的唯一写入方为 `electron/application/lancer-assistant-store.ts`，保存于 `assistants.json`。`contracts/lancer-assistants.ts` 定义头像、会话归属与窄动作，`use-assistant-scope` 只做视图投影。模型选择不改变助手身份。

独立运行仍使用现有 orchestration owner / Pi driver。分叉与回传依赖持久化的 child / evidence，`parallel-tree.ts` 只投影；动画不能写会话。悬浮窗读取 `control/runtime-journal`，`orb-output.ts` 合并工具的累计更新，不再只保留末尾九行。

## 2026-11-06 CYZ 内置研究流程

`contracts/cyz-paper-workflow.ts` 定义九阶段默认目标和稳定指导标识；阶段数量上限由 `contracts/lancer-workflows.ts` 统一供编辑器、保存校验和动作解码使用。`electron/application/cyz-workflow-guide.ts` 在主进程读取 `resources/workflows/` 中允许的指导文件，交给现有会话发送路径；renderer 不接收任意文件读取接口，Pi driver 不承载论文规则。模板及会话配置仍由 `LancerAssistantStore` 保存；项目研究状态由工作区中的 Markdown 保存。

## 2026-11-07 教育研究课题组

`edu-research-group` 是与 CYZ 阶段工作台并列的模式。独立调度器管理四个持久化 Pi 会话，以已发布、已读取的不可变成果推进；不进入通用子任务的同组完成屏障。知识、项目证据、应用配置分别保存。第一版只打磨问题并审阅初步方案；该组运行只启用 `research_group` 工具，外部原文检索和实地研究尚不在范围内。普通会话及原工作台的工具不变。具体门禁和验证契约见 `docs/education-research-group.md`。
