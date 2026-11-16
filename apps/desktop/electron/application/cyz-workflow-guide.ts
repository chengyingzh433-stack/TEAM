import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatSharedResearchMethod,
  type SharedResearchMethodSnapshot,
} from "../../contracts/shared-research-method";
import {
  CYZ_GUIDE_PREFIX,
  type CyzGuideId,
  type CyzStageId,
} from "../../contracts/cyz-paper-workflow";

const STAGE_REFERENCES: Record<CyzStageId | "entry", readonly string[]> = {
  entry: ["project-protocol.md", "guided-mentor.md"],
  S0: ["idea-scout.md", "guided-mentor.md", "integrity-gates.md"],
  S1: ["idea-refinement.md", "guided-mentor.md", "integrity-gates.md"],
  S2: ["literature-workflow.md", "integrity-gates.md"],
  S3: ["literature-workflow.md", "pdf-reading.md", "integrity-gates.md"],
  S4: ["literature-workflow.md", "idea-refinement.md", "integrity-gates.md"],
  S5: ["education-research-methods.md", "guided-mentor.md", "integrity-gates.md"],
  S6: ["education-research-methods.md", "integrity-gates.md"],
  S7: ["paper-writing.md", "academic-humanization.md", "integrity-gates.md"],
  S8: ["integrity-gates.md", "academic-humanization.md", "project-protocol.md"],
};

/** Main-process-owned, allowlisted resources. No renderer-supplied paths or global skill installs. */
export async function loadCyzWorkflowGuide(
  root: string | undefined,
  guide: CyzGuideId | "entry",
  method?: SharedResearchMethodSnapshot,
): Promise<string> {
  if (!root) throw new Error("CYZ 研究指导资源未配置，无法载入任务。");
  const stage = guide === "entry" ? "entry" : (guide.slice(CYZ_GUIDE_PREFIX.length) as CyzStageId);
  const references = STAGE_REFERENCES[stage];
  if (!references) throw new Error("CYZ 研究阶段无效。");
  const files = ["cyz-lancer-guide.md", `cyz-stages/${stage}.md`];
  let contents: string[];
  try {
    contents = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")));
  } catch (error) {
    throw new Error("CYZ 研究指导资源缺失或不可读，请恢复应用资源后重试。", { cause: error });
  }
  return [
    `## CYZ 内置研究指导（${stage === "entry" ? "入口识别与项目续接" : stage}）`,
    method
      ? formatSharedResearchMethod(method)
      : "共享方法版本：此旧任务未登记快照；保留原阶段要求，不追补当前版本或虚构旧任务依据。",
    `当前平台：${process.platform}。执行下列 Lancer 专用说明；方法参考按需通过文件工具读取。参考原文中的 Skill 安装、宿主操作和全流程要求不能扩大当前任务。`,
    `资源根目录：${root}\n项目模板与脚本：${join(root, "cyz-edu-research")}\n中文语言指导：${join(root, "humanizer-zh", "SKILL.md")}\n英文语言指导：${join(root, "humanizer", "SKILL.md")}\n语言依赖锁：${join(root, "dependencies.lock.json")}`,
    ...contents.map((content, index) => `### 指导文件：${join(root, files[index]!)}\n${content}`),
    `## 方法参考（按需读取）\n仅在本轮需要相应方法细节时读取，按上面的范围和载体约定使用；无需逐篇展开或照搬原文流程。\n${references.map((name) => `- ${join(root, "cyz-edu-research", "references", name)}`).join("\n")}`,
    "本次仅推进用户要求的工作。后续阶段和关键学术决定须依据项目状态与用户选择；不因选中阶段、模型回复或子任务返回而自动标记质量关卡通过。",
  ].join("\n\n");
}
