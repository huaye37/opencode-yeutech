# YEUTECH AI 工作台集成状态

更新时间：2026-09-13

本文件只记录已由代码或运行态证据确认的能力。OpenCode 已提供但门户界面尚未接入的接口，不标记为“已完成”。

## 统一模型目录目标

```text
CLIProxyAPI /v1/models
        │ 发现当前账号和渠道实际暴露的模型 ID
        ▼
CLIProxyAPI /v1/model-capabilities
        │ 合并上下文、输入/输出上限、模态和可选状态
        ├── AI 工作台 /api/models
        ├── 考研 /api/system/models
        ├── 小说工作台 /api/models
        └── API 管理平台模型目录
```

- 新 ID 必须先显示。能力不完整时保留在目录中，但 `selectable=false`，不能进入执行链。
- `context_length <= 0`、输出上限缺失、模态不兼容或本地运行态隔离的模型不能执行。
- 公共目录的 `ready/selectable` 只表示静态能力完整，不代表某个 OAuth/API 账号在 OpenCode 链路中已经实测可用。
- 单型号运行失败只隔离该型号；不能隐藏其他型号，也不能让整个 Worker 或目录不可用。
- 模型目录变化只允许空闲 Worker 重载，不能中断活跃会话。

当前隔离工作树统一消费 `/v1/model-capabilities`。下文把本地质量门、NAS 运行态、真实模型、LAN UI、公网入口和旧 Codex 分开记录，避免把某一层通过扩大成其他层通过。

## 当前工作台能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 门户登录与模块权限 | 已接入 | `agent.yeutech.cn` 由门户验权并注入短期签名身份。 |
| 用户会话/SQLite 隔离 | 已部署并验收 | 每个 immutable portal user id 映射独立 workspace、Worker 和数据库；Ryan UI 为 11 个独立会话，Lucian UI 只显示自己的 1 个会话。 |
| `system:kaoyan` 隔离 | 已接入 | 使用独立 token、workspace、任务库和 OpenCode Worker。 |
| 动态模型目录与执行前校验 | 已接入 | 能力不完整型号可见但禁用；执行前再次校验。 |
| 项目与历史会话恢复 | 已部署并验收 | Ryan/Lucian 的 final-v6 会话均在刷新后的 LAN UI 恢复出真实提示与回复；原 workspace 与 runtime DB 保持挂载。 |
| 宿主项目根定位 | 已部署 | Compose bind source 由限定父目录下的唯一 `spaceId` marker 解析；运行容器实际挂载 `/volume2/codex项目空间:/projects:rw`。 |
| 会话持久化、刷新恢复 | 已接入 | 由租户独立 OpenCode 数据目录持久化。 |
| 消息历史分页 | 已接入 | 首屏及向前读取均使用 cursor 分页，避免大上下文拖垮前端。 |
| SSE、停止、恢复 | 已部署并验收 | 版本化投影事件持久化到 SQLite；真实 SSE 观察到 `ready`、`ephemeral`、`durable`，长生成停止返回 200；LAN UI 恢复出 `MessageAbortedError`。 |
| 每用户并发治理 | 已部署并验收 | 原“先查询再提交”竞态已改为原子占位；同会话并发、Worker 容量、超时和错误均为稳定类型，自动化回归已覆盖。 |
| 项目文件浏览 | 已部署并公网验收 | 公网登录态已打开 Lucian 的真实 NAS 项目 `Agent工作台`，进入目录、浏览 `附件` 子目录并预览文本正文；符号链接逃逸防护由 BFF 回归覆盖。 |
| 附件上传 | 已部署并公网验收 | 公网登录态分别向独立会话受控目录和 `Agent工作台` NAS 项目目录上传真实文本文件，均显示“已上传并附加”，正文预览正确；两份验收文件随后通过 UI 物理删除并确认目录为空。 |
| 工具审批 | 已部署，自动化验收 | 门户按用户过滤 pending permission，仅允许 once/reject，UI 有明确审批卡；本轮真实会话未触发权限请求。 |
| diff / todo / fork / summarize | 部分完成 | todo 与 summarize 已有可见入口；diff/fork 仍是受控后端能力，未伪装为完整页面。 |
| Goal/Plan 面板 | 已部署并验收 | OpenCode todo 作为本轮计划；LAN UI 创建 Goal 后从 revision 1 更新为 complete/revision 2，SQLite Goal 使用用户/scope 隔离与 revision CAS。 |
| 子 Agent 活动 | 已部署 | 投影提供父子树、状态和完整轨迹入口；本次真实会话没有子 Agent，UI 正确显示空树，递归树由自动化测试覆盖。 |
| Skills/插件能力 | 已部署并验收 | LAN 能力中心只读展示 Worker Skills；不提供浏览器任意安装或修改。 |
| 详细轨迹/统计 | 已部署并验收 | Ryan LAN UI 显示 2 轮 Turn Outline、4 条完整轨迹、输入/输出统计、Work Graph 和 Evidence Gate；大工具结果裁剪及受控回读由自动化测试覆盖。 |
| Context Pack / Replay / Runtime Budget | 已部署并验收 | LAN 控制面成功生成 Context Pack hash、捕获并比较 Replay 基线；Budget 显示 1/19 个交互 Worker且在预算内。 |

