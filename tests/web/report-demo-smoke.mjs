// Run from the repository root with the Python report dependencies installed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const{chromium}=createRequire(process.env.FIELDNOTE_QA_PACKAGE||import.meta.url)('playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const p=await browser.newPage();
 await p.route('**/api/records**',route=>{const body=route.request().method()==='POST'?route.request().postDataJSON():{};return route.fulfill({json:body.changes?{cases:body.changes.map(c=>({...c.record,_serverRevision:1})),settings:Object.fromEntries(Object.entries(body.settings||{}).map(([k,c])=>[k,{value:c.value,revision:1}]))}:{revision:0,cases:[],settings:{}}});});
 await p.goto('http://127.0.0.1:8501/');await p.waitForFunction(()=>JSON.parse(localStorage.getItem('yeosu-fieldnote-chat-v2'))?.cases?.length===100);
 const ui=await p.evaluate(()=>JSON.parse(localStorage.getItem('yeosu-fieldnote-chat-v2')).cases.filter(c=>c.stage==='complete'));
 const exported=JSON.parse(execFileSync(process.env.FIELDNOTE_PYTHON||'python3',['-c','import json; from server.reports import demo_records,today; print(json.dumps(demo_records(today())))'],{encoding:'utf8'}));assert.equal(ui.length,exported.length);
 for(const row of exported){const match=ui.find(c=>c.id===row.id);assert.ok(match);for(const key of ['customerName','assignedEngineer','counselorName','repairNotes','dispatchAddress'])assert.equal(row[key],match[key],row.id+' '+key);assert.equal(Date.parse(row.completedAt),Date.parse(match.completedAt));assert.equal(row.repairPlan.travelFee,match.repairPlan.travelFee);assert.deepEqual(row.repairPlan.parts.map(p=>[p.name,p.qty,p.unitPrice]),match.repairPlan.parts.map(p=>[p.name,p.qty,p.unitPrice]));}
 console.log('PASS: all '+ui.length+' completed demo records match browser customer, engineer, timestamps, parts, costs and repair results');
}finally{await browser.close();}
