import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  researchPdfFixture,
  researchDocxFixture,
  researchXlsxFixture,
} from "../helpers/research-material-fixture";
import {
  RESEARCH_ROLES,
  type ResearchGroupsState,
  type ResearchProject,
} from "../../contracts/research-group";
import {
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  type DesktopHarness,
} from "../helpers/electron-app";

async function chooseFiles(harness: DesktopHarness, files: string[]): Promise<void> {
  // This proves picker-result handling in Electron (E), not native OS file selection (N).
  await harness.electronApp.evaluate(({ dialog }, filePaths) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths };
    };
  }, files);
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("Electron imports mixed candidate files, previews and adopts declared evidence without overwriting originals", async () => {
  test.setTimeout(120_000);
  const profile = await makeUserDataDir("research-material-ui-"),
    workspace = await makeWorkspace("research-material-ui"),
    agentDir = join(profile, "agent");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light" }),
  );
  const sessions: Awaited<ReturnType<typeof seedNamedTextSessionFixture>>[] = [];
  for (const role of RESEARCH_ROLES)
    sessions.push(
      await seedNamedTextSessionFixture(agentDir, workspace, {
        title: `lancer-zone:edu-research-group|材料接续 ${role}`,
        userText: "保留的旧课题输入（隔离测试记录）",
        assistantText: `保留的 ${role} 研究记录`,
      }),
    );
  const inputs = [
    join(workspace, "paper.txt"),
    join(workspace, "data.csv"),
    join(workspace, "bad.txt"),
    join(workspace, "text-layer.pdf"),
    join(workspace, "scan.pdf"),
    join(workspace, "notes.md"),
    join(workspace, "draft.docx"),
    join(workspace, "table.tsv"),
    join(workspace, "workbook.xlsx"),
    join(workspace, "wrong.csv"),
    join(workspace, "semicolon.csv"),
    join(workspace, "gbk.txt"),
    join(workspace, "other", "paper.txt"),
  ];
  await writeFile(
    inputs[0]!,
    "原文第一行：课堂反馈与学习表现存在关联。\n原文第二行：该关联不能直接解释为因果关系。\n",
  );
  await writeFile(inputs[1]!, "x,y\n1,3\n2,5\n3,7\n4,9\n");
  await writeFile(inputs[2]!, new Uint8Array([0xc3, 0x28]));
  const pdfText = "Electron PDF parsing marker.";
  await writeFile(inputs[3]!, researchPdfFixture(pdfText));
  await writeFile(inputs[4]!, researchPdfFixture());
  await writeFile(inputs[5]!, "# Markdown 原文\n保留 Markdown 第二行定位\n");
  await writeFile(inputs[6]!, researchDocxFixture());
  await writeFile(inputs[7]!, "x\ty\n1\t2\n3\t4\n");
  await writeFile(inputs[8]!, researchXlsxFixture());
  await writeFile(inputs[9]!, "x,y\n1,2,extra\n");
  await writeFile(inputs[10]!, "说明;\nx;y\n1;2\n3;4\n");
  await writeFile(inputs[11]!, new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]));
  await mkdir(join(workspace, "other"));
  await writeFile(inputs[12]!, "同名材料的不同正文，不覆盖首份 paper.txt。\n");
  const originals = await Promise.all(inputs.map((file) => readFile(file)));
  const launch = () =>
    launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [workspace],
      testMode: "background",
      scrubProviderEnv: true,
    });
  let harness = await launch();
  try {
    // Seed only a pre-existing completed project; all import/adoption mutations below use UI.
    let page = await harness.firstWindow();
    const initial = await getDesktopState(page);
    const workspaceId = initial.workspaces.find((item) =>
      item.sessions.some((session) => session.id === sessions[0]!.sessionId),
    )?.id;
    if (!workspaceId) throw new Error("Seeded research sessions were not discovered");
    await harness.close();
    const at = new Date().toISOString();
    const project: ResearchProject = {
      id: randomUUID(),
      root: { workspaceId, sessionId: sessions[0]!.sessionId },
      workspacePath: workspace,
      objective: "旧课题完成后导入材料并接续；测试输入不代表实际研究声明",
      revision: 1,
      status: "completed",
      createdAt: at,
      updatedAt: at,
      knowledge: { directory: workspace, sha256: "fixture", version: "isolated-fixture", count: 0 },
      scope: "proposal",
      currentStage: "review",
      members: RESEARCH_ROLES.map((role, i) => ({
        role,
        ref: { workspaceId, sessionId: sessions[i]!.sessionId },
        status: "idle",
      })),
      artifacts: [],
      packets: [],
      events: [],
    };
    const state: ResearchGroupsState = {
      version: 1,
      config: { knowledgeDir: workspace },
      projects: [project],
    };
    await writeFile(join(profile, "research-groups.json"), JSON.stringify(state));
    harness = await launch();
    page = await harness.firstWindow();
    await harness.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1480, 1000),
    );
    await page.getByRole("button", { name: "教育研究课题组", exact: true }).click();
    await page
      .locator(`.research-project[data-project-id="${project.id}"] .research-project__name`)
      .click();
    const panel = page.getByRole("region", { name: "教育研究课题组", exact: true });
    await expect(panel.getByRole("button", { name: "导入研究材料", exact: true })).toBeVisible();
    await chooseFiles(harness, inputs);
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    const current = async () =>
      (await getDesktopState(page)).researchGroups!.projects.find(
        (item) => item.id === project.id,
      )!;
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(inputs.length);
    await expect(
      panel.locator("summary").filter({ hasText: /^bad\.txt · 解析失败/ }),
    ).toBeVisible();
    expect((await current()).evidence?.sources ?? []).toHaveLength(0);
    const pdfSummary = panel.locator("summary").filter({ hasText: /^text-layer\.pdf · 部分可用/ });
    await expect(pdfSummary).toBeVisible();
    await pdfSummary.click();
    const pdfPreview = pdfSummary.locator("..");
    await expect(pdfPreview).toContainText("1 处可定位内容");
    await pdfPreview.getByText("位置与正文预览（前 8 处）", { exact: true }).click();
    await expect(pdfPreview.getByText("物理第 1 页", { exact: true })).toBeVisible();
    await expect(pdfPreview.getByText(pdfText, { exact: true })).toBeVisible();
    await expect(pdfPreview).toContainText("PDF 图表、公式与阅读顺序需对照原页核对");
    const importedPdf = (await current()).importedMaterials!.find(
      (item) => item.name === "text-layer.pdf",
    )!;
    expect(importedPdf.locations).toEqual([
      { kind: "page", locator: "page:1", page: 1, text: pdfText },
    ]);
    expect(importedPdf.original).toMatch(/\.pdf$/);
    const persistedPdf: unknown = JSON.parse(await readFile(importedPdf.parsed, "utf8"));
    expect(persistedPdf).toMatchObject({
      sha256: sha256(originals[3]!),
      locations: importedPdf.locations,
    });
    const scanSummary = panel.locator("summary").filter({ hasText: /^scan\.pdf · 待解析/ });
    await expect(scanSummary).toBeVisible();
    await scanSummary.click();
    const scanPreview = scanSummary.locator("..");
    await expect(scanPreview).toContainText("物理第 1 页没有可提取文字，需要 OCR");
    await expect(
      scanPreview.getByRole("button", { name: "查看上述影响并采用材料", exact: true }),
    ).toHaveCount(0);
    const scan = (await current()).importedMaterials!.find((item) => item.name === "scan.pdf")!;
    expect(scan.locations).toEqual([{ kind: "page", locator: "page:1", page: 1, text: "" }]);
    await page.screenshot({ path: test.info().outputPath("pdf-extraction-and-scan-limit.png") });
    const initialImports = (await current()).importedMaterials!;
    for (const [name, locator, expected] of [
      ["notes.md", "line:2", "保留 Markdown 第二行定位"],
      ["draft.docx", "paragraph:1", "DOCX 原文定位示例"],
      ["draft.docx", "table:1/row:2/cell:2", "需要原始证据"],
      ["table.tsv", "line:2", "1\t2"],
      ["workbook.xlsx", "成绩!B3", "2"],
    ]) {
      const item = initialImports.find((candidate) => candidate.name === name)!;
      expect(item.locations).toEqual(
        expect.arrayContaining([expect.objectContaining({ locator, text: expected })]),
      );
      const detail = panel.locator(`[data-material-id="${item.id}"]`);
      if (!(await detail.evaluate((element) => element.hasAttribute("open"))))
        await detail.locator(":scope > summary").click();
      const preview = detail.getByText("位置与正文预览（前 8 处）", { exact: true });
      if (!(await preview.locator("..").evaluate((element) => element.hasAttribute("open"))))
        await preview.click();
      const locationLabel = preview.locator("..").getByText(locator!, { exact: true });
      await expect(locationLabel).toBeVisible();
      await expect(locationLabel.locator("..").getByText(expected!, { exact: true })).toBeVisible();
    }
    const workbook = initialImports.find((item) => item.name === "workbook.xlsx")!;
    expect(workbook.tables.map((table) => table.name)).toEqual(["成绩", "说明"]);
    expect(workbook.warnings.join(" ")).toContain("缓存值未经重新计算");
    const wrong = initialImports.find((item) => item.name === "wrong.csv")!;
    expect(wrong.tables[0]?.rows[1]).toEqual(["1", "2", "extra"]);
    expect(wrong.tables[0]?.errors[0]?.row).toBe(2);
    const paperSummary = panel
      .locator("summary")
      .filter({ hasText: /^paper\.txt ·/ })
      .first();
    await paperSummary.click();
    const paper = paperSummary.locator("..");
    await paper
      .getByLabel("paper.txt 来源及提供说明", { exact: true })
      .fill("隔离 Electron 测试自行编制的定位文本，不是正式研究原文。");
    await paper.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect.poll(async () => (await current()).evidence?.sources.length).toBe(1);
    await expect(paperSummary).toContainText("已采用");
    const dataSummary = panel.locator("summary").filter({ hasText: /^data\.csv ·/ });
    await dataSummary.click();
    const data = dataSummary.locator("..");
    await data
      .locator("summary")
      .filter({ hasText: /^data\.csv：/ })
      .click();
    await expect(data.getByRole("columnheader", { name: "x", exact: true })).toBeVisible();
    await expect(data.getByRole("cell", { name: "9", exact: true })).toBeVisible();
    await data
      .getByLabel("data.csv 来源及提供说明", { exact: true })
      .fill("隔离测试人工合成数据，仅供界面及导入计算验证。");
    await expect(
      data.getByRole("button", { name: "查看上述影响并采用材料", exact: true }),
    ).toBeDisabled();
    await data.getByLabel("data.csv 材料性质", { exact: true }).selectOption("synthetic");
    await data.getByLabel("data.csv 使用依据", { exact: true }).selectOption("user-authorized");
    await data.getByRole("button", { name: "查看上述影响并采用材料", exact: true }).click();
    await expect.poll(async () => (await current()).evidence?.datasets.length).toBe(1);
    const adopted = await current();
    expect(adopted.evidence?.sources).toHaveLength(2);
    expect(adopted.evidence?.datasets[0]).toMatchObject({
      dataKind: "synthetic",
      permission: "user-authorized",
    });
    const dataImport = adopted.importedMaterials!.find((item) => item.name === "data.csv")!;
    expect(adopted.evidence?.datasets[0]?.materialImportId).toBe(dataImport.id);
    expect(await readFile(adopted.evidence!.datasets[0]!.file)).toEqual(originals[1]);
    await page.screenshot({ path: test.info().outputPath("materials-adopted.png") });
    await chooseFiles(harness, [inputs[0]!]);
    await panel.getByRole("button", { name: "导入研究材料", exact: true }).click();
    await expect
      .poll(async () => (await current()).importedMaterials?.length)
      .toBe(inputs.length + 1);
    const repeated = await current();
    const papers = repeated.importedMaterials!.filter((item) => item.name === "paper.txt");
    expect(papers[1]!.sha256).not.toBe(papers[0]!.sha256);
    expect(papers[1]!.original).not.toBe(papers[0]!.original);
    expect(papers[2]).toMatchObject({
      duplicate: true,
      sha256: papers[0]!.sha256,
      original: papers[0]!.original,
    });
    expect(papers[2]!.parsed).not.toBe(papers[0]!.parsed);
    expect(repeated.evidence).toEqual(adopted.evidence);
    for (let i = 0; i < inputs.length; i++) {
      expect(await readFile(inputs[i]!)).toEqual(originals[i]);
      const imported = repeated.importedMaterials!.find(
        (item) => item.name === basename(inputs[i]!) && item.sha256 === sha256(originals[i]!),
      )!;
      expect(sha256(await readFile(imported.original))).toBe(sha256(originals[i]!));
    }
    // Recover through actual controls. Each action appends a candidate; adopted evidence is stable.
    const recoveries = [
      { name: "gbk.txt", encoding: "gb18030", expected: "中文" },
      { name: "semicolon.csv", delimiter: ";", headerRow: "2" },
      { name: "workbook.xlsx", headerRow: "2", sheet: "成绩" },
    ];
    let count = repeated.importedMaterials!.length;
    for (const recovery of recoveries) {
      const original = initialImports.find((item) => item.name === recovery.name)!;
      const detail = panel.locator(`[data-material-id="${original.id}"]`);
      if (!(await detail.evaluate((element) => element.hasAttribute("open"))))
        await detail.locator(":scope > summary").click();
      await detail.getByText("处理解析问题或更新文件", { exact: true }).click();
      if (recovery.encoding)
        await detail
          .getByLabel(`${recovery.name} 解析编码`, { exact: true })
          .selectOption(recovery.encoding);
      if (recovery.delimiter)
        await detail
          .getByLabel(`${recovery.name} 解析分隔符`, { exact: true })
          .selectOption(recovery.delimiter);
      if (recovery.headerRow)
        await detail
          .getByLabel(`${recovery.name} 表头原行`, { exact: true })
          .fill(recovery.headerRow);
      if (recovery.sheet)
        await detail
          .getByLabel(`${recovery.name} 重新解析工作表`, { exact: true })
          .fill(recovery.sheet);
      await detail.getByRole("button", { name: "按所选设置重新解析", exact: true }).click();
      count++;
      await expect.poll(async () => (await current()).importedMaterials?.length).toBe(count);
      const fixed = (await current()).importedMaterials!.at(-1)!;
      expect(fixed.recovery).toMatchObject({ fromImportId: original.id, kind: "reparse" });
      expect(fixed.original).toBe(original.original);
      if (recovery.expected) expect(fixed.locations[0]?.text).toBe(recovery.expected);
      else expect(fixed.tables[0]).toMatchObject({ headers: ["x", "y"], headerRow: 2, errors: [] });
      if (recovery.sheet) expect(fixed.tables).toHaveLength(1);
    }
    const wrongDetail = panel.locator(`[data-material-id="${wrong.id}"]`);
    await wrongDetail.locator(":scope > summary").click();
    await wrongDetail.getByText("处理解析问题或更新文件", { exact: true }).click();
    const correctedFile = join(workspace, "corrected.csv");
    await writeFile(correctedFile, "x,y\n1,2\n");
    await chooseFiles(harness, [correctedFile]);
    await wrongDetail.getByRole("button", { name: "选择修正后的文件", exact: true }).click();
    count++;
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(count);
    expect((await current()).importedMaterials!.at(-1)).toMatchObject({
      name: "corrected.csv",
      recovery: { fromImportId: wrong.id, kind: "replace" },
    });
    await scanPreview.getByText("处理解析问题或更新文件", { exact: true }).click();
    await scanPreview.getByText("补入可定位的提取文本", { exact: true }).click();
    await scanPreview.getByLabel("scan.pdf 补入文本定位", { exact: true }).fill("page:1");
    await scanPreview
      .getByLabel("scan.pdf 补入提取文本", { exact: true })
      .fill("测试人员提供的第一页提取文本，不代表自动OCR已运行。");
    await scanPreview
      .getByLabel("scan.pdf 提取说明", { exact: true })
      .fill("测试模拟人工补入；原图未独立核验。");
    await scanPreview.getByRole("button", { name: "保存为新的定位文本版本", exact: true }).click();
    count++;
    await expect.poll(async () => (await current()).importedMaterials?.length).toBe(count);
    const recovered = await current();
    expect(recovered.importedMaterials!.at(-1)).toMatchObject({
      status: "partial",
      recovery: { kind: "supplement", fromImportId: scan.id },
    });
    expect(recovered.importedMaterials!.at(-1)!.warnings.join(" ")).toContain("尚未自动核验原图");
    expect(recovered.evidence).toEqual(adopted.evidence);
    expect(recovered.importedMaterials!.slice(0, repeated.importedMaterials!.length)).toEqual(
      repeated.importedMaterials,
    );
    await page.screenshot({ path: test.info().outputPath("materials-recovered-candidates.png") });
    expect(repeated.events.filter((event) => event.type === "started")).toHaveLength(0);
    await harness.close();
    harness = await launch();
    page = await harness.firstWindow();
    const restored = (await getDesktopState(page)).researchGroups!.projects.find(
      (item) => item.id === project.id,
    )!;
    expect(restored.importedMaterials).toEqual(recovered.importedMaterials);
    expect(restored.evidence).toEqual(repeated.evidence);
    expect(restored.members.map((member) => member.ref)).toEqual(
      project.members.map((member) => member.ref),
    );
    await writeFile(
      test.info().outputPath("materials-evidence.json"),
      JSON.stringify(
        {
          evidenceLayer:
            "E: deterministic Electron with stubbed OS picker result; no provider or native-picker claim",
          projectId: project.id,
          imports: restored.importedMaterials,
          evidence: restored.evidence,
          originalHashes: originals.map(sha256),
        },
        null,
        2,
      ),
    );
  } finally {
    await harness.close();
  }
});