## 考研系统身份

考研不是匿名浏览器用户，也不复用 Ryan/Lucian 的数据。它使用固定服务身份 `system:kaoyan`，业务服务端负责：

- 根据题目 ID 读取可信题干、标准答案、评分规则与学习上下文；
- 为学习助手、批卷和题目解析生成不同的 `kind` 与稳定 `sessionKey`；
- 调用 system task API，并向浏览器转发有界结果和状态；
- 保证浏览器不能提交任意 workspace、系统 token、标准答案或评分规则；
- 对空模型回复按失败处理，不能伪装成 `completed`。

## DSH 移植取舍

优先移植用户能直接感知、且不会重新引入单点大上下文问题的能力：工具审批、todo/plan、父子任务活动、附件、按需轨迹。DSH 的插件运行时、内部 Typert RPC、上下文数据库和整套前端不直接移植；Agent 执行、会话压缩和恢复继续由 OpenCode 负责，YEUTECH 只实现稳定的 BFF 与门户展示层。

## final-v9 发布与验收证据

### 本地质量门

- `npm test`：117/117 通过。
- `npm --prefix web run build`：通过。
- 全部 JavaScript/MJS `node --check` 与 `git diff --check`：通过。
- 发布包 83 项；不含 `.env`、`.runtime`、`node_modules`、`PaxHeader`、`._*`。

### NAS 运行态

- 镜像：`yeutech-agent:20260913-final-v9`。
- 发布包：`/tmp/yeutech-agent-20260913-final-v9.tgz`。
- 发布包 SHA-256：`5b177b542761c318065172ac7e0e8021dc0af20e6bd66114b777fb286af1b9ad`。
- DSM 构建、重建、启动均 Exit Code 0；容器持续显示“良好”。
- `/health` 连续 10 次成功，本轮收尾再次返回 `{"ok":true,"workerMode":"dynamic"}`。
- supervisor `ready=true`、system worker 为 `system-kaoyan`；migration source 为 `local-read-only-snapshot`。
- 目录实际返回 39 个模型、29 个可选模型。

### 真实模型与公网 UI

- Ryan 会话 `ses_f671836c3ffeJrc0JA7oNCwr4T` 使用 `gpt-5.6-sol`，真实回复 `RYAN_FINAL_V6_OK`。
- Lucian 会话 `ses_f671739bfffeGp7ZA2YFRfiLdor` 使用 `gpt-5.6-sol`，真实回复 `LUCIAN_FINAL_V6_OK`。
- Chrome 在 `https://agent.yeutech.cn/` 的 Lucian 登录态真渲染通过；页面显示 1 个独立会话、`Agent工作台` NAS 项目和 29/39 个模型，无相关 console error/warn。
- 公网 UI 已创建并进入 `Agent工作台` 的真实项目会话；项目文件面板固定绑定该项目目录。
- 公网 UI 已完成独立会话上传、项目目录上传、附件队列、文本正文预览、附加到输入区和 UI 物理删除；验收文件清理后两个目录均为空。
- 390×844 CDP 设备仿真下 `innerWidth=390`、`documentElement.clientWidth=390`、`documentElement.scrollWidth=390`；文件面板宽 374、左右边界 8/382，移动菜单和文件面板均可操作，无横向溢出。

### 公网与旧服务边界

- 未登录访问仍由门户网关保护；本轮同时使用现成 Lucian 门户登录态完成了公网 Agent UI、项目和附件全链路验收。
- 旧 `http://192.168.100.216:18110/health` 本轮仍返回 `ok=true`；没有重启或修改 18110。
- `https://codex.yeutech.cn/` 未登录入口仍返回 303 到原 Yeutech 登录网关；这只证明入口与旧服务健康，不等于登录后旧 Codex UI 的本轮全量回归。

## final-v10 加载态与兼容修复

### 修复内容

