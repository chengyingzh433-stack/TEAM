import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupResearchFusionRecoveryFixture } from "./research-fusion-recovery-provider";
import { writeProjectExtension } from "./electron-app";

export const LANGUAGE_BASE =
  "# 讨论\n\n本研究样本 n=120。学习支持与成绩可能有关，但未发现显著差异，不能据此推断因果。研究只覆盖本次提供的样本，保留测量、选择及实施边界；本稿为合成软件流程测试，不是实际研究结果或人类研究批准。\n\n# AI使用说明\n\n本文使用AI辅助语言编辑，作者核对内容。";
export const LANGUAGE_TARGET = LANGUAGE_BASE.replace("可能有关", "可能存在关联");
export interface LanguageFixtureEvent {
  type: "request" | "result";
  role: string;
  at: string;
  callId: string;
  text?: string;
  isError?: boolean;
  args?: Record<string, unknown>;
  data?: unknown;
  attemptId: string;
  nativeRunId: string;
}
function decodeLanguageFixtureEvent(raw: unknown): LanguageFixtureEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid language fixture record");
  const value = raw as Record<string, unknown>;
  if (
    !["request", "result"].includes(String(value.type)) ||
    ["role", "at", "callId", "attemptId", "nativeRunId"].some(
      (key) => typeof value[key] !== "string",
    ) ||
    (value.type === "result" &&
      (typeof value.text !== "string" || typeof value.isError !== "boolean"))
  )
    throw new Error("Invalid language fixture identity/result");
  return value as unknown as LanguageFixtureEvent;
}

/** Real Pi tools and Electron, deterministic provider; no external semantic R proof. */
export async function setupResearchLanguageFixture(
  mode: "first-draft" | "language" | "language-inherit",
) {
  const fixture = await setupResearchFusionRecoveryFixture();
  const manuscript = join(fixture.workspace, "provided-chapter.txt");
  await writeFile(manuscript, LANGUAGE_BASE);
  const journal = join(fixture.profile, "language-native-tools.jsonl");
  await writeFile(journal, "");
  const source = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFile, appendFile } from "node:fs/promises";
