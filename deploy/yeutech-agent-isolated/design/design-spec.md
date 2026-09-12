# AI 工作台复刻规范 v3

当前规范不再使用 `ai-workbench-concept-v1.png`。它是已废弃的通用白底三栏概念稿，不是当前产品的验收基线。

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
- 项目与会话的名称、层级和选中方式保持门户习惯；未归属数据放入“独立会话”，不构造 `Project A` 或重复的“未归属项目”。
- 原会话第一次发送时静默建立 OpenCode 映射；用户仍看到原会话 ID、一个会话条目和连续消息流。
- 迁移上下文是 OpenCode 内部 seed，不显示为巨大的用户气泡。
- 切换会话时必须清除上一会话的运行态，并仅恢复当前会话的 Agent 状态。

可以添加但不改变原工作流的本地增强：会话搜索、Markdown 导出、移动端项目抽屉和专注模式。附件、项目文件和权限在真实接口接入前必须显式禁用，不允许用静态界面伪装成已恢复。
