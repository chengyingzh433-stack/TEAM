import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { writeProjectExtension } from "./electron-app";
import { setupResearchMethodPackageFixture } from "./research-method-package-provider";

export const METHOD_LAYERS_BOUNDARY =
  "AC29 确定性软件夹具：课程、案例、AI建议、模型应用与意见均为明确编制的测试内容；真实SMS论文仅作来源层展示，不宣称本轮学术核验；CSV为新编合成数据，不是观察数据或原演练CSV。实际UI选择是测试操作者决定，不是人类学术C。";
export const METHOD_LAYERS_DECISION = "AC29_UI_DECISION：旧项目继续使用其已固定离线方法包？";
export const METHOD_LAYERS_OPTION = "continue-offline-cache";
export const METHOD_V2_MARKER = "AC29_EXPLICIT_KB_V2_NEW_PROJECT_ONLY";
export const UNINDEXED_ADMIN_MARKERS = ["AC29_HOMEWORK_NOT_METHOD", "AC29_CLASS_ADMIN_NOT_METHOD"];
export const COURSE_CASE_ID = "AC29-COURSE-CASE";
export const AI_SUGGESTION_ID = "AC29-AI-SUGGESTION";

function replaceOnce(source: string, old: string, replacement: string) {
  const first = source.indexOf(old);
  if (first < 0 || source.indexOf(old, first + old.length) >= 0)
    throw new Error(
      "Method fixture upstream seam changed; inspect it before extending AC29 coverage",
    );
  return source.slice(0, first) + replacement + source.slice(first + old.length);
}

/** Reuses the existing real Pi transport, image fixtures, gates and Electron launcher.
 * Only deterministic response selection is extended. It reads project state and never writes it.
 * The original course/paper/CSV fixture files are separate from user or real R/C state.
 */
