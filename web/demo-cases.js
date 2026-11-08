import { createCase, buildAnalysis } from './services.js';
import { defaultCatalog, catalogSource } from './parts-catalog.js';
export async function makeDemoCases() {
  const stages=['counseling','awaiting-arrival','checklist','before-photos','repair-plan','customer-approval','repair-notes','photos','final-verification','complete','remote-closed','awaiting-arrival'];
  const symptoms=['차가 밭에서 갑자기 멈췄어요','핸들이 뻑뻑하고 하부 소음이 나요','충전기를 연결해도 충전이 안 돼요'];
  const now=Date.now();const cases=[];
  for(let i=0;i<stages.length;i++){
    const group=i%3,stage=stages[i],item=createCase(`DEMO-CUSTOMER-${group}`,`시연 농기계 ${group+1}`);
    const stamp=offset=>new Date(now-offset*60000).toISOString();
    Object.assign(item,{id:`DEMO-SCENARIO-${i+1}`,customerName:`고객 ${'ABC'[group]}`,registeredAddress:`전남 나주시 시연등록로 ${i+1}`,dispatchAddress:`전남 나주시 시연농로 ${i+1}`,createdAt:stamp(120+i),counselorName:`상담사 ${'ABC'[group]}`,priority:['high','normal','low'][Math.floor(Math.random()*3)],beforePhotos:[],afterPhotos:[],transcript:[{role:'counselor',text:symptoms[group],authorName:`상담사 ${'ABC'[group]}`,createdAt:stamp(120)}]});
    const flags={visitRequested:i%2===0,cannotDrive:i%3===0,selfCareWanted:i%2===1};
    item.incidentType=i%4===0?'accident':'breakdown';item.insuranceRepair=item.incidentType==='accident'?'yes':null;item.insuranceEnrolled=item.incidentType==='accident'?['yes','no','unknown'][group]:null;
    item.flags=flags;item.analysis=await buildAnalysis(item,[],flags,true);item.dispatch=item.analysis.dispatch;
    if(stage!=='counseling'){
      item.erp={productName:`시연 제품 ${group+1}`,purchaseDate:`202${group+2}년 ${group+3}월`,repairHistory:group===0?'없음':'합성 점검 이력 · 배터리/타이어 확인',confirmedBy:item.counselorName,confirmedAt:stamp(110)};item.closedAt=stamp(110);
    }
    if(!['counseling','awaiting-arrival','remote-closed'].includes(stage)){item.assignedEngineer=`엔지니어 ${'ABC'[group]}`;item.arrivedAt=stamp(60);item.positionEvents=[{type:'arrival',at:item.arrivedAt,address:item.dispatchAddress,basis:'dispatch-address'}];}
    if(['customer-approval','repair-notes','photos','final-verification','complete'].includes(stage)){const part=defaultCatalog[Math.floor(Math.random()*defaultCatalog.length)];item.repairPlan={details:'합성 점검 결과에 따른 부품 교체',parts:[{...part,qty:1,unitPrice:part.retailPrice+part.laborPrice}],travelFee:[33000,55000,77000][group],catalogSource,quotedAt:stamp(50)};}
    if(['repair-notes','photos','final-verification','complete'].includes(stage))item.approvalSignature={typedName:item.customerName,signedAt:stamp(45),image:null};
    if(stage==='complete'){item.completedAt=stamp(10);item.finalSignature={typedName:item.customerName,signedAt:item.completedAt,image:null};item.repairFulfilled=true;item.privacyAcknowledged=true;item.positionEvents.push({type:'complete',at:item.completedAt,address:item.dispatchAddress,basis:'dispatch-address'});}
    item.repairNotes='시연용 조치 기록 · 실제 작업이 아닙니다.';item.stage=stage;item.status=({counseling:'상담 중','awaiting-arrival':'출동 배정 대기',complete:'작업 완료','remote-closed':'원격 안내 종료'})[stage]||'현장 시연 진행 중';
    if(stage==='remote-closed')item.dispatch={required:false,rule:'시연 원격 안내',reason:'합성 원격 해결 사례'};
    else if(stage!=='counseling')item.dispatch={required:true,rule:'시연 출동',reason:'단계별 시연 사례'};
    cases.push(item);
  }
  return cases;
}
