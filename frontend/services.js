import { followUpQuestions, customerChecklist } from './workflow.js';
const STORAGE_KEY = 'yeosu-fieldnote-chat-v2';

export const referenceCases = [
  {
    id: 'REF-101', title: '시동 불량 · 전원 계통 점검',
    keywords: ['시동', '전원', '배터리', '방전'], source: '합성 사례 REF-101',
    diagnosis: '시동 회로 전압 저하 또는 단자 접촉 불량 가능성. 현장 전압 측정과 연결 상태 확인이 필요합니다.',
    counselorReply: '유사 사례에서는 전원 연결 상태와 계기판 오류 표시를 먼저 확인했습니다. 고객에게 안전한 장소에 정차하도록 안내하고, 증상이 시작된 시점과 경고 표시를 확인해 주세요.',
    steps: ['차량 정차·전원 차단 확인', '계기판 경고 표시 기록', '전원 계통 연결 상태 확인', '조치 후 시동 재시험']
  },
  {
    id: 'REF-102', title: '주행 중 소음 · 하부 체결 점검',
    keywords: ['소음', '덜컹', '진동', '하부'], source: '합성 사례 REF-102',
    diagnosis: '주행 조건에 따른 하부 체결부 이완 또는 간섭 가능성. 재현 조건과 고정부 상태를 확인해야 합니다.',
    counselorReply: '유사 사례에서는 소음이 나는 속도와 도로 상태를 기록한 뒤 하부 고정부를 점검했습니다. 현재 주행이 안전한지, 소음이 계속되는지 고객에게 확인해 주세요.',
    steps: ['소음 발생 속도와 조건 기록', '하부 고정부 이탈·손상 확인', '점검 전후 상태 사진 기록', '안전한 조건에서 재시험']
  },
  {
    id: 'REF-103', title: '충전 불량 · 커넥터 점검',
    keywords: ['충전', '커넥터', '케이블', '충전기'], source: '합성 사례 REF-103',
    diagnosis: '충전 인터페이스 또는 외부 충전기 오류 가능성. 오류 코드와 커넥터 외관 확인이 우선입니다.',
    counselorReply: '유사 사례에서는 충전을 중단하고 오류 메시지와 커넥터 외관을 확인했습니다. 고객에게 접점이나 고전압 부품을 직접 만지지 않도록 안내해 주세요.',
    steps: ['충전 중단과 안전 확보', '차량·충전기 오류 코드 기록', '커넥터 외관 손상 확인', '정상 조건에서 충전 재시험']
  }
];

