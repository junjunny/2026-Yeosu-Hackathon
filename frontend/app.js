import { loadState, saveState, createCase, replyToCounselor, buildAnalysis, unavailableAnalysis } from './services.js';

import { migrateState, customerChecklist, travelFee, parseParts, estimateTotal } from './workflow.js';
import { planBatch, routeConfig } from './route-provider.js';
import { readPriceWorkbook, catalogFromRows } from './price-import.js';

import { managerAccess } from './manager-access.js';
import { dashboardStats, durationMinutes, closeReady } from './dashboard.js';

const state = migrateState(loadState());
let managerAuthorized = false;
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
  return `<div class="quote-card"><h4>${p.legacy ? '이전 버전 견적 · 출장비 확인 필요' : '최종 견적서'}</h4><p>${escapeHtml(p.details)}</p><div class="quote-row"><strong>부품비 (소비자가 + 공임)</strong><strong>금액</strong></div>${p.parts.map(part=>`<div class="quote-row"><span>${escapeHtml(part.name)} × ${part.qty}</span><span>${won(part.qty*part.unitPrice)}</span></div>`).join('')}${p.legacy?`<div class="quote-row"><span>이전 작업비</span><span>${won(p.laborPrice)}</span></div>`:`<div class="quote-row"><span>출장비</span><span>${won(p.travelFee)}</span></div>`}<div class="quote-row quote-total"><strong>청구 총액</strong><strong>${won(quoteTotal(p))}</strong></div><small>가격표: ${escapeHtml(p.catalogSource || '이전 합성 견적')} · ${p.quotedAt ? date(p.quotedAt) : ''}</small></div>`;
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

function stageForm(item) {
  switch (item.stage) {
    case 'awaiting-arrival':
      return `<form id="arrival-form" class="note-composer chat-composer"><label class="sr-only" for="arrival-text">현장 도착 메시지</label><input id="arrival-text" name="text" required autocomplete="off" placeholder="현장에 도착하면 ‘도착’이라고 입력하세요…"><button type="submit" aria-label="도착 메시지 보내기">↗</button></form>`;
    case 'checklist':
      return `<form id="checklist-form" class="stage-form"><div class="checklist">${item.analysis.checklist.map((step, i) => `<label class="check-row"><input type="checkbox" name="step" value="${i}"><span>${escapeHtml(step)}</span></label>`).join('')}</div><label>고객과 확인한 점검 결과<textarea name="findings" rows="3" required maxlength="2000" placeholder="브레이크·타이어 상태와 고객 증상 확인 결과"></textarea></label><button class="primary-button" type="submit">체크 결과 보내기</button></form>`;
    case 'before-photos':
      return `<form id="before-photos-form" class="stage-form"><label>현장 확인 · 수리 전 사진 (여러 장)<input name="beforePhotos" type="file" accept="image/*" multiple required></label><small>점검 결과와 수리 전 상태를 첨부한 뒤 견적을 작성합니다.</small><button class="primary-button" type="submit">수리 전 사진 저장</button></form>`;
    case 'repair-plan':
      return `<form id="plan-form" class="stage-form"><label>수리 예정 내용<textarea name="details" rows="3" maxlength="2000" required></textarea></label><label>부품과 수량<textarea name="partsChat" rows="4" required placeholder="가격표의 정확한 부품명 × 2&#10;다른 부품명 × 1"></textarea></label><details><summary>사용 가능한 부품 · ${state.catalog.length}개</summary>${state.catalog.length?`<ul>${state.catalog.map(p=>`<li>${escapeHtml(p.name)} (${escapeHtml(p.id)}) · ${won(p.retailPrice+p.laborPrice)}</li>`).join('')}</ul>`:'<p>팀장 화면에서 부품 가격표 엑셀을 등록해 주세요. 확인되지 않은 가격으로는 견적을 만들지 않습니다.</p>'}</details><label>출장 지역<select name="region" required><option value="">선택해 주세요</option><option value="naju">나주 관내 · 33,000원</option><option value="jeonnam">전남 내 나주 외 · 거리별 적용</option><option value="outside">전남 외 · 100,000원</option></select></label><label>출장 거리 (km)<input name="distanceKm" type="number" min="0" step="0.1" inputmode="decimal"><small>나주 외 전남 지역은 필수입니다. 60km 미만 55,000원 / 60~100km 미만 77,000원 / 100km 이상 100,000원</small></label><p id="quote-preview" role="status">부품비는 소비자가와 공임을 합산합니다.</p><button class="primary-button" type="submit">자동 계산 · 견적 확인</button></form>`;
    case 'customer-approval':
      return quoteCard(item) + signatureForm('approval', '고객에게 부품·가격·총액을 설명한 후 수리 진행 동의를 받아 주세요.', '표시된 수리 내용과 예상 금액에 동의합니다.');
    case 'repair-notes':
      return `<form id="repair-notes-form" class="stage-form"><label>실제 수리 내용과 결과<textarea name="repairNotes" rows="5" maxlength="3000" required placeholder="교체한 부품, 실제 조치, 재시험 결과를 적어 주세요…"></textarea></label><button class="primary-button" type="submit">수리 내역 보내기</button></form>`;
    case 'photos':
      return `<form id="photos-form" class="stage-form"><label>수리 후 사진 (여러 장)<input name="afterPhotos" type="file" accept="image/*" multiple required></label><button class="primary-button" type="submit">수리 후 사진 저장</button></form>`;
    case 'final-verification':
      return `${photoGallery(item)}${signatureForm('verification', '고객에게 개인정보 처리 내역을 안내하고 요청한 수리 이행 여부를 확인해 주세요.', '요청하신 수리를 잘 이행하였음을 확인했습니다.')}`;
    case 'complete':
      return `<div class="completion-card card"><div class="card-title"><span class="step-index done">✓</span><div><h3>현장 완료 보고</h3><p>${date(item.completedAt)} · 수리 동의 및 수리 이행 확인 서명 저장</p></div></div>${quoteCard(item)}<p><b>실제 수리</b> ${escapeHtml(item.repairNotes)}</p>${photoGallery(item)}<div class="signature-receipts">${signatureReceipt(item.approvalSignature, '수리 진행 동의')}${signatureReceipt(item.finalSignature, '수리 이행 확인')}</div></div>`;
    default: return '<div class="waiting-box">이 상담은 출동 없이 원격 안내로 종료되었습니다.</div>';
  }
}

