import { seoulDay } from './dashboard.js';
export function technicianPerformance(cases, names, days=30, now=new Date()) {
  const today=seoulDay(now);const cutoff=seoulDay(new Date(now.getTime()-(days-1)*86400000));
  const completed=cases.filter(c=>c.stage==='complete' && c.completedAt && Number.isFinite(Date.parse(c.completedAt)) && seoulDay(c.completedAt)>=cutoff && seoulDay(c.completedAt)<=today);
  const people=[...new Set([...names,...completed.map(c=>c.assignedEngineer||'담당자 확인 필요')])];
  return people.map(name=>{
    const records=completed.filter(c=>(c.assignedEngineer||'담당자 확인 필요')===name);
    const durations=records.map(c=>c.arrivedAt ? (Date.parse(c.completedAt)-Date.parse(c.arrivedAt))/60000 : NaN).filter(n=>Number.isFinite(n)&&n>=0);
    let quoted=0,quotedCount=0;
    for(const c of records){const p=c.repairPlan;if(!p || !Array.isArray(p.parts))continue;const amount=p.parts.reduce((sum,part)=>sum+part.qty*part.unitPrice,0)+(p.legacy?p.laborPrice:p.travelFee);if(Number.isFinite(amount)&&amount>=0){quoted+=amount;quotedCount++;}}
    return {name,count:records.length,averageMinutes:durations.length?Math.round(durations.reduce((a,b)=>a+b,0)/durations.length):null,timeCount:durations.length,missingTime:records.length-durations.length,quoted,quotedCount,approvalCount:records.filter(c=>c.approvalSignature).length,signatureCount:records.filter(c=>c.finalSignature).length,photoCount:records.filter(c=>c.beforePhotos?.length&&c.afterPhotos?.length).length,records};
  });
}
