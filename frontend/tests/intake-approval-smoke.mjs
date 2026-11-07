// Isolated browser test: all record writes and chatbot calls are intercepted.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(process.env.FIELDNOTE_QA_PACKAGE||import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const records=new Map(),settings={};let revision=0;const errors=[];
try{
 const p=await browser.newPage({viewport:{width:390,height:844}});p.on('pageerror',e=>errors.push(e.message));
 await p.route('**/api/records**',async route=>{
  const request=route.request(),body=request.method()==='POST'?request.postDataJSON():{};let result;
  if(request.url().includes('/sync')){
   const saved=[];for(const {record,baseRevision}of body.changes||[]){const r={...record,_serverRevision:baseRevision+1};records.set(r.id,r);saved.push(r);}const changed={};for(const[key,value]of Object.entries(body.settings||{})){changed[key]={value:value.value,revision:value.baseRevision+1};settings[key]=changed[key];}revision++;result={cases:saved,settings:changed};
  }else if(request.method()==='POST'){result={imported:0,archived:0};}else result={revision,cases:[...records.values()],settings};
  await route.fulfill({json:result});
 });
 await p.route('**/api/agentstream/**',route=>route.fulfill({status:503,json:{detail:'분리된 접수 검증 응답'}}));
 await p.goto(process.env.FIELDNOTE_BASE_URL||'http://127.0.0.1:8501/');
 const ready=()=>p.waitForFunction(()=>document.querySelector('#shared-storage-status')?.dataset.kind==='saved');await ready();
 for(const staff of ['상담사 A','상담사 B','상담사 C']){
  await p.locator('#staff-select').selectOption(staff);
  for(let i=1;i<=6;i++){
   if(!await p.locator('#start-form').count())await p.locator('#new-case').click();
   await p.locator('[name=customerName]').fill('접수한도검증 '+staff+' '+i);await p.locator('[name=registeredAddress]').fill('전남 나주시 합성 검증 주소');await p.locator('[name=dispatchAddress]').fill('전남 나주시 합성 검증 주소');await p.locator('#start-form button[type=submit]').click();await ready();
   await p.locator('#counselor-text').fill('브레이크가 밀리는 것 같습니다.');await p.locator('#counselor-chat > button').click();await p.locator('#open-close').click();
   for(const name of ['visitRequested','cannotDrive','selfCareWanted'])await p.locator(`[name=${name}][value=${name==='selfCareWanted'?'no':'yes'}]`).check();
   await p.locator('[name=manualChoice]').selectOption('yes');await p.locator('[name=productName]').fill('파밍보이2.0A');await p.locator('[name=purchaseDate]').fill('2023.08.19');await p.locator('[name=repairHistory]').fill('없음');await p.locator('#finish-call').click();await ready();
  }
  const saved=[...records.values()].filter(r=>r.customerName?.startsWith('접수한도검증 '+staff));assert.equal(saved.length,6);assert.ok(saved.every(r=>r.stage==='awaiting-arrival'&&r.counselorName===staff));console.log('PASS',staff,'6 intakes completed and ready for manager review');
 }
 await p.locator('#role-manager').click();await p.locator('#manager-password').fill('1234');await p.locator('#manager-auth-form button[type=submit]').click();
 const targets=[...records.values()].filter(r=>r.customerName?.startsWith('접수한도검증 상담사 A'));
 for(const item of targets){await p.locator(`[data-confirm-priority="${item.id}"]`).click();await ready();await p.locator(`[data-manager-approve="${item.id}"]`).click();await ready();}
 const approved=targets.map(r=>records.get(r.id));assert.ok(approved.every(r=>r.managerApprovedAt));const queued=approved.filter(r=>!r.assignedEngineer);assert.ok(queued.length>0);
 for(const item of queued){assert.match(await p.locator(`[data-manager-approve="${item.id}"]`).locator('xpath=ancestor::*[contains(@class,"manager-intake")][1]').textContent(),/최종 컨펌 완료.*배차 대기/);}
 const state=await p.evaluate(()=>JSON.parse(localStorage.getItem('yeosu-fieldnote-chat-v2')));assert.equal(state.cases.filter(r=>r.assignedEngineer==='엔지니어 A'&&!['complete','remote-closed'].includes(r.stage)).length,5);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 assert.deepEqual(errors,[]);console.log('PASS: 6 manager approvals despite full engineer; visible waiting queue; 5-job assignment cap; mobile layout');
 console.log('No production records written; 18 intake records tested.');
}finally{await browser.close();}
