import {
  languageObject,
  languageText,
  type ResearchLanguageArtifact,
  type ResearchLanguageAuthorization,
  type ResearchLanguageFrozenAnchor,
  type ResearchLanguageRange,
  type ResearchLanguageActualRead,
  type ResearchLanguageActor,
} from "./research-language-revisions";

export const RESEARCH_LANGUAGE_OPERATIONS = [
  "language-context",
  "language-register",
  "language-read",
  "language-review",
  "language-check",
  "language-not-applicable",
] as const;
export interface ResearchLanguageScope {
  id: string;
  revision: number;
  baseline: ResearchLanguageArtifact;
  authorization: ResearchLanguageAuthorization;
  ranges: ResearchLanguageRange[];
  frozenAnchors: ResearchLanguageFrozenAnchor[];
}
export interface ResearchLanguageHostRead extends ResearchLanguageActualRead {
  taskId: string;
  taskVersion: number;
  callId: string;
}
export interface ResearchLanguageDisposition {
  id: string;
  artifactId: string;
  bodySha256: string;
  at: string;
  actor: ResearchLanguageActor;
  reason: string;
  classification: "not-applicable";
}
export interface ResearchLanguageSelection {
  baselineId: string;
  bodySha256: string;
  rangeIds: string[];
  frozenTerms: string[];
}
/** A later actual user selection narrows an earlier general writing authorization. */
export function latestResearchLanguageSelection(
  project: {
    revision: number;
    languageScopes?: readonly ResearchLanguageScope[];
    artifacts: readonly { id: string; stage?: string }[];
  },
  stage: string | undefined,
): ResearchLanguageScope | undefined {
  return project.languageScopes
    ?.filter(
      (scope) =>
        scope.revision === project.revision &&
        scope.authorization.kind === "explicit-user-selection" &&
        project.artifacts.some(
          (artifact) => artifact.id === scope.baseline.id && artifact.stage === stage,
        ),
    )
    .at(-1);
}
export function researchLanguageParagraphs(body: string): ResearchLanguageRange[] {
  return [...body.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)].map((match, i) => ({
    id: `paragraph-${i + 1}`,
    label: `第 ${i + 1} 段`,
    start: match.index,
    end: match.index + match[0].length,
    exactText: match[0],
  }));
}
export function decodeResearchLanguageSelection(value: unknown): ResearchLanguageSelection {
  languageObject(value, ["baselineId", "bodySha256", "rangeIds", "frozenTerms"]);
  languageText(value.baselineId, 1024);
  if (typeof value.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.bodySha256))
    throw new Error("语言基线摘要无效。");
  for (const key of ["rangeIds", "frozenTerms"] as const) {
    if (!Array.isArray(value[key]) || value[key].length > 1000)
      throw new Error("语言范围或保护词清单无效。");
    value[key].forEach((text) => languageText(text, 1024));
    if (new Set(value[key]).size !== value[key].length) throw new Error("语言范围或保护词重复。");
  }
  if (!Array.isArray(value.rangeIds) || !value.rangeIds.length)
    throw new Error("请选定至少一段实际正文。");
  return structuredClone(value) as unknown as ResearchLanguageSelection;
}
