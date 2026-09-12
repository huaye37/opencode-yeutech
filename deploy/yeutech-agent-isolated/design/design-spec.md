# AI 工作台视觉规范 v2

当前规范不再使用 `ai-workbench-concept-v1.png`。它是已废弃的通用白底三栏概念稿，不得用于后续视觉验收。

唯一视觉基线是现有门户 Codex 工作台：

- `yeutech-home-platform/frontend/components/codex/codex-workbench-client.tsx`
- `yeutech-home-platform/frontend/app/globals.css`
- `yeutech-home-platform/frontend/components/portal/brand.tsx`

实现约束：

- 背景使用门户网格、蓝色与青绿环境光，不用纯白页面。
- 顶部保留“AI 工作台 / 检查并恢复连接 / 返回门户”骨架。
- 主区域是一个圆角玻璃 `command-stage`，内部为项目会话左栏和对话主区。
- 执行轨迹、重试和错误进入消息流，不设独立右栏。
- 输入器为底部液态玻璃控件，模型目录来自 CLIProxyAPI 动态返回。
- 880px 以下折叠左栏；390 × 844 下不允许水平溢出，消息与输入器仍可用。
- 运行态必须区分“CLIProxyAPI 已连通”、“模型账号授权不可用”和“真实模型回复成功”。
