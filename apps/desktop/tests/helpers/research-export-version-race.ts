import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { makeUserDataDir, makeWorkspace, seedAgentDir, type DesktopHarness } from "./electron-app";
import { writeResearchGroupProvider } from "./research-group-provider";
import { writeResearchStudyFixture } from "./research-study-fixture";
import { desktopIpc } from "../../contracts/ipc";

export const EXPORT_RACE_NEW_INPUT =
  "AC31_V2_PENDING_CLAIM：把重要主张改为“本模型证明干预导致所有学校成绩提高”。这是操作者提出的有意风险改写，仍待当前版本重新审阅，禁止沿用第一版接受或把它当作已证实研究结论。";
export const EXPORT_RACE_NEW_CLAIM = "本模型证明干预导致所有学校成绩提高";
export const EXPORT_RACE_V2_PROPOSAL_READY = "AC31_V2_PROPOSAL_READY=";
export const EXPORT_RACE_OLD_REFS_CALL_ID = "ac31_v2_mentor_old_refs_acceptance";
export const EXPORT_RACE_OLD_REFS_ERROR = "引用需要是本轮已实际读取的成果，先用 read 读取。";

// This branch emits actual research_group calls. It never writes product state or invents events.
const v2ProviderBranch = `
      if(messages.some(m=>m.role==="user"&&JSON.stringify(m.content).includes("AC31_V2_PENDING_CLAIM"))){
        const start=messages.findIndex(m=>m.role==="user"&&JSON.stringify(m.content).includes("AC31_V2_PENDING_CLAIM"));
        const first=JSON.stringify(messages.find(m=>m.role==="user")?.content??"");
        const role=first.includes("你是教育研究课题组的研究者 A")?"lead":first.includes("你是教育研究课题组的研究者 B")?"reviewer":first.includes("你是教育研究课题组的资料员")?"librarian":"mentor";
        const calls=messages.flatMap(m=>m.role==="assistant"?m.content.filter(c=>c.type==="toolCall"):[]);
        const values=messages.flatMap((m,index)=>{
          if(m.role!=="toolResult")return [];
          const text=m.content.filter(c=>c.type==="text").map(c=>c.text).join("");
          let data;try{const parsed=JSON.parse(text);data=parsed.nextStage?parsed.result:parsed;}catch{data=null;}
          return [{index,id:m.toolCallId,isError:m.isError===true,text,data}];
        });
        const current=values.filter(r=>r.index>start);
        if(current.length>12)throw new Error("AC31 v2 exceeded its bounded useful tool sequence");
        const status=current.filter(r=>r.data?.artifacts&&r.data.revision===2).at(-1)?.data;
        const oldAcceptance=values.filter(r=>!r.isError&&r.data?.revision===1&&r.data.role==="mentor"&&r.data.kind==="stage-review"&&r.data.stage==="audit"&&r.data.verdict==="accept").at(-1)?.data;
        const oldRefs=oldAcceptance?.refs;
        const negativeId=${JSON.stringify(EXPORT_RACE_OLD_REFS_CALL_ID)};
        const rejection=${JSON.stringify(EXPORT_RACE_OLD_REFS_ERROR)};
        for(const failure of current.filter(r=>r.isError)){
          const call=calls.find(c=>c.id===failure.id),a=call?.arguments;
          if(!(role==="mentor"&&failure.id===negativeId&&failure.text.trim()===rejection&&a?.operation==="publish"&&a.kind==="review"&&a.revision===2&&a.verdict==="accept"&&Array.isArray(oldRefs)&&JSON.stringify(a.refs)===JSON.stringify(oldRefs)))
            throw new Error("Unexpected AC31 v2 tool failure: "+failure.text);
        }
        if(current.some(r=>r.id===negativeId&&!r.isError))throw new Error("Old v1 references unexpectedly accepted v2 content");
        const own=kind=>current.filter(r=>!r.isError&&r.data?.delivery&&r.data.role===role&&r.data.revision===2&&r.data.kind===kind).map(r=>r.data);
        const read=id=>current.some(r=>!r.isError&&r.data?.id===id&&typeof r.data.content==="string");
        const knowledge=current.some(r=>!r.isError&&r.data?.revision===2&&r.data.role===role&&Array.isArray(r.data.records)&&r.data.records.length);
        const sourceIds=["FIXTURE-A","FIXTURE-B"].filter(id=>current.some(r=>!r.isError&&r.data?.id===id&&r.data.access&&typeof r.data.text==="string"));
        const ready=[...messages.filter(m=>m.role==="user").map(m=>JSON.stringify(m.content)).join("\\n").matchAll(/AC31_V2_PROPOSAL_READY=([a-f0-9-]{36})/g)].at(-1)?.[1];
        const draft=own("proposal")[0];
        let args;
        if(!status)args={operation:"status"};
        else if(status.revision!==2)throw new Error("AC31 expected current input revision two");
        else if(!knowledge)args={operation:"knowledge",query:"研究问题 证据匹配 因果与推广边界"};
        else if(sourceIds.length<2)args={operation:"source-read",sourceId:["FIXTURE-A","FIXTURE-B"].find(id=>!sourceIds.includes(id))};
        else if(role==="lead"&&!draft)args={operation:"publish",revision:status.revision,kind:"proposal",refs:[],content:${JSON.stringify("# 当前输入版本二的待审新稿\n\n重要主张改写：" + EXPORT_RACE_NEW_CLAIM + "。\n\n这是操作者要求保存并重新审阅的风险主张，当前材料未建立其因果及所有学校推广依据；不能沿用第一版的接受意见。本稿保留为当前版本待审稿，不是已证实结论或正式交付。需要 B 对本稿重新复核，再由导师依据当前版本裁定。")}};
        else if(role==="lead"&&draft&&!current.some(r=>!r.isError&&r.data?.delivered===true&&r.data.to==="mentor"))args={operation:"message",to:"mentor",content:${JSON.stringify(EXPORT_RACE_V2_PROPOSAL_READY)}+draft.id+"；这是实际保存的v2新稿。请本人read后验证旧v1引用不能放行本稿，保留当前待复核状态。"};
        else if(role==="reviewer"&&!own("assessment").length)args={operation:"publish",revision:status.revision,kind:"assessment",refs:[],content:"当前版本的独立待审意见：操作者新增的是因果及所有学校推广的重要主张，不能从旧稿的有限关联结论继承接受。本意见仅据本轮重新取得的方法和提供来源界定风险，尚未对A当前新稿形成正式通过；应保留待核验与新稿对应复核，不把历史裁定当本轮证据。"};
        else if(role==="mentor"&&ready&&!read(ready))args={operation:"read",artifactId:ready};
        else if(role==="mentor"&&ready&&!current.some(r=>r.id===negativeId)){
          if(!Array.isArray(oldRefs)||oldRefs.length<2)throw new Error("Actual accepted v1 references missing from mentor native history");
          args={operation:"publish",revision:status.revision,kind:"review",verdict:"accept",refs:oldRefs,content:"AC31明确负例：本次工具调用故意尝试用本人真实第一版已接受稿的旧引用放行当前新主张，预期由宿主版本门禁拒绝。它不是合法复核、不是科学接受意见，不得生成新版正式交付；若调用成功，本验收必须失败，不自动补造本轮通过依据。"};
        }
        const stream=createAssistantMessageEventStream();
        const callId=args?.operation==="publish"&&args.kind==="review"?negativeId:"ac31_v2_"+role+"_"+messages.length+"_"+(args?.operation??"text");
        const content=args?[{type:"toolCall",id:callId,name:"research_group",arguments:args}]:[{type:"text",text:"AC31 v2当前工作已自然结束；新重要主张仍需对应新稿的实际复核，没有新版accept或正式导出。"}];
        const message={role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage,stopReason:args?"toolUse":"stop",timestamp:Date.now()};
        stream.push({type:"start",partial:{...message,content:[]}});
        if(args){stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:content[0],partial:message});}
        else stream.push({type:"text_delta",contentIndex:0,delta:content[0].text,partial:message});
        stream.push({type:"done",reason:message.stopReason,message});return stream;
      }`;

