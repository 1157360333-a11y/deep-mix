import { useMemo, useState } from "react";
import type { SessionRecord } from "@deep-mix/shared-schema";
import type {
  DesktopModelProfileSaveInput,
  DesktopModelProbeResult,
  DesktopSettings,
  DesktopSettingsPatch,
} from "@shared/ipc";
import {
  DEFAULT_DESKTOP_SHORTCUTS,
  DESKTOP_SHORTCUT_IDS,
  formatDesktopShortcut,
  shortcutFromKeyboardEvent,
  type DesktopShortcutId,
} from "@shared/shortcut-config";
import type { ThemeMode } from "../types";
import { Icon, type IconName } from "./Icons";
import { ModelProfileEditor } from "./ModelProfileEditor";
import { SelectMenu } from "./SelectMenu";

type SettingsCategory = "general" | "shortcuts" | "models" | "plugins" | "archived" | "about";

export interface ArchivedSessionGroup {
  root: string;
  name: string;
  sessions: SessionRecord[];
}

interface SettingsDialogProps {
  settings: DesktopSettings | null;
  busy: boolean;
  theme: ThemeMode;
  archivedGroups: ArchivedSessionGroup[];
  onThemeChange: (theme: ThemeMode) => void;
  onClose: () => void;
  onUpdateSettings: (patch: DesktopSettingsPatch) => void;
  onSaveModelProfile: (input: DesktopModelProfileSaveInput) => Promise<void>;
  onProbeModel: (profileId: string) => Promise<DesktopModelProbeResult>;
  onRevealPath: (path: string) => void;
  onRestoreSession: (session: SessionRecord) => void;
  onDeleteSession: (session: SessionRecord) => void;
}

const categories: Array<{ id: SettingsCategory; label: string; icon: IconName }> = [
  { id: "general", label: "通用", icon: "settings" },
  { id: "shortcuts", label: "快捷键", icon: "keyboard" },
  { id: "models", label: "模型", icon: "computer" },
  { id: "plugins", label: "插件", icon: "plugin" },
  { id: "archived", label: "已归档", icon: "archive" },
  { id: "about", label: "关于", icon: "id" },
];

function formatFullTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <span><strong>{title}</strong>{description && <small>{description}</small>}</span>
      {children}
    </div>
  );
}

