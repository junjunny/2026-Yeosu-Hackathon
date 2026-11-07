import { loadState, saveState, createCase, replyToCounselor, buildAnalysis, unavailableAnalysis } from './services.js';

import { migrateState, customerChecklist, travelFee, parseParts, estimateTotal } from './workflow.js';
import { planBatch, routeConfig } from './route-provider.js';
import { readPriceWorkbook, catalogFromRows } from './price-import.js';
import { defaultCatalog, catalogSource } from './parts-catalog.js';

import { dashboardStats, durationMinutes, closeReady, seoulDay } from './dashboard.js';

import { technicianPerformance } from './performance.js';

const state = migrateState(loadState());
let performanceDays = 30;
let priceSheets = [];
let priceFileName = '';
let routeBusy = false;
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lines = value => escapeHtml(value).replace(/\n/g, '<br>');
const date = value => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone:'Asia/Seoul', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const won = value => new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(value) || 0);
const current = () => state.cases.find(item => item.id === state.activeId);
let signatureHasInk = false;
let sending = false;

const DEMO_DATA_URL = './data/farmingboy_customers_100.json';
const DEMO_SEED_VERSION = 'farmingboy-customers-100-v5';
const MANAGER_PASSWORD = '1234';

function demoPhoto(label, index, after = false) {
  const colors = after ? ['#dff5e9', '#e7efff', '#fff0d9'] : ['#eef1ff', '#f3e9ff', '#e8f5f5'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420"><rect width="100%" height="100%" fill="${colors[index % colors.length]}"/><text x="50%" y="48%" text-anchor="middle" font-family="Arial" font-size="30" fill="#52617a">${label}</text><text x="50%" y="60%" text-anchor="middle" font-family="Arial" font-size="18" fill="#8795aa">합성 현장 사진</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function demoCaseFromCustomer(customer, index, assignedEngineer = null, active = false, todayComplete = false) {
  const job = customer.current_job || {};
  const receivedAt = job.received_at || new Date(Date.now() - index * 86400000).toISOString();
  const text = customer.name === '고해숙'
    ? '충전기 출력 전압이 안 올라옵니다. 저도 장비를 잘 아는 편이라 부품을 먼저 보내주시고, 팀장님과 직접 통화하고 싶습니다.'
    : (job.request_text || '농기계 점검과 수리를 요청합니다.');
  const todayIntake = String(receivedAt).startsWith('2026-11-07');
  const repairMinutes = [45, 60, 75, 90, 120, 150][index % 6];
  const todaySlots = ['08:41:00','10:24:00','10:37:00','11:22:00','12:45:00','13:11:00','14:05:00'];
  const completedAt = todayComplete ? `2026-11-07T${todaySlots[index % todaySlots.length]}+09:00` : (job.completed_at || new Date(Date.parse(receivedAt) + repairMinutes * 60000).toISOString());
  const arrivedAt = new Date(Date.parse(completedAt) - repairMinutes * 60000).toISOString();
  const catalogPart = defaultCatalog[index % defaultCatalog.length];
  const travelFee = [33000, 55000, 77000, 100000][index % 4];
  const photoCount = (index % 3) + 1;
  const repeat = Boolean(customer._eval?.repeat_within_6m);
  const completedEngineer = assignedEngineer;
  const item = createCase(customer.customer_id, customer.machine?.model || '파밍보이2.0A');
  Object.assign(item, {
    id: `FARMINGBOY-${customer.customer_id}`,
    customerName: customer.name,
    phone: customer.phone,
    registeredAddress: customer.address?.full || '',
    dispatchAddress: customer.address?.full || '',
    createdAt: receivedAt,
    receivedAt,
    customerRecord: customer,
    counselorName: '상담사 A',
    transcript: [{ role: 'counselor', text, authorName: '상담사 A', createdAt: receivedAt }],
    flags: { visitRequested: true, cannotDrive: false, selfCareWanted: false },
    analysis: { mode: 'demo', searchStatus: 'ok', history: [], similar: [], diagnosis: '팀장 배차용 합성 고객 기록', checklist: [], missingInfo: [], dispatch: { required: true, rule: '팀장 배차 대상', reason: '최근 30일 배차 시연 데이터' } },
    dispatch: { required: true, rule: active ? '최근 30일 배차 대상' : '최근 30일 완료 기록', reason: active ? '오늘 접수와 분리된 배차 대상' : '완료된 고객 이력' },
    erp: { productName: customer.machine?.model || '파밍보이2.0A', purchaseDate: customer.machine?.purchase_date || '확인 필요', repairHistory: customer.repair_history?.length ? `${customer.repair_history.length}건의 과거 수리 이력` : '없음', confirmedBy: '팀장 데모 데이터', confirmedAt: receivedAt },
    assignedEngineer: todayIntake ? null : completedEngineer,
    scheduledToday: active || todayComplete,
    assignedAt: completedEngineer && !todayIntake ? receivedAt : null,
    stage: active || todayIntake ? 'awaiting-arrival' : 'complete',
    status: active ? '오늘 수리 예정' : todayIntake ? '팀장 우선순위 확인 대기' : (todayComplete ? '오늘 수리 완료' : '작업 완료'),
    priority: repeat ? 'high' : 'normal',
    priorityReason: repeat ? '최근 6개월 동일 부품 수리 이력' : '일반 접수',
    arrivedAt: active || todayIntake ? null : arrivedAt,
    completedAt: active || todayIntake ? null : completedAt,
    closedAt: active || todayIntake ? null : completedAt,
    onsiteMinutes: active || todayIntake ? null : repairMinutes,
    repairNotes: active || todayIntake ? '' : `합성 완료 기록 · ${catalogPart.name} 교체 및 작동 재시험 완료`,
    repairPlan: active || todayIntake ? null : { details: `현장 점검 후 ${catalogPart.name} 교체`, parts: [{ id: catalogPart.id, name: catalogPart.name, qty: 1, unitPrice: catalogPart.retailPrice + catalogPart.laborPrice, retailPrice: catalogPart.retailPrice, laborPrice: catalogPart.laborPrice }], travelFee, region: travelFee === 33000 ? 'naju' : 'jeonnam', distanceKm: travelFee === 33000 ? 12 : travelFee === 55000 ? 42 : travelFee === 77000 ? 78 : 120, catalogSource, quotedAt: completedAt },
    beforePhotos: active || todayIntake ? [] : Array.from({ length: photoCount }, (_, photoIndex) => demoPhoto(`수리 전 ${photoIndex + 1}`, index + photoIndex)),
    afterPhotos: active || todayIntake ? [] : Array.from({ length: photoCount }, (_, photoIndex) => demoPhoto(`수리 후 ${photoIndex + 1}`, index + photoIndex, true)),
    approvalSignature: active || todayIntake ? null : { typedName: customer.name, signedAt: new Date(Date.parse(arrivedAt) + Math.round(repairMinutes * 0.35) * 60000).toISOString(), image: null },
    finalSignature: active || todayIntake ? null : { typedName: customer.name, signedAt: completedAt, image: null },
    priorityConfirmed: false,
    fieldLog: [],
    positionEvents: []
  });
  return item;
}

async function seedFarmingboyDemo() {
  if (state.demoSeedVersion === DEMO_SEED_VERSION) return;
  const response = await fetch(DEMO_DATA_URL);
  if (!response.ok) throw new Error('100명 데모 데이터를 불러오지 못했습니다.');
  const payload = await response.json();
  const customers = Array.isArray(payload.customers) ? payload.customers : [];
  const today = seoulDay(new Date(`${payload._meta?.base_date || '2026-11-07'}T00:00:00+09:00`));
  const engineers = ['엔지니어 A', '엔지니어 B', '엔지니어 C'];
  const sorted = customers.filter(customer => seoulDay(customer.current_job?.received_at || '') !== today)
    .sort((a, b) => String(b.current_job?.received_at || '').localeCompare(String(a.current_job?.received_at || '')));
  const baseMs = Date.parse(`${today}T00:00:00+09:00`);
  const recent7 = sorted.filter(customer => {
    const receivedMs = Date.parse(customer.current_job?.received_at || '');
    return Number.isFinite(receivedMs) && baseMs - receivedMs <= 7 * 86400000;
  });
  const recent7Ids = new Set(recent7.slice(0, 6).map(customer => customer.customer_id));
  const dispatchCustomers = [...recent7.filter(customer => recent7Ids.has(customer.customer_id)), ...sorted.filter(customer => !recent7Ids.has(customer.customer_id))]
    .slice(0, engineers.length * 4);
  const assigned = new Map(dispatchCustomers.map((customer, index) => [customer.customer_id, engineers[Math.floor(index / 4)]]));
  const todayCompletedIds = new Set(dispatchCustomers.slice(0, 7).map(customer => customer.customer_id));
  const completed = customers.filter(customer => !assigned.has(customer.customer_id));
  completed.forEach((customer, index) => assigned.set(customer.customer_id, engineers[index % engineers.length]));
  state.cases = customers.map((customer, index) => { const isDispatch = dispatchCustomers.some(item => item.customer_id === customer.customer_id); return demoCaseFromCustomer(customer, index, assigned.get(customer.customer_id) || null, isDispatch && !todayCompletedIds.has(customer.customer_id), todayCompletedIds.has(customer.customer_id)); });
  state.staff = { counselors: ['상담사 A'], engineers };
  state.selectedCounselor = '상담사 A'; state.selectedEngineer = engineers[0]; state.role = 'counselor';
  state.routePlans = {}; state.demoSeedVersion = DEMO_SEED_VERSION;
  persist();
}

function persist() {
  try { saveState(state); return true; }
  catch { alert('브라우저 저장 공간이 부족합니다. 사진 크기를 줄여 다시 시도해 주세요.'); return false; }
}
function formError(form, message, fieldName) {
  let error = form.querySelector('.form-error');
  if (!error) { error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'alert'); form.prepend(error); }
  error.textContent = message;
  (fieldName ? form.querySelector(`[name="${fieldName}"]`) : form.querySelector('input, textarea, button'))?.focus();
}
function entry(role, text) { return { role, text, authorName:role==='counselor'?state.selectedCounselor:role==='engineer'?state.selectedEngineer:'Fieldnote', createdAt: new Date().toISOString() }; }
function bubble(role, text, createdAt, extra = '', authorName = '') {
  const isAgent = role === 'assistant';
  const name = isAgent ? 'Fieldnote' : authorName || (role === 'engineer' ? '엔지니어' : '상담사');
  const symbol = isAgent ? 'F' : role === 'engineer' ? '엔' : '상';
  return `<article class="message ${isAgent ? '' : 'user'}"><div class="avatar ${isAgent ? '' : 'user'}" aria-hidden="true">${symbol}</div><div class="message-body"><div class="message-head"><strong>${escapeHtml(name)}</strong><span>${date(createdAt)}</span></div><div class="${isAgent ? 'agent-bubble' : 'user-bubble'}">${lines(text)}${extra}</div></div></article>`;
}
function labelBadge(text, style = '') { return `<span class="badge ${style}">${escapeHtml(text)}</span>`; }
function statusText(item) { return item?.status || '접수 준비'; }

