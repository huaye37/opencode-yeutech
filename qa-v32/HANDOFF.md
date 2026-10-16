# AI 工作台 v3.2 玻璃化本地交接

## 结果与边界
- 本地实现、production build、本地Chrome QA通过。未push、未部署、未操作NAS/容器/CLIProxyAPI，未触碰robin/考研。
- 仅改定制web表现层和qa-v32；上游packages、BFF、接口、鉴权、业务数据、原测试均不改。
- worktree：`/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/.worktrees/v3-agent`
- 分支`v3/apple-redesign`，起点`385702dd5`。本服务唯一施工提交可由`git log -1`读取。
- 所有浏览器交互使用本地mock+明确展示fixture，不代表真实模型、账号、生产会话或NAS验收。

## 完成
- 恢复门户合同yt-page壁纸层；左浮动chrome玻璃侧栏+右满宽surface玻璃会话窗，互为兄弟，无嵌套模糊。
- 删除全局顶栏；品牌、唯一站点名、连接状态和账户/外观/重新同步入口移入侧栏。
- 保留唯一会话标题与原变更/控制台/导出/专注/文件操作行；该会话上下文行并非重复站点顶栏。
- 内容窗口内部卡片/工具/列表使用material，输入和选择器用control，文件检查器与对话框用overlay+dim。所有色彩、圆角、模糊均消费合同token。
- 手机四底部标签：会话与项目、对话、文件、任务状态；直接复用既有可见性/文件/控制台处理器。
- 会话/项目管理、搜索、独立模型偏好、权限、发送/停止、消息投影、文件/附件、导出、拖拽及键盘调宽保留。
- 新CSS102行，修改/新增代码文件≤600行；字号仅34/22/17/15/13，原手机图标控件font-size:0仍保留aria-label。

## 真源与设计参考
- canonical：`/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/yeutech-home-platform/frontend/design/yeutech-material-contract.{css,mjs}`。
- 执行`sync-material-contract.mjs --target <本worktree/web/src/design>`，只同步本消费者；CSS/MJS/声明文件和真源字节一致，因此未产生合同Git diff。canonical和其他消费者均未改。
- 参考门户web/src/design-system/workspace.module.css与shell；已用view_image查看`../portal-v32-unify/docs/plans/design-2026-10-15/qa/v32/after/members-approved-1440-light.png`及本地桌面浅/深色、390会话与文件截图。
- 本次沿用用户指定的既有设计系统，无另行生成概念。Browser插件/技能未提供，按frontend-testing-debugging使用既有Playwright+系统Chrome。

## 验证
| 检查 | 结果/证据 |
|---|---|
| 服务测试 | 231/231，unit-tests.log |
| production build | Vite成功；postbuild确认最终CSS含合同定义、JS挂载壁纸，production-build.log |
| 合同/范围 | 三合同SHA一致；仅web+qa-v32、代码≤600，scope-verification.json / preservation.log |
| 业务保留 | bootstrap/SSE/actions主体与旧已验基线字节一致；API/附件/Markdown/投影/滚动/排序/外观全文件一致，behavior-preservation.json |
| 视口/主题 | 1440x900、2560x1440、390x844，light/dark；无横溢、页面身份正确/非空/无framework overlay，verification.json |
| 原交互 | 搜索、会话菜单、模型独立偏好PATCH/刷新读回、能力/插件/Skills、目标/高级信息、文件搜索/Markdown/放大恢复/附加、导出、专注/侧栏/键盘调宽、账户菜单，browser-qa.log |
| 手机 | 底部目录/对话/文件/任务状态；目录→对话→文件→返回；手机项目草稿进入对话 |
| mock执行链 | 上传201→附件引用→发送204含Ultra+Ultrafast+附件→运行态→SSE单次审批→停止/abort→终态同步，runtime-verification.json |
| 新建fixture | 独立草稿/项目新建/NAS发现弹窗/手机项目草稿；不是后端写入验收 |
| 计算样式 | 1440/390无嵌套backdrop-filter；composer不模糊、会话头透明、全局顶栏0、stage maxWidth none，glass-verification.json |
| 边界 | 圆角0、全部透明度0/100、减弱动态/透明度、高对比，verification.json+accessibility截图 |
| 错误 | 无pageerror/console error；git diff --check通过 |

### 视觉比对台账
| 比对点 | 本地修复/保持 |
|---|---|
| 壁纸/明暗 | 恢复同一合同图片与背景opacity；本地1440浅深色可见 |
| 浮动窗/导航 | 门户同款兄弟玻璃窗，移除灰底舞台与全局顶栏 |
| 满宽 | 2560截图与computed maxWidth none；不设窄中心消息栏 |
| 字体/图标 | 五档计算字号；复用已有Icon，不增装饰图标或营销文案 |
| 层级 | 材质/控件从合同取值，无嵌套模糊；列表/设置在玻璃窗口 |
| 手机 | 四标签同一业务组件；390会话/文件输入与检查器无横溢 |

有意差异：保留原300px可调侧栏而非强制门户240px；保留会话上下文操作与执行状态行，不为视觉移除功能。首屏文案沿用原站点/会话/CTA，只新增用户要求的底部导航标签。对指定门户玻璃语言完成本地忠实性检查，未发现本次待修材质或裁切问题。

## 截图（均在此目录）
- 1440x900-light.png / dark.png
- 2560x1440-light.png / dark.png
- 390x844-light.png / dark.png（目录）
- 390x844-light-conversation.png / dark-conversation.png
- 390x844-light-files.png / dark-files.png
- 1440x900-light-files.png / light-control.png
- 1440x900-square-min-accessibility.png / max-accessibility.png

## 复现
从本worktree：deploy/yeutech-agent-isolated下`npm test`；web下`npm run build`。
分别启动临时`node mock-server.mjs`及`npm run preview -- --port 18148 --strictPort`。
从worktree根，设置`NODE_PATH=/Users/fangjialiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`，依次执行qa-v32/verify-workbench.cjs、verify-runtime.cjs、verify-glass.cjs、verify-preservation.cjs。
首次完整QA使用全新临时mock（审批一次性），不要重启生产。截图脚本用canonical门户本地public壁纸文件响应本地图片请求，不改生产路径。

## 未验证
- 未发布：线上域名/缓存/真实身份/真实模型/NAS和生产浏览器验收由主控另行完成。
- 未穷举全部消息格式、Office/PDF/图片、真实项目管理写入、真实断线重连；对应实现字节保留，不宣称本轮验收。
- 定制web未定义typecheck/lint脚本；完成production JSX编译、计算样式审计、服务测试和浏览器回归。未安装依赖/改lockfile。
