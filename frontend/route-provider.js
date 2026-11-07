// Configure a same-origin team backend adapter after the map provider is selected.
// Keep provider secrets on the backend. No endpoint means no invented route metrics.
export const routeConfig = { endpoint: '' };

export async function calculateRoute(originAddress, cases, { signal } = {}) {
  if (!originAddress.trim()) throw new Error('출발지 주소를 입력해 주세요.');
  if (!cases.length) throw new Error('담당 기사에게 배정된 출동 대기 건이 없습니다.');
  if (cases.some(c => !c.registeredAddress?.trim())) throw new Error('모든 접수 건의 등록 주소를 확인해 주세요.');
  if (!routeConfig.endpoint) throw new Error('지도 서비스 연결 대기 중입니다. 배정과 우선순위는 저장되며 거리·시간은 연결 후 계산합니다.');
  const request = { originAddress, optimize: 'priority-then-travel-time', stops: cases.map(c => ({ caseId:c.id, address:c.registeredAddress, priority:c.priority, summary:c.transcript.filter(m=>m.role==='counselor').map(m=>m.text).join('\n') })) };
  const response = await fetch(routeConfig.endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(request), signal });
  if (!response.ok) throw new Error('동선 계산에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  const result = await response.json();
  const expected = new Map(cases.map(c=>[c.id,c]));
  if (!Array.isArray(result.stops) || result.stops.length !== cases.length || new Set(result.stops.map(s=>s.caseId)).size !== cases.length || result.stops.some(s=>!expected.has(s.caseId) || !Number.isFinite(s.distanceMeters) || s.distanceMeters<0 || !Number.isFinite(s.durationSeconds) || s.durationSeconds<0)) throw new Error('지도 응답의 접수 건·거리·시간을 확인할 수 없습니다.');
  const rank = {urgent:0,high:1,normal:2};
  if (result.stops.some((s,i)=>i>0 && rank[expected.get(result.stops[i-1].caseId).priority] > rank[expected.get(s.caseId).priority])) throw new Error('긴급 접수 우선순위가 반영되지 않은 동선입니다.');
  return { stops:result.stops, calculatedAt:new Date().toISOString(), originAddress, source:result.source || '연결된 지도 서비스' };
}

// Return optimized geographic route groups first; equally skilled engineers are randomly mapped afterwards.
routeConfig.batchEndpoint = '';
export async function planBatch(originAddress, cases, engineers, { signal } = {}) {
  if(!originAddress.trim())throw new Error('출발지 주소를 입력해 주세요.');
  if(!cases.length || !engineers.length)throw new Error('미배정 접수와 기사 목록을 확인해 주세요.');
  if(cases.some(c=>!c.dispatchAddress?.trim()))throw new Error('모든 접수의 출동 장소를 확인해 주세요.');
  if(!routeConfig.batchEndpoint)throw new Error('지도 서비스 연결 대기 중입니다. 동선 계산 후 일괄 배정할 수 있습니다.');
  const response=await fetch(routeConfig.batchEndpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({originAddress,optimize:'distance-time-only',routeCount:Math.min(cases.length,engineers.length),stops:cases.map(c=>({caseId:c.id,address:c.dispatchAddress}))})});
  if(!response.ok)throw new Error('동선 계산에 실패했습니다.');
  const result=await response.json();
  const routes=result.routes;
  const stops=Array.isArray(routes)?routes.flatMap(r=>Array.isArray(r.stops)?r.stops:[]):[];
  const expected=new Set(cases.map(c=>c.id));
  if(!Array.isArray(routes)||routes.length!==Math.min(cases.length,engineers.length)||routes.some(r=>!Array.isArray(r.stops)||!r.stops.length)||stops.length!==expected.size||new Set(stops.map(s=>s.caseId)).size!==expected.size||stops.some(s=>!expected.has(s.caseId)||!Number.isFinite(s.distanceMeters)||s.distanceMeters<0||!Number.isFinite(s.durationSeconds)||s.durationSeconds<0))throw new Error('지도 응답의 방문지·거리·시간을 확인할 수 없습니다.');
  const shuffled=[...engineers];
  for(let i=shuffled.length-1;i>0;i--){const random=new Uint32Array(1);crypto.getRandomValues(random);const j=Math.floor(random[0]/4294967296*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
  return routes.map((r,i)=>({engineer:shuffled[i],stops:r.stops,source:result.source||'연결된 지도 서비스',originAddress,calculatedAt:new Date().toISOString()}));
}
