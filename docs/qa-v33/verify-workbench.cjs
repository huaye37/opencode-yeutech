/* Run with the repo's local mock on 18141 and production preview on 18148.
   NODE_PATH=<your Playwright node_modules> node qa-v3/verify-workbench.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { installFixtures, selected } = require('../../qa-v3/visual-fixtures.cjs');
const base = process.env.YEUTECH_V3_QA_URL || 'http://127.0.0.1:18148/';
const out = __dirname;
const checks = [];
const errors = [];
const screenshots = [];
const check = (name, detail = '') => { checks.push({ name, status: 'pass', detail }); console.log('PASS', name, ...(detail ? [detail] : [])); };
const browserOptions = { headless: true, channel: 'chrome' };
async function inspect(page, label) {
  assert.equal(new URL(page.url()).origin, new URL(base).origin);
  assert.ok((await page.title()).includes('YEUTECH'));
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.equal(await page.getByText('暂时无法显示', { exact: false }).count(), 0);
  const audit = await page.evaluate(() => {
    const visible = e => { const r = e.getBoundingClientRect(); return r.width && r.height && getComputedStyle(e).visibility !== 'hidden'; };
    const fonts = [...new Set([...document.querySelectorAll('body *')].filter(e => visible(e) && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => getComputedStyle(e).fontSize))];
    return { overflow: document.documentElement.scrollWidth > innerWidth, fonts, wallpaper: getComputedStyle(document.querySelector('.portal-shell'), '::before').display, stage: getComputedStyle(document.querySelector('.command-stage')).boxShadow, height: document.querySelector('.workspace').getBoundingClientRect().height };
  });
  assert.equal(audit.overflow, false, label + ' horizontal overflow');
  assert.equal(audit.wallpaper, 'block');
  assert.equal(audit.stage, 'none');
  assert.ok(audit.fonts.every(size => ['0px', '13px', '15px', '17px', '22px', '34px'].includes(size)), JSON.stringify(audit.fonts));
  check(label + ': page/layout/type audit', JSON.stringify(audit));
}
async function capture(page, name) {
  await page.screenshot({ path: path.join(out, name), fullPage: false, animations: 'disabled' }); screenshots.push(name);
}
async function createPage(browser, width, height, theme, appearance = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await installFixtures(page, { theme, backgroundStyle: 'image', ...appearance });
  await page.route('**/backgrounds/*.webp', route => route.fulfill({ path: '/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/yeutech-home-platform/frontend/public/backgrounds/' + new URL(route.request().url()).pathname.split('/').at(-1) }));
  await page.goto(base);
  await page.locator('.session-row-main').filter({ hasText: '门户 v3 界面联调' }).waitFor();
  await page.waitForFunction(theme => document.documentElement.dataset.ytTheme === theme, theme);
  await page.waitForTimeout(200);
  return page;
}
(async () => {
  const browser = await chromium.launch(browserOptions);
  try {
    for (const [width, height] of [[1440, 900], [2560, 1440], [390, 844]]) {
      for (const theme of ['light', 'dark']) {
        const page = await createPage(browser, width, height, theme);
        await inspect(page, `${width}x${height} ${theme}`);
        await capture(page, `${width}x${height}-${theme}.png`);
        if (width === 390) {
          assert.ok(await page.locator('.service-name').isVisible());
          assert.ok(await page.getByRole('navigation', { name: '工作台导航' }).isVisible());
          await page.locator('.session-row-main').filter({ hasText: '门户 v3 界面联调' }).click();
          assert.ok(await page.getByRole('textbox', { name: '向 Agent 发送消息' }).isVisible());
          const actions = ['查看当前会话的文件变更', '导出当前会话', '进入专注模式', '打开文件与附件'];
          for (const name of actions) {
            const box = await page.getByRole('button', { name, exact: true }).boundingBox();
            assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.height >= 40, name);
          }
          await inspect(page, `mobile detail ${theme}`);
          await capture(page, `390x844-${theme}-conversation.png`);
          const tabs = page.getByRole('navigation', { name: '工作台导航' });
          await tabs.getByRole('button', { name: '会话与项目', exact: true }).click();
          assert.ok(await page.locator('.service-name').isVisible());
          await tabs.getByRole('button', { name: '对话', exact: true }).click();
          assert.ok(await page.getByRole('textbox', { name: '向 Agent 发送消息' }).isVisible());
          await tabs.getByRole('button', { name: '任务状态', exact: true }).click();
          assert.ok(await page.getByRole('dialog').isVisible());
          await page.getByRole('button', { name: '关闭任务状态', exact: true }).last().click();
          check('mobile ' + theme + ': bottom tabs directory / conversation / task dialog');
          await page.getByRole('navigation', { name: '工作台导航' }).getByRole('button', { name: '文件', exact: true }).click();
          await page.getByRole('button', { name: /设定.md/ }).click();
          await page.locator('.document-preview').waitFor();
          assert.ok(await page.locator('.document-preview').isVisible());
          const fileHeader = await page.locator('.file-panel > header').boundingBox();
          assert.ok(fileHeader.y >= 52, 'file header below site header');
          await inspect(page, `mobile file detail ${theme}`);
          await capture(page, `390x844-${theme}-files.png`);
          await page.getByRole('button', { name: '关闭文件面板' }).click();
          await page.getByRole('button', { name: '返回会话与项目目录' }).click();
          assert.ok(await page.locator('.service-name').isVisible());
          assert.ok(await page.getByRole('navigation', { name: '工作台导航' }).isVisible());
          check(`mobile ${theme}: directory -> conversation -> files -> return`);
        }
        await page.close();
      }
    }
    const page = await createPage(browser, 1440, 900, 'light');
    await page.getByRole('textbox', { name: '搜索会话与项目' }).fill('备份');
    assert.equal(await page.locator('.session-row-main:visible').count(), 1);
    await page.getByRole('textbox', { name: '搜索会话与项目' }).fill('');
    assert.equal(await page.locator('.session-row-main:visible').count(), 3);
    check('session/project search and shared directory');
    await page.getByRole('button', { name: '管理会话 门户 v3 界面联调' }).click();
    for (const name of ['重命名', 'Fork 会话', '删除会话']) assert.ok(await page.getByRole('menuitem', { name, exact: true }).isVisible());
    await page.keyboard.press('Escape');
    check('session rename/Fork/delete entries preserved');
    const preference = () => page.waitForResponse(r => r.url().includes('/session-preferences/') && r.request().method() === 'PATCH');
    const ultra = preference(); await page.getByRole('combobox', { name: '推理强度' }).selectOption('ultra'); await ultra;
    const fast = preference(); await page.getByRole('combobox', { name: '响应速度' }).selectOption('ultrafast'); const fastResponse = await fast;
    assert.equal(fastResponse.request().postDataJSON().reasoningEffort, 'ultra');
    assert.equal(fastResponse.request().postDataJSON().serviceTier, 'ultrafast');
    await page.reload(); await page.getByRole('combobox', { name: '推理强度' }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: '推理强度' }).inputValue(), 'ultra');
    assert.equal(await page.getByRole('combobox', { name: '响应速度' }).inputValue(), 'ultrafast');
    check('Ultra / Ultrafast independent persistence', 'real local mock preference API; reload readback');
    await page.getByRole('button', { name: '模型能力', exact: true }).click();
    assert.ok(await page.getByRole('dialog').isVisible());
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '插件中心', exact: true }).click();
    assert.ok(await page.getByRole('dialog').isVisible()); await page.keyboard.press('Escape');
    check('capabilities, skills/profiles and plugin entry');
    await page.getByRole('button', { name: 'Agent 控制台', exact: true }).click();
    const goal = page.waitForResponse(r => r.url().endsWith('/goals') && r.request().method() === 'POST');
    await page.getByPlaceholder('记下这次要完成的事').fill('v3 本地界面回归');
    await page.getByRole('button', { name: '添加', exact: true }).click(); await goal;
    assert.ok(await page.getByText('v3 本地界面回归', { exact: true }).last().isVisible());
    await page.getByText('高级信息', { exact: false }).click();
    assert.ok(await page.getByText('运行容量', { exact: true }).isVisible());
    await capture(page, '1440x900-light-control.png'); await page.getByRole('button', { name: '关闭任务状态' }).last().click();
    check('control center / goal create / advanced budget & context');
    await page.getByRole('button', { name: '打开文件与附件' }).click();
    await page.getByRole('textbox', { name: '搜索当前目录文件' }).fill('设定');
    await page.getByRole('button', { name: /设定.md/ }).click();
    await page.locator('.document-preview').waitFor();
          assert.ok(await page.locator('.document-preview').isVisible());
    await page.getByRole('button', { name: '放大文件预览' }).click();
    assert.ok(await page.locator('.file-expanded').isVisible());
    await page.getByRole('button', { name: '恢复文件面板大小' }).click();
    await page.getByRole('button', { name: '交给 Agent' }).click();
    assert.ok(await page.getByLabel('已附加文件').isVisible());
    await capture(page, '1440x900-light-files.png');
    await page.getByRole('button', { name: '关闭文件面板' }).click();
    check('files search / Markdown preview / expand & restore / attach');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出当前会话' }).click();
    assert.equal((await download).suggestedFilename(), '门户 v3 界面联调.md');
    check('Markdown export preserved');
    await page.getByRole('button', { name: '进入专注模式' }).click();
    assert.ok(await page.locator('.workspace.focus-mode').isVisible());
    await page.getByRole('button', { name: '退出专注模式' }).click();
    await page.getByRole('button', { name: '收起项目栏' }).click();
    assert.ok(await page.getByRole('button', { name: '展开项目栏' }).isVisible());
    await page.getByRole('button', { name: '展开项目栏' }).click();
    const separator = page.getByRole('separator', { name: '调整项目目录宽度' });
    const before = await separator.getAttribute('aria-valuenow'); await separator.focus(); await page.keyboard.press('ArrowRight');
    assert.notEqual(await separator.getAttribute('aria-valuenow'), before);
    check('focus, sidebar collapse and keyboard resizing');
    await page.getByRole('button', { name: '账户与设置', exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: '外观设置' }).getAttribute('href'), 'https://yeutech.cn/settings/?site=agent');
    await page.keyboard.press('Escape'); assert.equal(await page.getByRole('button', { name: '账户与设置' }).getAttribute('aria-expanded'), 'false');
    check('portal brand/account/settings and keyboard menu');
    await page.close();
    // Appearance boundaries still use the unchanged portal contract runtime.
    for (const [name, appearance] of [['square-min', { cornerRadius: 0, surfaceOpacity: 0, materialOpacity: 0, chromeOpacity: 0, controlOpacity: 0, overlayOpacity: 0 }], ['max', { cornerRadius: 40, surfaceOpacity: 100, materialOpacity: 100, chromeOpacity: 100, controlOpacity: 100, overlayOpacity: 100 }]]) {
      const p = await createPage(browser, 1440, 900, 'dark', { ...appearance, backgroundStyle: 'image', darkBackgroundImage: '/backgrounds/dark-structure.webp', backgroundOpacity: 100 });
      await inspect(p, 'appearance ' + name);
      if (name === 'square-min') assert.equal(await p.locator('.composer').evaluate(e => getComputedStyle(e).borderRadius), '0px');
      const cdp = await p.context().newCDPSession(p);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-contrast', value: 'more' }, { name: 'prefers-reduced-transparency', value: 'reduce' }] });
      assert.ok(await p.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches));
      await inspect(p, 'accessibility ' + name);
      assert.equal(await p.locator('.sidebar').evaluate(e => getComputedStyle(e).backdropFilter), 'none');
      await capture(p, `1440x900-${name}-accessibility.png`); await p.close();
    }
    assert.deepEqual(errors, [], 'browser errors');
    check('no console or page errors');
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ base, browser: 'Playwright Chrome headless', data: 'local mock + presentation fixtures; no production/model calls', checks, screenshots, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
