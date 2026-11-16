import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { writeProjectExtension } from "./electron-app";
import { setupResearchFusionRecoveryFixture } from "./research-fusion-recovery-provider";

export const REGISTRY_PLAN_IDS = ["registry-primary", "registry-comparison", "registry-describe"];
export const REGISTRY_CSV = "x,z,y\n1,0,3\n2,1,5\n3,0,8\n4,1,9\n5,0,12\n6,1,12\n7,,16\n8,0,\n";

/** Actual Pi tools use UI-adopted synthetic files; no analysis or accepted stage is seeded. */
export async function setupResearchAnalysisRegistryFixture() {
  const fixture = await setupResearchFusionRecoveryFixture();
  const design = join(fixture.workspace, "registry-design.txt");
  const csv = join(fixture.workspace, "registry-data.csv");
  await writeFile(
    design,
    "合成软件验收方案：观察x、z与y的关联，主模型OLS包含x和z，比较模型仅x。比较和描述明确选原始行2至7；保留原始缺失行与排除说明，不把派生样本叫原始全样本。不声称因果、p值或置信区间。尚未执行分析。\n",
  );
  await writeFile(csv, REGISTRY_CSV);
  await writeProjectExtension(
    fixture.workspace,
    "research-recovery-fixture.ts",
    String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { watch } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const profile=${JSON.stringify(fixture.profile)},stateFile=${JSON.stringify(join(fixture.profile, "research-groups.json"))},journal=${JSON.stringify(join(fixture.profile, "recovery-provider-journal"))};
const ids=${JSON.stringify(REGISTRY_PLAN_IDS)};
const state=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects[0];
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const waitFor=(predicate,signal)=>new Promise((resolve,reject)=>{
 let ended=false,checking=false,dirty=false;
 const end=error=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
 const abort=()=>end(new Error("Registry fixture wait aborted"));
 const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(error){end(error);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
 const watcher=watch(profile,()=>{void check();});const timer=setTimeout(()=>end(new Error("Registry fixture required handoff missing")),30000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else void check();
});
export default function(pi){
 pi.registerProvider("research-recovery-fixture",{baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-recovery-fixture",models:[{id:"gpt-6.1-sol",name:"Registry deterministic fixture",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,context,options){
 const stream=createAssistantMessageEventStream();
 const emit=async()=>{
  const messages=context.messages;if(messages.length>650)throw new Error("Registry bounded fixture exceeded tool budget");
  const failed=messages.find(m=>m.role==="toolResult"&&m.isError);if(failed)throw new Error("Registry tool failed: "+JSON.stringify(failed.content));
  const match=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n").match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
  if(!match)throw new Error("Registry member instruction missing");
  const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]];
  const p=await state(),attempt=p.fusion.attempts.findLast(a=>["prepared","running"].includes(a.state)&&p.fusion.tasks.find(t=>t.id===a.taskId)?.role===role);
  if(!attempt)throw new Error("Registry provider has no native attempt");
  const task=p.fusion.tasks.find(t=>t.id===attempt.taskId),phase=task.stage;
  const results=messages.flatMap(m=>{if(m.role!=="toolResult"||!m.toolCallId?.includes(attempt.id))return [];try{const parsed=JSON.parse(m.content.filter(c=>c.type==="text").map(c=>c.text).join(""));return [{data:parsed.nextStage?parsed.result:parsed,callId:m.toolCallId}];}catch{return [];}});
  const get=(kind,stage=phase)=>p.artifacts.findLast(a=>a.revision===p.revision&&a.stage===stage&&a.kind===kind);
  const read=id=>results.some(r=>r.callId.endsWith("_read")&&r.data.id===id);
  const readRun=id=>results.some(r=>r.callId.endsWith("_read-registered-analysis")&&r.data.id===id);
  const sourceIds=p.evidence.sources.filter(s=>results.some(r=>r.callId.endsWith("_source-read")&&r.data.id===s.id&&r.data.sha256===s.sha256)).map(s=>s.id);
  const previous=phase==="analysis"?get("stage-review","design"):undefined;
  const refs=previous?[previous.id]:[];
  const draft=get("stage-draft"),risk=get("stage-risk"),critique=get("stage-critique"),revision=get("stage-revision"),verification=get("stage-verification");
  const registry=p.analysisRegistry??{plans:[],runs:[],reviews:[]};
  const original=id=>registry.runs.find(r=>r.planId===id&&r.actor==="model:lead");
  const replay=id=>registry.runs.find(r=>r.planId===id&&r.actor==="model:reviewer"&&r.verification.level==="same-engine-replay");
  const reviewed=id=>registry.reviews.some(r=>r.planId===id&&r.runId===original(id)?.id&&r.actor==="model:reviewer"&&r.verdict==="accept");
  const analysisIds=registry.runs.filter(r=>r.actor==="model:"+role||readRun(r.id)).map(r=>r.id);
  const base="FR05确定性软件验收的合成研究文本；只验证分析登记、真实计算及复跑链，不是真实研究发现。主模型x和z、比较模型x预测y，明确原始8行与共同完整6行；缺失与排除单列，OLS只支持观察关联，不宣称因果、p值或置信区间。同引擎复跑不是独立算法审阅，模型接受不是人类专家决定。";
  const publish=(kind,needed=[],verdict)=>({operation:"publish",revision:p.revision,stage:phase,kind,refs:needed,sourceIds,content:base+(kind==="stage-critique"?"具体批评：区分共同样本与原始全样本，明确缺失和模型限制。":kind==="stage-revision"?"逐条回应：保留原始8行，完整案例6行，比较明确选择同一6行，不报告未支持统计量。":"完成本角色实际分析/审阅工作。"),...(phase==="analysis"?{analysisIds}:{}),...(verdict?{verdict}:{})});
  const plan=index=>({id:ids[index],version:1,label:["主模型 x+z","比较模型 x","同样本描述"][index],purpose:["primary","comparison","descriptive"][index],objective:"比较相同样本上的观察关联，并保留完整样本审计。",dataset:{id:p.evidence.datasets[0].id},method:index===2?"describe":"ols",columns:index===0?["x","z"]:index===1?["x"]:["x","z","y"],...(index<2?{outcome:"y"}:{}),parameters:{missingPolicy:index===2?"per-variable":"complete-case",...(index<2?{intercept:true}:{})},outputs:index===2?["descriptive","sample-accounting"]:["regression.coefficients","regression.rSquared","sample-accounting"],reviewPlan:"B实际读取A结果，按同一计划同引擎复跑，另行解释审阅；不冒充独立算法。",registrationReason:"提供方案事前指定主模型及比较，并明确共同完整行。",timing:"prospective",sample:index===0?{mode:"all"}:{mode:"selected-rows",id:"shared-six",sourceLines:[2,3,4,5,6,7],reason:"主模型所需x/z/y完整案例；保留原始行8和9未选入记录。"},...(index===1?{compareWith:{planId:ids[0],planVersion:1,requireSameSample:true}}:{})});
  let args,wait;
  if(!results.some(r=>r.callId.endsWith("_status")))args={operation:"status"};
  else if(phase==="writing")args=undefined;
  else if(!["design","analysis"].includes(phase))throw new Error("Unexpected registry fixture stage "+phase);
  else if(!results.some(r=>r.callId.endsWith("_knowledge")))args={operation:"knowledge",query:"研究问题 证据 研究设计"};
  else if(previous&&!read(previous.id))args={operation:"read",artifactId:previous.id};
  else if(sourceIds.length<p.evidence.sources.length)args={operation:"source-read",sourceId:p.evidence.sources.find(s=>!sourceIds.includes(s.id)).id};
  else if(!results.some(r=>r.callId.endsWith("_analysis-registry")))args={operation:"analysis-registry"};
  else if(phase==="design"&&role==="lead"&&registry.plans.length<3)args={operation:"register-analysis",plan:plan(registry.plans.length)};
  else if(phase==="analysis"&&role==="lead"&&ids.some(id=>!original(id)))args={operation:"run-analysis",planId:ids.find(id=>!original(id)),planVersion:1};
  else if(phase==="analysis"&&role==="reviewer"&&ids.some(id=>!reviewed(id))){
   const id=ids.find(id=>!reviewed(id)),run=original(id);
   if(!run)wait=q=>ids.every(id=>q.analysisRegistry?.runs.some(r=>r.planId===id&&r.actor==="model:lead"));
   else if(!readRun(run.id))args={operation:"read-registered-analysis",analysisId:run.id};
   else if(!replay(id))args={operation:"run-analysis",planId:id,planVersion:1,replayOf:run.id};
   else args={operation:"review-analysis",planId:id,planVersion:1,analysisId:run.id,verdict:"accept",content:base+"已核对该计划原始8行、实际6行、缺失/排除和系数解释；同引擎复跑一致，只接受观察关联解释。"};
  }
  else if(role==="librarian"&&!get("stage-material"))args=publish("stage-material");
  else if(role==="lead"&&!draft)args=publish("stage-draft",refs);
  else if(role==="reviewer"&&!risk)args=publish("stage-risk",refs);
  else if(role==="lead"&&!critique)wait=q=>q.artifacts.some(a=>a.stage===phase&&a.kind==="stage-critique");
  else if(role==="lead"&&!revision)args=read(critique.id)?publish("stage-revision",[critique.id]):{operation:"read",artifactId:critique.id};
  else if(role==="reviewer"&&!draft)wait=q=>q.artifacts.some(a=>a.stage===phase&&a.kind==="stage-draft");
  else if(role==="reviewer"&&!critique)args=read(draft.id)?publish("stage-critique",[draft.id]):{operation:"read",artifactId:draft.id};
  else if(role==="reviewer"&&!revision)wait=q=>q.artifacts.some(a=>a.stage===phase&&a.kind==="stage-revision");
  else if(role==="reviewer"&&!verification)args=read(revision.id)?publish("stage-verification",[revision.id],"accept"):{operation:"read",artifactId:revision.id};
  else if(role==="mentor"&&(!revision||!verification))wait=q=>q.artifacts.some(a=>a.stage===phase&&a.kind==="stage-verification");
  else if(role==="mentor"&&!get("stage-review"))args=!read(revision.id)?{operation:"read",artifactId:revision.id}:!read(verification.id)?{operation:"read",artifactId:verification.id}:publish("stage-review",[revision.id,verification.id],"accept");
  if(wait){await waitFor(async()=>wait(await state()),options?.signal);args={operation:"status"};}
  const requestId=randomUUID(),callId="registry_"+attempt.id+"_"+messages.length+"_"+(args?.operation??"text");
  const output=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:phase==="writing"?"REGISTRY_BOUNDARY: S6实际分析与模型审阅已完成，S7尚无稿件，本测试不宣称完整论文。":"当前登记/分析工作已交付，等待实际交接。"}];
  const message={role:"assistant",content:output,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
  const log=type=>appendFile(journal+"/"+role+".jsonl",JSON.stringify({at:new Date().toISOString(),role,requestId,type,attemptId:attempt.id,nativeRunId:attempt.nativeRunId,operation:args?.operation,kind:args?.kind,planId:args?.planId??args?.plan?.id})+"\n");
  await log("request");if(options?.signal?.aborted)throw new Error("Registry response aborted");
  stream.push({type:"start",partial:{...message,content:[]}});
  if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:output[0],partial:message});}else stream.push({type:"text_delta",contentIndex:0,delta:output[0].text,partial:message});
  await log("response");stream.push({type:"done",reason:message.stopReason,message});
 };
 void emit().catch(error=>stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}}));
 return stream;
 }});
}
`,
  );
  return { ...fixture, design, csv };
}