function engineerView(item) {
  if (item.dispatch?.required && !item.assignedEngineer) return '<div class="waiting-box">전체 접수 후 팀장의 동선 계산·일괄 배정을 기다립니다.</div>';
  if (item.stage === 'erp-pending') return `<div class="waiting-box">상담사가 ERP 정보를 확인하고 있습니다.</div>${transcript(item,true)}`;
  if (item.assignedEngineer && item.assignedEngineer !== state.selectedEngineer) return '<div class="waiting-box">다른 기사에게 배정된 접수입니다. 담당자를 변경해 확인하세요.</div>';
  if (item.stage === 'counseling') return `<div class="waiting-box">상담이 진행 중입니다. 통화 종료 후 기술 진단과 원문 대화가 표시됩니다.</div>${transcript(item, true)}`;
  const log = item.fieldLog.map(message => bubble(message.role, message.text, message.createdAt, '', message.authorName)).join('');
  return `${diagnosisCard(item)}${item.erp ? `<div class="quote-card"><b>ERP 확인</b><p>제품명: ${escapeHtml(item.erp.productName)} · 구입 시점: ${escapeHtml(item.erp.purchaseDate)}</p><p>과거 수리 이력: ${lines(item.erp.repairHistory)}</p></div>` : ''}${transcript(item, true)}<div class="field-conversation"><div class="thread-intro"><span class="thread-line"></span><span>현장 진행 대화</span><span class="thread-line"></span></div>${log}${stageForm(item)}</div>`;
}

function renderDetails() {
  const item = current();
  const stages = ['상담 원문 기록', 'ERP 확인·배정', '현장 점검·견적·동의', '수리 완료·확인'];
  const step = !item || item.stage === 'counseling' ? 0 : ['awaiting-arrival','checklist','before-photos','repair-plan','customer-approval','remote-closed'].includes(item.stage) ? 2 : item.stage === 'complete' ? 4 : 3;
  return `<div class="detail-card"><div class="detail-heading"><span class="eyebrow">접수 진행</span><h3>${item ? escapeHtml(item.id) : '새 상담 대기'}</h3><p>${item ? `${escapeHtml(item.customerName)} · ${escapeHtml(item.registeredAddress || '등록 주소 확인 필요')}` : '고객과 장비를 선택해 시작하세요.'}</p></div><div class="progress-list">${stages.map((name,i) => `<div class="progress-item ${i < step ? 'completed' : i === step ? 'current' : ''}"><span>${i < step ? '✓' : i+1}</span><strong>${escapeHtml(name)}</strong></div>`).join('')}</div></div><div class="help-card"><span aria-hidden="true">ⓘ</span><div><strong>합성 데이터 시연</strong><p>고객·사례·가격·서명은 시연용입니다. AgentStream 키와 팀 API는 아직 연결되지 않았습니다.</p></div></div>`;
}