function startView() {
  return `<div class="welcome"><div class="welcome-icon" aria-hidden="true">✳</div><h2>고객의 말을 그대로 기록하세요.</h2><p>실구매자이자 실사용자인 고객의 정보로 접수합니다. 등록 주소와 고장 발생 위치를 구분해 주세요.</p></div>
  <form id="start-form" class="stage-form card"><h3>상담 시작</h3><label>고객 이름 · 실구매자 / 실사용자<input name="customerName" required maxlength="80" autocomplete="name"></label><label>등록 주소<input name="registeredAddress" required maxlength="300" autocomplete="street-address"><small>제품에 등록된 주소를 입력합니다. 고장이 발생한 장소가 아닙니다.</small></label><label>출동 장소<input name="dispatchAddress" required maxlength="300" autocomplete="off"></label><label>장비 식별 정보 (선택)<input name="equipmentId" maxlength="100" placeholder="ERP 제품명은 통화 종료 후 입력합니다."></label><button class="primary-button" type="submit">상담 시작</button></form><p class="demo-note">시연에는 합성 고객 정보만 입력하세요.</p>`;
}

function transcript(item, engineerView = false) {
  const html = item.transcript.map(message => bubble(message.role, message.text, message.createdAt, '', message.authorName)).join('');
  if (!engineerView) return `<div class="thread-intro"><span class="thread-line"></span><span>${date(item.createdAt)} · 통화 대화</span><span class="thread-line"></span></div>${html}`;
  return `<details class="raw-transcript"><summary>상담사와 챗봇의 원문 대화 <span>${item.transcript.length}건 · 펼쳐 보기</span></summary><div class="raw-transcript-body">${html}</div></details>`;
}

function callEndForm(item) {
  return `<article class="message"><div class="avatar" aria-hidden="true">F</div><div class="message-body"><div class="message-head"><strong>Fieldnote</strong></div><div class="card"><div class="card-title"><span class="step-index">2</span><div><h3>통화 종료 전 재확인</h3><p>입력한 내용과 아래 항목을 다시 확인한 뒤 통화를 종료하세요.</p></div></div><form id="close-form" class="form-grid"><label>접수 구분<select name="incidentType" id="incident-type" required><option value="breakdown">고장</option><option value="accident">사고</option></select></label><label class="insurance-field" hidden>보험수리 가능 여부<select name="insuranceRepair" id="insurance-repair"><option value="unknown">확인 필요</option><option value="yes">가능</option><option value="no">불가</option></select></label><label class="insurance-enrollment" hidden>보험 가입 여부<select name="insuranceEnrolled"><option value="unknown">확인 필요</option><option value="yes">가입</option><option value="no">미가입</option></select></label><label>상담 우선순위<select name="priority"><option value="high">상</option><option value="normal" selected>중</option><option value="low">하</option></select></label><div class="full">${yesNo('visitRequested', '고객이 방문을 요청했나요?')}${yesNo('cannotDrive', '주행이 불가능한가요?')}${yesNo('selfCareWanted', '고객이 직접 조치하기를 원하나요?')}</div><label class="full">일반 건 출동 여부<select name="manualChoice" required><option value="">선택해 주세요</option><option value="yes">출동</option><option value="no">원격 안내</option></select><small>고객 요청·주행 불가·유사 사례 없음 규칙에 해당하면 이 선택보다 출동 규칙이 우선합니다.</small></label><fieldset class="full erp-fields"><legend>ERP 확인 후 직접 입력</legend><label>과거 수리 이력<textarea name="repairHistory" required maxlength="4000" placeholder="이력이 없으면 없음, 확인 불가이면 사유를 입력하세요."></textarea></label><label>제품명<input name="productName" required maxlength="150"></label><label>구입 시점<input name="purchaseDate" required maxlength="80"></label><label>출동 장소<input name="dispatchAddress" required maxlength="300" value="${escapeHtml(item.dispatchAddress || '')}"></label></fieldset><div class="form-actions full"><button class="ghost-button" type="button" id="cancel-close">통화 계속</button><button id="finish-call" class="primary-button" type="submit" disabled>통화 종료 · 기록 잠금</button></div></form></div></div></article>`;
}
function yesNo(name, question) {
  return `<fieldset class="choice-field"><legend>${escapeHtml(question)}</legend><label><input type="radio" name="${name}" value="yes" required><span>예</span></label><label><input type="radio" name="${name}" value="no" required><span>아니요</span></label></fieldset>`;
}

function counselorView(item) {
  let html = transcript(item);
  if (item.stage === 'counseling') {
    html += state.closeFormOpen ? callEndForm(item) : `<form id="counselor-chat" class="note-composer chat-composer"><label class="sr-only" for="counselor-text">전화 상담 원문</label><textarea id="counselor-text" name="text" rows="3" maxlength="4000" required autocomplete="off" placeholder="고객이 말한 내용을 거의 그대로 입력하세요…"></textarea><button type="submit" aria-label="상담 내용 보내기" ${sending ? 'disabled' : ''}>↗</button></form><div class="chat-actions"><span>입력한 문장은 요약하지 않고 보관됩니다.</span><button id="open-close" class="ghost-button" type="button" ${!sending && item.transcript.some(m => m.role === 'counselor') ? '' : 'disabled'}>통화 종료</button></div>`;
  } else {
    const decision = item.dispatch;
    html += `<div class="locked-note" role="status"><span aria-hidden="true">🔒</span><div><strong>통화가 종료되었습니다.</strong><p>상담사 대화는 읽기 전용입니다. 출동 결과: ${decision ? `${decision.required ? '출동' : '원격 안내'} (${escapeHtml(decision.rule)})` : '분석 중'}</p></div></div>`;
  }
  if (item.stage !== 'counseling') html += erpForm(item);
  return html;
}

function diagnosisCard(item) {
  if (!item.analysis) return '<div class="waiting-box">상담 분석을 기다리고 있습니다.</div>';
  const a = item.analysis;
  const sources = a.similar.length ? a.similar.map(s => `<li><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.source)} · 관련 단어 ${s.score}개</span></li>`).join('') : '<li>확인 필요: 찾은 사례가 없습니다.</li>';
  const insurance = item.incidentType==='accident' ? `사고 접수 · 보험수리 ${{yes:'가능',no:'불가',unknown:'확인 필요'}[item.insuranceRepair]||'확인 필요'}${item.insuranceRepair==='yes'?` · 보험 가입 ${{yes:'가입',no:'미가입',unknown:'확인 필요'}[item.insuranceEnrolled]||'확인 필요'}`:''}` : '고장 접수';
  const history = a.history.length ? a.history.map(h => `${escapeHtml(h.id)} (${escapeHtml(h.status)})`).join(', ') : '이전 접수 없음';
  return `<section class="diagnosis-card" aria-label="엔지니어 진단"><div class="diagnosis-top"><span class="diagnosis-label">초기 기술 진단 · ${a.mode === 'mock' ? '합성 데이터' : '확인 필요'}</span>${labelBadge(item.dispatch.required ? '출동 확정' : '원격 안내', item.dispatch.required ? 'violet' : 'green')}</div><h2>${escapeHtml(a.diagnosis)}</h2><p><b>적용 규칙</b> ${escapeHtml(item.dispatch.rule)} · ${escapeHtml(item.dispatch.reason)}</p><p><b>고객 등록 주소</b> ${escapeHtml(item.registeredAddress||'확인 필요')}</p><p><b>접수 구분</b> ${escapeHtml(insurance)}</p><p><b>고객 이력</b> ${history}</p><details><summary>유사 사례와 출처</summary><ul>${sources}</ul></details>${a.missingInfo.length ? `<div class="missing-box"><strong>확인 필요</strong><p>${a.missingInfo.map(escapeHtml).join(' · ')}</p></div>` : ''}</section>`;
}

function quoteTotal(plan) { return plan.legacy ? plan.parts.reduce((sum,p)=>sum+p.qty*p.unitPrice,0) + (plan.laborPrice||0) : estimateTotal(plan); }
function quoteCard(item) {
  const p = item.repairPlan; if (!p) return '';
  return `<div class="quote-card"><h4>${p.legacy ? '이전 버전 견적 · 출장비 확인 필요' : '최종 견적서'}</h4><p>${escapeHtml(p.details)}</p>${!p.legacy&&Number.isFinite(Number(p.distanceKm))?`<p class="quote-route">본사 → 현장 ${Number(p.distanceKm).toFixed(1)}km · ${escapeHtml(p.travelSource||'자동 거리 계산')}</p>`:''}<div class="quote-row"><strong>부품비 (소비자가 + 공임)</strong><strong>금액</strong></div>${p.parts.map(part=>`<div class="quote-row"><span>${escapeHtml(part.name)} × ${part.qty}</span><span>${won(part.qty*part.unitPrice)}</span></div>`).join('')}${p.legacy?`<div class="quote-row"><span>이전 작업비</span><span>${won(p.laborPrice)}</span></div>`:`<div class="quote-row"><span>자동 출장비</span><span>${won(p.travelFee)}</span></div>`}<div class="quote-row quote-total"><strong>청구 총액</strong><strong>${won(quoteTotal(p))}</strong></div><small>가격표: ${escapeHtml(p.catalogSource || '이전 합성 견적')} · ${p.quotedAt ? date(p.quotedAt) : ''}</small></div>`;
}

function signatureReceipt(signature, title) {
  if (!signature) return '';
  const signed = signature.image
    ? `<img src="${signature.image}" width="200" height="60" alt="${escapeHtml(title)} 그림 서명">`
    : `<strong>${escapeHtml(signature.typedName)}</strong>`;
  return `<div class="signature-receipt"><span>${escapeHtml(title)}</span>${signed}<small>${date(signature.signedAt)}</small></div>`;
}

