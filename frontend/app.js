import { loadState, saveState, createCase, replyToCounselor, buildAnalysis, unavailableAnalysis } from './services.js';

const state = loadState();
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lines = value => escapeHtml(value).replace(/\n/g, '<br>');
const date = value => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
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
function entry(role, text) { return { role, text, createdAt: new Date().toISOString() }; }
function bubble(role, text, createdAt, extra = '') {
  const isAgent = role === 'assistant';
  const name = isAgent ? 'Fieldnote' : role === 'engineer' ? '엔지니어' : '상담사';
  const symbol = isAgent ? 'F' : role === 'engineer' ? '엔' : '상';
  return `<article class="message ${isAgent ? '' : 'user'}"><div class="avatar ${isAgent ? '' : 'user'}" aria-hidden="true">${symbol}</div><div class="message-body"><div class="message-head"><strong>${name}</strong><span>${date(createdAt)}</span></div><div class="${isAgent ? 'agent-bubble' : 'user-bubble'}">${lines(text)}${extra}</div></div></article>`;
}
function labelBadge(text, style = '') { return `<span class="badge ${style}">${escapeHtml(text)}</span>`; }
function statusText(item) { return item?.status || '접수 준비'; }

function startView() {
  return `<div class="welcome"><div class="welcome-icon" aria-hidden="true">✳</div><h2>고객의 말을 그대로 기록하세요.</h2><p>통화 중 상담 내용을 보내면 챗봇이 사례를 근거로 응답합니다. 통화가 끝나면 기록은 읽기 전용으로 전환됩니다.</p></div>
    <article class="message"><div class="avatar" aria-hidden="true">F</div><div class="message-body"><div class="message-head"><strong>Fieldnote</strong></div><div class="card"><div class="card-title"><span class="step-index">1</span><div><h3>상담 시작</h3><p>고객과 장비를 고른 뒤 통화 내용을 입력하세요.</p></div></div><form id="start-form" class="form-grid"><label>고객<select name="customerId" autocomplete="off" required><option value="">고객 선택</option><option>고객 A</option><option>고객 B</option><option>고객 C</option></select></label><label>장비<select name="equipmentId" autocomplete="off" required><option value="">장비 선택</option><option>장비 A-01</option><option>장비 B-02</option><option>장비 C-03</option></select></label><div class="form-actions full"><button class="primary-button" type="submit">상담 시작</button></div></form></div></div></article><p class="demo-note">합성 고객·사례만 사용하는 시연 모드입니다.</p>`;
}

function transcript(item, engineerView = false) {
  const html = item.transcript.map(message => bubble(message.role, message.text, message.createdAt)).join('');
  if (!engineerView) return `<div class="thread-intro"><span class="thread-line"></span><span>${date(item.createdAt)} · 통화 대화</span><span class="thread-line"></span></div>${html}`;
  return `<details class="raw-transcript"><summary>상담사와 챗봇의 원문 대화 <span>${item.transcript.length}건 · 펼쳐 보기</span></summary><div class="raw-transcript-body">${html}</div></details>`;
}

function callEndForm(item) {
  return `<article class="message"><div class="avatar" aria-hidden="true">F</div><div class="message-body"><div class="message-head"><strong>Fieldnote</strong></div><div class="card"><div class="card-title"><span class="step-index">2</span><div><h3>통화 종료 전 확인</h3><p>아래 3개 항목은 원문과 별도로 확정해야 출동 규칙을 적용할 수 있습니다.</p></div></div><form id="close-form" class="form-grid"><div class="full">${yesNo('visitRequested', '고객이 방문을 요청했나요?')}${yesNo('cannotDrive', '주행이 불가능한가요?')}${yesNo('selfCareWanted', '고객이 직접 조치하기를 원하나요?')}</div><label class="full">일반 건 출동 여부<select name="manualChoice" required><option value="">선택해 주세요</option><option value="yes">출동</option><option value="no">원격 안내</option></select><small>고객 요청·주행 불가·유사 사례 없음 규칙에 해당하면 이 선택보다 출동 규칙이 우선합니다.</small></label><div class="form-actions full"><button class="ghost-button" type="button" id="cancel-close">통화 계속</button><button class="primary-button" type="submit">통화 종료 · 기록 잠금</button></div></form></div></div></article>`;
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
    html += `<div class="locked-note" role="status"><span aria-hidden="true">🔒</span><div><strong>통화가 종료되었습니다.</strong><p>상담사 대화는 읽기 전용입니다. 출동 결과: ${decision?.required ? '출동' : '원격 안내'} (${escapeHtml(decision?.rule || '확인 필요')})</p></div></div>`;
  }
  return html;
}