/** Generates isolated synthetic inputs/provider only; no Electron launch or product state seed. */
export async function setupResearchExportVersionRace() {
  const profile = await makeUserDataDir("research-export-version-race-"),
    workspace = await makeWorkspace("research-export-version-race"),
    agentDir = join(profile, "agent"),
    kb = join(profile, "course-fixture"),
    materials = join(profile, "synthetic-study-inputs");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await mkdir(join(kb, "索引"), { recursive: true });
  await mkdir(join(kb, "溯源"), { recursive: true });
  await writeFile(
    join(kb, "索引", "知识块.jsonl"),
    JSON.stringify({
      id: "FIXTURE-METHOD",
      title: "研究问题 证据 研究设计 论文写作",
      text: "合成测试知识：问题、方法与证据对应，单班相关不能证明因果或推广到所有学校。",
      required_context_ids: [],
    }),
  );
  await writeFile(
    join(kb, "溯源", "来源清单.json"),
    JSON.stringify({ version: "export-race-fixture" }),
  );
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ language: "en", themeMode: "light", toolPermissionMode: "full-access" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "research-routing-fixture",
      defaultModel: "gpt-6.1-sol",
      enabledModels: [
        "research-routing-fixture/gpt-6-astra",
        "research-routing-fixture/gpt-6.1-sol",
        "research-routing-fixture/deepseek-flash",
      ],
      compaction: { enabled: false },
    }),
  );
  await writeResearchStudyFixture(materials);
  await writeResearchGroupProvider(workspace, profile);
  const extension = join(workspace, ".pi", "extensions", "research-routing-fixture.ts"),
    original = await readFile(extension, "utf8"),
    anchor = "const messages = context.messages;";
  if (original.split(anchor).length !== 2)
    throw new Error(
      "Existing paper provider fixture anchor changed; do not silently substitute a different pipeline",
    );
  // v1 remains the existing seven-stage fixture. v2 saves a real current proposal,
  // preserves B's pending judgment and attempts exactly one named stale-ref accept.
  const source = original.replace(anchor, `${anchor}${v2ProviderBranch}`);
  await writeFile(extension, source);
  return { profile, workspace, agentDir, kb, materials, extension };
}