- 首屏初始化不再用空数组渲染成“0 个项目 / 0/0 模型 / 服务已连接”；统一显示正在同步工作区，并在数据返回前禁用新建、扫描、搜索、模型和控制台操作。
- 初始化失败时显示真实错误和“刷新状态”恢复入口，不把失败伪装成空工作区。
- 兼容线上既有的有界模型能力目录：只有 `ready/complete`、可选择且具备有效上下文/输出上限的旧契约条目才保守映射为 text-only；不根据模型名猜测图片或音视频能力。
- 兼容已经处于用户隔离目录内的旧 `ownerKey` 项目标记，保留原项目 ID；跨用户、无有效 ID 或伪造标记仍拒绝。
- NAS Compose 命令固定 `-p yeutech-agent`，避免 CLI 与 DSM Container Manager 项目名不一致导致固定容器名冲突。

### 质量门与运行态

- `npm test`：119/119 通过。
- `npm --prefix web run build`、全部适用的 `node --check`、shell 语法检查与 `git diff --check` 通过。
- 镜像：`yeutech-agent:20260913-final-v10`；容器仅重建 `yeutech-agent`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260913-final-v10.tgz`，78 项，SHA-256 `81184ce1aa482e392800ba5c8318561e6e0fff46c9214213046def220e584ce5`。
- NAS `18140/health` 返回 `{"ok":true,"workerMode":"dynamic"}`；旧 Codex `192.168.100.216:18110/health` 同时保持 `ok=true`。

### 公网浏览器验收

- Chrome 登录态在 2500ms 网络延迟下，首屏只显示“正在加载你的工作区 / 正在同步模型、会话和 NAS 项目”，没有出现 0 项目、0/0 模型或假连接状态；初始化前相关操作全部禁用。
- 数据返回后显示 Ryan 的 11 个独立会话、4 个真实 NAS 项目和 30/40 个模型；console error/warn 为空。
- 旧项目 `Codex工作台功能验收_20260829` 可展开到 3 个历史项目会话；“文件与附件”可读取真实根目录，并提供启用的多文件上传控件。
- 390×844 下加载态明确，完成后 `innerWidth=390`、`clientWidth=390`、`scrollWidth=390`，无横向溢出，console error/warn 为空。

## final-v12 附件删除状态闭环

### 修复内容

- 从文件面板物理删除上传文件后，按文件空间与相对路径同步清除输入框内的全部对应附件引用；项目间或独立会话间的同名文件不会被误清除。
- 删除动作不会再次调用后端，避免输入框引用清理造成重复物理删除。
- 上传队列记录保存服务端实际返回路径；物理删除后，“已上传并附加”的完成状态也同步消失，不再显示悬空成功提示。

### 质量门与运行态

- `npm test`：122/122 通过；包含项目附件引用、独立会话同名隔离与上传队列状态三项回归。
- `npm --prefix web run build`、适用的 `node --check`、shell 语法检查与 `git diff --check` 通过。
- 镜像：`yeutech-agent:20260913-final-v12`；Image ID `sha256:41e8555fad2f96de4a0d25fc2e51df53d69282eec94a56ffe5c000b396780ab0`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260913-final-v12.tgz`，80 项，SHA-256 `7c8e8604fcedb1fdfc86679c7bc93c6d979568c3dd15c7e6f0377071df178cfa`。
- 只重建 `yeutech-agent`；NAS `18140/health` 返回 `{"ok":true,"workerMode":"dynamic"}`，旧 Codex `192.168.100.216:18110/health` 同时保持 `ok=true`。

### 公网浏览器验收

- Chrome 登录态在 `https://agent.yeutech.cn/` 上传真实文本文件，文件选择器确认 `multiple=true`，页面出现“已上传并附加”、输入框附件标签和“1 个附件”。
- 从文件面板进入 `附件` 目录并删除后，文件行、输入框附件标签、“1 个附件”和上传队列完成状态均为 0；页面显示“当前目录为空”，console error/warn 为空。
- Ryan 登录态刷新后显示 11 个独立会话、4 个真实 NAS 项目和 30/40 个模型；旧项目 `Codex工作台功能验收_20260829` 仍可读取 `.codex-report-qa`、`附件`、HTML、XLSX、README 与 DOCX 等真实目录内容。

## final-v16 用户文件目录收敛

### 目录规则

- 项目会话继续只使用各自项目目录，不复制项目文件，也不把独立会话目录登记为项目。
- 每个门户用户的所有独立会话共用一个可见的 `用户目录/独立会话/` 文件夹；上传文件仍进入其中的 `附件/` 子目录。
- 旧 `.独立会话附件/` 隐藏树不再参与运行时查找。本次没有迁移、覆盖或删除其中的历史文件。

### 质量门与运行态

