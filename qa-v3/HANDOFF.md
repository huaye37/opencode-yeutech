# AI 工作台 v3 本地交接

## 结论与交付边界
- **本地实现与本地 QA 已完成**；六张规定尺寸/主题截图及八张补充截图齐全。尚未上线，也不把本地 mock 视为真实模型、账号或 NAS 验收。
- 工作区：`/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/.worktrees/v3-agent`；分支 `v3/apple-redesign`；起点 `504d9dc22`。
- 仅修改定制前端 `deploy/yeutech-agent-isolated/web` 与 `qa-v3`。OpenCode 上游 `packages/*`、BFF/backend、原测试、`api.js`、鉴权与数据契约均未改。
- 未 push、未部署、未操作 NAS；未修改原 checkout、canonical 合同或其他合同消费者。
- 已读：仓库 `AGENTS.md`、隔离服务 README、design/integration-status.md、门户设计方向 v3 第二/五节、全站治理及门户 workspace.tsx/CSS。
- 本分支无独立命名的 UPSTREAM 文件；上游边界依据 README/CONTRIBUTING、隔离部署说明与 integration-status。旧白底三栏概念已废弃，以本次 v3 规范为准。

## 本地提交
- ad63e54cd：施工前功能清单与保留边界。
- 6c6593ee0：按职责拆分原工作台。
- d5f055177：v3 外壳、响应式导航、合同同步及拆分依赖补齐。
- 最后的 QA 提交保存本文、14张截图、验证脚本、JSON与通过日志。

## 完成改动
- 56px 第一方软件式顶栏：YEUTECH 首页、AI 工作台、连接状态、账户图标；原刷新动作移入账户菜单，不再占顶栏文字按钮。
- 平面不透明工作区、轻 chrome 目录、细分隔线、浅强调色选中行、克制的主操作；移除工具外壳壁纸和浮框阴影。
- 显示文字仅 34/22/17/15/13 五档；时间与数值采用 tabular-nums。手机部分按钮 font-size:0 仅隐藏可视文字，图标和 aria-label 均保留。
- 手机首屏为完整目录，点击会话推入正文；文件为全屏详情，关闭后回会话，再返回目录。修正手机工具栏固定高度遮挡操作与偏好项过窄；新建项目草稿成功后进入会话。
- 账户与外观仍由门户管理：菜单链接门户与 `settings/?site=agent`，未新增身份源或伪造账户名。

