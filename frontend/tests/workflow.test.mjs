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