- `npm test`：124/124 通过；前端生产构建、JavaScript/MJS 语法、shell 语法与 `git diff --check` 均通过。
- 镜像：`yeutech-agent:20260913-final-v16`；Image ID `sha256:e79e4b99f1313880e2a8d70edc4e0e45ac999cfb9117d24987f14b2bda3cfc17`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260913-final-v16.tgz`，80 项，SHA-256 `d4c1cb53c1e31a3e8d6e0c0e299d1bcc69fa57ac00b827ab22de80e52b5c044e`。
- 回滚源码：`/volume1/docker/yeutech-agent/source-final-v15-20260913-191143.rollback`。
- 容器为 `running / healthy / restarts=0`；NAS `18140/health` 与旧 Codex `192.168.100.216:18110/health` 均正常。

### 公网浏览器验收

- Chrome 登录态刷新后，独立会话文件面板明确显示“独立会话文件”和“这里的文件由你的所有独立会话共用”。
- 用户级 `独立会话` 文件夹没有混入左侧项目列表；项目仍只有 4 个真实 NAS 项目。
- 真实文本文件已在新目录中完成列表显示、打开、正文预览、下载和“附加到对话”入口检查；验收文件随后已从 NAS 和本地清理，线上目录恢复为空。
- 页面无框架错误覆盖层，浏览器 console error/warn 为空。

## final-v18 可调目录与项目操作区

### 界面调整

- 项目展开后的“新建会话 / 项目文件”整行工具条已移除，两个操作收进项目标题右侧的轻量图标区，不再打断会话列表。
- 独立会话改为可展开、收起的文件夹结构；搜索时自动展开，普通状态与刷新后保留用户上次选择。
- 桌面端项目目录宽度支持鼠标拖动和键盘方向键调节，范围 `220–420px`；项目文件面板同样支持调节，最小 `360px`，并为中间会话区保留可用宽度。
- 两侧宽度写入浏览器本地存储；窄屏继续使用抽屉/全屏文件面板，不显示拖拽条。

### 质量门与运行态

- `npm test`：124/124 通过；前端生产构建和 `git diff --check` 通过。
- 镜像：`yeutech-agent:20260913-final-v18`；构建短 ID `3d7ef3b89767`。
- 回滚源码：`/volume1/docker/yeutech-agent/source-final-v17-20260913-1958.rollback`。
- NAS `18140/health` 返回 `{"ok":true,"workerMode":"dynamic"}`；旧 Codex `192.168.100.216:18110/health` 同时正常。

### 公网浏览器验收

- Chrome 登录态在 `https://agent.yeutech.cn/` 实际收起、展开独立会话，并刷新确认状态保留。
- 项目目录和项目文件分隔条均完成鼠标拖动与键盘方向键调节；打开项目文件后刷新，保存的宽度仍生效。
- 项目标题右侧“新建项目会话”和“浏览项目文件”具备独立可访问名称；点击文件操作能打开当前项目真实目录。
- 页面无横向溢出，浏览器 console error/warn 为空。

## final-v19 核心能力闭环

- 删除源码默认模型 ID；默认型号只来自部署配置或动态可执行目录。
- 项目附件提交由服务端重新校验，生成并注入 Context Receipt，同时写入 durable projection。
- 普通会话准入使用跨进程文件锁和 activity lease 原子占位；同会话重复提交与 Worker 超限返回稳定错误码。
- 运行兼容性按 `workload + modelId` 记录；单次空结果只降级，连续失败达到阈值才隔离。
- Replay Lab 使用租户隔离 SQLite 任务库，在隐藏隔离目录真实执行最近一轮，并明确区别于指标快照比较。
- 项目栏、会话区和文件预览分别设置错误边界，单个渲染错误不会使整个工作台白屏。
- 本地质量门：`npm test` 126/126、前端生产构建、JavaScript/MJS 语法与 `git diff --check` 通过。

## final-v20 工作台交互与真实回放闭环

### 实现状态

- 项目展开、活动项目和活动会话已解耦；项目标题只负责展开/收起，多个项目可同时展开。
- 项目与会话支持重命名，项目支持取消登记与重新登记，取消登记只更改服务端偏好状态，不删除 NAS 目录。
- 会话 Fork 和 Diff 已由真实 BFF 接口接入页面；Diff 面板展示文件状态、增删统计和逐行 patch，不再是“受控后端能力”。
- 未登记 NAS 目录进入独立发现流程；普通点文件由“显示隐藏文件”控制，系统噪声文件始终隐藏。
- 独立会话继续共用用户目录下的 `独立会话/`，工作台中可像文件夹一样收起；项目栏与文件栏均可调宽度。
- HTML/SVG 按源码文本预览，文件响应明确返回原始 MIME、预览类型和下载策略。
- Replay Lab 改为 Worker 实时工具目录驱动的 deny-by-default 策略：只允许 `read/glob/grep/list/lsp`，执行后对轨迹审计，越权工具稳定返回 `replay_policy_violation`。

### 自动化与发布证据