function GeneralSection({ settings, busy, theme, onThemeChange, onUpdate }: { settings: DesktopSettings; busy: boolean; theme: ThemeMode; onThemeChange: (theme: ThemeMode) => void; onUpdate: (patch: DesktopSettingsPatch) => void }) {
  return (
    <>
      <section className="settings-view__section">
        <h3>外观</h3>
        <div className="theme-choice-grid" role="radiogroup" aria-label="界面主题">
          {([
            { value: "light", label: "浅色", icon: "sun" },
            { value: "dark", label: "深色", icon: "moon" },
          ] as Array<{ value: ThemeMode; label: string; icon: IconName }>).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={theme === option.value}
              className={`theme-choice${theme === option.value ? " is-active" : ""}`}
              onClick={() => onThemeChange(option.value)}
            >
              <Icon name={option.icon} size={18} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-view__section">
        <h3>回复</h3>
        <SettingRow title="回复风格" description="控制默认语气与表达方式，应用于总结与日常回答">
          <SelectMenu
            ariaLabel="回复风格"
            size="regular"
            disabled={busy}
            value={settings.replyStyle}
            options={[
              { value: "pragmatic", label: "务实", description: "冷静、严谨", icon: "activity", tone: "accent" },
              { value: "friendly", label: "亲和", description: "温暖、协作", icon: "spark" },
            ]}
            onChange={(value) => onUpdate({ replyStyle: value as DesktopSettings["replyStyle"] })}
          />
        </SettingRow>
      </section>
    </>
  );
}

function ModelsSection({ settings, busy, onUpdate, onSaveModelProfile, onProbeModel }: { settings: DesktopSettings; busy: boolean; onUpdate: (patch: DesktopSettingsPatch) => void; onSaveModelProfile: (input: DesktopModelProfileSaveInput) => Promise<void>; onProbeModel: (profileId: string) => Promise<DesktopModelProbeResult> }) {
  const [probeState, setProbeState] = useState<Record<string, string>>({});
  const [profileEditor, setProfileEditor] = useState<{ slot: "governor" | "coding" | "vision"; mode: "create" | "edit" }>();
  return (
    <section className="settings-view__section">
      <h3>模型中心<small>{settings.models.preset} · r{settings.models.revision} · 不显示密钥</small></h3>
      {(["governor", "coding", "vision"] as const).map((slot) => {
        const state = settings.models.slots[slot];
        const slotLabel = slot === "governor" ? "总线" : slot === "coding" ? "编程" : "视觉";
        const compatible = settings.models.candidates.filter((candidate) => candidate.status.allowedSlots?.includes(slot));
        return <div className="model-slot-card" key={slot}>
          <div className="model-slot-card__title"><span>{slotLabel}</span><small>{state.requiredCapabilities.join(" + ") || "text"}</small></div>
          <SelectMenu
            ariaLabel={`${slotLabel}主模型`}
            size="regular"
            disabled={busy}
            value={state.primary.profileId}
            options={compatible.map((candidate) => ({
              value: candidate.profileId,
              label: candidate.displayName,
              description: `${candidate.status.provider ?? "provider?"} · ${candidate.status.model ?? "model?"}`,
              icon: slot === "coding" ? "code" : slot === "vision" ? "image" : "activity",
            }))}
            onChange={(value) => onUpdate({ models: {
              expectedRevision: settings.models.revision,
              slot,
              primaryProfileId: value,
              fallbackProfileIds: state.fallbacks.map((entry) => entry.profileId),
            } })}
          />
          <label className="model-slot-field"><span>模型覆盖</span><input
            key={`${slot}:${state.primary.profileId}:${state.primary.model ?? ""}`}
            defaultValue={state.primary.model ?? ""}
            disabled={busy}
            placeholder={state.primary.status.model ?? "使用 profile 默认模型"}
            onBlur={(event) => {
              const value = event.currentTarget.value.trim();
              if (value === (state.primary.model ?? "")) return;
              onUpdate({ models: {
                expectedRevision: settings.models.revision,
                slot,
                primaryProfileId: state.primary.profileId,
                primaryModel: value,
                fallbackProfileIds: state.fallbacks.map((entry) => entry.profileId),
              } });
            }}
          /></label>
          <SelectMenu
            ariaLabel={`${slotLabel}回退模型`}
            size="regular"
            disabled={busy}
            value={state.fallbacks[0]?.profileId ?? "none"}
            options={[
              { value: "none", label: "不启用回退", icon: "shield" },
              ...compatible.filter((candidate) => candidate.profileId !== state.primary.profileId).map((candidate) => ({
                value: candidate.profileId,
                label: candidate.displayName,
                description: `${candidate.status.provider ?? "provider?"} · ${candidate.status.model ?? "model?"}`,
                icon: "activity" as const,
              })),
            ]}
            onChange={(value) => onUpdate({ models: {
              expectedRevision: settings.models.revision,
              slot,
              primaryProfileId: state.primary.profileId,
              primaryModel: state.primary.model,
              fallbackProfileIds: value === "none" ? [] : [value],
            } })}
          />
          <div className="profile-row"><span className={!state.activationError ? "profile-ready" : "profile-missing"} /><div><strong>{state.primary.displayName}</strong><small>{state.activationError ?? `${state.primary.status.provider ?? "provider?"} · model=${state.primary.model ?? state.primary.status.model ?? "unknown"} · fallback=${state.fallbackEnabled ? state.fallbacks.map((entry) => entry.displayName).join(", ") : "off"}`}</small></div></div>
          <div className="model-slot-actions"><button type="button" disabled={busy} onClick={() => setProfileEditor({ slot, mode: "create" })}><Icon name="plus" size={12} />新建接入</button><button type="button" disabled={busy} onClick={() => setProfileEditor({ slot, mode: "edit" })}><Icon name="edit" size={12} />编辑当前</button></div>
          {profileEditor?.slot === slot && <ModelProfileEditor
            key={`${slot}:${profileEditor.mode}:${state.primary.profileId}:${settings.models.profileRevision}`}
            slot={slot}
            mode={profileEditor.mode}
            settingsRevision={settings.models.revision}
            profileRevision={settings.models.profileRevision}
            current={state.primary}
            requiredCapabilities={state.requiredCapabilities}
            disabled={busy}
            onCancel={() => setProfileEditor(undefined)}
            onSave={onSaveModelProfile}
          />}
          <button className="path-button" disabled={busy || !state.primary.status.hasKey} onClick={() => {
            setProbeState((current) => ({ ...current, [slot]: "testing" }));
            void onProbeModel(state.primary.profileId).then((result) => setProbeState((current) => ({ ...current, [slot]: result.ok ? `ok ${result.latencyMs ?? 0}ms` : result.skipped ? "skipped" : "failed" })));
          }}><Icon name="activity" size={14} /><span>连接测试 · {probeState[slot] ?? "未运行"}</span></button>
        </div>;
      })}
      <button className="path-button" disabled={busy} onClick={() => onUpdate({ models: { expectedRevision: settings.models.revision, restoreClassic: true } })}><Icon name="undo" size={14} /><span>恢复 classic 预设（保留自定义 profile）</span></button>
    </section>
  );
}

function PluginsSection({ settings, busy, onUpdate }: { settings: DesktopSettings; busy: boolean; onUpdate: (patch: DesktopSettingsPatch) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => settings.extensions.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase())), [query, settings]);
  return (
    <section className="settings-view__section">
      <h3>插件<small>{settings.extensions.length} 个已发现</small></h3>
      <label className="settings-view__search"><Icon name="search" size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能、工作流或 MCP" /></label>
      <div className="plugin-list">
        {filtered.map((extension) => (
          <div className="plugin-row" key={extension.id}>
            <span className={`plugin-row__icon plugin-row__icon--${extension.kind}`}><Icon name={extension.kind === "skill" ? "spark" : extension.kind === "workflow" ? "plan" : "plugin"} size={16} /></span>
            <div><strong>{extension.name}</strong><p>{extension.description}</p><small>{extension.kind.toUpperCase()} · {extension.source ?? "local"}</small></div>
            {extension.kind === "skill" ? <button aria-label={`${extension.enabled ? "停用" : "启用"} ${extension.name}`} className={`toggle${extension.enabled ? " toggle--on" : ""}`} disabled={busy} onClick={() => onUpdate({ enabledSkills: { [extension.name]: !extension.enabled } })}><span /></button> : <span className={`state-label state-label--${extension.state}`}>{extension.state === "ready" ? "就绪" : extension.state === "disabled" ? "停用" : "错误"}</span>}
          </div>
        ))}
        {!filtered.length && <div className="settings-view__empty"><Icon name="search" size={20} /><strong>没有匹配项</strong><span>尝试搜索其它名称。</span></div>}
      </div>
    </section>
  );
}

