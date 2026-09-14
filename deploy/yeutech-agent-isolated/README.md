# YEUTECH Agent 工作台

这是一套运行在 NAS、与线上 Codex 工作台并列且数据隔离的 OpenCode Agent 工作台。第一阶段只恢复 Ryan（`user_id=3`）的项目和会话，不连接线上 `codex.sqlite`。历史正文读取 2026-09-12 的一致性数据库副本；新会话、OpenCode 状态和迁移映射写入独立的 `/volume1/docker/yeutech-agent/runtime`。

## NAS 单容器部署

生产形态只新增一个 `yeutech-agent` 容器。容器内部同时运行静态前端、BFF、历史迁移服务和 OpenCode，宿主只发布 `18140`。现有 `novel-ai-proxy` 继续提供 CLIProxyAPI，不新增 bridge 容器；Mac mini 不参与常驻执行。

NAS 路径：

```text
/volume1/docker/yeutech-agent/
├── source/   # Dockerfile、docker-compose.yml 和源码
├── data/     # 只读历史数据库副本
└── runtime/  # OpenCode 数据、配置、映射和密钥
```

DSM Container Manager 创建项目时选择：

```text
项目名：yeutech-agent
路径：/docker/yeutech-agent/source
文件：docker-compose.yml
```

Compose 的关键边界：

- `${YEUTECH_PROJECTS_BIND_SOURCE}` 以 bind 方式挂载到 `/projects:rw`（宿主源目录必须先通过不可变 `spaceId` marker 唯一解析，并禁止 Docker 自动创建缺失源目录；`edit` 允许，命令及其他副作用工具必须逐次审批）
- `/volume1/docker/yeutech-agent/data:/data:ro`
- 首次启动把固定日期的只读 SQLite 快照复制到独立 runtime，供 SQLite 创建必要的 WAL/SHM；不会修改源副本
- CLIProxyAPI key 只读挂载到 `/run/secrets/cliproxy.key`
- 容器使用 NAS host 网络，只通过宿主回环地址 `http://127.0.0.1:18319` 复用 `novel-ai-proxy`
- 动态 OpenCode Worker `18150-18249`、supervisor `18141` 和 migration `18142` 仅监听 NAS loopback，不向局域网开放
- 浏览器统一访问 `http://NAS-IP:18140/`

### 宿主项目空间定位

项目空间目录可以改名，Compose 不再保存 `/volume2/codex项目空间` 这个易漂移路径。在真实项目根放置 `.yeutech-space-id`，文件内只保存稳定 ID，例如：

```text
yeutech-codex-projects-v1
```

然后通过包装脚本执行 Compose：

```bash
sudo env \
  YEUTECH_PROJECT_SPACE_PARENT=/volume2 \
  YEUTECH_PROJECT_SPACE_ID=yeutech-codex-projects-v1 \
  ./scripts/compose-nas.sh -p yeutech-agent config --quiet

sudo env \
  YEUTECH_PROJECT_SPACE_PARENT=/volume2 \
  YEUTECH_PROJECT_SPACE_ID=yeutech-codex-projects-v1 \
  ./scripts/compose-nas.sh -p yeutech-agent up -d --build --force-recreate --no-deps yeutech-agent
```

固定 `-p yeutech-agent` 可确保 CLI 与 DSM Container Manager 识别为同一个 Compose 项目，避免已有固定容器名被误判为冲突。

解析器只检查限定父目录的直接子目录，不跟随目录或 marker 符号链接。找不到或找到多份相同 `spaceId` 时立即退出；Compose 变量未注入时也会在解析配置阶段失败，因此 Docker 不会因旧目录改名而创建一个空的 bind source。磁盘挂载点改变时只更新受限的 `YEUTECH_PROJECT_SPACE_PARENT`，不修改 `spaceId`。

## 隔离边界

