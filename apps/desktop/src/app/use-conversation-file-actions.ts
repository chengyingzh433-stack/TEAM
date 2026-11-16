import { useCallback, type RefObject } from "react";
import type { WorkspaceFileLine } from "../features/conversation/workspace-file-line";
import type { useWorkbench } from "../features/workbench/use-workbench";
import type { OpenWorkspaceDocument } from "../features/conversation/workspace-document-link";

export function useConversationFileActions(
  api: Window["piApp"],
  selectedWorkspaceRef: RefObject<{ readonly id: string } | undefined>,
  workbenchRef: RefObject<ReturnType<typeof useWorkbench>>,
) {
  // Snapshot ticks replace selectedWorkspace. A new callback identity reparses every
  // visible assistant message and drops stick-to-bottom while a reply is streaming.
  const handleOpenWorkspaceFileLine = useCallback(
    (target: WorkspaceFileLine) => {
      const workspace = selectedWorkspaceRef.current;
      if (!api || !workspace) return;
      void workbenchRef.current
        .openFile({
          workspaceId: workspace.id,
          path: target.path,
          line: target.line,
          endLine: target.endLine,
        })
        .catch(() => {
          // Missing, unreadable, or outside the workspace: leave the panel unchanged.
        });
    },
    [api],
  );

  const handleOpenDeliverable = useCallback(
    async (path: string) => {
      const workspace = selectedWorkspaceRef.current;
      if (!api || !workspace) throw new Error("工作区不可用");
      await api.revealWorkspaceFile(workspace.id, path);
    },
    [api],
  );

  const handleOpenDocument = useCallback<OpenWorkspaceDocument>(
    async (path, action) => {
      const workspace = selectedWorkspaceRef.current;
      if (!api || !workspace) throw new Error("工作区不可用");
      if (action === "reveal") await api.revealWorkspaceFile(workspace.id, path);
      else await api.openWorkspaceDocument(workspace.id, path);
    },
    [api],
  );

  return { handleOpenWorkspaceFileLine, handleOpenDeliverable, handleOpenDocument };
}
