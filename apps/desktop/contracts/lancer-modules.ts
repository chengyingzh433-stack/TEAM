import {
  LANCER_SESSION_ZONES,
  conversationZoneId,
  isRetiredLancerZone,
  type LancerSessionZone,
} from "./lancer-zones";
import { decodeLancerWorkflow, type LancerWorkflow } from "./lancer-workflows";
import { CYZ_PAPER_MODULE_ID, CYZ_PAPER_WORKFLOW } from "./cyz-paper-workflow";
import { RESEARCH_GROUP_ZONE } from "./research-group";

export interface LancerModule {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly description: string;
  readonly workflow?: LancerWorkflow;
  readonly deleted?: boolean;
}
export const DEFAULT_LANCER_MODULES: readonly LancerModule[] = LANCER_SESSION_ZONES.filter(
  (zone) => zone.id !== "chat",
).map(({ id, label, color }) => ({
  id,
  label: id === "lancer" ? "TEAM 自举" : label,
  color,
  description: "",
  ...(id === CYZ_PAPER_MODULE_ID
    ? {
        description:
          "教育研究九阶段：选题、文献、研究设计、数据分析、写作与全文审查。支持项目续接和证据核查。",
        workflow: CYZ_PAPER_WORKFLOW,
      }
    : {}),
}));

/** Add the new built-in once while preserving customized or explicitly deleted copies. */
export function includeCyzPaperModule(modules: readonly LancerModule[]): readonly LancerModule[] {
  return modules.some((module) => module.id === CYZ_PAPER_MODULE_ID)
    ? modules
    : [...modules, DEFAULT_LANCER_MODULES.find((module) => module.id === CYZ_PAPER_MODULE_ID)!];
}

export function includeResearchGroupModule(
  modules: readonly LancerModule[],
): readonly LancerModule[] {
  return modules.some((module) => module.id === RESEARCH_GROUP_ZONE)
    ? modules
    : [
        ...modules,
        {
          ...DEFAULT_LANCER_MODULES.find((module) => module.id === RESEARCH_GROUP_ZONE)!,
          description:
            "导师、推进研究者、复核研究者和资料员独立会话协作；贯通问题打磨、方案审阅、文献综合、研究设计、数据分析、论文写作与全文审阅。",
        },
      ];
}

export function moduleZones(
  modules: readonly LancerModule[] = DEFAULT_LANCER_MODULES,
): readonly LancerSessionZone[] {
  return [
    LANCER_SESSION_ZONES[0]!,
    ...modules
      .filter((module) => !module.deleted && !isRetiredLancerZone(module.id))
      .map((module) => ({ ...module, relay: [] })),
  ];
}
export function decodeLancerModule(value: unknown): LancerModule {
  const module = value as LancerModule;
  if (
    !module ||
    typeof module.id !== "string" ||
    !/^[a-z0-9_-]{1,60}$/.test(module.id) ||
    module.id === "chat"
  )
    throw new Error("无效模块标识。");
  if (typeof module.label !== "string" || !module.label.trim() || module.label.length > 40)
    throw new Error("模块名称需要 1–40 字。");
  if (typeof module.color !== "string" || !/^#[0-9a-f]{6}$/i.test(module.color))
    throw new Error("请选择模块颜色。");
  if (typeof module.description !== "string" || module.description.length > 1000)
    throw new Error("模块说明最多 1000 字。");
  if (module.deleted !== undefined && typeof module.deleted !== "boolean")
    throw new Error("无效模块状态。");
  const workflow = module.workflow ? decodeLancerWorkflow(module.workflow) : undefined;
  return {
    id: module.id,
    label: module.label.trim(),
    color: module.color,
    description: module.description.trim(),
    ...(workflow
      ? {
          workflow: {
            steps: workflow.steps,
            ...(workflow.method ? { method: workflow.method } : {}),
          },
        }
      : {}),
    ...(module.deleted ? { deleted: true } : {}),
  };
}

export function conversationModule(
  title: string,
  state?: { readonly modules?: readonly LancerModule[] },
): LancerSessionZone {
  return (
    moduleZones(state?.modules).find(
      (zone) => zone.id === conversationZoneId(title, state?.modules),
    ) ?? LANCER_SESSION_ZONES[0]!
  );
}