- OpenCode 仅监听容器内 `127.0.0.1:18130`；migration 仅监听容器内 `127.0.0.1:18142`；BFF 和静态前端监听 `0.0.0.0:18140`。
- 现有 Codex 的 `18110`、进程、数据库和项目空间不在脚本操作范围内。
- OpenCode 使用独立的 XDG 配置、数据、缓存和状态目录。
- 项目工作区由 supervisor 按门户不可变用户 ID 懒创建；升级时 Ryan/Lucian 继续使用 `/projects/ryan`、`/projects/lucian`，新用户使用 `/projects/users/<portalUserId>`。历史项目与会话只从 Ryan 的迁移快照恢复。
- 每个身份拥有独立 Worker、端口、XDG、配置、日志和 SQLite。映射原子持久化在 `/runtime/workers/registry.json`，重启后端口稳定；空闲 Worker 默认 30 分钟后回收。打开或刷新页面、浏览项目/文件、读取历史和准备工作区都不启动用户 Worker；只有发送新消息时才以原数据唤醒。
- 用户和项目路径不以名称作为身份：owner 根目录保存 `.yeutech-user.json`（不可变 `portalUserId`），项目目录保存 `.yeutech-project.json`（不可变 `projectId` 和所属 `portalUserId`）。因此门户用户名、owner 文件夹名、项目展示名和项目文件夹名都可以改变；首次访问重新扫描 marker，并只在校验通过后更新 registry 的 `currentPath`。Ryan 首次升级会在既有 `/projects/ryan` 安全写入用户 marker，不移动也不复制原项目。
- owner 根目录改名时，supervisor 必须先确认该用户 Worker 空闲并停止子进程，再通过 SQLite online backup 保存该用户 `opencode.db`，在单一事务中重绑 `session.directory`、`project.worktree`、`project_directory.directory` 和 `project.sandboxes` 的旧 owner 路径前缀。`session.path` 保持相对路径不变；失败会回滚且 registry 不切换。项目目录单独改名只更新项目 marker 索引，不会错误改写以 owner 根目录为 `directory` 的会话。
- marker 重复、格式或归属错误、选中的 workspace/marker 是符号链接、真实路径越出 `/projects`，以及数据库重绑会产生主键冲突时均 fail closed。扫描不会跟随无关符号链接，避免 NAS 中一个无关链接导致整个用户空间不可用。
- 浏览器侧只能接同源 BFF。BFF 验证门户短期签名后向 loopback supervisor 请求对应 Worker，并拒绝 Shell、Command、Share 等未授权接口。
- BFF 仅接受门户短期签名身份，并把所有 Agent、SSE 和审批请求固定到该用户的独立 Worker。`external_directory` 永远拒绝，`bash` 和其他副作用工具要求审批；页面只提供单次允许或拒绝。
- 模型层固定复用 NAS 现有 CLIProxyAPI，模型目录持续动态读取，默认型号由部署配置或当前可执行目录决定，不在源码和前端写死。目录变化只重载空闲 Worker；失败按 `workload + modelId` 记录，单次空回复只降级，连续失败达到阈值才隔离，不影响其他工作负载和模型。

## 本地检查

```bash
npm test
```

## 本地 AI 工作台

这个前端只用于本地界面和交互验证，不读取 NAS，不连接线上 Codex 数据库。分别启动 Mock Agent API 和 Vite：

```bash
npm --prefix web run mock
npm --prefix web run dev -- --port 18140
```

然后用 Chrome 打开 `http://127.0.0.1:18140/`。Vite 将 `/api/agent` 转发到本地 `127.0.0.1:18141`。旧的白底三栏概念稿已废弃，当前视觉以门户 Codex 工作台为准，记录在 `design/design-spec.md` 和 `design/fidelity-ledger.md`。

当前工作台把任务状态概览固定在会话标题下方，不随消息区滚动；独立会话按最近更新时间倒序排列，新发消息的会话会立即上浮。文件面板只在已经选中预览文件时，于预览工具栏提供轻量的放大/恢复图标，面板标题区只保留关闭入口。

