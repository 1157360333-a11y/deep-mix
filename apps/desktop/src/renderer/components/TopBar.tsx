import type { SessionRecord } from "@deep-mix/shared-schema";
import type { DesktopSettings } from "@shared/ipc";
import { Icon } from "./Icons";

interface TopBarProps {
  session: SessionRecord | null;
  settings: DesktopSettings | null;
  leftVisible: boolean;
  rightVisible: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onExport: () => void;
  onUndo: () => void;
  statusLabel: (status: SessionRecord["status"]) => string;
}

export function TopBar({
  session,
  settings,
  leftVisible,
  rightVisible,
  onToggleLeft,
  onToggleRight,
  onExport,
  onUndo,
  statusLabel,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__start no-drag">
        <button className={`icon-button${leftVisible ? " icon-button--active" : ""}`} onClick={onToggleLeft} title="显示或隐藏左侧栏 (Ctrl+B)">
          <Icon name="panel-left" size={17} />
        </button>
        <div className="topbar__breadcrumbs">
          <span>{settings?.workspaceName ?? "Deep-Mix"}</span>
          <span className="topbar__slash">/</span>
          <strong>{session?.title ?? "新任务"}</strong>
        </div>
        {session && (
          <span className={`status-chip status-chip--${session.status}`}>
            <span />{statusLabel(session.status)}
          </span>
        )}
      </div>

      <div className="topbar__end no-drag">
        <button className="icon-button" onClick={onUndo} disabled={!session} title="撤销到最近检查点">
          <Icon name="undo" size={16} />
        </button>
        <button className="icon-button" onClick={onExport} disabled={!session} title="导出当前任务">
          <Icon name="download" size={16} />
        </button>
        <button className={`icon-button${rightVisible ? " icon-button--active" : ""}`} onClick={onToggleRight} title="显示或隐藏检查器 (Ctrl+Shift+B)">
          <Icon name="panel-right" size={17} />
        </button>
      </div>
    </header>
  );
}
