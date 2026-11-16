import { join } from "node:path";
import { writeProjectExtension } from "./electron-app";

export const DATA_CONTINUATION_PROVIDER = "research-data-continuation-fixture";
export function dataContinuationGatePaths(profile: string) {
  return {
    waiting: join(profile, "old-analysis-waiting.json"),
    release: join(profile, "release-old-analysis"),
  };
}

/** A deterministic native Pi provider; only response timing is controlled, never project state. */
export async function writeResearchDataContinuationProvider(workspace: string, profile: string) {
  await writeProjectExtension(
    workspace,
    "research-data-continuation-fixture.ts",
    String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFile, writeFile, access } from "node:fs/promises";
const stateFile = ${JSON.stringify(join(profile, "research-groups.json"))};
const gates = ${JSON.stringify(dataContinuationGatePaths(profile))};
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
export default function(pi) {
  pi.registerProvider(${JSON.stringify(DATA_CONTINUATION_PROVIDER)}, {baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:${JSON.stringify(DATA_CONTINUATION_PROVIDER)},models:[{id:"gpt-6.1-sol",name:"Deterministic data continuation",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple(model,context,options) {
      const stream=createAssistantMessageEventStream();
      const emit=async()=>{
        const messages=context.messages;
        if(messages.length>700)throw new Error("Data continuation fixture exceeded bounded conversation");
        const failure=messages.find(m=>m.role==="toolResult"&&m.isError);
        if(failure)throw new Error("Data continuation tool failure: "+JSON.stringify(failure.content));
        const instructions=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\n");
        const match=instructions.match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
        if(!match)throw new Error("Missing actual role instruction");
        const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]];
        const p=JSON.parse(await readFile(stateFile,"utf8")).projects[0];
        const attempt=p.fusion.attempts.findLast(a=>["prepared","running"].includes(a.state)&&p.fusion.tasks.find(t=>t.id===a.taskId)?.role===role);
        if(!attempt)throw new Error("Missing persisted native attempt for "+role);
        const task=p.fusion.tasks.find(t=>t.id===attempt.taskId), phase=task.stage;
        const results=messages.flatMap(m=>{
          if(m.role!=="toolResult"||m.isError||!m.toolCallId?.includes(attempt.id))return [];
          try{const parsed=JSON.parse(m.content.filter(c=>c.type==="text").map(c=>c.text).join(""));return [{data:parsed.nextStage?parsed.result:parsed,callId:m.toolCallId}];}catch{return [];}
        });
        const valid=a=>{const record=p.fusion.artifacts.find(r=>r.id===a.id);const owner=record&&p.fusion.tasks.find(t=>t.id===record.taskId);return !record||(owner?.inputVersion===record.taskVersion&&!["needs-review","superseded"].includes(record.reviewState));};
        const get=(kind,stage=phase)=>p.artifacts.findLast(a=>a.revision===p.revision&&a.stage===stage&&a.kind===kind&&valid(a));
        const read=id=>results.some(r=>r.callId.endsWith("_read")&&r.data.id===id);
        const source=p.evidence.sources.find(s=>s.kind==="dataset");
        const sourceRead=source&&results.some(r=>r.callId.endsWith("_source-read")&&r.data.id===source.id&&r.data.sha256===source.sha256);
        const previous=get("stage-review",phase==="design"?"synthesis":"design");
        const refs=previous?[previous.id]:[];
        const draft=get("stage-draft"),risk=get("stage-risk"),critique=get("stage-critique"),revision=get("stage-revision"),verification=get("stage-verification");
        const analysis=results.findLast(r=>r.callId.endsWith("_analyze"))?.data;
        const readArg=id=>({operation:"read",artifactId:id});
        const content="仅供确定性软件集成验收的合成研究文本。阶段="+phase+"，输入任务版本="+task.inputVersion+"。保留问题与文献综合，只核对新材料的来源、字段、完整案例和设计适配。观察关联不能解释为因果，不将模型判断当成人类确认。";
        const publish=(kind,needed=[],verdict)=>({operation:"publish",revision:p.revision,stage:phase,kind,refs:needed,sourceIds:sourceRead?[source.id]:[],content:content+(kind==="stage-revision"?"已经逐条回应具体批评，按当前x与y字段登记OLS计划。":kind==="stage-critique"?"请明确x与y的操作定义及不作因果解释的限制。":kind==="stage-draft"&&analysis?" OLD_OR_CURRENT_ANALYSIS="+analysis.id+" DATA_HASH="+analysis.datasetSha256:"完成本角色当前核查。"),...(analysis&&["stage-draft","stage-revision"].includes(kind)?{analysisIds:[analysis.id]}:{}),...(verdict?{verdict}:{}),...(phase==="design"&&kind==="stage-revision"?{analysisPlan:{datasetId:p.evidence.datasets[0].id,method:"ols",columns:["x"],outcome:"y"}}:{})});
        let args;
        if(attempt.taskVersion!==task.inputVersion)args=undefined;
        else if(!results.some(r=>r.callId.endsWith("_status")))args={operation:"status"};
        else if(!results.some(r=>r.callId.endsWith("_knowledge")))args={operation:"knowledge",query:"研究设计 变量 分析 证据边界"};
        else if(previous&&!read(previous.id))args=readArg(previous.id);
        else if(source&&!sourceRead)args={operation:"source-read",sourceId:source.id};
        else if(phase==="design"){
          if(role==="lead"&&!draft)args=publish("stage-draft",refs);
          else if(role==="reviewer"&&!risk)args=publish("stage-risk",refs);
          else if(role==="librarian"&&!get("stage-material"))args=publish("stage-material");
          else if(role==="reviewer"&&draft&&!critique)args=read(draft.id)?publish("stage-critique",[draft.id]):readArg(draft.id);
          else if(role==="lead"&&critique&&!revision)args=read(critique.id)?publish("stage-revision",[critique.id]):readArg(critique.id);
          else if(role==="reviewer"&&revision&&!verification)args=read(revision.id)?publish("stage-verification",[revision.id],"accept"):readArg(revision.id);
          else if(role==="mentor"&&revision&&verification&&!get("stage-review"))args=!read(revision.id)?readArg(revision.id):!read(verification.id)?readArg(verification.id):publish("stage-review",[revision.id,verification.id],"accept");
        } else if(phase==="analysis"){
          if(role==="reviewer"&&!risk)args=publish("stage-risk",refs);
          else if(role==="librarian"&&!get("stage-material"))args=publish("stage-material");
          else if(role==="lead"&&!analysis)args={operation:"analyze",...p.analysisPlan};
          else if(role==="lead"&&analysis&&!draft)args=publish("stage-draft",refs);
        } else throw new Error("Unexpected stage in bounded data fixture: "+phase);
        const callId="dataflow_"+attempt.id+"_"+messages.length+"_"+(args?.operation??"text");
        const output=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:"当前工作已交付，等待实际交接；此fixture不自动进入写作。"}];
        const message={role:"assistant",content:output,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
        stream.push({type:"start",partial:{...message,content:[]}});
        if(role==="lead"&&phase==="analysis"&&args?.kind==="stage-draft"&&analysis&&!(await exists(gates.waiting))){
          await writeFile(gates.waiting,JSON.stringify({attemptId:attempt.id,analysisId:analysis.id,taskVersion:attempt.taskVersion,datasetSha256:analysis.datasetSha256}),{flag:"wx"});
          const deadline=Date.now()+30000;
          while(!(await exists(gates.release))&&!options?.signal?.aborted&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,15));
          if(!(await exists(gates.release))&&!options?.signal?.aborted)throw new Error("Old native response gate was not released by the UI scenario");
        }
        if(options?.signal?.aborted){stream.push({type:"error",reason:"aborted",error:{...message,content:[],stopReason:"aborted",errorMessage:"Paused by test"}});return;}
        if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:output[0],partial:message});}
        else stream.push({type:"text_delta",contentIndex:0,delta:output[0].text,partial:message});
        stream.push({type:"done",reason:message.stopReason,message});
      };
      void emit().catch(error=>stream.push({type:"error",reason:"error",error:{role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"error",timestamp:Date.now(),errorMessage:String(error)}}));
      return stream;
    }
  });
}
`,
  );
}