function diagnosisCard(item) {
  if (!item.analysis) return '<div class="waiting-box">상담 분석을 기다리고 있습니다.</div>';
  const a = item.analysis;
  const sources = a.similar.length ? a.similar.map(s => `<li><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.source)} · 관련 단어 ${s.score}개</span></li>`).join('') : '<li>확인 필요: 찾은 사례가 없습니다.</li>';
  const history = a.history.length ? a.history.map(h => `${escapeHtml(h.id)} (${escapeHtml(h.status)})`).join(', ') : '이전 접수 없음';
  return `<section class="diagnosis-card" aria-label="엔지니어 진단"><div class="diagnosis-top"><span class="diagnosis-label">초기 기술 진단 · ${a.mode === 'mock' ? '합성 데이터' : '확인 필요'}</span>${labelBadge(item.dispatch.required ? '출동 확정' : '원격 안내', item.dispatch.required ? 'violet' : 'green')}</div><h2>${escapeHtml(a.diagnosis)}</h2><p><b>적용 규칙</b> ${escapeHtml(item.dispatch.rule)} · ${escapeHtml(item.dispatch.reason)}</p><p><b>고객 이력</b> ${history}</p><details><summary>유사 사례와 출처</summary><ul>${sources}</ul></details>${a.missingInfo.length ? `<div class="missing-box"><strong>확인 필요</strong><p>${a.missingInfo.map(escapeHtml).join(' · ')}</p></div>` : ''}</section>`;
}

function quoteTotal(plan) { return plan.parts.reduce((sum, part) => sum + part.qty * part.unitPrice, 0) + plan.laborPrice; }
function quoteCard(item) {
  const p = item.repairPlan;
  if (!p) return '';
  return `<div class="quote-card"><h4>고객 수리 동의 내역</h4><p>${escapeHtml(p.details)}</p><div class="quote-row"><strong>부품</strong><strong>금액</strong></div>${p.parts.map(part => `<div class="quote-row"><span>${escapeHtml(part.name)} × ${part.qty}</span><span>${won(part.qty * part.unitPrice)}</span></div>`).join('')}<div class="quote-row"><span>작업비</span><span>${won(p.laborPrice)}</span></div><div class="quote-row quote-total"><strong>총 예상 금액</strong><strong>${won(quoteTotal(p))}</strong></div><small>합성 시연용 견적입니다. 실제 가격이 아닙니다.</small></div>`;
}

function signatureReceipt(signature, title) {
  if (!signature) return '';
  const signed = signature.image
    ? `<img src="${signature.image}" width="200" height="60" alt="${escapeHtml(title)} 그림 서명">`
    : `<strong>${escapeHtml(signature.typedName)}</strong>`;
  return `<div class="signature-receipt"><span>${escapeHtml(title)}</span>${signed}<small>${date(signature.signedAt)}</small></div>`;
}

function signatureForm(kind, question, checkboxText) {
  return `<form id="${kind}-form" class="stage-form"><p>${question}</p><label class="consent-row"><input name="consent" type="checkbox" required><span>${checkboxText}</span></label><label>고객 서명<canvas class="signature-pad" width="550" height="150" aria-label="고객 서명 영역"></canvas></label><button type="button" class="signature-clear ghost-button">서명 다시 쓰기</button><label>직접 서명할 수 없는 경우 성명 입력<input name="typedName" maxlength="80" autocomplete="off" placeholder="고객 성명 입력…"></label><small>그림 서명 또는 성명 입력 중 하나가 필요합니다. 이 시연에서는 합성 이름만 사용하세요.</small><button class="primary-button" type="submit">${kind === 'approval' ? '고객 수리 동의 저장' : '정상 작동 확인 서명 저장'}</button></form>`;
}

