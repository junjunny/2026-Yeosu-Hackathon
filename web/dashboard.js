export const seoulDay = value => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export function dashboardStats(cases, now=new Date()) {
  const today=seoulDay(now);
  const resolved=c=>['complete','remote-closed'].includes(c.stage);
  const done=cases.filter(c=>resolved(c) && (c.completedAt||c.closedAt) && seoulDay(c.completedAt||c.closedAt)===today);
  const todo=cases.filter(c=>!resolved(c) && seoulDay(c.createdAt)<=today);
  return {done,todo};
}
export function durationMinutes(item) {
  if(!item.arrivedAt || !item.completedAt)return null;
  const elapsed=new Date(item.completedAt)-new Date(item.arrivedAt);
  return Number.isFinite(elapsed)&&elapsed>=0 ? Math.round(elapsed/60000) : null;
}
export function closeReady(form) {
  return form.checkValidity() && ['productName','purchaseDate','repairHistory','dispatchAddress'].every(key=>form.elements[key]?.value.trim());
}
