const assert=require('node:assert/strict'),fs=require('node:fs/promises');
const {chromium}=require('/Users/fangjialiang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const {installFixtures}=require('/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/.worktrees/v3-agent/qa-v3/visual-fixtures.cjs');
(async()=>{const browser=await chromium.launch({channel:'chrome'}),results=[],errors=[];try{
for(const site of ['agent'])for(const width of [1440,390])for(const variant of ['radius-zero-low','opacity-high','reduced-transparency','contrast']){
 const page=await browser.newPage({viewport:{width,height:width===390?844:900},reducedMotion:'reduce'});page.on('pageerror',e=>errors.push(e.message));
 const appearance={theme:'light',backgroundStyle:'none',cornerRadius:variant==='radius-zero-low'?0:14,surfaceOpacity:variant==='radius-zero-low'?0:100};
 if(site==='agent')await installFixtures(page,appearance);else await page.route(site==='api'?'**/api/appearance':'**/api/portal/appearance?*',r=>r.fulfill({json:{ok:true,settings:appearance}}));
 if(site==='api')await page.route('**/api/nodes/tokyo/**',r=>r.fulfill({json:{reachable:false,message:'Local fixture'}}));
 if(variant==='reduced-transparency'){const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-reduced-motion',value:'reduce'}]});}if(variant==='contrast')await page.emulateMedia({contrast:'more'});
 await page.goto('http://127.0.0.1:'+({api:28327,agent:18149,worklog:3197}[site]));let target;
 if(site==='api'){await page.locator('#overview').waitFor({state:'visible'});await page.locator('.nav-rail [data-tab=update]').click();target=page.locator('#update > .data-section').first();}
 if(site==='agent'){await page.locator('.session-row-main').first().waitFor();await page.getByRole('navigation',{name:'工作台导航'}).getByRole('button',{name:'任务状态',exact:true}).click();target=page.getByRole('dialog',{name:'任务状态'});}
 if(site==='worklog'){if(width===390)await page.getByTestId('nav-archive').click();await page.locator('.requirement-row-button').first().click();target=page.getByTestId('requirement-inspector');}
 await target.waitFor();const state=await target.evaluate(e=>{const s=getComputedStyle(e),root=document.documentElement;return {radius:s.borderRadius,filter:s.backdropFilter,alpha:root.style.getPropertyValue('--yt-surface-alpha'),scroll:root.scrollWidth,width:innerWidth,motion:matchMedia('(prefers-reduced-motion:reduce)').matches}});
 assert.ok(state.scroll<=width,JSON.stringify({site,variant,state}));assert.ok(state.motion);if(variant==='radius-zero-low')assert.equal(state.radius,'0px');if(['reduced-transparency','contrast'].includes(variant))assert.equal(state.filter,'none');
 await page.screenshot({path:`${__dirname}/${site}-${width}-${variant}.png`});results.push({site,width,variant,state});await page.close();
}assert.deepEqual(errors,[]);await fs.writeFile(require('node:path').join(__dirname,'appearance-edge-results.json'),JSON.stringify({results,errors},null,2));console.log('PASS 8 desktop/mobile radius,alpha,accessibility surface/panel checks');}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