## 历史项目和会话恢复

2026-09-12 的隔离迁移样本固定读取以下本地快照，不连接 NAS 或正式 `codex.sqlite`：

```text
/Users/fangjialiang/Documents/家庭网络中枢项目/04_工具与运维/本地备份/codex迁移源数据/2026-09-12/
├── projects/       # NAS 项目空间副本，保留 .git、隐藏目录和用户级“独立会话”文件夹
├── conversations/  # 工作台数据、导入包、附件和运行记录副本
├── database/       # 原始 WAL 文件集和通过 integrity_check 的一致性 SQLite 副本
└── metadata/       # 项目盘点和逐文件 SHA-256 清单
```

生成或刷新本地快照清单：

```bash
npm run migration:manifest -- \
  '/Users/fangjialiang/Documents/家庭网络中枢项目/04_工具与运维/本地备份/codex迁移源数据/2026-09-12'
```

启动只读历史服务（要求隔离 OpenCode `18130` 已运行）：

```bash
YEUTECH_MIGRATION_DATABASE='/Users/fangjialiang/Documents/家庭网络中枢项目/04_工具与运维/本地备份/codex迁移源数据/2026-09-12/database/codex-20260912-062144.sqlite' \
YEUTECH_MIGRATION_PROJECTS_ROOT='/Users/fangjialiang/Documents/家庭网络中枢项目/04_工具与运维/本地备份/codex迁移源数据/2026-09-12/projects' \
./scripts/start-migration.sh
```

历史正文始终只读。用户不需要点击额外的“继续此会话”：在原会话输入框第一次发送时，服务会静默创建或复用 OpenCode session，并使用 `noReply: true` 写入最多 24,000 字符的迁移上下文，然后再发送当前用户消息。映射保存在 `.runtime/migration/mappings.json`，页面始终保留原会话 ID 和原会话条目；不再额外显示对应的 OpenCode session。迁移 seed 只存在 OpenCode 内部，不作为用户消息显示。旧 thread/session ID、隐藏消息、推理、工具句柄、审批、登录态和运行中进程不会被伪装成已恢复。

当前只完成本机 Ryan 单用户可用链路。恢复服务必须显式绑定 `user_id=3` 和 `ryan` 项目目录，缺少任一绑定就拒绝启动；其他用户、没有用户归属的记录、其他用户目录和无归属 OpenCode runtime session 均不进入恢复结果。用户、项目权限和多租户隔离要等 NAS 可用后再接门户验证；浏览器不能传入数据库、项目根目录或 OpenCode workspace 的任意路径。

Ryan 范围的当前快照为 4 个真实项目、37 个去重历史会话和 3,125 条可见历史消息；其中 29 个项目会话、8 个 Ryan 独立会话。独立会话具有 Ryan 用户归属，只是没有项目归属；没有用户归属的数据不恢复，也不生成虚构项目。后续换快照时应重新盘点，数字不在前端写死。

连接真实本地 CLIProxyAPI 时，只提供上游地址和密钥文件，不把密钥写入前端、配置文件或命令参数：

```bash
YEUTECH_CLI_PROXY_URL=http://127.0.0.1:8317/v1 \
YEUTECH_CLI_PROXY_KEY_FILE=/absolute/path/to/cliproxy.key \
./scripts/start-isolated.sh

YEUTECH_AGENT_WEB_TARGET=http://127.0.0.1:18131 \
YEUTECH_AGENT_BFF_TOKEN_FILE=../.runtime/secrets/portal.token \
npm --prefix web run dev
```

## Mac mini 独立部署

目标目录：

```text
/Users/lucian/Developer/YEUTECH/opencode-agent-isolated
```

在目标目录执行：

```bash
./scripts/install-opencode.sh
./scripts/start-isolated.sh
```