export async function setupResearchMethodLayersFixture() {
  const fixture = await setupResearchMethodPackageFixture();
  const index = join(fixture.kb, "索引", "知识块.jsonl");
  const records = (await readFile(index, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  records[0]!.required_context_ids = ["EDU-N02-2-4", COURSE_CASE_ID, AI_SUGGESTION_ID];
  records.push(
    {
      id: COURSE_CASE_ID,
      title: "合成课程案例层",
      text: "合成课程案例只示范方法选择；不是当前课题参与者的原始观察，不得作真实paper发现。",
      required_context_ids: [],
      image_paths: [],
      content_layers: ["course_case"],
    },
    {
      id: AI_SUGGESTION_ID,
      title: "明确标记的AI建议层",
      text: "AI建议测试夹具：提示记录不适用条件，尚未被当前课题实证核验，不是论文或用户决定。",
      required_context_ids: [],
      image_paths: [],
      content_layers: ["ai_suggestion"],
    },
  );
  await writeFile(index, records.map((record) => JSON.stringify(record)).join("\n"));
  await mkdir(join(fixture.kb, "未编入方法索引的课务"));
  for (const marker of UNINDEXED_ADMIN_MARKERS)
    await writeFile(
      join(fixture.kb, "未编入方法索引的课务", `${marker}.txt`),
      `${marker}: 合成课务文件未列入方法索引，不是方法检索对象。`,
    );
  const newerKb = join(fixture.profile, "knowledge-v2-explicit");
  await cp(fixture.kb, newerKb, { recursive: true });
  const newerRecords = structuredClone(records);
  newerRecords[0]!.text = `${String(newerRecords[0]!.text)} ${METHOD_V2_MARKER}：只对明确连接此副本的新项目提供此新增边界。`;
  await writeFile(
    join(newerKb, "索引", "知识块.jsonl"),
    newerRecords.map((record) => JSON.stringify(record)).join("\n"),
  );
  await writeFile(
    join(newerKb, "溯源", "来源清单.json"),
    JSON.stringify({ version: "method-core-synthetic-v2-explicit" }),
  );
  const csv = join(fixture.workspace, "AC29-new-synthetic-data.csv");
  await writeFile(csv, "fixture_x,fixture_y\n1,2\n2,4\n3,6\n");
  const originalPaper =
    process.env.RESEARCH_METHOD_LAYERS_PAPER ??
    resolve(
      __dirname,
      "../../../../../工作区/教育研究课题组/全流程演练-2026-11-07/研究材料/SMS2025.txt",
    );
  // Only an original text is read; no original CSV, authentication, old manuscript or R/C is opened.
  const paperBytes = await readFile(originalPaper);
  if (!paperBytes.toString().includes("Artificial intelligence in student management systems"))
    throw new Error("AC29 paper must be the actual selected SMS2025 supplied text");
  const paper = join(fixture.workspace, "AC29-real-paper-SMS2025.txt");
  await writeFile(paper, paperBytes, { flag: "wx" });

  let provider = replaceOnce(
    fixture.providerSource,
    'const state=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects[0];',
    'const projects=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects;',
  );
  provider = replaceOnce(
    provider,
    "[match[1]],p=await state();",
    String.raw`[match[1]];
  const marker=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n").match(/AC29_PROJECT=(old|peer|new)/)?.[0];
  if(!marker)throw new Error("AC29 deterministic fixture project marker missing");
  const state=async()=>{const p=(await projects()).find(p=>p.objective.includes(marker));if(!p)throw new Error("AC29 project not found");return p;};
  const p=await state();`,
  );
  provider = replaceOnce(
    provider,
    "const base=boundary+",
    'const base=boundary+" PRIVATE-APPLICATION-"+marker+" "+',
  );
  provider = replaceOnce(
    provider,
    'else if(p.status!=="running"||review)args=undefined;',
    `else if(p.status!=="running"||review)args=undefined;
  else if(role==="mentor"&&marker==="AC29_PROJECT=old"&&!(p.fusion.decisionRequests??[]).some(r=>r.question===${JSON.stringify(METHOD_LAYERS_DECISION)}))args={operation:"request-decision",decision:{conditionId:"ac29-old-offline-cache",question:${JSON.stringify(METHOD_LAYERS_DECISION)},context:${JSON.stringify(METHOD_LAYERS_BOUNDARY)},impact:"仅旧项目导师最终裁定等待真实UI选择；A/B和另建项目不受此条件阻塞。",taskIds:[task.id],options:[{id:${JSON.stringify(METHOD_LAYERS_OPTION)},label:"仅继续旧项目固定缓存",consequence:"不更换旧项目课程pin、不授权实证结论",outcome:"confirmed"},{id:"defer",label:"暂缓",consequence:"保留旧项目私有记录",outcome:"deferred"}],recommendedOptionId:${JSON.stringify(METHOD_LAYERS_OPTION)}}};
  else if(role==="mentor"&&marker==="AC29_PROJECT=old"&&!(p.fusion.decisions??[]).some(d=>d.requestId===(p.fusion.decisionRequests??[]).find(r=>r.question===${JSON.stringify(METHOD_LAYERS_DECISION)})?.id&&d.outcome==="confirmed"))args=undefined;`,
  );
  provider = replaceOnce(
    provider,
    '} else if(role==="mentor"){\n   if(!verification)',
    '} else if(role==="mentor"){\n   if(marker==="AC29_PROJECT=old"&&!own.some(r=>r.args.operation==="method-read-image"&&r.args.path===paths[0]&&!r.isError))args={operation:"method-read-image",packageId:pkg.id,path:paths[0]};\n   else if(!verification)',
  );
  await writeProjectExtension(fixture.workspace, "research-recovery-fixture.ts", provider);
  await fixture.release("images");
  await fixture.release("observations");
  await fixture.release("adjudication");
  return {
    ...fixture,
    index,
    newerKb,
    records,
    newerRecords,
    csv,
    paper,
    paperSha256: createHash("sha256").update(paperBytes).digest("hex"),
  };
}
