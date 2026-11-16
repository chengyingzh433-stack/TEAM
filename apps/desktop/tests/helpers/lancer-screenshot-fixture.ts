import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeGitWorkspace, seedProcessTimelineDemoFixture } from "./electron-app";

/** Every sidebar branch is a real checkout in the isolated fixture repository. */
export async function makeLancerScreenshotFixture(agentDir: string, userDataDir: string) {
  const repositoryPath = await makeGitWorkspace("Lancer");
  const branches = [
    "lancer-ui",
    "douyin-watch",
    "web-digest",
    "xhs-notes",
    "douyin-dl",
    "douyin-learn",
    "douyin-render",
    "web-collect",
    "motion-demo",
    "review",
    "xhs-cover",
  ];
  const paths: string[] = [];
  for (const branch of branches) {
    const path = join(userDataDir, "worktrees", "Lancer", branch);
    await mkdir(dirname(path), { recursive: true });
    await promisify(execFile)("git", [
      "-C",
      repositoryPath,
      "worktree",
      "add",
      "-b",
      `wt/${branch}`,
      path,
    ]);
    paths.push(await realpath(path));
  }
  const fixture = await seedProcessTimelineDemoFixture(agentDir, paths[0]!, {
    laneWorkspaces: { github: paths[1]!, paper: paths[2]!, chat: paths[3]! },
    extraSessions: [
      { zone: "github", title: "豆包 · 阅读项目说明", provider: "volcengine", model: "doubao" },
      {
        zone: "github",
        title: "Grok+Opus · 讨论沉淀学习",
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
      { zone: "github", title: "Codex · 验证示例项目", provider: "openai", model: "gpt-5" },
      { zone: "paper", title: "Grok · 检索论文来源", provider: "xai", model: "grok-3-mini" },
      { zone: "paper", title: "Codex · 实现动效 demo", provider: "openai", model: "gpt-5" },
      {
        zone: "lancer",
        title: "Opus · 审查：并发写入竞争",
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
      { zone: "chat", title: "Astra · 汇总待办事项", provider: "openai", model: "gpt-4o" },
    ].map((spec, index) => ({ ...spec, workspacePath: paths[index + 4]! })),
  });
  return {
    fixture,
    repositoryPath,
    workspacePath: paths[0]!,
    initialWorkspaces: [repositoryPath, ...paths],
  };
}
