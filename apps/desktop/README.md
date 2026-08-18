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
- Plan/执行模式、`Governor / Coding / Vision` 语义路由、低/中/高思考深度和四档权限模式。
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

权限、语义路由、思考深度、Skill 开关和三槽位绑定默认写入用户级 `~/.deep-mix/settings.json`；只有当前工作区本来就有 `.deep-mix/settings.json` 时才继续使用项目级覆盖。模型中心为总线、编程、视觉提供三张独立卡片，可以新建或编辑 profile，并配置 provider、API Key、Base URL、接口路径、模型名、adapter、能力声明、primary、fallback 和 model override；“恢复 classic 预设”只恢复默认绑定，不删除自定义 profile 或密钥。

API Key 只通过受信任 IPC 单向提交给主进程的 Profile Service，并写入用户级 `~/.deep-mix/workspaces/<workspace-id>/api-key-library/profiles.local.json`。密钥不会返回 renderer，不写入 settings、聊天、日志、遥测或导出；编辑时留空表示保留原密钥。保存和切换只影响后续 Provider cycle 或 Worker dispatch，不会热切换正在运行的请求。旧项目内凭据仅作为兼容读取来源，不会被普通 Tool Runtime 改写。

打开其他项目时，桌面端按 workspace 解析 profile library 和三槽位绑定，并兼容启动工作区的历史凭据解析行为；不会复制凭据，也不会为了运行时状态在项目内创建 `.deep-mix/`。实际绑定在激活前按槽位分别经过 capability gate，Vision 接入缺少图片输入能力时会失败关闭。
