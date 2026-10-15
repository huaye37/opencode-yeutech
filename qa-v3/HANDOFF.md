# AI 工作台 v3 交接（施工中）

## 边界与基线
- 工作区：`家庭网络/.worktrees/v3-agent`；分支 `v3/apple-redesign`；起点 `504d9dc22`。
- 修改范围：`deploy/yeutech-agent-isolated/web` 的 React 表现层及配套 QA。OpenCode 上游 `packages/*`、BFF、API、数据结构与鉴权不修改。
- 已读：仓库 `AGENTS.md`、部署 README、定制集成记录、v3 设计方向第二/五节、全站治理七层及门户 workspace.tsx/workspace.module.css。
- 本分支没有独立命名的 UPSTREAM 文件；上游参照为仓库 README/CONTRIBUTING、隔离部署说明及 design/integration-status.md。旧设计文档已声明旧白底三栏概念废弃，v3 规范优先。
- 不 push、不部署、不重启/修改 NAS，不以本地 mock 验收冒充线上真实模型执行。

## 施工前功能对照表
| 既有能力 | 原入口 / 代码 | v3 保留方式 | 验证 |
|---|---|---|---|
| 独立会话新建、目录折叠、搜索、最近更新排序 | Sidebar / session-ordering.js | 同一事件与排序；macOS 目录行 | 待验 |
| 项目展开、切换、新建项目会话 | Sidebar / selectProject / createProjectSession | 原目录与事件保留 | 待验 |
| 新建项目、扫描 NAS、接入、取消登记、重命名 | ProjectDialog / ProjectDiscoveryDialog / row menu | 原入口与弹窗保留 | 待验 |
| 会话重命名、Fork、删除 | SessionRow / RowMenu | 原菜单保留 | 待验 |
| 原会话历史、向上分页、刷新恢复、SSE 增量 | App / api.js / message-* | 只按职责移到 hooks，协议/顺序不变 | 待验 |
| Markdown、表格、推理折叠、工具轨迹和终端命令/完整结果回读 | TimelineItem / TimelineTool / MarkdownText | 原渲染和回读保留；未新增交互终端 | 待验 |
| 模型选择、动态可用性、会话级持久偏好 | Conversation / changeModel | 原 select 与 API 不变 | 待验 |
| Ultra 推理与 Ultrafast 响应速度独立偏好 | Conversation / changeReasoningEffort / changeServiceTier | 两个独立 select 保留 | 待验 |
| 权限模式、单次允许、拒绝、本任务全部允许 | PermissionCard / replyPermission | 原审批与鉴权逻辑保留 | 待验 |
| 发消息、运行中补充、停止、错误恢复、中文 IME 防重复发送 | Conversation / send / stop | 原输入与执行链保留 | 待验 |
| 文件浏览、搜索/排序/类型/隐藏项、上传/取消/重试/删除、拖入/粘贴、多附件 | FilePanel / UploadQueue | 原处理、受控路径和取消逻辑保留 | 待验 |
| 文本/图像/PDF/Office 预览、文件链接、放大/恢复 | FilePanel / FilePreviewContent | 桌面检查器，手机推入详情 | 待验 |
| 会话文件变更、补丁预览 | DiffPanel | 原入口与读取保留 | 待验 |
| 控制台、Goals、预算、工作图、子任务树、上下文收据、Replay | ControlCenter / AgentConsole | 原控制面弹窗保留 | 待验 |
| 模型能力/Skills/Profiles、插件及项目开关 | CapabilityCenter / PluginCenter | 原入口及 API 保留 | 待验 |
| 导出 Markdown、专注模式、侧栏折叠、双侧拖拽及键盘调宽、文件面板恢复 | App / PanelResizer | 同一事件保留 | 待验 |
| 门户统一外观、系统明暗跟随、访问门户 | portal-appearance.js / 顶栏 | 合同不分叉；不透明工作区；YEUTECH 品牌链接 | 待验 |
| 当前账户 | 原外壳无独立账户入口 | 顶栏加入门户账户链接，不新增身份源 | 待验 |
| 手机导航 | 原覆盖侧栏 | 同一 Sidebar 变首屏目录，选会话推入，可返回目录 | 待验 |

## 实施计划
1. 对 2,068 行 App.jsx、4,163 行 styles.css 按职责做无行为迁移，每文件不超过 600 行。
2. 在定制外壳复刻门户 v3 语言：56px 品牌顶栏、轻 chrome 侧栏、不透明 page 工作区、留白/分隔线、五档字号、实心主操作。合同 CSS/MJS 字节不改。
3. 跑定制服务完整 `npm test`、前端 `npm run build`（含 production material 校验），用 Playwright 本地夹具验证和六尺寸/明暗截图。

## 未验证项
施工中；上线、NAS、真实账号和真实模型执行均不在本次授权范围。