interface SdkRefMetadata {
  workspaceId: string | null;
  sessionId: string | null;
}

interface SdkEventMetadata {
  type: string | null;
  timestamp: string | null;
  runId: string | null;
  ref: SdkRefMetadata | null;
  snapshot: {
    status: string | null;
    runningRunId: string | null;
    updatedAt: string | null;
  } | null;
}

interface SdkRecordMetadata {
  ref: SdkRefMetadata | null;
  status: string | null;
  runningRunId: string | null;
  updatedAt: string | null;
}

interface SdkProbeSummary {
  modulePath: string;
  moduleCachedBeforeRequire: boolean;
  installedAt: string | null;
  restoredAt: string | null;
  emitCalls: number;
  mapCalls: number;
}

export interface ExportVersionRaceSdkProbe extends SdkProbeSummary {
  notice: string;
  events: {
    sequence: number;
    hook: "emit" | "mapAgentEvent";
    deliveredAt: string;
    settledAt: string | null;
    outcome: "pending" | "returned" | "threw";
    inputType: string | null;
    event: SdkEventMetadata | null;
    mapped: SdkEventMetadata[] | null;
    recordBefore: SdkRecordMetadata;
    recordAfter: SdkRecordMetadata | null;
  }[];
}

export interface ExportVersionRaceSnapshot {
  installedAt: string | null;
  enteredAt: string | null;
  exportDirectory: string | null;
  held: boolean;
  releaseRequestedAt: string | null;
  resumedAt: string | null;
  mkdirCompletedAt: string | null;
  restoredAt: string | null;
  submissions: {
    arrivedAt: string;
    settledAt: string | null;
    outcome: "pending" | "resolved" | "rejected";
    text: string;
    error?: string;
  }[];
  writes: {
    file: string;
    startedAt: string;
    finishedAt: string | null;
    payloadSha256: string | null;
  }[];
  sdkProbe: SdkProbeSummary;
}

