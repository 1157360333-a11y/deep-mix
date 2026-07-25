# Deep-Mix Desktop

Deep-Mix 的本地桌面工作台。桌面端直接复用 Governor Runtime、Permission Layer、Session Store、Worker、Skills、Workflows 与 MCP，不维护另一套 agent 逻辑。

## 启动

在仓库根目录运行：

```powershell
npm install
npm run app
```

也可以使用完整命令 `npm run desktop:dev`。生产构建使用 `npm run desktop:build`。

## 主要能力

- 三栏工作区：任务列表、无气泡对话流、上下文检查器；左右栏可隐藏并拖动调整宽度。
- 多项目会话树会同时展示已添加工作区及其任务；点击任意会话即可直接打开对应项目，不需要先切换全局工作区。
- 新建任务时可输入或浏览工作目录，也可以在某个项目标题右侧直接创建。
- 会话支持重命名、置顶、标记未读、复制 ID、归档与删除；归档会话可单独展开查看。
- 石墨深色与纸白浅色主题，主题和栏宽保存在本机。
- Plan/执行模式、模型路由、低/中/高思考深度和四档权限模式。
- 点击或拖拽添加图片、文档、代码等附件；附件以本地绝对路径交给 Runtime。
- Skills、Workflows 与 MCP 插件状态；Skill 可直接启停并写入项目设置。
- 审批固定显示在输入框上方，可点击完成一次允许、任务内允许或拒绝；批准后自动续接原有 tool-call 回合，右侧栏收起也不影响处理。
- 流式正文、流式推理、工具状态、Worker、Artifact 与 Diagnostics。
- 完整 GFM Markdown 渲染，支持标题、列表、粗体、引用、代码块和表格；回复与每个代码块都可独立复制。
- 上下文占用、token 构成、模型、会话累计、处理时长和会话 ID。
- CLI 常用能力的桌面入口：恢复、停止、撤销、导出、状态、上下文和命令面板。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+N` | 新建任务 |
| `Ctrl+K` | 打开命令面板 |
| `Ctrl+L` | 聚焦输入框 |
| `Ctrl+B` | 显示或隐藏左侧栏 |
| `Ctrl+Shift+B` | 显示或隐藏右侧检查器 |
| `Ctrl++` / `Ctrl+=` | 放大界面 |
| `Ctrl+-` | 缩小界面 |
| `Ctrl+0` | 恢复 100% 缩放 |
| `Enter` | 发送 |
| `Shift+Enter` | 输入换行 |

## 斜杠命令

输入框会在文本以 `/` 开头时进入命令模式，不会把命令发送给模型。当前支持：

`/help`、`/context`、`/compact`、`/status`、`/session`、`/resume [id]`、`/continue`、`/undo`、`/export`、`/new`、`/zoom-in`、`/zoom-out`、`/zoom-reset`。

## 设置与安全

权限、模型路由、思考深度和 Skill 开关写入当前工作区的 `.deep-mix/settings.json`。桌面端只检查 profile 与 API key 是否存在，不把真实密钥发送到 renderer，也不在界面中回显密钥。

打开没有本地密钥库的项目时，桌面端会继续使用启动工作区的 `.deep-mix/api-key-library/profiles.local.json`；不会复制或改写密钥文件。若目标工作区提供了同名有效 profile，则优先使用目标工作区配置。