import { watch } from "node:fs";
import { randomUUID } from "node:crypto";
const profile=${JSON.stringify(fixture.profile)}, stateFile=${JSON.stringify(join(fixture.profile, "research-groups.json"))}, journal=${JSON.stringify(journal)}, mode=${JSON.stringify(mode)}, baseline=${JSON.stringify(LANGUAGE_BASE)}, target=${JSON.stringify(LANGUAGE_TARGET)};
const state=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects[0];
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const recorded=new Set();
const waitFor=(predicate,signal)=>new Promise((resolve,reject)=>{
 let ended=false,checking=false,dirty=false;
 const end=error=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
 const abort=()=>end(new Error("Language fixture aborted"));
 const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(error){end(error);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
 const watcher=watch(profile,()=>{void check();}),timer=setTimeout(()=>end(new Error("Language fixture observable user/handoff state missing")),45000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else void check();
});
export default function(pi){pi.registerProvider("research-recovery-fixture",{baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-recovery-fixture",models:[{id:"gpt-6.1-sol",name:"Language and first-draft deterministic fixture",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,context,options){
 const stream=createAssistantMessageEventStream();
 const emit=async()=>{
  const messages=context.messages;
  if(messages.length>300)throw new Error("Language fixture bounded conversation exceeded");
  const match=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n").match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
  if(!match)throw new Error("Language fixture role missing");
  const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]],p=await state();
  const attempt=p.fusion.attempts.findLast(a=>["prepared","running"].includes(a.state)&&p.fusion.tasks.find(t=>t.id===a.taskId)?.role===role);
  if(!attempt)throw new Error("Language fixture actual attempt missing");
  const task=p.fusion.tasks.find(t=>t.id===attempt.taskId),results=[];
  for(const m of messages.filter(m=>m.role==="toolResult"&&m.toolName==="research_group")){
   const tc=messages.filter(m=>m.role==="assistant").flatMap(m=>m.content).find(c=>c.type==="toolCall"&&c.id===m.toolCallId);
   const args=tc?.arguments??{},text=m.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");let data;try{const parsed=JSON.parse(text);data=parsed.result??parsed;}catch{}
   if(m.isError&&!m.toolCallId.endsWith("_probe-independent")&&!m.toolCallId.endsWith("_probe-language-gate"))throw new Error("Unexpected language fixture tool failure: "+text);
   const key=role+":"+m.toolCallId;
   if(!recorded.has(key)){recorded.add(key);await appendFile(journal,JSON.stringify({type:"result",role,at:new Date().toISOString(),callId:m.toolCallId,args,data,text,isError:!!m.isError,attemptId:attempt.id,nativeRunId:attempt.nativeRunId})+"\n");}
   results.push({args,data,text,error:!!m.isError,id:m.toolCallId});
  }
  const own=results.filter(r=>r.id.includes(attempt.id)),done=tag=>results.some(r=>r.id.endsWith("_"+tag)),read=id=>own.some(r=>r.args.operation==="read"&&r.data?.id===id&&!r.error);
  const get=kind=>p.artifacts.findLast(a=>a.stage===task.stage&&a.kind===kind&&a.revision===p.revision);
  const draft=get("stage-draft"),risk=get("stage-risk"),revision=get("stage-revision"),verification=get("stage-verification"),review=get("stage-review");
  const pkg=p.methodPackages?.find(pkg=>pkg.rootIds.includes("RECOVERY-METHOD")),app=p.methodApplications?.find(a=>a.actor.id==="model:lead"),opinion=p.methodContentOpinions?.find(o=>o.applicationId===app?.id&&o.verdict==="support"),adjudication=p.methodAdjudications?.find(a=>a.applicationId===app?.id&&a.verdict==="accept");
  const sourceIds=(p.evidence?.sources??[]).filter(s=>own.some(r=>r.args.operation==="source-read"&&r.data?.id===s.id&&!r.error)).map(s=>s.id);
  const text="合成软件验收，当前证据只允许有限的低风险问题或语言改写。A与B按共同原始输入分别判断，保留所有未知条件及方法边界；没有数据采集、因果发现或人类审批。此份首稿无需制造额外问题，必要审阅可直接接受。";
  const publish=(kind,refs=[],verdict,content=text)=>({operation:"publish",revision:p.revision,stage:task.stage,kind,refs,sourceIds,content,...(verdict?{verdict}:{})});
  let args,tag,wait;
  if(!own.some(r=>r.args.operation==="status"))args={operation:"status"};
  else if(p.status!=="running"||review)args=undefined;
  else if(role==="librarian")args=undefined;
  else if(!own.some(r=>r.args.operation==="method-package"))args=pkg?{operation:"method-package",packageId:pkg.id}:{operation:"method-package",ids:["RECOVERY-METHOD"]};
  else if(sourceIds.length<(p.evidence?.sources??[]).length)args={operation:"source-read",sourceId:p.evidence.sources.find(s=>!sourceIds.includes(s.id)).id};
  else if(role==="lead"){
   if(!app)args={operation:"method-apply",packageId:pkg.id,recordIds:["RECOVERY-METHOD"],methodSelection:"有限证据与范围约束",applicabilityExplanation:"把本测试交付限定为问题或指定段落，明确合成材料、真实工具和语义证明的区别；不提出因果或全国外推。",nonApplicableConditions:["无实测数据不能报告实证结论"],limitations:"合成软件方法内容不能替代真实研究方法论验收。",scoringClaim:"not-scored"};
   else if(!draft)args=publish("stage-draft",[],undefined,mode!=="first-draft"?baseline:text);
   else if(mode==="first-draft")args=undefined;
   else if(!p.languageScopes?.length){if(mode!=="language-inherit")wait=async()=>!!(await state()).languageScopes?.length;}
   else if(!revision){
    if(!read(draft.id))args={operation:"read",artifactId:draft.id};
    else args={...publish("stage-revision",[draft.id],undefined,target),languageBaselineId:draft.id,languageScopeId:p.languageScopes.at(-1).id};
   }else{
    const lr=p.languageRevisions.find(r=>r.target.id===revision.id);
    const unread=["baseline","target"].find(side=>!own.some(r=>r.args.operation==="language-read"&&r.args.languageRevisionId===lr.id&&r.args.side===side));
    if(lr.semanticReviews.some(r=>r.actor.role==="lead"))args=undefined;
    else if(unread)args={operation:"language-read",languageRevisionId:lr.id,side:unread,start:0,end:lr[unread].body.length};
    else if(!lr.semanticReviews.some(r=>r.actor.role==="lead"))args={operation:"language-review",languageReview:{revisionId:lr.id,classification:"meaning-preserved",reason:"合成软件夹具只将可能有关改为可能存在关联；样本、否定、因果限制、数值与AI说明均保留，不是外部模型语义C。",coverage:lr.programReport.units.map(u=>({unitId:u.id,baseline:u.baseline,target:u.target}))}};
   }
  }else if(role==="reviewer"){
   if(!draft)wait=async()=>!!(await state()).artifacts.find(a=>a.kind==="stage-draft");
   else if(!done("probe-independent")){args={operation:"read",artifactId:draft.id};tag="probe-independent";}
   else if(!risk)args=publish("stage-risk");
   else if(mode!=="first-draft"&&!revision)wait=async()=>!!(await state()).languageRevisions?.length;
   else{
    const targetArtifact=mode!=="first-draft"?revision:draft;
    const lr=mode!=="first-draft"?p.languageRevisions.find(r=>r.target.id===targetArtifact.id):undefined;
    if(!read(targetArtifact.id))args={operation:"read",artifactId:targetArtifact.id};
    else if(!own.some(r=>r.args.operation==="method-check"))args={operation:"method-check",packageId:pkg.id,applicationId:app.id};
    else if(!opinion)args={operation:"method-opinion",packageId:pkg.id,applicationId:app.id,verdict:"support",note:"B在本合成软件任务实际读取同包与当前稿，范围明确，无完整版评分或因果宣称；支持此有限方法应用。"};
    else if(lr&&!done("probe-language-gate")){args=publish("stage-verification",[targetArtifact.id],"accept");tag="probe-language-gate";}
    else if(lr){
     const unread=["baseline","target"].find(side=>!own.some(r=>r.args.operation==="language-read"&&r.args.languageRevisionId===lr.id&&r.args.side===side));
     if(unread)args={operation:"language-read",languageRevisionId:lr.id,side:unread,start:0,end:lr[unread].body.length};
     else if(!lr.semanticReviews.some(r=>r.actor.role==="reviewer"))args={operation:"language-review",languageReview:{revisionId:lr.id,classification:"meaning-preserved",reason:"B本人读取双稿；本合成片段只改变关联措辞，未删否定、未改样本或因果边界；此预定内容不能充当真实模型C。",coverage:lr.programReport.units.map(u=>({unitId:u.id,baseline:u.baseline,target:u.target}))}};
     else if(!lr.semanticReviews.some(r=>r.actor.role==="lead"))wait=async()=>!!(await state()).languageRevisions.find(r=>r.id===lr.id).semanticReviews.some(r=>r.actor.role==="lead");
     else if(!verification)args=publish("stage-verification",[targetArtifact.id],"accept");
    }else if(!verification)args=publish("stage-verification",[targetArtifact.id],"accept");
   }
  }else{
   if(!verification)wait=async()=>!!(await state()).artifacts.find(a=>a.kind==="stage-verification");
   else if(!read((revision??draft).id))args={operation:"read",artifactId:(revision??draft).id};
   else if(!read(verification.id))args={operation:"read",artifactId:verification.id};
   else if(!adjudication)args={operation:"method-adjudicate",packageId:pkg.id,applicationId:app.id,opinionIds:[opinion.id],verdict:"accept",note:"导师Agent实际同包、当前稿与B意见均已读取；只裁定本合成软件交付的方法范围，不代用户确认。"};
   else args=publish("stage-review",[(revision??draft).id,verification.id],"accept");
  }
  if(wait){await waitFor(wait,options?.signal);args={operation:"status"};tag=undefined;}
  const callId="language_"+attempt.id+"_"+randomUUID()+"_"+(tag??args?.operation??"text");
  const output=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:"本次合成软件流程已交付。"}];
  const message={role:"assistant",content:output,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
  await appendFile(journal,JSON.stringify({type:"request",role,at:new Date().toISOString(),callId,args,attemptId:attempt.id,nativeRunId:attempt.nativeRunId})+"\n");
  if(options?.signal?.aborted)throw new Error("Language fixture aborted");
  stream.push({type:"start",partial:{...message,content:[]}});
  if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:output[0],partial:message});}else stream.push({type:"text_delta",contentIndex:0,delta:output[0].text,partial:message});
  stream.push({type:"done",reason:message.stopReason,message});
 };
 void emit().catch(error=>stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}}));return stream;
}});}
`;
  await writeProjectExtension(fixture.workspace, "research-recovery-fixture.ts", source);
  return {
    ...fixture,
    manuscript,
    readLanguageJournal: async (): Promise<LanguageFixtureEvent[]> =>
      (await readFile(journal, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeLanguageFixtureEvent(JSON.parse(line))),
  };
}
