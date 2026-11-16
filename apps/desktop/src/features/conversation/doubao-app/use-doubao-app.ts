import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionRef } from "@lancer/session-driver/types";
import type { DoubaoAppSnapshot } from "../../../../contracts/doubao-app";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import type { DesktopAppState } from "../../../../contracts/desktop-state";

export function useDoubaoApp(api: PiDesktopApi | undefined, target: SessionRef | undefined) {
  const key = target ? `${target.workspaceId}:${target.sessionId}` : "";
  const stableTarget = useMemo(() => target, [key]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [entry, setEntry] = useState<{ key: string; value: DoubaoAppSnapshot }>();
  const [attemptedKey, setAttemptedKey] = useState("");
  const [pendingKey, setPendingKey] = useState("");
  const [error, setError] = useState<{ key: string; text: string }>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const inFlight = useRef(new Set<string>());
  const state = entry?.key === key ? entry.value : undefined;
  const run = useCallback(
    async (operation: () => Promise<DoubaoAppSnapshot>, operationKey = key) => {
      if (!operationKey || inFlight.current.has(operationKey)) return;
      inFlight.current.add(operationKey);
      setPendingKey(operationKey);
      try {
        const next = await operation();
        if (currentKey.current === operationKey) {
          setEntry({ key: operationKey, value: next });
          setError(undefined);
        }
        return next;
      } catch (cause) {
        if (currentKey.current === operationKey)
          setError({
            key: operationKey,
            text: cause instanceof Error ? cause.message : String(cause),
          });
        return undefined;
      } finally {
        inFlight.current.delete(operationKey);
        setPendingKey((current) => (current === operationKey ? "" : current));
      }
    },
    [key],
  );

  useEffect(() => {
    if (!api || !stableTarget) return;
    let disposed = false;
    void api
      .doubaoAppStatus(stableTarget)
      .then((value) => {
        if (!disposed)
          setEntry((current) =>
            current?.key === key && current.value.error && !value.binding
              ? current
              : { key, value },
          );
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError({ key, text: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      disposed = true;
    };
  }, [api, key, stableTarget]);

  useEffect(() => {
    if (!api || !stableTarget || !state?.enabled || !state.binding) return;
    const timer = setInterval(() => {
      if (!inFlight.current.has(key))
        void run(() => api.doubaoAppRefresh(stableTarget)).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [api, key, run, stableTarget, state?.enabled, state?.binding?.conversationId]);

  const choose = () => {
    if (!api || !stableTarget) return;
    setAttemptedKey(key);
    void run(() =>
      state?.binding
        ? api.doubaoAppSetEnabled({ target: stableTarget, enabled: true })
        : api.doubaoAppBind({ target: stableTarget }),
    ).catch(() => undefined);
  };
  const leave = async () => {
    if (inFlight.current.has(key)) return false;
    if (!api || !stableTarget || !state?.enabled) {
      setAttemptedKey("");
      return true;
    }
    const result = await run(() =>
      api.doubaoAppSetEnabled({ target: stableTarget, enabled: false }),
    );
    if (!result || result.errorCode || result.enabled) return false;
    setAttemptedKey("");
    return true;
  };
  const send = async () => {
    const text = drafts[key]?.trim();
    if (!api || !stableTarget || !text || state?.busy || inFlight.current.has(key)) return;
    const result = await run(() => api.doubaoAppSend({ target: stableTarget, text }));
    if (result && !result.errorCode) setDrafts((current) => ({ ...current, [key]: "" }));
  };
  const create = async (workspaceId: string, onState: (state: DesktopAppState) => void) => {
    if (!api || !workspaceId || inFlight.current.has("new")) return;
    inFlight.current.add("new");
    try {
      const next = await api.createSession({ workspaceId, title: "豆包 App" });
      if (next.lastError || !next.selectedSessionId)
        throw new Error(next.lastError || "会话创建失败");
      const created = { workspaceId: next.selectedWorkspaceId, sessionId: next.selectedSessionId };
      const value = await api.doubaoAppBind({ target: created });
      const createdKey = `${created.workspaceId}:${created.sessionId}`;
      setEntry({ key: createdKey, value });
      setAttemptedKey(createdKey);
      onState(next);
    } catch (cause) {
      setError({ key, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      inFlight.current.delete("new");
    }
  };
  return {
    state,
    ready: Boolean(state),
    createHandler: (workspaceId: string, onState: (state: DesktopAppState) => void) =>
      api?.doubaoAppAvailable
        ? () => {
            void create(workspaceId, onState).catch(() => undefined);
          }
        : undefined,
    enabled: state?.enabled === true || (Boolean(key) && attemptedKey === key),
    pending: pendingKey === key,
    error: error?.key === key ? error.text : state?.error,
    draft: drafts[key] ?? "",
    setDraft: (text: string) => setDrafts((current) => ({ ...current, [key]: text })),
    choose,
    leave,
    send,
    create,
    refresh: () => {
      if (api && stableTarget)
        void run(() => api.doubaoAppRefresh(stableTarget)).catch(() => undefined);
    },
    select: () => {
      if (api && stableTarget)
        void run(() => api.doubaoAppSelect(stableTarget)).catch(() => undefined);
    },
    bind: () => {
      if (api && stableTarget)
        void run(() => api.doubaoAppBind({ target: stableTarget })).catch(() => undefined);
    },
    openAccessibility: () => {
      if (api)
        void api
          .doubaoAppOpenAccessibilitySettings()
          .catch((cause: unknown) =>
            setError({ key, text: cause instanceof Error ? cause.message : String(cause) }),
          );
    },
  };
}
export type DoubaoAppController = ReturnType<typeof useDoubaoApp>;