export function loadState() {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return state && Array.isArray(state.cases) ? state : { cases: [], activeId: null, role: 'counselor', closeFormOpen: false };
  } catch {
    return { cases: [], activeId: null, role: 'counselor', closeFormOpen: false };
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function findSimilar(text) {
  const query = String(text).toLowerCase();
  return referenceCases.map(item => ({ ...item, score: item.keywords.filter(word => query.includes(word)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);
}

export function decideDispatch(flags, searchStatus, count, manualChoice = null) {
  if (flags.visitRequested) return { required: true, rule: '고객 방문 요청', reason: '고객이 출동을 요청했습니다.' };
  if (flags.cannotDrive) return { required: true, rule: '주행 불가', reason: '주행할 수 없어 현장 확인이 필요합니다.' };
  if (searchStatus !== 'ok') return { required: manualChoice, rule: '분석 확인 필요', reason: '검색이 완료되지 않아 상담사가 출동 여부를 결정했습니다.' };
  if (count === 0) return { required: true, rule: '유사 사례 없음', reason: '유사 사례가 없어 현장 데이터를 확보합니다.' };
  if (flags.selfCareWanted) return { required: false, rule: '고객 자가조치 희망', reason: '유사 사례를 바탕으로 원격 안내합니다.' };
  return { required: manualChoice, rule: '상담사 판단', reason: '유사 사례 검토 후 상담사가 출동 여부를 확정했습니다.' };
}

export function createCase(customerId, equipmentId) {
  return {
    id: `DEMO-${Date.now().toString(36).toUpperCase()}`,
    createdAt: new Date().toISOString(), customerId, equipmentId,
    stage: 'counseling', status: '상담 중',
    transcript: [], flags: null, analysis: null, dispatch: null,
    fieldLog: [], checklistDone: [], repairPlan: null,
    approvalSignature: null, repairNotes: '', beforePhoto: null, afterPhoto: null,
    finalSignature: null, verifiedOperation: false, completedAt: null
  };
}

function deltaText(payload) {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return payload.map(deltaText).join('');
  if (!payload || typeof payload !== 'object') return '';
  const kind = String(payload.type || '').toLowerCase();
  if (['thinking', 'reasoning', 'tool', 'tool_call'].some(name => kind.includes(name))) return '';
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.content === 'string') return payload.content;
  if (Array.isArray(payload.content)) return deltaText(payload.content);
  if (payload.delta) return deltaText(payload.delta);
  return '';
}

export async function replyToCounselor(item, rawText, onDelta = null) {
  const history = item.transcript.slice(-20).map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.text || '')
  }));
  const response = await fetch('./api/agentstream/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId: item.id, message: rawText, history }),
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || 'AgentStream 상담 연결 실패');
  }
  if (!response.body) throw new Error('AgentStream 스트림이 비어 있습니다.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const seen = new Set();
  let buffer = '';
  let answer = '';
  let completed = false;

  const consume = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error('AgentStream 응답 형식이 올바르지 않습니다.'); }
    if (!event || typeof event !== 'object') return;
    if (event.event_id && seen.has(event.event_id)) return;
    if (event.event_id) seen.add(event.event_id);
    const type = String(event.type || event.event || '').toLowerCase();
    const payload = event.data && typeof event.data === 'object' ? event.data : event;
    if (type === 'assistant.delta' || type.endsWith('.assistant.delta')) {
      const text = deltaText(payload.content ?? payload.delta ?? payload);
      if (text) { answer += text; onDelta?.(answer); }
      return;
    }
    if (type === 'turn.completed' || type.endsWith('.turn.completed')) { completed = true; return; }
    if (type === 'turn.failed' || type === 'tool.failed' || type.endsWith('.turn.failed') || type.endsWith('.tool.failed')) {
      throw new Error(payload.message || payload.error || 'AgentStream 답변 생성에 실패했습니다.');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!completed) throw new Error('AgentStream 답변이 정상적으로 완료되지 않았습니다.');
  if (!answer.trim()) throw new Error('AgentStream 답변 없음');
  return answer.trim();
}

export async function buildAnalysis(item, previousCases, flags, manualChoice) {
  const raw = item.transcript.filter(message => message.role === 'counselor').map(message => message.text).join('\n');
  const similar = findSimilar(raw);
  const best = similar[0];
  const history = previousCases.filter(entry => entry.id !== item.id && entry.customerId === item.customerId)
    .map(entry => ({ id: entry.id, status: entry.status, createdAt: entry.createdAt }));
  return {
    mode: 'mock', searchStatus: 'ok', history,
    similar: similar.map(({ id, title, source, score }) => ({ id, title, source, score })),
    diagnosis: best?.diagnosis || '확인 필요: 유사 사례가 없어 현장 증상 재현과 계측을 통한 원인 진단이 필요합니다.',
    checklist: customerChecklist(item, { checklist: best?.steps || ['고객 진술과 증상 재현 조건 확인', '안전 확보 후 오류 표시·부품 상태 기록', '측정값과 조치 결과 기록', '상급 엔지니어 검토 요청'] }),
    missingInfo: best ? [] : ['검증된 유사 사례', '확정된 원인 및 수리 방법'],
    dispatch: decideDispatch(flags, 'ok', similar.length, manualChoice)
  };
}

export function unavailableAnalysis(flags, manualChoice) {
  return {
    mode: 'unavailable', searchStatus: 'error', history: [], similar: [],
    diagnosis: '확인 필요: 분석 서비스에 연결되지 않아 현장 진단이 필요합니다.',
    checklist: ['고객과 브레이크 작동·제동 상태 확인 및 결과 기록', '고객과 타이어 마모·손상·공기압 상태 확인 및 결과 기록', '고객 진술과 현장 증상 확인', '안전 확보 후 오류 표시 기록', '상급 엔지니어 검토 요청'],
    missingInfo: ['고객 접수 이력', '유사 사례와 출처', '확정된 원인'],
    dispatch: decideDispatch(flags, 'error', 0, manualChoice)
  };
}

