import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordSync} from '../record-sync.js';
const copy=v=>JSON.parse(JSON.stringify(v));
const clean=v=>JSON.stringify(v,(k,x)=>['_serverRevision','_pendingServer'].includes(k)?undefined:x);
function server(){
 const records=new Map(),settings={};let revision=0,offline=false,loseNext=false;const archive=[];
 globalThis.fetch=async(url,options={})=>{
  if(offline)throw Error('offline');const body=options.body?JSON.parse(options.body):null;
  const response=(status,data)=>({ok:status===200,status,async json(){return copy(data)}});
  if(String(url).includes('/import')){for(const c of body.cases){if(!records.has(c.id))records.set(c.id,{...c,_serverRevision:1});else if(clean(records.get(c.id))!==clean(c))archive.push(copy(c));}revision++;return response(200,{imported:0,archived:0});}
  if(body){
   for(const {record,baseRevision} of body.changes||[]){const old=records.get(record.id);if((old?._serverRevision||0)!==baseRevision&&clean(old)!==clean(record))return response(409,{detail:{message:'conflict'}});}
   const saved=[];for(const {record} of body.changes||[]){const old=records.get(record.id);const next={...record,_serverRevision:clean(old)===clean(record)?old._serverRevision:(old?._serverRevision||0)+1};records.set(record.id,next);saved.push(next);}
   for(const[k,c]of Object.entries(body.settings||{}))settings[k]={value:c.value,revision:(settings[k]?.revision||0)+1};revision++;
   if(loseNext){loseNext=false;throw Error('response lost');}
   return response(200,{cases:saved,settings:Object.fromEntries(Object.keys(body.settings||{}).map(k=>[k,settings[k]]))});
  }
  const since=Number(String(url).split('since=')[1]);return response(200,since===revision?{revision,unchanged:true}:{revision,cases:[...records.values()],settings});
 };
 return{records,archive,set offline(v){offline=v},set loseNext(v){loseNext=v}};
}
function client(saved={}){const state={cases:[],staff:{counselors:['A'],engineers:['A']},catalog:[],catalogSource:'test',routePlans:{},originAddress:'',...copy(saved)};let status,editing=false;const sync=createRecordSync({state,onStatus:s=>status=s,isEditing:()=>editing});return{state,sync,get status(){return status},set editing(v){editing=v}};}
const record=(id='REAL-1')=>({id,customerName:'합성 고객',stage:'counseling'});

test('independent devices, stale writer rejection, archive and explicit reload',async()=>{
 const db=server(),a=client(),b=client();
 try{
  await a.sync.start();await b.sync.start();a.state.cases.push(record());await a.sync.refresh();await b.sync.refresh();assert.equal(b.state.cases[0].id,'REAL-1');
  a.state.cases[0].stage='checklist';b.state.cases[0].stage='complete';await a.sync.refresh();await b.sync.refresh();assert.equal(b.status.kind,'conflict');assert.equal(db.records.get('REAL-1').stage,'checklist');assert.equal(b.state.cases[0].stage,'complete');
  await b.sync.useServer();assert.equal(b.state.cases[0].stage,'checklist');assert.equal(db.archive.at(-1).stage,'complete');
 }finally{a.sync.stop();b.sync.stop();}
});
test('lost response retry and offline pending cache restore without clobbering remote state',async()=>{
 const db=server(),a=client();let restored;
 try{
  await a.sync.start();a.state.cases.push(record());db.loseNext=true;await a.sync.refresh();assert.equal(a.status.kind,'error');assert.ok(a.state.cases[0]._pendingServer);await a.sync.refresh();assert.equal(db.records.get('REAL-1')._serverRevision,1);assert.equal(a.status.kind,'saved');
  db.offline=true;a.state.cases[0].stage='complete';await a.sync.refresh();assert.ok(a.state.cases[0]._pendingServer);a.sync.stop();db.offline=false;restored=client(a.state);await restored.sync.start();assert.equal(db.records.get('REAL-1').stage,'complete');assert.equal(restored.sync.hasPending,false);
 }finally{a.sync.stop();restored?.sync.stop();}
});
test('remote refresh defers an actively edited case and never silently overwrites it',async()=>{
 server();const a=client(),b=client();try{await a.sync.start();a.state.cases.push(record());await a.sync.refresh();await b.sync.start();b.editing=true;a.state.cases[0].stage='complete';await a.sync.refresh();await b.sync.refresh();assert.equal(b.state.cases[0].stage,'counseling');assert.equal(b.status.kind,'conflict');b.editing=false;await b.sync.refresh();assert.equal(b.state.cases[0].stage,'complete');}finally{a.sync.stop();b.sync.stop();}
});
test('legacy import keeps old browser data and daily demo defaults are never auto-uploaded',async()=>{
 const db=server(),a=client({cases:[record(),{...record('FARMINGBOY-CUS-001'),demoDay:'2026-11-08'}]});try{await a.sync.start();assert.ok(db.records.has('REAL-1'));assert.equal(db.records.has('FARMINGBOY-CUS-001'),false);a.state.cases.find(c=>c.id.startsWith('FARMINGBOY')).stage='complete';await a.sync.refresh();assert.ok(db.records.has('FARMINGBOY-CUS-001'));}finally{a.sync.stop();}
});
