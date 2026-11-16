import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESEARCH_SYNTHESIS_COLUMNS } from "../../contracts/research-synthesis";
import { writeProjectExtension } from "./electron-app";
import { setupResearchFusionRecoveryFixture } from "./research-fusion-recovery-provider";

export const COUNTEREVIDENCE_BOUNDARY =
  "AC24 确定性软件验收：来源、课程、稿件和模型判断均为明确编制的合成测试内容。真实 Pi 适配器执行 research_group 工具，只证明软件流程，不是真实文献、科学发现、外部模型 R 或独立学术 C。";
export const COUNTEREVIDENCE_CHECKPOINT = "AC24_E 新增合成论文顺序检查点";
export const COUNTEREVIDENCE_OPTION = "new-paper-adopted";
export const COUNTEREVIDENCE_BEFORE =
  "当前提供材料未直接回答缺勤与数学等级的关联；候选材料缺口仍待核验，不能称无人研究。";
export const COUNTEREVIDENCE_AFTER =
  "新增合成既有研究已回答原问题的一部分；撤回该部分材料缺口，将后续问题收窄到其他情境的测量差异。";
export const COUNTEREVIDENCE_SOURCES = {
  initial:
    "合成论文一，仅作软件验收。研究问题是甲镇两校学生自报学习时间与数学期末等级的观察关联；来源为课堂问卷和课程等级。提供文字讨论学习时间，未直接讨论缺勤与数学等级的关联方向。没有随机分配，不支持因果或全国外推，精确测量工具和效应数值在本段未提供。",
  added:
    "合成论文二，仅作软件验收。另一项甲镇两校的既有观察研究已经直接讨论缺勤与数学期末等级的关联，作者在该限定情境报告负向关联。它回答了原候选缺口的一部分；未覆盖其他情境、其他学科或测量差异，不提供因果证据。这里没有原始CSV或可复算的统计量。",
};

export interface CounterevidenceProviderEvent {
  type: "request" | "tool-result" | "failure";
  at: string;
  role: string;
  attemptId?: string;
  nativeRunId?: string;
  taskId?: string;
  taskInputVersion?: number;
  callId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: boolean;
  detail?: string;
}

/** Existing local Pi transport and launcher; only synthetic input files and response selection differ.
 * The provider reads the durable project to select responses and never writes its state.
 */
export async function setupResearchCounterevidenceFixture() {
  const fixture = await setupResearchFusionRecoveryFixture();
  const initial = join(fixture.workspace, "AC24-initial-synthetic-paper.txt");
  const added = join(fixture.workspace, "AC24-added-synthetic-paper.txt");
  await writeFile(initial, COUNTEREVIDENCE_SOURCES.initial, { flag: "wx" });
  await writeFile(added, COUNTEREVIDENCE_SOURCES.added, { flag: "wx" });
  await writeFile(
    join(fixture.kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "RECOVERY-METHOD",
      title: "合成研究综合 证据与候选缺口",
      text: `${COUNTEREVIDENCE_BOUNDARY} 区分当前材料未回答与不存在研究。按原文建立七列矩阵，保留局限，新反证通过新稿与具名复核处理，只重开受影响任务。`,
      required_context_ids: [],
      image_paths: [],
      content_layers: ["course_paraphrase"],
    }),
  );
  const journal = join(fixture.profile, "counterevidence-provider-journal.jsonl");
  await writeFile(journal, "", { flag: "wx" });
  const providerSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { watch } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const profile=${JSON.stringify(fixture.profile)},stateFile=${JSON.stringify(join(fixture.profile, "research-groups.json"))},journal=${JSON.stringify(journal)};
