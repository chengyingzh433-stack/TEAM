# TEAM · 科研辅助工具

<p align="center"><img src="apps/desktop/resources/icon.png" width="160" alt="TEAM 图标"></p>

TEAM 是基于 Pi 的桌面科研辅助工具：把研究想法、材料、团队讨论、版本与交付放在同一工作区。你是课题发起人和最终决策者，导师、研究者 A、独立复核 B、资料员保留各自持续会话。导师在关键未知处组织引导式研讨，支持自由回答，并区分“探讨想法”和“正式指令”。

**当前版本：1.1.0-beta.2，开发测试版。** 提供 Apple Silicon macOS 安装测试包与源码；安装包未经过 Apple Developer ID 签名和公证。代码、存储、类型与构建检查不能代替真实研究、界面或模型验收。研究者仍需核查来源、方法、数据与结论。

[版本发布](https://github.com/chengyingzh433-stack/TEAM/releases) · [安装与已有 Pi 适配](docs/team-install.md) · [当前能力](docs/education-research-group.md) · [研讨测试清单](docs/education-research-group-guided-discussion.md)

## 能做什么

- 从想法、材料、稿件或单项任务进入研究，按 S0–S8 方法导航与依赖推进。
- 导师、A、B、资料员协作，先独立判断再互评；用户参与研讨和重要决定。
- 支持有限量化、范围明确的文献综述、已有文本质性及理论概念路径；可以只做精读、引用核查、设计评估、章节修改或全文审阅。
- 保留材料来源、实际阅读、分析计划与计算结果、内容核验、稿件版本和失败记录。
- 同版本导出 Word、Markdown、HTML 与溯源；显式选择可分发材料后生成研究归档，导入创建独立新课题。
- 显示执行容量、已知用量及未知预留；失败、暂停与恢复遵循原记录，不盲目重放未知请求。
- 独立保留 CYZ 论文工作台和旧课题模式，不强制迁移原有研究。

## macOS 直接安装

M 系列 Mac 用户可从[发布页](https://github.com/chengyingzh433-stack/TEAM/releases/tag/v1.1.0-beta.2)下载 `TEAM-1.1.0-beta.2-arm64-preview.dmg`，把 TEAM 拖入“应用程序”，打开后配置自己的账号和模型。无需安装开发环境或全局 Pi。最低系统目标 macOS 13，Intel 版暂未提供；首次打开的系统提示、已有数据保护和验证边界见[macOS 安装说明](docs/team-macos-install.md)。

## Pi 是否需要另装

TEAM 使用项目依赖中的 `@earendil-works/pi-coding-agent`，依赖安装时取得锁定版本的 Pi SDK。**不要求先全局安装 `pi` 命令。** 这不是另写一个模型循环，也不把用户账号、API 密钥或模型权重打进源码。

已使用 Pi 的用户可以继续使用默认 `~/.pi/agent` 配置与账号；TEAM 使用自己的锁定 SDK，不替换全局 Pi CLI。自定义 Pi 目录、备份与版本兼容说明见 [安装文档](docs/team-install.md)。首次启动前备份已有 Pi 配置和会话，不同时在多个客户端操作同一个正在运行的会话。

## 从源码启动

需要 Node **>=22.19.0 <26**（推荐 Node 24）、pnpm **10.34.9** 和 Git。安装依赖需要联网；原生依赖可能需要平台编译工具。

```sh
git clone https://github.com/chengyingzh433-stack/TEAM.git
cd TEAM
pnpm install --frozen-lockfile
pnpm dev
```

在应用中配置可用的提供商和模型。教育研究课题组还需要你自己的方法知识库／研究材料，课程正文、私人原文与示例账号均不随发布提供。没有原文、数据、工具或权限时应保留缺项，不能补造研究事实。

开发验证：

```sh
NODE_OPTIONS=--max-old-space-size=6144 pnpm check
pnpm --filter @lancer/desktop build
```

内部包名 `@lancer/*`、协议字段和既有数据位置为兼容保留，界面产品名为 TEAM。旧 Lancer 数据继续位于原应用数据目录的 `Lancer` 子目录；新名称不会自动迁移或清空原课题。不要手工删除旧目录。

默认本地更新仍要求持久签名证书；macOS 正式发布需要 Developer ID 和公证；当前是明确选择的未公证测试分发，不会在签名失败时悄悄降级。源码启动与打包流程见安装文档。

## 边界与来源

- 引导式研讨的提问质量、语义重复与真实模型表现仍需用户验证。程序限制同版一个待答问题、重复提交与过期回答；讨论摘要不代表指令已落实。
- Word 的目录为静态跳转；复杂公式、图片和期刊排版有局限。归档导入不是原会话恢复，不自动执行随包程序。
- 本发布没有替用户运行 18 次真实协作对照，也不宣称协作必然提速。Windows/Linux 和原生安装能力按实际验证状态使用。
- TEAM 基于 [Lancer](https://github.com/raylee-ai/lancer)、[pi-gui](https://github.com/minghinmatthewlam/pi-gui) 和 [Pi](https://github.com/earendil-works/pi)。保留 MIT 许可和来源声明，见 [NOTICE](NOTICE)。
- CYZ 及其他随附指导资源有独立许可（包括 CC BY-NC 4.0 内容），没有统一改授 MIT；见资源目录的 LICENSE、THIRD_PARTY_NOTICES 和 [第三方说明](docs/third-party-dependencies.md)。

公开仓库不包含开发者账号、课题、会话、原稿、课程库、更新备份或失败现场。项目不是已有 `cyz-research-workbench`（Codex Windows 工作台）的升级包，两者分别维护。
