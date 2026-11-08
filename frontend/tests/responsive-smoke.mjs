// Node 22+, Playwright via FIELDNOTE_QA_PACKAGE, and the existing service on port 8501.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(process.env.FIELDNOTE_QA_PACKAGE||import.meta.url)('playwright');
const base=process.env.FIELDNOTE_BASE_URL||'http://127.0.0.1:8501/';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage();page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
// Isolate layout fixtures from the shared workspace. Persistence is tested separately.
await page.route('**/api/records**',async route=>{
  const request=route.request();const body=request.method()==='POST'?request.postDataJSON():{};
  const value=request.url().includes('/sync')?{cases:(body.changes||[]).map(c=>({...c.record,_serverRevision:c.baseRevision+1})),settings:Object.fromEntries(Object.entries(body.settings||{}).map(([k,c])=>[k,{value:c.value,revision:c.baseRevision+1}]))}:request.method()==='POST'?{imported:0,archived:0}:{revision:0,cases:[],settings:{}};
  await route.fulfill({json:value});
});
// UI validation must not send questions or travel requests to external paid APIs.
await page.route('**/api/dispatch/travel-estimate',r=>r.fulfill({json:{hqAddress:'합성 본사',distanceKm:12,durationMinutes:20,region:'naju',travelFee:33000,source:'UI 검증 데이터'}}));
await page.route('**/api/agentstream/**',r=>r.fulfill({status:503,json:{detail:'UI 검증용 응답'}}));
try {
  await page.goto(base);
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('yeosu-fieldnote-chat-v2')||'{}').cases?.length>90);
  const seed=await page.evaluate(()=>localStorage.getItem('yeosu-fieldnote-chat-v2'));
  async function scene(role,stage){
    await page.evaluate(({seed,role,stage})=>{
      const s=JSON.parse(seed);s.role=role;s.selectedEngineer='엔지니어 A';s.activeId=stage?'FARMINGBOY-CUS-094':null;
      if(stage){const c=s.cases.find(c=>c.id===s.activeId);c.stage=stage;if(stage==='counseling'){c.closedAt=null;c.transcript.push({role:'counselor',text:'딱딱 소리가 나고 브레이크가 밀리는 것 같습니다.',createdAt:new Date().toISOString()});}}
      localStorage.setItem('yeosu-fieldnote-chat-v2',JSON.stringify(s));
    },{seed,role,stage});
    await page.reload();
    if(role==='manager'){
      await page.locator('#role-manager').click();await page.locator('#manager-password').fill('0000');
      await page.locator('#manager-auth-form button[type=submit]').click();
      assert.equal(await page.locator('#manager-password').getAttribute('type'),'password');
      assert.equal(await page.locator('#manager-auth-error').textContent(),'비밀번호가 틀립니다. (비밀번호 : 1234)');
      assert.equal(await page.locator('#manager-auth-error').isVisible(),true);
      await page.locator('#manager-password').fill('1234');
      await page.locator('#manager-auth-form button[type=submit]').click();await page.locator('.ops-dashboard').waitFor();
    }else await page.locator(stage?'.raw-transcript, #counselor-chat':'#start-form').first().waitFor();
  }
  async function fits(label){
    const sizes=await page.evaluate(()=>({viewport:innerWidth,page:document.documentElement.scrollWidth,conversation:document.querySelector('.conversation').scrollWidth,client:document.querySelector('.conversation').clientWidth}));
    assert.ok(sizes.page<=sizes.viewport+1,`${label}: page overflow ${JSON.stringify(sizes)}`);
    assert.ok(sizes.conversation<=sizes.client+1,`${label}: content overflow ${JSON.stringify(sizes)}`);
  }
  for(const width of [320,390,768,1024,1440,1920]){
    await page.setViewportSize({width,height:900});
    await scene('counselor');await fits(`new intake ${width}`);
    const centered=await page.evaluate(()=>{const f=document.querySelector('#start-form').getBoundingClientRect(),m=document.querySelector('.main-area').getBoundingClientRect();return Math.abs((f.left+f.right-m.left-m.right)/2)});
    assert.ok(centered<2,`intake must be centered in workspace at ${width}`);
    assert.equal(await page.locator('#conversation').evaluate(e=>e.scrollTop),0);
    await page.locator('[name=customerName]').focus();
    await page.locator('[data-demo-target=customerName]').click();
    assert.equal(await page.locator('[name=customerName]').inputValue(),'한준희');
    if(width<=900){
      assert.equal(await page.locator('#case-list').isVisible(),false);
      await page.locator('#case-list-toggle').click();assert.equal(await page.locator('#case-list').isVisible(),true);
      await page.locator('#case-list [data-case-id]').first().click();assert.equal(await page.locator('#case-list').isVisible(),false);
    }
    await scene('manager');await fits(`manager ${width}`);
    await page.locator('.manager-history summary').click();await fits(`today records ${width}`);
    await page.locator('.manager-settings summary').click();await fits(`manager settings ${width}`);
    const frame=page.frameLocator('.manager-map iframe');await frame.locator('#run').waitFor();
    assert.ok(await frame.locator('body').evaluate(e=>e.scrollWidth<=innerWidth+1),`dispatch frame ${width}`);
    await scene('counselor','counseling');await fits(`counselor chat ${width}`);
    await page.locator('#counselor-chat textarea').focus();
    const suggestion=page.locator('#counselor-chat .demo-choices button');
    const popupWidth=await suggestion.locator('..').evaluate(e=>e.clientWidth);
    assert.ok((await suggestion.boundingBox()).width>popupWidth*.8,'chat suggestion uses full popup width');
    await suggestion.click();assert.match(await page.locator('#counselor-chat textarea').inputValue(),/딱딱/);
    await page.locator('#open-close').click();await page.locator('#close-form').waitFor();await fits(`ERP close ${width}`);
    for(const stage of ['awaiting-arrival','checklist','before-photos','repair-plan','customer-approval','repair-notes','photos','final-verification','complete']){
      await scene('engineer',stage);await fits(`${stage} ${width}`);
      if(stage==='complete' && width<=700)assert.ok(await page.locator('[name=internalRemark]').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=16),'mobile internal remark stays readable without input zoom');
      if(stage==='before-photos'||stage==='photos')assert.equal(await page.locator('input[type=file]').count(),5);
      if(stage==='checklist'){
        await page.locator('[name=findings]').fill('입력 중인 점검 결과');
        await page.locator('[name=step]').first().check();
        await page.locator('#open-engineer-help').click();
        const help=page.frameLocator('#engineer-help-frame');await help.locator('#question').fill('브레이크 점검 질문');
        assert.ok(await help.locator('body').evaluate(e=>e.scrollWidth<=innerWidth+1));
        if(width<=900){
          // A reduced viewport approximates the space left by the mobile keyboard.
          await page.setViewportSize({width,height:500});
          await page.waitForTimeout(100);const composer=await help.locator('#help-form').boundingBox();assert.ok(composer.y+composer.height<=500,`Help composer ${width}: ${JSON.stringify(composer)}`);
          await page.setViewportSize({width,height:900});
        }
        await page.locator('#close-engineer-help').click();
        assert.equal(await page.locator('[name=findings]').inputValue(),'입력 중인 점검 결과');assert.equal(await page.locator('[name=step]').first().isChecked(),true);
        await page.locator('#open-engineer-help').click();assert.equal(await help.locator('#question').inputValue(),'브레이크 점검 질문');await page.locator('#close-engineer-help').click();
      }
      if(stage==='customer-approval'){
        const canvas=page.locator('.signature-pad');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
        await page.mouse.move(box.x+25,box.y+25);await page.mouse.down();await page.mouse.move(box.x+65,box.y+55,{steps:8});await page.mouse.up();
        const ink=await canvas.evaluate(c=>c.toDataURL());await page.locator('#open-engineer-help').click();await page.locator('#close-engineer-help').click();assert.equal(await canvas.evaluate(c=>c.toDataURL()),ink);
        const mapped=await canvas.evaluate(c=>{const r=c.getBoundingClientRect(),x=Math.round(65*c.width/r.width),y=Math.round(55*c.height/r.height);return c.getContext('2d').getImageData(x-2,y-2,5,5).data.some((v,i)=>i%4===3&&v>0)});assert.ok(mapped,'signature ink follows pointer');
      }
    }
    console.log(`PASS ${width}px: centered intake, counselor/ERP, manager/map, 9 field stages, Help/drafts/signature`);
  }
  assert.deepEqual(errors,[]);
} finally {await browser.close();}
