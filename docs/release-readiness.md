# Local collaboration build

Updated: 2026-11-05. The removed business modules are documented in [feature-removal.md](feature-removal.md). This is a local preparation checklist, not a published release announcement. The owner will supply the GitHub repository address separately. Do not upload local history or publish a release until the candidate and destination are reviewed.

## What must pass

- Fresh source checkout: Node >=22.19.0 <26, pnpm 10.34.9, frozen install, `pnpm run doctor`, `pnpm check`, `pnpm build`.
- Security: `pnpm audit:dependencies` has no high/critical advisories across runtime and build dependencies; renderer and extension-frame boundary tests pass.
- Conversations: new workspace selection, send/stream, model/thinking selection, stop, switching, drafts, archive/restore and restart.
- Parallel work: parent → child → grandchild, concurrent progress, completion and returned files; verify failure and admission-limit behavior.
- UI: keep conversation bubbles, blue running borders and matching GitTree light paths. Profile on a foreground window; record hardware and distinguish display refresh timing from CPU long frames.
- Doubao: fixed conversation identity, partial-history order, no unconfirmed automatic resend. Fixture proof does not prove compatibility with the installed native App.
- Package: launch the exact signed candidate, create a conversation, verify native helpers from a working directory outside the source checkout. Source-run tests alone are insufficient.

## Parallel limits

Defaults are 8 unfinished child branches across the app, depth 4 below a root conversation, and 32 total child/grandchild records per task tree. Pending creations reserve capacity before asynchronous work begins. Existing sessions are not deleted when a limit is reached. Independent root conversations have independent tree counts.

Set positive integer environment variables to override: `LANCER_MAX_CONCURRENT_BRANCHES` (up to 64), `LANCER_MAX_BRANCH_DEPTH` (up to 16), `LANCER_MAX_TREE_BRANCHES` (up to 256), `LANCER_MAX_TREE_TOKENS` (default 500000, up to 100000000).

The token check is an **admission limit based on currently loaded provider-reported usage**, including input, output and cache tokens. It blocks new composer submissions and new branch requests once the known total reaches the threshold. It is not a billing cap: in-flight requests, previously queued turns, provider-internal tool loops and unloaded history can exceed it. Do not describe it as a guaranteed maximum cost. Hard runtime budgeting and write-isolated automatic branches remain separate work.

## Public source and assets

`pnpm export:source /absolute/new/folder` exports current source with a hash manifest. It excludes `.git`, `.lancer-task`, local agent settings, known credential/signing files and generated build/test directories. It does not remove anything from the working checkout. Review the manifest, run checks from the export and perform a separate secret scan before publishing. The export is a candidate, not certification of a clean Git history.

Package a pristine export with `pnpm package:source /absolute/source-export /absolute/new-source.tar.gz`. This also supports the independent Light UI export. It verifies every listed file and rejects additional files before writing; archive ownership and timestamps are anonymous. Do not use a normal archive of the development directory. Check actual local API/OAuth values, private gateway URLs and saved account/session identifiers against the final package offline, without logging their values. Review screenshot/video content and metadata as well as source text. Existing local configuration and history stay on the owner's machine.

Remaining publication decisions:

- Repository URL, issue/security reporting channel and branch protection.
- The owner supplied the new App icon on 2026-10-30. Default assistant portraits now use the new icon and authored neutral SVG glyphs; old character artwork is retained privately. See `apps/desktop/resources/brand/README.md` for provenance. User-provided future portraits require the same asset review.
- The website now uses a current Electron capture with explicitly synthetic test conversations. Upstream media remain only with the preserved upstream documentation, not as Lancer product proof.
- Public Developer ID/notarization credentials, or an explicitly source-only first release. Local persistent signing is not public notarization.
- A clean-machine install and platform-specific native validation; Linux/Windows package configurations alone are not proof.

The source retains the upstream MIT license and attribution. Reference videos, Fate materials, downloaded files and private test recordings are not release assets.

## Website configuration

Build with `NEXT_PUBLIC_LANCER_GITHUB_URL=https://github.com/OWNER/REPO` and `NEXT_PUBLIC_LANCER_SITE_URL=https://YOUR_DOMAIN` after those destinations exist. Only set `NEXT_PUBLIC_LANCER_RELEASES_AVAILABLE=true` when release artifacts are actually available. An unconfigured preview disables indexing and offers release status instead of upstream downloads.

## 从源码包构建安装包

源码包不含 Git 历史，也不预填私人仓库地址。GitHub Actions 自动使用当前仓库 URL。
本地构建 Linux 安装包前设置 `LANCER_REPOSITORY_URL=https://github.com/你的账号/你的仓库`（替换成实际地址）；其他平台也可设置它来填入安装包元数据。
地址未确定时可以完成源码安装、检查、开发启动和 macOS 本地验证，不能把上游 pi-gui 地址填作 Lancer 下载来源。
