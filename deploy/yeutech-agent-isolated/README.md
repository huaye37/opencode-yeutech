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

停止样本：

```bash
./scripts/stop-isolated.sh
```

运行态、密钥、日志和 OpenCode 二进制都位于 `.runtime/`，不会进入源码版本控制。

## 第一阶段验收

1. bridge 匿名和错误 token 请求返回 401。
2. OpenCode 匿名请求返回 401，且只绑定 loopback。
3. 动态对话模型数量与 CLIProxyAPI 当前目录过滤结果一致。
4. 选中的 CLIProxyAPI 模型能真实回复并稳定透传 SSE；模型目录成功不代表账号授权可用。
5. 客户端中止时终止对应 SSH/curl 子进程。
6. OpenCode 重启后会话可以从独立数据目录恢复。
7. 全程不访问 `18110`、线上 `codex.sqlite` 或现有项目目录。
8. BFF 覆盖浏览器传入的 `directory`，只允许访问固定样本工作区。
