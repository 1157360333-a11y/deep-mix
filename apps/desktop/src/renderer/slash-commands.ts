export interface SlashCommandItem {
  /** 命令名，包含前导斜杠，如 "/help" */
  name: string;
  description: string;
  /** 参数提示，如 "[id]"；有参数的命令补全后会追加空格 */
  args?: string;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  { name: "/help", description: "查看全部命令" },
  { name: "/context", description: "查看上下文、token 与处理时长" },
  { name: "/compact", description: "将早期回合压缩为摘要" },
  { name: "/status", description: "查看当前会话与运行设置" },
  { name: "/session", description: "显示并复制会话 ID" },
  { name: "/resume", description: "恢复指定或最近会话", args: "[id]" },
  { name: "/continue", description: "继续当前或最近会话" },
  { name: "/undo", description: "恢复最近检查点" },
  { name: "/export", description: "导出当前会话为 Markdown" },
  { name: "/new", description: "打开新建任务窗口" },
  { name: "/zoom-in", description: "放大界面" },
  { name: "/zoom-out", description: "缩小界面" },
  { name: "/zoom-reset", description: "重置界面缩放" },
];

/** 输入内容仍处于“命令输入”阶段：以 / 开头且尚未输入参数。 */
export function matchSlashCommandDraft(draft: string): boolean {
  return /^\/\S*$/.test(draft);
}

export function filterSlashCommands(draft: string): SlashCommandItem[] {
  const query = draft.trimStart().toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}
