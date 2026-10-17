const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { installFixtures } = require('../../qa-v3/visual-fixtures.cjs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const checks = [];
  try {
    for (const scenario of ['empty', 'failed']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await installFixtures(page, { theme: 'light', backgroundStyle: 'none' });
      await page.route('**/api/migration/projects', route => route.fulfill({ json: [] }));
      await page.route('**/api/workbench/bootstrap', async route => {
        if (scenario === 'failed') return route.fulfill({ status: 503, json: { error: 'Local QA unavailable' } });
        const original = await (await route.fetch()).json();
        await route.fulfill({ json: { ...original, sessions: [], projects: [], states: {}, permissions: [] } });
      });
      await page.goto('http://127.0.0.1:18148/');
      await page.getByText(scenario === 'empty' ? '创建会话，开始一个任务' : '工作区加载失败', { exact: true }).waitFor();
      assert.equal(await page.locator('h1').textContent(), 'AI 工作台');
      assert.ok(await page.getByRole('navigation', { name: '工作台导航' }).isVisible());
      if (scenario === 'failed') assert.ok(await page.locator('.workbench-summary').textContent().then(t => t.includes('连接失败')));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: __dirname + '/1440x900-' + scenario + '.png', animations: 'disabled' });
      assert.deepEqual(errors, []);
      checks.push({ scenario, titleAndNavRetained: true, appExceptions: errors, data: 'local browser fixture only', expectedHttpError: scenario === 'failed' ? 503 : null });
      await page.close();
    }
    fs.writeFileSync(__dirname + '/state-verification.json', JSON.stringify({ checks }, null, 2) + '\n');
    console.log('PASS empty workspace and bootstrap failure preserve title, navigation, original error/empty semantics');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
