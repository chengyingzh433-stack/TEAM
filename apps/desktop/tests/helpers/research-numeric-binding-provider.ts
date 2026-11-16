import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupResearchAnalysisRegistryFixture } from "./research-analysis-registry-provider";
import { writeProjectExtension } from "./electron-app";

/** Wraps the actual S5/S6 provider; only S7/S8 responses differ. Never writes product state. */
export async function setupResearchNumericBindingFixture() {
  const fixture = await setupResearchAnalysisRegistryFixture();
  await writeFile(
    fixture.design,
    (await readFile(fixture.design, "utf8")) +
      "本次合成字段单位：x与z均按小时计，y按分计；系数单位为分/小时。单位语义仍需模型明确审阅，不是程序自动证明。\n",
  );
  const modules = join(fixture.workspace, ".pi", "fixture-modules");
  await mkdir(modules, { recursive: true });
  await rename(
    join(fixture.workspace, ".pi", "extensions", "research-recovery-fixture.ts"),
    join(modules, "registry-base.ts"),
  );
  const release = join(fixture.profile, "numeric-release-corrected-draft");
  const journal = join(fixture.profile, "numeric-tool-receipts.jsonl");
  await writeFile(journal, "");
  await writeProjectExtension(
    fixture.workspace,
    "research-recovery-fixture.ts",
    String.raw`
import base from "../fixture-modules/registry-base.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFileSync, watch } from "node:fs";
import { readFile, appendFile, access } from "node:fs/promises";
const profile=${JSON.stringify(fixture.profile)},stateFile=${JSON.stringify(join(fixture.profile, "research-groups.json"))},release=${JSON.stringify(release)},journal=${JSON.stringify(journal)};
const state=()=>JSON.parse(readFileSync(stateFile,"utf8")).projects[0];
const recorded=new Set();
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const waitFor=(predicate,signal)=>new Promise((resolve,reject)=>{
 let ended=false,checking=false,dirty=false;
 const end=error=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
 const abort=()=>end(new Error("Numeric fixture wait aborted"));
 const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(error){end(error);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
 const watcher=watch(profile,()=>{void check();});const timer=setTimeout(()=>end(new Error("Numeric fixture required actual handoff missing")),30000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();else void check();
});
const who=messages=>{
 const match=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n").match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
 if(!match)throw new Error("Numeric fixture missing member instruction");
 return {"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]];
};
const active=(p,role)=>p.fusion.attempts.findLast(a=>["prepared","running"].includes(a.state)&&p.fusion.tasks.find(t=>t.id===a.taskId)?.role===role);
export default function(pi){base({registerProvider(name,config){pi.registerProvider(name,{...config,streamSimple(model,context,options){
 const p=state(),role=who(context.messages),attempt=active(p,role),phase=p.fusion.tasks.find(t=>t.id===attempt?.taskId)?.stage;
 // A delayed, already-accepted S5/S6 handoff can arrive after S7's expected tool errors.
 // Acknowledge that closed task explicitly; the generic registry fixture assumes no errors
 // anywhere in history and must not reinterpret an already-handled S7 rejection as S6 failure.
 const accepted=p.artifacts.filter(a=>a.revision===p.revision&&a.stage===phase&&a.kind==="stage-review"&&a.verdict==="accept").at(-1);
 const acceptedGraph=accepted&&p.fusion.artifacts.find(a=>a.id===accepted.id),acceptedTask=acceptedGraph&&p.fusion.tasks.find(t=>t.id===acceptedGraph.taskId);
 const closedStage=!["writing","audit"].includes(phase)&&["writing","audit"].includes(p.currentStage)&&accepted&&acceptedGraph&&acceptedTask?.currentArtifactId===accepted.id&&acceptedTask.inputVersion===acceptedGraph.taskVersion&&!["needs-review","superseded","revision-required"].includes(acceptedGraph.reviewState)&&acceptedGraph.inputRefs.every(ref=>p.fusion.adoptedInputs.some(input=>input.inputId===ref.inputId&&input.version===ref.version))&&!p.artifacts.some(a=>a.revision===p.revision&&a.stage===phase&&Date.parse(a.createdAt)>Date.parse(accepted.createdAt))&&!p.fusion.tasks.some(t=>t.id.startsWith("v"+p.revision+":")&&t.stage===phase&&t.continuations.some(c=>!c.attemptId));
 if(!["writing","audit"].includes(phase)&&!closedStage)return config.streamSimple(model,context,options);
 const stream=createAssistantMessageEventStream();
 const emit=async()=>{
  const messages=context.messages;if(messages.length>1100)throw new Error("Numeric fixture bounded conversation exceeded");
  const calls=new Map(messages.flatMap(m=>m.role==="assistant"?m.content.filter(c=>c.type==="toolCall").map(c=>[c.id,c.arguments]):[]));
  const results=messages.flatMap(m=>{if(m.role!=="toolResult")return [];const raw=m.content.filter(c=>c.type==="text").map(c=>c.text).join("");let data;try{const parsed=JSON.parse(raw);data=parsed.nextStage?parsed.result:parsed;}catch{data=raw;}return [{callId:m.toolCallId,args:calls.get(m.toolCallId),data,error:!!m.isError,raw}];});
  for(const r of results){
   const badArtifact=p.artifacts.find(a=>a.stage==="writing"&&a.kind==="stage-revision"&&a.round===1&&a.content.includes("BAD_NUMERIC_REVISION"));
   const expectedBind=role==="lead"&&/_bad-bind-(r2|n|sign|unit)$/.test(r.callId)&&r.args?.operation==="numeric-bind"&&r.args.binding?.artifactId===badArtifact?.id&&/display-mismatch|unit-mismatch/.test(r.raw);
   const expectedAccept=role==="reviewer"&&r.callId.endsWith("_bad-accept")&&r.args?.operation==="publish"&&r.args.stage==="writing"&&r.args.kind==="stage-verification"&&r.args.verdict==="accept"&&r.args.refs?.includes(badArtifact?.id)&&p.contentChecks?.some(c=>c.kind==="numeric-acceptance"&&c.program?.kind==="program"&&c.target?.artifactId===badArtifact?.id&&c.result==="blocked")&&/数值|数字|绑定|numeric/.test(r.raw);
   if(r.error&&!expectedBind&&!expectedAccept)throw new Error("Unexpected numeric tool failure: "+r.raw);
   if(r.args&&(["numeric-check","numeric-bind","numeric-render","numeric-candidate-review","declare-result-field","review-result-field","claim-register","claim-review","claim-check","language-not-applicable"].includes(r.args.operation)||r.callId.endsWith("_bad-accept"))&&!recorded.has(r.callId)){
    recorded.add(r.callId);await appendFile(journal,JSON.stringify({at:new Date().toISOString(),role,callId:r.callId,args:r.args,result:r.data,error:r.error,project:r.callId.endsWith("_bad-accept")?p:undefined})+"\n");
   }
  }
  const own=results.filter(r=>r.callId.includes(attempt.id)),ok=results.filter(r=>!r.error);
  const get=(kind,stage=phase)=>p.artifacts.findLast(a=>a.stage===stage&&a.revision===p.revision&&a.kind===kind);
  const read=id=>ok.some(r=>r.args?.operation==="read"&&r.data.id===id);
  const run=p.analysisRegistry.runs.find(r=>r.planId==="registry-primary"&&r.actor==="model:lead");
  const readRun=own.some(r=>!r.error&&r.args?.operation==="read-registered-analysis"&&r.data.id===run.id&&r.data.validForCurrentInputs===true);
  const sourceIds=p.evidence.sources.filter(s=>ok.some(r=>r.args?.operation==="source-read"&&r.data.id===s.id)).map(s=>s.id);
  const prev=get("stage-review","analysis"),draft=get("stage-draft"),risk=get("stage-risk"),critique=get("stage-critique"),revision=get("stage-revision"),verification=get("stage-verification");
  const definitions=[
   {key:"r2",path:["regression","rSquared"],quantity:"r-squared",unit:"",decimalPlaces:3},
   {key:"n",path:["regression","sampleSize"],quantity:"sample-size",unit:"",decimalPlaces:0},
   {key:"sign",path:["regression","coefficients","x"],quantity:"coefficient",unit:"分/小时",decimalPlaces:2},
   {key:"unit",path:["regression","coefficients","z"],quantity:"coefficient",unit:"分/小时",decimalPlaces:2},
   {key:"rounded",path:["regression","rSquared"],quantity:"r-squared",unit:"",decimalPlaces:2},
  ];
  const coefficients=definitions.filter(d=>d.quantity==="coefficient");
  const metadata=(d,status)=>p.numericFieldMetadata?.find(m=>m.runId===run.id&&JSON.stringify(m.path)===JSON.stringify(d.path)&&m.status===status);
  const field=d=>({runId:run.id,path:d.path,quantity:d.quantity,unit:d.unit,decimalPlaces:d.decimalPlaces,rounding:"half-away-from-zero",unitSeparator:d.unit?" ":"",...(d.quantity==="coefficient"?{fieldMetadataId:metadata(d,"verified").id}:{})});
  const rendering=d=>ok.find(r=>r.args?.operation==="numeric-render"&&JSON.stringify(r.args.path)===JSON.stringify(d.path)&&r.args.decimalPlaces===d.decimalPlaces)?.data.renderedText;
  const generic="这是合成数据的软件验收稿，只检验数值引用与审阅机制，不是真实研究结论。明确观察关联边界，缺乏因果识别条件；模型意见和同引擎复跑都不能冒充人类专家或独立算法核验。年份和内部编号是文稿管理信息，并非计算结果。";
  const body=bad=>{
   const values=definitions.map(d=>rendering(d));
   if(bad){values[0]="0.123";values[1]="99";values[2]="-"+values[2].replace(/^[+-]/,"");values[3]=values[3].replace("分/小时","小时");}
   return "# 数值核对演练\n"+generic+"\n文稿年份2026，内部编号17。\n"+(bad?"BAD_NUMERIC_REVISION":"CORRECT_NUMERIC_REVISION")+"\nR²="+values[0]+"；n="+values[1]+"；x系数="+values[2]+"；z系数="+values[3]+"；合法舍入R²="+values[4]+"。\n";
  };
  const spans=artifact=>definitions.map(d=>{
   const prefix={r2:"R²=",n:"n=",sign:"x系数=",unit:"z系数=",rounded:"合法舍入R²="}[d.key];
   const start=artifact.content.indexOf(prefix)+prefix.length,end=artifact.content.indexOf(d.key==="rounded"?"。":"；",start);
   return {...d,start,end};
  });
  const publish=(kind,refs=[],verdict,content=generic)=>({operation:"publish",revision:p.revision,stage:phase,kind,refs,sourceIds,analysisIds:readRun?[run.id]:[],content,...(verdict?{verdict}:{})});
  const latestCheck=artifact=>ok.filter(r=>r.args?.operation==="numeric-check"&&r.args.artifactId===artifact.id).at(-1);
  const checkedAfterReviews=artifact=>{
   const check=latestCheck(artifact);return check&&!check.data.blocksFormalAcceptance;
  };
  const bindingFor=(artifact,d)=>p.numericBindings?.some(b=>b.artifactId===artifact.id&&b.start===d.start&&b.end===d.end);
  const claimFor=artifact=>p.claims?.claims.find(c=>c.artifactId===artifact.id&&c.id==="numeric-result:"+artifact.id);
  const supportedClaim=artifact=>{const claim=claimFor(artifact);return claim&&p.claims?.reviews.some(r=>r.claimId===claim.id&&r.actor.role==="reviewer"&&r.conclusion==="supported");};
  const claimChecked=artifact=>{const check=ok.filter(r=>r.args?.operation==="claim-check"&&r.args.artifactId===artifact.id).at(-1);if(check?.data.blocksFormalAcceptance)throw new Error("Corrected numeric claim remains blocked: "+JSON.stringify(check.data));return !!check;};
  let args,tag,wait;
  if(!own.some(r=>r.args?.operation==="status"))args={operation:"status"};
  else if(closedStage||phase==="audit")args=undefined;
  else if(!own.some(r=>r.args?.operation==="knowledge"))args={operation:"knowledge",query:"研究问题 证据 研究设计"};
  else if(prev&&!read(prev.id))args={operation:"read",artifactId:prev.id};
  else if(sourceIds.length<p.evidence.sources.length)args={operation:"source-read",sourceId:p.evidence.sources.find(s=>!sourceIds.includes(s.id)).id};
  else if(role!=="librarian"&&!readRun)args={operation:"read-registered-analysis",analysisId:run.id};
  else if(role==="librarian"&&!get("stage-material"))args=publish("stage-material");
  else if(role==="lead"&&!draft)args=publish("stage-draft",[prev.id],undefined,generic+"请B核对结果字段、单位与舍入声明，随后完整修订；本稿暂不插入数值。");
  else if(role==="reviewer"&&!risk)args=publish("stage-risk",[prev.id],undefined,generic+"数值需绑定实际字段；未解决的候选不能直接接受。");
  else if(role==="lead"&&coefficients.some(d=>!metadata(d,"declared"))){const d=coefficients.find(d=>!metadata(d,"declared"));args={operation:"declare-result-field",runId:run.id,path:d.path,quantity:d.quantity,unit:d.unit,content:"本合成方案将x与z按小时计、y按分计，因此系数单位声明为分/小时；仅此演练含义，需B审阅。"};}
  else if(role==="reviewer"&&coefficients.some(d=>!metadata(d,"verified"))){const d=coefficients.find(d=>!metadata(d,"verified")),m=metadata(d,"declared");if(!m)wait=q=>q.numericFieldMetadata?.some(m=>m.runId===run.id&&JSON.stringify(m.path)===JSON.stringify(d.path)&&m.status==="declared");else args={operation:"review-result-field",metadataId:m.id,content:"已读取真实运行及合成方案的字段语义，核对y为分、x/z为小时，接受分/小时的模型单位审阅；不是程序物理证明。"};}
  else if(role==="lead"&&coefficients.some(d=>!metadata(d,"verified")))wait=q=>coefficients.every(d=>q.numericFieldMetadata?.some(m=>m.runId===run.id&&JSON.stringify(m.path)===JSON.stringify(d.path)&&m.status==="verified"));
  else if(role==="lead"&&definitions.some(d=>!rendering(d))){const d=definitions.find(d=>!rendering(d));args={operation:"numeric-render",...field(d)};}
  else if(role==="reviewer"&&!draft)wait=q=>q.artifacts.some(a=>a.stage==="writing"&&a.kind==="stage-draft");
  else if(role==="reviewer"&&!critique)args=read(draft.id)?publish("stage-critique",[draft.id],undefined,generic+"请在修订中给出R²、样本量及两个系数，采用已审单位，并为每个实际数值片段创建绑定。"): {operation:"read",artifactId:draft.id};
  else if(role==="lead"&&!critique)wait=q=>q.artifacts.some(a=>a.stage==="writing"&&a.kind==="stage-critique");
  else if(role==="lead"&&!revision)args=read(critique.id)?publish("stage-revision",[critique.id],undefined,body(true)):{operation:"read",artifactId:critique.id};
  else if(role==="lead"&&revision?.round===1){
   if(!read(revision.id))args={operation:"read",artifactId:revision.id};
   else {const defs=spans(revision),missing=defs.find(d=>d.key==="rounded"?!bindingFor(revision,d):!results.some(r=>r.callId.endsWith("_bad-bind-"+d.key)&&r.args?.binding?.artifactId===revision.id));
    if(missing){args={operation:"numeric-bind",binding:{artifactId:revision.id,start:missing.start,end:missing.end,...field(missing),...(missing.key==="unit"?{unit:"小时"}:{})}};tag=missing.key==="rounded"?"numeric-bind":"bad-bind-"+missing.key;}
    else if(verification?.verdict!=="revise")wait=q=>q.artifacts.some(a=>a.stage==="writing"&&a.kind==="stage-verification"&&a.verdict==="revise");
    else if(!read(verification.id))args={operation:"read",artifactId:verification.id};
    else {await waitFor(async()=>{try{await access(release);return true;}catch{return false;}},options?.signal);args=publish("stage-revision",[verification.id],undefined,body(false));}
   }
  }
  else if(role==="lead"&&revision?.round===2){
   if(!read(revision.id))args={operation:"read",artifactId:revision.id};
   else if(!claimFor(revision)){const start=revision.content.indexOf("R²="),end=revision.content.indexOf("。",start)+1;args={operation:"claim-register",claim:{id:"numeric-result:"+revision.id,artifactId:revision.id,start,end,category:"research-result",evidence:definitions.filter(d=>d.key!=="rounded").map(d=>({kind:"result",runId:run.id,path:d.path}))}};}
   else {const d=spans(revision).find(d=>!bindingFor(revision,d));if(d)args={operation:"numeric-bind",binding:{artifactId:revision.id,start:d.start,end:d.end,...field(d)}};else if(!p.languageDispositions?.some(r=>r.artifactId===revision.id))args={operation:"language-not-applicable",artifactId:revision.id,reason:"本稿纠正实际数值、单位与绑定，是实质结果修订；没有纯语言打磨，不制造双稿语言复核。"};}
  }
  else if(role==="reviewer"&&!revision)wait=q=>q.artifacts.some(a=>a.stage==="writing"&&a.kind==="stage-revision");
  else if(role==="reviewer"&&revision){
   if(!read(revision.id))args={operation:"read",artifactId:revision.id};
   else if(!p.numericBindings?.some(b=>b.artifactId===revision.id&&b.path.at(-1)==="rSquared"&&b.decimalPlaces===2))wait=q=>q.numericBindings?.some(b=>b.artifactId===revision.id&&b.decimalPlaces===2&&b.path.at(-1)==="rSquared");
   else if(revision.round===2&&p.numericBindings.filter(b=>b.artifactId===revision.id).length<5)wait=q=>q.numericBindings?.filter(b=>b.artifactId===revision.id).length===5;
   else if(revision.round===2&&!claimFor(revision))wait=q=>q.claims?.claims.some(c=>c.artifactId===revision.id&&c.id==="numeric-result:"+revision.id);
   else if(revision.round===2&&!p.languageDispositions?.some(r=>r.artifactId===revision.id))wait=q=>q.languageDispositions?.some(r=>r.artifactId===revision.id);
   else if(revision.round===2&&!supportedClaim(revision))args={operation:"claim-review",review:{claimId:claimFor(revision).id,conclusion:"supported",reason:"已实际读取当前修订与主模型计算结果：该数值整行仅描述本次合成CSV的R²、完整案例数及x/z系数，字段引用支持这些软件演练结果；单位声明与舍入另经数值核对。此模型语义意见不证明真实研究、因果解释或人类专家认可。",resolvesReviewIds:[]}};
   else if(revision.round===2&&!claimChecked(revision))args={operation:"claim-check",artifactId:revision.id};
   else {
    const check=latestCheck(revision),candidate=check?.data.semantic.unbound.find(c=>["2026","17"].includes(c.text)&&!p.numericCandidateReviews?.some(r=>r.artifactId===revision.id&&r.start===c.start&&r.end===c.end));
    if(!check)args={operation:"numeric-check",artifactId:revision.id};
    else if(candidate)args={operation:"numeric-candidate-review",artifactId:revision.id,start:candidate.start,end:candidate.end,classification:"non-result-number",reason:candidate.text==="2026"?"逐项核对：这是文稿年份，不是本次统计结果。":"逐项核对：这是内部文稿编号，不是样本量或估计结果。"};
    else if(check.data.semantic.unbound.some(c=>["2026","17"].includes(c.text)))args={operation:"numeric-check",artifactId:revision.id};
    else if(revision.round===1&&!results.some(r=>r.callId.endsWith("_bad-accept"))){args=publish("stage-verification",[revision.id],"accept",generic+"测试故意尝试模型接受：程序须阻断四处未解决数值。");tag="bad-accept";}
    else if(revision.round===1&&verification?.refs.includes(revision.id))args=undefined;
    else if(revision.round===1)args=publish("stage-verification",[revision.id],"revise",generic+"程序已阻断正式接受；逐项更正R²、样本量、系数符号和单位，保留合法舍入片段，不重算数据。");
    else if(!checkedAfterReviews(revision))args={operation:"numeric-check",artifactId:revision.id};
    else if(!verification?.refs.includes(revision.id))args=publish("stage-verification",[revision.id],"accept",generic+"程序核对五处绑定一致，两处非结果数字已逐项模型审阅；现在接受数值及解释，仍不代表人类专家。" );
   }
  }
  else if(role==="mentor"&&(!revision||revision.round!==2||verification?.verdict!=="accept"))wait=q=>q.artifacts.some(a=>a.stage==="writing"&&a.kind==="stage-verification"&&a.round===2&&a.verdict==="accept");
  else if(role==="mentor"&&!get("stage-review")){
   if(!read(revision.id))args={operation:"read",artifactId:revision.id};else if(!read(verification.id))args={operation:"read",artifactId:verification.id};else if(!checkedAfterReviews(revision))args={operation:"numeric-check",artifactId:revision.id};else args=publish("stage-review",[revision.id,verification.id],"accept",generic+"接受第二轮修订；数值已重绑重审，实际分析没有重跑，整体仍待后续全文审计。");
  }
  if(wait){await waitFor(()=>wait(state()),options?.signal);args={operation:"status"};}
  const callId="numeric_"+attempt.id+"_"+messages.length+"_"+(tag??args?.operation??"text");
  const output=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:closedStage?"已接受的上游阶段收到晚到交接：实际查看状态后结束，不重跑分析或改写已有成果。":phase==="audit"?"NUMERIC_BOUNDARY: 写作数值已核对，全文审计未交稿，不声称完整论文。":"当前数值工作已交付，保留历史错误稿。"}];
  const message={role:"assistant",content:output,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
  const logClosed=type=>appendFile(profile+"/recovery-provider-journal/"+role+".jsonl",JSON.stringify({at:new Date().toISOString(),role,requestId:callId,type,attemptId:attempt.id,nativeRunId:attempt.nativeRunId,operation:args?.operation})+"\n");
  if(closedStage)await logClosed("request");
  if(options?.signal?.aborted)throw new Error("Numeric response aborted");stream.push({type:"start",partial:{...message,content:[]}});
  if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:output[0],partial:message});}else stream.push({type:"text_delta",contentIndex:0,delta:output[0].text,partial:message});
  if(closedStage)await logClosed("response");
  stream.push({type:"done",reason:message.stopReason,message});
 };
 void emit().catch(error=>stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}}));return stream;
 }});}});}
`,
  );
  return {
    ...fixture,
    releaseCorrected: () => writeFile(release, "Allow only the corrected native response.\n"),
    readNumericReceipts: async (): Promise<unknown[]> =>
      (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
  };
}
