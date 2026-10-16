# AI 工作台 v3.3 · 首页同源设计语言本地交接

## 结果与边界
- **本地实现完成，服务测试、production build、Chrome 本地浏览器 QA 通过。**
- 仅在 `/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/.worktrees/v3-agent` 修改定制 web 表现层与本目录；基线 `6cb3667e8`，本次独立提交见 `git log -1`。
- 没有 push、部署、NAS、容器、代理切换或 robin/考研操作。生产域名、真实身份、真实模型与作者接受均未验证。
- 所有可复现浏览器内容明确使用本地 mock + presentation fixtures；不能称为真实后端、模型或设备验收。

## 规范提取与映射
只读参考：门户 `docs/plans/2026-10-16-统一设计语言v33.md`、`web/src/design-system/home-workspace.tsx`、`home-workspace.module.css`、`workspace.module.css` 的 `homeApp`。不改门户或材质合同。

| 原语 | 本地实现与精确值 |
|---|---|
| 顶栏 | `WorkbenchHeader`，sticky/top0/z30，56px、390px 为52px；横向32px、>=1800为48px、手机16px；无外阴影 |
| 品牌与动作 | YEUTECH 17px/650/-.02em、站名17px；返回门户、300px 搜索/44px触控（手机44px图标）、44px账户命中/32px本体；gap24/手机8；搜索底板伪元素inset6px0；顶部图标1.75线宽 |
| 横向栏目 | 原目录/对话/文件/任务状态处理器；44px、15px、gap4，当前项`--yt-layer-control` + `--radius-control`；只导航本身横向滚动；不再固定底部 |
| 主容器 | max2400px居中、padding32px/宽屏48px/手机28px16px与safe-area |
| 标题 | 单一h1，34px/650/1.25/-.035em；副标题17px/1.5、mt12px，手机15px；状态保留真实bootstrapping/error/modelCount |
| 主体与右辅栏 | 200px/gap32；<=1200为175px/gap24；>=1800为240px/gap40；<=760下置 |
| 任务内容 | 目录与对话为同级surface；卡片标题22px/600，正文15px、注释13px；对话header/composer padding24，手机20；任务目录保留可调300px默认宽、搜索、层级与密度，不再带站点身份/账户 |
| 多面板 | 原目录/对话/文件检查器并行、关闭/放大/附加、键盘调宽保留；desktop打开文件时暂时让出右侧辅助栏空间，不压窄编辑器；手机文件抽屉从68px开始，标题/关闭不被52px顶栏遮挡 |
| 材质 | page壁纸；顶栏chrome；目录/对话/desktop文件为兄弟surface；内层卡/条目material、字段control；浮层overlay+dim；直接/祖先无嵌套backdrop-filter |

合同唯一真源是门户 `frontend/design/yeutech-material-contract.{css,mjs}`；本消费者三份CSS/MJS/声明文件与canonical SHA一致，无合同diff。新CSS只消费合同色彩/圆角/模糊tokens，不复制计算。

## 修改文件
- `deploy/yeutech-agent-isolated/web/src/App.jsx`：只重排表现层、接入顶栏与辅助列、搜索复用原目录输入，不改原状态/业务action。
- `deploy/yeutech-agent-isolated/web/src/workbench-header.jsx`：顶部身份/返回/搜索/账户、横向栏目、辅助列。
- `deploy/yeutech-agent-isolated/web/src/workbench-sidebar.jsx`：移除站点身份注入，任务目录h2；搜索Escape返回顶部触发器。
- `deploy/yeutech-agent-isolated/web/src/styles.css`：最终cascade从v32切换到v33。旧v32文件和历史QA保留，不删除已有工作。
- `deploy/yeutech-agent-isolated/web/src/styles/workspace-v33.css`：同源geometry与七层映射。

## 验证
The flow under test is: local production app loads -> directory/conversation/file/task controls operate -> original local mock requests/events and rendered state remain usable.

