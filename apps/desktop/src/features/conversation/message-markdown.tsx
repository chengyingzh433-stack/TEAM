import { memo, useContext, useMemo } from "react";
import { WorkspaceDocumentActions, WorkspaceDocumentLink } from "./workspace-document-link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  remarkWorkspaceFileLines,
  workspaceFileLineFromAnchorProps,
  type WorkspaceFileLine,
} from "./workspace-file-line";

const REMARK_PLUGINS = [remarkGfm];

function markdownComponents(
  onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void,
  documents = false,
): Components {
  return {
    code: ({ className, children }) => {
      const code = String(children).replace(/\n$/, "");
      return <code className={className}>{code}</code>;
    },
    a: ({ href, children, ...props }) => {
      const document = (props as Record<string, unknown>)["data-workspace-document"];
      if (documents && typeof document === "string") {
        return <WorkspaceDocumentLink path={document}>{children}</WorkspaceDocumentLink>;
      }
      const file = onOpenWorkspaceFileLine ? workspaceFileLineFromAnchorProps(props) : null;
      if (file && onOpenWorkspaceFileLine) {
        return (
          <button
            className="message__file-link"
            data-end-line={file.endLine}
            data-line={file.line}
            data-path={file.path}
            data-testid="workspace-file-link"
            type="button"
            onClick={() => onOpenWorkspaceFileLine(file)}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} rel="noreferrer" target="_blank">
          {children}
        </a>
      );
    },
    table: ({ children }) => (
      <div className="message__table-scroll">
        <table>{children}</table>
      </div>
    ),
  };
}

const PLAIN_MARKDOWN_COMPONENTS = markdownComponents();

// Memoized: remark parsing is the dominant render cost on long threads, and the
// timeline re-renders on every streaming tick. `text` is a string, so shallow
// comparison skips the re-parse for every message except the one still growing.
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  workspacePath,
  onOpenWorkspaceFileLine,
}: {
  readonly text: string;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
}) {
  const openDocument = useContext(WorkspaceDocumentActions);
  const components = useMemo(
    () =>
      onOpenWorkspaceFileLine || openDocument
        ? markdownComponents(onOpenWorkspaceFileLine, Boolean(openDocument))
        : PLAIN_MARKDOWN_COMPONENTS,
    [onOpenWorkspaceFileLine, openDocument],
  );
  const remarkPlugins = useMemo(
    () =>
      onOpenWorkspaceFileLine || openDocument
        ? [remarkGfm, remarkWorkspaceFileLines(workspacePath ?? null, Boolean(openDocument))]
        : REMARK_PLUGINS,
    [onOpenWorkspaceFileLine, openDocument, workspacePath],
  );
  return (
    <div className="message__content">
      <ReactMarkdown components={components} remarkPlugins={remarkPlugins}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