function render(scrollPosition = 'bottom') {
  const item = current();
  $('#page-title').textContent = state.role === 'manager' ? '팀장 배정·동선' : item ? `${item.customerName} 상담` : '새 상담';
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
  $('#case-list').innerHTML = state.cases.length ? [...state.cases].reverse().map(c => `<button type="button" class="case-item ${c.id === state.activeId ? 'active' : ''}" data-case-id="${c.id}"><span class="case-item-top"><strong>${escapeHtml(c.customerName)}</strong><small>${date(c.createdAt)}</small></span><span class="case-item-symptom">${escapeHtml(c.transcript.find(m => m.role === 'counselor')?.text || '상담 대기')}</span><span class="case-item-status">${escapeHtml(c.status)}</span></button>`).join('') : '<p class="empty-cases">아직 접수된 상담이 없습니다.</p>';
  $('#conversation').innerHTML = state.role==='manager' ? managerView() : item ? (state.role === 'engineer' ? engineerView(item) : counselorView(item)) : startView();
  $('.content-grid').classList.toggle('manager-layout',state.role==='manager');
  $('#details').innerHTML = state.role==='manager' ? '' : renderDetails();
  bindSignature();
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
    try { item.transcript.push(entry('assistant', await replyToCounselor(item, text))); }
    catch { item.transcript.push(entry('assistant', '사례 연결을 확인할 수 없습니다. 고객에게 안전 상태를 먼저 확인하고, 기술 답변은 확인 필요로 남겨 주세요.')); }
    item.status = '상담 중'; sending = false; if (persist()) render(); return;
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
      const fee=travelFee({region:data.get('region'),distanceKm:data.get('distanceKm')});
      item.repairPlan={details:String(data.get('details')).trim(),parts,travelFee:fee,region:data.get('region'),distanceKm:data.get('distanceKm'),catalogSource:state.catalogSource,quotedAt:new Date().toISOString()};
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
      if (!files.length || files.length>12) throw new Error('사진은 1~12장씩 첨부해 주세요.');
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
function managerView() {
  if(!managerAuthorized)return '<div class="waiting-box"><h2>팀장 전용 대시보드</h2><p>팀장 계정 인증이 필요합니다. 인증 서비스 연결 후 접근할 수 있습니다.</p></div>';
  const {done,todo}=dashboardStats(state.cases);
  const queue=pendingCases().filter(c=>!c.assignedEngineer);
  const collecting=state.cases.some(c=>['counseling','erp-pending','analyzing'].includes(c.stage));
  return `<div class="manager-view"><h2>오늘의 현장 운영</h2><div class="dashboard-stats"><article><span>오늘의 해결된 건수</span><strong>${done.length}</strong></article><article><span>오늘의 해야 할 건수</span><strong>${todo.length}</strong><small>이월 미완료 포함</small></article></div><h3>전체 접수 · 동선 일괄 배정</h3><p>기사 역량은 동일하게 보고 출동 장소의 거리·시간으로 동선을 구성한 뒤 기사 이름을 무작위로 연결합니다.</p><form id="origin-form" class="stage-form"><label>동선 출발지 주소<input name="originAddress" required maxlength="300" value="${escapeHtml(state.originAddress)}"></label><button class="ghost-button" type="submit">출발지 저장</button></form><label class="consent-row"><input id="batch-ready" type="checkbox" ${collecting?'disabled':''}>이번 배정에 포함할 모든 사건의 접수가 끝났습니다.</label><p class="route-notice" role="status">${collecting?'진행 중인 상담을 먼저 종료해 주세요.':'출동 장소 기준으로 동선을 계산합니다. 지도 서비스 연결 전에는 배정하지 않습니다.'}</p><button id="batch-assign" class="primary-button" disabled>전체 동선 계산 · 기사 무작위 일괄 배정</button><div class="dispatch-queue">${queue.map(c=>`<article class="card"><div class="queue-heading"><strong>${escapeHtml(c.customerName)}</strong>${labelBadge(priorityLabel(c.priority))}</div><p>출동 장소: ${escapeHtml(c.dispatchAddress||'확인 필요')}</p><p>등록 주소: ${escapeHtml(c.registeredAddress)}</p><p>${escapeHtml(c.analysis?.diagnosis||'확인 필요')}</p></article>`).join('')||'<p>미배정 출동 접수가 없습니다.</p>'}</div><h3>기사별 이동 · 위치 기록</h3><p>주소 기반 방문 기록입니다. 실시간 GPS 위치와 지도는 연결 전입니다.</p>${state.staff.engineers.map(engineer=>engineerTimeline(engineer)).join('')}<h3>오늘 해결된 수리 · 시간과 비용</h3><div class="table-scroll"><table><thead><tr><th>고객 / 기사</th><th>완료 시점</th><th>수리 소요시간</th><th>청구액 (견적 기준)</th></tr></thead><tbody>${done.map(c=>`<tr><td>${escapeHtml(c.customerName)} / ${escapeHtml(c.assignedEngineer||'원격 안내')}</td><td>${date(c.completedAt||c.closedAt)}</td><td>${durationMinutes(c)==null?'기록 없음':durationMinutes(c)+'분'}</td><td>${c.repairPlan?won(quoteTotal(c.repairPlan)):'해당 없음'}</td></tr>`).join('')||'<tr><td colspan="4">오늘 완료된 수리가 없습니다.</td></tr>'}</tbody></table></div><details class="manager-settings"><summary>담당자·부품 가격표 관리</summary><form id="staff-form" class="stage-form"><label>상담사 이름 · 한 줄에 한 명<textarea name="counselors" rows="3" required>${escapeHtml(state.staff.counselors.join('\n'))}</textarea></label><label>기사 이름 · 한 줄에 한 명<textarea name="engineers" rows="3" required>${escapeHtml(state.staff.engineers.join('\n'))}</textarea></label><button class="primary-button" type="submit">담당자 저장</button></form><form id="catalog-file-form" class="stage-form"><label>파밍보이 부품 가격표 (.xlsx)<input name="priceFile" type="file" accept=".xlsx" required></label><p>현재 가격표: ${escapeHtml(state.catalogSource||'등록 전')} · ${state.catalog.length}개 부품</p><button class="primary-button" type="submit">엑셀 읽기</button></form>${priceImportView()}</details></div>`;
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

$('#role-manager').addEventListener('click',async()=>{managerAuthorized=await managerAccess();state.role='manager';state.closeFormOpen=false;persist();render('top');renderPriceMapping();});
$('#staff-select').addEventListener('change',event=>{if(state.role==='counselor')state.selectedCounselor=event.target.value;else if(state.role==='engineer')state.selectedEngineer=event.target.value;persist();render('top');});
$('#conversation').addEventListener('change',event=>{
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
  const data=new FormData(form);
  try {const parts=parseParts(String(data.get('partsChat')),state.catalog);const fee=travelFee({region:data.get('region'),distanceKm:data.get('distanceKm')});$('#quote-preview').textContent=`부품비 ${won(parts.reduce((sum,p)=>sum+p.qty*p.unitPrice,0))} + 출장비 ${won(fee)} = ${won(estimateTotal({parts,travelFee:fee}))}`;}
  catch(error){$('#quote-preview').textContent=error.message;}
});
$('#conversation').addEventListener('click',async event=>{
  if(event.target.id!=='batch-assign' || routeBusy)return;
  if(!await managerAccess()){managerAuthorized=false;render('top');return;}
  if(!$('#batch-ready')?.checked || state.cases.some(c=>['counseling','erp-pending','analyzing'].includes(c.stage)))return;
  const cases=structuredClone(pendingCases().filter(c=>!c.assignedEngineer)),origin=state.originAddress,engineers=availableEngineers();
  const button=event.target;routeBusy=true;button.disabled=true;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
  try {
    const plans=await planBatch(origin,cases,engineers,{signal:controller.signal});
    if(state.role!=='manager' || !await managerAccess())throw new Error('팀장 인증을 다시 확인해 주세요.');
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
  if(state.role!=='manager' || !await managerAccess()){managerAuthorized=false;render('top');return;}
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

render(state.role === 'engineer' || state.role === 'manager' ? 'top' : 'bottom');
renderPriceMapping();