启动脚本会生成独立 portal token、supervisor token 和 OpenCode Basic Auth 密码，动态读取 NAS `/v1/model-capabilities`，只把明确声明 text input 与 text output 的模型纳入对话能力，再为每个 Worker 生成独立 `opencode.json`。模型名称不再参与图片/对话能力猜测。端口分配会持久化并跳过已占用端口；容器只有在 `system-kaoyan` Worker 真正 ready 后才宣告就绪。
新发现的对话模型会通过同源 `GET /api/models` 出现在模型选择中；上下文或输出上限未补全时保持可见但禁用。BFF 在转发每个 prompt 前会再校验公共能力目录与当前 OpenCode 配置，`context=0`、不可用或尚未安全加载的模型不会进入 OpenCode。
目录每 15 秒检查一次。Ryan、Lucian 和 `system-kaoyan` 在同一容器中分别运行独立 OpenCode Worker，使用独立端口、XDG data/config/cache/state 和 `opencode.db`。每个 Worker 发现目录变化后先进入自己的 `pending-idle`；只有 `/session/status` 为空且没有 BFF 持久 activity lease 时才重启该子进程并原子替换配置。刷新按单 Worker 滚动，避免目录更新形成重启峰值。其他 Worker、BFF、容器和 SQLite 不重启。旧共享库只作一次非破坏性拷贝迁入 Ryan Worker，Lucian 和考研系统从独立空库开始。每个 Worker 最多同时接受 2 个执行任务；状态检查与 prompt 提交在 BFF 内串行准入，超限请求返回类型化 `429 worker_capacity`。

工作台使用版本化 Portal Projection，而不是让页面拼接 OpenCode 内部对象：`/api/workbench/bootstrap` 一次返回服务端归属的会话、状态、审批、模型与默认模型原因；`/api/workbench/sessions/:id/snapshot` 聚合消息、计划、子 Agent、轮次提纲、活动轨迹、统计和 Context Receipt。`/api/workbench/sessions/:id/events` 把 durable 投影事件写入 SQLite 并用单调 cursor 回放，OpenCode 流式 delta 作为 ephemeral 事件传输且不推进 cursor；页面只在流中断时降级为有界快照恢复。项目附件在提交时由服务端重新校验并生成 Context Receipt，收据随本次执行注入且写入 durable projection；Replay Lab 在独立隐藏目录真实重跑最近一轮并持久记录结果，不把指标快照比较伪装成执行回放。控制面还提供 Goals、Runtime Budget、只读 Skills、Workload Profile、Work Graph、子任务树和大工具结果受控回读。浏览器 localStorage 只保存最近选中的会话与已确认 durable cursor，不保存会话归属或事件正文。

### 考研系统任务 API

考研后端使用只读挂载的 `/volume1/docker/yeutech-agent/runtime/secrets/system-kaoyan.token` 作为 Bearer token，不将 token 下发给浏览器。所有请求固定到 `system:kaoyan` 服务身份的 `/projects/system/kaoyan` workspace，请求中不接受自定义目录。

- `POST /api/system/tasks`：提交 `{sessionKey, kind, modelId, prompt, idempotencyKey?}`，`kind` 可为 `assistant`、`grading` 或 `explanation`。同一 `sessionKey` 持久复用同一 OpenCode session；带幂等键可防止阅卷任务重复提交。
- `GET /api/system/models`：读取考研 Worker 已安全加载的模型和待空闲重载状态。
- `GET /api/system/tasks/:taskId`：读取任务、最近 200 条消息与终态。
- `GET /api/system/tasks/:taskId/events`：转发该考研 workspace 的 OpenCode SSE，响应头包含对应 `taskId` 和 `sessionId`。
- `POST /api/system/tasks/:taskId/stop`：停止执行但保留任务和 session。
- `POST /api/system/tasks/:taskId/resume`：可以 `{prompt?, modelId?}` 继续原 session；缺省时复用原任务内容和模型。

