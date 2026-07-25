import { useRef, useState } from "react";
import type { ApprovalRecord, PermissionMode, RouteTarget } from "@deep-mix/shared-schema";
import type { AttachmentDescriptor, DesktopSettings } from "@shared/ipc";
import { buildApprovalDisplayDetails } from "../approval-display";
import { Icon } from "./Icons";
import { SelectMenu } from "./SelectMenu";

interface InputBarProps {
  draft: string;
  settings: DesktopSettings | null;
  attachments: AttachmentDescriptor[];
  approvals: ApprovalRecord[];
  questionPending: boolean;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onPickAttachments: () => void;
  onDropFiles: (files: File[]) => void;
  onPasteImage: () => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  onSetReasoningEffort: (effort: "low" | "medium" | "high") => void;
  onSetRoute: (route: RouteTarget | null) => void;
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
  onDraftChange,
  onSend,
  onStop,
  onPickAttachments,
  onDropFiles,
  onPasteImage,
  onRemoveAttachment,
  onSetPermissionMode,
  onSetReasoningEffort,
  onSetRoute,
  onResolveApproval,
}: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pastingImage, setPastingImage] = useState(false);
  const activeApproval = approvals[0];
  const approvalDisplay = activeApproval
    ? buildApprovalDisplayDetails(activeApproval)
    : undefined;
  const inputBlocked = Boolean(activeApproval) || questionPending;
  const canSend = !inputBlocked && (draft.trim().length > 0 || attachments.length > 0);
  const commandMode = draft.trimStart().startsWith("/");

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!busy && canSend) onSend();
    }
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

        {commandMode && !inputBlocked && (
          <div className="composer-command-mode"><Icon name="terminal" size={13} /><span>命令模式</span><small>/help 查看全部命令</small></div>
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
            <button className="toolbar-icon-button" onClick={onPickAttachments} disabled={inputBlocked} title="添加附件">
              <Icon name="plus" size={18} />
            </button>
            <SelectMenu
              ariaLabel="任务模式"
              placement="top"
              icon="plan"
              disabled={busy || inputBlocked}
              value={settings?.permissionMode === "plan" ? "plan" : "agent"}
              options={[
                { value: "agent", label: "执行模式", description: "可以读取、修改并运行工具", icon: "activity" },
                { value: "plan", label: "Plan 模式", description: "只分析和规划，不修改文件", icon: "plan", tone: "accent" },
              ]}
              onChange={(value) => onSetPermissionMode(value === "plan" ? "plan" : "auto")}
            />
            <SelectMenu
              ariaLabel="思考深度"
              placement="top"
              variant="reasoning"
              disabled={busy || inputBlocked}
              value={settings?.reasoningEffort ?? "medium"}
              options={[
                { value: "low", label: "快速思考", description: "单轨推理 · 简单问答与小改动", depthLevel: 1 },
                { value: "medium", label: "标准思考", description: "双轨校验 · 速度与质量平衡", depthLevel: 2 },
                { value: "high", label: "深度思考", description: "三轨汇聚 · 复杂重构与调试", depthLevel: 3, tone: "accent" },
              ]}
              onChange={onSetReasoningEffort}
            />
            <SelectMenu
              ariaLabel="模型路由"
              placement="top"
              icon="plugin"
              disabled={busy || inputBlocked}
              value={settings?.routeOverride ?? "auto"}
              options={[
                { value: "auto", label: "自动路由", description: "按任务自动选择模型", icon: "spark" },
                { value: "ds_direct", label: "DeepSeek", description: "Governor 直接执行", icon: "activity" },
                { value: "glm_coding", label: "GLM 编码", description: "复杂代码与跨文件任务", icon: "code" },
                { value: "kimi_vision", label: "Kimi 视觉", description: "图片、截图与界面分析", icon: "image" },
              ]}
              onChange={(value) => onSetRoute(value === "auto" ? null : value as RouteTarget)}
            />
          </div>

          <div className="composer__send-area">
            <span className="composer__hint">Shift+Enter 换行 · Enter 发送</span>
            {busy ? (
              <button className="send-button send-button--stop" onClick={onStop} title="停止当前任务"><Icon name="stop" size={14} /></button>
            ) : (
              <button className="send-button" onClick={onSend} disabled={!canSend} title="发送"><Icon name="arrow-up" size={18} /></button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-meta">
        <span><Icon name="shield" size={12} />{activeApproval ? "等待审批" : questionPending ? "等待问题回答" : settings?.permissionMode === "danger-full-access" ? "完全访问" : settings?.permissionMode === "edit" ? "工作区写入" : settings?.permissionMode === "plan" ? "只读规划" : "按需审批"}</span>
        <span>{settings?.profiles.deepseek_governor.hasKey ? "模型已连接" : "模型未配置"}</span>
      </div>
    </div>
  );
}