function stageForm(item) {
  switch (item.stage) {
    case 'awaiting-arrival':
      return `<form id="arrival-form" class="note-composer chat-composer"><label class="sr-only" for="arrival-text">현장 도착 메시지</label><input id="arrival-text" name="text" required autocomplete="off" placeholder="현장에 도착하면 ‘도착’이라고 입력하세요…"><button type="submit" aria-label="도착 메시지 보내기">↗</button></form>`;
    case 'checklist':
      return `<form id="checklist-form" class="stage-form"><div class="checklist">${item.analysis.checklist.map((step, i) => `<label class="check-row"><input type="checkbox" name="step" value="${i}"><span>${escapeHtml(step)}</span></label>`).join('')}</div><button class="primary-button" type="submit">체크 결과 보내기</button></form>`;
    case 'repair-plan':
      return `<form id="plan-form" class="stage-form"><label>예상 수리 내용<textarea name="details" rows="3" maxlength="2000" required placeholder="점검 결과와 수리 예정 내용을 적어 주세요…"></textarea></label><div class="part-heading">부품과 가격</div>${[0,1].map(i => `<div class="part-row"><label>부품 ${i+1}${i ? ' (선택)' : ''}<input name="partName${i}" ${i ? '' : 'required'} autocomplete="off" placeholder="부품명…"></label><label>수량<input name="qty${i}" type="number" min="1" step="1" value="1" inputmode="numeric"></label><label>단가 (원)<input name="price${i}" type="number" min="0" step="1" ${i ? '' : 'required'} inputmode="numeric" placeholder="0"></label></div>`).join('')}<label>작업비 (원)<input name="laborPrice" type="number" min="0" step="1" required inputmode="numeric" value="0"></label><button class="primary-button" type="submit">수리 계획과 견적 보내기</button></form>`;
    case 'customer-approval':
      return quoteCard(item) + signatureForm('approval', '고객에게 부품·가격·총액을 설명한 후 수리 진행 동의를 받아 주세요.', '표시된 수리 내용과 예상 금액에 동의합니다.');
    case 'repair-notes':
      return `<form id="repair-notes-form" class="stage-form"><label>실제 수리 내용과 결과<textarea name="repairNotes" rows="5" maxlength="3000" required placeholder="교체한 부품, 실제 조치, 재시험 결과를 적어 주세요…"></textarea></label><button class="primary-button" type="submit">수리 내역 보내기</button></form>`;
    case 'photos':
      return `<form id="photos-form" class="stage-form"><div class="photo-inputs"><label>작업 전 사진<input name="beforePhoto" type="file" accept="image/*" capture="environment" required></label><label>작업 후 사진<input name="afterPhoto" type="file" accept="image/*" capture="environment" required></label></div><button class="primary-button" type="submit">비포·애프터 사진 보내기</button></form>`;
    case 'final-verification':
      return `<div class="photo-pair"><figure><img src="${item.beforePhoto}" width="220" height="130" loading="lazy" alt="작업 전 사진"><figcaption>작업 전</figcaption></figure><figure><img src="${item.afterPhoto}" width="220" height="130" loading="lazy" alt="작업 후 사진"><figcaption>작업 후</figcaption></figure></div>${signatureForm('verification', '고객과 함께 정상 작동 여부를 확인하고 최종 서명을 받아 주세요.', '수리 후 장비가 정상 작동하는 것을 확인했습니다.')}`;
    case 'complete':
      return `<div class="completion-card card"><div class="card-title"><span class="step-index done">✓</span><div><h3>현장 완료 보고</h3><p>${date(item.completedAt)} · 수리 동의 및 정상 작동 확인 서명 저장</p></div></div>${quoteCard(item)}<p><b>실제 수리</b> ${escapeHtml(item.repairNotes)}</p><div class="photo-pair"><figure><img src="${item.beforePhoto}" width="220" height="130" loading="lazy" alt="작업 전 사진"><figcaption>작업 전</figcaption></figure><figure><img src="${item.afterPhoto}" width="220" height="130" loading="lazy" alt="작업 후 사진"><figcaption>작업 후</figcaption></figure></div><div class="signature-receipts">${signatureReceipt(item.approvalSignature, '수리 진행 동의')}${signatureReceipt(item.finalSignature, '정상 작동 확인')}</div></div>`;
    default: return '<div class="waiting-box">이 상담은 출동 없이 원격 안내로 종료되었습니다.</div>';
  }
}

function engineerView(item) {
  if (item.stage === 'counseling') return `<div class="waiting-box">상담이 진행 중입니다. 통화 종료 후 기술 진단과 원문 대화가 표시됩니다.</div>${transcript(item, true)}`;
  const log = item.fieldLog.map(message => bubble(message.role, message.text, message.createdAt)).join('');
  return `${diagnosisCard(item)}${transcript(item, true)}<div class="field-conversation"><div class="thread-intro"><span class="thread-line"></span><span>현장 진행 대화</span><span class="thread-line"></span></div>${log}${stageForm(item)}</div>`;
}

