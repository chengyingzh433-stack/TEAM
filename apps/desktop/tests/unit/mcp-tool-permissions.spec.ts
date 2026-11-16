import { test, expect } from "@playwright/test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  approvalParameters,
  requiresToolConfirmation,
  createToolPermissionsExtension,
} from "../../electron/conversation/tool-permissions";
import { setLocale } from "../../contracts/i18n";
import { createEmptyDesktopAppState, type ToolPermissionMode } from "../../contracts/desktop-state";
import { decodePersistedUiState } from "../../electron/persistence/app-store-persistence";
import { expectToolPermissionMode } from "../../electron/ipc/request-validation";

test("old profiles ask by default and malformed permission preferences are rejected", () => {
  expect(createEmptyDesktopAppState().toolPermissionMode).toBe("ask");
  expect(decodePersistedUiState({ version: 19 }).toolPermissionMode).toBeUndefined();
  for (const mode of ["ask", "full-access"]) {
    expect(
      decodePersistedUiState({ version: 19, toolPermissionMode: mode }).toolPermissionMode,
    ).toBe(mode);
    expect(expectToolPermissionMode(mode)).toBe(mode);
  }
  for (const mode of [true, null, "always", "FULL_ACCESS", {}, []]) {
    expect(() => decodePersistedUiState({ version: 19, toolPermissionMode: mode })).toThrow();
    expect(() => expectToolPermissionMode(mode)).toThrow();
  }
});

test("explicit full access follows live changes for native and nested tools while stop still blocks", async () => {
  let mode: ToolPermissionMode = "ask";
  let handler: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    on: (_name: string, callback: typeof handler) => {
      handler = callback;
    },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  await createToolPermissionsExtension(() => mode)(pi);
  let confirmations = 0;
  const ctx = {
    hasUI: true,
    ui: {
      confirm: () => {
        confirmations++;
        return Promise.resolve(false);
      },
    },
  } as unknown as ExtensionContext;
  const call = (toolName: string): ToolCallEvent =>
    ({
      type: "tool_call",
      toolName,
      input: { text: "fixture" },
      toolCallId: "outer/1",
      parentToolCallId: "outer",
    }) as ToolCallEvent;
  expect(await handler!(call("write"), ctx)).toMatchObject({ block: true });
  mode = "full-access";
  for (const tool of [
    "write",
    "edit",
    "bash",
    "codemode",
    "mcp__fixture__write_note",
    "create_child_thread",
  ]) {
    expect(await handler!(call(tool), ctx)).toBeUndefined();
    expect(await handler!(call(tool), { ...ctx, hasUI: false })).toBeUndefined();
  }
  expect(confirmations).toBe(1);
  const aborted = new AbortController();
  aborted.abort();
  expect(await handler!(call("bash"), { ...ctx, signal: aborted.signal })).toMatchObject({
    block: true,
  });
  mode = "ask";
  expect(await handler!(call("bash"), ctx)).toMatchObject({ block: true });
  expect(await handler!(call("mcp__fixture__write_note"), ctx)).toMatchObject({ block: true });
  expect(confirmations).toBe(3);
});

test("only native inspection is exempt; server hints and execution wrappers cannot bypass approval", async () => {
  expect(requiresToolConfirmation("mcp__shared__get", { readOnlyHint: true })).toBe(true);
  expect(requiresToolConfirmation("mcp__shared__write", { readOnlyHint: false })).toBe(true);
  expect(requiresToolConfirmation("unknown")).toBe(true);
  for (const name of [
    "codemode",
    "create_child_thread",
    "send_message_to_thread",
    "bash",
    "edit",
    "write",
  ]) {
    expect(requiresToolConfirmation(name, { readOnlyHint: true })).toBe(true);
  }
  expect(requiresToolConfirmation("read")).toBe(false);
  expect(requiresToolConfirmation("write", { readOnlyHint: true, destructiveHint: true })).toBe(
    true,
  );
  expect(approvalParameters({ token: "DO_NOT_SHOW", page_id: "page-1" })).not.toContain(
    "DO_NOT_SHOW",
  );
  let handler: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    on: (_name: string, callback: typeof handler) => {
      handler = callback;
    },
    getAllTools: () => [{ name: "mcp__fixture__write_note", annotations: { readOnlyHint: true } }],
  } as unknown as ExtensionAPI;
  await createToolPermissionsExtension()(pi);
  let confirmations = 0;
  const ctx = {
    hasUI: true,
    ui: {
      confirm: () => {
        confirmations++;
        return Promise.resolve(false);
      },
    },
  } as unknown as ExtensionContext;
  const call = {
    type: "tool_call",
    toolName: "mcp__fixture__write_note",
    input: { text: "only after approval" },
    toolCallId: "outer/1",
    parentToolCallId: "outer",
  } as ToolCallEvent;
  expect(await handler!(call, ctx)).toMatchObject({ block: true });
  expect(await handler!(call, ctx)).toMatchObject({ block: true });
  expect(confirmations).toBe(2);
  expect(await handler!(call, { ...ctx, hasUI: false })).toMatchObject({ block: true });
  const aborted = new AbortController();
  aborted.abort();
  expect(await handler!(call, { ...ctx, signal: aborted.signal })).toMatchObject({ block: true });
  expect(confirmations).toBe(2);
  expect(
    await handler!(call, {
      ...ctx,
      ui: { confirm: () => Promise.reject(new Error("window closed")) },
    } as unknown as ExtensionContext),
  ).toMatchObject({ block: true });
});

test("approval redacts common credentials inside string values without hiding ordinary arguments", () => {
  const output = approvalParameters({
    nested: {
      authorization: "hidden-header",
      url: "https://example.test/?key=hidden-query&token=hidden-token",
      text: "sk-123456789012345678901234 Bearer hidden-bearer",
      authUrl: "https://user:hidden-password@example.test/path",
    },
    page: "visible-page",
  });
  for (const secret of [
    "hidden-header",
    "hidden-query",
    "hidden-token",
    "sk-123456789012345678901234",
    "hidden-bearer",
    "hidden-password",
  ])
    expect(output).not.toContain(secret);
  expect(output).toContain("visible-page");
  setLocale("en");
  expect(() => approvalParameters({ text: "x".repeat(16_001) })).toThrow("Arguments exceed");
  setLocale("zh-CN");
  expect(() => approvalParameters({ text: "x".repeat(16_001) })).toThrow("参数超过");
  setLocale("en");
});