function signatureForm(kind, question, checkboxText) {
  return `<form id="${kind}-form" class="stage-form"><p>${question}</p>${kind === 'verification' ? privacyNotice() : ''}<label class="consent-row"><input name="consent" type="checkbox" required><span>${checkboxText}</span></label><label>고객 서명<canvas tabindex="0" class="signature-pad" width="550" height="150" aria-label="고객 서명 영역"></canvas></label><button type="button" class="signature-clear ghost-button">서명 다시 쓰기</button><label>직접 서명할 수 없는 경우 성명 입력<input name="typedName" maxlength="80" autocomplete="off" placeholder="고객 성명 입력…"></label><small>그림 서명 또는 성명 입력 중 하나가 필요합니다. 이 시연에서는 합성 이름만 사용하세요.</small><button class="primary-button" type="submit">${kind === 'approval' ? '고객 수리 동의 저장' : '수리 이행 확인 서명 저장'}</button></form>`;
}

function photoPicker(name) {
  return `<div class="multi-photo-picker">${Array.from({length:5},(_,index)=>`<label><span>사진 ${index+1}${index===0?' · 필수':''}</span><input name="${name}" type="file" accept="image/*" ${index===0?'required':''}></label>`).join('')}</div>`;
}

function stageForm(item) {
  switch (item.stage) {
    case 'awaiting-arrival':
      return `<form id="arrival-form" class="note-composer chat-composer"><label class="sr-only" for="arrival-text">현장 도착 메시지</label><input id="arrival-text" name="text" required autocomplete="off" placeholder="현장에 도착하면 ‘도착’이라고 입력하세요…"><button type="submit" aria-label="도착 메시지 보내기">↗</button></form>`;
    case 'checklist':
      return `<form id="checklist-form" class="stage-form"><div class="checklist">${item.analysis.checklist.map((step, i) => `<label class="check-row"><input type="checkbox" name="step" value="${i}"><span>${escapeHtml(step)}</span></label>`).join('')}</div><label>고객과 확인한 점검 결과<textarea name="findings" rows="3" required maxlength="2000" placeholder="브레이크·타이어 상태와 고객 증상 확인 결과"></textarea></label><button class="primary-button" type="submit">체크 결과 보내기</button></form>`;
    case 'before-photos':
      return `<form id="before-photos-form" class="stage-form"><h4>현장 확인 · 수리 전 사진</h4>${photoPicker('beforePhotos')}<small>사진 1은 필수이며 필요한 만큼 최대 5장까지 추가해 주세요.</small><button class="primary-button" type="submit">수리 전 사진 저장</button></form>`;
    case 'repair-plan':
      return `<form id="plan-form" class="stage-form"><label>수리 예정 내용<textarea name="details" rows="3" maxlength="2000" required></textarea></label><div class="part-picker"><label for="part-search">부품 검색<input id="part-search" type="search" autocomplete="off" placeholder="예: 브레이크, 타이어, 충전기"></label><small>부품명의 일부만 입력한 뒤 목록에서 선택하세요.</small><div id="part-suggestions" class="part-suggestions" role="listbox" aria-label="검색된 부품"></div><div id="selected-parts" class="selected-parts" aria-live="polite"></div><input type="hidden" name="partsChat"></div><section class="travel-estimate" aria-live="polite"><div><span>자동 출장비</span><strong id="travel-fee-value">계산 중…</strong></div><p id="travel-estimate-status">본사와 실제 출동 주소의 도로 거리를 확인하고 있습니다.</p><input type="hidden" name="region"><input type="hidden" name="distanceKm"><input type="hidden" name="travelFee"></section><p id="quote-preview" role="status">부품을 선택하면 자동 출장비를 더해 최종 견적을 계산합니다.</p><button id="plan-submit" class="primary-button" type="submit" disabled>최종 견적 확인</button></form>`;
    case 'customer-approval':
      return quoteCard(item) + signatureForm('approval', '고객에게 부품·가격·총액을 설명한 후 수리 진행 동의를 받아 주세요.', '표시된 수리 내용과 예상 금액에 동의합니다.');
    case 'repair-notes':
      return `<form id="repair-notes-form" class="stage-form"><label>실제 수리 내용과 결과<textarea name="repairNotes" rows="5" maxlength="3000" required placeholder="교체한 부품, 실제 조치, 재시험 결과를 적어 주세요…"></textarea></label><button class="primary-button" type="submit">수리 내역 보내기</button></form>`;
    case 'photos':
      return `<form id="photos-form" class="stage-form"><h4>수리 후 사진</h4>${photoPicker('afterPhotos')}<small>사진 1은 필수이며 수리 완료 상태를 최대 5장까지 추가해 주세요.</small><button class="primary-button" type="submit">수리 후 사진 저장</button></form>`;
    case 'final-verification':
      return `${photoGallery(item)}${signatureForm('verification', '고객에게 개인정보 처리 내역을 안내하고 요청한 수리 이행 여부를 확인해 주세요.', '요청하신 수리를 잘 이행하였음을 확인했습니다.')}`;
    case 'complete':
      return `<div class="completion-card card"><div class="card-title"><span class="step-index done">✓</span><div><h3>현장 완료 보고</h3><p>${date(item.completedAt)} · 수리 동의 및 수리 이행 확인 서명 저장</p></div></div>${quoteCard(item)}<p><b>실제 수리</b> ${escapeHtml(item.repairNotes)}</p>${photoGallery(item)}<div class="signature-receipts">${signatureReceipt(item.approvalSignature, '수리 진행 동의')}${signatureReceipt(item.finalSignature, '수리 이행 확인')}</div></div>`;
    default: return '<div class="waiting-box">이 상담은 출동 없이 원격 안내로 종료되었습니다.</div>';
  }
}

function renderPartSuggestions(query) {
  const target=$('#part-suggestions');if(!target)return;
  const keyword=String(query||'').trim().toLowerCase();
  if(!keyword){target.innerHTML='';return;}
  const matches=state.catalog.filter(part=>`${part.name} ${part.id}`.toLowerCase().includes(keyword)).slice(0,10);
  target.innerHTML=matches.length?matches.map(part=>`<button type="button" role="option" data-select-part="${escapeHtml(part.id)}"><span><strong>${escapeHtml(part.name)}</strong><small>${escapeHtml(part.id)}</small></span><b>${won(part.retailPrice+part.laborPrice)}</b></button>`).join(''):'<p>일치하는 부품이 없습니다. 다른 단어로 검색해 주세요.</p>';
}

function addPartSelection(partId) {
  const part=state.catalog.find(item=>item.id===partId);const target=$('#selected-parts');if(!part||!target)return;
  if(target.querySelector(`[data-selected-part="${CSS.escape(part.id)}"]`)){target.querySelector(`[data-selected-part="${CSS.escape(part.id)}"] input`)?.focus();return;}
  target.insertAdjacentHTML('beforeend',`<div class="selected-part-row" data-selected-part="${escapeHtml(part.id)}"><div><strong>${escapeHtml(part.name)}</strong><small>단가 ${won(part.retailPrice+part.laborPrice)}</small></div><label>수량<input type="number" data-part-qty min="1" max="99" step="1" value="1" inputmode="numeric"></label><button type="button" data-remove-part="${escapeHtml(part.id)}" aria-label="${escapeHtml(part.name)} 삭제">×</button></div>`);
  const search=$('#part-search');if(search)search.value='';renderPartSuggestions('');syncSelectedParts();
}

function syncSelectedParts() {
  const form=$('#plan-form');if(!form)return;
  const rows=[...form.querySelectorAll('[data-selected-part]')];
  form.elements.partsChat.value=rows.map(row=>{const part=state.catalog.find(item=>item.id===row.dataset.selectedPart);const qty=Math.max(1,Math.min(99,Number(row.querySelector('[data-part-qty]').value)||1));row.querySelector('[data-part-qty]').value=qty;return part?`${part.name} × ${qty}`:'';}).filter(Boolean).join('\n');
  updateQuotePreview(form);
}

function updateQuotePreview(form=$('#plan-form')) {
  if(!form)return;
  const preview=form.querySelector('#quote-preview');const submit=form.querySelector('#plan-submit');const data=new FormData(form);const fee=Number(data.get('travelFee'));
  if(!Number.isSafeInteger(fee)||fee<0){if(preview)preview.textContent='출장 거리와 출장비 계산을 기다리고 있습니다.';if(submit)submit.disabled=true;return;}
  try {const parts=parseParts(String(data.get('partsChat')),state.catalog);const partTotal=parts.reduce((sum,part)=>sum+part.qty*part.unitPrice,0);if(preview)preview.innerHTML=`부품비 <strong>${won(partTotal)}</strong> + 자동 출장비 <strong>${won(fee)}</strong> = 최종 견적 <strong>${won(estimateTotal({parts,travelFee:fee}))}</strong>`;if(submit)submit.disabled=false;}
  catch(error){if(preview)preview.textContent=error.message;if(submit)submit.disabled=true;}
}

function applyTravelEstimate(item, estimate) {
  const form=$('#plan-form');if(!form||current()?.id!==item.id)return;
  form.elements.region.value=estimate.region;form.elements.distanceKm.value=estimate.distanceKm;form.elements.travelFee.value=estimate.travelFee;
  $('#travel-fee-value').textContent=won(estimate.travelFee);
  $('#travel-estimate-status').textContent=`본사 ↔ 현장 ${estimate.distanceKm}km · 약 ${estimate.durationMinutes}분 · ${estimate.source}`;
  updateQuotePreview(form);
}

async function loadTravelEstimate(item, force=false) {
  if(!item||item.stage!=='repair-plan')return;
  if(!force&&item.travelEstimate?.dispatchAddress===item.dispatchAddress){applyTravelEstimate(item,item.travelEstimate);return;}
  const status=$('#travel-estimate-status');const submit=$('#plan-submit');if(status)status.textContent='본사와 실제 출동 주소의 도로 거리를 확인하고 있습니다.';if(submit)submit.disabled=true;
  try {const response=await fetch('./api/dispatch/travel-estimate',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:item.dispatchAddress})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.detail||'출장 거리를 계산하지 못했습니다.');item.travelEstimate={...result,dispatchAddress:item.dispatchAddress,calculatedAt:new Date().toISOString()};persist();applyTravelEstimate(item,item.travelEstimate);}
  catch(error){if(status)status.innerHTML=`${escapeHtml(error.message)} <button type="button" class="ghost-button travel-retry">다시 계산</button>`;}
}

