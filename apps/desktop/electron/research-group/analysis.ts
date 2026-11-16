import type { ResearchAnalysisSpec } from "../../contracts/research-evidence";

export const RESEARCH_ANALYSIS_ENGINE = "csv-quantitative-1";

/** Self-contained so the exact executed algorithm can be exported as a replay script. */
export function calculateResearchData(
  csv: string,
  delimiter: string,
  spec: ResearchAnalysisSpec,
): Record<string, unknown> {
  if (![",", ";", "\t"].includes(delimiter)) throw new Error("不支持此分隔符。");
  csv = csv.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]!;
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (!field && !closed) quoted = true;
      else throw new Error("CSV 引号位置无效。");
    } else if (c === delimiter && !quoted) {
      row.push(field);
      field = "";
      closed = false;
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else if (closed) {
      if (c.trim()) throw new Error("CSV 引号结束后含有多余字符。");
    } else field += c;
  }
  if (quoted) throw new Error("CSV 引号未闭合。");
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  const header = rows.shift()?.map((s, i) => (i ? s : s.replace(/^\uFEFF/, "")).trim());
  if (
    !header?.length ||
    header.length > 200 ||
    header.some((v) => !v) ||
    new Set(header).size !== header.length ||
    !rows.length ||
    rows.length > 50_000 ||
    rows.some((r) => r.length !== header.length)
  )
    throw new Error("CSV 需要唯一列名、完整行，且为 1–50000 行、最多 200 列。");
  if (
    !["describe", "correlation", "ols"].includes(spec.method) ||
    !Array.isArray(spec.columns) ||
    !spec.columns.length ||
    spec.columns.length > 12 ||
    new Set(spec.columns).size !== spec.columns.length
  )
    throw new Error("分析方法或变量无效，最多选择 12 个不同变量。");
  const names = [...new Set([...spec.columns, ...(spec.outcome ? [spec.outcome] : [])])];
  if (names.some((n) => !header.includes(n))) throw new Error("分析变量不在数据表中。");
  if (spec.method === "ols" && spec.columns.includes("intercept"))
    throw new Error("intercept 为回归截距的保留名称，请先明确重命名该数据列。");
  const numeric = (s: string): number | null => {
    if (!s.trim() || /^(NA|N\/A|null)$/i.test(s.trim())) return null;
    const value = Number(s);
    if (
      !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim()) ||
      !Number.isFinite(value) ||
      Math.abs(value) > 1e100
    )
      throw new Error("所选变量含非数值或无穷值；请先确定编码，不能自动猜测。");
    return value;
  };
  const columns = Object.fromEntries(
    names.map((n) => [n, rows.map((r) => numeric(r[header.indexOf(n)]!))]),
  );
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const summary = (n: string) => {
    const values = columns[n]!.filter((v): v is number => v !== null).sort((a, b) => a - b),
      count = values.length;
    if (!count)
      return {
        n: 0,
        missing: rows.length,
        mean: null,
        sd: null,
        median: null,
        min: null,
        max: null,
      };
    const m = mean(values);
    return {
      n: count,
      missing: rows.length - count,
      mean: m,
      sd: count > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (count - 1)) : null,
      median: (values[Math.floor((count - 1) / 2)]! + values[Math.floor(count / 2)]!) / 2,
      min: values[0],
      max: values.at(-1),
    };
  };
  const complete = rows.map((_, i) => i).filter((i) => names.every((n) => columns[n]![i] !== null));
  const result: Record<string, unknown> = {
    method: spec.method,
    totalRows: rows.length,
    completeRows: complete.length,
    excludedRows: rows.length - complete.length,
    descriptive: Object.fromEntries(names.map((n) => [n, summary(n)])),
    notes: [
      "空值、NA、N/A、null 视为缺失；相关/回归按所选变量完整案例计算，描述统计逐变量计算。",
      "不提供 p 值、显著性或因果识别；变量编码、选择偏差与模型假设须由研究者审阅。",
    ],
  };
  if (spec.method === "describe") return result;
  if (complete.length < 3) throw new Error("完整案例不足 3 行。");
  const values = (n: string) => complete.map((i) => columns[n]![i]!);
  const correlation = (x: number[], y: number[]) => {
    const mx = mean(x),
      my = mean(y),
      xx = x.reduce((s, v) => s + (v - mx) ** 2, 0),
      yy = y.reduce((s, v) => s + (v - my) ** 2, 0);
    return xx && yy
      ? Math.max(
          -1,
          Math.min(
            1,
            x.reduce((s, v, i) => s + (v - mx) * (y[i]! - my), 0) / (Math.sqrt(xx) * Math.sqrt(yy)),
          ),
        )
      : null;
  };
  if (spec.method === "correlation") {
    result.correlations = Object.fromEntries(
      names.map((x) => [
        x,
        Object.fromEntries(names.map((y) => [y, correlation(values(x), values(y))])),
      ]),
    );
    return result;
  }
  if (
    !spec.outcome ||
    spec.columns.includes(spec.outcome) ||
    complete.length <= spec.columns.length + 1
  )
    throw new Error("回归需单独指定因变量、不同自变量和充分完整案例。");
  // Center/scale predictors, then modified Gram-Schmidt with reorthogonalization.
  const xs = spec.columns.map(values),
    means = xs.map(mean),
    scales = xs.map((v, j) =>
      Math.sqrt(v.reduce((s, x) => s + (x - means[j]!) ** 2, 0) / v.length),
    );
  if (scales.some((v) => v < 1e-12)) throw new Error("回归自变量为常数，无法估计。");
  const design = [
      complete.map(() => 1),
      ...xs.map((v, j) => v.map((x) => (x - means[j]!) / scales[j]!)),
    ],
    q: number[][] = [],
    r = design.map(() => design.map(() => 0)),
    y = values(spec.outcome);
  for (let j = 0; j < design.length; j++) {
    const v = [...design[j]!];
    for (let pass = 0; pass < 2; pass++)
      for (let k = 0; k < j; k++) {
        const dot = q[k]!.reduce((s, x, i) => s + x * v[i]!, 0);
        r[k]![j]! += dot;
        for (let i = 0; i < v.length; i++) v[i]! -= dot * q[k]![i]!;
      }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-8 * Math.sqrt(complete.length))
      throw new Error("自变量共线或数值不稳定，拒绝输出回归系数。");
    r[j]![j] = norm;
    q.push(v.map((x) => x / norm));
  }
  const beta = q.map((v) => v.reduce((s, x, i) => s + x * y[i]!, 0));
  for (let j = beta.length - 1; j >= 0; j--) {
    for (let k = j + 1; k < beta.length; k++) beta[j]! -= r[j]![k]! * beta[k]!;
    beta[j]! /= r[j]![j]!;
  }
  const slopes = beta.slice(1).map((b, j) => b / scales[j]!),
    intercept = beta[0]! - slopes.reduce((s, b, j) => s + b * means[j]!, 0),
    predicted = complete.map(
      (_, i) => intercept + slopes.reduce((s, b, j) => s + b * xs[j]![i]!, 0),
    ),
    sse = y.reduce((s, v, i) => s + (v - predicted[i]!) ** 2, 0),
    my = mean(y),
    sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  result.regression = {
    outcome: spec.outcome,
    coefficients: { intercept, ...Object.fromEntries(spec.columns.map((n, j) => [n, slopes[j]])) },
    rSquared: sst ? 1 - sse / sst : null,
    residualDf: complete.length - beta.length,
    residualRmse: Math.sqrt(sse / (complete.length - beta.length)),
    sampleSize: complete.length,
  };
  if (JSON.stringify(result).includes("null") && !sst)
    (result.notes as string[]).push("因变量没有变异，R² 未定义。");
  return result;
}