## 功能保留对照（实施前登记，实施后按证据更新）
| 既有能力 | 原入口 / 代码 | v3 保留方式 | 验证 |
|---|---|---|---|
| 独立会话新建、目录折叠、搜索、最近更新排序 | Sidebar / session-ordering.js | 同一事件与排序；macOS 目录行 | 本地 QA：搜索、切换；独立草稿创建为 browser fixture |
| 项目展开、切换、新建项目会话 | Sidebar / selectProject / createProjectSession | 原目录与事件保留 | 本地 QA：目录及切换；手机项目草稿创建为 browser fixture |
| 新建项目、扫描 NAS、接入、取消登记、重命名 | ProjectDialog / ProjectDiscoveryDialog / row menu | 原入口与弹窗保留 | 本地 QA：新建/扫描弹窗；接入/取消/重命名仅入口与源码保留，未执行 NAS |
| 会话重命名、Fork、删除 | SessionRow / RowMenu | 原菜单保留 | 本地 QA：三项菜单可达；变更请求未做真实后端验收 |
| 原会话历史、向上分页、刷新恢复、SSE 增量 | App / api.js / message-* | 只按职责移到 hooks，协议/顺序不变 | 本地 QA：历史显示、刷新与 SSE 审批/终态；分页与断线重连仅源码保留 |
| Markdown、表格、推理折叠、工具轨迹和终端命令/完整结果回读 | TimelineItem / TimelineTool / MarkdownText | 原渲染和回读保留；未新增交互终端 | 本地 QA：Markdown 显示；工具/终端回读组件源码保留，未穷举所有消息类型 |
| 模型选择、动态可用性、会话级持久偏好 | Conversation / changeModel | 原 select 与 API 不变 | 本地 QA：模型选择器显示；动态目录变动仅原逻辑保留 |
| Ultra 推理与 Ultrafast 响应速度独立偏好 | Conversation / changeReasoningEffort / changeServiceTier | 两个独立 select 保留 | 本地 mock：两次独立 PATCH、刷新读回；发送 payload 断言通过 |
| 权限模式、单次允许、拒绝、本任务全部允许 | PermissionCard / replyPermission | 原审批与鉴权逻辑保留 | 本地 mock：SSE 单次审批与移除；拒绝/全部允许源码保留 |
| 发消息、运行中补充、停止、错误恢复、中文 IME 防重复发送 | Conversation / send / stop | 原输入与执行链保留 | 本地 mock：发送/停止/终态恢复；运行中补充、错误与 IME 分支源码保留 |
| 文件浏览、搜索/排序/类型/隐藏项、上传/取消/重试/删除、拖入/粘贴、多附件 | FilePanel / UploadQueue | 原处理、受控路径和取消逻辑保留 | 本地 QA：浏览/搜索/附加；mock XHR 上传 201；取消/重试/拖粘/多附件源码保留 |
| 文本/图像/PDF/Office 预览、文件链接、放大/恢复 | FilePanel / FilePreviewContent | 桌面检查器，手机推入详情 | 本地 QA：Markdown 预览、放大/恢复；其他格式未穷举 |
| 会话文件变更、补丁预览 | DiffPanel | 原入口与读取保留 | 入口与原 DiffPanel/API 保留；本地空 diff fixture，未验收真实补丁 |
| 控制台、Goals、预算、工作图、子任务树、上下文收据、Replay | ControlCenter / AgentConsole | 原控制面弹窗保留 | 本地 QA：控制台、Goal 创建、高级预算/上下文；其余原组件保留 |
| 模型能力/Skills/Profiles、插件及项目开关 | CapabilityCenter / PluginCenter | 原入口及 API 保留 | 本地 QA：能力/Skills/Profiles 弹窗、插件入口；插件 fixture 为空，未验收真实启停 |
| 导出 Markdown、专注模式、侧栏折叠、双侧拖拽及键盘调宽、文件面板恢复 | App / PanelResizer | 同一事件保留 | 本地 QA：Markdown 下载、专注/侧栏、键盘调宽、文件放大恢复；指针拖拽源码保留 |
| 门户统一外观、系统明暗跟随、访问门户 | portal-appearance.js / 顶栏 | 合同不分叉；不透明工作区；YEUTECH 品牌链接 | 本地 QA：两主题、0/100 透明度、圆角0、减弱动态/透明度、高对比及链接 |
| 当前账户 | 原外壳无独立账户入口 | 顶栏加入门户账户链接，不新增身份源 | 本地 QA：账户菜单、链接目标及 Escape 关闭；无伪造账号或新鉴权 |
| 手机导航 | 原覆盖侧栏 | 同一 Sidebar 变首屏目录，选会话推入，可返回目录 | 本地 QA：两主题目录→会话→文件→返回；新项目草稿成功后推入会话 |


## 模块职责与拆分理由
原 App.jsx 2,068 行、styles.css 4,163 行，按本次≤600行硬规则拆分，避免把完整工作台重写为简化演示页。

| 模块 | 职责 |
|---|---|
| App.jsx（305行） | 原有状态、effect、布局装配与表现层导航 |
| workbench-header.jsx | 新顶栏与账户菜单，仅复用原刷新和门户链接 |
| workbench-bootstrap.js | 原 bootstrap/刷新主体（字节不变） |
| use-projection-events.js | 原 SSE 投影主体（字节不变） |
| workbench-actions.js | 原发送/停止/审批/项目/文件/导出处理主体（字节不变） |
| workbench-helpers.js | 原选择/宽度/文件作用域与存储辅助逻辑 |
| workbench-sidebar/conversation/timeline/files/dialogs/primitives | 原组件按职责归组；业务事件和 API 保留 |
| styles/01-foundation-shell.css…08-responsive-accessibility.css | 在完整规则边界拆分原有级联，统一五档字号 |
| styles/workspace-v3.css | v3 外壳、平面层级、目录与响应式覆盖 |

- 所有本次修改/新增代码文件≤600行（最长拆分 CSS 550行）。未改的 canonical 合同 CSS 686行不属于自行重写文件。
- `behavior-preservation.json` 与 `verify-preservation.cjs` 对照基线，确认 bootstrap、SSE、actions 主体字节一致；API、附件、Markdown、消息投影、滚动、会话排序与门户外观文件完全不变。
- 拆分时补齐 lexical 依赖注入，包含导出依赖 messages；已用真实 UI 下载验证导出。
- 终端能力仍是既有命令轨迹及完整结果回读；**没有新增原生交互终端**。

