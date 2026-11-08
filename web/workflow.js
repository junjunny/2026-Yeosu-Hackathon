import { defaultCatalog, catalogSource } from './parts-catalog.js';
export const defaultStaff = { counselors: ['상담사 A', '상담사 B', '상담사 C'], engineers: ['엔지니어 A', '엔지니어 B', '엔지니어 C'] };

export function followUpQuestions(item) {
  const text = item.transcript.filter(m => m.role === 'counselor').map(m => m.text).join('\n');
  const groups = [
    [/멈|정지|시동|전원/, ['멈추기 직전 주행 중이었나요, 정차 중이었나요?', '지금 계기판과 전원은 켜지나요? 표시된 경고 문구를 그대로 알려주시겠어요?', '멈추기 전에 소음·진동·냄새 등 평소와 다른 점이 있었나요?']],
    [/충전|배터리|방전/, ['마지막 충전 시점과 현재 배터리 표시를 알려주시겠어요?', '충전기나 장비에 어떤 오류 문구가 표시되나요?']],
    [/소음|진동|덜컹/, ['소음이나 진동이 언제, 어느 부위에서 발생하나요?', '속도·노면·제동 여부에 따라 증상이 달라지나요?']],
    [/사고|충돌|전복|추돌/, ['사고 시점과 충격을 받은 부위를 알려주시겠어요?', '다친 분이 있거나 현재 주변에 위험한 상황이 있나요?']]
  ];
  const relevant = groups.filter(([pattern]) => pattern.test(text)).flatMap(([, qs]) => qs);
  const questions = ['고객님은 지금 안전한 장소에 계신가요?', ...relevant, ...(relevant.length ? [] : ['어떤 상황에서 처음 증상이 발생했나요?', '장비에서 보이는 표시나 들리는 소리를 그대로 알려주시겠어요?']), '현재 장비를 움직일 수 있나요? 확인을 위해 무리하게 운행하지는 마세요.'];
  const answered = [
    [/안전한 장소/, /안전한?\s*(?:곳|장소)|안전.{0,12}(?:정차|확보)|위험.{0,8}(?:없|있)/],
    [/멈추기 직전/, /주행\s*중|운행\s*중|정차\s*중/],
    [/지금 계기판/, /(?:계기판|전원).{0,20}(?:켜|꺼|안\s*켜|오류|표시|점등)/],
    [/마지막 충전/, /(?:어제|오늘|지난|[0-9]+일).{0,15}충전/],
    [/충전기나 장비/, /(?:오류|에러)\s*(?:코드|문구)?\s*[:：]?\s*[A-Za-z][0-9]+/],
    [/현재 장비를 움직일/, /주행\s*(?:불가|가능)|운행\s*(?:불가|가능)|움직.{0,8}(?:못|안|불가)|움직일\s*수\s*(?:있|없)/]
  ];
  const remaining = questions.filter(question=>!answered.some(([questionPattern,answerPattern])=>questionPattern.test(question)&&answerPattern.test(text)));
  return (remaining.length ? remaining : ['추가로 불편했던 점이나 이전에 같은 증상이 있었는지 알려주시겠어요?']).slice(0,4);
}

export function customerChecklist(item, analysis) {
  const raw = item.transcript.filter(m => m.role === 'counselor').map(m => m.text).join('\n');
  return [...new Set([
    '고객과 브레이크 작동·제동 상태 확인 및 결과 기록',
    '고객과 타이어 마모·손상·공기압 상태 확인 및 결과 기록',
    `고객이 설명한 증상과 현장 상태 대조: ${raw.slice(0, 160) || '고객에게 증상 재확인'}`,
    ...(analysis.checklist || []),
    ...(analysis.missingInfo || []).map(info => `고객에게 확인 후 기록: ${info}`)
  ])];
}

export function travelFee({ region, distanceKm }) {
  if (region === 'outside') return 100000;
  if (region === 'naju') return 33000;
  const km = Number(distanceKm);
  if (region !== 'jeonnam' || distanceKm === '' || distanceKm == null || !Number.isFinite(km) || km < 0) throw new Error('출장 지역과 이동 거리를 확인해 주세요.');
  return km < 60 ? 55000 : km < 100 ? 77000 : 100000;
}

export function parseParts(text, catalog) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) throw new Error('부품명과 수량을 입력해 주세요.');
  return lines.map(line => {
    const match = line.match(/^(.+?)\s*(?:[x×*]\s*|\s+)(\d+)\s*(?:개)?$/i);
    if (!match) throw new Error(`“${line}”: 부품명 × 수량 형식으로 입력해 주세요.`);
    const name = match[1].trim(); const qty = Number(match[2]);
    const candidates = catalog.filter(p => p.name === name || p.id === name);
    if (candidates.length !== 1) throw new Error(`“${name}”의 가격표 항목을 하나로 확인할 수 없습니다. 정확한 부품명 또는 코드를 입력해 주세요.`);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 999) throw new Error('수량은 1~999 사이 정수로 입력해 주세요.');
    const part = candidates[0];
    if (![part.retailPrice, part.laborPrice].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('가격표의 소비자가와 공임을 확인해 주세요.');
    return { id: part.id, name: part.name, qty, unitPrice: part.retailPrice + part.laborPrice, retailPrice: part.retailPrice, laborPrice: part.laborPrice };
  });
}

export const estimateTotal = plan => plan.parts.reduce((sum, p) => sum + p.qty * p.unitPrice, 0) + plan.travelFee;

export function migrateState(state) {
  state.staff ||= structuredClone(defaultStaff);
  state.staff.counselors ||= [...defaultStaff.counselors]; state.staff.engineers ||= [...defaultStaff.engineers];
  state.selectedCounselor ||= state.staff.counselors[0]; state.selectedEngineer ||= state.staff.engineers[0];
  if (!state.catalog?.length) { state.catalog=structuredClone(defaultCatalog); state.catalogSource=catalogSource; } state.routePlans ||= {}; state.originAddress ||= '';
  for (const item of state.cases) {
    item.customerName ||= item.customerId; item.registeredAddress ||= ''; item.priority = state.priorityVersion===2 ? (item.priority || 'normal') : ({urgent:'high',high:'normal',normal:'low'}[item.priority] || 'normal'); item.dispatchAddress ||= item.incidentLocation || ''; 
    item.counselorName ||= state.staff.counselors[0];
    item.beforePhotos ||= item.beforePhoto ? [item.beforePhoto] : [];
    item.afterPhotos ||= item.afterPhoto ? [item.afterPhoto] : [];
    if (item.analysis) item.analysis.checklist = customerChecklist(item, item.analysis);
    if (item.repairPlan && item.repairPlan.travelFee == null) item.repairPlan.legacy = true;
  }
  state.priorityVersion=2;
  return state;
}
