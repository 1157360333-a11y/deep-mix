import { useEffect, useMemo, useState } from "react";
import type {
  DiagnosticReportRecord,
  PermissionMode,
  PlanItem,
  RouteTarget,
  SessionRecord,
  ToolProcessSession,
  ToolOutputArtifact,
  WorkerArtifactRecord,
} from "@deep-mix/shared-schema";
import type { DesktopSettings, DesktopSettingsPatch, WorkerStatusView } from "@shared/ipc";
import type { InspectorPanel } from "../types";
import { Icon, type IconName } from "./Icons";
import { SelectMenu } from "./SelectMenu";
import { ToolOutputArtifacts } from "./ToolOutputArtifacts";

interface RightPanelProps {
  activePanel: InspectorPanel;
  session: SessionRecord | null;
  planItems: PlanItem[];
  workers: WorkerStatusView[];
  artifacts: WorkerArtifactRecord[];
  toolOutputArtifacts: ToolOutputArtifact[];
  processes: ToolProcessSession[];
  stoppingProcessIds: ReadonlySet<string>;
  diagnostics: DiagnosticReportRecord | null;
  settings: DesktopSettings | null;
  busy: boolean;
  onSelectPanel: (panel: InspectorPanel) => void;
  onUpdateSettings: (patch: DesktopSettingsPatch) => void;
  onRevealPath: (path: string) => void;
  onStopProcess: (processSessionId: string) => void;
}

const tabs: Array<{ id: InspectorPanel; label: string; icon: IconName }> = [
  { id: "context", label: "上下文", icon: "context" },
  { id: "plan", label: "计划", icon: "plan" },
  { id: "activity", label: "运行", icon: "activity" },
  { id: "plugins", label: "插件", icon: "plugin" },
  { id: "settings", label: "设置", icon: "settings" },
];

