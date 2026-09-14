# OpenCode × DeepSeek Harness 深层融合研究

更新时间：2026-09-13

适用范围：YEUTECH AI 公共能力、AI 工作台、小说工作台、考研系统及后续 Agent 项目。本文件是源码分析与目标架构，不代表 NAS 或线上运行态已经修改。

## 总结论

不应把 DeepSeek Harness（DSH）理解成一批等待复制到 OpenCode 的功能，也不应把 OpenCode 理解成一个只负责推理的黑盒。更好的方向是：

1. OpenCode 保留执行、会话、工具和文件操作主权；
2. 吸收 DSH 在事件投影、长会话导航、轨迹、目标、子 Agent 和可解释性上的设计；
3. 在两者之上建设 YEUTECH 自己的能力控制面、工作图、上下文凭证和证据验收层；
4. 小说、考研和通用 Agent 不再各自选择固定模型，而是声明工作负载需要的能力，由统一控制面返回已验证且被项目授权的候选。

最终结构不是“OpenCode 加几个 DSH 页面”，而是：

```text
门户身份 / 项目权限 / 工作负载策略
                │
                ▼
YEUTECH AI Control Plane
  ├─ 模型能力与运行证据
  ├─ Worker / 队列 / 配额
  ├─ Skills / 插件供应链
  ├─ 上下文凭证与证据门槛
  └─ 版本化 Portal Event Projection
                │
                ▼
       OpenCode Runtime Workers
  会话 · 工具 · 子任务 · 文件 · 压缩 · 恢复
                │
                ▼
          CLIProxyAPI / Providers
```

## 方向一：移植 OpenCode 当前缺少的精华

### 1. 轨迹、Turn Outline 与全会话统计

DSH 的优势不是“日志更多”，而是把完整事件折叠成适合用户读取的投影：

- `session-turn-outline` 能定位尚未载入的历史 turn；
- `session-stats` 从完整 durable log 计算 turn、step、LLM、tool、TTFT 和 decode 时间；
- `ui-trajectory` 将 user、assistant、tool、nested tool、compaction 按 turn/step 组织，并按需查看 token、耗时、输入与输出；
- 长会话从尾部打开、向前分页，只渲染可见行。

应移植的是这种“权威事实 → 有界投影 → 懒加载界面”的模式。数据仍来自 OpenCode message、part、session、children、diff、todo、token、cost 和 time，不引入 DSH Session Log。

建议新增版本化接口：

- `GET /api/agent/v1/sessions/:id/outline`
- `GET /api/agent/v1/sessions/:id/activity?after=&before=&limit=`
- `GET /api/agent/v1/sessions/:id/stats`

轨迹默认返回摘要；完整工具输入、输出和 diff 必须二次请求，防止大结果重新拖垮前端。

### 2. 子 Agent 可观察性

OpenCode 已有 Task/子会话和 `children`，缺的是 DSH 那种完整后代树、独立状态、token、持续时间、继续与停止语义。应实现 YEUTECH 子任务面板，但保持 OpenCode 子会话为唯一权威。

需要补足：

- 明确 `parentSessionId + childSessionId + runId`，不能只依赖标题；
- 区分 running、completed、failed、cancelled、orphaned；
- 父任务和子任务分别停止，不能把父任务停止解释成所有子任务完成；
- 后台子任务必须计入 Worker 活跃租约，防止 Supervisor 将其当作空闲进程驱逐。

### 3. Goal 的状态语言，而不是自动续跑驱动

DSH Goal 的 revision、active/paused/blocked/complete、最大轮数和 CAS 更新很有价值，因为它把“继续努力”变成可恢复状态。Goal Round Driver 自动驱动模型多轮并不适合直接移植：它会扩大成本和失控执行面，也与门户后台任务队列重叠。

建议创建轻量 `work_goal`：

- 绑定公开任务或项目，而不是绑某个模型会话；
- 保存 objective、phase、revision、blockReason、acceptancePolicy；
- OpenCode todo 是本次执行计划，`work_goal` 是跨会话目标，两者不能混为一张 todo 表；
- 自动继续必须由队列策略显式授权，而不是 Goal 状态隐式触发。

### 4. 手动压缩、工具结果裁剪与压缩可解释性

OpenCode V2 的 Context Epoch、自动压缩、overflow-triggered compaction 和“完整历史保留、只替换模型表示”更稳健；DSH 的 `/compact`、按模型策略与 oversized tool-result pruner 更适合用户控制。