const shortcutActions: Array<{ id: DesktopShortcutId; title: string; description: string }> = [
  { id: "sendMessage", title: "发送消息", description: "在输入框中发送当前消息" },
  { id: "newLine", title: "插入换行", description: "在输入框中插入一行文本" },
  { id: "stopTask", title: "停止当前任务", description: "中断正在执行的当前任务" },
  { id: "dismissOverlay", title: "关闭弹窗", description: "关闭当前设置、任务或操作弹窗" },
  { id: "newTask", title: "新建任务", description: "打开新任务输入框" },
  { id: "toggleLeftSidebar", title: "切换左侧栏", description: "显示或隐藏会话与项目侧栏" },
  { id: "toggleRightPanel", title: "切换检查器", description: "显示或隐藏右侧检查器" },
  { id: "focusComposer", title: "聚焦输入框", description: "将光标移至消息输入框" },
  { id: "zoomIn", title: "放大界面", description: "提高当前窗口的缩放比例" },
  { id: "zoomOut", title: "缩小界面", description: "降低当前窗口的缩放比例" },
  { id: "resetZoom", title: "重置缩放", description: "恢复默认缩放比例" },
];

function ShortcutsSection({ settings, busy, onUpdate }: { settings: DesktopSettings; busy: boolean; onUpdate: (patch: DesktopSettingsPatch) => void }) {
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<DesktopShortcutId>();
  const [notice, setNotice] = useState<string>();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? shortcutActions.filter((action) => `${action.title} ${action.description}`.toLowerCase().includes(normalized)) : shortcutActions;
  }, [query]);

  const resetAll = () => {
    setRecording(undefined);
    setNotice(undefined);
    onUpdate({ shortcuts: { ...DEFAULT_DESKTOP_SHORTCUTS } });
  };

  const recordShortcut = (event: React.KeyboardEvent<HTMLButtonElement>, action: DesktopShortcutId) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(undefined);
      setNotice(undefined);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      setRecording(undefined);
      setNotice(undefined);
      onUpdate({ shortcuts: { [action]: null } });
      return;
    }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) {
      setNotice("请按下一个组合键，或使用 Enter 发送消息。");
      return;
    }
    const conflict = DESKTOP_SHORTCUT_IDS.find((id) => id !== action && settings.shortcuts[id] === shortcut);
    if (conflict) {
      const conflictTitle = shortcutActions.find((item) => item.id === conflict)?.title ?? "另一项操作";
      setNotice(`${formatDesktopShortcut(shortcut)} 已用于“${conflictTitle}”。`);
      return;
    }
    setRecording(undefined);
    setNotice(undefined);
    onUpdate({ shortcuts: { [action]: shortcut } });
  };

  return (
    <section className="settings-view__section shortcut-settings">
      <div className="shortcut-settings__heading">
        <div><h3>键盘快捷键</h3><p>点击一个快捷键后直接按下新的组合键。按 Esc 取消，按 Backspace 或 Delete 可停用。</p></div>
        <button type="button" className="shortcut-reset-all" disabled={busy} onClick={resetAll}><Icon name="undo" size={14} />恢复默认</button>
      </div>
      <label className="settings-view__search"><Icon name="search" size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索快捷键操作" /></label>
      <div className="shortcut-list" aria-live="polite">
        {filtered.map((action) => {
          const isRecording = recording === action.id;
          return <div className={`shortcut-row${isRecording ? " is-recording" : ""}`} key={action.id}>
            <div className="shortcut-row__copy"><strong>{action.title}</strong><small>{action.description}</small></div>
            <div className="shortcut-row__controls">
              <button
                type="button"
                className="shortcut-binding"
                disabled={busy}
                aria-label={`设置${action.title}快捷键`}
                onClick={() => { setRecording(action.id); setNotice(undefined); }}
                onKeyDown={(event) => recordShortcut(event, action.id)}
              >
                {isRecording ? "请按下快捷键" : formatDesktopShortcut(settings.shortcuts[action.id])}
              </button>
              <button type="button" className="shortcut-reset" disabled={busy || settings.shortcuts[action.id] === DEFAULT_DESKTOP_SHORTCUTS[action.id]} onClick={() => onUpdate({ shortcuts: { [action.id]: DEFAULT_DESKTOP_SHORTCUTS[action.id] } })} title="恢复此项默认快捷键" aria-label={`恢复${action.title}默认快捷键`}><Icon name="undo" size={14} /></button>
            </div>
          </div>;
        })}
      </div>
      {notice && <p className="shortcut-settings__notice" role="status">{notice}</p>}
      {!filtered.length && <div className="settings-view__empty"><Icon name="search" size={20} /><strong>没有匹配项</strong><span>尝试搜索其它操作名称。</span></div>}
    </section>
  );
}

