import { useRef, useState, type FormEvent } from "react";
import type { ModelCapabilityManifest, ModelSlotId } from "@deep-mix/shared-schema";
import type { DesktopModelProfileSaveInput, DesktopModelReferenceStatus, DesktopModelSlotStatus } from "@shared/ipc";
import { Icon } from "./Icons";

interface ModelProfileEditorProps {
  slot: ModelSlotId;
  settingsRevision: number;
  profileRevision: number;
  current: DesktopModelReferenceStatus;
  requiredCapabilities: DesktopModelSlotStatus["requiredCapabilities"];
  mode: "create" | "edit";
  disabled: boolean;
  onCancel: () => void;
  onSave: (input: DesktopModelProfileSaveInput) => Promise<void>;
}

function slotDefaults(slot: ModelSlotId, contextWindow: number): ModelCapabilityManifest {
  return {
    textInput: true,
    imageInput: slot === "vision",
    streaming: slot === "governor",
    nativeToolCalling: slot === "governor",
    structuredOutput: slot !== "governor",
    reasoning: slot === "governor",
    contextWindow,
  };
}

const capabilityLabels: Array<{ key: Exclude<keyof ModelCapabilityManifest, "contextWindow">; label: string }> = [
  { key: "textInput", label: "文本输入" },
  { key: "imageInput", label: "图片输入" },
  { key: "streaming", label: "流式输出" },
  { key: "nativeToolCalling", label: "原生工具调用" },
  { key: "structuredOutput", label: "结构化输出" },
  { key: "reasoning", label: "推理模式" },
];

export function ModelProfileEditor({
  slot,
  settingsRevision,
  profileRevision,
  current,
  requiredCapabilities,
  mode,
  disabled,
  onCancel,
  onSave,
}: ModelProfileEditorProps) {
  const source = mode === "edit" ? current : undefined;
  const required = new Set(requiredCapabilities);
  const initialCapabilities = {
    ...(source?.status.capabilities ?? slotDefaults(slot, 128_000)),
  };
  for (const { key } of capabilityLabels) {
    if (required.has(key)) initialCapabilities[key] = true;
  }
  const editableEndpoint = (value: string | undefined, fallback: string): string =>
    value?.includes("[REDACTED") ? "" : value ?? fallback;
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const slotLabel = slot === "governor" ? "总线" : slot === "coding" ? "编程" : "视觉";
  const [profileId, setProfileId] = useState(mode === "edit" ? current.profileId : `${slot}_custom`);
  const [displayName, setDisplayName] = useState(mode === "edit" ? current.displayName : `自定义${slotLabel}接入`);
  const [provider, setProvider] = useState(source?.status.provider ?? "custom");
  const [protocol, setProtocol] = useState(source?.status.protocol ?? "openai_chat_completions");
  const [adapterId, setAdapterId] = useState(source?.status.adapterId ?? "openai_compatible");
  const [baseUrl, setBaseUrl] = useState(editableEndpoint(source?.status.baseUrl, ""));
  const [endpointPath, setEndpointPath] = useState(editableEndpoint(source?.status.endpointPath, "/chat/completions"));
  const [model, setModel] = useState(source?.model ?? source?.status.model ?? "");
  const [capabilities, setCapabilities] = useState(initialCapabilities);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const apiKey = apiKeyRef.current?.value.trim();
    try {
      await onSave({
        slot,
        expectedSettingsRevision: settingsRevision,
        expectedProfileRevision: profileRevision,
        profileId: profileId.trim(),
        displayName: displayName.trim(),
        provider: provider.trim(),
        protocol: protocol.trim(),
        adapterId,
        ...(apiKey ? { apiKey } : {}),
        baseUrl: baseUrl.trim(),
        endpointPath: endpointPath.trim(),
        model: model.trim(),
        capabilities,
      });
      if (apiKeyRef.current) apiKeyRef.current.value = "";
      onCancel();
    } catch (saveError) {
      if (apiKeyRef.current) apiKeyRef.current.value = "";
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="model-profile-editor" onSubmit={submit}>
      <div className="model-profile-editor__heading">
        <span><Icon name="plugin" size={14} /></span>
        <div><strong>{mode === "edit" ? "编辑当前接入" : "新建模型接入"}</strong><small>保存后直接设为此槽位主模型</small></div>
      </div>
      <div className="model-profile-editor__grid">
        <label><span>接入名称</span><input value={displayName} maxLength={80} disabled={disabled || saving} onChange={(event) => setDisplayName(event.target.value)} placeholder={`例如：${slotLabel}主模型`} required /></label>
        <label><span>内部 Profile ID</span><input value={profileId} disabled={disabled || saving || mode === "edit"} onChange={(event) => setProfileId(event.target.value)} placeholder="my_governor" title="用于配置引用和兼容迁移；创建后不可修改" required /></label>
        <label><span>Provider</span><input value={provider} disabled={disabled || saving} onChange={(event) => setProvider(event.target.value)} placeholder="openai-compatible" required /></label>
        <label className="is-wide"><span>API Key</span><input ref={apiKeyRef} type="password" autoComplete="new-password" disabled={disabled || saving} placeholder={mode === "edit" && current.status.hasKey ? "留空以保留现有密钥" : "新 Profile 必填；复用已有 ID 可留空"} /></label>
        <label className="is-wide"><span>Base URL</span><input value={baseUrl} disabled={disabled || saving} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required /></label>
        <label><span>接口路径</span><input value={endpointPath} disabled={disabled || saving} onChange={(event) => setEndpointPath(event.target.value)} placeholder="/chat/completions" required /></label>
        <label><span>模型名</span><input value={model} disabled={disabled || saving} onChange={(event) => setModel(event.target.value)} placeholder="model-name" required /></label>
        <label><span>协议</span><input value={protocol} disabled={disabled || saving} onChange={(event) => setProtocol(event.target.value)} placeholder="openai_chat_completions" required /></label>
        <label><span>Adapter</span><select value={adapterId} disabled={disabled || saving} onChange={(event) => setAdapterId(event.target.value)}><option value="openai_compatible">OpenAI compatible</option><option value="deepseek_compat">DeepSeek compatible</option><option value="glm_compat">GLM compatible</option><option value="kimi_compat">Kimi compatible</option></select></label>
        <label className="is-wide"><span>上下文窗口</span><input type="number" min={1} value={capabilities.contextWindow} disabled={disabled || saving} onChange={(event) => setCapabilities((value) => ({ ...value, contextWindow: Math.max(1, Number(event.target.value) || 1) }))} required /></label>
      </div>
      <fieldset className="model-capability-editor">
        <legend>能力声明 <small>带锁标记的是该槽位必需能力</small></legend>
        <div>{capabilityLabels.map(({ key, label }) => {
          const locked = required.has(key);
          return <label className={locked ? "is-required" : ""} key={key}><input type="checkbox" checked={capabilities[key]} disabled={disabled || saving || locked} onChange={(event) => setCapabilities((value) => ({ ...value, [key]: event.target.checked }))} /><span>{label}</span>{locked && <Icon name="shield" size={10} />}</label>;
        })}</div>
      </fieldset>
      <p className="model-profile-editor__security"><Icon name="shield" size={12} />API Key 只发送到主进程凭据控制面；保存后输入框立即清空，界面不会回读。</p>
      {error && <p className="model-profile-editor__error">{error}</p>}
      <div className="model-profile-editor__actions"><button type="button" disabled={saving} onClick={onCancel}>取消</button><button type="submit" disabled={disabled || saving}>{saving ? "保存中…" : "保存并切换"}</button></div>
    </form>
  );
}