## 与门户规范的 fidelity 对照
| 规范依据 | 最终表现 / 证据 | 偏差处理 |
|---|---|---|
| 56px 顶栏、品牌入口、服务名、状态与账户 | 1440/2560 六图顶栏；账户菜单交互断言 | 刷新收进账户菜单，门户账户仍链接管理 |
| 工具工作区使用不透明 page，不消费壁纸 | DOM：::before display:none；stage box-shadow:none | canonical 保持完整，工具外壳只取消壁纸呈现 |
| 目录轻 chrome，正文 page，细分隔线 | 桌面两主题及文件检查器图 | 原卡片内容不删，仅削弱容器、阴影与装饰 |
| macOS 目录式浅强调选中行 | 桌面项目会话选中行 + aria-current | 不再使用竖条和浮框阴影 |
| 34/22/17/15/13 字号、等宽数值 | 六尺寸/主题及详情 computed-style audit | 隐藏文字的纯图标按钮为0px，非额外文字档位 |
| 手机目录→详情，文件全屏推入 | 390目录/会话/文件双主题六图与返回断言 | 两行工具栏取代旧固定高度，44px主要触点 |
| 全局圆角与透明度、系统可访问性 | square-min/max 两图及 CDP media 断言 | 不产生第二套全局设置，page始终不透明 |

## 验证结果
- 定制服务完整 `npm test`：**231/231 pass，0 fail**，详见 unit-tests.log。不是全仓上游测试。
- 前端 production build + postbuild：通过，production CSS 包含正式材质定义，详见 production-build.log。
- 三份合同 CSS/MJS/DTS 与门户 canonical **字节一致**，SHA-256 见 scope-verification.json。
  - 原分支 MJS/DTS 缺少 canonical 新增的 assistant 站点，仅通过官方 sync 脚本的隔离 --target 同步这两行；CSS 本就一致，未修改。
- Playwright 主 QA：26项通过，console/page errors均为空；详见 verification.json、browser-qa.log。
- 额外 runtime QA：7项通过；上传201、发送204、审批once、abort200与终态恢复均针对原本地 mock endpoint；详见 runtime-verification.json、runtime-qa.log。
- 页面身份、非空、无框架 overlay、横向溢出、字号与材质、交互结果均通过。
- Chrome headless；**Browser plugin not available**，本会话无 Browser skill/runtime，按允许的 fallback 使用已有 Playwright与系统Chrome，未安装/修改业务依赖。
- 最终 `git diff --check` 通过；范围/行数/主体保留检查见 verify-preservation.cjs。

## 截图清单
规定六图：
- 1440x900-light.png / 1440x900-dark.png
- 2560x1440-light.png / 2560x1440-dark.png
- 390x844-light.png / 390x844-dark.png（目录首屏）

补充八图：
- 390x844-light-conversation.png / 390x844-dark-conversation.png
- 390x844-light-files.png / 390x844-dark-files.png
- 1440x900-light-files.png / 1440x900-light-control.png
- 1440x900-square-min-accessibility.png / 1440x900-max-accessibility.png

均为本地展示夹具；并非线上用户数据。截图禁用动画，避免消息入场动画中的透明度影响静态比较。临时/伪before图已移除。

## 复现
从本 worktree 执行，需已有前端依赖、系统Chrome与Playwright：
```sh
ROOT="/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/.worktrees/v3-agent"
cd "$ROOT/deploy/yeutech-agent-isolated"
npm test
cd web
npm run build
# 独立终端1：每轮组合QA前重启mock，恢复初始审批与偏好
node mock-server.mjs
# 独立终端2（Vite preview复用配置中的本地API代理）：
npm run preview -- --port 18148 --strictPort
# 独立终端3：先主QA保存Ultra/Ultrafast，再runtime QA消费初始审批
cd "$ROOT"
export NODE_PATH="/Users/fangjialiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
node qa-v3/verify-workbench.cjs
node qa-v3/verify-runtime.cjs
node qa-v3/verify-preservation.cjs
git diff --check
```
其他机器将 NODE_PATH 换为已有 Playwright 所在 node_modules。可用 YEUTECH_V3_QA_URL 指定本地预览地址。
visual-fixtures.cjs 只补展示数据与旧mock未实现的界面endpoint；新建草稿是明确 browser fixture，不代表真实项目后端验收。

## 尚未验证 / 不应作出的结论
- 生产账号和跨站统一身份、真实模型调用、真实NAS文件/扫描/项目登记、正式发布均未执行。
- Office/PDF/图片等复杂预览格式、所有文件取消/重试/删除/拖粘分支、历史分页/断线恢复、真实插件启停及所有控制台高级动作没有穷举。
- 会话重命名/Fork/删除、项目登记等部分只验证入口与原实现保留；browser fixture的草稿不等于真实后端写入。
- 本地通过不是作者视觉接受、线上功能全量验收或部署完成。
