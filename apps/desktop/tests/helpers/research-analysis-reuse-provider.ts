import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeProjectExtension } from "./electron-app";
import {
  REGISTRY_PLAN_IDS,
  setupResearchAnalysisRegistryFixture,
} from "./research-analysis-registry-provider";

export interface AnalysisReuseProviderRecord {
  type: string;
  at: string;
  role: string;
  attemptId?: string;
  nativeRunId?: string;
  taskId?: string;
  taskInputVersion?: number;
  callId?: string;
  args?: Record<string, unknown>;
  error?: boolean;
  result?: unknown;
}

/** Local deterministic model transport, real Pi tools/files; no seeded results or accepted stages. */
export async function setupResearchAnalysisReuseFixture() {
  const fixture = await setupResearchAnalysisRegistryFixture();
  const modules = join(fixture.workspace, ".pi", "fixture-modules");
  await mkdir(modules, { recursive: true });
  await rename(
    join(fixture.workspace, ".pi", "extensions", "research-recovery-fixture.ts"),
    join(modules, "reuse-registry-base.ts"),
  );
  const release = join(fixture.profile, "reuse-release-plan-change");
  const journal = join(fixture.profile, "reuse-tool-journal.jsonl");
  await writeFile(journal, "");
  await writeFile(
    fixture.design,
    (await readFile(fixture.design, "utf8")) +
      "局部变更演练：首轮三计划计算结束后，导师事后把比较模型的自变量由x改为z；主模型和描述计划保持原样。采用旧计算须逐项明确说明，重新取得数字并由B给出本轮解释；不能把采用当新复跑。\n",
  );
  await writeProjectExtension(
    fixture.workspace,
    "research-recovery-fixture.ts",
    String.raw`
import base from "../fixture-modules/reuse-registry-base.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFileSync, watch } from "node:fs";
import { appendFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const profile=${JSON.stringify(fixture.profile)},stateFile=${JSON.stringify(join(fixture.profile, "research-groups.json"))},journal=${JSON.stringify(journal)},release=${JSON.stringify(release)},transportJournal=${JSON.stringify(join(fixture.profile, "recovery-provider-journal"))};
const ids=${JSON.stringify(REGISTRY_PLAN_IDS)},unchanged=[ids[0],ids[2]],recorded=new Set();
const state=()=>JSON.parse(readFileSync(stateFile,"utf8")).projects[0];
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const active=(p,role)=>p.fusion.attempts.findLast(a=>["prepared","running"].includes(a.state)&&p.fusion.tasks.find(t=>t.id===a.taskId)?.role===role);
const roleOf=messages=>{const m=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n").match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);if(!m)throw Error("Reuse fixture role missing");return {"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[m[1]];};
const currentArtifact=(p,a)=>{const r=p.fusion.artifacts.find(x=>x.id===a.id),t=p.fusion.tasks.find(x=>x.id===r?.taskId);return !!r&&t?.inputVersion===r.taskVersion&&r.content===a.content&&!["needs-review","superseded"].includes(r.reviewState);};
const originalRuns=p=>p.analysisRegistry?.runs.filter(r=>r.planVersion===1)??[];
const sourceAttempts=p=>originalRuns(p).map(r=>p.fusion.attempts.find(a=>a.id===p.analyses.find(x=>x.id===r.id)?.attemptId));
const sourceFinished=p=>originalRuns(p).length===6&&sourceAttempts(p).every(a=>a?.state==="succeeded"&&!!a.finishedAt);
const changed=p=>p.analysisRegistry?.plans.some(plan=>plan.id===ids[1]&&plan.version===2);
const waitFor=(predicate,signal,label)=>new Promise((resolve,reject)=>{
 let ended=false,checking=false,dirty=false;
 const end=e=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);e?reject(e):resolve();};
 const abort=()=>end(Error("Reuse fixture wait aborted: "+label));
 const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(e){end(e);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
 const watcher=watch(profile,()=>void check()),timer=setTimeout(()=>end(Error("Reuse fixture missing actual barrier: "+label)),60000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else void check();
});
export default function(pi){base({registerProvider(name,config){pi.registerProvider(name,{...config,streamSimple(model,context,options){
 const p=state(),role=roleOf(context.messages),attempt=active(p,role),task=p.fusion.tasks.find(t=>t.id===attempt?.taskId),phase=task?.stage;
 const designAccepted=p.artifacts.some(a=>a.stage==="design"&&a.kind==="stage-review"&&a.verdict==="accept"&&currentArtifact(p,a));
 if(phase==="design"&&!designAccepted)return config.streamSimple(model,context,options);
 const stream=createAssistantMessageEventStream();
 const emit=async()=>{
  if(!attempt||!task)throw Error("Reuse fixture requires actual native attempt");
  const messages=context.messages;if(messages.length>1400)throw Error("Reuse fixture bounded tool conversation exceeded");
  const calls=new Map(messages.flatMap(m=>m.role==="assistant"?m.content.filter(c=>c.type==="toolCall").map(c=>[c.id,c.arguments]):[]));
  const results=messages.flatMap(m=>{if(m.role!=="toolResult")return [];const raw=m.content.filter(c=>c.type==="text").map(c=>c.text).join("");let data;try{const v=JSON.parse(raw);data=v.nextStage?v.result:v;}catch{data=raw;}return [{callId:m.toolCallId,args:calls.get(m.toolCallId),data,raw,error:!!m.isError}];});
  for(const r of results){
   const old=p.fusion.attempts.find(a=>r.callId?.includes(a.id));
   const oldTask=p.fusion.tasks.find(t=>t.id===old?.taskId);
   const expectedLate=r.callId?.endsWith("_late-reuse")&&r.args?.operation==="reuse-analysis"&&role==="lead"&&old?.taskVersion<oldTask?.inputVersion&&/任务输入已变化或原生请求已结束/.test(r.raw);
   const originalComparison=originalRuns(p).find(run=>run.planId===ids[1]&&run.actor==="model:lead");
   const expectedExpired=r.callId?.endsWith("_expired-numeric-render")&&r.args?.operation==="numeric-render"&&role==="lead"&&changed(p)&&old?.nativeRunId&&old.taskVersion===oldTask?.inputVersion&&r.args.runId===originalComparison?.id&&r.raw.includes("运行不存在、未实际采用或因数据/计划/任务版本变化而过期。");
   if(r.error&&!expectedLate&&!expectedExpired)throw Error("Unexpected reuse tool failure: "+r.raw);
   if(r.args&&!recorded.has(r.callId)){
    recorded.add(r.callId);await appendFile(journal,JSON.stringify({type:"tool-result",at:new Date().toISOString(),role,attemptId:old?.id,nativeRunId:old?.nativeRunId,taskId:old?.taskId,taskInputVersion:old?.taskVersion,callId:r.callId,args:r.args,result:r.data,error:r.error})+"\n");
   }
  }
  const own=results.filter(r=>r.callId?.includes(attempt.id)),ok=own.filter(r=>!r.error);
  const get=(kind,stage=phase)=>p.artifacts.findLast(a=>a.revision===p.revision&&a.stage===stage&&a.kind===kind&&currentArtifact(p,a));
  const read=id=>ok.some(r=>r.args?.operation==="read"&&r.data.id===id);
  const readRun=id=>ok.some(r=>["read-registered-analysis","run-analysis"].includes(r.args?.operation)&&r.data.id===id);
  const sourceIds=p.evidence.sources.filter(s=>ok.some(r=>r.args?.operation==="source-read"&&r.data.id===s.id&&r.data.sha256===s.sha256)).map(s=>s.id);
  const registry=p.analysisRegistry??{plans:[],runs:[],reviews:[]};
  const run=(planId,owner="lead",version=1)=>registry.runs.find(r=>r.planId===planId&&r.planVersion===version&&r.actor==="model:"+owner);
  const projection=id=>p.analyses.find(r=>r.id===id);
  const adopted=(id,owner)=>p.analysisRunAdoptions?.some(a=>a.pin.runId===id&&a.target.role===owner&&a.target.taskInputVersion===p.fusion.tasks.find(t=>t.id===a.target.taskId)?.inputVersion);
  const reviewed=(id,version)=>registry.reviews.some(r=>r.planId===id&&r.planVersion===version&&r.runId===run(id,"lead",version)?.id&&r.actor==="model:reviewer"&&r.verdict==="accept"&&p.analysisReviewContexts?.some(c=>c.reviewId===r.id&&c.context.taskInputVersion===task.inputVersion));
  const draft=get("stage-draft"),risk=get("stage-risk"),critique=get("stage-critique"),revision=get("stage-revision"),verification=get("stage-verification"),previous=get("stage-review","design");
  const analysisIds=p.analysisReads?.filter(r=>r.context.attemptId===attempt.id&&r.usableForCurrentInputs).map(r=>r.pin.runId)??[];
  const baseText="局部复用合成软件验收：只证明结构化分析、真实CSV计算及当前执行凭据链，不是真实教育研究结论。原始八行及缺失排除保持；共同完整六行只支持观察关联，不能推断因果或报告未支持p值、置信区间。同引擎复跑不等于独立算法，模型意见不是人类专家确认。";
  const publish=(kind,refs=[],verdict,extra="")=>({operation:"publish",revision:p.revision,stage:phase,kind,refs,sourceIds,analysisIds,content:baseText+extra,...(verdict?{verdict}:{})});
  const ownSource=originalRuns(p).some(r=>r.actor==="model:"+role&&projection(r.id)?.attemptId===attempt.id);
  const late=phase==="analysis"&&role==="lead"&&!ownSource&&run(ids[0])&&attempt.taskVersion===p.fusion.attempts.find(a=>a.id===projection(run(ids[0]).id)?.attemptId)?.taskVersion;
  let args,tag,wait,label;
  if(late){
   const marker="armed:"+attempt.id;
   if(!recorded.has(marker)){recorded.add(marker);await appendFile(journal,JSON.stringify({type:"late-native-armed",at:new Date().toISOString(),role,attemptId:attempt.id,nativeRunId:attempt.nativeRunId})+"\n");}
   if(!changed(p)){await waitFor(()=>changed(state()),options?.signal,"mentor actual plan-v2 registration");args={operation:"reuse-analysis",analysisId:run(ids[0]).id,reason:"旧尝试不能因读到新计划而授权新输入"};tag="late-reuse";}
   else if(!own.some(r=>r.callId.endsWith("_late-reuse"))){args={operation:"reuse-analysis",analysisId:run(ids[0]).id,reason:"旧尝试不能授权新输入"};tag="late-reuse";}
   else if(!own.some(r=>r.callId.endsWith("_late-publish"))){args=publish("stage-revision",[],undefined," LATE_OLD_INPUT_HISTORY：该旧输入稿必须保留为历史，不能释放新计划。");tag="late-publish";}
  }
  else if(!ok.some(r=>r.args?.operation==="status"))args={operation:"status"};
  else if(phase==="writing"||phase==="design"&&designAccepted||get("stage-review")?.verdict==="accept")args=undefined;
  else if(phase!=="analysis")throw Error("Unexpected reuse stage "+phase);
  else if(!ok.some(r=>r.args?.operation==="knowledge"))args={operation:"knowledge",query:"研究问题 证据 研究设计"};
  else if(previous&&!read(previous.id))args={operation:"read",artifactId:previous.id};
  else if(sourceIds.length<p.evidence.sources.length)args={operation:"source-read",sourceId:p.evidence.sources.find(s=>!sourceIds.includes(s.id)).id};
  else if(!ok.some(r=>r.args?.operation==="analysis-registry"))args={operation:"analysis-registry"};
  else if(!changed(p)){
   if(role==="lead"){
    const missing=ids.find(id=>!run(id));
    if(missing)args={operation:"run-analysis",planId:missing,planVersion:1};
    else if(!draft)args=publish("stage-draft",[previous.id],undefined," INITIAL_INDEPENDENT_DRAFT：三项初次计算交付；等待真实局部方案变更。");
   }else if(role==="reviewer"){
    const missing=ids.find(id=>!registry.reviews.some(r=>r.planId===id&&r.planVersion===1&&r.actor==="model:reviewer"&&r.verdict==="accept"));
    if(missing){const original=run(missing);if(!original){wait=q=>!!q.analysisRegistry?.runs.some(r=>r.planId===missing&&r.actor==="model:lead");label="original A run";}else if(!readRun(original.id))args={operation:"read-registered-analysis",analysisId:original.id};else if(!run(missing,"reviewer"))args={operation:"run-analysis",planId:missing,planVersion:1,replayOf:original.id};else args={operation:"review-analysis",planId:missing,planVersion:1,analysisId:original.id,verdict:"accept",content:baseText+" INITIAL_INTERPRETATION：按第一版计划解释，日后输入变化不能自动恢复此意见。"};}
    else if(!risk)args=publish("stage-risk",[previous.id],undefined," INITIAL_INDEPENDENT_RISK：明确原始样本、缺失和同引擎限制。");
    else if(!draft){wait=q=>q.artifacts.some(a=>a.stage==="analysis"&&a.kind==="stage-draft"&&currentArtifact(q,a));label="original independent A draft";}
    else if(!read(draft.id))args={operation:"read",artifactId:draft.id};
    else if(!critique){const a=projection(run(ids[0]).id);if(p.fusion.attempts.find(x=>x.id===a.attemptId)?.state!=="succeeded"){wait=q=>q.fusion.attempts.find(x=>x.id===a.attemptId)?.state==="succeeded";label="original A native natural completion";}else args=publish("stage-critique",[draft.id],undefined," INITIAL_CRITIQUE：请保留未变计算，导师下一步仅调整比较变量；本意见触发真实交接。");}
   }else if(role==="librarian"&&!get("stage-material"))args=publish("stage-material",[],undefined," 已实际读取设计与CSV原件；保留所有原始行。");
   else if(role==="mentor"){
    const permitted=sourceFinished(p)&&p.fusion.attempts.some(a=>a.taskId==="v"+p.revision+":analysis:lead"&&a.state==="running"&&!sourceAttempts(p).some(s=>s.id===a.id));
    let released=false;try{await access(release);released=true;}catch{}
    if(!permitted||!released){wait=async q=>{try{await access(release);}catch{return false;}return sourceFinished(q)&&q.fusion.attempts.some(a=>a.taskId==="v"+q.revision+":analysis:lead"&&a.state==="running"&&!sourceAttempts(q).some(s=>s.id===a.id));};label="six finished source runs and explicit fixture release";}
    else {const old=registry.plans.find(plan=>plan.id===ids[1]&&plan.version===1);const {registration,...fields}=old;args={operation:"register-analysis",plan:{...fields,version:2,label:"比较模型 z（事后修订）",columns:["z"],registrationReason:"首轮结果后明确仅把比较自变量由x改为z；主模型及描述计划未变。",timing:"post-hoc"}};tag="change-comparison";}
   }
  }else{
   if(role==="lead"){
    const missing=unchanged.find(id=>!adopted(run(id).id,"lead"));
    const unread=unchanged.find(id=>!readRun(run(id).id));
    if(missing)args={operation:"reuse-analysis",analysisId:run(missing).id,reason:"仅比较计划变化；本项计划闭包、数据和引擎未变，明确采用本人原计算。"};
    else if(unread)args={operation:"read-registered-analysis",analysisId:run(unread).id};
    else if(!run(ids[1],"lead",2))args={operation:"run-analysis",planId:ids[1],planVersion:2};
    else if(!readRun(run(ids[1],"lead",2).id))args={operation:"read-registered-analysis",analysisId:run(ids[1],"lead",2).id};
    else if(!draft&&!own.some(r=>r.callId.endsWith("_expired-numeric-render"))){args={operation:"numeric-render",runId:run(ids[1],"lead",1).id,path:["regression","sampleSize"],quantity:"sample-size",unit:"",decimalPlaces:0,rounding:"half-away-from-zero"};tag="expired-numeric-render";}
    else if(!draft)args=publish("stage-draft",[previous.id],undefined," CURRENT_INDEPENDENT_DRAFT：主模型和描述明确复用；比较z为新计算。先独立表述本轮边界。");
    else if(!critique){wait=q=>q.artifacts.some(a=>a.stage==="analysis"&&a.kind==="stage-critique"&&currentArtifact(q,a));label="current B critique";}
    else if(!revision)args=read(critique.id)?publish("stage-revision",[critique.id],undefined," CURRENT_ANALYSIS_REVISION：逐条说明哪些为既有计算的本轮采用、哪些为比较模型新实算；原六运行与档案未改，B须本轮重新解释。"):{operation:"read",artifactId:critique.id};
   }else if(role==="reviewer"){
    const missing=unchanged.find(id=>!adopted(run(id,"reviewer").id,"reviewer"));
    if(missing&&!adopted(run(missing).id,"lead")){wait=q=>q.analysisRunAdoptions?.some(a=>a.pin.runId===run(missing).id&&a.target.role==="lead");label="A explicit unchanged-result adoption";}
    else if(missing)args={operation:"reuse-analysis",analysisId:run(missing,"reviewer").id,reason:"明确采用本人已匹配的原复跑，A原运行现已有效；此采用不等于新复跑或新解释。"};
    else {
     const unread=ids.find(id=>{const r=run(id,"lead",id===ids[1]?2:1);return !r||!readRun(r.id);});
     if(unread){const r=run(unread,"lead",unread===ids[1]?2:1);if(!r){wait=q=>q.analysisRegistry?.runs.some(r=>r.planId===unread&&r.planVersion===2&&r.actor==="model:lead");label="new comparison A run";}else args={operation:"read-registered-analysis",analysisId:r.id};}
     else if(!run(ids[1],"reviewer",2))args={operation:"run-analysis",planId:ids[1],planVersion:2,replayOf:run(ids[1],"lead",2).id};
     else if(ids.some(id=>!reviewed(id,id===ids[1]?2:1))){const id=ids.find(id=>!reviewed(id,id===ids[1]?2:1)),version=id===ids[1]?2:1;args={operation:"review-analysis",planId:id,planVersion:version,analysisId:run(id,"lead",version).id,verdict:"accept",content:baseText+" CURRENT_INTERPRETATION：本native实际重新取得数字后独立解释；未变项保持原样本和结果，比较z为本轮重算，旧解释不复用。"};}
     else if(!risk)args=publish("stage-risk",[previous.id],undefined," CURRENT_INDEPENDENT_RISK：区分采用与实算，重新核对当前样本和解释。");
     else if(!draft){wait=q=>q.artifacts.some(a=>a.stage==="analysis"&&a.kind==="stage-draft"&&currentArtifact(q,a));label="current A independent draft";}
     else if(!critique)args=read(draft.id)?publish("stage-critique",[draft.id],undefined," CURRENT_CRITIQUE：请明确保留原计算身份及新采用身份，比较项仅新增两次运行；不可称作普遍自动复用。"):{operation:"read",artifactId:draft.id};
     else if(!revision){wait=q=>q.artifacts.some(a=>a.stage==="analysis"&&a.kind==="stage-revision"&&currentArtifact(q,a));label="current A revision";}
     else if(!verification)args=read(revision.id)?publish("stage-verification",[revision.id],"accept"," 当前实际取得、重新解释和新比较复跑已核查；仅接受有限软件分析交付。"): {operation:"read",artifactId:revision.id};
    }
   }else if(role==="librarian"&&!get("stage-material"))args=publish("stage-material",[],undefined," 原始设计和CSV未改，补充指出比较模型事后变化。");
   else if(role==="mentor"){
    if(!revision||!verification){wait=q=>q.artifacts.some(a=>a.stage==="analysis"&&a.kind==="stage-verification"&&a.verdict==="accept"&&currentArtifact(q,a));label="current analysis verification";}
    else {const unread=ids.map(id=>run(id,"lead",id===ids[1]?2:1)).find(r=>!readRun(r.id));if(unread)args={operation:"read-registered-analysis",analysisId:unread.id};else if(!read(revision.id))args={operation:"read",artifactId:revision.id};else if(!read(verification.id))args={operation:"read",artifactId:verification.id};else if(!get("stage-review"))args=publish("stage-review",[revision.id,verification.id],"accept"," S6当前输入交付可接受，接续S7；本演练在S7无稿停止，不是完整论文。");}
   }
  }
  if(wait){await waitFor(async()=>wait(state()),options?.signal,label);args={operation:"status"};}
  const callId="reuse_"+attempt.id+"_"+messages.length+"_"+(tag??args?.operation??"text"),requestId=randomUUID();
  const content=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:phase==="writing"?"REUSE_WRITING_BOUNDARY：S6已接受；S7无稿，本演练不声称完整论文。":"当前任务到达自然结束边界；等待真实交接，不自动重放计算。"}];
  const message={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
  const log=async type=>{const row={type,at:new Date().toISOString(),role,attemptId:attempt.id,nativeRunId:attempt.nativeRunId,requestId,operation:args?.operation,kind:args?.kind,planId:args?.planId??args?.plan?.id};await appendFile(transportJournal+"/"+role+".jsonl",JSON.stringify(row)+"\n");};
  await log("request");if(options?.signal?.aborted)throw Error("Reuse response aborted");
  stream.push({type:"start",partial:{...message,content:[]}});
  if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:content[0],partial:message});}else stream.push({type:"text_delta",contentIndex:0,delta:content[0].text,partial:message});
  await log("response");stream.push({type:"done",reason:message.stopReason,message});
 };
 void emit().catch(error=>stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}}));
 return stream;
 }});}});}
`,
  );
  return {
    ...fixture,
    releaseComparisonChange: () =>
      writeFile(release, "release only the deterministic response barrier\n"),
    readReuseJournal: async (): Promise<AnalysisReuseProviderRecord[]> => {
      const content = await readFile(journal, "utf8");
      return content.trim()
        ? content
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as AnalysisReuseProviderRecord)
        : [];
    },
  };
}
