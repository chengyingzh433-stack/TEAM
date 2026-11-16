import type { LancerModule } from "./lancer-modules";
import { CYZ_PAPER_MODULE_ID } from "./cyz-paper-workflow";
import { RESEARCH_GROUP_ZONE } from "./research-group";
/** Explicit conversation modes shared by sidebar, workflows and local control. */

export interface LancerSessionZone {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly relay: readonly LancerRelayModel[];
}

export interface LancerRelayModel {
  readonly provider: string;
  readonly modelId: string;
  readonly label: string;
}

const CODEX = { provider: "openai", modelId: "gpt-5", label: "Codex" };
const OPUS = { provider: "anthropic", modelId: "claude-opus-4-5", label: "Claude Opus" };
export const LANCER_SESSION_ZONES: readonly LancerSessionZone[] = [
  { id: "chat", label: "常态会话", color: "#64748B", relay: [] },
  { id: "paper", label: "论文查询", color: "#0891B2", relay: [] },
  { id: "github", label: "GitHub 研究", color: "#D97706", relay: [] },
  { id: "lancer", label: "TEAM", color: "#10B981", relay: [CODEX, OPUS] },
  { id: CYZ_PAPER_MODULE_ID, label: "CYZ 论文工作台", color: "#0F766E", relay: [] },
  { id: RESEARCH_GROUP_ZONE, label: "教育研究课题组", color: "#4F6B57", relay: [] },
];

const ZONE_PREFIX = /^lancer-zone:([a-z0-9_-]+)\|/i;

/** Legacy identifiers are recognized only to preserve access to old conversations. */
export function isRetiredLancerZone(id: string | undefined): boolean {
  return id === "video" || id === "research" || id === "xhs";
}

/** Only an explicit module tag makes a conversation modular. Discussing a video
 * or paper in ordinary chat must not silently change its mode. */
export function conversationZoneId(title: string, modules?: readonly LancerModule[]): string {
  const id = ZONE_PREFIX.exec(title.trim())?.[1]?.toLowerCase();
  if (isRetiredLancerZone(id)) return "chat";
  if (modules) return modules.some((module) => module.id === id && !module.deleted) ? id! : "chat";
  return id &&
    (LANCER_SESSION_ZONES.some((zone) => zone.id === id) || /^module-[a-z0-9-]+$/.test(id))
    ? id
    : "chat";
}

export function stripLancerZonePrefix(title: string): string {
  return title.replace(ZONE_PREFIX, "").trim();
}

export function lancerZoneById(zoneId: string): LancerSessionZone {
  return LANCER_SESSION_ZONES.find((zone) => zone.id === zoneId) ?? LANCER_SESSION_ZONES[0]!;
}

export function formatSessionTitleForZone(zoneId: string, title: string): string {
  const stripped = stripLancerZonePrefix(title);
  return `lancer-zone:${zoneId}|${stripped}`;
}