/** Passthrough filesystem/IPC instrumentation in the owned main process, never product-state mutation. */
export async function installResearchExportVersionRace(
  harness: DesktopHarness,
  fixture: Awaited<ReturnType<typeof setupResearchExportVersionRace>>,
) {
  await harness.electronApp.evaluate(
    ({ ipcMain }, payload) => {
      const { createRequire, syncBuiltinESMExports } = process.getBuiltinModule("module");
      const { relative, sep } = process.getBuiltinModule("path");
      const { createHash } = process.getBuiltinModule("crypto");
      const fs = process.getBuiltinModule("fs/promises");
      type Invoke = (...args: unknown[]) => unknown;
      const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers?: Map<string, Invoke> })
        ._invokeHandlers;
      if (!handlers || typeof handlers.get !== "function")
        throw new Error(
          "Actual Electron invoke-handler registry unavailable after desktop readiness",
        );
      const originalSubmit = handlers.get(payload.channel);
      if (typeof originalSubmit !== "function")
        throw new Error(
          `Actual composer IPC handler missing after desktop readiness: ${payload.channel}`,
        );
      // Resolve through the same desktop entry used by existing main-process tests.
      // A nonzero observed call count, not cache membership, proves class identity.
      const load = createRequire(payload.desktopEntry),
        modulePath = load.resolve("@lancer/pi-sdk-driver"),
        moduleCachedBeforeRequire = !!load.cache[modulePath];
      const sdk = load(modulePath) as { SessionSupervisor?: { prototype: object } };
      const prototype = sdk.SessionSupervisor?.prototype;
      if (!prototype) throw new Error("SDK metadata probe: SessionSupervisor export unavailable");
      const emitDescriptor = Object.getOwnPropertyDescriptor(prototype, "emit"),
        mapDescriptor = Object.getOwnPropertyDescriptor(prototype, "mapAgentEvent");
      if (typeof emitDescriptor?.value !== "function" || typeof mapDescriptor?.value !== "function")
        throw new Error("SDK metadata probe: expected emit/mapAgentEvent methods unavailable");
      const originalEmit = emitDescriptor.value as Invoke,
        originalMap = mapDescriptor.value as Invoke;
      const mkdirDescriptor = Object.getOwnPropertyDescriptor(fs, "mkdir")!,
        writeDescriptor = Object.getOwnPropertyDescriptor(fs, "writeFile")!;
      const originalMkdir = fs.mkdir,
        originalWrite = fs.writeFile;
      type Control = Omit<ExportVersionRaceSnapshot, "sdkProbe"> & {
        sdkProbe: ExportVersionRaceSdkProbe;
        release(): void;
        restore(): void;
      };
      const store = globalThis as typeof globalThis & {
        __PI_TEST_RESEARCH_EXPORT_RACE__?: Control;
      };
      if (store.__PI_TEST_RESEARCH_EXPORT_RACE__)
        throw new Error("Export race instrumentation already installed");
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const restoreBindings = () => {
        const errors: unknown[] = [];
        for (const restore of [
          () => Object.defineProperty(prototype, "emit", emitDescriptor),
          () => Object.defineProperty(prototype, "mapAgentEvent", mapDescriptor),
          () => Object.defineProperty(fs, "mkdir", mkdirDescriptor),
          () => Object.defineProperty(fs, "writeFile", writeDescriptor),
          () => syncBuiltinESMExports(),
          () => {
            ipcMain.removeHandler(payload.channel);
            ipcMain.handle(payload.channel, originalSubmit);
          },
        ]) {
          try {
            restore();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            `Export race binding restoration failed: ${errors.map(String).join("; ")}`,
          );
      };
      const control: Control = {
        installedAt: null,
        enteredAt: null,
        exportDirectory: null,
        held: false,
        releaseRequestedAt: null,
        resumedAt: null,
        mkdirCompletedAt: null,
        restoredAt: null,
        submissions: [],
        writes: [],
        sdkProbe: {
          notice:
            "Test-only metadata probe scoped to this owned workspace. emit is observed at delivery; mapAgentEvent input records only its type and selected mapped event metadata. No messages, tool input/output, content, credentials or record objects are stored. A zero call count means this class was not observed and cannot support an SDK event conclusion.",
          modulePath,
          moduleCachedBeforeRequire,
          installedAt: null,
          restoredAt: null,
          emitCalls: 0,
          mapCalls: 0,
          events: [],
        },
        release() {
          if (!control.releaseRequestedAt) control.releaseRequestedAt = new Date().toISOString();
          releaseGate();
        },
        restore() {
          control.release();
          restoreBindings();
          control.restoredAt = new Date().toISOString();
          control.sdkProbe.restoredAt = control.restoredAt;
        },
      };
      const object = (value: unknown): Record<string, unknown> =>
        value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const string = (value: unknown) => (typeof value === "string" ? value : null);
      const refMetadata = (value: unknown): SdkRefMetadata | null => {
        const ref = object(value);
        return typeof ref.workspaceId === "string" || typeof ref.sessionId === "string"
          ? { workspaceId: string(ref.workspaceId), sessionId: string(ref.sessionId) }
          : null;
      };
      const recordMetadata = (value: unknown): SdkRecordMetadata => {
        const record = object(value);
        return {
          ref: refMetadata(record.ref),
          status: string(record.status),
          runningRunId: string(record.runningRunId),
          updatedAt: string(record.updatedAt),
        };
      };
      const eventMetadata = (value: unknown): SdkEventMetadata => {
        const event = object(value),
          snapshot = object(event.snapshot);
        return {
          type: string(event.type),
          timestamp: string(event.timestamp),
          runId: string(event.runId),
          ref: refMetadata(event.sessionRef ?? snapshot.ref),
          snapshot:
            event.snapshot && typeof event.snapshot === "object"
              ? {
                  status: string(snapshot.status),
                  runningRunId: string(snapshot.runningRunId),
                  updatedAt: string(snapshot.updatedAt),
                }
              : null,
        };
      };
      const observe = (hook: "emit" | "mapAgentEvent", args: unknown[]) => {
        const record = recordMetadata(args[0]);
        if (record.ref?.workspaceId !== payload.workspace) return null;
        if (hook === "emit") control.sdkProbe.emitCalls++;
        else control.sdkProbe.mapCalls++;
        const row: ExportVersionRaceSdkProbe["events"][number] = {
          sequence: control.sdkProbe.events.length + 1,
          hook,
          deliveredAt: new Date().toISOString(),
          settledAt: null,
          outcome: "pending",
          inputType: hook === "mapAgentEvent" ? string(object(args[1]).type) : null,
          event: hook === "emit" ? eventMetadata(args[1]) : null,
          mapped: null,
          recordBefore: record,
          recordAfter: null,
        };
        control.sdkProbe.events.push(row);
        return row;
      };
      try {
        Object.defineProperty(prototype, "emit", {
          ...emitDescriptor,
          value: async function (this: unknown, ...args: unknown[]) {
            const row = observe("emit", args);
            try {
              const value: unknown = await Reflect.apply(originalEmit, this, args);
              if (row) row.outcome = "returned";
              return value;
            } catch (error) {
              if (row) row.outcome = "threw";
              throw error;
            } finally {
              if (row) {
                row.recordAfter = recordMetadata(args[0]);
                row.settledAt = new Date().toISOString();
              }
            }
          },
        });
        Object.defineProperty(prototype, "mapAgentEvent", {
          ...mapDescriptor,
          // Mapping is synchronous in the actual SDK; keep its exact result identity.
          value: function (this: unknown, ...args: unknown[]) {
            const row = observe("mapAgentEvent", args);
            try {
              const value: unknown = Reflect.apply(originalMap, this, args);
              if (row) {
                row.mapped = Array.isArray(value) ? value.map(eventMetadata) : null;
                row.outcome = "returned";
              }
              return value;
            } catch (error) {
              if (row) row.outcome = "threw";
              throw error;
            } finally {
              if (row) {
                row.recordAfter = recordMetadata(args[0]);
                row.settledAt = new Date().toISOString();
              }
            }
          },
        });
        control.sdkProbe.installedAt = new Date().toISOString();
        Object.defineProperty(fs, "mkdir", {
          ...mkdirDescriptor,
          value: async (...args: unknown[]) => {
            const path = typeof args[0] === "string" ? args[0] : "",
              parts = relative(payload.researchRoot, path).split(sep);
            const finalDirectory =
              path &&
              parts.length === 2 &&
              !parts[0]!.startsWith("..") &&
              parts[1]!.startsWith("paper-v1-");
            if (finalDirectory && !control.enteredAt) {
              control.enteredAt = new Date().toISOString();
              control.exportDirectory = path;
              control.held = true;
              await gate;
              control.resumedAt = new Date().toISOString();
              control.held = false;
              const value: unknown = await Reflect.apply(originalMkdir, fs, args);
              control.mkdirCompletedAt = new Date().toISOString();
              return value;
            }
            const value: unknown = await Reflect.apply(originalMkdir, fs, args);
            return value;
          },
        });
        Object.defineProperty(fs, "writeFile", {
          ...writeDescriptor,
          value: async (...args: unknown[]) => {
            const file = typeof args[0] === "string" ? args[0] : "";
            const data = args[1];
            const row =
              control.exportDirectory && file.startsWith(control.exportDirectory + sep)
                ? {
                    file,
                    startedAt: new Date().toISOString(),
                    finishedAt: null as string | null,
                    payloadSha256:
                      typeof data === "string" || data instanceof Uint8Array
                        ? createHash("sha256").update(data).digest("hex")
                        : null,
                  }
                : null;
            if (row) control.writes.push(row);
            const value: unknown = await Reflect.apply(originalWrite, fs, args);
            if (row) row.finishedAt = new Date().toISOString();
            return value;
          },
        });
        syncBuiltinESMExports();
        ipcMain.removeHandler(payload.channel);
        ipcMain.handle(payload.channel, async (...args: unknown[]) => {
          const tracked = args[1] === payload.newInput;
          const row: ExportVersionRaceSnapshot["submissions"][number] = {
            arrivedAt: new Date().toISOString(),
            settledAt: null,
            outcome: "pending",
            text: tracked ? payload.newInput : "",
          };
          if (tracked) control.submissions.push(row);
          try {
            const value: unknown = await originalSubmit(...args);
            if (tracked) {
              row.outcome = "resolved";
              row.settledAt = new Date().toISOString();
            }
            return value;
          } catch (error) {
            if (tracked) {
              row.outcome = "rejected";
              row.error = String(error);
              row.settledAt = new Date().toISOString();
            }
            throw error;
          }
        });
        control.installedAt = new Date().toISOString();
        store.__PI_TEST_RESEARCH_EXPORT_RACE__ = control;
      } catch (error) {
        control.release();
        try {
          restoreBindings();
        } catch (rollbackError) {
          throw new Error(
            `${String(error)}; installation rollback also failed: ${String(rollbackError)}`,
            { cause: error },
          );
        }
        throw error;
      }
    },
    {
      researchRoot: join(fixture.workspace, ".lancer", "research-groups"),
      workspace: fixture.workspace,
      desktopEntry: resolve("apps/desktop/out/main/main.js"),
      channel: desktopIpc.submitComposer,
      newInput: EXPORT_RACE_NEW_INPUT,
    },
  );
}

