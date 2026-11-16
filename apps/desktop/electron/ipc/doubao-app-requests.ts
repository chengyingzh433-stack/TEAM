import { shell } from "electron";
import { desktopIpc } from "../../contracts/ipc";
import type {
  DoubaoAppBindInput,
  DoubaoAppEnabledInput,
  DoubaoAppSendInput,
} from "../../contracts/doubao-app";
import type { DoubaoAppService } from "../doubao-app/service";
import type { MainFrameHandler } from "./main-frame-ipc";
import {
  expectBoolean,
  expectNonEmptyString,
  expectRecord,
  expectSessionTarget,
} from "./request-validation";
export function expectDoubaoBind(raw: unknown): DoubaoAppBindInput {
  const v = expectRecord(raw, "doubaoBind");
  const target = expectSessionTarget(v.target);
  if (v.conversationId === undefined) return { target };
  const conversationId = expectNonEmptyString(v.conversationId, "conversationId");
  if (!/^\d{1,30}$/.test(conversationId)) throw new Error("Invalid conversationId");
  return { target, conversationId };
}
export function expectDoubaoSend(raw: unknown): DoubaoAppSendInput {
  const v = expectRecord(raw, "doubaoSend");
  if (Object.keys(v).some((key) => key !== "target" && key !== "text"))
    throw new Error("Unsupported message option");
  const text = expectNonEmptyString(v.text, "text");
  if (Buffer.byteLength(text, "utf8") > 50_000) throw new Error("Message is too long");
  return {
    target: expectSessionTarget(v.target),
    text,
  };
}
function expectEnabled(raw: unknown): DoubaoAppEnabledInput {
  const v = expectRecord(raw, "doubaoEnabled");
  return { target: expectSessionTarget(v.target), enabled: expectBoolean(v.enabled, "enabled") };
}
export function registerDoubaoAppRequests(
  handle: MainFrameHandler,
  service: DoubaoAppService,
): void {
  handle(desktopIpc.doubaoAppStatus, expectSessionTarget, (target) => service.status(target));
  handle(desktopIpc.doubaoAppBind, expectDoubaoBind, (input) => service.bind(input));
  handle(desktopIpc.doubaoAppSend, expectDoubaoSend, (input) => service.send(input));
  handle(desktopIpc.doubaoAppRefresh, expectSessionTarget, (target) => service.refresh(target));
  handle(desktopIpc.doubaoAppSelect, expectSessionTarget, (target) =>
    service.refresh(target, true),
  );
  handle(desktopIpc.doubaoAppSetEnabled, expectEnabled, (input) =>
    service.setEnabled(input.target, input.enabled),
  );
  handle(
    desktopIpc.doubaoAppOpenAccessibilitySettings,
    () => undefined,
    async () => {
      if (process.platform !== "darwin") throw new Error("E_UNSUPPORTED");
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    },
  );
}
