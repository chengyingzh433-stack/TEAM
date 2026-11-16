import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { setupResearchFusionRecoveryFixture } from "./research-fusion-recovery-provider";
import { writeProjectExtension } from "./electron-app";

export const METHOD_IMAGE_PATHS = [
  "synthetic-red",
  "synthetic-green",
  "synthetic-blue",
  "synthetic-yellow",
].map((name) => `素材/原图/${name}.png`);
export const METHOD_BOUNDARY =
  "合成软件验收：2×2纯色PNG仅证明真实Pi图片传输与记录分离，不是原课程图片、视觉内容C或真实研究结论。";
export interface MethodFixtureEvent {
  type: "request" | "result";
  role: string;
  at: string;
  attemptId: string;
  nativeRunId: string;
  callId: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  text?: string;
  images?: { sha256: string; bytes: number; mimeType: string }[];
  textOrDetailsContainsImageData?: boolean;
  modelInput?: string[];
  before?: {
    risk: boolean;
    receipts: number;
    readings: number;
    applications: number;
    opinions: number;
    adjudications: number;
  };
}

// Four small valid PNGs with distinct actual pixels/hashes, not screenshots of course content.
function png(red: number, green: number, blue: number) {
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.from([0, red, green, blue, 255, red, green, blue, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat([row, row]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Local deterministic provider with real native tools; never writes research project state. */
export async function setupResearchMethodPackageFixture() {
  const fixture = await setupResearchFusionRecoveryFixture();
  const design = join(fixture.workspace, "method-design.txt");
  await writeFile(
    design,
    `${METHOD_BOUNDARY}\n拟参考EDU-N02-2-5及必要上下文EDU-N02-2-4中的部分指标制定有限观察方案；不计算完整工具总分，不推断完整量表效度，没有CSV或实际采集。\n`,
  );
  await mkdir(join(fixture.kb, "素材", "原图"), { recursive: true });
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  const images = METHOD_IMAGE_PATHS.map((path, index) => {
    const color = colors[index]!,
      bytes = png(color[0]!, color[1]!, color[2]!);
    return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  for (const image of images) await writeFile(join(fixture.kb, image.path), image.bytes);
  await writeFile(
    join(fixture.kb, "索引", "知识块.jsonl"),
    [
      {
        id: "EDU-N02-2-5",
        title: "合成方法选择 研究设计",
        text: `${METHOD_BOUNDARY} 必须结合必要上下文，只能作局部指标参考。`,
        required_context_ids: ["EDU-N02-2-4"],
        image_paths: [],
        content_layers: ["course_paraphrase"],
      },
      {
        id: "EDU-N02-2-4",
        title: "合成部分指标与四张色块",
        text: `${METHOD_BOUNDARY} 四张图片为红绿蓝黄纯色像素，没有量表条目。部分指标不能计算完整版工具总分；当前没有完整评分工具。`,
        required_context_ids: [],
        image_paths: METHOD_IMAGE_PATHS,
        content_layers: ["note_commentary"],
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  await writeFile(
    join(fixture.kb, "溯源", "来源清单.json"),
    JSON.stringify({ version: "method-core-synthetic-v1" }),
  );
  await writeFile(
    join(fixture.kb, "溯源", "图片清单.json"),
    JSON.stringify(images.map(({ path, sha256 }) => ({ path, sha256 }))),
  );
  const gatesFile = join(fixture.profile, "method-core-gates.json"),
    journal = join(fixture.profile, "method-core-journal.jsonl");
  await writeFile(journal, "");
  const gates = { images: false, observations: false, adjudication: false };
  const release = async (gate: keyof typeof gates) => {
    gates[gate] = true;
    await writeFile(`${gatesFile}.tmp`, JSON.stringify(gates));
    await rename(`${gatesFile}.tmp`, gatesFile);
  };
  await writeFile(gatesFile, JSON.stringify(gates));
  const providerSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { watch } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
const profile=${JSON.stringify(fixture.profile)},stateFile=${JSON.stringify(join(fixture.profile, "research-groups.json"))},gateFile=${JSON.stringify(gatesFile)},journal=${JSON.stringify(journal)},paths=${JSON.stringify(METHOD_IMAGE_PATHS)},boundary=${JSON.stringify(METHOD_BOUNDARY)};
const state=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects[0];
const gates=async()=>JSON.parse(await readFile(gateFile,"utf8"));
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const recorded=new Set();
const waitFor=(predicate,signal,label)=>new Promise((resolve,reject)=>{
 let ended=false,checking=false,dirty=false;
 const end=error=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
 const abort=()=>end(new Error("Method fixture wait aborted"));
 const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(error){end(error);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
 const watcher=watch(profile,()=>{void check();});const timer=setTimeout(()=>end(new Error("Method fixture missing observable state: "+label)),45000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else void check();
});
export default function(pi){pi.registerProvider("research-recovery-fixture",{baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-recovery-fixture",models:[{id:"gpt-6.1-sol",name:"Method images deterministic fixture",reasoning:true,input:["text","image"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,context,options){
 const stream=createAssistantMessageEventStream();
 const emit=async()=>{
  const messages=context.messages;if(messages.length>750)throw new Error("Method fixture bounded tool conversation exceeded");
  const match=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n").match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
  if(!match)throw new Error("Method fixture member identity missing");
  const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]],p=await state();
  const attempt=p.fusion.attempts.findLast(a=>["prepared","running"].includes(a.state)&&p.fusion.tasks.find(t=>t.id===a.taskId)?.role===role);
  if(!attempt)throw new Error("Method fixture missing actual attempt");
  const task=p.fusion.tasks.find(t=>t.id===attempt.taskId);if(task.stage!=="design"||role==="librarian")throw new Error("Method fixture unexpected task scope");
  const calls=new Map(messages.flatMap(m=>m.role==="assistant"?m.content.filter(c=>c.type==="toolCall").map(c=>[c.id,c.arguments]):[]));
  const results=[];
  for(const m of messages.filter(m=>m.role==="toolResult")){
   const args=calls.get(m.toolCallId);if(!args)continue;
   const text=m.content.filter(c=>c.type==="text").map(c=>c.text).join("\n"),images=m.content.filter(c=>c.type==="image").map(c=>({sha256:createHash("sha256").update(Buffer.from(c.data,"base64")).digest("hex"),bytes:Buffer.from(c.data,"base64").length,mimeType:c.mimeType}));
   let parsed;try{parsed=JSON.parse(text);}catch{if(!m.isError)throw new Error("Non-JSON successful research tool result");}
   const data=parsed?.nextStage?parsed.result:parsed;
   if(m.isError){
    const fullScore=args.operation==="method-apply"&&args.scoringClaim==="full-score"&&(text.includes("完整工具评分认证")||(/scoringClaim/.test(text)&&/validation|validate|enum|allowed|schema|must|invalid/i.test(text)));
    const independence=role==="reviewer"&&args.operation==="method-check"&&m.toolCallId.endsWith("_probe-guess")&&text.includes("独立初判");
    const gate=args.operation==="publish"&&args.stage==="design"&&args.verdict==="accept"&&["stage-verification","stage-review"].includes(args.kind)&&text.includes("方法依据核验未通过：")&&(p.methodProgramChecks??[]).some(check=>check.result==="blocked"&&check.role===role&&args.refs.includes(check.target?.artifactId));
    if(!fullScore&&!independence&&!gate)throw new Error("Unexpected real method tool error: "+text);
   }
   const key=role+":"+m.toolCallId;
   if(!recorded.has(key)){
    recorded.add(key);
    const imageParts=m.content.filter(c=>c.type==="image");
    await appendFile(journal,JSON.stringify({type:"result",role,at:new Date().toISOString(),attemptId:attempt.id,nativeRunId:attempt.nativeRunId,callId:m.toolCallId,args,isError:m.isError===true,text,images,modelInput:model.input,textOrDetailsContainsImageData:imageParts.some(c=>text.includes(c.data)||JSON.stringify(m.details??{}).includes(c.data))})+"\n");
   }
   results.push({args,data,text,isError:m.isError,callId:m.toolCallId});
  }
  const own=results.filter(r=>r.callId.includes(attempt.id)),done=tag=>results.some(r=>r.callId.endsWith("_"+tag)),read=id=>own.some(r=>r.args.operation==="read"&&r.data?.id===id);
  const get=kind=>p.artifacts.findLast(a=>a.revision===p.revision&&a.stage==="design"&&a.kind===kind);
  const draft=get("stage-draft"),risk=get("stage-risk"),critique=get("stage-critique"),revision=get("stage-revision"),verification=get("stage-verification"),review=get("stage-review");
  const pkg=p.methodPackages?.find(pkg=>pkg.rootIds.includes("EDU-N02-2-5")),app=p.methodApplications?.find(a=>a.actor.id==="model:lead"),opinion=p.methodContentOpinions?.find(o=>o.applicationId===app?.id&&o.verdict==="support"),adjudication=p.methodAdjudications?.find(a=>a.applicationId===app?.id&&a.verdict==="accept");
  const readings=(p.methodImageReadings??[]).filter(r=>r.actor.id==="model:lead"&&r.packageId===pkg?.id&&r.taskId===app?.taskId),complete=paths.every(path=>readings.some(r=>r.path===path));
  const reviewerReadings=(p.methodImageReadings??[]).filter(r=>r.actor.id==="model:reviewer"&&r.packageId===pkg?.id&&r.taskId===task.id),reviewerComplete=paths.every(path=>reviewerReadings.some(r=>r.path===path));
  const sourceIds=p.evidence.sources.filter(s=>own.some(r=>r.args.operation==="source-read"&&r.data?.id===s.id)).map(s=>s.id);
  const base=boundary+" 本任务仅评价合成方案中的局部指标适用范围；不能把片段当完整工具总分，不主张量表效度或实证因果。保留方法选择、适用解释、不适用条件和未知边界。";
  const publish=(kind,refs=[],verdict)=>({operation:"publish",revision:p.revision,stage:"design",kind,refs,sourceIds,content:base+(kind==="stage-draft"?"A独立初稿明确EDU-N02-2-5需要2-4上下文与四图。":kind==="stage-risk"?"B先独立判断：纯色软件图片不包含评分条目；审阅只能检验软件链和有限应用。":kind==="stage-critique"?"B实际读初稿后要求明确部分指标、未取得完整工具和图像记录缺口。":kind==="stage-revision"?"A回应B：仅部分指标参考，图片传送和具体观察分离，未取得完整工具不计算总分。":kind==="stage-verification"?"B支持本次有限软件范围，支持意见不能替代导师方法裁定或人类视觉审阅。":"导师仅接受合成方法记录链，课程视觉与研究效度仍未认证。"),...(verdict?{verdict}:{})});
  const application=scoringClaim=>({operation:"method-apply",packageId:pkg.id,recordIds:["EDU-N02-2-5","EDU-N02-2-4"],methodSelection:"采用必要上下文中的部分指标参考",applicabilityExplanation:"仅讨论有限观察方案；合成图片不包含真实评分条目。",nonApplicableConditions:["没有完整版工具，不能计算总分","没有实际数据，不能推断测量效度"],limitations:boundary,scoringClaim});
  let args,wait,tag;
  if(!own.some(r=>r.args.operation==="status"))args={operation:"status"};
  else if(p.status!=="running"||review)args=undefined;
  else if(!own.some(r=>r.args.operation==="method-package"))args=pkg?{operation:"method-package",packageId:pkg.id}:{operation:"method-package",ids:["EDU-N02-2-5"]};
  else if(sourceIds.length<p.evidence.sources.length)args={operation:"source-read",sourceId:p.evidence.sources.find(s=>!sourceIds.includes(s.id)).id};
  else if(role==="lead"){
   if(!done("probe-full-score")){args=application("full-score");tag="probe-full-score";}
   else if(!app)args=application("partial-indicators-only");
   else if(!draft)args=publish("stage-draft");
   else if(!critique)wait=async()=>!!(await state()).artifacts.find(a=>a.stage==="design"&&a.kind==="stage-critique");
   else if(!read(critique.id))args={operation:"read",artifactId:critique.id};
   else if(!revision)args=publish("stage-revision",[critique.id]);
   else if(!complete){
    if(!(await gates()).images)wait=async()=> (await gates()).images;
    else {
     const path=paths.find(path=>!readings.some(r=>r.path===path));
     const receipt=own.findLast(r=>r.args.operation==="method-read-image"&&r.args.path===path&&!r.isError)?.data?.receipt;
     if(!receipt)args={operation:"method-read-image",packageId:pkg.id,path};
     else if(!(await gates()).observations)wait=async()=> (await gates()).observations;
     else args={operation:"method-image-reading",packageId:pkg.id,path,receiptId:receipt.id,observations:"实际收到2×2纯色PNG："+["红色","绿色","蓝色","黄色"][paths.indexOf(path)]+"像素；没有量表项目或评分规则。仅为确定性软件运输观察声明，不是课程视觉C。"};
    }
   } else if(!done("lead-program-complete")){args={operation:"method-check",packageId:pkg.id,applicationId:app.id};tag="lead-program-complete";}
  } else if(role==="reviewer"){
   if(!app)wait=async()=>!!(await state()).methodApplications?.length;
   else if(!risk&&!done("probe-guess")){args={operation:"method-check",packageId:pkg.id,applicationId:app.id};tag="probe-guess";}
   else if(!risk)args=publish("stage-risk");
   else if(!draft)wait=async()=>!!(await state()).artifacts.find(a=>a.kind==="stage-draft");
   else if(!read(draft.id))args={operation:"read",artifactId:draft.id};
   else if(!critique)args=publish("stage-critique",[draft.id]);
   else if(!revision)wait=async()=>!!(await state()).artifacts.find(a=>a.kind==="stage-revision");
   else if(!read(revision.id))args={operation:"read",artifactId:revision.id};
   else if(!done("missing-images-check")){args={operation:"method-check",packageId:pkg.id,applicationId:app.id};tag="missing-images-check";}
   else if(!done("probe-verification")){args=publish("stage-verification",[revision.id],"accept");tag="probe-verification";}
   else if(!complete)wait=async()=>{const q=await state();return paths.every(path=>(q.methodImageReadings??[]).some(r=>r.actor.id==="model:lead"&&r.path===path&&r.packageId===pkg.id&&r.taskId===app.taskId));};
   else if(!reviewerComplete){
    const path=paths.find(path=>!reviewerReadings.some(r=>r.path===path));
    const receipt=own.findLast(r=>r.args.operation==="method-read-image"&&r.args.path===path&&!r.isError)?.data?.receipt;
    args=receipt?{operation:"method-image-reading",packageId:pkg.id,path,receiptId:receipt.id,observations:"B本人当前native实际收到2×2纯色PNG："+["红色","绿色","蓝色","黄色"][paths.indexOf(path)]+"像素，无真实量表条目；自己的读图观察，不借A观察，不是课程视觉C。"}:{operation:"method-read-image",packageId:pkg.id,path};
   }
   else if(!opinion)args={operation:"method-opinion",packageId:pkg.id,applicationId:app.id,verdict:"support",note:base+"已核对四图观察与部分指标范围，仅支持软件记录链，不认证完整工具。"};
   else if(!done("reviewer-program-complete")){args={operation:"method-check",packageId:pkg.id,applicationId:app.id};tag="reviewer-program-complete";}
   else if(!verification)args=publish("stage-verification",[revision.id],"accept");
  } else if(role==="mentor"){
   if(!verification)wait=async()=>!!(await state()).artifacts.find(a=>a.kind==="stage-verification");
   else if(!read(revision.id))args={operation:"read",artifactId:revision.id};
   else if(!read(verification.id))args={operation:"read",artifactId:verification.id};
   else if(!done("mentor-pre-adjudication-check")){args={operation:"method-check",packageId:pkg.id,applicationId:app.id};tag="mentor-pre-adjudication-check";}
   else if(!done("probe-adjudication")){args=publish("stage-review",[revision.id,verification.id],"accept");tag="probe-adjudication";}
   else if(!(await gates()).adjudication)wait=async()=> (await gates()).adjudication;
   else if(!adjudication)args={operation:"method-adjudicate",packageId:pkg.id,applicationId:app.id,opinionIds:[opinion.id],verdict:"accept",note:base+"引用当前B支持意见，有限接受部分指标应用；程序完整性不替代模型方法判断。"};
   else if(!done("mentor-program-complete")){args={operation:"method-check",packageId:pkg.id,applicationId:app.id};tag="mentor-program-complete";}
   else args=publish("stage-review",[revision.id,verification.id],"accept");
  }
  if(wait){await waitFor(wait,options?.signal,role+" "+(tag??"handoff/gate"));args={operation:"status"};tag=undefined;}
  const callId="method_"+attempt.id+"_"+randomUUID()+"_"+(tag??args?.operation??"text");
  const output=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:"本次合成方法任务工作已交付，保留视觉C及完整工具未知边界。"}];
  const message={role:"assistant",content:output,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
  await appendFile(journal,JSON.stringify({type:"request",role,at:new Date().toISOString(),attemptId:attempt.id,nativeRunId:attempt.nativeRunId,callId,args,modelInput:model.input,before:{risk:!!risk,receipts:(p.methodImageReceipts??[]).length,readings:(p.methodImageReadings??[]).length,applications:(p.methodApplications??[]).length,opinions:(p.methodContentOpinions??[]).length,adjudications:(p.methodAdjudications??[]).length}})+"\n");
  if(options?.signal?.aborted)throw new Error("Method fixture aborted");
  stream.push({type:"start",partial:{...message,content:[]}});
  if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:output[0],partial:message});}else stream.push({type:"text_delta",contentIndex:0,delta:output[0].text,partial:message});
  stream.push({type:"done",reason:message.stopReason,message});
 };
 void emit().catch(error=>stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}}));return stream;
}});}
`;
  await writeProjectExtension(fixture.workspace, "research-recovery-fixture.ts", providerSource);
  return {
    ...fixture,
    design,
    images,
    providerSource,
    release,
    readMethodJournal: async (): Promise<MethodFixtureEvent[]> =>
      (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as MethodFixtureEvent),
  };
}
