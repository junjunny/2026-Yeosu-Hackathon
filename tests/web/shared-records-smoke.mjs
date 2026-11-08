// Explicitly opted-in integration test: creates one named synthetic record on the running service.
// Reported IDs allow the operator to remove only this test record after verification.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
if(process.env.FIELDNOTE_E2E_WRITE!=='1')throw Error('Set FIELDNOTE_E2E_WRITE=1 to create a synthetic shared record.');
const{chromium}=createRequire(process.env.FIELDNOTE_QA_PACKAGE||import.meta.url)('playwright');
const base=process.env.FIELDNOTE_BASE_URL||'http://127.0.0.1:8501/';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const errors=[];let id;let debugEngineer;
const ready=p=>p.waitForFunction(()=>document.querySelector('#shared-storage-status')?.dataset.kind==='saved');
const cache=p=>p.evaluate(()=>JSON.parse(localStorage.getItem('yeosu-fieldnote-demo-final-20261108')));
async function page(width){const context=await browser.newContext({viewport:{width,height:900}});await context.route('**/api/agentstream/**',r=>r.fulfill({status:503,json:{detail:'합성 브라우저 검증 응답'}}));await context.route('**/api/dispatch/travel-estimate',r=>r.fulfill({json:{hqAddress:'합성 본사',distanceKm:12,durationMinutes:20,region:'naju',travelFee:33000,source:'합성 검증 거리'}}));const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await ready(p);return p;}
try{
 const counselor=await page(1440),manager=await page(1024),engineer=await page(390);
 debugEngineer=engineer;await manager.locator('#role-manager').click();await manager.locator('#manager-password').fill('1234');await manager.locator('#manager-auth-form button[type=submit]').click();
 await counselor.locator('[name=customerName]').fill('공유 저장 검증 '+Date.now());await counselor.locator('[name=registeredAddress]').fill('전남 나주시 합성 검증 주소');await counselor.locator('[name=dispatchAddress]').fill('전남 나주시 합성 검증 주소');await counselor.locator('#start-form button[type=submit]').click();await ready(counselor);
 id=(await cache(counselor)).activeId;await writeFile('/tmp/fieldnote-shared-test-id.json',JSON.stringify({id}));
 await manager.locator(`[data-priority-case="${id}"]`).waitFor({timeout:15000});
 await counselor.locator('#counselor-text').fill('딱딱 소리가 나고 브레이크가 밀리는 것 같습니다.');await counselor.locator('#counselor-chat > button').click();await ready(counselor);await counselor.locator('#open-close').click();
 for(const name of ['visitRequested','cannotDrive','selfCareWanted'])await counselor.locator(`[name=${name}][value=yes]`).check();
 await counselor.locator('[name=manualChoice]').selectOption('yes');await counselor.locator('[name=productName]').fill('파밍보이2.0A');await counselor.locator('[name=purchaseDate]').fill('2023.08.19');await counselor.locator('[name=repairHistory]').fill('과거 수리 이력 없음');await counselor.locator('#finish-call').click();await ready(counselor);
 await manager.waitForFunction(id=>JSON.parse(localStorage.getItem('yeosu-fieldnote-demo-final-20261108')).cases.find(c=>c.id===id)?.stage==='awaiting-arrival',id);
 await manager.locator(`[data-priority-case="${id}"]`).selectOption('high');await manager.locator(`[data-confirm-priority="${id}"]`).click();await ready(manager);await manager.locator(`[data-manager-approve="${id}"]`).click();await ready(manager);
 await engineer.waitForFunction(id=>JSON.parse(localStorage.getItem('yeosu-fieldnote-demo-final-20261108')).cases.find(c=>c.id===id)?.assignedEngineer==='엔지니어 A',id);
 await engineer.locator('#role-engineer').click();await engineer.locator('#arrival-form').waitFor();
 assert.equal((await cache(engineer)).activeId,id);
 await engineer.locator('#arrival-text').fill('현장 도착');await engineer.locator('#arrival-form > button').click();await ready(engineer);
 for(const checkbox of await engineer.locator('[name=step]').all())await checkbox.check();await engineer.locator('[name=findings]').fill('브레이크 패드와 앞 타이어 2개 교체 필요');await engineer.locator('#checklist-form button[type=submit]').click();await ready(engineer);
 const png=await engineer.evaluate(()=>{const c=document.createElement('canvas');c.width=80;c.height=60;c.getContext('2d').fillRect(10,10,30,30);return c.toDataURL().split(',')[1]});const image={name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')};
 for(const input of await engineer.locator('[name=beforePhotos]').all())await input.setInputFiles(image);await engineer.locator('#before-photos-form button[type=submit]').click();await ready(engineer);
 await engineer.locator('[name=details]').fill('브레이크 패드와 앞 타이어 2개 교체');await engineer.locator('#part-search').fill('브레이크');await engineer.locator('[data-select-part]').first().click();await engineer.locator('#plan-submit').click();await ready(engineer);
 async function sign(form){await engineer.locator(`${form} [name=consent]`).check();if(form==='#verification-form')await engineer.locator('[name=privacyRead]').check();const canvas=engineer.locator('.signature-pad');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();await engineer.mouse.move(box.x+20,box.y+30);await engineer.mouse.down();await engineer.mouse.move(box.x+90,box.y+55,{steps:10});await engineer.mouse.up();await engineer.locator(`${form} button[type=submit]`).click();await ready(engineer);}
 await sign('#approval-form');await engineer.locator('[name=repairNotes]').fill('부품 교체 후 정상 작동 확인');await engineer.locator('#repair-notes-form button[type=submit]').click();await ready(engineer);
 for(const input of await engineer.locator('[name=afterPhotos]').all())await input.setInputFiles(image);await engineer.locator('#photos-form button[type=submit]').click();await ready(engineer);await sign('#verification-form');
 await manager.waitForFunction(id=>JSON.parse(localStorage.getItem('yeosu-fieldnote-demo-final-20261108')).cases.find(c=>c.id===id)?.stage==='complete',id);
 const done=(await cache(manager)).cases.find(c=>c.id===id);assert.equal(done.beforePhotos.length,5);assert.equal(done.afterPhotos.length,5);for(const url of [...done.beforePhotos,...done.afterPhotos,done.approvalSignature.image,done.finalSignature.image]){assert.match(url,/^\.\/api\/records\/media\//);assert.equal((await manager.request.get(new URL(url,base).href)).status(),200);}
 const preview='/data/Documents/Codex/.runtime/fieldnote/export-preview/';
 const pdfEvent=engineer.waitForEvent('download');await engineer.locator('[data-report=pdf]').click();const pdf=await pdfEvent;assert.match(pdf.suggestedFilename(),/\.pdf$/);await pdf.saveAs(preview+'workflow-verification.pdf');
 await manager.setViewportSize({width:320,height:900});
 const excelEvent=manager.waitForEvent('download');await manager.locator('[data-report=xlsx]').click();const excel=await excelEvent;assert.match(excel.suggestedFilename(),/\.xlsx$/);await excel.saveAs(preview+'workflow-verification.xlsx');
 assert.equal(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 console.log('PASS: completed record PDF on 390px engineer; latest cumulative Excel on 320px manager');
 const fresh=await page(768);assert.equal((await cache(fresh)).cases.find(c=>c.id===id).stage,'complete');
 assert.deepEqual(errors,[]);
 console.log('PASS: three isolated devices, counselor → manager approval → engineer complete, 5+5 photos, drawn signatures, fresh-browser read');console.log(JSON.stringify({id}));
}catch(error){if(debugEngineer){console.log('DEBUG',await debugEngineer.locator('.form-error').allTextContents(),await debugEngineer.locator('#shared-storage-status').textContent(),await debugEngineer.locator('form').evaluateAll(fs=>fs.map(f=>f.id)));await debugEngineer.screenshot({path:'/tmp/shared-test-error.png'});}throw error;}finally{await browser.close();}
