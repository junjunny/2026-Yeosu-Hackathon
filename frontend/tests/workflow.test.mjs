import test from 'node:test';
import assert from 'node:assert/strict';
import { travelFee, parseParts, estimateTotal, customerChecklist, followUpQuestions, migrateState } from '../workflow.js';
import { decideDispatch } from '../services.js';
import { calculateRoute, routeConfig } from '../route-provider.js';
import { catalogFromRows } from '../price-import.js';

const catalog=[{id:'P1',name:'검증용 부품',retailPrice:12000,laborPrice:3000}];
test('출장비 경계: 나주, 60km 미만, 60~100km 미만, 100km 이상, 전남 외',()=>{
  assert.equal(travelFee({region:'naju'}),33000);
  for(const [distanceKm,expected] of [[0,55000],[59.9,55000],[60,77000],[99.9,77000],[100,100000]])assert.equal(travelFee({region:'jeonnam',distanceKm}),expected);
  assert.equal(travelFee({region:'outside',distanceKm:10}),100000);
  for(const distanceKm of ['',null,-1,'abc'])assert.throws(()=>travelFee({region:'jeonnam',distanceKm}));
});
test('소비자가+공임을 부품비로 합산하고 출장비는 한 번만 청구',()=>{
  const parts=parseParts('검증용 부품 × 2',catalog);assert.equal(parts[0].unitPrice,15000);assert.equal(estimateTotal({parts,travelFee:55000}),85000);
  assert.equal(parseParts('P1 3개',catalog)[0].qty,3);
  for(const text of ['없는 부품 × 1','검증용 부품 × 0','검증용 부품 × 1.5','검증용 부품'])assert.throws(()=>parseParts(text,catalog));
});
test('엑셀 매핑은 빈 금액과 중복 부품, 같은 열 사용을 거부',()=>{
  const rows=[['부품명','소비자가','공임'],['검증용 부품','12,000','3000']];const map={headerRow:0,nameColumn:0,retailColumn:1,laborColumn:2};
  assert.deepEqual(catalogFromRows(rows,map),[{id:'PART-1',name:'검증용 부품',retailPrice:12000,laborPrice:3000}]);
  assert.throws(()=>catalogFromRows([...rows,rows[1]],map));assert.throws(()=>catalogFromRows([rows[0],['빈 금액','','0']],map));assert.throws(()=>catalogFromRows(rows,{...map,laborColumn:1}));
});
test('출동 규칙: 요청·주행 불가·검색 성공 0건은 자가조치보다 우선, 검색 실패는 수동 판단',()=>{
  assert.equal(decideDispatch({visitRequested:true,selfCareWanted:true},'ok',1,false).required,true);
  assert.equal(decideDispatch({cannotDrive:true,selfCareWanted:true},'ok',1,false).required,true);
  assert.equal(decideDispatch({selfCareWanted:true},'ok',0,false).required,true);
  assert.equal(decideDispatch({selfCareWanted:true},'ok',1,true).required,false);
  assert.equal(decideDispatch({},'error',0,null).required,null);
});
test('증상별 추가 질문과 고객 중심 필수 브레이크·타이어 점검',()=>{
  const item={transcript:[{role:'counselor',text:'차가 갑자기 멈췄습니다'}]};assert.ok(followUpQuestions(item).some(q=>q.includes('계기판')));
  const checklist=customerChecklist(item,{checklist:['전원 측정'],missingInfo:['오류 코드']});
  for(const keyword of ['브레이크','타이어','멈췄','전원 측정','오류 코드'])assert.ok(checklist.some(s=>s.includes(keyword)));
  assert.equal(customerChecklist(item,{checklist}).length,checklist.length);
});
test('기존 단일 사진 기록은 복원하고 예전 견적은 변경하지 않음',()=>{
  const state=migrateState({cases:[{customerId:'고객 A',beforePhoto:'data:before',afterPhoto:'data:after',repairPlan:{parts:[],laborPrice:10000}}]});
  assert.deepEqual(state.cases[0].beforePhotos,['data:before']);assert.ok(state.cases[0].repairPlan.legacy);assert.equal(state.staff.engineers.length,3);
});
test('지도 미연결·누락·우선순위 역전 거부 및 정상 응답 수용',async()=>{
  const cases=[{id:'A',registeredAddress:'나주시 A',priority:'urgent',transcript:[]},{id:'B',registeredAddress:'나주시 B',priority:'normal',transcript:[]}];
  await assert.rejects(calculateRoute('나주 출발지',cases),/연결 대기/);
  routeConfig.endpoint='/api/route';const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>({ok:true,json:async()=>({stops:[{caseId:'B',distanceMeters:1,durationSeconds:1},{caseId:'A',distanceMeters:1,durationSeconds:1}]})});
    await assert.rejects(calculateRoute('나주 출발지',cases),/우선순위/);
    globalThis.fetch=async()=>({ok:true,json:async()=>({stops:[{caseId:'A',distanceMeters:1,durationSeconds:1},{caseId:'A',distanceMeters:1,durationSeconds:1}]})});
    await assert.rejects(calculateRoute('나주 출발지',cases),/확인할 수 없습니다/);
    globalThis.fetch=async()=>({ok:true,json:async()=>({stops:cases.map(c=>({caseId:c.id,distanceMeters:1200,durationSeconds:90}))})});
    assert.equal((await calculateRoute('나주 출발지',cases)).stops.length,2);
  }finally{globalThis.fetch=original;routeConfig.endpoint='';}
});