export async function readResearchExportVersionRace(
  harness: DesktopHarness,
): Promise<ExportVersionRaceSnapshot> {
  return harness.electronApp.evaluate(() => {
    const control = (
      globalThis as typeof globalThis & {
        __PI_TEST_RESEARCH_EXPORT_RACE__?: ExportVersionRaceSnapshot;
      }
    ).__PI_TEST_RESEARCH_EXPORT_RACE__;
    if (!control) throw new Error("Export race instrumentation unavailable");
    return {
      installedAt: control.installedAt,
      enteredAt: control.enteredAt,
      exportDirectory: control.exportDirectory,
      held: control.held,
      releaseRequestedAt: control.releaseRequestedAt,
      resumedAt: control.resumedAt,
      mkdirCompletedAt: control.mkdirCompletedAt,
      restoredAt: control.restoredAt,
      submissions: control.submissions,
      writes: control.writes,
      // Polling carries only counters; the full trace is read once for retained evidence.
      sdkProbe: {
        modulePath: control.sdkProbe.modulePath,
        moduleCachedBeforeRequire: control.sdkProbe.moduleCachedBeforeRequire,
        installedAt: control.sdkProbe.installedAt,
        restoredAt: control.sdkProbe.restoredAt,
        emitCalls: control.sdkProbe.emitCalls,
        mapCalls: control.sdkProbe.mapCalls,
      },
    };
  });
}

export async function readResearchExportVersionRaceSdkProbe(
  harness: DesktopHarness,
): Promise<ExportVersionRaceSdkProbe> {
  return harness.electronApp.evaluate(() => {
    const control = (
      globalThis as typeof globalThis & {
        __PI_TEST_RESEARCH_EXPORT_RACE__?: { sdkProbe: ExportVersionRaceSdkProbe };
      }
    ).__PI_TEST_RESEARCH_EXPORT_RACE__;
    if (!control) throw new Error("SDK metadata probe unavailable");
    return control.sdkProbe;
  });
}

export async function releaseResearchExportVersionRace(harness: DesktopHarness, restore = false) {
  await harness.electronApp.evaluate((_electron, restore) => {
    const control = (
      globalThis as typeof globalThis & {
        __PI_TEST_RESEARCH_EXPORT_RACE__?: { release(): void; restore(): void };
      }
    ).__PI_TEST_RESEARCH_EXPORT_RACE__;
    if (!control) throw new Error("Export race instrumentation unavailable during release/restore");
    if (restore) control.restore();
    else control.release();
  }, restore);
}