- 本地 `npm test`：137/137 通过；前端生产构建、全部 JavaScript/MJS 语法、shell 语法与 `git diff --check` 通过。
- 镜像：`yeutech-agent:20260913-final-v20`；Image ID `sha256:fe8152da62a434b34f70fe3232e56a6c5520f340827b28ca3182dcd96e5ef6f8`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260913-final-v20.tgz`；SHA-256 `f9819db4d0979f89e8055045a31d10c4a44c43eed589a2de63fb727ac2f18da3`。
- 回滚源码：`/volume1/docker/yeutech-agent/source-final-v19-20260913-pre-v20.rollback`。
- SSH 运行态：容器 `running / healthy / restarts=0`，`18140/health` 正常；旧 Codex `192.168.100.216:18110/health` 同时正常，未修改或重启。
- SSH 真实 BFF 探针返回契约 `2026-09-13.4`、4 个已登记项目、3 个会话、40 个型号（其中 30 个可选），文件与 Diff 接口均返回 200。

### SSH 真实端到端验收

- 在 Ryan 用户空间内用唯一名称临时创建验收项目和会话，验证项目/会话重命名、附件上传、目录列表、文本预览、刷新恢复、Fork、Diff、取消登记与重新登记。
- 同一会话的两次并发提交实际返回 `204 + 409`，409 错误码为 `session_busy`，原子占位已在真实 Worker 链路生效。
- `gpt-5.6-sol` 真实执行完成，会话投影返回完整的 user/assistant 两条消息、型号与完成时间；Context Receipt 以 durable 事件返回。
- Replay 实际经历 `queued → running → completed`，结果明确为 `executedReplay=true` 且 `persisted=true`；隔离目录位于 `.yeutech-replay-lab/<replay-id>`，API 不泄露服务端绝对路径。
- 独立会话的上传、列表和删除实际落在用户级 `独立会话/附件/`，没有混入项目列表。
- 所有验收会话已通过 API 删除；临时项目目录、附件、Replay 隔离目录、对应投影/Replay/项目偏好 SQLite 记录已精确清理。

## final-v21 无限制上传与项目文件闭环

- 应用层不再限制上传数量、大小、类型或空文件；二进制仍以流式方式落盘，不进入聊天 JSON。
- 会话上传改为不限数量排队、最多 3 个并发，显示百分比、已传字节、总大小和“正在保存到 NAS”；支持取消、重试、拖放、粘贴和纯附件发送。
- 未完成或失败的上传会阻止发送；切换会话会终止旧 XHR，并用 owner/generation 双重校验阻止附件回写到新会话。
- 项目文件上传会写入当前打开目录，不再固定写到附件目录，也不会自动加入当前对话。上传目标逐级拒绝隐藏目录和符号链接。
- 项目文件列表由服务端提供预览资格元数据；大文件或未知格式保留中文状态、下载和“附加给 Agent”。DOCX/XLSX 预览增加 ZIP 目录、条目数和解压总量边界。
- 文件栏默认宽度提高到 640px，仍支持拖动和键盘调节；独立会话文件区只显示用户级独立会话目录，不再跨项目浏览。
- 本地质量门：npm test 140/140，前端生产构建、全部 JavaScript/MJS 语法和 git diff --check 通过。真实浏览器验收覆盖桌面与 390×844，5 文件实测最大并发为 3，上传中发送禁用，全部完成后可纯附件发送。
- 镜像：yeutech-agent:20260913-final-v21；Image ID sha256:4747db7213c0954a81c5278fa0f624efcfda8960653b13865d888c89c9735267。发布包 SHA-256 2d709e421af9a9bae1f23974528c8310d59506e26e4370ced685b9fedf4b6ffe；回滚源码 /volume1/docker/yeutech-agent/source-final-v20-20260913-pre-v21.rollback。
- SSH 真实验收：5 MiB 任意类型、0 字节文件、当前子目录上传、原文件下载、Context Receipt、Agent 按路径读取并返回 V21_AGENT_FILE_READ_OK、客户端中断后 .uploading=0 均通过。验收会话、临时项目、附件和偏好记录已精确清理。
- 运行态：running / healthy / restarts=0；旧 Codex 192.168.100.216:18110 健康且未修改。

## final-v31 被动历史、按需 Worker 与附件状态闭环

### 用户可见行为

- 历史会话首次只显示最近 10 条，用户滚到顶部后每次继续读取 10 条，并保持阅读位置。初始化的程序化滚动不再误触发第二页。迁移历史和原生 OpenCode 历史都使用不启动用户 Worker 的被动通道。
- 打开网站、刷新、查看项目/文件/历史会话只使用常驻系统 Worker `18133`；发送新消息时才启动对应用户 Worker（本轮实测为 `18150`）。用户 Worker 空闲 30 分钟后回收。
- 终态事件会直接清理页面运行态并释放 prompt activity lease；新 Worker 启动后只在权威 `/session/status` 返回空映射时清理崩溃进程遗留 lease。
- 被动消息与运行时投影按权威消息 ID 去重；终态后 SSE 正常断开不再显示“实时连接中断”。切换会话时模型选择跟随会话的已保存模型。
- 纯附件新会话使用文件名作标题；首次发送失败会保留草稿和附件引用；刷新或转入被动历史后，附件仍以结构化文件标签显示，不暴露内部传输包装文本。历史空回复显示“本轮未返回正文”，不再被误标为正在执行。

### 正确性与附件细节

- 文件面板关闭或切换会话时，中止旧上传并使列表/预览请求失效；上传取消使用 tombstone 阻止完成回调让文件“取消后复活”。
- 消息成功只清理本会话、本轮已发送的附件，不会清理其他会话的新附件。Composer 的“移除”只取消本轮引用；只有文件面板的明确删除动作才会删除 NAS 附件。
- 预览请求绑定当前目录与 generation，旧目录的延迟响应不再跨目录回写。

### 质量门与生产证据

- 本地 `npm test`：145/145 通过；`npm --prefix web run build` 和 `git diff --check` 通过。主 JS 314.29 KB（gzip 97.17 KB）；Mammoth 仅在 DOCX 预览时动态加载。
- 镜像：`yeutech-agent:20260914-final-v31`；Image ID `sha256:6581d82905d7205c27bc3a08fbb1027af351082db4be3b71372b45232539cd69`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260914-final-v31.tar.gz`；SHA-256 `2fb5960c9581f6fb422dd8d37df7989e43e29ad43b015b82b957919eb3fb56c7`。回滚源码：`/volume1/docker/yeutech-agent/source-final-v30-20260914-pre-v31.rollback`。
- SSH 运行态：`running / healthy / restarts=0`；`18140/health={"ok":true,"workerMode":"dynamic"}`。刷新前 `docker top` 只有系统 Worker `18133`，发送消息后才出现用户 Worker `18150`。旧 Codex `192.168.100.216:18110/health` 同时保持 `ok=true`，本次未修改或重启。
- Chrome 登录态真实验收：全新页面首屏严格显示最近 10 条，有更早内容时显示“向上滚动继续加载”，不再自动加载第二页；模型自动跟随为 `GPT 5.6 Luna`。`final-v30` 的真实发送链路已收到唯一“最终版本通过”并回到“当前会话已就绪”；`final-v31` 刷新与分页修复后 console error/warn 为空。
- `final-v22` 的静态资源误唤醒、`final-v23` 的 activity lease 遗留、`final-v26/final-v27` 的被动历史和 UI 终态问题以及中间发布的 `final-v28/final-v29/final-v30/final-v31` 均不是最终版本。