Browser plugin/skill not available；`agent-browser` CLI也未安装。按frontend-testing-debugging使用已有Playwright + 系统Chrome，无依赖/lockfile变更。

| 检查 | 结果与证据 |
|---|---|
| 全量服务测试 | `npm test`，231/231，0失败/跳过；`unit-tests.log` |
| 构建与合同production产物 | `npm run build`成功；原postbuild检查产物CSS实际包含合同定义、JS挂载page壁纸；`production-build.log` |
| typecheck | 此独立定制web为JS/JSX，无typecheck脚本或TS项目；不虚报通过。Vite完成实际JSX编译。未运行无关上游OpenCode单体包typecheck |
| 业务/测试保留 | API、bootstrap、SSE投影、actions、原conversation/files/dialogs/timeline等15模块字节一致；40原测试文件字节一致；`scope-verification.json`、`preservation.log` |
| 几何与材质 | 1440/2560/390计算样式实测56/52、32/48/16、44/15/gap4、34/650/42.5/-.035；max2400、200/240右栏；单h1，无横溢/嵌套blur；`home-language-verification.json` |
| 页面健康 | title/URL身份正确、非空、无framework overlay、无pageerror/console error；`verification.json` |
| 交互 | 搜索/会话菜单；Ultra+Ultrafast独立PATCH与刷新读回；模型能力/插件/Skills；控制台目标/高级信息；文件搜索/Markdown/放大恢复/附加；Markdown导出；专注/目录收起/键盘调宽；账户菜单；`browser-qa.log` |
| 搜索顶部入口 | 点击与Ctrl+K都聚焦既有搜索；Escape焦点还原；`home-language-qa.log` |
| 手机 | 同一任务组件；目录→对话→文件→返回、任务状态浮层、新项目草稿推入；无新固定底栏；输入/发送第一视口内可见；`verification.json`、`runtime-verification.json` |
| mock执行链 | 上传201→附件引用→发送204含Ultra+Ultrafast+附件→运行态→SSE单次审批→停止abort→终态；`runtime-qa.log`。未调用真实模型 |
| 边界 | radius0、全部opacity0/100，reduced-motion/transparency、high-contrast；对应截图及`verification.json` |
| 空态/异常 | 空工作区与bootstrap503均保留标题/栏目/原错误说明，无app异常；`state-verification.json`、`states-qa.log` |
| 范围 | 仅5个表现层文件+本目录；修改源码<=600行；`git diff --check`通过 |

### 路由/视图覆盖
独立前端为同一入口 `/`，通过原状态呈现：项目/会话目录、对话、文件列表/预览/放大、任务状态、能力/插件、创建项目、NAS发现、账户菜单、独立/项目草稿、权限审批、空态/连接异常。不是把这些视图伪装成新增URL路由。原API路径/鉴权代码字节保留；原mock请求检查不等于生产读写验证。

### 视觉差异台账
- 已纠正v3.2的站点左侧全高浮动壳：身份与账户回到连续顶栏，栏目回到横向，原底部导航移除固定定位。
- 任务内目录树仍保留，这是规范明确允许的多层级业务内容，不是站点壳；300px可调宽、目录卡内横向紧凑padding保留，避免丢失项目操作。
- 保留长对话/编辑器内部滚动与多面板，不强制改成首页概览三卡；没有创造指标、删会话行或删测试。
- 手机文件标题遮挡在截图人工复查中发现并修复；回归增加`fileHeader.y>=52`断言。
- 本任务未修改门户首页或其他站点，未在本工作树复跑门户首页基线截图；主控负责跨站对照。

## 截图
- `1440x900-light.png`、`1440x900-dark.png`
- `2560x1440-light.png`、`2560x1440-dark.png`
- `390x844-light.png`、`390x844-dark.png`（目录）
- `390x844-light-conversation.png`、`390x844-dark-conversation.png`
- `390x844-light-files.png`、`390x844-dark-files.png`
- `1440x900-light-files.png`、`1440x900-light-control.png`
- `1440x900-square-min-accessibility.png`、`1440x900-max-accessibility.png`
- `1440x900-empty.png`、`1440x900-failed.png`

