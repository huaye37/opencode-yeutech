# DeepSeek Harness 能力复核与 OpenCode 移植清单

更新时间：2026-09-13
适用范围：`deploy/yeutech-agent-isolated` 本地与隔离运行时；不代表 NAS 或线上工作台已发布。

## 结论

OpenCode 继续作为 YEUTECH Agent 执行后端。DeepSeek Harness（DSH）真正有价值的部分是围绕会话事实形成的可观察界面：详细轨迹、目标/计划状态、子 Agent 树、Skills/插件清单和统计。它们应读取 OpenCode 已有的会话、消息、工具、子会话、todo、diff、token、cost 和时间字段，经 YEUTECH BFF 做租户过滤与有界投影后展示。

不移植 DSH 的 Cordis 插件运行时、Typert RPC、Session Log/Projection/Query 数据栈、整套 Web 客户端或自动 Goal Round Driver。这些组件会在 OpenCode 旁边形成第二个执行与持久化权威，增加恢复、升级和租户隔离风险，却不会改善当前门户体验。

## 分类矩阵

| DSH 能力 | 当前 OpenCode/YEUTECH 状态 | 结论 | 落地边界 |
| --- | --- | --- | --- |
| 会话持久化、历史、停止、恢复 | OpenCode 原生拥有；BFF 已代理会话、消息、状态、停止与事件路由 | 已具备，继续完善 | 只补前端增量 SSE 和断线恢复，不复制 DSH Session Log |
| 工具审批 | OpenCode 原生 `permission` 请求/回复；YEUTECH 已有 BFF 路由与审批卡代码 | 已具备核心，需完成闭环验收 | 保持 `allow_once`/`reject`，工作区外访问始终拒绝；不得把门户身份交给 OpenCode |
| diff / todo / fork / summarize | OpenCode 原生接口存在，BFF 已列入会话路由白名单 | 已具备后端 | 前端按会话懒加载；不可把整个 diff 或 todo 塞入主消息流 |
| Skills 执行 | OpenCode 原生 Skill 发现与 `skill` 工具已存在 | 已具备执行能力 | 不引入 DSH Skill Registry；补只读清单和来源说明即可 |
| 子 Agent 执行 | OpenCode 原生 Task/子会话与 `children` 接口已存在 | 已具备执行能力 | 移植 DSH 的树形活动展示，不移植 DSH 子进程 Provider 层 |
| 详细轨迹 | 当前消息记录已有 text/tool parts、token、cost、time；YEUTECH 尚无完整轨迹页 | 应移植 | BFF 生成有界、分页的只读投影，前端虚拟列表按需展开输入/输出 |
| Goal/Plan | OpenCode 有 todo、会话状态和 plan 文件语义，但没有 DSH 的 durable Goal 生命周期 | 选择性移植 | 第一阶段把 todo 作为计划事实；如需目标状态，建立 YEUTECH 门户级轻量记录，不驱动模型自动续跑 |
| 子 Agent 活动面板 | `children` 可读，主界面尚未展示完整谱系、运行态、token 与持续时间 | 应移植 | 父子关系来自 OpenCode；状态与统计从子会话消息聚合，禁止客户端拼接任意 session id |
| Skills 清单 | OpenCode 提供 Skill 发现；BFF 当前未公开 `/skill` | 应移植 | 新增租户 Worker 内的只读清单端点，显示名称、描述、来源、可用状态；普通用户不能安装或改写 |
| 插件清单/管理 | OpenCode 有插件加载能力，YEUTECH 没有受控管理面 | 只移植只读管理员清单 | 来源限定为部署配置和可信目录；不开放浏览器安装、上传、启停或任意配置编辑 |
| 会话统计 | OpenCode 消息/会话记录已有 token、cost、time，尚无 YEUTECH 汇总页 | 应移植 | 后端聚合，按用户/项目/会话隔离；未知价格不估算费用，缺失字段显示未知 |
| Session Telemetry / OTel | DSH 为外部报告提供 best-effort、可脱敏事件副本 | 暂不移植 | 当前先用 OpenCode 权威数据库按需聚合；没有明确外发需求前不增加第二份遥测流 |
| DSH Plan Mode | DSH 会改变 system prompt，并提供 `/plan` 与 `exit_plan_mode` | 不直接移植 | 若产品需要只读规划，应由 OpenCode 权限策略和独立模式实现，不能只复制一个 UI 开关 |
| Goal Round Driver | DSH 可按目标自动继续多轮并维护 armed/paused/blocked/complete | 不移植 | 会扩大自动执行与资源消耗；YEUTECH 的后台任务由现有系统任务队列治理 |
| Cordis/Typert/DSH Web | DSH 的组合、RPC、投影和前端框架 | 不移植 | 保留 YEUTECH 门户、BFF、OpenCode runtime 和现有数据权威 |

## 证据定位

### DSH 可借鉴表面

