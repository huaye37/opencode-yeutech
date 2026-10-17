const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { installFixtures } = require('../qa-v3/visual-fixtures.cjs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const checks = [];
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await installFixtures(page, { backgroundStyle: 'plain' });
      await page.goto('http://127.0.0.1:18148/');
      await page.locator('.session-row-main').first().waitFor();
      if (width === 390) await page.getByRole('navigation', { name: '工作台导航' }).getByRole('button', { name: '对话', exact: true }).click();
      const audit = await page.evaluate(() => {
        const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const nested = [...document.querySelectorAll('body *')].filter(visible).filter(e => getComputedStyle(e).backdropFilter !== 'none').flatMap(e => {
          for (let parent = e.parentElement; parent; parent = parent.parentElement) {
            if (getComputedStyle(parent).backdropFilter !== 'none') return [e.className];
          }
          return [];
        });
        return {
          nested,
          toolbarCount: document.querySelectorAll('.workbench-toolbar').length,
          sidebar: getComputedStyle(document.querySelector('.sidebar')).backdropFilter,
          conversation: getComputedStyle(document.querySelector('.conversation')).backdropFilter,
          composer: getComputedStyle(document.querySelector('.composer')).backdropFilter,
          header: getComputedStyle(document.querySelector('.conversation-header')).backgroundColor,
          pageMaxWidth: getComputedStyle(document.querySelector('.command-stage')).maxWidth,
        };
      });
      assert.deepEqual(audit.nested, []);
      assert.equal(audit.toolbarCount, 0);
      assert.notEqual(audit.conversation, 'none');
      assert.equal(audit.composer, 'none');
      assert.equal(audit.header, 'rgba(0, 0, 0, 0)');
      assert.equal(audit.pageMaxWidth, 'none');
      checks.push({ width, ...audit });
      await page.close();
    }
    fs.writeFileSync(__dirname + '/glass-verification.json', JSON.stringify({ checks }, null, 2) + '\n');
    console.log('PASS sibling glass / no nested blur / no top toolbar / unconstrained width');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
