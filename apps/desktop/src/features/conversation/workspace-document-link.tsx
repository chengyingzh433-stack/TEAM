import { createContext, useContext, useState, type ReactNode } from "react";

export type OpenWorkspaceDocument = (path: string, action: "open" | "reveal") => Promise<void>;
export const WorkspaceDocumentActions = createContext<OpenWorkspaceDocument | undefined>(undefined);

export function WorkspaceDocumentLink({
  path,
  children,
}: {
  readonly path: string;
  readonly children: ReactNode;
}) {
  const open = useContext(WorkspaceDocumentActions);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const revealLabel = window.piApp?.platform === "darwin" ? "在访达中显示" : "在文件夹中显示";
  const run = (action: "open" | "reveal") => {
    if (!open || busy) return;
    setError("");
    setBusy(true);
    void open(path, action).then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setError(
          `无法打开文件 ${path}：${reason instanceof Error ? reason.message : String(reason)}`,
        );
      },
    );
  };
  return (
    <span className="message__document" data-testid="workspace-document-link">
      <button
        type="button"
        className="message__file-link"
        title={`打开文件：${path}`}
        disabled={busy}
        onClick={() => run("open")}
      >
        {children}
      </button>
      <button
        type="button"
        className="message__document-reveal"
        aria-label={revealLabel}
        title={revealLabel}
        disabled={busy}
        onClick={() => run("reveal")}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v2M3 7v12h16l3-9H6L3 19" />
        </svg>
      </button>
      {error ? (
        <span className="message__document-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
