# TEAM 1.1.0-beta.2 · macOS 安装测试版

TEAM 是基于 Pi 的科研辅助工具，保留导师、A、B、资料员和用户作为最终决策者的协作方式。本版首次提供无需开发环境的 macOS Apple Silicon 安装包。

## 下载

- **M 系列 Mac：**下载 `TEAM-1.1.0-beta.2-arm64-preview.dmg`，打开后把 TEAM.app 拖入 Applications。
- **备用：**同版 ZIP，解压后把 TEAM.app 放入应用程序。
- 最低系统目标 **macOS 13**；Intel 版暂未提供。源码和 SHA256SUMS 随版本发布。
- [逐步安装、已有数据与首次打开说明](https://github.com/chengyingzh433-stack/TEAM/blob/main/docs/team-macos-install.md)。

## 包含内容

- Electron 43.8.4／Node 24.22.1、Pi SDK 1.4.0、生产依赖和原生 helper。
- 固定版本 rg 15.2.0、fd 10.5.2 及许可，避免基础搜索首次使用时临时下载工具。
- 不要求用户安装 Node、pnpm、Xcode、Homebrew 或全局 Pi；不自动修改全局 Pi、shell 或账号。
- 账号、API Key 和模型由用户在“模型与账号”里配置。研究数据、原稿、课程正文、个人认证与会话不随包分发。
- 原 Lancer 数据目录继续使用，已有课题不自动迁移／清理；原引导式研讨、稿件与证据、Word 导出、归档和恢复能力保留。

## 必须了解的测试状态

**此包未经过 Apple Developer ID 签名和公证。** ad-hoc 技术签名只用于包完整性，不能代表 Apple 验证。首次下载打开可能被 macOS 阻止，确认来源后按安装说明中的 Apple 官方流程处理；受管理设备不保证可以运行。没有自动关闭 Gatekeeper 或清除隔离属性。

代码／存储、格式、lint、架构、类型检查通过；desktop Node 单元检查 **956 passed／1 个既有平台 skip**。桌面构建、包内依赖版本图与工作流／许可资源、签名完整性、DMG 只读挂载及内容核对通过。30 个 Mach-O 文件的最低系统声明不高于 macOS 13，无需开发机的外部动态库。

额外使用应用自带 Node 模式、空账号、隔离 HOME 和仅系统命令 PATH，验证 Pi／提供商模块、原生终端模块、随包搜索工具可以加载；没有打开应用界面、实际安装到应用程序、请求真实模型或执行研究功能验收。macOS 13 实机、其他 M 系列设备及首次下载的 Gatekeeper 体验由用户测试，声明目标不等于逐系统实测。

GitHub Actions 继续暂停；以上为本地验证。用户功能和真实模型测试、18 次协作对照、完整新融合内容验收仍待执行。保留上游 MIT 和各工作流／第三方资源许可。
