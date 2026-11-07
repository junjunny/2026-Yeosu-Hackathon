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
const submitButton = form.querySelector('button[type="submit"]');
const demoChoice = document.querySelector('.demo-choice');

question.addEventListener('focus', () => demoChoice.classList.add('is-open'));
question.addEventListener('keydown', event => { if (event.key === 'Escape') demoChoice.classList.remove('is-open'); });
document.addEventListener('pointerdown', event => { if (!event.target.closest('#question, .demo-choice')) demoChoice.classList.remove('is-open'); });

document.querySelector('#help-demo-question').addEventListener('click', () => {
  question.value = '딱딱 소리날 때 뭘 봐야 하더라. 좀 알려줘';
  question.dispatchEvent(new Event('input', { bubbles: true }));
  question.focus();
  demoChoice.classList.remove('is-open');
});

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
  if (!raw || submitButton.disabled) return;
  question.value = '';
  bubble('user', raw);
  const answer = bubble('assistant', '답변 생성 중…');
  submitButton.disabled = true;
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
    submitButton.disabled = false;
    question.focus();
  }
});