## final-v32 会话顺序与顶部状态布局

### 用户可见行为

- 任务状态概览从输入框上方移到会话标题栏正下方、消息区上方；状态区不再占用输入区附近的空间，也不随历史消息滚动。
- 独立会话按 `updatedAt` 倒序派生展示，不修改 React 原状态；新发消息时立即刷新该会话时间并上浮到首位。
- 文件面板标题区移除突兀的“放大预览”文字按钮。选择文件后，预览工具栏右上角出现四角图标，放大后切换为恢复图标，同时保留完整的 `aria-label` 和悬停说明。

### 质量门与生产证据

- 本地 `npm test`：145/145 通过；`npm --prefix web run build` 和 `git diff --check` 通过。主 JS 314.74 KB（gzip 97.32 KB）。
- 镜像：`yeutech-agent:20260914-final-v32`；Image ID `sha256:b7659e1da9ed97dccf818631e10c0be27a8f5a0d4ed3e4846a4f7e967741e38f`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260914-final-v32.tar.gz`；SHA-256 `8a7c88966d4ecdd7915a9dee026c96bbca92b2c4ebfb66767d417122421c1fbc`。回滚源码：`/volume1/docker/yeutech-agent/source-final-v31-20260914-pre-v32.rollback`。
- SSH 运行态：`running / healthy / restarts=0`；`18140/health={"ok":true,"workerMode":"dynamic"}`。浏览器只读验收后 `docker top` 仍只有系统 Worker `18133`，未启动用户 Worker。旧 Codex `192.168.100.216:18110/health` 同时保持 `ok=true`，本次未修改或重启。
- Chrome 登录态真实验收：任务状态概览确实位于消息列表前；独立会话时间从 `9/14 00:42` 起单调倒序；文件预览已实际完成一次放大与恢复，标题区不再出现文字按钮，预览工具栏提供“放大文件预览/恢复文件面板大小”可访问名称；console error/warn 为空。

## final-v33 门户外观与文件面板交互修复

- 顶部操作重新排序：含义不清的 `Diff` 改为“变更”并使用编辑图标，“文件”固定为最右侧入口。
- 文件面板标题栏不再错误等分操作区；关闭按钮距面板右边缘 18px，固定在右上角。
- 文件面板打开时进入专注模式会先关闭文件面板，并移除 `files-open` 网格列；生产浏览器验证会话区与工作区同为 2240px，不再缩成左侧窄列。退出专注后仍可重新打开文件面板。
- 工作台通过同源只读接口 `/api/portal/appearance?site=codex` 复用当前账号的门户外观配置，并在页面重新聚焦、恢复可见及系统主题变化时刷新。背景模式/图片、背景透明度、表面/材料/顶栏/控件透明度、模糊、圆角、强调色和明暗主题统一映射为工作台语义层；读取失败时仅退回内置默认值，不写入第二份设置。
- 生产账号实测值：`theme=light`、`backgroundStyle=image`、`accent=#0071e3`、`surfaceOpacity=78%`、`materialOpacity=90%`、`chromeOpacity=46%`、`controlOpacity=42%`、`glassBlur=14px`、`radius=14px`，背景图解析为 `https://agent.yeutech.cn/backgrounds/light-architecture.webp`；工作区实算背景为 `color(srgb 1 1 1 / 0.78)`。
- 验证：前端生产构建通过，全量 Node 测试 `145/145` 通过；本地及生产浏览器均完成“打开文件 → 检查关闭按钮 → 进入专注 → 文件面板消失且会话全宽”交互，Console error/warn 均为空。
- 镜像：`yeutech-agent:20260914-final-v33`；Image ID `sha256:906fae5e760f22c9ac1f5895e1b527b238c96ffdea4cbc80b09f03b4f240da40`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260914-final-v33.tar.gz`；SHA-256 `49cb66229a9090e47f37496ae1c95504d341eb074ae50520f08e5fc82e06ebc8`。回滚源码：`/volume1/docker/yeutech-agent/source-final-v32-20260914-pre-v33.rollback`。
- SSH 运行态：`running / healthy / restarts=0`；`18140/health={"ok":true,"workerMode":"dynamic"}`。发布前及生产只读验收后都只有系统 Worker `18133`，未启动用户 Worker。旧 Codex `192.168.100.216:18110/health` 保持 `ok=true`，未修改或重启。

## final-v34 NAS 隐藏目录发现隔离

- “发现 NAS 项目”改为复用服务端工作区隐藏项规则；`.yeutech-replay-lab`、`.git`、`@eaDir` 及其他点号/系统目录不会再作为待接入项目返回，真实普通一级目录仍可发现。
- 新增服务端回归测试覆盖内部回放目录、普通隐藏目录、NAS 系统目录、附件目录、独立会话目录与真实待接入项目的并存情况。
- 本地 `npm test`：146/146 通过；`npm --prefix web run build` 和 `git diff --check` 通过。
- 镜像：`yeutech-agent:20260914-final-v34`；Image ID `sha256:3b5fd97239592496eb9a740282de213ba29e5446a0a05891dd9cee2bf738eab4`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260914-final-v34.tar.gz`；SHA-256 `821c87d7489301aa378771638723eaddd91ac73bc90f042808207b0c48f85719`。回滚源码：`/volume1/docker/yeutech-agent/source-final-v33-20260914-pre-v34.rollback`。
- Chrome 登录态刷新并重新打开“发现 NAS 项目”后，页面显示“没有待接入的 NAS 目录”，不再出现 `.yeutech-replay-lab`；DOM 无错误覆盖层，console error/warn 为空。
- SSH 运行态：`running / healthy / restarts=0`；线上只保留系统 Worker `18133`，未因只读验收唤醒用户 Worker。旧 Codex `192.168.100.216:18110/health` 保持正常，未修改或重启。

