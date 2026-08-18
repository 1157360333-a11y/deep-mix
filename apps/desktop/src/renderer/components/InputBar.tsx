import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRecord, PermissionMode } from "@deep-mix/shared-schema";
import type { AttachmentDescriptor, DesktopSettings } from "@shared/ipc";
import { DEFAULT_DESKTOP_SHORTCUTS, shortcutFromKeyboardEvent } from "@shared/shortcut-config";
import { buildApprovalDisplayDetails } from "../approval-display";
import { filterSlashCommands, matchSlashCommandDraft, SLASH_COMMANDS, type SlashCommandItem } from "../slash-commands";
import { Icon } from "./Icons";
import { SelectMenu } from "./SelectMenu";

interface InputBarProps {
  draft: string;
  settings: DesktopSettings | null;
  attachments: AttachmentDescriptor[];
  approvals: ApprovalRecord[];
  questionPending: boolean;
  busy: boolean;
  /** 当前对话目标（预留接口，后端接线前仅作界面状态） */
  goal: string | null;
  onGoalChange: (goal: string | null) => void;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onPickAttachments: () => void;
  onDropFiles: (files: File[]) => void;
  onPasteImage: () => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  onSetReasoningEffort: (effort: "low" | "medium" | "high") => void;
  onResolveApproval: (approval: ApprovalRecord, persistence: "allow_once" | "allow_session" | "deny") => void;
}