function engineerView(item) {
  if (item.dispatch?.required && !item.assignedEngineer) return '<div class="waiting-box">전체 접수 후 팀장의 동선 계산·일괄 배정을 기다립니다.</div>';
  if (item.stage === 'erp-pending') return `<div class="waiting-box">상담사가 ERP 정보를 확인하고 있습니다.</div>${transcript(item,true)}`;
  if (item.assignedEngineer && item.assignedEngineer !== state.selectedEngineer) return '<div class="waiting-box">다른 기사에게 배정된 접수입니다. 담당자를 변경해 확인하세요.</div>';
  if (item.stage === 'counseling') return `<div class="waiting-box">상담이 진행 중입니다. 통화 종료 후 기술 진단과 원문 대화가 표시됩니다.</div>${transcript(item, true)}`;
  const log = item.fieldLog.map(message => bubble(message.role, message.text, message.createdAt, '', message.authorName)).join('');
  const assistantMode = `<section class="engineer-assistant-mode" aria-label="엔지니어 담당 챗봇 상태"><div><span class="assistant-mode-dot"></span><strong>엔지니어 담당 챗봇</strong><small>저장 기록 모드</small></div><p>API 연결 전에는 저장된 상담 원문·진단·체크리스트를 바탕으로 현장 절차를 이어갑니다. API 키가 준비되면 이 영역에 엔지니어 전용 답변을 연결합니다.</p></section>`;
  return `${assistantMode}${diagnosisCard(item)}${item.erp ? `<div class="quote-card"><b>ERP 확인</b><p>제품명: ${escapeHtml(item.erp.productName)} · 구입 시점: ${escapeHtml(item.erp.purchaseDate)}</p><p>과거 수리 이력: ${lines(item.erp.repairHistory)}</p></div>` : ''}${transcript(item, true)}<div class="field-conversation"><div class="thread-intro"><span class="thread-line"></span><span>현장 진행 대화</span><span class="thread-line"></span></div>${log}${stageForm(item)}</div>`;
}

function renderDetails() {
  const item = current();
  const stages = ['상담 원문 기록', 'ERP 확인·배정', '현장 점검·견적·동의', '수리 완료·확인'];
  const step = !item || item.stage === 'counseling' ? 0 : ['awaiting-arrival','checklist','before-photos','repair-plan','customer-approval','remote-closed'].includes(item.stage) ? 2 : item.stage === 'complete' ? 4 : 3;
  return `<div class="detail-card"><div class="detail-heading"><span class="eyebrow">접수 진행</span><h3>${item ? escapeHtml(item.id) : '새 상담 대기'}</h3><p>${item ? `${escapeHtml(item.customerName)} · ${escapeHtml(item.registeredAddress || '등록 주소 확인 필요')}` : '고객과 장비를 선택해 시작하세요.'}</p></div><div class="progress-list">${stages.map((name,i) => `<div class="progress-item ${i < step ? 'completed' : i === step ? 'current' : ''}"><span>${i < step ? '✓' : i+1}</span><strong>${escapeHtml(name)}</strong></div>`).join('')}</div></div><div class="help-card"><span aria-hidden="true">ⓘ</span><div><strong>해커톤 시연</strong><p>상담 채팅은 서버의 AgentStream 프록시를 호출합니다. 고객·사례·가격·서명은 합성 데이터입니다.</p></div></div>`;
}

function render(scrollPosition = 'bottom') {
  const item = current();
  $('#page-title').textContent = state.role === 'manager' ? '팀장 대시보드' : item ? `${item.customerName} 상담` : '새 상담';
  $('#thread-id').textContent = item?.id || '새 접수';
  $('#thread-status').textContent = statusText(item);
  $('#case-count').textContent = state.cases.length;
  $('#role-manager').classList.toggle('active',state.role==='manager');
  $('#role-manager').setAttribute('aria-pressed',String(state.role==='manager'));
  const names = state.role==='counselor' ? state.staff.counselors : state.role==='engineer' ? state.staff.engineers : ['팀장'];
  $('#staff-select').innerHTML=names.map(name=>`<option ${name===(state.role==='counselor'?state.selectedCounselor:state.selectedEngineer)?'selected':''}>${escapeHtml(name)}</option>`).join('');
  $('#role-counselor').classList.toggle('active', state.role === 'counselor');
  $('#role-engineer').classList.toggle('active', state.role === 'engineer');
  $('#role-counselor').setAttribute('aria-pressed', String(state.role === 'counselor'));
  $('#role-engineer').setAttribute('aria-pressed', String(state.role === 'engineer'));
  const todayCases = state.cases.filter(c => seoulDay(c.receivedAt || c.createdAt) === seoulDay(new Date()));
  $('#case-count').textContent = todayCases.length;
  $('#case-list').innerHTML = todayCases.length ? [...todayCases].sort((a,b) => String(b.receivedAt || b.createdAt).localeCompare(String(a.receivedAt || a.createdAt))).map(c => `<button type="button" class="case-item ${c.id === state.activeId ? 'active' : ''}" data-case-id="${c.id}"><span class="case-item-top"><strong>${escapeHtml(c.customerName)}</strong><small>${date(c.receivedAt || c.createdAt)}</small></span><span class="case-item-symptom">${escapeHtml(c.transcript.find(m => m.role === 'counselor')?.text || '상담 대기')}</span><span class="case-item-status">오늘 접수 · ${escapeHtml(c.status)}</span></button>`).join('') : '<p class="empty-cases">오늘 접수된 상담이 없습니다.</p>';
  $('#conversation').innerHTML = state.role==='manager' ? farmingboyManagerSummary()+managerView() : item ? (state.role === 'engineer' ? engineerView(item) : counselorView(item)) : startView();
  $('.content-grid').classList.toggle('manager-layout',state.role==='manager');
  $('#details').innerHTML = state.role==='manager' ? '' : renderDetails();
  bindSignature();
  if(state.role==='engineer'&&item?.stage==='repair-plan')loadTravelEstimate(item);
  $('#conversation').scrollTop = scrollPosition === 'top' ? 0 : $('#conversation').scrollHeight;
}

function bindSignature() {
  const canvas = $('.signature-pad');
  signatureHasInk = false;
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.getBoundingClientRect().width;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(150 * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio); ctx.strokeStyle = '#263957'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  let drawing = false;
  const point = event => { const r = canvas.getBoundingClientRect(); return [event.clientX-r.left, event.clientY-r.top]; };
  canvas.addEventListener('pointerdown', event => { drawing = true; signatureHasInk = true; canvas.setPointerCapture(event.pointerId); const [x,y]=point(event); ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+.1,y+.1); ctx.stroke(); });
  canvas.addEventListener('pointermove', event => { if (!drawing) return; const [x,y]=point(event); ctx.lineTo(x,y); ctx.stroke(); });
  canvas.addEventListener('pointerup', () => { drawing = false; });
  canvas.addEventListener('pointercancel', () => { drawing = false; });
}

function advance(item, answer, stage, prompt, status) {
  item.fieldLog.push(entry('engineer', answer));
  item.fieldLog.push(entry('assistant', prompt));
  item.stage = stage; item.status = status;
  if (persist()) render();
}

async function imageData(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('사진 파일을 선택해 주세요.');
  if(file.size>20000000) throw new Error('사진 한 장은 20MB 이하로 선택해 주세요.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const scale = Math.min(1, 900 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(img.width*scale); canvas.height = Math.round(img.height*scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .65);
  } finally { URL.revokeObjectURL(url); }
}

$('#new-case').addEventListener('click', () => { state.activeId = null; state.role = 'counselor'; state.closeFormOpen = false; persist(); render(); });
$('#role-counselor').addEventListener('click', () => { state.role = 'counselor'; state.closeFormOpen = false; persist(); render(); });
$('#role-engineer').addEventListener('click', () => { state.role = 'engineer'; state.closeFormOpen = false; persist(); render('top'); });
$('#case-list').addEventListener('click', event => { const button = event.target.closest('[data-case-id]'); if (!button) return; state.activeId = button.dataset.caseId; state.closeFormOpen = false; persist(); render(); });
$('#conversation').addEventListener('click', event => {
  const partButton=event.target.closest('[data-select-part]');if(partButton){addPartSelection(partButton.dataset.selectPart);return;}
  const removePart=event.target.closest('[data-remove-part]');if(removePart){removePart.closest('[data-selected-part]')?.remove();syncSelectedParts();return;}
  if(event.target.closest('.travel-retry')){loadTravelEstimate(current(),true);return;}
  const priorityButton=event.target.closest('[data-confirm-priority]');
  if(priorityButton){const item=state.cases.find(c=>c.id===priorityButton.dataset.confirmPriority);const select=document.querySelector(`[data-priority-case="${CSS.escape(item?.id||'')}"]`);if(item&&select){item.priority=select.value;item.priorityConfirmed=true;persist();render('top');}return;}
  const approveButton=event.target.closest('[data-manager-approve]');
  if(approveButton){
    const item=state.cases.find(c=>c.id===approveButton.dataset.managerApprove);
    if(!item||state.role!=='manager'||item.stage!=='awaiting-arrival'||!item.dispatch?.required)return;
    if(!item.priorityConfirmed){window.alert('우선순위를 먼저 확정해 주세요.');return;}
    const engineerA=state.staff.engineers.find(name=>name==='엔지니어 A')||state.staff.engineers.find(name=>/A$/i.test(name))||state.staff.engineers[0];
    if(!engineerA){window.alert('현장 담당자를 확인해 주세요.');return;}
    const activeCount=state.cases.filter(c=>c.id!==item.id&&c.assignedEngineer===engineerA&&!['complete','remote-closed'].includes(c.stage)).length;
    if(activeCount>=5){window.alert('현장 담당자의 진행 중 업무가 5건입니다. 완료 처리 후 다시 컨펌해 주세요.');return;}
    item.managerApprovedAt=new Date().toISOString();item.managerApprovedBy='팀장';item.assignedEngineer=engineerA;item.assignedAt=item.managerApprovedAt;item.assignmentSource='manager-demo-confirm';item.status='팀장 최종 컨펌 · 현장 전달 완료';state.selectedEngineer=engineerA;
    item.fieldLog.push(entry('assistant','팀장 최종 컨펌이 완료되어 현장 단계로 전달되었습니다.'));
    item.fieldLog.push(entry('assistant','엔지니어 담당 챗봇 API 연결 전에는 저장된 상담·진단 기록을 바탕으로 현장 절차를 진행합니다.'));
    persist();render('top');return;
  }
  const evidence=event.target.closest('[data-evidence-id]');if(evidence){state.activeId=evidence.dataset.evidenceId;state.role='engineer';const c=current();if(c?.assignedEngineer)state.selectedEngineer=c.assignedEngineer;persist();render('top');return;}
  if (event.target.id === 'open-close') { state.closeFormOpen = true; render(); }
  if (event.target.id === 'cancel-close') { state.closeFormOpen = false; render(); }
  if (event.target.classList.contains('signature-clear')) { const canvas = $('.signature-pad'); canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height); signatureHasInk = false; }
});

