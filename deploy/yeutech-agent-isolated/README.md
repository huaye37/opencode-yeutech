# YEUTECH Agent 工作台

这是一套运行在 NAS、与线上 Codex 工作台并列且数据隔离的 OpenCode Agent 工作台。第一阶段只恢复 Ryan（`user_id=3`）的项目和会话，不连接线上 `codex.sqlite`。历史正文读取 2026-09-12 的一致性数据库副本，NAS 项目目录只读挂载；新会话、OpenCode 状态和迁移映射写入独立的 `/volume1/docker/yeutech-agent/runtime`。

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

- `/volume2/codex项目空间:/projects:ro`
- `/volume1/docker/yeutech-agent/data:/data:ro`
- CLIProxyAPI key 只读挂载到 `/run/secrets/cliproxy.key`
- `novel-ai-proxy:cliproxy` 只用于容器内访问 `http://cliproxy:8317`
- OpenCode `18130` 和 migration `18142` 仅监听容器 loopback
- 浏览器统一访问 `http://NAS-IP:18140/`

## 隔离边界

- OpenCode 仅监听容器内 `127.0.0.1:18130`；migration 仅监听容器内 `127.0.0.1:18142`；BFF 和静态前端监听 `0.0.0.0:18140`。
- 现有 Codex 的 `18110`、进程、数据库和项目空间不在脚本操作范围内。
- OpenCode 使用独立的 XDG 配置、数据、缓存和状态目录。
- 项目工作区由 BFF 固定为 `/projects/ryan`，挂载为文件系统只读；OpenCode 权限同时禁用 `edit`、`bash` 和 `external_directory`。
- 浏览器侧只能接同源 BFF。BFF 把 OpenCode 请求固定到 Ryan 工作区，并拒绝 Shell、Command、Share 等未授权接口。
- 当前 BFF 是单用户、单项目隔离样本，不代表多租户已完成；门户接入前还需要把门户用户和项目权限映射成服务端可验证的会话归属。
- 模型层固定复用 NAS 现有 CLIProxyAPI，模型目录在容器启动时动态读取，不在前端写死。

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

## 历史项目和会话恢复

2026-09-12 的隔离迁移样本固定读取以下本地快照，不连接 NAS 或正式 `codex.sqlite`：

```text
/Users/fangjialiang/Documents/家庭网络中枢项目/04_工具与运维/本地备份/codex迁移源数据/2026-09-12/
├── projects/       # NAS 项目空间副本，保留 .git、隐藏目录和独立会话附件
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

启动脚本会生成独立 portal token、bridge token 和 OpenCode Basic Auth 密码，动态读取 NAS `/v1/models`，过滤图片模型与 `codex-auto-review`，再生成只读 `opencode.json`。任一新端口已被占用时脚本会拒绝启动。
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

这组数据只衡量本地历史读取和恢复，不包含模型推理。为了避免长会话把全部消息一次性挂入浏览器，工作台现在使用 OpenCode 原生 cursor 分页：首次读取最近 200 条，并允许每次向前加载 200 条。Chrome 的 1000 条样本验证中，首屏 DOM 从 7135 个节点降到 1536 个节点；最新 200 条、向前加载到 400 条、输入与滚动均正常，控制台无错误。

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
8. BFF 覆盖浏览器传入的 `directory`，只允许访问固定样本工作区。
