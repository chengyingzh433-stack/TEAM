import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchProject } from "../../contracts/research-group";
import { researchHash } from "../../electron/research-group/materials";

export const evidenceObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface NativeCall {
  id: string;
  name: unknown;
  args: Record<string, unknown>;
  at: string;
  stage: string | null;
  attemptId: string | null;
  entryIndex: number;
  resultAt?: string;
  isError?: boolean;
  resultText?: string;
}

/** Only this run's isolated session files; no auth, provider execution or state mutation. */
export async function registeredAnalysisNativeEvidence(
  profile: string,
  project: ResearchProject,
  final = false,
) {
  const directory = join(profile, "agent", "sessions");
  const files = await readdir(directory, { recursive: true }).catch((error: unknown) => {
    if (evidenceObject(error).code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(
    project.members.map(async (member) => {
      const file = files.find((file) => file.endsWith(`_${member.ref.sessionId}.jsonl`));
      const entries: Record<string, unknown>[] = [],
        calls: NativeCall[] = [];
      if (file) {
        const lines = (await readFile(join(directory, file), "utf8")).split("\n");
        // A running process may be appending its last JSONL record. Never invent its completion.
        if (!final) lines.pop();
        for (const line of lines.filter((line) => line.trim())) {
          const entry = evidenceObject(JSON.parse(line)),
            message = evidenceObject(entry.message);
          const content = Array.isArray(message.content) ? message.content.map(evidenceObject) : [];
          entries.push(entry);
          for (const part of content)
            if (part.type === "toolCall" && typeof part.id === "string") {
              const at = String(entry.timestamp),
                attempt = (project.fusion?.attempts ?? [])
                  .filter((attempt) => {
                    const task = project.fusion!.tasks.find((task) => task.id === attempt.taskId);
                    return (
                      task?.role === member.role &&
                      Date.parse(attempt.dispatchedAt ?? attempt.preparedAt) <= Date.parse(at) &&
                      (!attempt.finishedAt || Date.parse(at) <= Date.parse(attempt.finishedAt))
                    );
                  })
                  .at(-1);
              calls.push({
                id: part.id,
                name: part.name,
                args: evidenceObject(part.arguments),
                at,
                stage:
                  project.fusion?.tasks.find((task) => task.id === attempt?.taskId)?.stage ?? null,
                attemptId: attempt?.id ?? null,
                entryIndex: entries.length - 1,
              });
            }
          if (message.role === "toolResult") {
            const call = calls.find((call) => call.id === message.toolCallId);
            if (call)
              Object.assign(call, {
                resultAt: String(entry.timestamp),
                isError: message.isError === true,
                resultText: content
                  .filter((part) => typeof part.text === "string")
                  .map((part) => String(part.text))
                  .join("\n"),
              });
          }
        }
      }
      return { role: member.role, ref: member.ref, file: file ?? null, calls, entries };
    }),
  );
}

/** Stage-specific terminal evidence; successor-stage cancellation cannot satisfy this predicate. */
export function registeredAnalysisStageBoundary(project: ResearchProject, stage: string) {
  const attempts = (project.fusion?.attempts ?? []).filter(
    (attempt) => project.fusion!.tasks.find((task) => task.id === attempt.taskId)?.stage === stage,
  );
  const unsettled = attempts.filter(
    (attempt) =>
      attempt.state !== "succeeded" ||
      !attempt.nativeRunId ||
      !project.events.some(
        (event) => event.type === "started" && event.runId === attempt.nativeRunId,
      ) ||
      !project.events.some(
        (event) => event.type === "finished" && event.runId === attempt.nativeRunId,
      ),
  );
  return {
    stage,
    naturalNativeEndObserved: attempts.length > 0 && unsettled.length === 0,
    attempts,
    unsettledAttemptIds: unsettled.map((attempt) => attempt.id),
    unknownUsageAttemptIds: attempts
      .filter((attempt) => attempt.usedTokens === undefined)
      .map((attempt) => attempt.id),
    usageBoundary:
      "Attempt deltas are provider-reported; absent usage stays unknown and is not a verified bill.",
  };
}

/** Independent, deliberately narrow oracle for the pinned public UCI file, not a model answer. */
export function publicUciNumericAudit(csv: string) {
  const rows = csv
    .trimEnd()
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(";")
        .map((cell) => (cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1) : cell)),
    );
  const header = rows.shift();
  if (
    !header ||
    rows.some((row) => row.length !== header.length || row.some((cell) => /[";\r\n]/.test(cell)))
  )
    throw new Error(
      "The pinned UCI oracle requires single-line records without embedded separators/quotes",
    );
  const variables = ["G1", "G2", "G3", "absences"];
  if (variables.some((name) => !header.includes(name)))
    throw new Error("Required UCI columns missing");
  const values = Object.fromEntries<number[]>(
    variables.map((name) => [
      name,
      rows.map((row) => {
        const cell = row[header.indexOf(name)]!;
        if (!cell.trim() || !Number.isFinite(Number(cell)))
          throw new Error("Pinned UCI required field is missing/non-numeric");
        return Number(cell);
      }),
    ]),
  );
  const n = rows.length,
    mean = (v: number[]) => v.reduce((sum, x) => sum + x, 0) / v.length;
  const descriptive = Object.fromEntries(
    variables.map((name) => {
      const v = [...values[name]!].sort((a, b) => a - b),
        m = mean(v);
      return [
        name,
        {
          n,
          missing: 0,
          mean: m,
          sd: Math.sqrt(v.reduce((sum, x) => sum + (x - m) ** 2, 0) / (n - 1)),
          median: (v[Math.floor((n - 1) / 2)]! + v[Math.floor(n / 2)]!) / 2,
          min: v[0]!,
          max: v.at(-1)!,
        },
      ];
    }),
  );
  // Closed-form centered cross-products, separate from the product's scaled QR algorithm.
  const y = values.G3!,
    my = mean(y),
    centered = (name: string) => values[name]!.map((v) => v - mean(values[name]!));
  const x = centered("G1"),
    z = centered("G2"),
    yy = y.map((v) => v - my);
  const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
  const xx = dot(x, x),
    zz = dot(z, z),
    xz = dot(x, z),
    xy = dot(x, yy),
    zy = dot(z, yy);
  const regression = (names: string[], slopes: number[]) => {
    const intercept =
      my - names.reduce((sum, name, i) => sum + mean(values[name]!) * slopes[i]!, 0);
    const sse = y.reduce(
      (sum, v, i) =>
        sum +
        (v - intercept - names.reduce((s, name, j) => s + values[name]![i]! * slopes[j]!, 0)) ** 2,
      0,
    );
    return {
      coefficients: {
        intercept,
        ...Object.fromEntries(names.map((name, i) => [name, slopes[i]!])),
      },
      rSquared: 1 - sse / dot(yy, yy),
      sampleSize: n,
      residualDf: n - names.length - 1,
      residualRmse: Math.sqrt(sse / (n - names.length - 1)),
    };
  };
  const determinant = xx * zz - xz * xz;
  if (!(determinant > 0)) throw new Error("The pinned two-predictor oracle is singular");
  return {
    originalRows: n,
    columnCount: header.length,
    sourceLines: rows.map((_, i) => i + 2),
    zeroG3SourceLines: values.G3!.flatMap((value, i) => (value === 0 ? [i + 2] : [])),
    originalCellsSha256: researchHash(JSON.stringify([header, ...rows])),
    descriptive,
    primary: regression(["G1"], [xy / xx]),
    comparison: regression(
      ["G1", "G2"],
      [(xy * zz - zy * xz) / determinant, (zy * xx - xy * xz) / determinant],
    ),
    boundary:
      "Offline test oracle only; not supplied to providers, not an additional registered run, and not independent scientific review.",
  };
}
