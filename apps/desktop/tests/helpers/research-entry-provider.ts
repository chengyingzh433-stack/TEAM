import { writeProjectExtension } from "./electron-app";

/** AC20 routing fixture: actual native tools and synthetic evidence, never R/C content proof. */
export async function writeResearchEntryProvider(
  workspace: string,
  selectedSourceIds?: string[],
): Promise<void> {
  await writeProjectExtension(
    workspace,
    "research-entry-fixture.ts",
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const selectedSourceIds = ${JSON.stringify(selectedSourceIds ?? null)};
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export default function(pi) {
  pi.registerProvider("research-entry-fixture", {baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-entry-fixture",models:[{id:"gpt-6.1-sol",name:"AC20 local fixture",reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple(model,context,options) {
      const messages=context.messages;
      if(messages.length>300)throw new Error("AC20 fixture exceeded one-stage tool budget");
      const failure=messages.find(message=>message.role==="toolResult"&&message.isError);
      if(failure)throw new Error("AC20 fixture tool failure: "+JSON.stringify(failure.content));
      const instructions=messages.filter(message=>message.role==="user").map(message=>JSON.stringify(message.content)).join("\\n");
      const match=instructions.match(/你是教育研究课题组的(研究者 A|研究者 B|资料员|导师)/);
      if(!match)throw new Error("AC20 fixture missing member instruction");
      const role={"研究者 A":"lead","研究者 B":"reviewer","资料员":"librarian","导师":"mentor"}[match[1]];
      const results=messages.flatMap((message,index)=>{
        if(message.role!=="toolResult"||message.isError)return [];
        try{const parsed=JSON.parse(message.content.filter(c=>c.type==="text").map(c=>c.text).join(""));return [{data:parsed.nextStage?parsed.result:parsed,index,callId:message.toolCallId}];}catch{return [];}
      });
      const statusResult=results.filter(result=>Array.isArray(result.data.artifacts)&&result.data.currentStage).at(-1);
      const status=statusResult?.data, phase=status?.currentStage;
      const own=results.filter(result=>result.data.delivery&&result.data.role===role);
      const lastUser=messages.findLastIndex(message=>message.role==="user");
      const known=[...(status?.artifacts??[]),...results.filter(result=>result.data.kind).map(result=>result.data)];
      const get=(kind,author)=>known.findLast(artifact=>artifact.stage===phase&&artifact.kind===kind&&(!author||artifact.role===author));
      const read=id=>results.some(result=>result.callId.endsWith("_read")&&result.data.id===id);
      const sources=(status?.evidence?.sources??[]).filter(source=>!selectedSourceIds||selectedSourceIds.includes(source.id));
      const readSources=sources.filter(source=>results.some(result=>result.data.access&&result.data.id===source.id)).map(source=>source.id);
      const knowledge=results.some(result=>Array.isArray(result.data.records)&&result.data.stage===phase);
      const draft=get("stage-draft","lead"), risk=get("stage-risk","reviewer"), critique=get("stage-critique","reviewer"), revision=get("stage-revision","lead"), verification=get("stage-verification","reviewer");
      const content="这是 AC20 确定性 Electron 路由验收的合成文本，不是真实文献结论。当前仅执行阶段 "+phase+"，沿用用户指定范围，不扩展完整流程。已通过 source-read 读取提供材料并保留定位。区分研究问题、构念与推断边界；满意度不能代替论证质量，关联不能写成因果。当前没有CSV，不声称完成数值复算；支持原文不足时保留待核验。所提供的方案或稿件不是早期阶段已经执行的证据。";
      const publish=(kind,refs=[],verdict)=>({operation:"publish",revision:status.revision,stage:phase,kind,refs,sourceIds:readSources,content:content+(kind==="stage-critique"?"具体批评：删除满意度替代论证质量的表达，明确未来材料条件。":kind==="stage-revision"?"逐条回应批评：收窄结论并明确未执行材料、分析与授权检查。":kind==="stage-verification"?"逐项核对修订已回应上述问题，仅在用户指定范围内通过。":"仅为指定范围的合成研究交付。"),...(verdict?{verdict}:{})});
      const readArg=id=>({operation:"read",artifactId:id});
      let args;
      if(!statusResult||statusResult.index<lastUser||statusResult.index<(own.at(-1)?.index??-1))args={operation:"status"};
      else if(status.status!=="running")args=undefined;
      else if(!knowledge)args={operation:"knowledge",query:"研究问题 证据 边界"};
      else if(readSources.length<sources.length)args={operation:"source-read",sourceId:sources.find(source=>!readSources.includes(source.id)).id};
      else if(role==="librarian"&&!get("stage-material","librarian"))args=publish("stage-material");
      else if(role==="reviewer"&&!risk)args=publish("stage-risk");
      else if(role==="lead"&&!draft)args=publish("stage-draft");
      else if(role==="lead"&&critique&&!revision)args=read(critique.id)?publish("stage-revision",[critique.id]):readArg(critique.id);
      else if(role==="reviewer"&&draft&&!critique)args=read(draft.id)?publish("stage-critique",[draft.id]):readArg(draft.id);
      else if(role==="reviewer"&&revision&&!verification)args=read(revision.id)?publish("stage-verification",[revision.id],"accept"):readArg(revision.id);
      else if(role==="mentor"&&verification&&revision&&!get("stage-review","mentor"))args=!read(verification.id)?readArg(verification.id):!read(revision.id)?readArg(revision.id):publish("stage-review",[revision.id,verification.id],"accept");
      const stream=createAssistantMessageEventStream();
      const callId="entry_"+role+"_"+messages.length+"_"+(args?.operation??"text");
      const output=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:"本轮指定范围已交付或等待实际成果交接；不自动扩展其他阶段。"}];
      const message={role:"assistant",content:output,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
      queueMicrotask(()=>{
        if(options?.signal?.aborted){stream.push({type:"error",reason:"aborted",error:{...message,content:[],stopReason:"aborted",errorMessage:"Paused by user"}});return;}
        stream.push({type:"start",partial:{...message,content:[]}});
        if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:output[0],partial:message});}
        else stream.push({type:"text_delta",contentIndex:0,delta:output[0].text,partial:message});
        stream.push({type:"done",reason:message.stopReason,message});
      });
      return stream;
    }
  });
}
`,
  );
}