function formatFileSize(size: number): string {
  if (!size) return "本地文件";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentIcon(kind: AttachmentDescriptor["kind"]): "image" | "code" | "file" {
  return kind === "image" ? "image" : kind === "code" ? "code" : "file";
}

export function InputBar({
  draft,
  settings,
  attachments,
  approvals,
  questionPending,
  busy,
  goal,
  onGoalChange,
  onDraftChange,
  onSend,
  onStop,
  onPickAttachments,
  onDropFiles,
  onPasteImage,
  onRemoveAttachment,
  onSetPermissionMode,
  onSetReasoningEffort,
  onResolveApproval,
}: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pastingImage, setPastingImage] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const [dangerConfirmOpen, setDangerConfirmOpen] = useState(false);
  const [dangerAcked, setDangerAcked] = useState(false);
  const activeApproval = approvals[0];
  const approvalDisplay = activeApproval
    ? buildApprovalDisplayDetails(activeApproval)
    : undefined;
  const inputBlocked = Boolean(activeApproval) || questionPending;
  const controlsDisabled = busy || inputBlocked;
  const planActive = settings?.permissionMode === "plan";
  const canSend = !inputBlocked && (draft.trim().length > 0 || attachments.length > 0);
  const slashMatches = useMemo(
    () => (!inputBlocked && matchSlashCommandDraft(draft.trimStart()) ? filterSlashCommands(draft.trimStart()) : []),
    [draft, inputBlocked],
  );
  const slashMenuOpen = !slashDismissed && slashMatches.length > 0;

  useEffect(() => {
    setSlashDismissed(false);
    setSlashIndex(0);
  }, [draft]);

  useEffect(() => {
    if (!addMenuOpen && !goalEditorOpen) return;
    const close = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) {
        setAddMenuOpen(false);
        setGoalEditorOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [addMenuOpen, goalEditorOpen]);

  const togglePlanMode = () => onSetPermissionMode(planActive ? "auto" : "plan");

  const closeDangerConfirm = () => {
    setDangerConfirmOpen(false);
    setDangerAcked(false);
  };

  const handlePermissionModeChange = (mode: PermissionMode) => {
    if (mode === "danger-full-access" && settings?.permissionMode !== "danger-full-access") {
      setDangerAcked(false);
      setDangerConfirmOpen(true);
      return;
    }
    onSetPermissionMode(mode);
  };

  useEffect(() => {
    if (!dangerConfirmOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeDangerConfirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dangerConfirmOpen]);

  const openGoalEditor = () => {
    setGoalDraft(goal ?? "");
    setAddMenuOpen(false);
    setGoalEditorOpen(true);
  };

  const confirmGoal = () => {
    onGoalChange(goalDraft.trim() || null);
    setGoalEditorOpen(false);
  };

  const insertSlashCommand = () => {
    setAddMenuOpen(false);
    onDraftChange("/");
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const completeSlashCommand = (command: SlashCommandItem) => {
    onDraftChange(command.args ? `${command.name} ` : command.name);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSlashIndex((index) => (index + direction + slashMatches.length) % slashMatches.length);
      return;
    }
    if (slashMenuOpen && event.key === "Tab") {
      event.preventDefault();
      completeSlashCommand(slashMatches[slashIndex] ?? slashMatches[0]);
      return;
    }
    if (slashMenuOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSlashDismissed(true);
      return;
    }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    const sendShortcut = settings ? settings.shortcuts.sendMessage : DEFAULT_DESKTOP_SHORTCUTS.sendMessage;
    const newLineShortcut = settings ? settings.shortcuts.newLine : DEFAULT_DESKTOP_SHORTCUTS.newLine;
    if (shortcut === newLineShortcut && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const field = event.currentTarget;
      const start = field.selectionStart;
      const end = field.selectionEnd;
      onDraftChange(`${draft.slice(0, start)}\n${draft.slice(end)}`);
      window.requestAnimationFrame(() => field.setSelectionRange(start + 1, start + 1));
      return;
    }
    if (shortcut === sendShortcut && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const exactCommand = SLASH_COMMANDS.some((command) => command.name === draft.trim().toLowerCase());
      if (slashMenuOpen && !exactCommand) {
        completeSlashCommand(slashMatches[slashIndex] ?? slashMatches[0]);
        return;
      }
      if (!busy && canSend) onSend();
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    onDropFiles(Array.from(event.dataTransfer.files));
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const hasImage = Array.from(event.clipboardData.items).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (!hasImage) return;
    event.preventDefault();
    setPastingImage(true);
    try {
      await onPasteImage();
    } finally {
      setPastingImage(false);
    }
  };

  return (
    <div className="composer-shell">
      {activeApproval && (
        <section className="inline-approval" aria-label="待审批操作">
          <div className="inline-approval__signal"><Icon name="shield" size={17} /></div>
          <div className="inline-approval__copy">
            <div className="inline-approval__eyebrow">需要你的确认</div>
            <strong>{activeApproval.toolName.replace(/_/g, " ")}</strong>
            {approvalDisplay && (
              <>
                <div className="inline-approval__meta">
                  {approvalDisplay.action && <span>{`操作: ${approvalDisplay.action}`}</span>}
                  {approvalDisplay.risk && <span>{`风险: ${approvalDisplay.risk}`}</span>}
                </div>
                <p>{approvalDisplay.summary}</p>
                {(approvalDisplay.paths.length > 0 || approvalDisplay.revisions.length > 0) && (
                  <div className="inline-approval__scope" aria-label="审批影响范围">
                    {approvalDisplay.paths.length > 0 && (
                      <span><b>路径:</b> <code>{approvalDisplay.paths.join(", ")}</code></span>
                    )}
                    {approvalDisplay.revisions.length > 0 && (
                      <span><b>Revision:</b> <code>{approvalDisplay.revisions.join(", ")}</code></span>
                    )}
                  </div>
                )}
              </>
            )}
            {approvals.length > 1 && <small>处理后还有 {approvals.length - 1} 项待确认</small>}
          </div>
          <div className="inline-approval__actions">
            <button className="approval-action approval-action--primary" onClick={() => onResolveApproval(activeApproval, "allow_once")}>允许一次</button>
            <button className="approval-action" onClick={() => onResolveApproval(activeApproval, "allow_session")}>本任务允许</button>
            <button className="approval-action approval-action--deny" onClick={() => onResolveApproval(activeApproval, "deny")}>拒绝</button>
          </div>
        </section>
      )}

      <div
        className={`composer${dragging ? " composer--dragging" : ""}${inputBlocked ? " composer--blocked" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={handleDrop}
      >
        {dragging && <div className="composer-dropzone"><Icon name="paperclip" size={20} />释放以添加到当前任务</div>}
        {attachments.length > 0 && (
          <div className="attachment-strip">
            {attachments.map((attachment) => (
              <div className={`attachment-pill${attachment.previewUrl ? " attachment-pill--preview" : ""}`} key={attachment.id} title={attachment.path}>
                {attachment.previewUrl
                  ? <span className="attachment-pill__preview"><img src={attachment.previewUrl} alt={attachment.name} /></span>
                  : <span className="attachment-pill__icon"><Icon name={attachmentIcon(attachment.kind)} size={15} /></span>}
                <span className="attachment-pill__copy"><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></span>
                <button onClick={() => onRemoveAttachment(attachment.id)} title="移除附件"><Icon name="x" size={13} /></button>
              </div>
            ))}
          </div>
        )}

        {pastingImage && <div className="composer-paste-status"><Icon name="image" size={14} />正在读取剪贴板图片…</div>}

        {slashMenuOpen && (
          <div className="slash-menu" role="listbox" aria-label="命令">
            <div className="slash-menu__title">命令</div>
            {slashMatches.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === slashIndex}
                className={index === slashIndex ? "is-active" : ""}
                onMouseEnter={() => setSlashIndex(index)}
                onClick={() => completeSlashCommand(command)}
              >
                <strong>{command.name}</strong>
                <span>{command.description}</span>
                {command.args && <small>{command.args}</small>}
              </button>
            ))}
          </div>
        )}
        <textarea
          id="deep-mix-composer"
          ref={textareaRef}
          value={draft}
          disabled={inputBlocked}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => void handlePaste(event)}
          placeholder={activeApproval ? "先处理上方审批后再继续…" : questionPending ? "请先回答上方问题，Deep-Mix 会从原任务继续" : settings?.permissionMode === "plan" ? "描述目标，我会先制定计划而不修改文件…" : "描述你想完成的任务，或输入 / 使用命令…"}
          rows={1}
        />

        <div className="composer__toolbar">
          <div className="composer__tools">
            <div className="add-menu-anchor" ref={addMenuRef}>
              <button
                className="toolbar-icon-button"
                onClick={() => { setGoalEditorOpen(false); setAddMenuOpen((value) => !value); }}
                disabled={inputBlocked}
                title="添加文件、目标、计划模式或命令"
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
              >
                <Icon name="plus" size={18} />
              </button>
              {addMenuOpen && (
                <div className="add-menu" role="menu" aria-label="添加">
                  <div className="add-menu__title">添加</div>
                  <button className="add-menu__item" onClick={() => { setAddMenuOpen(false); onPickAttachments(); }}>
                    <span className="add-menu__item-icon"><Icon name="paperclip" size={14} /></span>
                    <span className="add-menu__item-copy"><strong>文件和文件夹</strong><small>添加到当前任务</small></span>
                  </button>
                  <button className="add-menu__item" onClick={openGoalEditor}>
                    <span className="add-menu__item-icon"><Icon name="target" size={14} /></span>
                    <span className="add-menu__item-copy"><strong>目标</strong><small>设置要持续追求的目标</small></span>
                    {goal && <Icon name="check" size={14} />}
                  </button>
                  <button className="add-menu__item" disabled={busy} onClick={() => { setAddMenuOpen(false); togglePlanMode(); }}>
                    <span className="add-menu__item-icon"><Icon name="plan" size={14} /></span>
                    <span className="add-menu__item-copy"><strong>计划模式</strong><small>{planActive ? "关闭计划模式" : "只分析和规划，不修改文件"}</small></span>
                    {planActive && <Icon name="check" size={14} />}
                  </button>
                  <button className="add-menu__item" onClick={insertSlashCommand}>
                    <span className="add-menu__item-icon"><Icon name="terminal" size={14} /></span>
                    <span className="add-menu__item-copy"><strong>命令</strong><small>输入 / 查看全部命令</small></span>
                  </button>
                </div>
              )}
              {goalEditorOpen && (
                <div className="goal-editor" role="dialog" aria-label="设置目标">
                  <div className="add-menu__title">目标</div>
                  <input
                    autoFocus
                    value={goalDraft}
                    onChange={(event) => setGoalDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); confirmGoal(); }
                      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setGoalEditorOpen(false); }
                    }}
                    placeholder="设置要持续追求的目标…"
                  />
                  <div className="goal-editor__actions">
                    {goal && <button onClick={() => { onGoalChange(null); setGoalEditorOpen(false); }}>清除</button>}
                    <button className="is-primary" onClick={confirmGoal}>确定</button>
                  </div>
                </div>
              )}
            </div>
            <SelectMenu
              ariaLabel="权限模式"
              placement="top"
              variant="minimal"
              disabled={controlsDisabled}
              value={settings?.permissionMode ?? "auto"}
              options={[
                { value: "plan", label: "只读规划", icon: "shield-check" },
                { value: "edit", label: "工作区写入", icon: "shield-edit" },
                { value: "auto", label: "按需审批", icon: "shield-question" },
                { value: "danger-full-access", label: "完全访问", icon: "shield-alert", tone: "danger" },
              ]}
              onChange={(value) => handlePermissionModeChange(value as PermissionMode)}
            />
            {planActive && (
              <button className="composer-chip" disabled={controlsDisabled} onClick={togglePlanMode} title="计划模式已开启，点击关闭">
                <Icon name="plan" size={13} /><span>计划</span><Icon name="x" size={11} />
              </button>
            )}
            {goal && (
              <button className="composer-chip" disabled={controlsDisabled} onClick={() => onGoalChange(null)} title={`目标：${goal}（点击移除）`}>
                <Icon name="target" size={13} /><span>{goal}</span><Icon name="x" size={11} />
              </button>
            )}
          </div>

          <div className="composer__send-area">
            <SelectMenu
              ariaLabel="思考深度"
              placement="top"
              variant="minimal"
              disabled={busy || inputBlocked}
              value={settings?.reasoningEffort ?? "medium"}
              options={[
                { value: "low", label: "快速" },
                { value: "medium", label: "标准" },
                { value: "high", label: "深度" },
              ]}
              onChange={onSetReasoningEffort}
            />
            {busy ? (
              <button className="send-button send-button--stop" onClick={onStop} title="停止当前任务"><Icon name="stop" size={14} /></button>
            ) : (
              <button className="send-button" onClick={onSend} disabled={!canSend} title="发送"><Icon name="arrow-up" size={18} /></button>
            )}
          </div>
        </div>
      </div>
      {dangerConfirmOpen && (
        <div className="dialog-overlay" onMouseDown={closeDangerConfirm}>
          <section className="risk-dialog" role="alertdialog" aria-label="确认启用完全访问" onMouseDown={(event) => event.stopPropagation()}>
            <header className="risk-dialog__header">
              <strong>确认启用完全访问？</strong>
              <button onClick={closeDangerConfirm} aria-label="关闭"><Icon name="x" size={16} /></button>
            </header>
            <div className="risk-dialog__body">
              <div className="risk-dialog__warning">
                <span className="risk-dialog__warning-icon"><Icon name="alert" size={15} /></span>
                <p>启用完全访问后，Deep-Mix 将减少确认步骤，可以直接执行更多操作，包括敏感操作、文件修改或外部命令。这会带来敏感数据丢失或泄露等风险，仅建议在你信任当前任务时使用。</p>
              </div>
              <label className="risk-dialog__ack">
                <input type="checkbox" checked={dangerAcked} onChange={(event) => setDangerAcked(event.target.checked)} />
                <span>我已了解风险，并愿意继续</span>
              </label>
            </div>
            <div className="risk-dialog__footer">
              <button onClick={closeDangerConfirm}>取消</button>
              <button className="is-danger" disabled={!dangerAcked} onClick={() => { closeDangerConfirm(); onSetPermissionMode("danger-full-access"); }}>
                <Icon name="alert" size={13} />启用完全访问
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
