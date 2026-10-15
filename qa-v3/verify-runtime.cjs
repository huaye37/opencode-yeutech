// Additional UI regression against the existing local mock, NOT a live model test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { installFixtures } = require('./visual-fixtures.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const checks = [];
  try {
    await installFixtures(page);
    await page.goto(process.env.YEUTECH_V3_QA_URL || 'http://127.0.0.1:18148/');
    await page.getByRole('textbox', { name: '向 Agent 发送消息' }).waitFor();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    // File uploads use the existing XHR mock, preserving progress/cancel handlers.
    const upload = page.waitForResponse(r => r.url().includes('/attachments') && r.request().method() === 'POST');
    await page.locator('.composer-tools input[type="file"]').setInputFiles({ name: 'v3-qa.txt', mimeType: 'text/plain', buffer: Buffer.from('Local QA attachment, not production data.') });
    assert.equal((await upload).status(), 201);
    await page.getByLabel('已附加文件').waitFor();
    checks.push('upload -> persisted attachment reference');
    const input = page.getByRole('textbox', { name: '向 Agent 发送消息' });
    await input.fill('本地 UI 回归：检查附加文件，不调用真实模型。');
    const prompt = page.waitForResponse(r => r.url().includes('/prompt_async') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const response = await prompt;
    assert.equal(response.status(), 204);
    const body = response.request().postDataJSON();
    assert.equal(body.model.modelID, 'gpt-6.1-sol');
    assert.equal(body.yeutech.reasoningEffort, 'ultra');
    assert.equal(body.yeutech.serviceTier, 'ultrafast');
    assert.ok(body.yeutech.paths.length > 0);
    assert.equal(await input.inputValue(), '');
    await page.getByRole('button', { name: '停止', exact: true }).waitFor();
    checks.push('send -> original prompt payload (Ultra + Ultrafast + attachment) -> running state');
    await page.getByRole('button', { name: '仅本次允许' }).waitFor();
    const permission = page.waitForResponse(r => r.url().includes('/permission/') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '仅本次允许' }).click();
    assert.equal((await permission).request().postDataJSON().reply, 'once');
    await page.getByRole('button', { name: '仅本次允许' }).waitFor({ state: 'hidden' });
    checks.push('SSE permission projection -> single-use approval -> removal');
    const abort = page.waitForResponse(r => r.url().includes('/abort') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    assert.equal((await abort).status(), 200);
    await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
    assert.ok(await input.isVisible());
    checks.push('stop -> abort -> terminal SSE reconciliation -> composer retained');
    // Assert project creation/navigation against explicit browser fixtures; the mock
    // server deliberately has no draft/project-management backend implementation.
    await page.route('**/api/workbench/session-drafts', async route => {
      const payload = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { data: { id: 'ses_local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: payload.title, projectId: payload.projectId, model: { id: payload.modelId }, time: { updated: Date.now() } } } });
    });
    await page.getByRole('button', { name: '新建独立会话', exact: true }).click();
    await page.getByRole('heading', { name: '新会话', exact: true }).waitFor();
    checks.push('new independent-session entry -> draft selection (browser fixture)');
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByRole('dialog', { name: '新建项目' }).waitFor();
    assert.ok(await page.getByRole('button', { name: '创建并进入' }).isDisabled());
    await page.getByRole('button', { name: '关闭新建项目' }).last().click();
    await page.getByRole('button', { name: '扫描 NAS 项目', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    checks.push('project creation and NAS discovery dialogs preserved');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '返回会话与项目目录' }).click();
    await page.getByRole('button', { name: '在 家庭网络中枢 中新建会话' }).click();
    await page.getByRole('heading', { name: '新项目会话', exact: true }).waitFor();
    assert.ok(await input.isVisible());
    assert.equal(await page.getByRole('heading', { name: '会话与项目' }).isVisible(), false);
    checks.push('mobile project draft creation -> conversation pushed in (browser fixture)');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(__dirname, 'runtime-verification.json'), JSON.stringify({ scope: 'local mock UI requests/events only; no actual model or NAS execution', checks, errors }, null, 2));
    console.log(checks.map(check => 'PASS ' + check).join('\n'));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
