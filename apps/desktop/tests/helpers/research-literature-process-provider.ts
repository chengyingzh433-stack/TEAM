import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupResearchFusionRecoveryFixture } from "./research-fusion-recovery-provider";
import { writeProjectExtension } from "./electron-app";

export const LITERATURE_CORE_NOTICE =
  "合成软件验收：本地JSON导入，不联网，不是真实数据库检索或研究结论。";
export const LITERATURE_CORE_RECORDS = [
  {
    DOI: "10.9999/synthetic-fixture",
    title: "Synthetic fixture A",
    abstract: "Synthetic abstract for software depth checks only.",
    URL: "https://example.test/synthetic-a",
  },
  {
    doi: "https://doi.org/10.9999/SYNTHETIC-FIXTURE",
    title: "Synthetic fixture A duplicate original",
    URL: "https://example.test/synthetic-a",
  },
  { title: "Synthetic URL fixture B", url: "https://example.test/synthetic-b" },
  { title: "Synthetic URL fixture B duplicate original", URL: "https://example.test/synthetic-b" },
];
export interface LiteratureFixtureEvent {
  type: "request" | "result";
  role: string;
  at: string;
  attemptId: string;
  nativeRunId: string;
  callId: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  isError?: boolean;
  text?: string;
}

/** Actual local Pi provider/tools; reads owned state to schedule fixture responses, never writes it. */
export async function setupResearchLiteratureProcessFixture() {
  const fixture = await setupResearchFusionRecoveryFixture();
  const goodFile = join(fixture.workspace, "literature-records.json"),
    badFile = join(fixture.workspace, "literature-broken.json");
  await writeFile(goodFile, JSON.stringify({ candidates: LITERATURE_CORE_RECORDS }, null, 2));
  await writeFile(badFile, '{"candidates": [invalid JSON original retained\n');
  const journal = join(fixture.profile, "literature-core-journal.jsonl");
  await writeFile(journal, "");
  const providerSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { watch } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const profile=${JSON.stringify(fixture.profile)},stateFile=${JSON.stringify(join(fixture.profile, "research-groups.json"))},journal=${JSON.stringify(journal)},boundary=${JSON.stringify(LITERATURE_CORE_NOTICE)};
const state=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects[0];
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},recorded=new Set();
const waitFor=(predicate,signal,label)=>new Promise((resolve,reject)=>{
 let ended=false,checking=false,dirty=false;
 const end=error=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
 const abort=()=>end(new Error("Literature fixture aborted"));
 const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(error){end(error);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
 const watcher=watch(profile,()=>{void check();}),timer=setTimeout(()=>end(new Error("Missing literature observable state: "+label)),45000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else void check();
});
export default function(pi){pi.registerProvider("research-recovery-fixture",{baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-recovery-fixture",models:[{id:"gpt-6.1-sol",name:"Literature import local fixture",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,context,options){
 const stream=createAssistantMessageEventStream();
 const emit=async()=>{
  const messages=context.messages;if(messages.length>850)throw new Error("Bounded literature fixture conversation exceeded");
  const match=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n").match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);if(!match)throw new Error("Member identity absent");
  const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]],p=await state();
  const attempt=p.fusion.attempts.findLast(a=>["prepared","running"].includes(a.state)&&p.fusion.tasks.find(t=>t.id===a.taskId)?.role===role);if(!attempt)throw new Error("Actual attempt absent");
  const task=p.fusion.tasks.find(t=>t.id===attempt.taskId);if(task.stage!=="scan")throw new Error("Unexpected non-S0 task");
  const calls=new Map(messages.flatMap(m=>m.role==="assistant"?m.content.filter(c=>c.type==="toolCall").map(c=>[c.id,c.arguments]):[])),results=[];
  for(const m of messages.filter(m=>m.role==="toolResult")){
   const args=calls.get(m.toolCallId);if(!args)continue;const text=m.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");let parsed;
   try{parsed=JSON.parse(text);}catch{if(!m.isError)throw new Error("Non-JSON research result");}
   const data=parsed?.nextStage?parsed.result:parsed;
   if(m.isError&&!(m.toolCallId.endsWith("_probe-fulltext")&&args.operation==="literature-screen"&&args.requiredDepth==="full-text"&&/读取|深度/.test(text)))throw new Error("Unexpected real literature tool error: "+text);
   if(!recorded.has(role+":"+m.toolCallId)){recorded.add(role+":"+m.toolCallId);await appendFile(journal,JSON.stringify({type:"result",role,at:new Date().toISOString(),attemptId:attempt.id,nativeRunId:attempt.nativeRunId,callId:m.toolCallId,args,result:data,isError:m.isError===true,text})+"\n");}
   results.push({args,data,callId:m.toolCallId,isError:m.isError});
  }
  const own=results.filter(r=>r.callId.includes(attempt.id)),done=tag=>results.some(r=>r.callId.endsWith("_"+tag)),read=id=>own.some(r=>r.args.operation==="read"&&r.data?.id===id);
  const get=kind=>p.artifacts.findLast(a=>a.revision===p.revision&&a.stage==="scan"&&a.kind===kind),draft=get("stage-draft"),risk=get("stage-risk"),critique=get("stage-critique"),revision=get("stage-revision"),verification=get("stage-verification"),review=get("stage-review");
  const batches=p.artifacts.filter(a=>a.stage==="scan"&&a.kind==="stage-material"),pkg=p.methodPackages?.find(pkg=>pkg.rootIds.includes("RECOVERY-METHOD")),app=p.methodApplications?.findLast(a=>a.actor.id==="model:lead"),opinion=p.methodContentOpinions?.findLast(o=>o.applicationId===app?.id),adjudication=p.methodAdjudications?.findLast(a=>a.applicationId===app?.id);
  const ledger=p.literatureSearch,first=ledger?.records[0],good=p.importedMaterials?.find(m=>m.name==="literature-records.json"),bad=p.importedMaterials?.find(m=>m.name==="literature-broken.json");
  const sourceIds=p.evidence.sources.filter(s=>own.some(r=>r.args.operation==="source-read"&&r.data?.id===s.id)).map(s=>s.id);
  const plan=version=>({operation:"literature-strategy",strategy:{id:"core-import-scope",version,question:"仅演练教学材料的题录初筛和版本保存",concepts:["teaching"],synonyms:["education"],queries:[{source:"Crossref",query:version===1?"teaching feedback":"classroom feedback",filters:"计划字段，不执行远程过滤"}],inclusionCriteria:["合成教学题录仅供软件验收"],exclusionCriteria:["不将题录当全文"],stopRule:"本地两批后停止，不联网",changeReason:version===1?"初始有限演练范围":"明确课堂词汇，仅新策略不改旧执行"}});
  const screen=(version,depth)=>({operation:"literature-screen",recordId:first.id,strategyId:"core-import-scope",strategyVersion:version,decision:"undecided",requiredDepth:depth,reason:version===1?"LIBRARIAN-PRIVATE-JUDGMENT：仅摘要层待核，不能作全文纳排。":"第二版仅题录层记录，旧摘要判断保留。"});
  const stop=version=>({operation:"literature-stop",strategyId:"core-import-scope",strategyVersion:version,reason:"LIBRARIAN-PRIVATE-STOP：本地批次范围完成，未执行检索。",remainingLimitations:["无数据库执行","题录/摘要不能代替全文","合成记录不代表研究发现"]});
  const publish=(kind,refs=[],verdict)=>({operation:"publish",revision:p.revision,stage:"scan",kind,refs,sourceIds,content:boundary+" 候选方向只保留课堂反馈与学习支持两个待进一步限定的主题，不替用户定题。题录和摘要不代表全文，重复保留原件；资料员后续批次不阻断首批利用。"+(kind==="stage-material"?(batches.length?"第二批：坏JSON记录为失败，v2和旧记录独立保留。":"第一批：可读候选已经交接，资料员仍继续处理。"):(kind==="stage-risk"?"B独立初判，不借其他人的筛选理由。":kind==="stage-revision"?"A回应B：分别写清计划、导入、真实检索为零和未知全文范围。":"本段仅合成流程记录。")),...(verdict?{verdict}:{})});
  let args,wait,tag;
  if(!own.some(r=>r.args.operation==="status"))args={operation:"status"};
  else if(p.status!=="running"||review)args=undefined;
  else if(!own.some(r=>r.args.operation==="method-package"))args=pkg?{operation:"method-package",packageId:pkg.id}:{operation:"method-package",ids:["RECOVERY-METHOD"]};
  else if(sourceIds.length<p.evidence.sources.length)args={operation:"source-read",sourceId:p.evidence.sources.find(s=>!sourceIds.includes(s.id)).id};
  else if(role==="librarian"){
   if(!good||!bad)wait=async()=> (await state()).importedMaterials?.length===2;
   else if(!ledger?.strategies.length)args=plan(1);
   else if(!ledger.batches.some(b=>b.status==="succeeded"))args={operation:"literature-import",strategyId:"core-import-scope",strategyVersion:1,materialId:good.id};
   else if(!own.some(r=>r.args.operation==="literature-record"&&r.args.recordId===first.id))args={operation:"literature-record",recordId:first.id};
   else if(!done("probe-fulltext")){args=screen(1,"full-text");tag="probe-fulltext";}
   else if(!ledger.screenings.some(s=>s.strategyVersion===1))args=screen(1,"abstract");
   else if(!ledger.stops.some(s=>s.strategyVersion===1))args=stop(1);
   else if(!batches.length)args=publish("stage-material");
   else if(!draft||!risk)wait=async()=>{const q=await state();return ["stage-draft","stage-risk"].every(k=>q.artifacts.some(a=>a.kind===k));};
   else if(ledger.strategies.length===1)args=plan(2);
   else if(!ledger.batches.some(b=>b.status==="failed"))args={operation:"literature-import",strategyId:"core-import-scope",strategyVersion:2,materialId:bad.id};
   else if(ledger.batches.filter(b=>b.status==="succeeded").length===1)args={operation:"literature-import",strategyId:"core-import-scope",strategyVersion:2,materialId:good.id};
   else if(!ledger.screenings.some(s=>s.strategyVersion===2))args=screen(2,"metadata");
   else if(!ledger.stops.some(s=>s.strategyVersion===2))args=stop(2);
   else if(batches.length<2)args=publish("stage-material");
  }else if(role==="lead"||role==="reviewer"){
   if(!batches.length)wait=async()=> (await state()).artifacts.some(a=>a.kind==="stage-material");
   else if(!read(batches[0].id))args={operation:"read",artifactId:batches[0].id};
   else if(!done("context-before")){args={operation:"literature-context"};tag="context-before";}
   else if(!own.some(r=>r.args.operation==="literature-record"&&r.args.recordId===first.id))args={operation:"literature-record",recordId:first.id};
   else if(role==="lead"&&!draft)args=publish("stage-draft",[batches[0].id]);
   else if(role==="reviewer"&&!risk)args=publish("stage-risk",[batches[0].id]);
   else if(!done("context-after")){args={operation:"literature-context"};tag="context-after";}
   else if(role==="lead"){
    if(!app)args={operation:"method-apply",packageId:pkg.id,recordIds:["RECOVERY-METHOD"],methodSelection:"先交可读批次",applicabilityExplanation:"首批元数据交接，不等后批次完成；仅软件范围。",nonApplicableConditions:["不能推断检索覆盖率"],limitations:boundary,scoringClaim:"not-scored"};
    else if(!critique)wait=async()=> (await state()).artifacts.some(a=>a.kind==="stage-critique");
    else if(!read(critique.id))args={operation:"read",artifactId:critique.id};
    else if(batches.length<2)wait=async()=> (await state()).artifacts.filter(a=>a.kind==="stage-material").length===2;
    else if(!read(batches[1].id))args={operation:"read",artifactId:batches[1].id};
    else if(!revision)args=publish("stage-revision",[critique.id,batches[1].id]);
   }else{
    if(!draft)wait=async()=> (await state()).artifacts.some(a=>a.kind==="stage-draft");
    else if(!read(draft.id))args={operation:"read",artifactId:draft.id};
    else if(!critique)args=publish("stage-critique",[draft.id]);
    else if(!revision)wait=async()=> (await state()).artifacts.some(a=>a.kind==="stage-revision");
    else if(!read(revision.id))args={operation:"read",artifactId:revision.id};
    else if(!opinion)args={operation:"method-opinion",packageId:pkg.id,applicationId:app.id,verdict:"support",note:"支持区分计划、实际导入与未检索的有限软件说明；没有全文审阅或研究结论。"};
    else if(!verification)args=publish("stage-verification",[revision.id],"accept");
   }
  }else if(role==="mentor"){
   if(!verification)wait=async()=> (await state()).artifacts.some(a=>a.kind==="stage-verification");
   else if(!read(revision.id))args={operation:"read",artifactId:revision.id};
   else if(!read(verification.id))args={operation:"read",artifactId:verification.id};
   else if(!adjudication)args={operation:"method-adjudicate",packageId:pkg.id,applicationId:app.id,opinionIds:[opinion.id],verdict:"accept",note:"仅接受合成有限方向记录链，不认定数据库覆盖或研究发现。"};
   else args=publish("stage-review",[revision.id,verification.id],"accept");
  }
  if(wait){await waitFor(wait,options?.signal,role);args={operation:"status"};tag=undefined;}
  if(args&&["literature-search","literature-fetch","source-search","source-fetch"].includes(args.operation))throw new Error("Network operation forbidden in Core fixture");
  const callId="literature_"+attempt.id+"_"+randomUUID()+"_"+(tag??args?.operation??"text"),content=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:boundary+" 本次交接已完成，结束当前native。"}];
  await appendFile(journal,JSON.stringify({type:"request",role,at:new Date().toISOString(),attemptId:attempt.id,nativeRunId:attempt.nativeRunId,callId,args})+"\n");
  const message={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
  if(options?.signal?.aborted)throw new Error("Literature fixture aborted");stream.push({type:"start",partial:{...message,content:[]}});
  if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:content[0],partial:message});}else stream.push({type:"text_delta",contentIndex:0,delta:content[0].text,partial:message});
  stream.push({type:"done",reason:message.stopReason,message});
 };void emit().catch(error=>stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}}));return stream;
}});}
`;
  await writeProjectExtension(fixture.workspace, "research-recovery-fixture.ts", providerSource);
  return {
    ...fixture,
    goodFile,
    badFile,
    providerSource,
    readLiteratureJournal: async (): Promise<LiteratureFixtureEvent[]> =>
      (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LiteratureFixtureEvent),
  };
}