function ArchivedSection({ groups, busy, onRestore, onDelete }: { groups: ArchivedSessionGroup[]; busy: boolean; onRestore: (session: SessionRecord) => void; onDelete: (session: SessionRecord) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        sessions: normalized
          ? group.sessions.filter((session) => session.title.toLowerCase().includes(normalized) || group.name.toLowerCase().includes(normalized))
          : group.sessions,
      }))
      .filter((group) => group.sessions.length > 0);
  }, [groups, query]);
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  return (
    <section className="settings-view__section">
      <h3>已归档的会话<small>{total} 个会话</small></h3>
      {total > 0 && (
        <label className="settings-view__search"><Icon name="search" size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已归档会话" /></label>
      )}
      {filtered.length === 0 ? (
        <div className="settings-view__empty"><Icon name="archive" size={20} /><strong>{total === 0 ? "没有已归档的会话" : "没有匹配项"}</strong><span>{total === 0 ? "在会话菜单中选择“归档会话”后，会在这里集中管理。" : "尝试搜索其它名称。"}</span></div>
      ) : (
        filtered.map((group) => (
          <div className="archived-group" key={group.root}>
            <div className="archived-group__heading"><Icon name="folder" size={14} /><span>{group.name}</span><small>{group.sessions.length} 个会话</small></div>
            <div className="archived-list">
              {group.sessions.map((session) => (
                <div className="archived-row" key={session.sessionId}>
                  <div className="archived-row__copy">
                    <strong>{session.title || "未命名任务"}</strong>
                    <small>{formatFullTime(session.updatedAt)}</small>
                  </div>
                  <button className="is-icon" disabled={busy} onClick={() => onDelete(session)} title="彻底删除该会话" aria-label={`删除会话 ${session.title}`}><Icon name="trash" size={14} /></button>
                  <button disabled={busy} onClick={() => onRestore(session)}>取消归档</button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function AboutSection({ settings, onRevealPath }: { settings: DesktopSettings; onRevealPath: (path: string) => void }) {
  return (
    <>
      <section className="settings-view__section">
        <h3>工作区</h3>
        <button className="path-button" onClick={() => onRevealPath(settings.workspaceRoot)}><Icon name="folder" size={15} /><span>{settings.workspaceRoot}</span><Icon name="external" size={14} /></button>
      </section>
      <section className="settings-view__section">
        <h3>运行环境<small>{settings.capabilities.filter((entry) => entry.available).length}/{settings.capabilities.length} 可用</small></h3>
        <div className="capability-cloud">{settings.capabilities.map((entry) => <span className={entry.available ? "" : "is-missing"} key={entry.name}><i />{entry.name}</span>)}</div>
      </section>
    </>
  );
}

export function SettingsDialog({ settings, busy, theme, archivedGroups, onThemeChange, onClose, onUpdateSettings, onSaveModelProfile, onProbeModel, onRevealPath, onRestoreSession, onDeleteSession }: SettingsDialogProps) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("general");
  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <section className="settings-dialog" role="dialog" aria-label="设置" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-dialog__header">
          <strong>设置</strong>
          <button onClick={onClose} aria-label="关闭设置"><Icon name="x" size={16} /></button>
        </header>
        <div className="settings-dialog__body">
          <nav className="settings-nav" aria-label="设置分类">
            {categories.map((category) => (
              <button
                key={category.id}
                className={activeCategory === category.id ? "is-active" : ""}
                onClick={() => setActiveCategory(category.id)}
              >
                <Icon name={category.icon} size={16} /><span>{category.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content">
            <h2>{categories.find((category) => category.id === activeCategory)?.label}</h2>
            {activeCategory === "archived" ? (
              <ArchivedSection groups={archivedGroups} busy={busy} onRestore={onRestoreSession} onDelete={onDeleteSession} />
            ) : !settings ? (
              <div className="settings-view__empty"><Icon name="settings" size={20} /><strong>正在读取设置</strong><span>从工作区配置加载中…</span></div>
            ) : (
              <>
                {activeCategory === "general" && <GeneralSection settings={settings} busy={busy} theme={theme} onThemeChange={onThemeChange} onUpdate={onUpdateSettings} />}
                {activeCategory === "shortcuts" && <ShortcutsSection settings={settings} busy={busy} onUpdate={onUpdateSettings} />}
                {activeCategory === "models" && <ModelsSection settings={settings} busy={busy} onUpdate={onUpdateSettings} onSaveModelProfile={onSaveModelProfile} onProbeModel={onProbeModel} />}
                {activeCategory === "plugins" && <PluginsSection settings={settings} busy={busy} onUpdate={onUpdateSettings} />}
                {activeCategory === "about" && <AboutSection settings={settings} onRevealPath={onRevealPath} />}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