- 轨迹：`packages/client/ui-trajectory/README.md`。其关键价值是按 turn/step 分组、工具与嵌套工具记录、token/耗时/输入输出检查器、历史向前分页和只渲染可见行。
- 子 Agent：`packages/client/ui-subagent/README.md`。其关键价值是完整后代树、独立运行态、token/持续时间、可继续子会话与独立停止。
- Plan：`packages/client/ui-plan/README.md` 与 `packages/plan/plan-mode/src/index.ts`。DSH 的 Plan 是已记录状态和模型策略，不是一个纯前端标签。
- Goal：`packages/goal/goal/src/index.ts` 与 `packages/client/ui-goal/src/client/GoalBar.tsx`。它有 revision、阶段、暂停/恢复/阻塞/完成和最大轮数，不能用一个布尔字段等价替代。
- Skills/插件：`packages/client/ui-skill`、`packages/client/ui-settings-plugin-inventory`、`packages/client/ui-settings-plugins`。只读来源和运行态清单值得借鉴，浏览器配置与插件运行时不应照搬。
- 统计/遥测：`packages/session/session-telemetry/README.md`。该能力是非权威、best-effort 外发副本，不适合作为 YEUTECH 会话状态来源。

### OpenCode 可直接使用的数据

- `packages/opencode/src/session/session.ts` 已保存 token、reasoning、cache、cost 和时间字段。
- `packages/opencode/src/session/summary.ts` 已提供会话 diff 计算和读取。
- `packages/opencode/src/skill/index.ts` 与 `packages/opencode/src/tool/skill.ts` 已提供 Skill 发现和模型工具。
- `deploy/yeutech-agent-isolated/src/agent-bff.mjs` 已对白名单中的 `children`、`diff`、`todo`、`fork`、`summarize`、`permission`、`message`、`status`、`event` 做受控代理。
- `deploy/yeutech-agent-isolated/web/src/App.jsx` 已有消息分页、停止、模型选择和审批卡的实现基础。

## 开发者可执行差距

### P0：完成已有链路，不新增运行时

1. 把前端状态刷新从轮询主路径切换为 `/api/agent/event` 的增量 SSE；断线后先读权威 `session/status` 与最后消息，再恢复订阅。
2. 完成工具审批的真实闭环：覆盖待审批刷新恢复、`once`、`reject`、重复回复幂等、停止时清理和跨用户 request id 拒绝。
3. 接入项目文件与附件。附件必须绑定当前租户 Worker 和授权 workspace；浏览器不能提交本机绝对路径或改变 `directory`。

### P1：移植 DSH 的可观察表面

1. 在 BFF 增加只读聚合接口：
   - `GET /api/agent/session/:id/activity?cursor=&limit=`：从消息 parts、tool state、usage 和 time 生成有界轨迹；默认 50 条，最大 200 条。
   - `GET /api/agent/session/:id/children`：只返回当前用户 Worker 内、由目标会话派生的子会话树。
   - `GET /api/agent/session/:id/plan`：返回 OpenCode todo 与会话状态，不创造第二份计划事实。
   - `GET /api/agent/skills`：只读 Skill 清单，包含 `name`、`description`、`source`、`available`。
   - `GET /api/agent/session/:id/stats`：后端聚合 token、cache、cost、模型、工具数和持续时间。
2. 在前端会话视图增加“活动、计划、子任务”按需面板；首次打开才请求数据，关闭后不持续占用主消息 DOM。
3. 长轨迹使用虚拟列表；工具输入/输出默认折叠并截断预览，完整内容二次按需读取。

### P2：管理员只读能力中心

1. 从实际加载配置生成插件清单，显示来源、版本、启用状态和最近启动错误。
2. 仅门户管理员可读；不提供安装、删除、启停、上传或任意配置编辑。
3. 目录、Skill、插件和运行态分别显示。`模型在目录中`、`能力元数据完整`、`当前 Worker 已加载`、`真实调用已验证`不能合并成一个“可用”状态。

## 数据与安全约束

- 所有 session id 必须先由服务端根据门户用户映射到其 Worker，再访问 OpenCode；客户端 id 不能直接成为跨 Worker 寻址依据。
- OpenCode 数据库继续是新会话、消息、工具、usage、diff 和子会话的权威来源。门户只保存用户/项目授权、公开会话映射和必要的展示偏好。
- 轨迹和统计不得默认包含完整文件内容、命令环境、凭据或未脱敏工具输出。
- 运行中模型目录更新只标记 `pending-idle`；空闲后重载。活跃 Worker 不因目录变化重启。
- 新模型先进入公共目录；能力不完整时可见但不可执行。静态 `ready/selectable` 与当前账号真实调用验证必须分栏展示。

## 验收门槛

- 用户 A 不能通过 session、child、permission 或 cursor 参数读取用户 B 的任何活动。
- 100、500、1000 条消息的会话均能打开轨迹尾部；向前分页无重复、无跳页，主聊天首屏不因轨迹增长线性变慢。
- SSE 断开、BFF 重启和 Worker 重启后，运行/停止/待审批状态都从权威接口恢复，不凭前端缓存猜测完成。
- 子任务运行、完成、失败、取消分别可辨；父会话停止不应伪造所有子任务完成。
- token 与 cost 汇总能回溯到消息记录；目录没有价格时 cost 显示未知而不是 `0`。
- 插件和 Skill 清单只读；普通用户访问管理员清单返回 403。
- 本地测试、隔离运行时、NAS 部署和线上浏览器验收分别记录，任何一项不得替代下一项。

## 本轮边界

本复核不修改 DSH 核心、不把 DSH 指向 Codex 生产数据库、不部署 NAS、不重启或修改线上 Codex 工作台。当前并行修改中的模型目录、Worker 工厂、考研路由和前端文件不在本文件中重复实现或覆盖。