## 复现
从本工作树执行：
1. `npm --prefix deploy/yeutech-agent-isolated test`
2. `npm --prefix deploy/yeutech-agent-isolated/web run build`
3. 独立临时进程启动`web/mock-server.mjs`（18141）与`npm run preview -- --port 18148 --strictPort`，不重启现有服务。运行一次性SSE审批QA需要全新临时mock。
4. 设置`NODE_PATH=/Users/fangjialiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`，顺序运行本目录`verify-workbench.cjs`、`verify-runtime.cjs`、`verify-home-language.cjs`、`verify-states.cjs`、`verify-preservation.cjs`。
5. mock偏好可跨浏览器上下文留存；首次发送链路在`verify-workbench`设置Ultra/Ultrafast后执行。截图壁纸从门户本地public路径响应，不改线上路径。

## 未验证
真实生产登录/权限角色、真实模型/项目写入、NAS、真实断线重连、所有Office/PDF/图片内容、真机Safari与发布后资源/缓存均未验；原实现保留不等于这些验收已通过。没有部署、线上完成或作者采纳声明。

## 补充核查：PageShell 壁纸（2026-10-16）
- 复核门户`primitives.module.css`第2、57行发现：本服务首版只恢复了合同壁纸显示，缺少PageShell专有的滤镜/缩放覆写。
- 仅在`workspace-v33.css`的page伪元素补齐`filter: blur(var(--yt-blur)) saturate(40%)`、`transform: scale(1.04)`，并在`prefers-reduced-transparency:reduce`下设`filter:none`；没有修改合同或业务。
- 1440/2560/390实测默认`blur(14px) saturate(0.4)`、`matrix(1.04,0,0,1.04,0,0)`；减少透明度均为`none`。证据在`home-language-verification.json`的wallpaper/reducedWallpaperFilter字段。
- 重建production并刷新全部主题/视口及边界截图、原浏览器交互回归通过；此补充未改业务，不重复跑不相干服务测试。
- 账户菜单与辅助栏外观链接均已是`https://yeutech.cn/settings/?site=agent`，无需修改。


## 2026-10-17 线上巡检修复（本轮未发布）

- 账户头像改为真实bootstrap门户身份的用户名首字符大写；BFF只增加已认证`user.username`，不从本地猜身份或硬编码L，无身份时显示`?`。现有鉴权/工作区隔离不变；BFF测试核对真实fixture账号ryan，浏览器mock另用lucian验证L。
- “会话与项目”复用统一目录入口：退出专注、收起文件、展开已收起项目栏并聚焦原搜索框；“文件”和“任务状态”复用原handler并把焦点送入对应面板，滚动遵守减少动态偏好。手机文件抽屉仍需原关闭按钮返回，不绕过遮罩。
- 验证：isolated服务`npm test`231/231（未在上游仓库根运行测试）；定制web production build及最终合同检查通过；canonical同步仅target本树web/src/design，无合同diff。
- Browser plugin not available，Playwright+Chrome使用本地mock18141、production preview18149。1440/2560/390×light/dark六组：账户首字母、收起后目录展开与焦点、文件/任务面板焦点、返回目录、无横溢/pageerror均通过；截图`/tmp/yeutech-oct17-qa/agent-*.png`。实际生产身份与线上路径仍待主控发布后检查。
- 没有修改上游packages/app、会话持久数据或执行协议；没有push、NAS部署、代理/现有服务重启、考研操作。本次临时本地mock不是生产服务。

- 本轮补验：1440桌面与390×844手机，各覆盖radius0/alpha0、alpha100、减透明和高对比（全部减动态），共8组，页面/任务面板无横溢，圆角0与无blur状态正确。仅本地production preview+fixture，不代表线上。新截图、结果、复现脚本及测试/构建日志在 `regression-20261017/`，未覆盖旧验收记录。