任务映射保存在独立 `/runtime/system/kaoyan-tasks.sqlite`，使用 WAL、`busy_timeout=5000` 和唯一幂等约束，不与 OpenCode 的会话 SQLite 共用写锁。
默认优先使用 `gpt-5.6-sol`；当动态目录中没有该模型时自动选择第一个对话模型。如果通过 `YEUTECH_DEFAULT_MODEL` 显式指定，则该模型必须存在于当前目录。

停止样本：

```bash
./scripts/stop-isolated.sh
```

运行态、密钥、日志和 OpenCode 二进制都位于 `.runtime/`，不会进入源码版本控制。

## 本地容量基线

2026-09-12 在当前 Mac 上使用 OpenCode `1.18.30` 和本地 CLIProxyAPI `7.2.156` 实测完整隔离栈：

| 并发实例 | 整批就绪时间 | 总 RSS | OpenCode | BFF | bridge |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.424s | 499.2MB | 382.5MB | 58.0MB | 58.7MB |
| 3 | 1.470s | 1499.6MB | 1149.3MB | 174.2MB | 176.0MB |
| 5 | 1.550s | 2496.9MB | 1912.0MB | 290.8MB | 294.2MB |

数据表明启动时间在 5 实例下仍稳定，内存主要随 OpenCode 实例数线性增长。生产架构应共享一套 BFF 和 bridge，只按租户隔离 OpenCode 数据目录和必要的执行实例，避免每个租户重复消耗约 117MB Node 进程内存。该基线不包含真实模型推理负载。

同日对同一隔离数据目录做了完整停止和重启：2 个会话、6 条消息的会话 ID、会话载荷与消息载荷哈希全部一致。这证明当前独立 OpenCode 数据目录可以恢复本地会话；不代表旧 Codex 数据已完成迁移。

历史加载使用临时数据库副本和符合 OpenCode schema 的合成消息，通过 BFF 的正式 `/session/:id/message` 接口读取。下表是 3 轮中位数；每轮都会完整停止并重启临时 OpenCode 和 BFF，响应哈希均保持一致：

| 消息数 | 首次读取 | 热读取 | 重启后首次读取 | JSON 大小 | OpenCode RSS | BFF RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 178ms | 5.0ms | 92ms | 62KB | 408.9MB | 59.4MB |
| 500 | 189ms | 10.0ms | 101ms | 311KB | 420.8MB | 62.5MB |
| 1000 | 195ms | 16.6ms | 110ms | 622KB | 448.1MB | 65.1MB |

这组数据只衡量本地历史读取和恢复，不包含模型推理。为了避免长会话把全部消息一次性挂入浏览器，历史会话首次只读取最近 10 条，滚到顶部后每次再向前加载 10 条并保持当前滚动位置。既有迁移历史与 OpenCode 原生会话都有同样的被动分页通道；首屏、向前加载和刷新都不依赖用户 Worker。运行时投影与被动历史以消息 ID 去重，附件路径在刷新后仍恢复为结构化文件标签。

可以随时重跑后端基准，脚本仅使用临时目录和 `19400/19401`，退出时会清理，不会停止当前隔离工作台：

```bash
./scripts/benchmark-history.sh
```

## 第一阶段验收

1. bridge 匿名和错误 token 请求返回 401。
2. OpenCode 匿名请求返回 401，且只绑定 loopback。
3. 动态对话模型数量与 CLIProxyAPI 当前目录过滤结果一致。
4. 选中的 CLIProxyAPI 模型能真实回复并稳定透传 SSE；模型目录成功不代表账号授权可用。
5. 客户端中止时终止对应 SSH/curl 子进程。
6. OpenCode 重启后会话可以从独立数据目录恢复。
7. 全程不访问 `18110`、线上 `codex.sqlite` 或现有项目目录。
8. BFF 覆盖浏览器传入的 `directory`，只允许访问当前签名用户的固定 Worker/workspace；另一用户不能读取或回复该用户的审批。