应补：

- 用户可见的“为什么压缩、压缩了哪些范围、保留了哪些最近内容”；
- 手动压缩，但只能在安全边界执行；
- 对历史大工具结果做确定性裁剪，保留 hash、类型、原始长度和可回读引用；
- 压缩前后生成 Context Receipt，禁止把一次失败压缩当作已切换上下文。

### 5. 只读 Skills 与插件清单

借鉴 DSH 的来源、启用状态、运行异常和 preset/global 分层展示，但不移植浏览器插件编辑器。第一阶段仅提供：

- Skill 名称、说明、来源、版本/hash、授权范围、当前 Worker 是否加载；
- 插件名称、可信来源、启用状态、启动错误；
- 普通用户只读 Skills；插件供应链仅管理员可读；
- 浏览器不允许安装、上传、启停或修改任意插件配置。

## 方向二：融合优化两边都已有的功能

### 1. 会话：OpenCode durable inbox + DSH projection

OpenCode 的 steer/queue、幂等 prompt admission、按 Session 串行执行和 durable history 比 DSH 更适合作为执行主干；DSH 的 projection、outline 和 trajectory 更适合客户端。

融合后应形成版本化 Portal Event Projection：

- durable cursor 只随持久事件前进；
- streaming delta 明确标记 ephemeral，不推进 durable cursor；
- 客户端断线后从 durable cursor 回放，再续接 ephemeral stream；
- UI 不再对每个 SSE 事件全量重读 message、status 和 permission；
- 原始 OpenCode API 不成为长期浏览器契约，升级兼容由 BFF 投影层承担。

### 2. 上下文：Context Epoch + 来源投影 + 工作负载契约

OpenCode Context Epoch 能保存模型实际收到的 privileged baseline，并在模型切换、压缩和 Location 移动时建立新基线。DSH 的 context 插件与轨迹更擅长说明上下文来自哪里。

融合后的上下文分四层：

1. 项目契约：AGENTS、项目权限、可信资料范围；
2. 长期项目上下文：小说设定账本、考研教材/评分规则、项目稳定事实；
3. 会话上下文：历史、压缩 checkpoint、用户 steer/queue；
4. 本轮临时上下文：附件、当前文件、运行态和工具结果。

每次 provider turn 生成 `Context Receipt`：

- model/provider/route；
- catalog generation 与 runtime verification；
- Context Epoch/hash；
- 纳入的来源、版本、token 估计和缺失项；
- compaction checkpoint；
- workspace snapshot/hash；
- 权限与工具目录版本。

它让小说候选能判断是否基于最新设定，让考研解析能证明使用了哪份题干和评分规则，也让代码任务能解释模型是否读到了当前 AGENTS。

### 3. 模型目录：从“动态清单”升级为四层能力控制面

当前 `/v1/model-capabilities` 已解决新增 ID 自动发现，但一个 `selectable` 无法同时表达目录、能力、账号、运行时和项目授权。

建议拆为四层：

| 层 | 回答的问题 |
| --- | --- |
| Discovery | CLIProxyAPI 当前发现了哪些 model/route？ |
| Declared capability | context、input/output、modalities、reasoning、tools、structured output 是否完整？ |
| Runtime evidence | 哪个凭据代次、出口、Worker、协议和工作负载真实验证过？何时过期？ |
| Project eligibility | 小说、考研、代码或图片任务是否允许使用？是否满足成本、隔离和数据策略？ |

模型生命周期应为：`discovered → metadata-ready → probed → workload-approved → degraded/quarantined → retired`。

重要改进：

- 新模型未知时可见但不可执行；
- 不再用模型名称正则判断图片/对话能力，严格使用 input/output modalities；
- 隔离必须带维度：model + route + credential generation + protocol + workload。一次空回复不能全局封禁一个模型；
- fallback 不能取字母序第一个模型，应由工作负载策略、管理员优先级和会话 stickiness 决定；
- 会话中途不静默切模型。发生 failover 时必须生成 route decision 记录，并在可能改变语义时要求重新执行本轮；
- 所有消费者使用同一 JSON Schema、契约样例和兼容测试，避免每个项目自行猜测 snake_case/camelCase。

### 4. 权限：门户授权与 Agent 工具授权取交集

