import { useCallback, useEffect, useState } from "react";

/** Compact navigation is temporary; resizing never overwrites the desktop preference. */
export function useResponsiveSidebar(
  desktopCollapsed: boolean,
  navigationKey: string,
  enabled = true,
) {
  const [compact, setCompact] = useState(() => enabled && matchMedia("(max-width: 760px)").matches);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const query = matchMedia("(max-width: 760px)");
    const change = () => {
      setCompact(enabled && query.matches);
      setOpen(false);
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, [enabled]);
  useEffect(() => {
    setOpen(false);
  }, [navigationKey]);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  useEffect(() => {
    if (!compact || !open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open], [popover]:popover-open"))
        close();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [compact, open, close]);
  return {
    collapsed: compact ? !open : desktopCollapsed,
    toggle: compact ? toggle : undefined,
    close,
  };
}
