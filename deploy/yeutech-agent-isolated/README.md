# YEUTECH OpenCode 隔离验证环境

这是一套与线上 Codex 工作台并列、完全独立的 OpenCode Agent 后端样本。第一阶段只验证执行后端，不接门户、不配域名、不读取 `codex.sqlite`，也不挂载现有项目目录。

## 隔离边界

- OpenCode 仅监听 `127.0.0.1:18130`；Agent BFF 仅监听 `127.0.0.1:18131`；NAS bridge 仅监听 `127.0.0.1:18132`。
- 现有 Codex 的 `18110`、进程、数据库和项目空间不在脚本操作范围内。
- OpenCode 使用独立的 XDG 配置、数据、缓存和状态目录。
- 测试工作区为空目录，并设为文件系统只读；OpenCode 权限同时禁用 `edit`、`bash` 和 `external_directory`。
- bridge 只转发 `/v1/models` 和 `/v1/chat/completions`，要求独立 Bearer token，不保存或输出 NAS API Key。
- 浏览器侧只能接 Agent BFF。BFF 使用独立 Bearer token，把所有 OpenCode 请求固定到样本工作区，并拒绝 Shell、Command、Share 等未授权接口。
- 当前 BFF 是单用户、单项目隔离样本，不代表多租户已完成；门户接入前还需要把门户用户和项目权限映射成服务端可验证的会话归属。
- 模型层固定使用现有 CLIProxyAPI；工作台、BFF 和会话协议不绑定具体地址。本地验证仅允许 loopback HTTP，部署时再切换受控的 NAS 地址。

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

历史正文始终只读。点击“继续此会话”时，服务创建一个新的 OpenCode session，并使用 `noReply: true` 写入最多 24,000 字符的迁移上下文，因此不会自动调用模型；映射保存在 `.runtime/migration/mappings.json`，再次继续同一旧会话会复用新 session。旧 thread/session ID、隐藏消息、推理、工具句柄、审批、登录态和运行中进程不会被伪装成已恢复。

当前只完成本机单用户可用链路。用户、项目权限和多租户隔离要等 NAS 可用后再接门户验证；浏览器不能传入数据库、项目根目录或 OpenCode workspace 的任意路径。

当前快照盘点为 11 个项目分组、64 个去重历史会话和 3,236 条可见历史消息；其中门户原生 63 个会话/1,726 条消息，旧导入 8 个会话/1,510 条事件。数字同时写入 `metadata/project-inventory.json`，后续换快照时应重新生成，不在前端写死。

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