const {defaultCatalog}=await import('../parts-catalog.js');
const {dashboardStats,durationMinutes}=await import('../dashboard.js');
const {planBatch}=await import('../route-provider.js');
const {managerAccess}=await import('../manager-access.js');
test('제공된 가격표 63개와 쉼표·별표 포함 부품명을 보존',()=>{
  assert.equal(defaultCatalog.length,63);assert.equal(new Set(defaultCatalog.map(p=>p.name)).size,63);
  assert.equal(parseParts('메인퓨즈 10 A × 1',defaultCatalog)[0].unitPrice,5600);
  assert.equal(parseParts('샤프트 LH Ø28X324.4 × 1',defaultCatalog)[0].unitPrice,83800);
  assert.equal(parseParts('앞타이어(휠반납조건) 15*6,00*6 × 2',defaultCatalog)[0].unitPrice,67000);
  assert.equal(estimateTotal({parts:parseParts('키스위치 × 2\n콘트롤러 36V × 1',defaultCatalog),travelFee:33000}),543000);
});
test('서울 날짜 기준 완료·이월 미완료·소요시간 집계',()=>{
  const cases=[{stage:'complete',createdAt:'2026-11-06T00:00:00Z',arrivedAt:'2026-11-06T14:30:00Z',completedAt:'2026-11-06T15:30:00Z'},{stage:'checklist',createdAt:'2026-11-05T00:00:00Z'},{stage:'remote-closed',createdAt:'2026-11-06T00:00:00Z',closedAt:'2026-11-06T14:59:00Z'}];
  const stats=dashboardStats(cases,new Date('2026-11-07T00:00:00Z'));assert.equal(stats.done.length,1);assert.equal(stats.todo.length,1);assert.equal(durationMinutes(cases[0]),60);assert.equal(durationMinutes(cases[1]),null);
});
test('해커톤 팀장 화면은 로그인 없이 열린다',async()=>{
  assert.equal(await managerAccess(),true);
});
test('최적화된 동선 그룹을 서로 다른 기사에 무작위 연결하며 누락 응답을 거부',async()=>{
  const original=globalThis.fetch;routeConfig.batchEndpoint='/api/batch';const cases=[{id:'A',dispatchAddress:'출동 A'},{id:'B',dispatchAddress:'출동 B'}];
  try {globalThis.fetch=async(url,init)=>{const req=JSON.parse(init.body);assert.equal(req.optimize,'distance-time-only');assert.equal(req.stops[0].address,'출동 A');return {ok:true,json:async()=>({routes:cases.map(c=>({stops:[{caseId:c.id,distanceMeters:1,durationSeconds:1}]}))})};};
    const plans=await planBatch('출발지',cases,['기사 A','기사 B']);assert.equal(new Set(plans.map(p=>p.engineer)).size,2);assert.deepEqual(plans.flatMap(p=>p.stops.map(s=>s.caseId)).sort(),['A','B']);
    globalThis.fetch=async()=>({ok:true,json:async()=>({routes:[{stops:[{caseId:'A',distanceMeters:1,durationSeconds:1}]}]})});await assert.rejects(planBatch('출발지',cases,['기사 A','기사 B']),/확인할 수 없습니다/);
  }finally{globalThis.fetch=original;routeConfig.batchEndpoint='';}
});
const {technicianPerformance}=await import('../performance.js');
test('실적 집계는 완료 기록만 사용하고 누락 시간·견적·증빙을 구분',()=>{
 const cases=[{id:'C1',stage:'complete',assignedEngineer:'기사 A',completedAt:'2026-11-07T01:00:00Z',arrivedAt:'2026-11-07T00:00:00Z',repairPlan:{parts:[{qty:2,unitPrice:10000}],travelFee:33000},approvalSignature:{},finalSignature:{},beforePhotos:['a'],afterPhotos:['b']},{id:'C2',stage:'complete',assignedEngineer:'기사 A',completedAt:'2026-11-07T02:00:00Z'},{id:'C3',stage:'checklist',assignedEngineer:'기사 A',createdAt:'2026-11-07T00:00:00Z'},{id:'OLD',stage:'complete',assignedEngineer:'기사 A',completedAt:'2026-10-01T00:00:00Z'}];
 const rows=technicianPerformance(cases,['기사 A','기사 B'],7,new Date('2026-11-07T05:00:00Z'));
 assert.equal(rows[0].count,2);assert.equal(rows[0].averageMinutes,60);assert.equal(rows[0].missingTime,1);assert.equal(rows[0].quoted,53000);assert.equal(rows[0].quotedCount,1);assert.equal(rows[0].signatureCount,1);assert.equal(rows[0].photoCount,1);assert.equal(rows[1].averageMinutes,null);assert.equal(rows[1].count,0);assert.deepEqual(rows[0].records.map(c=>c.id),['C1','C2']);
});
