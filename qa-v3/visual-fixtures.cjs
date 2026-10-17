// Local visual/interaction fixture only. Never connects to production or calls a model.
const selected = 'ses_mock_history';
const now = Date.parse('2026-10-16T21:20:00+08:00');
const project = { id: 'project-mock', name: '家庭网络中枢', workspaceDirectory: '家庭网络中枢', registered: true, availableLocally: true, conversationCount: 2 };
const sessions = [
  { id: selected, title: '门户 v3 界面联调', projectId: project.id, model: { id: 'gpt-6.1-sol' }, time: { created: now, updated: now } },
  { id: 'ses_mock_design', title: '整理全站视觉检查清单', projectId: project.id, model: { id: 'gpt-6.1-sol' }, time: { created: now - 60_000, updated: now - 60_000 } },
  { id: 'ses_mock_notes', title: '梳理 NAS 备份计划', model: { id: 'gpt-6.1-sol' }, time: { created: now - 600_000, updated: now - 600_000 } },
];
const messages = [
  { id: 'msg_mock_1', role: 'user', text: '检查这套工作台：会话、项目和文件入口都需要保留。先整理一份界面检查清单。', createdAt: now - 6000 },
  { id: 'msg_mock_2', role: 'assistant', text: '## 界面检查清单\n\n按当前工作区的三个区域检查，不改动任务执行流程。\n\n- **会话与项目**：最近会话、项目切换、搜索和管理菜单。\n- **对话工作区**：消息、执行轨迹、模型与独立偏好。\n- **文件检查器**：目录浏览、预览、下载和附加到本轮。\n\n下一步先检查手机目录，再检查文件预览。', createdAt: now - 5000, completedAt: now - 1000 },
];
async function installFixtures(page, appearance = {}) {
  await page.addInitScript(({ selected, project }) => localStorage.setItem('yeutech-agent-workbench:selected:v2', JSON.stringify({ sessionId: selected, projectId: project.id })), { selected, project });
  await page.route('**/api/portal/appearance*', route => route.fulfill({ json: { ok: true, settings: { theme: 'light', backgroundStyle: 'none', ...appearance } } }));
  await page.route('**/api/workbench/bootstrap', async route => {
    const original = await (await route.fetch()).json();
    await route.fulfill({ json: { ...original, sessions, projects: [project], states: {}, permissions: [] } });
  });
  await page.route('**/api/migration/projects', route => route.fulfill({ json: [project] }));
  await page.route('**/api/migration/conversations', route => route.fulfill({ json: [] }));
  await page.route('**/api/workbench/sessions/*/messages?*', async route => {
    const original = await (await route.fetch()).json();
    await route.fulfill({ json: { ...original, records: messages, messages, permissions: [], trajectory: [], activity: [], session: { id: selected, status: null } } });
  });
  // These presentation-only endpoints are not implemented by the legacy local mock.
  await page.route('**/api/workbench/plugins*', route => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/agent/session/*/diff', route => route.fulfill({ json: [] }));
}
module.exports = { selected, project, sessions, messages, installFixtures };