$('#conversation').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  if(['origin-form','staff-form','catalog-file-form','catalog-map-form'].includes(form.id) || form.classList.contains('assignment-form')) return;
  const data = new FormData(form); const item = current();
  if (form.id === 'start-form') {
    const customerName=String(data.get('customerName')).trim(); const registeredAddress=String(data.get('registeredAddress')).trim();
    if (!customerName || !registeredAddress || !String(data.get('dispatchAddress')||'').trim()) return formError(form,'고객 이름과 등록 주소를 확인해 주세요.','customerName');
    const knownCustomer=state.cases.find(c=>c.customerName===customerName && c.registeredAddress===registeredAddress);
    const created = createCase(knownCustomer?.customerId || `CUSTOMER-${Date.now().toString(36)}`, String(data.get('equipmentId')||'확인 필요'));
    Object.assign(created,{customerName,registeredAddress,dispatchAddress:String(data.get('dispatchAddress')||'').trim(),counselorName:state.selectedCounselor,priority:'normal',beforePhotos:[],afterPhotos:[]});
    created.transcript.push(entry('assistant', '고객이 설명한 내용을 가능한 한 원문 그대로 보내주세요. 사례를 확인해 상담에 필요한 기술적 답변을 드리겠습니다.'));
    state.cases.push(created); state.activeId = created.id; state.role = 'counselor';
    if (persist()) render(); return;
  }
  if (!item) return;
  if (form.id === 'counselor-chat') {
    if (sending || item.stage !== 'counseling') return;
    const text = String(data.get('text')).trim(); if (!text) return;
    item.transcript.push(entry('counselor', text)); sending = true; item.status = '사례 확인 중'; persist(); render();
    let streamedReply;
    try {
      const reply = await replyToCounselor(item, text, partial => {
        streamedReply ||= entry('assistant', '답변 생성 중…');
        streamedReply.text = partial;
        if (!item.transcript.includes(streamedReply)) item.transcript.push(streamedReply);
        persist(); render('bottom');
      });
      if (streamedReply) streamedReply.text = reply;
      else item.transcript.push(entry('assistant', reply));
    }
    catch (error) { item.transcript.push(entry('assistant', `AgentStream 연결 실패: ${error.message || '설정을 확인해 주세요.'}\n고객의 안전 상태를 먼저 확인하고 기술 답변은 확인 필요로 남겨 주세요.`)); item.status = '상담 연결 실패'; }
    if (item.status !== '상담 연결 실패') item.status = '상담 중'; sending = false; if (persist()) render(); return;
  }
  if (form.id === 'close-form') {
    if (item.stage !== 'counseling' || sending) return;
    if(!closeReady(form))return formError(form,'재확인 항목과 ERP 내역을 모두 입력해 주세요.');
    item.erp={productName:String(data.get('productName')).trim(),purchaseDate:String(data.get('purchaseDate')).trim(),repairHistory:String(data.get('repairHistory')).trim(),confirmedBy:state.selectedCounselor,confirmedAt:new Date().toISOString()};
    item.dispatchAddress=String(data.get('dispatchAddress')).trim();
    const flags = { visitRequested:data.get('visitRequested')==='yes', cannotDrive:data.get('cannotDrive')==='yes', selfCareWanted:data.get('selfCareWanted')==='yes' };
    const manualChoice = data.get('manualChoice') === 'yes';
    item.incidentType=String(data.get('incidentType'));
    item.insuranceRepair=item.incidentType==='accident'?String(data.get('insuranceRepair')):null;
    item.insuranceEnrolled=item.insuranceRepair==='yes'?String(data.get('insuranceEnrolled')):null;
    item.priority=String(data.get('priority'));
    item.flags = flags; item.stage='analyzing'; item.status='분석 중'; sending=true;
    item.transcript.push(entry('assistant','통화가 종료되었습니다. 상담 원문은 잠겼으며 엔지니어에게 전달됩니다.'));
    persist(); render();
    try { item.analysis = await buildAnalysis(item, state.cases, flags, manualChoice); }
    catch { item.analysis = unavailableAnalysis(flags, manualChoice); }
    item.analysis.checklist=customerChecklist(item,item.analysis);
    item.dispatch = item.analysis.dispatch;
    sending=false;
    item.closedAt=new Date().toISOString();
    item.stage=item.dispatch.required?'awaiting-arrival':'remote-closed'; item.status=item.dispatch.required?'출동 배정 대기':'원격 안내 종료';
    if(item.dispatch.required)item.fieldLog.push(entry('assistant','팀장이 동선을 계산하고 기사를 일괄 배정합니다.')); 
    state.closeFormOpen = false; if (persist()) render(); return;
  }
  if (form.id==='erp-form' && state.role==='counselor' && item.stage==='erp-pending') {
    if(sending || !item.dispatch)return formError(form,'분석이 완료된 후 ERP 정보를 저장해 주세요.');
    item.erp={productName:String(data.get('productName')).trim(),purchaseDate:String(data.get('purchaseDate')).trim(),repairHistory:String(data.get('repairHistory')).trim(),confirmedBy:state.selectedCounselor,confirmedAt:new Date().toISOString()};
    if(Object.values(item.erp).some(v=>!v)) return formError(form,'ERP 확인 정보를 모두 입력해 주세요.');
    item.stage=item.dispatch.required?'awaiting-arrival':'remote-closed'; item.status=item.dispatch.required?'출동 대기':'원격 안내 종료';
    invalidateRoutes();
    if(item.dispatch.required) item.fieldLog.push(entry('assistant','현장에 도착하면 ‘도착’이라고 보내주세요.'));
    if(persist())render();return;
  }
  if (state.role !== 'engineer' || !item.assignedEngineer || (item.assignedEngineer && item.assignedEngineer!==state.selectedEngineer)) return;
  if (form.id === 'arrival-form' && item.stage === 'awaiting-arrival') {
    const text = String(data.get('text')).trim();
    if (!text.includes('도착')) return formError(form, '현장에 도착했으면 “도착”이라고 입력해 주세요.', 'text');
    item.arrivedAt=new Date().toISOString();
    recordPosition(item,'arrival',item.arrivedAt);
    item.analysis.checklist=customerChecklist(item,item.analysis);
    advance(item, text, 'checklist', '도착이 확인되었습니다. 고객이 설명한 증상과 분석 결과를 바탕으로 브레이크·타이어 상태를 포함해 점검하고 결과를 기록해 주세요.', '현장 도착'); return;
  }
  if (form.id === 'checklist-form' && item.stage === 'checklist') {
    const checked = data.getAll('step');
    if (checked.length !== item.analysis.checklist.length) return formError(form, '모든 체크리스트 항목을 확인해 주세요.', 'step');
    item.checklistDone = checked.map(Number);
    item.checklistFindings=String(data.get('findings')).trim();
    if(!item.checklistFindings) return formError(form,'고객과 확인한 점검 결과를 기록해 주세요.','findings');
    advance(item, `점검 완료: ${item.checklistFindings}`, 'before-photos', '견적 작성 전 고객과 확인한 수리 전 상태를 사진으로 남겨 주세요. 여러 장을 첨부할 수 있습니다.', '수리 전 사진 대기'); return;
  }
  if (form.id === 'plan-form' && item.stage === 'repair-plan') {
    try {
      const parts=parseParts(String(data.get('partsChat')),state.catalog);
      const automaticFee=Number(data.get('travelFee'));const fee=Number.isSafeInteger(automaticFee)&&automaticFee>=0?automaticFee:travelFee({region:data.get('region'),distanceKm:data.get('distanceKm')});
      item.repairPlan={details:String(data.get('details')).trim(),parts,travelFee:fee,region:data.get('region'),distanceKm:Number(data.get('distanceKm')),travelSource:item.travelEstimate?.source||'자동 거리 계산',hqAddress:item.travelEstimate?.hqAddress||'본사',dispatchAddress:item.dispatchAddress,catalogSource:state.catalogSource,quotedAt:new Date().toISOString()};
    } catch(error) { return formError(form,error.message,'partsChat'); }
    advance(item, `수리 계획과 예상 총액 ${won(quoteTotal(item.repairPlan))} 입력`, 'customer-approval', '고객에게 수리 내용과 총액을 설명한 뒤 진행 동의 서명을 받아 주세요.', '고객 동의 대기'); return;
  }
  if (form.id === 'approval-form' && item.stage === 'customer-approval') {
    if(!data.get('consent')) return formError(form,'고객의 확인이 필요합니다.','consent');
    const name = String(data.get('typedName')||'').trim();
    if (!signatureHasInk && !name) return formError(form, '서명 영역에 서명하거나 고객 성명을 입력해 주세요.', 'typedName');
    recordPosition(item,'approval',new Date().toISOString());
    item.approvalSignature = { image:signatureHasInk ? $('.signature-pad').toDataURL('image/png') : null, typedName:name, signedAt:new Date().toISOString() };
    advance(item, '고객이 예상 수리 내용과 금액에 동의함', 'repair-notes', '수리를 마쳤다면 실제 수리 내용과 조치 결과를 적어 주세요.', '수리 진행 중'); return;
  }
  if (form.id === 'repair-notes-form' && item.stage === 'repair-notes') {
    item.repairNotes = String(data.get('repairNotes')).trim();
    advance(item, item.repairNotes, 'photos', '수리 후 사진을 여러 장 첨부해 주세요. 수리 전 사진은 이미 저장되어 있습니다.', '사진 대기'); return;
  }
  if ((form.id==='before-photos-form' && item.stage==='before-photos') || (form.id==='photos-form' && item.stage==='photos')) {
    const before=form.id==='before-photos-form'; const button=form.querySelector('button[type="submit"]'); button.disabled=true;button.textContent='사진 처리 중…';
    try {
      const files=data.getAll(before?'beforePhotos':'afterPhotos').filter(file=>file.size);
      if (!files.length || files.length>5) throw new Error('사진은 수리 전·후 각각 1~5장씩 첨부해 주세요.');
      const photos=[]; for(const file of files) photos.push(await imageData(file));
      const key=before?'beforePhotos':'afterPhotos'; const previous=item[key]; const oldStage=item.stage; const oldStatus=item.status; const logLength=item.fieldLog.length;
      item[key]=photos;
      item.fieldLog.push(entry('engineer',`${before?'수리 전':'수리 후'} 사진 ${photos.length}장 첨부`));
      item.fieldLog.push(entry('assistant',before?'수리 예정 내용과 부품·수량을 입력하면 가격표와 출장비를 합산합니다.':'개인정보 처리 내역을 안내한 뒤 요청한 수리 이행에 대한 고객 서명을 받아 주세요.'));
      item.stage=before?'repair-plan':'final-verification'; item.status=before?'견적 작성':'수리 이행 확인 대기';
      if(!persist()) {item[key]=previous;item.stage=oldStage;item.status=oldStatus;item.fieldLog.length=logLength;throw new Error('사진 저장 용량이 부족합니다. 사진 수나 크기를 줄여 주세요.');}
      render();
    } catch(error) {formError(form,error.message);button.disabled=false;button.textContent='사진 다시 저장';}return;
  }
  if (form.id === 'verification-form' && item.stage === 'final-verification') {
    if(!data.get('privacyRead'))return formError(form,'개인정보 처리 내역을 안내하고 확인해 주세요.','privacyRead');
    if(!data.get('consent')) return formError(form,'고객의 확인이 필요합니다.','consent');
    const name = String(data.get('typedName')||'').trim();
    if (!signatureHasInk && !name) return formError(form, '서명 영역에 서명하거나 고객 성명을 입력해 주세요.', 'typedName');
    item.finalSignature = { image:signatureHasInk ? $('.signature-pad').toDataURL('image/png') : null, typedName:name, signedAt:new Date().toISOString() };
    item.repairFulfilled = true; item.privacyAcknowledged=true; item.privacyVersion='demo-v1'; item.completedAt = new Date().toISOString();
    recordPosition(item,'complete',item.completedAt);
    advance(item, '고객이 개인정보 처리 내역을 확인하고 요청한 수리 이행에 최종 서명함', 'complete', '현장 완료 보고가 저장되었습니다.', '작업 완료');
  }
});

