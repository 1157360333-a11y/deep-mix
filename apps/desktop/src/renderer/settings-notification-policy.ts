export function getSettingsSuccessToast(patch: object): string | null {
  if ("models" in patch && patch.models) return "模型设置已保存并应用";
  if ("shortcuts" in patch && patch.shortcuts) return "快捷键已保存并应用";
  return null;
}
