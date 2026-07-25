import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isChatViewportNearBottom } from "../chat-scroll";
import { projectConversationTurns } from "../conversation-turns";
import type { DesktopMessageAttachment, DisplayMessage, ToolCallState } from "../types";
import { BrandMark, Icon } from "./Icons";
import { ToolOutputArtifacts } from "./ToolOutputArtifacts";

interface ChatPanelProps {
  sessionId?: string;
  messages: DisplayMessage[];
  busy: boolean;
  taskTitle?: string;
  liveDurationMs: number;
  taskDurationMs?: number;
  onCopy: (value: string, label?: string) => Promise<boolean>;
  onSuggestion: (value: string) => void;
}

function formatFileSize(size: number): string {
  if (!size) return "本地文件";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatClock(value?: string): string {
  if (!value) return "";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

function toolLabel(tool: ToolCallState): string {
  const labels: Record<string, string> = {
    read_file: "读取文件",
    write_file: "写入文件",
    apply_patch: "应用变更",
    run_shell: "运行命令",
    run_tests: "执行测试",
    start_process: "启动托管进程",
    process_input: "写入进程输入",
    process_output: "读取进程输出",
    stop_process: "停止托管进程",
    build: "执行构建",
    format: "执行格式化",
    test_coverage: "检查覆盖率",
    inspect_logs: "分析日志",
    repository_explorer: "扫描工作区",
    invoke_coding_worker: "调用编码 Worker",
    invoke_vision_worker: "分析视觉附件",
    list_checkpoints: "列出检查点",
    list_artifacts: "列出产物",
    read_artifact: "读取产物",
    export_artifact: "导出产物",
    worker_status: "查看 Worker 状态",
    worker_output: "读取 Worker 输出",
    worker_cancel: "取消 Worker",
    list_mcp_servers: "列出 MCP Server",
    list_mcp_resources: "列出 MCP Resource",
    read_mcp_resource: "读取 MCP Resource",
  };
  if (tool.displayName?.trim()) return tool.displayName.trim();
  return labels[tool.name]
    ?? tool.name
      .replace(/[_-]+/g, " ")
      .replace(/\b(pdf|docx|mcp|cli)\b/gi, (value) => value.toUpperCase());
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function CopyableCodeBlock({ children, onCopy }: { children: ReactNode; onCopy: (value: string, label?: string) => Promise<boolean> }) {
  const [copied, setCopied] = useState(false);
  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];
  const code = nodeText(childNodes).replace(/\n$/, "");
  const language = isValidElement<{ className?: string }>(firstChild)
    ? firstChild.props.className?.replace(/^language-/, "") ?? "code"
    : "code";
  return (
    <div className="code-block">
      <div className="code-block__header">
        <span>{language}</span>
        <button
          type="button"
          aria-label="复制代码"
          title={copied ? "已复制" : "复制代码"}
          onClick={async () => {
            if (await onCopy(code, "代码")) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function MessageBody({ content, onCopy }: { content: string; onCopy: (value: string, label?: string) => Promise<boolean> }) {
  return (
    <div className="message-body markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          input: ({ checked, type }) => type === "checkbox" ? <input type="checkbox" checked={checked} readOnly /> : null,
          pre: ({ children }) => <CopyableCodeBlock onCopy={onCopy}>{children}</CopyableCodeBlock>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function PlainMessageBody({ content }: { content: string }) {
  return <div className="message-body message-body--plain">{content}</div>;
}

function SentAttachments({ attachments }: { attachments: DesktopMessageAttachment[] }) {
  return (
    <div className="sent-attachments" aria-label="已发送附件">
      {attachments.map((attachment) => attachment.kind === "image" && attachment.previewUrl ? (
        <figure className="sent-attachment sent-attachment--image" key={attachment.id}>
          <img src={attachment.previewUrl} alt={attachment.name} draggable={false} />
          <figcaption><Icon name="image" size={13} /><span>{attachment.name}</span><small>{formatFileSize(attachment.size)}</small></figcaption>
        </figure>
      ) : (
        <div className="sent-attachment sent-attachment--file" key={attachment.id} title={attachment.path}>
          <span className="sent-attachment__icon"><Icon name={attachment.kind === "code" ? "code" : attachment.kind === "image" ? "image" : "file"} size={15} /></span>
          <span><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></span>
        </div>
      ))}
    </div>
  );
}

interface GenericLifecyclePage {
  items?: unknown[];
  events?: unknown[];
  returned?: number;
  hasMore?: boolean;
  partial?: boolean;
}

function recordValue(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function LifecycleResultList({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const page = value as GenericLifecyclePage;
  const records = Array.isArray(page.items) ? page.items : Array.isArray(page.events) ? page.events : undefined;
  if (!records) return null;
  return (
    <div className="lifecycle-result" aria-label="生命周期结果">
      <div className="lifecycle-result__summary">
        <span>{page.returned ?? records.length} 条记录</span>
        {page.hasMore && <em>可继续分页</em>}
        {page.partial && <em>部分结果</em>}
      </div>
      {records.slice(0, 200).map((entry, index) => {
        const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : { value: entry };
        const title = recordValue(record, ["name", "checkpointId", "workerSessionId", "uri", "eventId", "serverName"])
          ?? `记录 ${index + 1}`;
        const detail = [
          recordValue(record, ["status", "state", "kind", "representation", "mimeType"]),
          recordValue(record, ["createdAt", "updatedAt", "requestedAt"]),
          recordValue(record, ["uri"]),
        ].filter((part): part is string => Boolean(part)).join(" · ");
        return (
          <div className="lifecycle-result__row" key={`${title}-${index}`}>
            <strong title={title}>{title}</strong>
            {detail && <small title={detail}>{detail}</small>}
          </div>
        );
      })}
    </div>
  );
}

function toolRoundDuration(tools: ToolCallState[]): number | undefined {
  const starts = tools
    .map((tool) => tool.result?.startedAt ?? tool.startedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  const ends = tools
    .map((tool) => tool.result?.endedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  if (!starts.length || !ends.length) return undefined;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

function ActivityTrace({ tools, active, round }: { tools: ToolCallState[]; active: boolean; round: number }) {
  const [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);
  const failed = tools.some((tool) => tool.status === "error");
  const duration = toolRoundDuration(tools);
  return (
    <details
      className={`activity-group${active ? " activity-group--active" : ""}${failed ? " activity-group--error" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="activity-group__summary">
        <span className="activity-group__glyph">
          {active ? <span className="kinetic-dot" /> : <Icon name={failed ? "x" : "check"} size={13} />}
        </span>
        <strong>{`第 ${round} 轮 · ${active ? "正在运行" : "运行了"} ${tools.length} 个工具`}</strong>
        {duration !== undefined && <small>{formatDuration(duration)}</small>}
        <Icon name="chevron-down" size={13} />
      </summary>
      <div className={`activity-trace${active ? " activity-trace--active" : ""}`}>
        <div className="activity-trace__rail">
          <span className="activity-trace__beam" />
          <span className="activity-trace__pulse" />
        </div>
        <div className="activity-trace__steps">
          {tools.map((tool) => (
            <details className={`tool-step tool-step--${tool.status}`} key={tool.id}>
              <summary>
                <span className="tool-step__glyph">
                  {tool.status === "running"
                    ? <span className="kinetic-dot" />
                    : tool.status === "queued"
                      ? <span className="queued-dot" />
                      : <Icon name={tool.status === "success" ? "check" : "x"} size={13} />}
                </span>
                <span>{toolLabel(tool)}</span>
                <small>{tool.status === "queued" ? "等待执行" : tool.status === "running" ? "执行中" : tool.status === "success" ? "完成" : "失败"}</small>
                <Icon name="chevron-down" size={13} />
              </summary>
              <div className="tool-step__details">
                <LifecycleResultList value={tool.result?.structuredContent} />
                <div className="tool-step__output">
                  {tool.result?.error && <div>{`error: ${tool.result.error}`}</div>}
                  <div>{tool.result?.output ?? JSON.stringify(tool.args ?? {}, null, 2)}</div>
                </div>
                <ToolOutputArtifacts artifacts={tool.result?.artifacts} />
              </div>
            </details>
          ))}
        </div>
      </div>
    </details>
  );
}

function WorkingIndicator({ duration }: { duration: number }) {
  return (
    <div className="working-indicator" role="status" aria-label="处理中">
      <span className="thinking-orbit"><span /><span /><span /></span>
      <small>{formatDuration(duration)}</small>
    </div>
  );
}

function ProcessTimeline({ messages, onCopy }: {
  messages: DisplayMessage[];
  onCopy: (value: string, label?: string) => Promise<boolean>;
}) {
  let round = 0;
  return (
    <div className="process-timeline">
      {messages.map((message) => {
        const tools = message.toolCalls ?? [];
        const renderedRound = tools.length > 0 ? ++round : round;
        return (
          <div className="process-phase" key={message.id}>
            {message.role === "status" && (
              <div className="conversation-status"><span /><p>{message.content}</p></div>
            )}
            {message.role === "user" && message.content && (
              <div className="phase-user-response">
                <span>你的补充</span>
                <PlainMessageBody content={message.content} />
              </div>
            )}
            {message.role === "user" && message.attachments && message.attachments.length > 0 && (
              <SentAttachments attachments={message.attachments} />
            )}
            {message.role === "assistant" && message.content && (
              <div className="phase-summary"><MessageBody content={message.content} onCopy={onCopy} /></div>
            )}
            {tools.length > 0 && (
              <ActivityTrace
                tools={tools}
                round={renderedRound}
                active={tools.some((tool) => tool.status === "queued" || tool.status === "running")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProcessHistory({ messages, duration, toolRoundCount, toolCallCount, onCopy }: {
  messages: DisplayMessage[];
  duration?: number;
  toolRoundCount: number;
  toolCallCount: number;
  onCopy: (value: string, label?: string) => Promise<boolean>;
}) {
  return (
    <details className="process-history">
      <summary>
        <span>{duration !== undefined ? `已处理 ${formatDuration(duration)}` : "已处理"}</span>
        {toolRoundCount > 0 && <small>{`${toolRoundCount} 轮 · ${toolCallCount} 次工具调用`}</small>}
        <Icon name="chevron-down" size={14} />
      </summary>
      <div className="process-history__body">
        <ProcessTimeline messages={messages} onCopy={onCopy} />
      </div>
    </details>
  );
}

function ProcessReceipt({ duration }: { duration: number }) {
  return <div className="process-receipt">{`已处理 ${formatDuration(duration)}`}</div>;
}

export function ChatPanel({ sessionId, messages, busy, taskTitle, liveDurationMs, taskDurationMs, onCopy, onSuggestion }: ChatPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const previousSessionIdRef = useRef(sessionId);
  const turns = useMemo(() => projectConversationTurns(messages, busy), [busy, messages]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const movedUp = viewport.scrollTop < previousScrollTopRef.current - 1;
    if (movedUp) followLatestRef.current = false;
    else if (isChatViewportNearBottom(viewport)) followLatestRef.current = true;
    previousScrollTopRef.current = viewport.scrollTop;
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (previousSessionIdRef.current !== sessionId) {
      previousSessionIdRef.current = sessionId;
      followLatestRef.current = true;
      previousScrollTopRef.current = 0;
    }
    if (followLatestRef.current) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
    }
  }, [busy, messages, sessionId]);

  const viewportInteractionProps = {
    onScroll: handleScroll,
    onWheel: (event: React.WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) followLatestRef.current = false;
    },
  };

  if (messages.length === 0) {
    return (
      <main className="chat-viewport chat-viewport--empty" ref={viewportRef} {...viewportInteractionProps}>
        <div className="empty-hero">
          <div className="empty-hero__mark"><BrandMark /></div>
          <div className="empty-hero__eyebrow">DEEP-MIX WORKSPACE</div>
          <h1>今天要把什么变得更好？</h1>
          <p>从一个目标开始。Deep-Mix 会规划、调用工具，并在需要时停下来请你确认。</p>
          <div className="suggestion-grid">
            <button onClick={() => onSuggestion("先阅读项目结构，然后给出一个可以直接执行的重构计划")}>审阅项目并规划重构 <span>→</span></button>
            <button onClick={() => onSuggestion("检查当前工作区的测试与类型错误，并修复根因")}>诊断并修复问题 <span>→</span></button>
            <button onClick={() => onSuggestion("根据我上传的界面截图实现对应的前端页面")}>从附件实现界面 <span>→</span></button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="chat-viewport" ref={viewportRef} {...viewportInteractionProps}>
      <div className="conversation">
        {taskTitle && <div className="conversation__title">{taskTitle}</div>}
        {turns.map((turn, turnIndex) => {
          const isLatestTurn = turnIndex === turns.length - 1;
          const duration = turn.durationMs ?? (isLatestTurn ? taskDurationMs : undefined);
          const assistantTimestamp = turn.final?.timestamp ?? turn.process[0]?.timestamp;
          const showAssistant = turn.process.length > 0 || Boolean(turn.final) || turn.running;
          return (
            <section className="conversation-turn" key={turn.id}>
              {turn.user && (
                <article className="message-row message-row--user">
                  <div className="message-row__identity"><span className="user-glyph">你</span></div>
                  <div className="message-row__content">
                    <div className="message-row__meta">
                      <strong>你</strong>
                      <span>{formatClock(turn.user.timestamp)}</span>
                    </div>
                    {turn.user.content && <PlainMessageBody content={turn.user.content} />}
                    {turn.user.attachments && turn.user.attachments.length > 0 && <SentAttachments attachments={turn.user.attachments} />}
                    {turn.user.content && (
                      <div className="message-actions">
                        <button
                          title="复制消息"
                          aria-label="复制消息"
                          onClick={() => onCopy(turn.user!.content, "消息")}
                        ><Icon name="copy" size={14} /></button>
                      </div>
                    )}
                  </div>
                </article>
              )}
              {showAssistant && (
                <article className="message-row message-row--assistant">
                  <div className="message-row__identity"><BrandMark compact /></div>
                  <div className="message-row__content">
                    <div className="message-row__meta">
                      <strong>Deep-Mix</strong>
                      <span>{formatClock(assistantTimestamp)}</span>
                    </div>
                    {turn.final && turn.process.length > 0 && (
                      <ProcessHistory
                        messages={turn.process}
                        duration={duration}
                        toolRoundCount={turn.toolRoundCount}
                        toolCallCount={turn.toolCallCount}
                        onCopy={onCopy}
                      />
                    )}
                    {turn.final && turn.process.length === 0 && duration !== undefined && (
                      <ProcessReceipt duration={duration} />
                    )}
                    {!turn.final && turn.process.length > 0 && (
                      <ProcessTimeline messages={turn.process} onCopy={onCopy} />
                    )}
                    {turn.final?.content && <MessageBody content={turn.final.content} onCopy={onCopy} />}
                    {turn.running && <WorkingIndicator duration={liveDurationMs} />}
                    {turn.final?.content && (
                      <div className="message-actions">
                        <button
                          title="复制回复"
                          aria-label="复制回复"
                          onClick={() => onCopy(turn.final!.content, "回复")}
                        ><Icon name="copy" size={14} /></button>
                      </div>
                    )}
                  </div>
                </article>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