## final-v36 整体巡检与被动运行时收口

- 首屏改为工作台 bootstrap 先渲染、历史迁移随后增量合并；历史消息首次只读最近 10 条并继续向上分页。项目文件入口与创建会话完全解耦，项目会话和独立会话统一按 `updatedAt` 倒序，流式输出仅在用户仍接近底部时跟随。
- Profiles、Control、Goals、Context Pack、Replay 与 Skills 查询均改为被动读取；打开、刷新、浏览项目文件及查看能力不会启动用户 Worker。Skills 在 Worker 休眠时明确显示“尚未读取”，不再把未报告误写成 0 项能力。
- Worker 以真实进入 idle 的时刻起算 30 分钟；状态轮询主动对账并清理浏览器断开后遗留的 activity lease。驱逐增加 admission generation，新的发送准入发生在最终 idle 确认窗口时不会被旧观察误停；租约读取只有 `ENOENT` 视为不存在，其他 I/O 错误 fail closed。
- 模型目录默认 5 秒硬超时，并在已有可信目录时 stale-while-revalidate；首次不可用返回 typed `503 model_catalog_unavailable`，不再无限阻塞 bootstrap。Skills 的 404 语义改为 `reported:false`，并使用 `no-store`。
- 文件面板、Diff、控件和暗色语义进一步继承门户外观；补齐 `liquidIntensity`、`lensEdgeWidth`、`density`、`fontScale`。390px 文件面板不再超出右边界；生产实测 rect 为 `x=9 / width=372 / right=381`，viewport 与 document scrollWidth 均为 390。
- 上传保留既定产品契约：应用层不限制数量、大小和类型，使用流式写入、三路并发队列、取消/重试和不覆盖同名文件；反向代理与存储容量仍是实际物理边界。
- OpenCode 实时上游 `dev=df23b7f`，最新正式版仍为 `v1.18.30`。新增 5 个 dev 提交仅涉及 AI SDK Gateway 依赖、文档、Nix 与 Zen billing，未修改 YEUTECH 目录，也没有适合当前 CLIProxyAPI/NAS 架构的直接合并项；继续固定正式版 `1.18.30`，等待下一 release 再以候选镜像升级。

