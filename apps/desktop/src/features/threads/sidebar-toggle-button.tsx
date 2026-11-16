import { t } from "../../../contracts/i18n";
import { SidebarToggleIcon } from "../../ui/icons";

interface SidebarToggleButtonProps {
  readonly collapsed: boolean;
  readonly shortcutLabel: string;
  readonly onToggle: () => void;
}

export function SidebarBackdrop({
  onClose,
  className = "shell__sidebar-backdrop",
}: {
  readonly onClose?: () => void;
  readonly className?: string;
}) {
  return <button type="button" className={className} aria-label="关闭导航" onClick={onClose} />;
}

export function SidebarToggleButton({
  collapsed,
  shortcutLabel,
  onToggle,
}: SidebarToggleButtonProps) {
  return (
    <div className="shortcut-tooltip-wrap sidebar-toggle">
      <button
        aria-label={t("threads.toggleSidebar")}
        aria-pressed={!collapsed}
        className="icon-button sidebar-toggle__button"
        data-testid="sidebar-toggle"
        type="button"
        onClick={onToggle}
      >
        <SidebarToggleIcon />
      </button>
      <span className="shortcut-tooltip sidebar-toggle__tooltip" role="tooltip">
        <span>{t("threads.toggleSidebar")}</span>
        <kbd>{shortcutLabel}</kbd>
      </span>
    </div>
  );
}
