import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateResearchData } from "../../electron/research-group/analysis";
import {
  isPublicResearchAddress,
  openResearchEvidence,
  readPinnedResearchFile,
} from "../../electron/research-group/materials";
import { writeResearchStudyFixture } from "../helpers/research-study-fixture";

test("CSV statistics use the actual rows, sample deviation and explicit complete-case handling", () => {
  const csv = '\uFEFF"x","y"\r\n1,3\r\n2,5\r\n3,7\r\n4,9\r\nNA,11\r\n';
  const result = calculateResearchData(csv, ",", {
    datasetId: "d",
    method: "ols",
    columns: ["x"],
    outcome: "y",
  });
  expect(result).toMatchObject({
    totalRows: 5,
    completeRows: 4,
    excludedRows: 1,
    descriptive: { x: { n: 4, missing: 1, mean: 2.5, median: 2.5 }, y: { n: 5, mean: 7 } },
    regression: { sampleSize: 4, residualDf: 2, rSquared: 1 },
  });
  const coefficients = (result.regression as { coefficients: Record<string, number> }).coefficients;
  expect(coefficients.intercept).toBeCloseTo(1, 12);
  expect(coefficients.x).toBeCloseTo(2, 12);
  const correlation = calculateResearchData(csv, ",", {
    datasetId: "d",
    method: "correlation",
    columns: ["x", "y"],
  });
  expect((correlation.correlations as Record<string, Record<string, number>>).x!.y).toBeCloseTo(
    1,
    12,
  );
  const large = calculateResearchData("x,y\n1e90,2e90\n2e90,4e90\n3e90,6e90", ",", {
    datasetId: "large",
    method: "correlation",
    columns: ["x", "y"],
  });
  expect((large.correlations as Record<string, Record<string, number>>).x!.y).toBeCloseTo(1, 12);
});
test("analysis rejects malformed rows, unsupported values and singular predictors", () => {
  expect(() =>
    calculateResearchData("intercept,y\n1,3\n2,5\n3,7", ",", {
      datasetId: "reserved",
      method: "ols",
      columns: ["intercept"],
      outcome: "y",
    }),
  ).toThrow("保留名称");
  const spec = { datasetId: "d", method: "ols" as const, columns: ["x", "z"], outcome: "y" };
  expect(() => calculateResearchData("x,z,y\n1,2,3\n2,4,5\n3,6,7\n4,8,9", ",", spec)).toThrow(
    "共线",
  );
  expect(() => calculateResearchData("x,y\n1,2,3", ",", { ...spec, columns: ["x"] })).toThrow(
    "完整行",
  );
  expect(() =>
    calculateResearchData("x,y\n1,2\n2,text\n3,4", ",", { ...spec, columns: ["x"] }),
  ).toThrow("非数值");
  expect(() => calculateResearchData('x,y\n"1,2', ",", { ...spec, columns: ["x"] })).toThrow(
    "引号",
  );
});
test("research material pins preserve source bytes and reject changes or a symlink outside the chosen directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-materials-"));
  await writeResearchStudyFixture(directory);
  const pin = await openResearchEvidence(directory),
    source = pin.sources[0]!;
  const original = await readFile(source.file);
  expect(await readPinnedResearchFile(source)).toContain("合成研究");
  expect(await readFile(source.file)).toEqual(original);
  await writeFile(source.file, "changed");
  await expect(readPinnedResearchFile(source)).rejects.toThrow("已变化");
  const outside = join(await mkdtemp(join(tmpdir(), "research-outside-")), "private.txt");
  await writeFile(outside, "outside");
  await symlink(outside, join(directory, "linked.txt"));
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    sources: { file: string }[];
  };
  manifest.sources[0]!.file = "linked.txt";
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await expect(openResearchEvidence(directory)).rejects.toThrow("不能越界");
});

test("research retrieval permits public destinations and rejects private, reserved and mapped addresses", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "172.31.2.3",
    "192.168.2.3",
    "198.18.1.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    expect(isPublicResearchAddress(address)).toBe(false);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    expect(isPublicResearchAddress(address)).toBe(true);
});