function formatTokens(value?: number): string {
  if (value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function formatDuration(value?: number): string {
  if (value === undefined) return "—";
  const seconds = Math.round(value / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}分 ${seconds % 60}秒` : `${seconds}秒`;
}

function processStatusLabel(status: ToolProcessSession["status"]): string {
  switch (status) {
    case "starting": return "启动中";
    case "running": return "运行中";
    case "stopping": return "停止中";
    case "stopped": return "已停止";
    case "exited": return "已退出";
    case "failed": return "失败";
    case "orphaned": return "失联";
  }
}

function formatProcessElapsed(process: ToolProcessSession, clock: number): string {
  const startedAt = Date.parse(process.startedAt);
  const endedAt = process.endedAt ? Date.parse(process.endedAt) : clock;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return "—";
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function EmptyPanel({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return <div className="inspector-empty"><Icon name={icon} size={22} /><strong>{title}</strong><span>{detail}</span></div>;
}

function ContextPanel({ session }: { session: SessionRecord | null }) {
  const budget = session?.latestContextBudget;
  const usage = session?.latestTokenUsage;
  const total = session?.cumulativeTokenUsage;
  const used = budget?.usagePercent ?? 0;
  const categoryTotal = budget?.categories.reduce((sum, entry) => entry.key === "free" ? sum : sum + entry.estimatedTokens, 0) ?? 0;
  const categoryColors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

  if (!session) return <EmptyPanel icon="context" title="尚无上下文" detail="发送任务后会显示预算与消耗。" />;
  return (
    <div className="inspector-content">
      <section className="context-hero">
        <div className="context-strata" style={{ "--context-used": `${Math.min(100, used)}%` } as React.CSSProperties}>
          <div className="context-strata__readout"><strong>{used.toFixed(0)}%</strong><span>已使用</span></div>
          <div className="context-strata__tracks" aria-hidden="true"><i /><i /><i /></div>
        </div>
        <div className="context-hero__copy">
          <span>当前请求</span>
          <strong>{formatTokens(budget?.usedInputTokens)} <small>/ {formatTokens(budget?.inputBudgetTokens)}</small></strong>
          <p>剩余 {formatTokens(budget?.remainingInputTokens)} tokens</p>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-section__title"><span>上下文构成</span><small>{budget?.source === "provider_exact" ? "精确" : "估算"}</small></div>
        <div className="context-categories">
          {budget?.categories.filter((entry) => entry.key !== "free").map((entry, index) => (
            <div className="context-category" key={entry.key}>
              <div><span style={{ background: categoryColors[index % categoryColors.length] }} /><strong>{entry.label}</strong><small>{formatTokens(entry.estimatedTokens)}</small></div>
              <div className="mini-bar"><span style={{ width: `${categoryTotal ? entry.estimatedTokens / categoryTotal * 100 : 0}%`, background: categoryColors[index % categoryColors.length] }} /></div>
            </div>
          )) ?? <span className="muted">等待模型调用数据</span>}
        </div>
      </section>

      <section className="metric-grid">
        <div><span>输入</span><strong>{formatTokens(usage?.inputTokens)}</strong></div>
        <div><span>输出</span><strong>{formatTokens(usage?.outputTokens)}</strong></div>
        <div><span>推理</span><strong>{formatTokens(usage?.reasoningTokens)}</strong></div>
        <div><span>处理时长</span><strong>{formatDuration(session.latestTaskDuration?.durationMs)}</strong></div>
      </section>

      <section className="inspector-section compact-list">
        <div className="inspector-section__title"><span>会话累计</span></div>
        <div className="property-row"><span>会话 ID</span><strong title={session.sessionId}>{session.sessionId.slice(0, 8)}</strong></div>
        <div className="property-row"><span>总 tokens</span><strong>{formatTokens(total?.totalTokens)}</strong></div>
        <div className="property-row"><span>消息</span><strong>{session.messageCount}</strong></div>
        <div className="property-row"><span>模型</span><strong>{budget?.model ?? usage?.model ?? "—"}</strong></div>
        <div className="property-row"><span>摘要</span><strong>{budget?.selectedSummaryCount ?? 0}</strong></div>
        <div className="property-row"><span>工具原文</span><strong>{budget?.toolOutputExposure?.rawMessageCount ?? 0}</strong></div>
        <div className="property-row"><span>超大工具摘要</span><strong>{budget?.toolOutputExposure?.summarizedMessageCount ?? 0}</strong></div>
        <div className="property-row"><span>预算截断</span><strong>{budget?.toolOutputExposure?.budgetTruncatedMessageCount ?? 0}</strong></div>
      </section>
    </div>
  );
}

function PlanPanel({ items }: { items: PlanItem[] }) {
  if (!items.length) return <EmptyPanel icon="plan" title="暂无计划" detail="切换到 Plan 模式，让 Deep-Mix 先梳理步骤。" />;
  const completed = items.filter((item) => item.status === "completed").length;
  return (
    <div className="inspector-content">
      <div className="plan-progress"><div><strong>{completed}/{items.length}</strong><span>步骤完成</span></div><div className="progress-line"><span style={{ width: `${items.length ? completed / items.length * 100 : 0}%` }} /></div></div>
      <div className="plan-list">
        {items.map((item, index) => (
          <div className={`plan-item plan-item--${item.status}`} key={item.id}>
            <div className="plan-item__rail"><span>{item.status === "completed" ? <Icon name="check" size={12} /> : index + 1}</span></div>
            <div><strong>{item.title}</strong>{item.notes && <p>{item.notes}</p>}{item.blockedReason && <p className="error-text">{item.blockedReason}</p>}<small>{item.status === "in_progress" ? "正在处理" : item.status === "completed" ? "已完成" : item.status === "blocked" ? "已阻塞" : "等待中"}</small></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityPanel({ workers, artifacts, toolOutputArtifacts, processes, stoppingProcessIds, diagnostics, onStopProcess }: Pick<RightPanelProps, "workers" | "artifacts" | "toolOutputArtifacts" | "processes" | "stoppingProcessIds" | "diagnostics" | "onStopProcess">) {
  const entries = diagnostics?.diagnostics ?? [];
  const hasLiveProcess = processes.some((process) => process.status === "starting" || process.status === "running" || process.status === "stopping");
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLiveProcess) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveProcess]);
  if (!processes.length && !workers.length && !artifacts.length && !toolOutputArtifacts.length && !entries.length) return <EmptyPanel icon="activity" title="运行记录为空" detail="受控进程、Worker、诊断和产物状态会在这里汇总。" />;
  return (
    <div className="inspector-content">
      {processes.length > 0 && <section className="inspector-section"><div className="inspector-section__title"><span>受控进程</span><small>{processes.length}</small></div><div className="process-list">{processes.map((process) => {
        const canStop = process.status === "starting" || process.status === "running";
        const stopping = stoppingProcessIds.has(process.processSessionId);
        return <article className={`process-card process-card--${process.status}`} key={process.processSessionId}>
          <div className="process-card__heading">
            <span className="process-card__icon"><Icon name="terminal" size={14} /></span>
            <div><strong title={process.processSessionId}>{process.processSessionId}</strong><small>{process.pid ? `PID ${process.pid}` : "PID 待定"} · {formatProcessElapsed(process, clock)}</small></div>
            <em><i />{processStatusLabel(process.status)}</em>
          </div>
          <code title={process.commandSummary}>{process.commandSummary}</code>
          <div className="process-card__footer"><span>{process.interactionMode === "pty" ? "PTY" : process.interactionMode === "pipe" ? "STDIO" : "后台"}</span><span>{process.totalOutputChars.toLocaleString()} chars</span>{canStop && <button aria-label={`停止进程 ${process.processSessionId}`} disabled={stopping} onClick={() => onStopProcess(process.processSessionId)}><Icon name="stop" size={10} />{stopping ? "停止中" : "停止"}</button>}</div>
        </article>;
      })}</div></section>}
      {workers.length > 0 && <section className="inspector-section"><div className="inspector-section__title"><span>Workers</span><small>{workers.length}</small></div><div className="runtime-list">{workers.map((worker) => <div className="runtime-row" key={worker.workerSessionId}><span className={`runtime-state runtime-state--${worker.status}`} /><div><strong>{worker.workerType}</strong><small>{worker.objective}</small></div><em>{worker.status}</em></div>)}</div></section>}
      {entries.length > 0 && <section className="inspector-section"><div className="inspector-section__title"><span>诊断</span><small>{entries.length}</small></div><div className="runtime-list">{entries.map((entry, index) => <div className="runtime-row" key={`${entry.kind}-${index}`}><span className={`runtime-state runtime-state--${entry.status}`} /><div><strong>{entry.kind}</strong><small>{entry.summary}</small></div><em>{entry.status}</em></div>)}</div></section>}
      {toolOutputArtifacts.length > 0 && <section className="inspector-section"><div className="inspector-section__title"><span>工具产物</span><small>{toolOutputArtifacts.length}</small></div><ToolOutputArtifacts artifacts={toolOutputArtifacts} compact /></section>}
      {artifacts.length > 0 && <section className="inspector-section"><div className="inspector-section__title"><span>Worker 产物</span><small>{artifacts.length}</small></div><div className="artifact-list">{artifacts.map((artifact) => <details key={artifact.artifactId}><summary><Icon name="file" size={14} /><span>{artifact.summary.kind === "code_artifact" ? "代码产物" : "视觉产物"}</span><Icon name="chevron-down" size={13} /></summary><p>{artifact.summary.summary}</p></details>)}</div></section>}
    </div>
  );
}

function PluginsPanel({ settings, busy, onUpdate }: { settings: DesktopSettings | null; busy: boolean; onUpdate: RightPanelProps["onUpdateSettings"] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => settings?.extensions.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase())) ?? [], [query, settings]);
  if (!settings) return <EmptyPanel icon="plugin" title="正在发现插件" detail="扫描项目和用户扩展目录…" />;
  return (
    <div className="inspector-content">
      <label className="inspector-search"><Icon name="search" size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能、工作流或 MCP" /></label>
      <div className="plugin-list">
        {filtered.map((extension) => (
          <div className="plugin-row" key={extension.id}>
            <span className={`plugin-row__icon plugin-row__icon--${extension.kind}`}><Icon name={extension.kind === "skill" ? "spark" : extension.kind === "workflow" ? "plan" : "plugin"} size={16} /></span>
            <div><strong>{extension.name}</strong><p>{extension.description}</p><small>{extension.kind.toUpperCase()} · {extension.source ?? "local"}</small></div>
            {extension.kind === "skill" ? <button aria-label={`${extension.enabled ? "停用" : "启用"} ${extension.name}`} className={`toggle${extension.enabled ? " toggle--on" : ""}`} disabled={busy} onClick={() => onUpdate({ enabledSkills: { [extension.name]: !extension.enabled } })}><span /></button> : <span className={`state-label state-label--${extension.state}`}>{extension.state === "ready" ? "就绪" : extension.state === "disabled" ? "停用" : "错误"}</span>}
          </div>
        ))}
        {!filtered.length && <EmptyPanel icon="search" title="没有匹配项" detail="尝试搜索其它名称。" />}
      </div>
    </div>
  );
}

function SettingsPanel({ settings, busy, onUpdate, onRevealPath }: { settings: DesktopSettings | null; busy: boolean; onUpdate: RightPanelProps["onUpdateSettings"]; onRevealPath: (path: string) => void }) {
  if (!settings) return <EmptyPanel icon="settings" title="正在读取设置" detail="从工作区配置加载中…" />;
  return (
    <div className="inspector-content settings-sections">
      <section className="settings-section settings-section--reply-style">
        <div className="inspector-section__title"><span>回复</span><small>应用于总结与日常回答</small></div>
        <div className="setting-row">
          <span><strong>回复风格</strong><small>控制默认语气与表达方式</small></span>
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
        </div>
      </section>
      <section className="settings-section">
        <div className="inspector-section__title"><span>执行</span></div>
        <div className="setting-row">
          <span><strong>权限模式</strong><small>控制写入与命令审批</small></span>
          <SelectMenu
            ariaLabel="权限模式"
            size="regular"
            disabled={busy}
            value={settings.permissionMode}
            options={[
              { value: "plan", label: "只读规划", description: "不允许修改文件", icon: "plan" },
              { value: "edit", label: "工作区写入", description: "写入前仍遵循权限层", icon: "edit" },
              { value: "auto", label: "按需审批", description: "危险操作由你确认", icon: "shield", tone: "accent" },
              { value: "danger-full-access", label: "完全访问", description: "允许所有工作区操作", icon: "activity", tone: "warning" },
            ]}
            onChange={(value) => onUpdate({ permissionMode: value as PermissionMode })}
          />
        </div>
        <div className="setting-row">
          <span><strong>模型路由</strong><small>默认由任务自动选择</small></span>
          <SelectMenu
            ariaLabel="模型路由"
            size="regular"
            disabled={busy}
            value={settings.routeOverride ?? "auto"}
            options={[
              { value: "auto", label: "自动", icon: "spark" },
              { value: "ds_direct", label: "DeepSeek", icon: "activity" },
              { value: "glm_coding", label: "GLM", icon: "code" },
              { value: "kimi_vision", label: "Kimi", icon: "image" },
            ]}
            onChange={(value) => onUpdate({ routeOverride: value === "auto" ? null : value as RouteTarget })}
          />
        </div>
        <div className="setting-row">
          <span><strong>思考深度</strong><small>越深越适合复杂任务</small></span>
          <SelectMenu
            ariaLabel="思考深度"
            size="regular"
            variant="reasoning"
            disabled={busy}
            value={settings.reasoningEffort}
            options={[
              { value: "low", label: "快速", description: "单轨响应", depthLevel: 1 },
              { value: "medium", label: "标准", description: "双轨校验", depthLevel: 2 },
              { value: "high", label: "深度", description: "三轨汇聚", depthLevel: 3, tone: "accent" },
            ]}
            onChange={(value) => onUpdate({ reasoningEffort: value })}
          />
        </div>
      </section>
      <section className="settings-section"><div className="inspector-section__title"><span>模型配置</span><small>不显示密钥</small></div>
        {Object.entries(settings.profiles).map(([name, state]) => <div className="profile-row" key={name}><span className={state.hasKey ? "profile-ready" : "profile-missing"} /><div><strong>{name}</strong><small>{state.hasKey ? "已连接" : state.exists ? "缺少密钥" : "未配置"}</small></div></div>)}
      </section>
      <section className="settings-section"><div className="inspector-section__title"><span>运行环境</span><small>{settings.capabilities.filter((entry) => entry.available).length}/{settings.capabilities.length}</small></div>
        <div className="capability-cloud">{settings.capabilities.map((entry) => <span className={entry.available ? "" : "is-missing"} key={entry.name}><i />{entry.name}</span>)}</div>
      </section>
      <section className="settings-section"><div className="inspector-section__title"><span>工作区</span></div><button className="path-button" onClick={() => onRevealPath(settings.workspaceRoot)}><Icon name="folder" size={15} /><span>{settings.workspaceRoot}</span><Icon name="external" size={14} /></button></section>
    </div>
  );
}

export function RightPanel(props: RightPanelProps) {
  return (
    <aside className="inspector">
      <div className="inspector__tabs">
        {tabs.map((tab) => <button key={tab.id} className={props.activePanel === tab.id ? "is-active" : ""} onClick={() => props.onSelectPanel(tab.id)} title={tab.label}><Icon name={tab.icon} size={16} /></button>)}
      </div>
      <div className="inspector__heading"><div><small>INSPECTOR</small><strong>{tabs.find((tab) => tab.id === props.activePanel)?.label}</strong></div>{props.busy && <span className="live-badge"><i />LIVE</span>}</div>
      <div className="inspector__body">
        {props.activePanel === "context" && <ContextPanel session={props.session} />}
        {props.activePanel === "plan" && <PlanPanel items={props.planItems} />}
        {props.activePanel === "activity" && <ActivityPanel workers={props.workers} artifacts={props.artifacts} toolOutputArtifacts={props.toolOutputArtifacts} processes={props.processes} stoppingProcessIds={props.stoppingProcessIds} diagnostics={props.diagnostics} onStopProcess={props.onStopProcess} />}
        {props.activePanel === "plugins" && <PluginsPanel settings={props.settings} busy={props.busy} onUpdate={props.onUpdateSettings} />}
        {props.activePanel === "settings" && <SettingsPanel settings={props.settings} busy={props.busy} onUpdate={props.onUpdateSettings} onRevealPath={props.onRevealPath} />}
      </div>
    </aside>
  );
}