function renderDetails() {
  const item = current();
  const stages = ['상담 원문 기록', '기술 진단·출동', '현장 도착·수리 동의', '수리 완료·검증'];
  const step = !item || item.stage === 'counseling' ? 0 : ['awaiting-arrival','checklist','repair-plan','customer-approval','remote-closed'].includes(item.stage) ? 2 : item.stage === 'complete' ? 4 : 3;
  return `<div class="detail-card"><div class="detail-heading"><span class="eyebrow">접수 진행</span><h3>${item ? escapeHtml(item.id) : '새 상담 대기'}</h3><p>${item ? `${escapeHtml(item.customerId)} · ${escapeHtml(item.equipmentId)}` : '고객과 장비를 선택해 시작하세요.'}</p></div><div class="progress-list">${stages.map((name,i) => `<div class="progress-item ${i < step ? 'completed' : i === step ? 'current' : ''}"><span>${i < step ? '✓' : i+1}</span><strong>${name}</strong></div>`).join('')}</div></div><div class="help-card"><span aria-hidden="true">ⓘ</span><div><strong>합성 데이터 시연</strong><p>고객·사례·가격·서명은 시연용입니다. AgentStream 키와 팀 API는 아직 연결되지 않았습니다.</p></div></div>`;
}

function render(scrollPosition = 'bottom') {
  const item = current();
  $('#page-title').textContent = item ? `${item.customerId} 상담` : '새 상담';
  $('#thread-id').textContent = item?.id || '새 접수';
  $('#thread-status').textContent = statusText(item);
  $('#case-count').textContent = state.cases.length;
  $('#role-counselor').classList.toggle('active', state.role === 'counselor');
  $('#role-engineer').classList.toggle('active', state.role === 'engineer');
  $('#role-counselor').setAttribute('aria-pressed', String(state.role === 'counselor'));
  $('#role-engineer').setAttribute('aria-pressed', String(state.role === 'engineer'));
  $('#case-list').innerHTML = state.cases.length ? [...state.cases].reverse().map(c => `<button type="button" class="case-item ${c.id === state.activeId ? 'active' : ''}" data-case-id="${c.id}"><span class="case-item-top"><strong>${escapeHtml(c.customerId)}</strong><small>${date(c.createdAt)}</small></span><span class="case-item-symptom">${escapeHtml(c.transcript.find(m => m.role === 'counselor')?.text || '상담 대기')}</span><span class="case-item-status">${escapeHtml(c.status)}</span></button>`).join('') : '<p class="empty-cases">아직 접수된 상담이 없습니다.</p>';
  $('#conversation').innerHTML = item ? (state.role === 'engineer' ? engineerView(item) : counselorView(item)) : startView();
  $('#details').innerHTML = renderDetails();
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
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const scale = Math.min(1, 1100 / Math.max(img.width, img.height));
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
  const form = event.target; const data = new FormData(form); const item = current();
  if (form.id === 'start-form') {
    const created = createCase(String(data.get('customerId')), String(data.get('equipmentId')));
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
    const flags = { visitRequested:data.get('visitRequested')==='yes', cannotDrive:data.get('cannotDrive')==='yes', selfCareWanted:data.get('selfCareWanted')==='yes' };
    const manualChoice = data.get('manualChoice') === 'yes';
    item.flags = flags; item.transcript.push(entry('assistant','통화가 종료되었습니다. 상담 원문은 잠겼으며 엔지니어에게 전달됩니다.'));
    try { item.analysis = await buildAnalysis(item, state.cases, flags, manualChoice); }
    catch { item.analysis = unavailableAnalysis(flags, manualChoice); }
    item.dispatch = item.analysis.dispatch;
    item.stage = item.dispatch.required ? 'awaiting-arrival' : 'remote-closed';
    item.status = item.dispatch.required ? '출동 대기' : '원격 안내 종료';
    if (item.dispatch.required) item.fieldLog.push(entry('assistant', "현장에 도착하면 ‘도착’이라고 보내주세요."));
    state.closeFormOpen = false; if (persist()) render(); return;
  }
  if (state.role !== 'engineer') return;
  if (form.id === 'arrival-form' && item.stage === 'awaiting-arrival') {
    const text = String(data.get('text')).trim();
    if (!text.includes('도착')) return formError(form, '현장에 도착했으면 “도착”이라고 입력해 주세요.', 'text');
    advance(item, text, 'checklist', '도착이 확인되었습니다. 아래 체크리스트를 확인하고 결과를 보내주세요.', '현장 도착'); return;
  }
  if (form.id === 'checklist-form' && item.stage === 'checklist') {
    const checked = data.getAll('step');
    if (checked.length !== item.analysis.checklist.length) return formError(form, '모든 체크리스트 항목을 확인해 주세요.', 'step');
    item.checklistDone = checked.map(Number);
    advance(item, '체크리스트 전 항목 확인 완료', 'repair-plan', '점검 결과를 바탕으로 수리 예정 내용, 부품, 수량과 가격을 입력해 주세요.', '점검 완료'); return;
  }
  if (form.id === 'plan-form' && item.stage === 'repair-plan') {
    const parts = [0,1].map(i => ({ name:String(data.get(`partName${i}`)||'').trim(), qty:Number(data.get(`qty${i}`)), unitPrice:Number(data.get(`price${i}`)) })).filter(p => p.name);
    if (!parts.length || parts.some(p => !Number.isInteger(p.qty) || p.qty < 1 || !Number.isFinite(p.unitPrice) || p.unitPrice < 0)) return formError(form, '부품명, 수량, 단가를 확인해 주세요.', 'partName0');
    const laborPrice = Number(data.get('laborPrice'));
    if (!Number.isFinite(laborPrice) || laborPrice < 0) return formError(form, '작업비를 확인해 주세요.', 'laborPrice');
    item.repairPlan = { details:String(data.get('details')).trim(), parts, laborPrice };
    advance(item, `수리 계획과 예상 총액 ${won(quoteTotal(item.repairPlan))} 입력`, 'customer-approval', '고객에게 수리 내용과 총액을 설명한 뒤 진행 동의 서명을 받아 주세요.', '고객 동의 대기'); return;
  }
  if (form.id === 'approval-form' && item.stage === 'customer-approval') {
    const name = String(data.get('typedName')||'').trim();
    if (!signatureHasInk && !name) return formError(form, '서명 영역에 서명하거나 고객 성명을 입력해 주세요.', 'typedName');
    item.approvalSignature = { image:signatureHasInk ? $('.signature-pad').toDataURL('image/png') : null, typedName:name, signedAt:new Date().toISOString() };
    advance(item, '고객이 예상 수리 내용과 금액에 동의함', 'repair-notes', '수리를 마쳤다면 실제 수리 내용과 조치 결과를 적어 주세요.', '수리 진행 중'); return;
  }
  if (form.id === 'repair-notes-form' && item.stage === 'repair-notes') {
    item.repairNotes = String(data.get('repairNotes')).trim();
    advance(item, item.repairNotes, 'photos', '작업 전·후 사진을 업로드해 주세요.', '사진 대기'); return;
  }
  if (form.id === 'photos-form' && item.stage === 'photos') {
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = '사진 처리 중…';
    try {
      item.beforePhoto = await imageData(data.get('beforePhoto'));
      item.afterPhoto = await imageData(data.get('afterPhoto'));
      advance(item, '작업 전·후 사진 업로드 완료', 'final-verification', '고객과 정상 작동 여부를 확인하고 최종 서명을 받아 주세요.', '작동 확인 대기');
    } catch (error) { formError(form, error.message, 'beforePhoto'); button.disabled = false; button.textContent = '비포·애프터 사진 보내기'; }
    return;
  }
  if (form.id === 'verification-form' && item.stage === 'final-verification') {
    const name = String(data.get('typedName')||'').trim();
    if (!signatureHasInk && !name) return formError(form, '서명 영역에 서명하거나 고객 성명을 입력해 주세요.', 'typedName');
    item.finalSignature = { image:signatureHasInk ? $('.signature-pad').toDataURL('image/png') : null, typedName:name, signedAt:new Date().toISOString() };
    item.verifiedOperation = true; item.completedAt = new Date().toISOString();
    advance(item, '고객이 정상 작동을 확인하고 최종 서명함', 'complete', '현장 완료 보고가 저장되었습니다.', '작업 완료');
  }
});

render(state.role === 'engineer' ? 'top' : 'bottom');
