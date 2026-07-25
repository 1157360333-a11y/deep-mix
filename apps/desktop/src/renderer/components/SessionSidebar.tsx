import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionRecord } from "@deep-mix/shared-schema";
import type { DesktopSettings } from "@shared/ipc";
import type { ProjectPreferences } from "../project-state";
import { BrandMark, Icon, type IconName } from "./Icons";

export type SessionAction = "rename" | "pin" | "archive" | "copy-id" | "mark-unread" | "delete";
export type ProjectAction = "rename" | "pin" | "remove";

interface SessionSidebarProps {
  sessions: SessionRecord[];
  workspaceRoots: string[];
  projectPreferences: ProjectPreferences;
  activeSessionId: string | null;
  composerWorkspaceRoot: string | null;
  settings: DesktopSettings | null;
  onSelect: (sessionId: string) => void;
  onNew: (workspaceRoot?: string) => void;
  onChooseWorkspace: () => void;
  onOpenSettings: () => void;
  onProjectAction: (action: ProjectAction, root: string, name: string) => void;
  onSessionAction: (action: SessionAction, session: SessionRecord) => void;
  statusLabel: (status: SessionRecord["status"]) => string;
}

function formatRelativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(diff / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天` : new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function workspaceName(root: string): string {
  return root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;
}

export function SessionSidebar({
  sessions,
  workspaceRoots,
  projectPreferences,
  activeSessionId,
  composerWorkspaceRoot,
  settings,
  onSelect,
  onNew,
  onChooseWorkspace,
  onOpenSettings,
  onProjectAction,
  onSessionAction,
  statusLabel,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<
    | { kind: "session"; session: SessionRecord; top: number; left: number }
    | { kind: "project"; root: string; name: string; pinned: boolean; top: number; left: number }
    | null
  >(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const closeOnResize = () => setMenu(null);
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [menu]);

  const archivedCount = sessions.filter((session) => !!session.archivedAt).length;
  const projects = useMemo(() => {
    const roots = [...new Set([...workspaceRoots, ...sessions.map((session) => session.workspaceRoot)])];
    const normalizedQuery = query.trim().toLowerCase();
    return roots.map((root, order) => {
      const preference = projectPreferences[root];
      const projectSessions = sessions
        .filter((session) => session.workspaceRoot === root)
        .filter((session) => showArchived ? !!session.archivedAt : !session.archivedAt)
        .filter((session) => !normalizedQuery || session.title.toLowerCase().includes(normalizedQuery))
        .sort((left, right) => {
          if (!!left.pinnedAt !== !!right.pinnedAt) return left.pinnedAt ? -1 : 1;
          return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
        });
      return { root, name: preference?.name ?? workspaceName(root), pinnedAt: preference?.pinnedAt, order, sessions: projectSessions };
    })
      .filter((project) => !normalizedQuery || project.name.toLowerCase().includes(normalizedQuery) || project.sessions.length > 0)
      .sort((left, right) => {
        if (!!left.pinnedAt !== !!right.pinnedAt) return left.pinnedAt ? -1 : 1;
        return left.order - right.order;
      });
  }, [projectPreferences, query, sessions, showArchived, workspaceRoots]);

  const menuPosition = (button: HTMLButtonElement, menuHeight: number) => {
    const rect = button.getBoundingClientRect();
    const menuWidth = 190;
    return {
      left: Math.min(window.innerWidth - menuWidth - 10, Math.max(10, rect.right - menuWidth)),
      top: Math.min(window.innerHeight - menuHeight - 10, rect.bottom + 5),
    };
  };

  const openSessionMenu = (event: React.MouseEvent<HTMLButtonElement>, session: SessionRecord) => {
    event.stopPropagation();
    setMenu({
      kind: "session",
      session,
      ...menuPosition(event.currentTarget, 244),
    });
  };

  const openProjectMenu = (event: React.MouseEvent<HTMLButtonElement>, project: { root: string; name: string; pinnedAt?: string }) => {
    event.stopPropagation();
    setMenu({
      kind: "project",
      root: project.root,
      name: project.name,
      pinned: !!project.pinnedAt,
      ...menuPosition(event.currentTarget, 146),
    });
  };

  const invoke = (action: SessionAction | ProjectAction) => {
    if (!menu) return;
    if (menu.kind === "session") onSessionAction(action as SessionAction, menu.session);
    else onProjectAction(action as ProjectAction, menu.root, menu.name);
    setMenu(null);
  };

  const toggleProject = (root: string) => setCollapsedRoots((current) => {
    const next = new Set(current);
    if (next.has(root)) next.delete(root);
    else next.add(root);
    return next;
  });

  const sessionMenuItems: Array<{ action: SessionAction; label: string; icon: IconName; danger?: boolean }> = menu?.kind === "session" ? [
    { action: "rename", label: "重命名", icon: "edit" },
    { action: "pin", label: menu.session.pinnedAt ? "取消置顶" : "置顶会话", icon: "pin" },
    { action: "mark-unread", label: "标记为未读", icon: "mail" },
    { action: "copy-id", label: "复制会话 ID", icon: "id" },
    { action: "archive", label: menu.session.archivedAt ? "移出归档" : "归档会话", icon: "archive" },
    { action: "delete", label: "删除会话", icon: "trash", danger: true },
  ] : [];
  const projectMenuItems: Array<{ action: ProjectAction; label: string; icon: IconName; danger?: boolean }> = menu?.kind === "project" ? [
    { action: "rename", label: "重命名项目", icon: "edit" },
    { action: "pin", label: menu.pinned ? "取消置顶" : "置顶项目", icon: "pin" },
    { action: "remove", label: "从列表移除", icon: "trash", danger: true },
  ] : [];
  const menuItems = menu?.kind === "session" ? sessionMenuItems : projectMenuItems;

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <BrandMark />
        <div className="sidebar__brand-copy"><strong>Deep-Mix</strong><span>Desktop</span></div>
      </div>

      <div className="sidebar__primary-actions">
        <button className="new-task-button" onClick={() => onNew()}>
          <Icon name="plus" size={17} /><span>新建任务</span><kbd>Ctrl N</kbd>
        </button>
        <label className="sidebar-search">
          <Icon name="search" size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部项目与任务" />
        </label>
      </div>

      <div className="project-tree-heading">
        <span>项目</span>
        <button onClick={onChooseWorkspace} title="添加项目" aria-label="添加项目"><Icon name="plus" size={14} /></button>
      </div>

      <div className="sidebar__sessions project-tree">
        {projects.length === 0 ? <div className="empty-list">没有匹配的项目或任务</div> : projects.map((project) => {
          const collapsed = collapsedRoots.has(project.root);
          const activeProject = project.root === (sessions.find((session) => session.sessionId === activeSessionId)?.workspaceRoot ?? composerWorkspaceRoot);
          return (
            <section className={`project-node${activeProject ? " project-node--active" : ""}${project.pinnedAt ? " project-node--pinned" : ""}`} key={project.root}>
              <div className="project-node__header" role="button" tabIndex={0} title={project.root} onClick={() => toggleProject(project.root)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") toggleProject(project.root); }}>
                <Icon name={collapsed ? "folder" : "folder-open"} size={16} />
                <strong>{project.name}</strong>
                {project.pinnedAt && <span className="project-node__pin" title="已置顶"><Icon name="pin" size={11} /></span>}
                <small>{project.sessions.length || ""}</small>
                <span className="project-node__actions">
                  <button title={`在 ${project.name} 中新建任务`} aria-label={`在 ${project.name} 中新建任务`} onClick={(event) => { event.stopPropagation(); onNew(project.root); }}><Icon name="edit" size={13} /></button>
                  <button title={`管理项目 ${project.name}`} aria-label={`管理项目 ${project.name}`} onClick={(event) => openProjectMenu(event, project)}><Icon name="more" size={15} /></button>
                </span>
                <Icon name="chevron-down" size={13} className={collapsed ? "rotate-90" : ""} />
              </div>
              {!collapsed && (
                <div className="project-node__sessions">
                  {project.sessions.length === 0 ? <button className="project-empty-task" onClick={() => onNew(project.root)}>在此项目中创建任务</button> : project.sessions.map((session) => (
                    <div
                      key={session.sessionId}
                      role="button"
                      tabIndex={0}
                      className={`session-row${session.sessionId === activeSessionId ? " session-row--active" : ""}${session.unread ? " session-row--unread" : ""}`}
                      onClick={() => onSelect(session.sessionId)}
                      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(session.sessionId); }}
                    >
                      <span className={`session-row__status session-row__status--${session.status}`} />
                      <span className="session-row__copy">
                        <strong>{session.title || "未命名任务"}{session.unread && <i className="session-row__unread" />}</strong>
                        <small>{statusLabel(session.status)} · {formatRelativeTime(session.updatedAt)}</small>
                      </span>
                      {session.pinnedAt && <span className="session-row__pin"><Icon name="pin" size={11} /></span>}
                      <button className="session-row__more" onClick={(event) => openSessionMenu(event, session)} aria-label={`管理会话 ${session.title}`} title="会话操作"><Icon name="more" size={16} /></button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {archivedCount > 0 && (
          <button className={`archive-toggle${showArchived ? " is-active" : ""}`} onClick={() => setShowArchived((value) => !value)}>
            <Icon name="archive" size={14} /><span>{showArchived ? "返回任务" : `已归档 ${archivedCount}`}</span><Icon name="chevron-down" size={12} />
          </button>
        )}
      </div>

      <div className="sidebar__footer">
        <button className="sidebar-footer-button" onClick={onOpenSettings}>
          <span className="profile-avatar">DM</span>
          <span className="sidebar-footer-button__copy"><strong>本地工作台</strong><small>{settings?.profiles.deepseek_governor.hasKey ? "Governor 已连接" : "需要配置 Governor"}</small></span>
          <Icon name="settings" size={17} />
        </button>
      </div>

      {menu && (
        <div ref={menuRef} className="session-action-menu" style={{ top: menu.top, left: menu.left }}>
          <div className="session-action-menu__title">{menu.kind === "session" ? menu.session.title : menu.name}</div>
          {menuItems.map((item) => (
            <button key={item.action} className={item.danger ? "is-danger" : ""} onClick={() => invoke(item.action)}>
              <Icon name={item.icon} size={15} /><span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