### 质量门与生产证据

- 本地 `npm test`：156/156 通过；`npm --prefix web run build`、全量 JS/MJS `node --check`、`git diff --check` 通过；Web 生产依赖 `npm audit --omit=dev --audit-level=high` 通过。主 JS 319.16 KB（gzip 99.13 KB），Mammoth 仍只在 DOCX 预览时动态加载。
- 镜像：`yeutech-agent:20260914-final-v36`；Image ID `sha256:5f64f01232962c358ec53eb8710a830831d90728edf1f3984c20dc38746d2574`。
- 发布包：`/volume1/docker/yeutech-agent/builds/yeutech-agent-20260914-final-v36.tar.gz`；SHA-256 `de03979b6087be534edb82d46a88e75bf67047fc1ecd9cc7cfbe1216b9961f16`。回滚源码：`/volume1/docker/yeutech-agent/source-final-v35-20260914-pre-v36.rollback`。
- SSH 运行态：`running / healthy / restarts=0`；`18140/health={"ok":true,"workerMode":"dynamic"}`，最近 10 分钟无 error/fatal 日志。只读浏览器验收后仍只有系统 Worker `18133`，没有用户 Worker 或 activity lease。旧 Codex `192.168.100.216:18110/health` 保持 `ok=true`，未修改或重启。
- Chrome 登录态验收：1440px 与 1024px 无横向溢出，文件固定为标题栏最右入口；点击项目文件前后会话数量和选中标题不变；独立/项目会话时间倒序；门户真实 `#598ef8`、图片背景与 74% 表面透明度生效；390px 主界面与文件面板无裁切；休眠 Skills 显示 `— Skills` 和延迟读取说明；console error/warn 为空。
- `final-v35` 是本轮中间巡检版本；它未包含最终的驱逐竞态、租约 I/O、Skills 状态和 390px 文件面板修复，不作为最终版本。

### 隔离实验项目真实 I/O 验收

- 在生产账号中创建隔离项目 `验收实验_20260914_文件预览`，自动进入其项目会话；初始文件目录为空，未混入其他项目内容。
- 通过 Chrome 真实文件选择器上传 `YEUTECH_v36_项目文件验收.md`；选择器 `multiple=true`，页面先显示上传进度，随后显示“已保存”和 237 B 目录项。NAS 实体文件位于 `/volume2/codex项目空间/lucian/验收实验_20260914_文件预览/`，SHA-256 为 `943dc2628f71d414a38d53667047a4cb66e40a35918c3e4fb2f39b29751eff7f`，SSH 回读正文与浏览器一致。
- Markdown 预览实际渲染了标题、三个列表项和末段正文；“下载”与“附加给 Agent”入口可见。附加后输入区出现完整项目路径，未发送消息，收尾已移除本轮引用。
- 桌面端和 390×844 均完成“放大文件预览 → 恢复文件面板大小”，按钮可访问名称随状态切换；移动端目录、工具栏与 Markdown 正文都未裁切。项目目录分隔线实测 `256 → 320 → 256`，项目文件分隔线实测 `360 → 460 → 360`。
- 验收期间 Chrome console error/warn 为空。最终 SSH 核对 `18140/health={"ok":true,"workerMode":"dynamic"}`；监听的 Agent Worker 仍只有系统 Worker `127.0.0.1:18133`，全部 Worker 目录无 `activity-lease.json`，证明创建项目、上传、预览、放大、附加但不发送不会误启动用户 Worker。旧 Codex `192.168.100.216:18110/health` 同时保持 `ok=true`，未修改或重启。
