// Browser plugin not available; existing Playwright + system Chrome, local production preview only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { installFixtures } = require('../../qa-v3/visual-fixtures.cjs');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const checks = [];
  try {
    for (const [width, height] of [[1440, 900], [2560, 1440], [390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      await installFixtures(page, { backgroundStyle: 'none' });
      await page.goto('http://127.0.0.1:18148/');
      await page.locator('.session-row-main').first().waitFor();
      if (width === 390) await page.getByRole('navigation', { name: '工作台导航' }).getByRole('button', { name: '对话', exact: true }).click();
      const audit = await page.evaluate(() => {
        const css = selector => getComputedStyle(document.querySelector(selector));
        const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const nested = [...document.querySelectorAll('body *')].filter(visible).filter(e => getComputedStyle(e).backdropFilter !== 'none').flatMap(e => {
          for (let p = e.parentElement; p; p = p.parentElement) if (getComputedStyle(p).backdropFilter !== 'none') return [e.className];
          return [];
        });
        return {
          width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, nested,
          header: { height: document.querySelector('.workbench-identity').getBoundingClientRect().height, padding: css('.workbench-identity').paddingInline, shadow: css('.workbench-identity').boxShadow },
          main: { maxWidth: css('.workspace').maxWidth, padding: css('.workspace').paddingTop },
          nav: { position: css('.workbench-tabs').position, height: document.querySelector('.workbench-tabs button').getBoundingClientRect().height, font: css('.workbench-tabs button').fontSize, gap: css('.workbench-tabs').gap, blur: css('.workbench-tabs').backdropFilter },
          heading: { size: css('.workbench-summary h1').fontSize, weight: css('.workbench-summary h1').fontWeight, lineHeight: css('.workbench-summary h1').lineHeight, letterSpacing: css('.workbench-summary h1').letterSpacing, subtitle: css('.workbench-summary p').fontSize, subtitleMargin: css('.workbench-summary p').marginTop },
          layout: { columns: css('.home-workbench-layout').gridTemplateColumns, gap: css('.home-workbench-layout').gap },
          composer: { blur: css('.composer').backdropFilter, bottom: document.querySelector('.composer').getBoundingClientRect().bottom },
          directory: { heading: css('.directory-heading').fontSize, shadow: css('.sidebar').boxShadow, blur: css('.sidebar').backdropFilter },
          conversation: { shadow: css('.conversation').boxShadow, blur: css('.conversation').backdropFilter },
          pageHeadings: document.querySelectorAll('h1').length,
        };
      });
      assert.equal(audit.overflow, false);
      assert.deepEqual(audit.nested, []);
      assert.equal(audit.header.height, width === 390 ? 52 : 56);
      assert.equal(audit.header.padding, width === 390 ? '16px' : width === 2560 ? '48px' : '32px');
      assert.equal(audit.header.shadow, 'none');
      assert.equal(audit.main.maxWidth, '2400px');
      assert.equal(audit.nav.position, 'static');
      assert.equal(audit.nav.height, 44); assert.equal(audit.nav.font, '15px'); assert.equal(audit.nav.gap, '4px');
      assert.equal(audit.heading.size, '34px'); assert.equal(audit.heading.weight, '650');
      assert.equal(audit.heading.lineHeight, '42.5px'); assert.equal(audit.heading.subtitleMargin, '12px');
      assert.equal(audit.heading.subtitle, width === 390 ? '15px' : '17px');
      assert.equal(audit.composer.blur, 'none'); assert.equal(audit.pageHeadings, 1);
      assert.equal(audit.directory.heading, '22px'); assert.equal(audit.directory.shadow, 'none');
      assert.equal(audit.conversation.shadow, 'none');
      if (width === 390) assert.ok(audit.composer.bottom <= 844, 'composer fits first mobile viewport');
      if (width === 1440) assert.ok(audit.layout.columns.endsWith('200px'));
      if (width === 2560) assert.ok(audit.layout.columns.endsWith('240px'));
      await page.getByRole('button', { name: '搜索会话与项目 (⌘K)', exact: true }).click();
      await page.getByRole('textbox', { name: '搜索会话与项目', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索会话与项目');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: '搜索会话与项目 (⌘K)', exact: true }).evaluate(e => e === document.activeElement), true);
      await page.keyboard.press('Control+k');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索会话与项目');
      checks.push({ ...audit, searchTriggerAndShortcutAndEscape: true });
      await page.close();
    }
    fs.writeFileSync(__dirname + '/home-language-verification.json', JSON.stringify({ checks }, null, 2) + '\n');
    console.log('PASS exact home geometry, static horizontal nav, single h1, mobile composer, no nested blur, header search/shortcut/Escape');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
