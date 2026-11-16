import { join } from "node:path";
import { writeProjectExtension } from "./electron-app";

/** Deterministic Pi provider: real tool executions, no external credentials. */
export async function writeResearchGroupProvider(
  workspace: string,
  profile: string,
  fixtureOptions: { pauseAtAnalysis?: boolean } = {},
): Promise<void> {
  await writeProjectExtension(
    workspace,
    "research-routing-fixture.ts",
    `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
const stateFile = ${JSON.stringify(profile + "/research-groups.json")};
const analysisRelease = ${JSON.stringify(join(workspace, "analysis-release"))};
const pauseAtAnalysis = ${JSON.stringify(!!fixtureOptions.pauseAtAnalysis)};
const usage = {input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
export default function(pi) {
  pi.registerProvider("research-routing-fixture", {baseUrl:"http://127.0.0.1:9/unused",apiKey:"LOCAL_FIXTURE",api:"research-routing-fixture",models:["gpt-6-astra","gpt-6.1-sol","deepseek-flash"].map(id=>({id,name:id,reasoning:true,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}})),
    streamSimple(model, context, options) {
      const messages = context.messages;
      const failure=messages.find(m=>m.role==="toolResult" && m.isError);
      if(failure)throw new Error("Fixture tool failure: "+JSON.stringify(failure.content));
      if(messages.length>650)throw new Error("Fixture exceeded its bounded conversation budget");
      const first = JSON.stringify(messages.find(m=>m.role==="user")?.content ?? "");
      const role = first.includes("你是教育研究课题组的研究者 A") ? "lead" : first.includes("你是教育研究课题组的研究者 B") ? "reviewer" : first.includes("你是教育研究课题组的资料员") ? "librarian" : "mentor";
      const results = messages.flatMap((m,index)=>{
        if(m.role!=="toolResult" || m.isError)return [];
        try { const parsed=JSON.parse(m.content.filter(c=>c.type==="text").map(c=>c.text).join("")); return [{data:parsed.nextStage ? parsed.result : parsed,index,callId:m.toolCallId}]; } catch {return [];}
      });
      const own = results.filter(r=>r.data.delivery && r.data.role===role);
      const published = kind=>own.filter(r=>r.data.kind===kind).map(r=>r.data);
      const read = id=>results.some(r=>r.callId.endsWith("_read") && r.data.id===id);
      const known = results.flatMap(r=>r.data.artifacts ?? (r.data.kind ? [r.data] : []));
      const get = kind=>known.find(a=>a.kind===kind);
      const lastUser=messages.findLastIndex(m=>m.role==="user");
      const lastStatus=results.filter(r=>r.data.artifacts).at(-1)?.index ?? -1;
      const initial=role==="mentor"?"plan":role==="lead"?"proposal":role==="reviewer"?"assessment":"material";
      const lastOwn=own.at(-1)?.index ?? -1;
      let args;
      const body = "模型="+model.id+"。合成验收文本：问题与证据必须匹配，满意度不替代论证质量，单班变化不支持因果归因；明确测量、质量控制、待确认条件及可支持的结论。所有文字仅用于本地模型切换与交接测试，不是实际研究建议。";
      const publish=(kind,refs=[],verdict)=>({operation:"publish",revision:1,kind,content:body,refs,...(verdict?{verdict}:{})});
      const readArg=id=>({operation:"read",artifactId:id});
      const phaseMatch=[...messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\\n").matchAll(/当前 stage=(literature|design|analysis|writing|audit)/g)].at(-1);
      const phase=phaseMatch?.[1];
      const status=results.filter(r=>r.data.artifacts).at(-1)?.data;
      const phaseOwn=kind=>own.filter(r=>r.data.stage===phase && r.data.kind===kind).map(r=>r.data);
      const phaseGet=kind=>known.findLast(a=>a.stage===phase && a.kind===kind);
      const sourceIds=["FIXTURE-A","FIXTURE-B"].filter(id=>results.some(r=>r.data.access&&r.data.id===id));
      const run=results.filter(r=>r.data.engine&&r.data.spec).at(-1)?.data;
      const primary=status?.analyses?.find(a=>a.role==="lead");
      const analysisId=primary?.id??run?.id;
      const analysisRead=analysisId && results.some(r=>r.data.engine&&r.data.id===analysisId);
      const manuscript="# 合成数据演练论文\\n\\n## 摘要\\n本稿是验证软件协作链的合成数据演练，不是真实教育研究。[SRC:FIXTURE-A] [SRC:FIXTURE-B]\\n\\n## 方法\\n对六行演练数据执行已冻结最小二乘回归。[ANALYSIS:"+analysisId+"]\\n\\n## 结果\\n"+JSON.stringify(run?.result??{})+"\\n\\n## 讨论\\n"+body.repeat(8)+"\\n\\n## 参考文献\\n合成来源 A 与 B，https://example.test/A ，https://example.test/B。";
      const pp=(kind,refs=[],verdict)=>({...publish(kind,refs,verdict),stage:phase,sourceIds,analysisIds:analysisRead?[analysisId]:[],...(phase==="design"&&kind==="stage-revision"?{analysisPlan:{datasetId:"FIXTURE-DATA",method:"ols",columns:["x"],outcome:"y"}}:{}),...(phase==="audit"&&kind==="stage-revision"?{content:manuscript}:{} )});
      if(phase){
        const initialKind=role==="lead"?"stage-draft":role==="reviewer"?"stage-risk":"stage-material";
        const previous=status?.previousStageReview, material=phaseGet("stage-material"),draft=phaseGet("stage-draft"),critique=phaseGet("stage-critique"),revision=phaseGet("stage-revision"),verification=phaseGet("stage-verification");
        if(!status || lastStatus<lastUser || lastStatus<lastOwn)args={operation:"status"};
        else if(status.currentStage!==phase)args=undefined;
        else if(previous&&!read(previous))args=readArg(previous);
        else if(role==="reviewer"&&!phaseOwn("stage-risk").length)args=pp("stage-risk",[previous]);
        else if(role!=="mentor"&&sourceIds.length<2 && !(role==="librarian"&&sourceIds.length===1&&!phaseOwn(initialKind).length))args={operation:"source-read",sourceId:["FIXTURE-A","FIXTURE-B"].find(id=>!sourceIds.includes(id))};
        else if(role==="librarian"&&phaseOwn(initialKind).length<2)args=pp(initialKind);
        else if(material && role!=="librarian" && !read(material.id))args=readArg(material.id);
        else if(phase==="analysis" && ["lead","reviewer"].includes(role) && !results.some(r=>r.data.engine&&r.data.role===role))args={operation:"analyze",datasetId:"FIXTURE-DATA",method:"ols",columns:["x"],outcome:"y"};
        else if(["writing","audit"].includes(phase)&&role!=="librarian"&&analysisId&&!analysisRead)args={operation:"read-analysis",analysisId};
        else if(role==="lead"&&!phaseOwn("stage-draft").length)args=pp("stage-draft",[previous]);
        else if(role==="lead"&&critique&&!phaseOwn("stage-revision").length)args=read(critique.id)?pp("stage-revision",[critique.id]):readArg(critique.id);
        else if(role==="reviewer"&&draft&&!phaseOwn("stage-critique").length)args=read(draft.id)?pp("stage-critique",[draft.id]):readArg(draft.id);
        else if(role==="reviewer"&&revision&&!phaseOwn("stage-verification").length)args=read(revision.id)?pp("stage-verification",[revision.id],"accept"):readArg(revision.id);
        else if(role==="mentor"&&verification&&revision&&!phaseOwn("stage-review").length)args=!read(verification.id)?readArg(verification.id):!read(revision.id)?readArg(revision.id):pp("stage-review",[revision.id,verification.id],"accept");
      }
      else       if(!results.some(r=>r.data.records)) args={operation:"knowledge",query:"研究问题 证据"};
      else if(!published(initial).length) args=publish(initial);
      else if(role==="librarian") {
        if(published("material").length===1 && results.filter(r=>r.data.records).length===1)args={operation:"knowledge",query:"研究设计 论文写作"};
        else if(published("material").length===1)args=publish("material");
      } else if(lastStatus<lastUser || lastStatus<lastOwn) args={operation:"status"};
      else if(role==="lead") {
        const material=get("material"), critique=get("critique");
        if(material && !read(material.id))args=readArg(material.id);
        else if(critique && !published("revision").length)args=read(critique.id)?publish("revision",[critique.id]):readArg(critique.id);
      } else if(role==="reviewer") {
        const material=get("material"), proposal=get("proposal"), revision=get("revision");
        if(material && !read(material.id))args=readArg(material.id);
        else if(proposal && !published("critique").length)args=read(proposal.id)?publish("critique",[proposal.id]):readArg(proposal.id);
        else if(revision && !published("verification").length)args=read(revision.id)?publish("verification",[revision.id],"accept"):readArg(revision.id);
      } else {
        const verification=get("verification"), revision=get("revision");
        if(verification && revision && !published("review").length)args=!read(verification.id)?readArg(verification.id):!read(revision.id)?readArg(revision.id):publish("review",[revision.id,verification.id],"accept");
      }
      const stream=createAssistantMessageEventStream();
      const callId="rgf_"+role+"_"+messages.length+"_"+(args?.operation ?? "text");
      const content=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:"已完成当前工作，等待中途交接。"}];
      const message={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
      const emit=async()=>{
        stream.push({type:"start",partial:{...message,content:[]}});
        if(pauseAtAnalysis && phase==="analysis") {
          let released=false;const deadline=Date.now()+30000;
          while(Date.now()<deadline&&!options?.signal?.aborted){try{await readFile(analysisRelease);released=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
          if(!released&&!options?.signal?.aborted)throw new Error("Analysis fixture remained gated without a pause/resume");
        }
        // Keep the producer's second useful output pending until a consumer reads its first.
        // A collect-after-all-finish implementation cannot satisfy this fixture.
        if(role==="librarian" && ((args?.kind==="material" && published("material").length===1)||(args?.kind==="stage-material"&&phaseOwn("stage-material").length===1))){
          const id=phase?phaseOwn("stage-material")[0].id:published("material")[0].id, deadline=Date.now()+10000;
          let consumed=false;
          while(Date.now()<deadline && !options?.signal?.aborted){
            try { const s=JSON.parse(await readFile(stateFile,"utf8")); consumed=s.projects.some(p=>p.events.some(e=>e.type==="read"&&e.artifactId===id&&e.role!=="librarian")); } catch {}
            if(consumed)break;
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          if(!consumed && !options?.signal?.aborted)throw new Error("Consumer did not read intermediate material while producer remained active");
        }
        if(options?.signal?.aborted){stream.push({type:"error",reason:"aborted",error:{...message,content:[],stopReason:"aborted",errorMessage:"Paused by the user"}});return;}
        if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:content[0],partial:message});}
        else stream.push({type:"text_delta",contentIndex:0,delta:content[0].text,partial:message});
        stream.push({type:"done",reason:message.stopReason,message});
      };
      void emit().catch(error=>stream.push({type:"error",reason:"error",error:{...message,content:[],stopReason:"error",errorMessage:String(error)}}));
      return stream;
    }
  });
}`,
  );
}