门户控制“这个用户能进入哪个项目”，OpenCode 控制“Agent 能在项目内做什么”，两者不能互相替代。

建议有效权限为：

```text
effective permission
= portal project authorization
∩ workload policy
∩ agent/tool policy
∩ current one-shot approval
```

借鉴 DSH permission preset 的用户表达，但后端只接受稳定策略 ID。审批卡应解释工具、资源范围、影响与持续时间；持久允许必须限定 project + tool + canonical resource pattern，普通 `allow_once` 不升级为长期授权。

### 5. 子任务与队列：速度、恢复和公平性一起设计

OpenCode 的本地 eager tool execution 和子会话性能更好；DSH 对子 Agent 的活动展示和继续/停止更成熟。YEUTECH 还需要补上两边都不完整的资源治理：

- 并发名额在持久任务库中原子领取，不能“先读 active 数再提交”；
- 每用户、system identity 和全机分别设并发/队列/内存预算；
- steer、queue、子任务和后台系统任务统一进入 Work Graph，但保留各自语义；
- 工具并行需有每 turn 上限、输出预算和背压；
- Worker 驱逐以活动租约为准，覆盖前台会话、后台子任务、待审批工具和未完成系统任务；
- 模型目录更新按预算分批重启空闲 Worker，避免同时冷启动。

### 6. Skills/插件：OpenCode 执行面 + DSH 可解释供应链

OpenCode 保持实际 Skill 与插件加载；DSH 的 inventory UI 提供可见性。YEUTECH 增加供应链清单：来源、hash、版本、能力声明、权限需求、兼容版本、加载结果。管理站只允许从签名/固定来源进入候选区，经过隔离验证后才进入生产配置；不做运行时任意安装市场。

## 方向三：基于 YEUTECH 场景原创的优化

### 1. Workload Profile：项目声明能力，不声明固定模型

把项目中的 `modelId` 改成工作负载契约，例如：

```json
{
  "profile": "kaoyan-grading",
  "requires": {
    "input": ["text", "image"],
    "output": ["text"],
    "structuredOutput": true,
    "minContext": 128000
  },
  "policy": {
    "sourceGrounding": "required",
    "maxCostClass": "medium",
    "failover": "before-dispatch-only"
  }
}
```

建议内置但可配置的 profile：

- `agent-code`：工具、文件、长会话、停止与恢复；
- `novel-draft`：完整历史、超长上下文、风格与设定一致性；
- `novel-review`：结构化差异、候选不自动覆盖正文；
- `kaoyan-tutor`：可信资料引用、视觉输入、解释能力；
- `kaoyan-grading`：结构化输出、稳定评分规则、低随机性；
- `scene-illustration`：图片输出，与文本模型选择彻底分离。

项目可以固定一个已批准模型，也可以选择“自动”，但自动选择必须留下决策记录。

### 2. Work Graph：把聊天、工具、子 Agent、后台任务统一成工作图

当前多个系统分别有 session、turn、system task、tool call、subagent、approval 和 review item。建议引入只读派生的 Work Graph：

- Node：goal、turn、tool、subagent、system task、artifact、approval、review；
- Edge：spawned、depends-on、produced、verified-by、blocked-by、supersedes；
- 状态来自各权威系统，Work Graph 本身不伪造完成；
- 用户从一张图看到“为什么还没完成”“正在等什么”“产出了什么”“哪些已验收”。

这比单纯复制 DSH trajectory 更适合跨小说、考研和代码工作流。

### 3. Evidence Gate：完成状态绑定证据，不绑定回复结束

每个 Workload Profile 定义完成证据：

- 代码任务：文件差异、对应测试、构建或运行探针；
- 小说：候选进入待审阅、输入 snapshotHash、设定/正文未被自动覆盖；
- 考研解析：题目 ID、来源版本、评分规则版本、结构化答案；
- 图片：生成文件、模型/参数、尺寸/格式检查；
- 发布：本地、NAS、公开入口、浏览器验收分别记录。

Agent 输出结束只表示 `generation-settled`；满足 profile 的证据后才进入 `deliverable-ready`，用户审阅或真实环境验收仍是独立状态。

### 4. Project Context Pack：跨模型、跨会话但不复制项目

为每个项目生成可版本化 Context Pack：