function erpForm(item) {
  if(item.stage!=='erp-pending') return item.erp ? `<div class="quote-card"><h4>ERP 확인 완료</h4><p>제품명: ${escapeHtml(item.erp.productName)} · 구입 시점: ${escapeHtml(item.erp.purchaseDate)}</p><p>과거 수리 이력: ${lines(item.erp.repairHistory)}</p><small>${escapeHtml(item.erp.confirmedBy)} · ${date(item.erp.confirmedAt)}</small></div>` : '';
  return `<form id="erp-form" class="stage-form card"><h3>통화 종료 후 ERP 확인</h3><p>상담 원문은 잠겼습니다. ERP를 조회한 후 직접 입력해 주세요.</p><label>제품명<input name="productName" required maxlength="150"></label><label>구입 시점<input name="purchaseDate" required maxlength="80" placeholder="예: 2024년 3월 / 확인 불가 시 사유 입력"></label><label>과거 수리 이력<textarea name="repairHistory" required maxlength="4000" rows="4" placeholder="수리 날짜·내용을 적어 주세요. 이력이 없으면 ‘없음’으로 입력합니다."></textarea></label><button class="primary-button" type="submit" ${sending?'disabled':''}>ERP 정보 저장 · 접수 전달</button></form>`;
}
function privacyNotice() {
  return `<div class="privacy-notice"><h4>개인정보 처리 내역</h4><p>다음에 원활한 수리를 위해서 부탁드립니다.</p><p>고객 이름·등록 주소, 상담·ERP 확인 내역, 점검·수리 기록, 사진과 서명을 이번 수리 확인 및 다음 수리 지원에 사용합니다. 현재 시연 기록은 이 브라우저에 저장됩니다.</p><label class="consent-row"><input type="checkbox" name="privacyRead" required><span>개인정보 처리 내역을 안내받고 확인했습니다.</span></label></div>`;
}
function photoGallery(item) {
  return `<div class="photo-gallery">${[['수리 전',item.beforePhotos],['수리 후',item.afterPhotos]].map(([title,photos])=>`<section><h4>${title} 사진 · ${(photos||[]).length}장</h4><div class="photo-pair">${(photos||[]).map((photo,i)=>`<figure><img src="${photo}" width="220" height="130" loading="lazy" alt="${title} 사진 ${i+1}"><figcaption>${title} ${i+1}</figcaption></figure>`).join('')}</div></section>`).join('')}</div>`;
}
const priorityLabel = p => ({high:'상',normal:'중',low:'하'})[p] || '중';
function availableEngineers(){return state.staff.engineers.filter(name=>!state.cases.some(c=>c.assignedEngineer===name&&!['complete','remote-closed'].includes(c.stage)));}
function pendingCases(engineer) { return state.cases.filter(c=>c.dispatch?.required && c.stage==='awaiting-arrival' && (!engineer || c.assignedEngineer===engineer)); }
function priceImportView() {
  if(!priceSheets.length) return '';
  return `<form id="catalog-map-form" class="stage-form"><h4>${escapeHtml(priceFileName)} · 열 확인</h4><label>시트<select id="price-sheet" name="sheet">${priceSheets.map((sheet,i)=>`<option value="${i}">${escapeHtml(sheet.name)}</option>`).join('')}</select></label><div id="price-mapping"></div><button class="primary-button" type="submit">가격표 확인 · 등록</button></form>`;
}
function farmingboyManagerSummary() {
  const today=seoulDay(new Date());
  const todayCases=state.cases.filter(c=>seoulDay(c.receivedAt||c.createdAt)===today);
  const recent30=state.cases.filter(c=>seoulDay(c.receivedAt||c.createdAt)>='2026-10-09');
  const dispatchCases=state.cases.filter(c=>c.scheduledToday);
  const completedToday=state.cases.filter(c=>c.stage==='complete'&&c.completedAt&&seoulDay(c.completedAt)===today);
  const scheduledToday=dispatchCases.filter(c=>c.stage!=='complete');
  const confirmedToday=todayCases.filter(c=>c.priorityConfirmed);
  const approvedToday=todayCases.filter(c=>c.managerApprovedAt&&c.assignedEngineer);
  const highPriority=todayCases.filter(c=>c.priority==='high').length;
  const managerQueue=state.cases.filter(c=>c.stage==='awaiting-arrival'&&!c.assignedEngineer);
  const engineerLanes=state.staff.engineers.map((engineer,index)=>{const rows=dispatchCases.filter(c=>c.assignedEngineer===engineer);const complete=rows.filter(c=>c.stage==='complete').length;return `<section class="topology-lane"><div class="topology-engineer"><span class="node-icon" aria-hidden="true">${String.fromCharCode(65+index)}</span><div><strong>${escapeHtml(engineer)}</strong><small>${complete} 완료 · ${rows.length-complete} 예정</small></div></div><div class="topology-stops">${rows.map((c,stopIndex)=>`<div class="topology-stop ${c.stage==='complete'?'is-complete':'is-scheduled'}"><span>${stopIndex+1}</span><div><strong>${escapeHtml(c.customerName)}</strong><small>${c.stage==='complete'?'수리 완료':'방문 예정'}</small></div></div>`).join('')||'<div class="topology-empty">배정 없음</div>'}</div></section>`;}).join('');
  const workload=state.staff.engineers.map((engineer,index)=>{const rows=dispatchCases.filter(c=>c.assignedEngineer===engineer);const complete=rows.filter(c=>c.stage==='complete').length;const percent=rows.length?Math.round(complete/rows.length*100):0;return `<div class="workload-row"><div><span class="engineer-dot dot-${index+1}"></span><strong>${escapeHtml(engineer)}</strong><small>${complete}/${rows.length}건 완료</small></div><div class="workload-track"><span style="width:${percent}%"></span></div><b>${percent}%</b></div>`;}).join('');
  const todaySummary=todayCases.map(c=>{const approved=Boolean(c.managerApprovedAt&&c.assignedEngineer);const canApprove=Boolean(c.dispatch?.required&&c.stage==='awaiting-arrival'&&c.priorityConfirmed&&!approved);return `<article class="manager-intake ${approved?'is-approved':''}"><div class="intake-priority priority-${escapeHtml(c.priority||'normal')}">${priorityLabel(c.priority)}</div><div class="intake-copy"><strong>${escapeHtml(c.customerName)}</strong><span>${escapeHtml(c.transcript.find(m=>m.role==='counselor')?.text||'상담 요약 없음')}</span><small>${escapeHtml(c.dispatchAddress)}${approved?' · 현장 전달 완료':''}</small></div><label>우선순위<select data-priority-case="${escapeHtml(c.id)}" ${approved?'disabled':''}><option value="high" ${c.priority==='high'?'selected':''}>상</option><option value="normal" ${c.priority==='normal'?'selected':''}>중</option><option value="low" ${c.priority==='low'?'selected':''}>하</option></select></label><div class="manager-intake-actions">${approved?'<span class="assignment-chip">최종 컨펌 완료</span>':`<button type="button" class="ghost-button" data-confirm-priority="${escapeHtml(c.id)}">${c.priorityConfirmed?'우선순위 확정됨':'우선순위 확정'}</button><button type="button" class="primary-button" data-manager-approve="${escapeHtml(c.id)}" ${canApprove?'':'disabled'}>최종 컨펌</button>`}</div></article>`;}).join('');
  const events=[...todayCases.map(c=>{if(c.stage==='complete'&&c.completedAt)return {at:c.completedAt,type:'완료',name:c.customerName,detail:'현장 수리 완료 · 사진과 최종 서명 저장',tone:'success'};return {at:c.managerApprovedAt||c.receivedAt||c.createdAt,type:c.managerApprovedAt?'전달':'접수',name:c.customerName,detail:c.managerApprovedAt?'팀장 최종 컨펌 · 현장 전달 완료':`우선순위 ${priorityLabel(c.priority)} · ${c.priorityConfirmed?'우선순위 확정':'확인 대기'}`,tone:c.managerApprovedAt?'success':c.priority==='high'?'alert':'info'};}),...dispatchCases.map(c=>({at:c.completedAt||c.assignedAt||c.receivedAt||c.createdAt,type:c.stage==='complete'?'완료':'방문',name:c.customerName,detail:`${c.assignedEngineer||'배차 대기'} · ${c.stage==='complete'?'현장 수리 완료':'오늘 방문 예정'}`,tone:c.stage==='complete'?'success':'scheduled'}))].sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,10);
  return `<section class="demo-operations ops-dashboard" aria-label="농기계 AS 통합 관제 대시보드"><header class="ops-dashboard-header"><div><span class="ops-eyebrow">FIELD SERVICE CONTROL</span><h2>농기계 AS 통합 관제</h2><p>접수 검토부터 기사 배차, 현장 완료까지 한 화면에서 확인합니다.</p></div><div class="ops-live"><span></span><strong>운영 중</strong><small>${today} · 본점 기준</small></div></header><div class="dashboard-stats ops-kpis"><article><span>오늘 접수</span><strong>${todayCases.length}</strong><small>최종 컨펌 ${approvedToday.length}건</small></article><article><span>오늘 수리 예약</span><strong>${dispatchCases.length}</strong><small>접수일과 방문일 분리</small></article><article><span>현장 완료</span><strong>${completedToday.length}</strong><small>예정 ${scheduledToday.length}건</small></article><article><span>최근 30일 고객</span><strong>${recent30.length}</strong><small>우선 확인 ${highPriority}건</small></article></div><div class="ops-board"><aside class="ops-panel intake-monitor"><div class="panel-title"><div><span>INTAKE</span><h3>접수 검토 현황</h3></div><b>${confirmedToday.length}/${todayCases.length}</b></div><div class="donut-wrap"><div class="status-donut" style="--progress:${todayCases.length?Math.round(confirmedToday.length/todayCases.length*100):0}"><strong>${todayCases.length?Math.round(confirmedToday.length/todayCases.length*100):0}%</strong><small>우선순위 확정</small></div></div><dl class="monitor-list"><div><dt>우선순위 상</dt><dd class="text-alert">${highPriority}건</dd></div><div><dt>최종 컨펌</dt><dd>${approvedToday.length}건</dd></div><div><dt>배차 대기</dt><dd>${managerQueue.length}건</dd></div></dl><p class="ops-rule">오늘 접수는 오늘 수리 예약과 분리합니다. 우선순위를 확인하고 최종 컨펌하면 현장 단계로 전달됩니다.</p></aside><section class="ops-panel topology-panel"><div class="panel-title"><div><span>WORKFLOW TOPOLOGY</span><h3>접수 → 검토 → 배차 → 현장 완료</h3></div><small>실시간 데모 데이터</small></div><div class="topology-flow"><div class="topology-source"><div class="flow-node source-node"><span aria-hidden="true">☎</span><strong>오늘 접수</strong><small>${todayCases.length}건</small></div><i aria-hidden="true"></i><div class="flow-node manager-node"><span aria-hidden="true">✓</span><strong>팀장 검토</strong><small>${approvedToday.length}건 최종 컨펌</small></div><i aria-hidden="true"></i><div class="flow-node hub-node"><span aria-hidden="true">⌘</span><strong>통합 배차</strong><small>거리·시간 최적화</small></div></div><div class="topology-branches">${engineerLanes}</div></div><div class="topology-legend"><span><i class="legend-complete"></i>완료 ${completedToday.length}</span><span><i class="legend-scheduled"></i>예정 ${scheduledToday.length}</span><span><i class="legend-review"></i>접수 검토 ${todayCases.length}</span></div></section><aside class="ops-panel workload-panel"><div class="panel-title"><div><span>ENGINEERS</span><h3>기사별 처리 현황</h3></div><b>${completedToday.length}/${dispatchCases.length}</b></div><div class="workload-list">${workload}</div><div class="completion-summary"><span>오늘 완료율</span><strong>${dispatchCases.length?Math.round(completedToday.length/dispatchCases.length*100):0}%</strong><small>기사당 최대 5건 · 동일 통합 역량</small></div></aside></div><section class="ops-panel event-panel"><div class="panel-title"><div><span>LIVE EVENTS</span><h3>오늘 운영 이벤트</h3></div><small>최근 ${events.length}건</small></div><div class="event-table"><div class="event-table-head"><span>시간</span><span>구분</span><span>고객</span><span>처리 상태</span></div>${events.map(event=>`<div class="event-row"><time>${date(event.at)}</time><span><i class="event-dot event-${event.tone}"></i>${escapeHtml(event.type)}</span><strong>${escapeHtml(event.name)}</strong><span>${escapeHtml(event.detail)}</span></div>`).join('')}</div></section><section class="ops-panel review-panel"><div class="panel-title"><div><span>MANAGER REVIEW</span><h3>오늘 접수 상담 요약 · 우선순위 및 최종 컨펌</h3></div><small>${todayCases.length}건</small></div><div class="manager-intake-list">${todaySummary}</div></section></section>`;
}
function managerView() {
  const {done,todo}=dashboardStats(state.cases);
  const queue=pendingCases().filter(c=>!c.assignedEngineer);
  const collecting=state.cases.some(c=>['counseling','erp-pending','analyzing'].includes(c.stage));
  const recent30=state.cases.filter(c => seoulDay(c.receivedAt || c.createdAt) >= '2026-10-09');
  const dispatchCases=state.cases.filter(c => c.assignedEngineer && c.stage === 'awaiting-arrival');
  const dispatchTable=state.staff.engineers.map(engineer => { const rows=dispatchCases.filter(c=>c.assignedEngineer===engineer); return `<article class="route-card card"><h4>${escapeHtml(engineer)} <small>${rows.length}/4건</small></h4><ol>${rows.map(c=>`<li><strong>${escapeHtml(c.customerName)}</strong><span>${escapeHtml(c.dispatchAddress)}</span><small>접수 ${seoulDay(c.receivedAt || c.createdAt)} · 오늘 수리 아님</small></li>`).join('') || '<li>배정된 고객 없음</li>'}</ol></article>`; }).join('');
  return `<div class="manager-view manager-detail"><section class="manager-section-heading"><div><span>ROUTE CONTROL</span><h2>오늘 수리 예약 동선</h2><p>본점: 전남 나주시 왕곡면 혁신산단6길 9 · 모든 기사 본점 출발</p></div><div><strong>${done.length}</strong><span>오늘 해결</span></div><div><strong>${todo.length}</strong><span>해야 할 건수</span></div></section><section class="manager-map"><iframe title="오늘의 AS 배차 지도와 기사별 방문 순서" src="./dispatch/?embedded=1" loading="eager"></iframe></section><details class="manager-history"><summary>기사별 이동 · 위치 기록</summary><p>주소 기반 방문 기록입니다. 실시간 GPS 위치와 지도는 연결 전입니다.</p>${state.staff.engineers.map(engineer=>engineerTimeline(engineer)).join('')}</details>${performanceView()}<h3>오늘 해결된 수리 · 시간과 비용</h3><div class="table-scroll"><table><thead><tr><th>고객 / 기사</th><th>완료 시점</th><th>수리 소요시간</th><th>청구액 (견적 기준)</th></tr></thead><tbody>${done.map(c=>`<tr><td>${escapeHtml(c.customerName)} / ${escapeHtml(c.assignedEngineer||'원격 안내')}</td><td>${date(c.completedAt||c.closedAt)}</td><td>${durationMinutes(c)==null?'기록 없음':durationMinutes(c)+'분'}</td><td>${c.repairPlan?won(quoteTotal(c.repairPlan)):'해당 없음'}</td></tr>`).join('')||'<tr><td colspan="4">오늘 완료된 수리가 없습니다.</td></tr>'}</tbody></table></div><details class="manager-settings"><summary>담당자·부품 가격표 관리</summary><form id="staff-form" class="stage-form"><label>상담사 이름 · 한 줄에 한 명<textarea name="counselors" rows="3" required>${escapeHtml(state.staff.counselors.join('\n'))}</textarea></label><label>기사 이름 · 한 줄에 한 명<textarea name="engineers" rows="3" required>${escapeHtml(state.staff.engineers.join('\n'))}</textarea></label><button class="primary-button" type="submit">담당자 저장</button></form><form id="catalog-file-form" class="stage-form"><label>파밍보이 부품 가격표 (.xlsx)<input name="priceFile" type="file" accept=".xlsx" required></label><p>현재 가격표: ${escapeHtml(state.catalogSource||'등록 전')} · ${state.catalog.length}개 부품</p><button class="primary-button" type="submit">엑셀 읽기</button></form>${priceImportView()}</details></div>`;
}
function performanceView() {
  const rows=technicianPerformance(state.cases,state.staff.engineers,performanceDays);
  return `<section class="performance-panel"><div class="performance-heading"><div><h3>기사별 업무 실적 · 평가 참고</h3><p>완료 기록과 현장 증빙을 바탕으로 면담·평가를 준비합니다.</p></div><label>조회 기간<select id="performance-period">${[[1,'오늘'],[7,'최근 7일'],[30,'최근 30일']].map(([days,label])=>`<option value="${days}" ${days===performanceDays?'selected':''}>${label}</option>`).join('')}</select></label></div><p class="performance-context">현장 경과시간은 도착부터 최종 서명까지이며 대기·점검·수리 시간이 포함됩니다. 접수 난이도, 현장 대기시간, 이동거리와 함께 비교하세요. 자동 점수·순위는 산출하지 않습니다.</p><div class="table-scroll"><table><thead><tr><th>기사</th><th>완료 건수</th><th>평균 현장 경과</th><th>시간 기록</th><th>청구액 합계</th><th>수리 동의/최종 서명</th><th>전후 사진</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>${r.count}건</td><td>${r.averageMinutes==null?'—':r.averageMinutes+'분'}</td><td>${r.timeCount}건 · 누락 ${r.missingTime}건</td><td>${r.quotedCount?won(r.quoted):'—'}<small>견적 ${r.quotedCount}건 기준</small></td><td>${r.approvalCount} / ${r.signatureCount}건</td><td>${r.photoCount} / ${r.count}건</td></tr>`).join('')}</tbody></table></div><p class="performance-context">청구액은 수금·매출 확정액이 아닙니다. 고객 만족도·재수리율·작업 난이도는 아직 수집하지 않습니다. 기록이 없는 기사는 실적 부족으로 판단하지 않습니다.</p><details><summary>평가 근거 접수 기록 보기</summary>${rows.map(r=>`<div class="evidence-row"><strong>${escapeHtml(r.name)}</strong>${r.records.length?`<ul>${r.records.map(c=>`<li><button type="button" class="evidence-case" data-evidence-id="${escapeHtml(c.id)}">${escapeHtml(c.id)}</button> · ${escapeHtml(c.customerName)} · ${date(c.completedAt)} · ${escapeHtml(c.erp?.productName||c.equipmentId||'제품 확인 필요')}</li>`).join('')}</ul>`:'<p>해당 기간의 저장된 완료 기록이 없습니다.</p>'}</div>`).join('')}</details><small>출처: 이 브라우저에 저장된 현장 완료 기록. 지도 배차 CSV는 예정 업무이며 완료 실적으로 집계하지 않습니다.</small></section>`;
}
function engineerTimeline(engineer) {
  const active=state.cases.filter(c=>c.assignedEngineer===engineer && !['complete','remote-closed'].includes(c.stage));
  const stops=state.routePlans[engineer]?.stops||[];
  const next=stops.map(s=>active.find(c=>c.id===s.caseId)).find(Boolean)||active[0];
  const records=state.cases.filter(c=>c.assignedEngineer===engineer).flatMap(c=>(c.positionEvents||[]).map(event=>({...event,customerName:c.customerName}))).sort((a,b)=>b.at.localeCompare(a.at));
  const metric=state.routePlans[engineer]?.stops.find(s=>s.caseId===next?.id);
  return `<section class="route-card card"><h4>${escapeHtml(engineer)}</h4>${metric?`<p>이전 방문지/출발지에서 ${(metric.distanceMeters/1000).toFixed(1)}km · ${Math.ceil(metric.durationSeconds/60)}분 (지도 계산값)</p>`:''}<p>${next ? `${next.arrivedAt?'현장 작업 중':'이동 예정'}: ${escapeHtml(next.dispatchAddress)}` : '현재 배정 없음'}</p><ol class="location-flags">${records.map(event=>`<li><span aria-hidden="true">⚑</span> ${escapeHtml({arrival:'도착',approval:'고객 수리 동의 서명',complete:'수리 완료 · 고객 최종 서명'}[event.type])} · ${date(event.at)}<p>${escapeHtml(event.customerName)} · ${escapeHtml(event.address)}</p></li>`).join('')||'<li>아직 위치 기록이 없습니다.</li>'}</ol></section>`;
}
function recordPosition(item,type,at) {item.positionEvents ||= [];item.positionEvents.push({type,at,address:item.dispatchAddress||'출동 장소 확인 필요',basis:'dispatch-address'});}

function renderPriceMapping() {
  const target=$('#price-mapping'); if(!target)return;
  const sheet=priceSheets[Number($('#price-sheet').value)]; if(!sheet)return;
  const requested=Number($('#price-header')?.value||0); const header=Math.min(requested,sheet.rows.length-1);
  const width=Math.max(0,...sheet.rows.slice(0,30).map(row=>row.length));
  const choices=Array.from({length:width},(_,i)=>`<option value="${i}">${i+1}열 · ${escapeHtml(sheet.rows[header]?.[i]||'열 이름 없음')}</option>`).join('');
  target.innerHTML=`<label>열 제목이 있는 행<select id="price-header" name="headerRow">${sheet.rows.slice(0,20).map((row,i)=>`<option value="${i}" ${i===header?'selected':''}>${i+1}번째 내용 행 · ${escapeHtml(row.filter(Boolean).join(' / ').slice(0,80))}</option>`).join('')}</select></label><div class="price-columns">${[['nameColumn','부품명'],['retailColumn','소비자가'],['laborColumn','공임']].map(([key,label])=>`<label>${label} 열<select name="${key}" required><option value="">열 선택</option>${choices}</select></label>`).join('')}</div><div class="table-scroll"><table><caption>선택 시트 미리보기 (상위 6행)</caption><tbody>${sheet.rows.slice(header,header+6).map(row=>`<tr>${Array.from({length:width},(_,i)=>`<td>${escapeHtml(row[i]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function updateCloseButton(){const form=$('#close-form');if(form)$('#finish-call').disabled=!closeReady(form)||sending;}
function invalidateRoutes() { for(const [name,plan] of Object.entries(state.routePlans)){if(!state.cases.some(c=>c.assignedEngineer===name && !['complete','remote-closed'].includes(c.stage) && plan.stops.some(stop=>stop.caseId===c.id)))delete state.routePlans[name];} }

$('#role-manager').addEventListener('click',()=>{if(state.role!=='manager'&&window.prompt('팀장 화면 비밀번호를 입력하세요.')!==MANAGER_PASSWORD){window.alert('팀장 비밀번호가 올바르지 않습니다.');return;}state.role='manager';state.closeFormOpen=false;persist();render('top');renderPriceMapping();});
$('#staff-select').addEventListener('change',event=>{if(state.role==='counselor')state.selectedCounselor=event.target.value;else if(state.role==='engineer')state.selectedEngineer=event.target.value;persist();render('top');});
$('#conversation').addEventListener('change',event=>{
  if(event.target.id==='performance-period'){performanceDays=Number(event.target.value);const panel=$('.performance-panel');if(panel)panel.outerHTML=performanceView();}
  if(event.target.closest('#close-form'))updateCloseButton();
  if(event.target.id==='batch-ready')$('#batch-assign').disabled=!event.target.checked||routeBusy;
  if(event.target.id==='incident-type' || event.target.id==='insurance-repair') {
    const accident=$('#incident-type').value==='accident';
    $('.insurance-field').hidden=!accident;
    $('.insurance-enrollment').hidden=!(accident && $('#insurance-repair').value==='yes');
  }
  if(event.target.id==='price-sheet') { const old=$('#price-header');if(old)old.value='0';renderPriceMapping(); }
  if(event.target.id==='price-header')renderPriceMapping();
});
$('#conversation').addEventListener('input',event=>{
  if(event.target.closest('#close-form'))updateCloseButton();
  const form=event.target.closest('#plan-form'); if(!form)return;
  if(event.target.id==='part-search'){renderPartSuggestions(event.target.value);return;}
  if(event.target.matches('[data-part-qty]')){syncSelectedParts();return;}
  updateQuotePreview(form);
});
$('#conversation').addEventListener('click',async event=>{
  if(event.target.id!=='batch-assign' || routeBusy)return;
  if(state.role!=='manager')return;
  if(!$('#batch-ready')?.checked || state.cases.some(c=>['counseling','erp-pending','analyzing'].includes(c.stage)))return;
  const cases=structuredClone(pendingCases().filter(c=>!c.assignedEngineer)),origin=state.originAddress,engineers=availableEngineers();
  const button=event.target;routeBusy=true;button.disabled=true;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
  try {
    const plans=await planBatch(origin,cases,engineers,{signal:controller.signal});
    if(state.role!=='manager')throw new Error('팀장 화면에서 다시 실행해 주세요.');
    if(JSON.stringify(cases)!==JSON.stringify(pendingCases().filter(c=>!c.assignedEngineer))||origin!==state.originAddress||JSON.stringify(engineers)!==JSON.stringify(availableEngineers())||state.cases.some(c=>['counseling','erp-pending','analyzing'].includes(c.stage)))throw new Error('접수나 출발지가 변경되었습니다. 다시 계산해 주세요.');
    const previous=structuredClone(state);
    for(const plan of plans){state.routePlans[plan.engineer]=plan;for(const stop of plan.stops){const item=state.cases.find(c=>c.id===stop.caseId);item.assignedEngineer=plan.engineer;item.assignedAt=new Date().toISOString();item.status='출동 배정 완료';}}
    if(!persist()){Object.assign(state,previous);throw new Error('배정 저장에 실패했습니다.');}
    routeBusy=false;render('top');
  } catch(error){const notice=$('.route-notice');if(notice)notice.textContent=error.name==='AbortError'?'동선 계산 시간이 초과되었습니다.':error.message;}
  finally{clearTimeout(timer);routeBusy=false;if(button.isConnected)button.disabled=!$('#batch-ready')?.checked;}
});
$('#conversation').addEventListener('submit',async event=>{
  const form=event.target;
  if(!['origin-form','staff-form','catalog-file-form','catalog-map-form'].includes(form.id) && !form.classList.contains('assignment-form'))return;
  event.preventDefault();
  if(state.role!=='manager')return;
  const data=new FormData(form);
  try {
    if(form.id==='origin-form') {state.originAddress=String(data.get('originAddress')).trim();invalidateRoutes();}
    if(form.id==='staff-form') {
      const names=key=>[...new Set(String(data.get(key)).split('\n').map(n=>n.trim()).filter(Boolean))];
      const counselors=names('counselors'),engineers=names('engineers');
      if(!counselors.length||!engineers.length || [...counselors,...engineers].some(n=>n.length>80))throw new Error('상담사와 기사 이름은 각각 한 명 이상, 80자 이하로 입력해 주세요.');
      if(state.cases.some(c=>c.assignedEngineer && !engineers.includes(c.assignedEngineer) && !['complete','remote-closed'].includes(c.stage)))throw new Error('진행 중인 접수의 담당 기사를 재배정한 뒤 이름을 삭제해 주세요.');
      state.staff={counselors,engineers};if(!counselors.includes(state.selectedCounselor))state.selectedCounselor=counselors[0];if(!engineers.includes(state.selectedEngineer))state.selectedEngineer=engineers[0];invalidateRoutes();
    }
    if(form.id==='catalog-file-form') {
      const button=form.querySelector('button');button.disabled=true;button.textContent='엑셀 읽는 중…';
      try{const file=data.get('priceFile');priceSheets=await readPriceWorkbook(file);priceFileName=file.name;}
      finally{button.disabled=false;button.textContent='엑셀 읽기';}
      render('top');$('.manager-settings').open=true;renderPriceMapping();return;
    }
    if(form.id==='catalog-map-form') {
      const sheet=priceSheets[Number(data.get('sheet'))];
      if(['nameColumn','retailColumn','laborColumn'].some(k=>data.get(k)===''))throw new Error('부품명·소비자가·공임 열을 모두 선택해 주세요.');
      state.catalog=catalogFromRows(sheet.rows,Object.fromEntries(data));state.catalogSource=`${priceFileName} / ${sheet.name}`;priceSheets=[];
    }
    if(persist()){render('top');renderPriceMapping();}
  }catch(error){formError(form,error.message);}
});

async function bootstrap() {
  try {
    await seedFarmingboyDemo();
    if (state.role === 'manager') { state.role = 'counselor'; persist(); }
    render(state.role === 'engineer' || state.role === 'manager' ? 'top' : 'bottom');
    renderPriceMapping();
  } catch (error) {
    render(state.role === 'engineer' || state.role === 'manager' ? 'top' : 'bottom');
    const notice = document.createElement('p'); notice.className = 'form-error'; notice.textContent = error.message;
    $('#conversation')?.prepend(notice);
  }
}
bootstrap();
