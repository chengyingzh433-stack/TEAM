import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  writeProjectExtension,
} from "./electron-app";

export interface RecoveryGates {
  failLibrarianAfterFirstBatch: boolean;
  finishRemainingWork: boolean;
}
export interface RecoveryProviderEvent {
  at: string;
  role: string;
  requestId: string;
  type: "request" | "failure" | "aborted" | "response";
  attemptId?: string;
  nativeRunId?: string;
  operation?: string;
  kind?: string;
}

/** Real Pi tool execution with deterministic local responses; never an external-provider R test. */
export async function setupResearchFusionRecoveryFixture() {
  const profile = await makeUserDataDir("fusion-native-recovery-");
  const workspace = await makeWorkspace("fusion-native-recovery");
  const agentDir = join(profile, "agent"),
    kb = join(profile, "knowledge"),
    materials = join(profile, "materials"),
    journal = join(profile, "recovery-provider-journal");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await Promise.all([
    mkdir(join(kb, "索引"), { recursive: true }),
    mkdir(join(kb, "溯源"), { recursive: true }),
    mkdir(materials),
    mkdir(journal),
  ]);
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "RECOVERY-METHOD",
      title: "研究问题 证据 研究设计",
      text: "合成软件测试方法：先交可读批次，局部失败不撤销已交成果，恢复只继续未完成工作。",
      required_context_ids: [],
    }),
  );
  await writeFile(
    join(kb, "溯源", "来源清单.json"),
    JSON.stringify({ version: "recovery-fixture" }),
  );
  for (const id of ["A", "B"])
    await writeFile(
      join(materials, `${id}.txt`),
      `合成软件测试来源${id}；不是研究发现。观察关联不能当因果，恢复不能重复合入已发布材料。`,
    );
  await writeFile(
    join(materials, "manifest.json"),
    JSON.stringify({
      version: 1,
      sources: ["A", "B"].map((id) => ({
        id: `RECOVERY-${id}`,
        title: `恢复测试材料${id}`,
        authors: "本地测试",
        year: "2026",
        url: `https://example.test/recovery-${id}`,
        file: `${id}.txt`,
        kind: "paper",
      })),
      datasets: [],
    }),
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "research-recovery-fixture",
      defaultModel: "gpt-6.1-sol",
      enabledModels: ["research-recovery-fixture/gpt-6.1-sol"],
      compaction: { enabled: false },
    }),
  );
  const gateFile = join(profile, "recovery-gates.json");
  const setGates = async (gates: RecoveryGates) => {
    const temporary = `${gateFile}.tmp`;
    await writeFile(temporary, JSON.stringify(gates));
    await rename(temporary, gateFile);
  };
  await setGates({ failLibrarianAfterFirstBatch: false, finishRemainingWork: false });
  await writeProjectExtension(
    workspace,
    "research-recovery-fixture.ts",
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { watch } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const profile=${JSON.stringify(profile)}, stateFile=${JSON.stringify(join(profile, "research-groups.json"))}, gateFile=${JSON.stringify(gateFile)}, journal=${JSON.stringify(journal)};
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const state=async()=>JSON.parse(await readFile(stateFile,"utf8")).projects[0];
const gates=async()=>JSON.parse(await readFile(gateFile,"utf8"));
// Register the directory watcher before checking state so atomic rename cannot lose a wakeup.
// The timer is a failure bound, never a scheduling sleep or a success condition.
const waitFor=(predicate,signal,label)=>new Promise((resolve,reject)=>{
  let ended=false, checking=false, dirty=false;
  const end=error=>{if(ended)return;ended=true;watcher.close();clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolve();};
  const abort=()=>end(new Error("fixture wait aborted"));
  const check=async()=>{if(ended)return;if(checking){dirty=true;return;}checking=true;try{if(await predicate())end();}catch(error){end(error);}finally{checking=false;if(dirty&&!ended){dirty=false;void check();}}};
  const watcher=watch(profile,()=>{void check();});
  const timer=setTimeout(()=>end(new Error(label)),45000);
  signal?.addEventListener("abort",abort,{once:true});
  if(signal?.aborted)abort();else void check();
});
export default function(pi){
 pi.registerProvider("research-recovery-fixture",{baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-recovery-fixture",models:[{id:"gpt-6.1-sol",name:"gpt-6.1-sol",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
  streamSimple(model,context,options){
   const messages=context.messages;
   if(messages.length>400)throw new Error("Recovery fixture bounded conversation exceeded");
   const instructions=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\\n");
   const found=instructions.match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
   if(!found)throw new Error("Recovery fixture cannot identify member instruction");
   const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[found[1]];
   const failure=messages.find(m=>m.role==="toolResult"&&m.isError);
   if(failure)throw new Error("Real research tool failed: "+JSON.stringify(failure.content));
   const results=messages.flatMap((m,index)=>{if(m.role!=="toolResult")return [];try{const parsed=JSON.parse(m.content.filter(c=>c.type==="text").map(c=>c.text).join(""));return [{data:parsed.nextStage?parsed.result:parsed,index,callId:m.toolCallId}];}catch{return [];}});
   const statusResult=results.filter(r=>Array.isArray(r.data.artifacts)&&r.data.currentStage).at(-1), status=statusResult?.data;
   const own=results.filter(r=>r.data.delivery&&r.data.role===role);
   const known=[...(status?.artifacts??[]),...results.filter(r=>r.data.kind).map(r=>r.data)];
   const get=kind=>known.findLast(a=>a.stage==="question"&&a.kind===kind);
   const mine=kind=>own.filter(r=>r.data.stage==="question"&&r.data.kind===kind).map(r=>r.data);
   const read=id=>results.some(r=>r.callId.endsWith("_read")&&r.data.id===id);
   const sourceIds=["RECOVERY-A","RECOVERY-B"].filter(id=>results.some(r=>r.data.access&&r.data.id===id));
   const material=get("stage-material"),draft=get("stage-draft"),risk=get("stage-risk"),critique=get("stage-critique"),revision=get("stage-revision"),verification=get("stage-verification");
   const base="确定性恢复软件验收的合成研究文本，不是真实发现。问题限定为实验报告中的证据表现与观察关联，不声称干预效果。保留来源、测量、样本、分析计划、伦理和结论边界；未来实际材料尚未提供，不编造统计结果。";
   const publish=(kind,refs=[],verdict)=>({operation:"publish",revision:status.revision,stage:"question",kind,refs,sourceIds,content:base+(kind==="stage-material"?(mine(kind).length?"第二批材料：仅补充未交的编码核验边界。":"第一批材料：已交可用字段说明，后续工作未完成。"):kind==="stage-draft"?"A在资料员失败之后实际读首批，提出区分满意度和论证质量的问题卡。":kind==="stage-critique"?"B在资料员失败之后读首批和A稿，要求将结果解释限制为观察关联。":kind==="stage-revision"?"A恢复后只完成缺少的修订：回应B，删去因果措辞并记录材料限制。":kind==="stage-verification"?"B恢复后只复核新修订，确认已回应批评，模型复核接受。":"独立判断或导师模型裁定；不是人的确认。"),...(verdict?{verdict}:{})});
   const readArg=id=>({operation:"read",artifactId:id});
   let args;
   if(!statusResult||statusResult.index<messages.findLastIndex(m=>m.role==="user")||statusResult.index<(own.at(-1)?.index??-1))args={operation:"status"};
   else if(status.status!=="running")args=undefined;
   else if(!results.some(r=>Array.isArray(r.data.records)&&r.data.stage==="question"))args={operation:"knowledge",query:"研究问题 证据 研究设计"};
   else if(role==="reviewer"&&!risk)args=publish("stage-risk");
   else if(sourceIds.length<2&&!(role==="librarian"&&sourceIds.length===1&&!mine("stage-material").length))args={operation:"source-read",sourceId:["RECOVERY-A","RECOVERY-B"].find(id=>!sourceIds.includes(id))};
   else if(role==="librarian"&&mine("stage-material").length<2)args=publish("stage-material");
   else if(!material&&role!=="librarian")args={operation:"status"};
   else if(material&&role!=="librarian"&&!read(material.id))args=readArg(material.id);
   else if(role==="lead"&&!draft)args=publish("stage-draft");
   else if(role==="lead"&&critique&&!revision)args=read(critique.id)?publish("stage-revision",[critique.id]):readArg(critique.id);
   else if(role==="lead"&&!critique)args={operation:"status"};
   else if(role==="reviewer"&&draft&&!critique)args=read(draft.id)?publish("stage-critique",[draft.id]):readArg(draft.id);
   else if(role==="reviewer"&&revision&&!verification)args=read(revision.id)?publish("stage-verification",[revision.id],"accept"):readArg(revision.id);
   else if(role==="reviewer"&&!verification)args={operation:"status"};
   else if(role==="mentor"&&verification&&revision&&!get("stage-review"))args=!read(verification.id)?readArg(verification.id):!read(revision.id)?readArg(revision.id):publish("stage-review",[revision.id,verification.id],"accept");
   else if(role==="mentor"&&!get("stage-review"))args={operation:"status"};
   const requestId=randomUUID(), callId="recovery_"+role+"_"+messages.length+"_"+(args?.operation??"text");
   const content=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:"本次已交工作完成，保留成果。"}];
   const message={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
   const stream=createAssistantMessageEventStream();
   const log=async(type)=>{const p=await state();const taskIds=new Set(p.fusion.tasks.filter(t=>t.role===role).map(t=>t.id));const a=p.fusion.attempts.findLast(a=>taskIds.has(a.taskId)&&["running","prepared"].includes(a.state));await appendFile(journal+"/"+role+".jsonl",JSON.stringify({at:new Date().toISOString(),role,requestId,type,attemptId:a?.id,nativeRunId:a?.nativeRunId,operation:args?.operation,kind:args?.kind})+"\\n");};
   const emit=async()=>{
    await log("request");stream.push({type:"start",partial:{...message,content:[]}});
    if(!statusResult)await waitFor(async()=> (await state()).members.filter(m=>m.status==="running").length===4,options?.signal,"Four members did not enter actual native runs");
    if(role==="librarian"&&mine("stage-material").length===1){
     const p=await state();
     if(!p.fusion.retryRequests?.some(r=>r.taskId==="v1:question:librarian")){
      await waitFor(async()=> (await gates()).failLibrarianAfterFirstBatch,options?.signal,"Test never released the librarian failure gate");
      await log("failure");throw new Error("RECOVERY_FIXTURE_NATIVE_FAILURE_AFTER_PUBLISHED_BATCH");
     }
    }
    if(role!=="librarian"&&args?.operation==="read"&&args.artifactId===material?.id)
     await waitFor(async()=> (await state()).fusion.attempts.some(a=>a.taskId==="v1:question:librarian"&&a.state==="failed"),options?.signal,"Consumers must read after the librarian native failure");
    if(role==="lead"&&args?.kind==="stage-revision")
     await waitFor(async()=> (await gates()).finishRemainingWork,options?.signal,"Final revision gate was not released");
    if(args?.operation==="status"&&statusResult&&status.status==="running"){
     const needed=!material&&role!=="librarian"?"stage-material":role==="lead"&&draft&&!critique?"stage-critique":role==="reviewer"&&!draft?"stage-draft":role==="reviewer"&&critique&&!revision?"stage-revision":role==="mentor"&&!verification?"stage-verification":undefined;
     if(needed)await waitFor(async()=> (await state()).artifacts.some(a=>a.stage==="question"&&a.kind===needed),options?.signal,"Required persisted handoff never arrived: "+needed);
    }
    if(options?.signal?.aborted)throw new Error("fixture response aborted");
    if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:content[0],partial:message});}
    else stream.push({type:"text_delta",contentIndex:0,delta:content[0].text,partial:message});
    await log("response");stream.push({type:"done",reason:message.stopReason,message});
   };
   void emit().catch(async error=>{if(options?.signal?.aborted)await log("aborted");stream.push({type:"error",reason:options?.signal?.aborted?"aborted":"error",error:{...message,content:[],stopReason:options?.signal?.aborted?"aborted":"error",errorMessage:String(error)}});});
   return stream;
  }
 });
}
`,
  );
  return {
    profile,
    workspace,
    kb,
    materials,
    agentDir,
    setGates,
    launch: () =>
      launchDesktop(profile, {
        agentDir,
        initialWorkspaces: [workspace],
        testMode: "background",
        scrubProviderEnv: true,
      }),
    readJournal: async (): Promise<RecoveryProviderEvent[]> =>
      (
        await Promise.all(
          ["mentor", "lead", "reviewer", "librarian"].map(async (role) => {
            const content = await readFile(join(journal, `${role}.jsonl`), "utf8").catch(() => "");
            return content.trim()
              ? content
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line) as RecoveryProviderEvent)
              : [];
          }),
        )
      )
        .flat()
        .sort((a, b) => a.at.localeCompare(b.at)),
  };
}
