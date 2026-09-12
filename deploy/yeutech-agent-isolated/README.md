# YEUTECH OpenCode 隔离验证环境

这是一套与线上 Codex 工作台并列、完全独立的 OpenCode Agent 后端样本。第一阶段只验证执行后端，不接门户、不配域名、不读取 `codex.sqlite`，也不挂载现有项目目录。

## 隔离边界

- OpenCode 仅监听 `127.0.0.1:18130`；NAS bridge 仅监听 `127.0.0.1:18132`。
- 现有 Codex 的 `18110`、进程、数据库和项目空间不在脚本操作范围内。
- OpenCode 使用独立的 XDG 配置、数据、缓存和状态目录。
- 测试工作区为空目录，并设为文件系统只读；OpenCode 权限同时禁用 `edit`、`bash` 和 `external_directory`。
- bridge 只转发 `/v1/models` 和 `/v1/chat/completions`，要求独立 Bearer token，不保存或输出 NAS API Key。
- NAS API Key 只在 NAS 本机由固定路径读取；当前 SSH bridge 是隔离验证手段，不是最终生产网络架构。

## 本地检查

```bash
npm test
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

启动脚本会生成独立 bridge token 和 OpenCode Basic Auth 密码，动态读取 NAS `/v1/models`，过滤图片模型与 `codex-auto-review`，再生成只读 `opencode.json`。任一新端口已被占用时脚本会拒绝启动。

停止样本：

```bash
./scripts/stop-isolated.sh
```

运行态、密钥、日志和 OpenCode 二进制都位于 `.runtime/`，不会进入源码版本控制。

## 第一阶段验收

1. bridge 匿名和错误 token 请求返回 401。
2. OpenCode 匿名请求返回 401，且只绑定 loopback。
3. 动态对话模型数量与 NAS 当前目录过滤结果一致。
4. 默认模型 `gpt-5.6-sol` 能真实回复并稳定透传 SSE。
5. 客户端中止时终止对应 SSH/curl 子进程。
6. OpenCode 重启后会话可以从独立数据目录恢复。
7. 全程不访问 `18110`、线上 `codex.sqlite` 或现有项目目录。
