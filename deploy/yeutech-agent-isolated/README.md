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

## 第一阶段验收

1. bridge 匿名和错误 token 请求返回 401。
2. OpenCode 匿名请求返回 401，且只绑定 loopback。
3. 动态对话模型数量与 CLIProxyAPI 当前目录过滤结果一致。
4. 选中的 CLIProxyAPI 模型能真实回复并稳定透传 SSE；模型目录成功不代表账号授权可用。
5. 客户端中止时终止对应 SSH/curl 子进程。
6. OpenCode 重启后会话可以从独立数据目录恢复。
7. 全程不访问 `18110`、线上 `codex.sqlite` 或现有项目目录。
8. BFF 覆盖浏览器传入的 `directory`，只允许访问固定样本工作区。
