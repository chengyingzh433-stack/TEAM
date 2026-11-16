import { randomUUID } from "node:crypto";
import type {
  ResearchM3Action,
  ResearchTaskScope,
  ResearchScopeFinding,
} from "../../contracts/research-m3";
import type { ResearchArtifact, ResearchProject } from "../../contracts/research-group";
import { readPinnedResearchFile, researchHash } from "./materials";

export function currentResearchTaskScope(p: ResearchProject): ResearchTaskScope | undefined {
  return p.m3?.scopes
    ?.filter(
      (s) =>
        s.revision === p.revision &&
        p.evidence?.sources.some(
          (source) => source.id === s.sourceId && source.sha256 === s.sourceSha256,
        ),
    )
    .at(-1);
}
export async function setResearchTaskScope(
  p: ResearchProject,
  input: Extract<ResearchM3Action, { operation: "task-scope" }>,
  at: string,
) {
  if (p.workflowVersion !== "fusion-v2" || !p.task || p.goal !== "task" || p.status === "running")
    throw new Error("请先暂停单项课题，再固定原稿、引用或章节范围。");
  const source = p.evidence?.sources.find(
    (s) => s.id === input.sourceId && s.sha256 === input.sourceSha256,
  );
  if (!source) throw new Error("任务范围所选材料不存在或已变版。");
  if (p.task.kind === "chapter-edit" && source.kind !== "manuscript")
    throw new Error("章节修改需要原稿材料。");
  const baseline = await readPinnedResearchFile(source);
  if (input.ranges.some((r) => r.end > baseline.length)) throw new Error("任务范围超出固定原文。");
  if (p.fusion?.attempts.some((a) => a.taskId.startsWith(`v${p.revision}:`)))
    throw new Error("本轮已执行过任务；改变范围请开始新输入版本，保留原范围和意见。");
  const scope: ResearchTaskScope = {
    id: randomUUID(),
    revision: p.revision,
    sourceId: source.id,
    sourceSha256: source.sha256,
    bodySha256: researchHash(baseline),
    baseline,
    ranges: structuredClone(input.ranges),
    at,
  };
  (p.m3 ??= {}).scopes ??= [];
  p.m3.scopes.push(scope);
  return scope;
}

export async function verifyResearchScopeSource(
  p: ResearchProject,
  sourceIds: unknown = [],
): Promise<void> {
  if (p.goal !== "task" || p.workflowVersion !== "fusion-v2") return;
  const scope = currentResearchTaskScope(p);
  const source = p.evidence?.sources.find((s) => s.id === scope?.sourceId);
  if (!scope || !source || researchHash(await readPinnedResearchFile(source)) !== scope.bodySha256)
    throw new Error("单项任务原稿缺失或已变版，请重新锁定当前输入。");
  if (Array.isArray(sourceIds))
    for (const id of sourceIds) {
      const source = p.evidence?.sources.find((s) => s.id === id);
      if (!source) throw new Error("单项报告的支持材料不存在。");
      await readPinnedResearchFile(source);
    }
}

/** The host composes the complete next draft. The model cannot write outside the selected ranges. */
export function composeResearchScopedText(scope: ResearchTaskScope, edits: unknown): string {
  if (!Array.isArray(edits) || !edits.length || edits.length > scope.ranges.length)
    throw new Error("章节修改需要明确的范围内替换。");
  const selected = edits
    .map((edit: unknown) => {
      if (
        !edit ||
        typeof edit !== "object" ||
        Array.isArray(edit) ||
        Object.keys(edit).some((k) => !["start", "end", "replacement"].includes(k))
      )
        throw new Error("章节替换字段无效。");
      const e = edit as { start: number; end: number; replacement: string };
      if (
        !Number.isSafeInteger(e.start) ||
        !Number.isSafeInteger(e.end) ||
        typeof e.replacement !== "string" ||
        !e.replacement.trim() ||
        e.replacement.length > 20000 ||
        !scope.ranges.some((r) => r.start === e.start && r.end === e.end)
      )
        throw new Error("只能替换用户选定的完整章节范围，不能改动其他正文。");
      return e;
    })
    .sort((a, b) => b.start - a.start);
  if (new Set(selected.map((e) => e.start)).size !== selected.length)
    throw new Error("同一范围不能替换两次。");
  return selected.reduce(
    (body, e) => body.slice(0, e.start) + e.replacement + body.slice(e.end),
    scope.baseline,
  );
}

export function assertResearchTaskPublication(
  p: ResearchProject,
  input: Record<string, unknown>,
): void {
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.goal !== "task" ||
    !p.task ||
    !["stage-draft", "stage-revision"].includes(String(input.kind))
  )
    return;
  const scope = currentResearchTaskScope(p);
  if (!scope) throw new Error("先由用户固定本轮原稿和实际引用／章节范围。");
  if (!Array.isArray(input.sourceIds) || !input.sourceIds.includes(scope.sourceId))
    throw new Error("单项交付必须引用本轮固定的对应稿件／目标材料。");
  if (p.task.kind === "chapter-edit") composeResearchScopedText(scope, input.scopeEdits);
  if (p.task.kind === "citations") assertResearchScopeFindings(scope, input.scopeFindings);
}

