import { replyToCounselor } from './services.js?v=2';

const form = document.querySelector('#help-form');
const messages = document.querySelector('#messages');
const status = document.querySelector('#help-status');
const question = document.querySelector('#question');
const engineer = new URLSearchParams(location.search).get('engineer') || '엔지니어';
const embedded = new URLSearchParams(location.search).get('embedded') === '1';
document.body.classList.toggle('embedded', embedded);
document.querySelector('#help-title').textContent = `${engineer} 작업 도움말`;
const conversation = { id: `ENGINEER-HELP-${engineer}-${crypto.randomUUID()}`, transcript: [] };
const engineerEndpoint = new URL('../api/agentstream/engineer-chat', location.href).href;

function bubble(kind, content) {
  const element = document.createElement('div');
  element.className = `message ${kind}`;
  element.textContent = content;
  messages.append(element);
  messages.scrollTop = messages.scrollHeight;
  return element;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const raw = question.value.trim();
  if (!raw || form.querySelector('button').disabled) return;
  question.value = '';
  bubble('user', raw);
  const answer = bubble('assistant', '답변 생성 중…');
  const button = form.querySelector('button');
  button.disabled = true;
  status.textContent = 'AgentStream 답변 생성 중';
  try {
    const result = await replyToCounselor(conversation, raw, partial => { answer.textContent = partial; messages.scrollTop = messages.scrollHeight; }, engineerEndpoint);
    answer.textContent = result;
    conversation.transcript.push({role:'counselor',text:raw},{role:'assistant',text:result});
    status.textContent = '답변 완료';
  } catch (error) {
    if (answer.textContent === '답변 생성 중…') answer.remove();
    bubble('error', `연결 실패: ${error.message}`);
    status.textContent = '답변 실패 · 다시 질문할 수 있습니다';
  } finally {
    button.disabled = false;
    question.focus();
  }
});
