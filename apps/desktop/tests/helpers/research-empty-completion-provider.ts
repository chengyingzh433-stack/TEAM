import { writeProjectExtension } from "./electron-app";
import { setupResearchFusionRecoveryFixture } from "./research-fusion-recovery-provider";
import { join } from "node:path";

/** Reuses isolated files/config/launcher; replaces only the local provider before launch. */
export async function setupResearchEmptyCompletionFixture() {
  const fixture = await setupResearchFusionRecoveryFixture();
  await writeProjectExtension(
    fixture.workspace,
    "research-recovery-fixture.ts",
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { watch } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const profile=${JSON.stringify(fixture.profile)}, stateFile=${JSON.stringify(join(fixture.profile, "research-groups.json"))}, journal=${JSON.stringify(join(fixture.profile, "recovery-provider-journal"))};
const state=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects[0];
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
// Persisted real tool effects wake blocked responses; timeout is only a failure bound.
const waitFor=(predicate,signal)=>new Promise((resolve,reject)=>{
 let ended=false,checking=false,dirty=false;
 const end=error=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
 const abort=()=>end(new Error("Fixture response aborted"));
 const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(error){end(error);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
 const watcher=watch(profile,()=>{void check();});
 const timer=setTimeout(()=>end(new Error("Expected actual handoff did not arrive")),30000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else void check();
});
export default function(pi){
 pi.registerProvider("research-recovery-fixture",{baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-recovery-fixture",models:[{id:"gpt-6.1-sol",name:"Empty completion local fixture",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
 streamSimple(model,context,options){
  const messages=context.messages;
  if(messages.length>250)throw new Error("Empty completion fixture exceeded bounded tool budget");
  const failed=messages.find(m=>m.role==="toolResult"&&m.isError);
  if(failed)throw new Error("Real research tool failure: "+JSON.stringify(failed.content));
  const instructions=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\\n");
  const match=instructions.match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
  if(!match)throw new Error("Member instruction missing");
  const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]];
  const results=messages.flatMap((m,index)=>{if(m.role!=="toolResult")return [];try{const parsed=JSON.parse(m.content.filter(c=>c.type==="text").map(c=>c.text).join(""));return [{data:parsed.nextStage?parsed.result:parsed,index,callId:m.toolCallId}];}catch{return [];}});
  const statusResult=results.filter(r=>Array.isArray(r.data.artifacts)&&r.data.currentStage).at(-1),status=statusResult?.data;
  const own=results.filter(r=>r.data.delivery&&r.data.role===role);
  const known=[...(status?.artifacts??[]),...results.filter(r=>r.data.kind).map(r=>r.data)];
  const get=kind=>known.findLast(a=>a.stage==="question"&&a.kind===kind);
  const read=id=>results.some(r=>r.callId.endsWith("_read")&&r.data.id===id);
  const sources=["RECOVERY-A","RECOVERY-B"],sourceIds=sources.filter(id=>results.some(r=>r.data.access&&r.data.id===id));
  const material=get("stage-material"),draft=get("stage-draft"),risk=get("stage-risk"),critique=get("stage-critique"),revision=get("stage-revision"),verification=get("stage-verification");
  const base="确定性软件验收合成文本，不是真实研究发现。问题仅为实验报告中的证据使用与观察关联；满意度不能代替论证质量，不声称因果或统计结果。提供材料经真实 source-read 读取。缺数据、测量和伦理条件时保留待核验，范围止于问题卡。";
  const publish=(kind,refs=[],verdict)=>({operation:"publish",revision:status.revision,stage:"question",kind,refs,sourceIds,content:base+(kind==="stage-critique"?"批评：明确关联边界与样本限制。":kind==="stage-revision"?"逐条修订：删除因果措辞并记录样本限制。":kind==="stage-verification"?"核对修订已回应批评。":"指定范围的合成交付。"),...(verdict?{verdict}:{})});
  const readArg=id=>({operation:"read",artifactId:id});
  const stream=createAssistantMessageEventStream();
  const emit=async()=>{
   const p=await state(),attempt=p.fusion.attempts.findLast(a=>a.taskId==="v1:question:"+role&&["prepared","running"].includes(a.state));
   if(!attempt)throw new Error("No real native attempt for provider request");
   const emptyMentor=role==="mentor"&&!p.fusion.tasks.find(t=>t.id===attempt.taskId).continuations.some(c=>c.attemptId===attempt.id);
   let args,needed;
   if(!statusResult||statusResult.index<messages.findLastIndex(m=>m.role==="user")||statusResult.index<(own.at(-1)?.index??-1))args={operation:"status"};
   // The first mentor request finishes normally after a real status tool, without publish.
   else if(emptyMentor)args=undefined;
   else if(status.status!=="running")args=undefined;
   else if(!results.some(r=>Array.isArray(r.data.records)&&r.data.stage==="question"))args={operation:"knowledge",query:"研究问题 证据 研究设计"};
   else if(sourceIds.length<sources.length)args={operation:"source-read",sourceId:sources.find(id=>!sourceIds.includes(id))};
   else if(role==="librarian"&&!material)args=publish("stage-material");
   else if(role==="reviewer"&&!risk)args=publish("stage-risk");
   else if(role!=="librarian"&&role!=="mentor"&&!material)needed="stage-material";
   else if(role!=="librarian"&&role!=="mentor"&&!read(material.id))args=readArg(material.id);
   else if(role==="lead"&&!draft)args=publish("stage-draft");
   else if(role==="lead"&&!critique)needed="stage-critique";
   else if(role==="lead"&&!revision)args=read(critique.id)?publish("stage-revision",[critique.id]):readArg(critique.id);
   else if(role==="reviewer"&&!draft)needed="stage-draft";
   else if(role==="reviewer"&&!critique)args=read(draft.id)?publish("stage-critique",[draft.id]):readArg(draft.id);
   else if(role==="reviewer"&&!revision)needed="stage-revision";
   else if(role==="reviewer"&&!verification)args=read(revision.id)?publish("stage-verification",[revision.id],"accept"):readArg(revision.id);
   else if(role==="mentor"&&!get("stage-review"))args=!read(verification.id)?readArg(verification.id):!read(revision.id)?readArg(revision.id):publish("stage-review",[revision.id,verification.id],"accept");
   if(needed){await waitFor(async()=> (await state()).artifacts.some(a=>a.kind===needed&&a.stage==="question"),options?.signal);args={operation:"status"};}
   const requestId=randomUUID(),callId="empty_"+role+"_"+messages.length+"_"+(args?.operation??"text");
   const content=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:emptyMentor?"EMPTY_COMPLETION: 本次正常结束，尚未发布导师裁定。":"本成员实际交付已完成。"}];
   const message={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
   const log=type=>appendFile(journal+"/"+role+".jsonl",JSON.stringify({at:new Date().toISOString(),role,requestId,type,attemptId:attempt.id,nativeRunId:attempt.nativeRunId,operation:args?.operation,kind:args?.kind})+"\\n");
   await log("request");
   if(options?.signal?.aborted)throw new Error("Fixture response aborted");
   stream.push({type:"start",partial:{...message,content:[]}});
   if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:content[0],partial:message});}
   else stream.push({type:"text_delta",contentIndex:0,delta:content[0].text,partial:message});
   await log("response");stream.push({type:"done",reason:message.stopReason,message});
  };
  void emit().catch(error=>stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}}));
  return stream;
 }});
}
`,
  );
  return fixture;
}