- 权威文件引用，不复制 NAS 主数据；
- 结构化项目事实、术语、约束和来源；
- 变更后生成新 revision，旧候选记录其使用版本；
- 模型切换或会话恢复时通过 Context Epoch 装载；
- 小说与考研分别使用自己的 pack schema，不把两者压成通用向量库。

Context Pack 解决“会话能续上但事实已经变了”的问题，也让不同模型共享同一项目语义边界。

### 5. Context Inspector：让用户看到模型本轮真正拿到了什么

在会话旁增加“本轮上下文”抽屉：

- 已纳入、已截断、未找到、权限拒绝、版本过期；
- 每一来源的 token 占用；
- 压缩前后范围；
- 明确区分项目文件、显式上传和历史上下文；
- 不展示敏感正文全文，只展示来源、版本、摘要和可授权的预览。

这能直接减少“模型是不是读了我的文件”“为什么忘了设定”“批改用了哪版答案”的争议。

### 6. Replay Lab：升级模型和 Agent 之前先离线复盘

建立无写权限的回放实验室：

- 从真实任务抽取脱敏、固定输入的代表性样本；
- 对新模型、新目录元数据、新压缩策略和 OpenCode 版本做同输入比较；
- 指标包括 TTFT、总耗时、token、cost、工具成功率、上下文忠实度、答案结构与证据完整度；
- 小说用设定一致性和候选可读性人工审阅，考研用标准答案/评分规则比对，代码用测试和 diff；
- 回放结果只形成升级证据，不直接切生产路由。

### 7. Runtime Budget Controller：适合 16GB Mac mini 的隔离与效率平衡

当前每用户独立 Worker 的隔离方向正确，但要增加预算控制：

- `system:kaoyan` 保持独立常驻；
- 普通用户 Worker 按需唤醒、空闲休眠，XDG 与数据库继续独立；
- 记录冷启动、RSS、活跃会话、后台子任务和队列长度；
- 基于总内存预算决定同时常驻 Worker 数，不以固定端口数量代替容量；
- 目录更新和版本升级分批滚动，正在运行或有后台租约的 Worker 不动。

## 当前实现的具体优化点

### P0：正确性与数据边界

1. `web/src/App.jsx` 的 `DEFAULT_MODEL` 仍是固定模型 ID；应由 BFF 返回当前 Worker 的 `defaultModel` 和选择原因。
2. 独立会话归属通过 `OWNED_SESSIONS_STORAGE_KEY` 保存在浏览器 localStorage；换设备、清缓存或多标签会造成可见性不一致。归属应来自门户数据库/Worker 映射，localStorage 只保存最近选择。
3. SSE 收到事件后仍全量请求 messages、status、permissions；高频流会造成请求放大。应按 typed event 增量更新，并用低频 reconciliation 修正漂移。
4. `requireWorkerCapacity()` 是读取 active 数后再提交，两个并发请求可能同时通过。应在持久队列中原子占位，再由 Dispatcher 启动。
5. Supervisor 用 `/session/status` 判断空闲，但 OpenCode 当前 active registry 不覆盖后台 subagent/task。需要 Worker lease 聚合，否则后台工作可能被空闲驱逐或目录重载终止。
6. 模型 quarantine 当前主要按 model ID 存储；一次空输出可能影响所有 Worker 和工作负载。应按 route/credential generation/protocol/workload 分类，并区分 auth、transport、empty-output、schema、region 和 model 错误。
7. 模型类型仍部分依赖 ID 正则；应严格验证 text input/output modalities。图片输出模型即使名称不含 `image` 也不能进入聊天执行配置。
8. `readableStatus()` 通过错误字符串识别 `auth_unavailable`；应使用稳定错误 code、retryable、scope 和 recoveryAction。

### P1：性能与恢复

1. 目录更新对多个空闲 Worker 的 refresh 当前可并发发生，应增加滚动预算，避免 Mac mini 同时重启多个 OpenCode 进程。
2. BFF 到 OpenCode 的 system 请求需要统一 timeout、abort 传播和分类错误，不能无限等待。
3. message/permission/status 的聚合读取应变成一个有版本号的 session snapshot，减少三次请求之间的竞态。
4. 增加 inbox backlog、steer batch、每 turn 工具并行数和工具输出预算；当前底层已有“宽泛暴露前需补限制”的明确缺口。
5. Worker 启动、配置代次、目录代次和运行验证状态应形成一份 readiness，而不是由多个文件和接口让前端自行拼接。

### P2：产品与维护性