const boundary=${JSON.stringify(COUNTEREVIDENCE_BOUNDARY)},before=${JSON.stringify(COUNTEREVIDENCE_BEFORE)},after=${JSON.stringify(COUNTEREVIDENCE_AFTER)},columns=${JSON.stringify(RESEARCH_SYNTHESIS_COLUMNS)},checkpoint=${JSON.stringify(COUNTEREVIDENCE_CHECKPOINT)},option=${JSON.stringify(COUNTEREVIDENCE_OPTION)};
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const recorded=new Set();
const state=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects[0];
const active=(p,role)=>p.fusion.attempts.findLast(a=>["prepared","running"].includes(a.state)&&p.fusion.tasks.find(t=>t.id===a.taskId)?.role===role);
const current=(p,a)=>{const record=p.fusion.artifacts.find(row=>row.id===a.id),task=p.fusion.tasks.find(t=>t.id===record?.taskId);return !!record&&task?.inputVersion===record.taskVersion&&record.content===a.content&&!["needs-review","superseded"].includes(record.reviewState);};
const source=(p,kind)=>p.evidence.sources.find(s=>p.importedMaterials?.find(m=>m.id===s.materialImportId)?.name===(kind==="initial"?"AC24-initial-synthetic-paper.txt":"AC24-added-synthetic-paper.txt"));
const origin=actor=>actor?.evidenceRef?.startsWith("host-method:")?JSON.parse(actor.evidenceRef.slice("host-method:".length)):undefined;
// Register before checking: atomic persistence cannot lose a wakeup. This is an
// observed handoff/material wait, never a sleep, status polling or a success timeout.
const waitFor=(predicate,signal,label)=>new Promise((resolve,reject)=>{
 let ended=false,checking=false,dirty=false;
 const end=error=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
 const abort=()=>end(Error("AC24 fixture wait aborted: "+label));
 const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(error){end(error);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
 const watcher=watch(profile,()=>void check()),timer=setTimeout(()=>end(Error("AC24 actual handoff missing: "+label)),45000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else void check();
});
export default function(pi){pi.registerProvider("research-recovery-fixture",{baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-recovery-fixture",models:[{id:"gpt-6.1-sol",name:"AC24 deterministic software fixture",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,context,options){
 const stream=createAssistantMessageEventStream();
 const emit=async()=>{
  const messages=context.messages;
  if(messages.length>800)throw Error("AC24 bounded deterministic conversation exceeded");
  const match=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n").match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
  if(!match)throw Error("AC24 role instruction missing");
  const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]];
  const calls=new Map(messages.flatMap(m=>m.role==="assistant"?m.content.filter(c=>c.type==="toolCall").map(c=>[c.id,c.arguments]):[]));
  const results=[];
  for(const message of messages.filter(m=>m.role==="toolResult")){
   const args=calls.get(message.toolCallId);if(!args)continue;
   const raw=message.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");
   let data;try{const parsed=JSON.parse(raw);data=parsed.nextStage?parsed.result:parsed;}catch{data=raw;}
   const p=await state(),producer=p.fusion.attempts.find(a=>message.toolCallId.includes(a.id));
   if(!recorded.has(message.toolCallId)){
    recorded.add(message.toolCallId);
    await appendFile(journal,JSON.stringify({type:"tool-result",at:new Date().toISOString(),role,attemptId:producer?.id,nativeRunId:producer?.nativeRunId,taskId:producer?.taskId,taskInputVersion:producer?.taskVersion,callId:message.toolCallId,args,result:data,error:!!message.isError})+"\n");
   }
   if(message.isError)throw Error("Unexpected actual AC24 tool error: "+raw);
   results.push({args,data,callId:message.toolCallId});
  }
  let args,attempt,task,p;
  // A wait only re-evaluates the same one model response after a real state change.
  for(let decisions=0;;decisions++){
   if(decisions>80)throw Error("AC24 response selection exceeded actual state transitions");
   p=await state();attempt=active(p,role);task=p.fusion.tasks.find(t=>t.id===attempt?.taskId);
   if(!attempt||!task)throw Error("AC24 actual native owner missing");
   const own=results.filter(r=>r.callId.includes(attempt.id)),has=operation=>own.some(r=>r.args.operation===operation),read=id=>own.some(r=>r.args.operation==="read"&&r.data.id===id);
   const get=(kind,stage=task.stage)=>p.artifacts.findLast(a=>a.revision===p.revision&&a.stage===stage&&a.kind===kind&&current(p,a));
   const ledger=p.synthesis??{reads:[],matrices:[],gaps:[],counterevidence:[],responses:[],reviews:[],resolutions:[]};
   const challenge=ledger.counterevidence.find(c=>c.id==="ac24-counter");
   const response=ledger.responses.find(r=>r.counterevidenceId===challenge?.id);
   const responseReview=ledger.reviews.find(r=>r.responseId===response?.id&&r.conclusion==="addressed");
   const resolution=ledger.resolutions.find(r=>r.reviewId===responseReview?.id&&r.decision==="close");
   const initial=source(p,"initial"),added=source(p,"added");
   const sourceIds=p.evidence.sources.filter(s=>own.some(r=>r.args.operation==="source-read"&&r.data.id===s.id&&r.data.sha256===s.sha256)).map(s=>s.id);
   const pkg=p.methodPackages?.find(pkg=>pkg.rootIds.includes("RECOVERY-METHOD"));
   const draft=get("stage-draft"),risk=get("stage-risk"),verification=get("stage-verification"),review=get("stage-review");
   const previous=task.stage==="synthesis"?get("stage-review","reading"):task.stage==="design"?get("stage-review","synthesis"):undefined;
   const application=p.methodApplications?.findLast(a=>a.taskId==="v"+p.revision+":"+task.stage+":lead"&&a.actor.id==="model:lead"&&origin(a.actor)?.taskVersion===p.fusion.tasks.find(t=>t.id===a.taskId)?.inputVersion);
   const opinion=p.methodContentOpinions?.findLast(o=>o.applicationId===application?.id&&o.actor.id==="model:reviewer"&&o.verdict==="support");
   const adjudication=p.methodAdjudications?.findLast(a=>a.applicationId===application?.id&&a.verdict==="accept");
   const sourceRef=id=>{
    const receipt=p.sourceReads?.findLast(r=>r.sourceId===id&&r.sessionId===p.members.find(m=>m.role===role).ref.sessionId&&ledger.reads.some(binding=>binding.id===r.id&&binding.owner.attemptId===attempt.id));
    if(!receipt)throw Error("AC24 source evidence must be this native's actual read");
    return {sourceId:id,locatorId:receipt.locatorId,start:receipt.start,end:receipt.end,requiredDepth:receipt.depth};
   };
   const content=boundary+"\n"+(task.stage==="synthesis"?(challenge?after:before):task.stage==="reading"?"本人实际阅读合成来源，分开对象、测量、证据与未提供事项；本阶段不制造已执行的S1/S2。":"本轮仅给有限后续方案，保留观察关联和情境限制，不采集、不计算、不写完整论文。")+"\n课程仅作方法参考；材料未回答不等于不存在研究，模型接受不是人的科研批准。";
   const publish=(kind,refs=[],verdict)=>({operation:"publish",revision:p.revision,stage:task.stage,kind,refs,sourceIds,content:content+(kind==="stage-risk"?"\nB独立风险：先按共同来源判断范围，再读A稿；不能由一份材料推出普遍研究空白。":kind==="stage-verification"?"\nB已本人读取对应A稿及原文，只支持这个明确软件范围。":kind==="stage-review"?"\n导师实际读取同版稿和B意见，裁定仅覆盖本版本。":""),...(verdict?{verdict}:{})});
   let wait,label;
   const stale=q=>q.fusion.tasks.find(t=>t.id===task.id)?.inputVersion!==attempt.taskVersion;
   if(attempt.taskVersion!==task.inputVersion||p.status!=="running"||review){args=undefined;break;}
   if(!["reading","synthesis","design"].includes(task.stage))throw Error("AC24 unexpected stage "+task.stage);
   if(!has("status"))args={operation:"status"};
   else if(task.stage==="design"&&role==="mentor"&&!(p.fusion.decisionRequests??[]).some(r=>r.question===checkpoint))args={operation:"request-decision",decision:{conditionId:"ac24-core-new-paper",question:checkpoint,context:boundary,impact:"仅S5导师后续裁定等待操作者普通UI采用新增合成论文；S4既有接受不改。",taskIds:[task.id],options:[{id:option,label:"新增合成论文已采用，继续核对",consequence:"只解除测试材料顺序条件，不预先接受任何观点",outcome:"confirmed"},{id:"defer",label:"暂缓",consequence:"保留当前记录",outcome:"deferred"}],recommendedOptionId:option}};
   else if(task.stage==="design"&&role==="mentor"&&!p.fusion.decisions.some(d=>d.requestId===p.fusion.decisionRequests?.find(r=>r.question===checkpoint)?.id&&d.outcome==="confirmed"))args=undefined;
   else if(!has("method-package"))args=pkg?{operation:"method-package",packageId:pkg.id}:{operation:"method-package",ids:["RECOVERY-METHOD"]};
   else if(previous&&!read(previous.id))args={operation:"read",artifactId:previous.id};
   else if(sourceIds.length<p.evidence.sources.length)args={operation:"source-read",sourceId:p.evidence.sources.find(s=>!sourceIds.includes(s.id)).id};
   else if(role==="reviewer"&&!risk)args=publish("stage-risk",previous?[previous.id]:[]);
   else if(task.stage==="design"&&role==="reviewer"&&added&&!challenge){
    const gap=ledger.gaps.find(g=>g.id==="ac24-gap-before");if(!gap)throw Error("AC24 accepted baseline gap missing");
    if(!read(gap.artifactId))args={operation:"read",artifactId:gap.artifactId};
    else args={operation:"synthesis-counterevidence",request:{id:"ac24-counter",source:sourceRef(added.id),claimIds:[],gapIds:[gap.id],reason:"合成论文二直接讨论原候选问题，只削弱已提供材料中的该部分缺口；保留情境与因果局限。",materialChange:true}};
   }
   else if(task.stage==="design"&&role==="mentor"&&!resolution){wait=q=>stale(q)||q.synthesis?.resolutions.some(r=>r.decision==="close");label="ordinary UI new paper and completed local counterevidence review";}
   else if(role==="librarian"){
    if(!get("stage-material"))args=publish("stage-material");
   }
   else if(role==="lead"){
    if(!draft)args=publish("stage-draft",previous?[previous.id]:[]);
    else if(!read(draft.id))args={operation:"read",artifactId:draft.id};
    else if(!application)args={operation:"method-apply",packageId:pkg.id,recordIds:["RECOVERY-METHOD"],methodSelection:"按当前实际原文记录候选缺口与限制",applicabilityExplanation:"先作本阶段独立稿；新增证据出现后只重开相关任务并保存新稿、矩阵与缺口前后链。",nonApplicableConditions:["合成材料不能证明真实学术空白","没有数据，不计算或推断因果"],limitations:boundary,scoringClaim:"not-scored"};
    else if(task.stage==="synthesis"){
     const matrixId=challenge?"ac24-matrix-after":"ac24-matrix-before",gapId=challenge?"ac24-gap-after":"ac24-gap-before";
     if(!ledger.matrices.some(m=>m.id===matrixId))args={operation:"synthesis-matrix",request:{id:matrixId,artifactId:draft.id,...(challenge?{supersedesId:"ac24-matrix-before"}:{}),rows:(challenge?[initial,added]:[initial]).map(s=>({sourceId:s.id,cells:Object.fromEntries(columns.map(column=>[column,column==="conceptsMeasures"?{unavailable:"该合成原文未提供精确测量工具或评分条目。"}:{summary:"合成来源的"+column+"；只覆盖本人实际读取的限定情境。",evidence:[sourceRef(s.id)]}]))}))}};
     else if(!ledger.gaps.some(g=>g.id===gapId))args={operation:"synthesis-gap",request:{id:gapId,artifactId:draft.id,...(challenge?{supersedesId:"ac24-gap-before"}:{}),statement:challenge?after:before,scope:"仅本次已提供合成论文及甲镇两校情境",state:challenge?"weakened-or-rejected":"pending-validation",matrixIds:[matrixId],claimIds:[],evidence:[sourceRef(challenge?added.id:initial.id)],counterSearchBatchIds:[],remainingUncertainty:"未执行真实反向文献检索，不知道其他情境与测量；不能称支持普遍创新性。"}};
     else if(challenge&&!response){const start=draft.content.indexOf(after);if(start<0)throw Error("AC24 new draft lacks its real response text");args={operation:"synthesis-respond",request:{id:"ac24-response",counterevidenceId:challenge.id,artifactId:draft.id,start,end:start+after.length,reason:"新稿撤回原材料缺口的一部分，并把剩余范围收窄；旧稿与旧候选保留历史。",claimReplacements:[],gapReplacements:[{beforeId:"ac24-gap-before",afterId:gapId}]}};}
    }
   }
   else if(role==="reviewer"){
    if(!draft){wait=q=>stale(q)||q.artifacts.some(a=>a.kind==="stage-draft"&&a.stage===task.stage&&current(q,a));label="A actual current draft";}
    else if(task.stage==="synthesis"&&!ledger.gaps.some(g=>g.artifactId===draft.id)){wait=q=>stale(q)||q.synthesis?.gaps.some(g=>g.artifactId===draft.id);label="A actual located matrix/gap";}
    else if(!read(draft.id))args={operation:"read",artifactId:draft.id};
    else if(task.stage==="synthesis"&&challenge&&!response){wait=q=>stale(q)||q.synthesis?.responses.some(r=>r.artifactId===draft.id);label="A actual structured response";}
    else if(task.stage==="synthesis"&&challenge&&!responseReview)args={operation:"synthesis-review",request:{id:"ac24-response-review",responseId:response.id,start:response.start,end:response.end,conclusion:"addressed",reason:"B本人本native重新读取新增合成原文及新稿，确认只撤回被回答的缺口，未扩大情境或因果解释。"}};
    else if(task.stage==="synthesis"&&challenge&&!resolution){wait=q=>stale(q)||q.synthesis?.resolutions.some(r=>r.reviewId===responseReview.id&&r.decision==="close");label="mentor actual disposition before B formal verification";}
    else if(!application){wait=q=>stale(q)||q.methodApplications?.some(a=>a.taskId==="v"+q.revision+":"+task.stage+":lead"&&origin(a.actor)?.taskVersion===q.fusion.tasks.find(t=>t.id===a.taskId)?.inputVersion);label="A current method application";}
    else if(!own.some(r=>r.args.operation==="method-check"&&r.args.applicationId===application.id))args={operation:"method-check",packageId:pkg.id,applicationId:application.id};
    else if(!opinion)args={operation:"method-opinion",packageId:pkg.id,applicationId:application.id,verdict:"support",note:boundary+" B实际核对同包应用、来源范围与当前稿，只支持这次有限软件流程。"};
    else if(!verification)args=publish("stage-verification",[draft.id],"accept");
   }
   else if(role==="mentor"){
    // Resolve the actual structured B review before waiting for formal verification,
    // whose acceptance guard correctly requires that mentor disposition first.
    if(!draft){wait=q=>stale(q)||q.artifacts.some(a=>a.kind==="stage-draft"&&a.stage===task.stage&&current(q,a));label="A actual current draft for mentor";}
    else if(!read(draft.id))args={operation:"read",artifactId:draft.id};
    else if(task.stage==="synthesis"&&challenge&&!responseReview){wait=q=>stale(q)||q.synthesis?.reviews.some(r=>r.conclusion==="addressed");label="B named response review";}
    else if(task.stage==="synthesis"&&challenge&&!own.some(r=>r.args.operation==="synthesis-context"&&r.data.reviews?.some(review=>review.id===responseReview.id)))args={operation:"synthesis-context"};
    else if(task.stage==="synthesis"&&challenge&&!resolution)args={operation:"synthesis-resolve",request:{id:"ac24-resolution",reviewId:responseReview.id,decision:"close",direction:"narrow",reason:"导师本native实际读取新增合成原文及同版新稿/B复核，关闭该部分材料缺口；方向仅收窄，不替人作研究许可。"}};
    else if(!verification){wait=q=>stale(q)||q.artifacts.some(a=>a.kind==="stage-verification"&&a.stage===task.stage&&current(q,a));label="B actual current verification after structured resolution";}
    else if(!read(verification.id))args={operation:"read",artifactId:verification.id};
    else if(!opinion)throw Error("AC24 verified draft lacks B current method opinion");
    else if(!adjudication)args={operation:"method-adjudicate",packageId:pkg.id,applicationId:application.id,opinionIds:[opinion.id],verdict:"accept",note:boundary+" 具名接受本稿有限方法应用；综合反证必须已由新稿、B复核和局部裁定关闭。"};
    else if(!own.some(r=>r.args.operation==="method-check"&&r.args.applicationId===application.id))args={operation:"method-check",packageId:pkg.id,applicationId:application.id};
    else args=publish("stage-review",[draft.id,verification.id],"accept");
   }
   if(wait){await waitFor(async()=>wait(await state()),options?.signal,label);continue;}
   break;
  }
  const callId="ac24_"+attempt.id+"_"+randomUUID()+"_"+(args?.operation??"text");
  const output=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:boundary+" 本次实际任务已交付或旧输入已自然结算；等待宿主按真实依赖继续。"}];
  const message={role:"assistant",content:output,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
  await appendFile(journal,JSON.stringify({type:"request",at:new Date().toISOString(),role,attemptId:attempt.id,nativeRunId:attempt.nativeRunId,taskId:task.id,taskInputVersion:attempt.taskVersion,callId,args})+"\n");
  if(options?.signal?.aborted)throw Error("AC24 response aborted");
  stream.push({type:"start",partial:{...message,content:[]}});
  if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:output[0],partial:message});}
  else stream.push({type:"text_delta",contentIndex:0,delta:output[0].text,partial:message});
  stream.push({type:"done",reason:message.stopReason,message});
 };
 void emit().catch(async error=>{await appendFile(journal,JSON.stringify({type:"failure",at:new Date().toISOString(),role:"unknown",detail:String(error)})+"\n");stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}});});
 return stream;
}});}
`;
  await writeProjectExtension(fixture.workspace, "research-recovery-fixture.ts", providerSource);
  return {
    ...fixture,
    initial,
    added,
    journal,
    providerSource,
    readCounterevidenceJournal: async (): Promise<CounterevidenceProviderEvent[]> =>
      (await readFile(journal, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CounterevidenceProviderEvent),
  };
}