export function assertResearchScopeFindings(
  scope: ResearchTaskScope,
  value: unknown,
): asserts value is ResearchScopeFinding[] {
  if (!Array.isArray(value) || value.length !== scope.ranges.length)
    throw new Error("引用核查须逐项覆盖选定引用，不扩大到整稿。");
  const seen = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("引用核查结果无效。");
    const finding = item as { rangeIndex: number; conclusion: string; reason: string };
    if (
      Object.keys(finding).some((k) => !["rangeIndex", "conclusion", "reason"].includes(k)) ||
      !Number.isInteger(finding.rangeIndex) ||
      finding.rangeIndex < 0 ||
      finding.rangeIndex >= scope.ranges.length ||
      seen.has(finding.rangeIndex) ||
      !["supported", "partially-supported", "unsupported", "insufficient-material"].includes(
        finding.conclusion,
      ) ||
      typeof finding.reason !== "string" ||
      finding.reason.trim().length < 20 ||
      finding.reason.length > 12000
    )
      throw new Error("每条指定引用需要唯一范围编号、明确支持结论和具体理由。");
    seen.add(finding.rangeIndex);
  }
}

export function recordResearchScopedResult(
  p: ResearchProject,
  artifact: ResearchArtifact,
  input: Record<string, unknown>,
  at: string,
): void {
  if (
    p.goal !== "task" ||
    !p.task ||
    artifact.role !== "lead" ||
    !["stage-draft", "stage-revision"].includes(artifact.kind)
  )
    return;
  const scope = currentResearchTaskScope(p);
  if (!scope) throw new Error("章节范围已过期。");
  const fullText =
    p.task.kind === "chapter-edit"
      ? composeResearchScopedText(scope, input.scopeEdits)
      : artifact.content;
  if (fullText !== artifact.content)
    throw new Error("实际修改稿必须正是可供B读取和审阅的成果正文。");
  ((p.m3 ??= {}).results ??= []).push({
    id: randomUUID(),
    kind: p.task.kind,
    revision: p.revision,
    scopeId: scope.id,
    artifactId: artifact.id,
    artifactSha256: researchHash(artifact.content),
    sourcePins: [...new Set([scope.sourceId, ...(artifact.sourceIds ?? [])])].map((id) => {
      const source = p.evidence?.sources.find((s) => s.id === id);
      if (!source) throw new Error("单项结果来源缺失。");
      return { id, sha256: source.sha256 };
    }),
    analysisPins: (artifact.analysisIds ?? []).map((id) => {
      const run = p.analyses?.find((r) => r.id === id);
      if (!run) throw new Error("单项结果实际分析缺失。");
      return { id, sha256: run.sha256 };
    }),
    fullText,
    fullTextSha256: researchHash(fullText),
    edits: (p.task.kind === "chapter-edit" ? structuredClone(input.scopeEdits) : []) as {
      start: number;
      end: number;
      replacement: string;
    }[],
    ...(p.task.kind === "citations" ? { findings: structuredClone(artifact.scopeFindings) } : {}),
    at,
  });
}

/** The published/read/accepted body is the actual deliverable, including host-composed edits. */
export function scopedResearchPublicationContent(
  p: ResearchProject,
  input: Record<string, unknown>,
): string {
  const original = String(input.content);
  if (
    p.workflowVersion !== "fusion-v2" ||
    p.goal !== "task" ||
    !p.task ||
    !["stage-draft", "stage-revision"].includes(String(input.kind))
  )
    return original;
  assertResearchTaskPublication(p, input);
  const scope = currentResearchTaskScope(p)!;
  let body = original;
  if (p.task.kind === "chapter-edit") body = composeResearchScopedText(scope, input.scopeEdits);
  else if (p.task.kind === "citations") {
    const findings =
      input.scopeFindings as import("../../contracts/research-m3").ResearchScopeFinding[];
    const labels = {
      supported: "支持",
      "partially-supported": "部分支持",
      unsupported: "不支持",
      "insufficient-material": "材料不足，不能核验",
    };
    body +=
      "\n\n## 本轮指定引用的逐项核查记录\n" +
      findings
        .map((f) => {
          const range = scope.ranges[f.rangeIndex]!;
          return `\n### 引用 ${f.rangeIndex + 1}：${labels[f.conclusion]}\n原稿片段：${scope.baseline.slice(range.start, Math.min(range.end, range.start + 1000))}\n\n核查依据与局限：${f.reason}\n`;
        })
        .join("\n");
  }
  if (body.length > 300000) throw new Error("本次实际交付稿超过300000字符，请收窄范围。");
  return body;
}