1. API 工作台、AI 工作台、小说、考研使用同一 schema 与 contract fixtures；各端只做 workload filtering，不复制能力推断规则。
2. 前端不要直读 OpenCode 内部对象；BFF 输出 YEUTECH 稳定 DTO，避免上游升级影响所有项目。
3. UI 将“目录发现、能力完整、Worker 已加载、真实验证、项目允许”分栏显示，不能再汇总成单一“可用”。
4. 轨迹、上下文和统计均按需加载；聊天 DOM 只保留当前阅读窗口。

## 推荐实施顺序

### 决策优先级

| 项目 | 用户影响 | 实现量 | 风险 | 建议 |
| --- | --- | --- | --- | --- |
| 原子任务占位与持久队列 | 高 | 中 | 中 | 立即做，先消除并发竞态 |
| Worker activity lease | 高 | 中 | 中 | 立即做，避免后台任务被误杀 |
| 统一 capability schema 与严格 modality | 高 | 低 | 低 | 立即做，封住错误模型进入执行链 |
| 服务端会话归属 | 高 | 中 | 中 | 立即做，支持跨设备与真实隔离 |
| typed error 与 session snapshot | 高 | 中 | 低 | P0/P1 交界，减少状态猜测 |
| Portal Event Projection | 高 | 高 | 中 | 作为后续所有可观察界面的地基 |
| Context Receipt | 高 | 中 | 低 | 先做最小字段，立即服务小说和考研 |
| 子任务树、轨迹、统计 | 中高 | 中高 | 低 | 投影层完成后并行建设 |
| Workload Profile | 高 | 高 | 中 | 模型控制面稳定后落地 |
| Work Graph / Evidence Gate | 高 | 高 | 中 | 先覆盖 system task，再扩展通用会话 |
| Replay Lab | 中高 | 高 | 低 | 在下一次模型或 runtime 大升级前完成 |
| 插件管理 UI | 低 | 高 | 高 | 不做；只做管理员只读 inventory |

### 阶段 A：先修正确性

- 统一 capability JSON Schema 与契约测试；
- 去除前端默认模型硬编码和模型类型正则依赖；
- 原子任务占位、Worker activity lease、typed error；
- 将会话归属移回服务端。

### 阶段 B：建立版本化投影层

- Portal Event Projection、durable cursor、ephemeral delta；
- session snapshot、outline、stats、activity；
- SSE 增量消费与重连回放。

### 阶段 C：交付用户可见精华

- 子任务树、轨迹页、Context Inspector；
- todo plan 与轻量 Goal；
- 只读 Skills/插件能力中心；
- 手动压缩和大工具结果引用化。

### 阶段 D：建设原创控制面

- Workload Profile 与多层模型资格；
- Work Graph 和 Evidence Gate；
- Project Context Pack；
- Replay Lab 与 Runtime Budget Controller。

## 暂不采用

- DSH Cordis/Typert 作为第二运行时；
- 把 DSH Session Log 或 Query SQLite 与 OpenCode 数据库双写；
- 浏览器插件安装、上传和任意配置编辑；
- Goal 状态自动触发无限多轮；
- 静默跨模型 failover；
- 将完整轨迹、工具输出或上下文正文塞入主聊天 DOM；
- 用向量库替代小说设定账本、考研来源和项目文件权威数据；
- 因单个模型失败重启整个 Worker 或隐藏整个公共目录。

## 验收指标

- 100/500/1000 消息会话的打开、尾部定位、回放、断线恢复和内存曲线；
- 1/3/5 用户 Worker 加 `system:kaoyan` 时的 RSS、冷启动、并发和驱逐正确性；
- 高频 streaming 下 BFF 请求放大倍数和前端渲染次数；
- 并发提交不突破配额，排队位置可恢复；
- 后台子任务存在时不驱逐、不重载对应 Worker；
- 新模型从 discovery 到 workload-approved 的状态转换和审计记录；
- 小说、考研、代码三类 Context Receipt 与 Evidence Gate 能回溯到真实来源；
- 任何测试、隔离运行态、NAS 部署、公开入口和用户验收继续分别记录。

## 本轮执行边界

本文件只进行源码级研究和目标设计。没有部署 NAS、没有修改线上 Codex 工作台、没有变更 DSH 核心、没有提交或推送，也没有覆盖当前并行修改中的模型目录、Worker、考研或前端实现。
