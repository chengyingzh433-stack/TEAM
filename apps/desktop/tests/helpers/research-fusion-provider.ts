import { join } from "node:path";
import { writeProjectExtension } from "./electron-app";

/** Local deterministic provider, exercising native Pi tools; never R/C evidence. */
export async function writeResearchFusionProvider(
  workspace: string,
  profile: string,
): Promise<void> {
  await writeProjectExtension(
    workspace,
    "research-fusion-fixture.ts",
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
const stateFile = ${JSON.stringify(join(profile, "research-groups.json"))};
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const stages=["scan","question","search","reading","synthesis","design","analysis","writing","audit"];
export default function(pi) {
  pi.registerProvider("research-fusion-fixture", {baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-fusion-fixture",models:["gpt-6-astra","gpt-6.1-sol","deepseek-flash"].map(id=>({id,name:id,reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}})),
    streamSimple(model,context,options) {
      const messages=context.messages;
      if(messages.length>900)throw new Error("Fusion fixture exceeded its bounded tool conversation");
      const failure=messages.find(m=>m.role==="toolResult"&&m.isError);
      if(failure)throw new Error("Fusion fixture tool failure: "+JSON.stringify(failure.content));
      const instructions=messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\\n");
      const roleMatch=instructions.match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
      if(!roleMatch)throw new Error("Fusion fixture could not identify its actual member instruction");
      const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[roleMatch[1]];
      const results=messages.flatMap((message,index)=>{
        if(message.role!=="toolResult"||message.isError)return [];
        try{const parsed=JSON.parse(message.content.filter(c=>c.type==="text").map(c=>c.text).join(""));return [{data:parsed.nextStage?parsed.result:parsed,index,callId:message.toolCallId}];}catch{return [];}
      });
      const lastUser=messages.findLastIndex(m=>m.role==="user");
      const statusResult=results.filter(r=>Array.isArray(r.data.artifacts)&&r.data.currentStage).at(-1);
      const status=statusResult?.data;
      const own=results.filter(r=>r.data.delivery&&r.data.role===role);
      const latestOwnIndex=own.at(-1)?.index??-1;
      const lastPhase=[...instructions.matchAll(/stage=(scan|question|search|reading|synthesis|design|analysis|writing|audit)/g)].at(-1)?.[1];
      const phase=status?.currentStage??lastPhase;
      if(phase&&!stages.includes(phase))throw new Error("Unexpected fusion stage "+phase);
      const known=[...(status?.artifacts??[]),...results.filter(r=>r.data.kind).map(r=>r.data)];
      const get=(kind,author)=>known.findLast(a=>a.stage===phase&&a.kind===kind&&(!author||a.role===author));
      const mine=kind=>own.filter(r=>r.data.stage===phase&&r.data.kind===kind).map(r=>r.data);
      const read=id=>results.some(r=>r.callId.endsWith("_read")&&r.data.id===id);
      const knowledge=results.filter(r=>Array.isArray(r.data.records)&&r.data.stage===phase).at(-1);
      const sourceIds=["FUSION-A","FUSION-B"].filter(id=>results.some(r=>r.index>(knowledge?.index??-1)&&r.data.access&&r.data.id===id));
      const previous=status?.previousStageReview;
      const previousRefs=previous?[previous]:[];
      const material=get("stage-material","librarian"), draft=get("stage-draft","lead"), risk=get("stage-risk","reviewer"), critique=get("stage-critique","reviewer"), revision=get("stage-revision","lead"), verification=get("stage-verification","reviewer");
      const base="这是确定性 Electron 集成验收的合成文本，不是真实研究。模型="+model.id+"；阶段="+phase+"。记录问题、对象、证据、变量、材料获取、分析预案、伦理计划、现实条件与结论边界。当前没有实际数据，不生成结果，不把计划采集写成已经实施。";
      const publish=(kind,refs=[],verdict)=>({operation:"publish",revision:status.revision,stage:phase,kind,refs,sourceIds,content:base+(kind==="stage-draft"?"初始方案保留待澄清点：满意度与报告论证质量是否混淆。":kind==="stage-critique"?"具体批评：初稿须分离满意度与论证质量，先登记评分文本与指标，不声称AI引起提升。":kind==="stage-revision"?"逐条回应B：删除满意度替代论证质量的推断；研究目标收窄为观察关联，列出未来原始报告、评分标准及检查步骤。":kind==="stage-verification"?"逐项核对修订已回应构念混淆及因果表达，当前范围为研究方案。":"本条为方法资料或模型范围裁定，不是人的确认。"),...(verdict?{verdict}:{}),...(phase==="design"&&kind==="stage-revision"?{analysisPlan:{datasetId:"FUTURE-DATA",method:"ols",columns:["x"],outcome:"y"}}:{})});
      const readArg=id=>({operation:"read",artifactId:id});
      let args;
      if(!statusResult||statusResult.index<lastUser||statusResult.index<latestOwnIndex)args={operation:"status"};
      else if(status.status!=="running")args=undefined;
      else if(!knowledge)args={operation:"knowledge",query:"研究问题 证据 研究设计 论文写作"};
      else if(previous&&!read(previous))args=readArg(previous);
      else if(role==="reviewer"&&!risk)args=publish("stage-risk",previousRefs);
      else if(sourceIds.length<2&&!(role==="librarian"&&sourceIds.length===1&&!mine("stage-material").length))args={operation:"source-read",sourceId:["FUSION-A","FUSION-B"].find(id=>!sourceIds.includes(id))};
      else if(role==="librarian"&&mine("stage-material").length<2)args=publish("stage-material");
      else if(!material&&role!=="librarian")args={operation:"status"};
      else if(material&&role!=="librarian"&&!read(material.id))args=readArg(material.id);
      else if(phase==="analysis"&&role==="lead")args=undefined;
      else if(role==="lead"&&!draft)args=publish("stage-draft",previousRefs);
      else if(role==="lead"&&critique&&!revision)args=read(critique.id)?publish("stage-revision",[critique.id]):readArg(critique.id);
      else if(role==="reviewer"&&draft&&!critique)args=read(draft.id)?publish("stage-critique",[draft.id]):readArg(draft.id);
      else if(role==="reviewer"&&revision&&!verification)args=read(revision.id)?publish("stage-verification",[revision.id],"accept"):readArg(revision.id);
      else if(role==="mentor"&&verification&&revision&&!get("stage-review","mentor"))args=!read(verification.id)?readArg(verification.id):!read(revision.id)?readArg(revision.id):publish("stage-review",[revision.id,verification.id],"accept");
      const stream=createAssistantMessageEventStream();
      const callId="fusion_"+role+"_"+messages.length+"_"+(args?.operation??"text");
      const content=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:"本阶段已交付或等待必要交接；不伪造材料和结果。"}];
      const message={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
      const waitFor=async(predicate,label)=>{
        const deadline=Date.now()+15000;
        while(Date.now()<deadline&&!options?.signal?.aborted){
          const state=JSON.parse(await readFile(stateFile,"utf8"));
          if(state.projects.some(predicate))return;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        if(!options?.signal?.aborted)throw new Error(label);
      };
      const emit=async()=>{
        stream.push({type:"start",partial:{...message,content:[]}});
        if(!statusResult)await waitFor(p=>p.members.filter(m=>m.status==="running").length===4,"Four native member runs never overlapped at fusion entry");
        if(statusResult&&args?.operation==="status"&&role!=="librarian"&&!material)
          await waitFor(p=>p.artifacts.some(a=>a.stage===phase&&a.kind==="stage-material"),"Fixture stage material was never published");
        if(role==="librarian"&&args?.kind==="stage-material"&&mine("stage-material").length===1){
          const first=mine("stage-material")[0];
          await waitFor(p=>p.events.some(e=>e.type==="read"&&e.artifactId===first.id&&e.role!=="librarian"),"Consumer did not read the first fusion batch while its producer was still executing");
        }
        if(options?.signal?.aborted){stream.push({type:"error",reason:"aborted",error:{...message,content:[],stopReason:"aborted",errorMessage:"Paused by test user"}});return;}
        if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:content[0],partial:message});}
        else stream.push({type:"text_delta",contentIndex:0,delta:content[0].text,partial:message});
        stream.push({type:"done",reason:message.stopReason,message});
      };
      void emit().catch(error=>stream.push({type:"error",reason:"error",error:{...message,content:[],stopReason:"error",errorMessage:String(error)}}));
      return stream;
    }
  });
}
`,
  );
}
