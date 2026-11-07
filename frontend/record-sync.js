// Per-record optimistic writes. Role, selected customer, drafts and view state stay device-local.
const SETTING_KEYS=['staff','catalog','catalogSource','routePlans','originAddress'];
const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>!['_serverRevision','_pendingServer'].includes(k)).map(k=>[k,clean(value[k])])):value;
const fingerprint=value=>JSON.stringify(clean(value));
const clone=value=>JSON.parse(JSON.stringify(value));

export function createRecordSync({state,onStatus=()=>{},onRemote=()=>{},isEditing=()=>false,saveCache=()=>{}}){
  const bases=new Map(),settingBases=new Map();
  let ready=false,busy=false,conflicts=false,revision=-1,timer=null,debounce=null,stopped=false;
  const status=(text,kind='saved')=>onStatus({text,kind,ready});
  const cache=()=>{try{saveCache();}catch{/* Server persistence does not depend on browser quota. */}};
  async function api(path,body){
    const response=await fetch('./api/records'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(20000)});
    const value=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(typeof value.detail==='string'?value.detail:value.detail?.message||'서버 저장 연결을 확인해 주세요.');error.status=response.status;throw error;}
    return value;
  }
  function changes(){return state.cases.filter(c=>fingerprint(c)!==bases.get(c.id)?.text).map(c=>({record:clone(c),baseRevision:bases.get(c.id)?.revision||0}));}
  function settingsChanges(){return Object.fromEntries(SETTING_KEYS.filter(k=>fingerprint(state[k])!==settingBases.get(k)?.text).map(k=>[k,{value:clone(state[k]),baseRevision:settingBases.get(k)?.revision||0}]));}
  function markPending(){
    const ids=new Set(changes().map(c=>c.record.id));
    for(const c of state.cases)c._pendingServer=ids.has(c.id);
    state._pendingSettings=Object.keys(settingsChanges());
  }
  function applySnapshot(snapshot,{initial=false,force=false}={}){
    if(snapshot.unchanged)return false;
    let changed=false,deferred=false;
    const ids=new Set(snapshot.cases.map(c=>c.id));
    for(const remote of snapshot.cases){
      let local=state.cases.find(c=>c.id===remote.id);
      const base=bases.get(remote.id);
      const same=fingerprint(local)===fingerprint(remote);
      const dirty=initial?local?._pendingServer:local&&base&&fingerprint(local)!==base.text;
      if(!force&&!same&&((dirty&&remote._serverRevision!==(initial?local._serverRevision||0:base?.revision||0))||(!initial&&isEditing(remote.id)&&remote._serverRevision!==base?.revision))){deferred=true;continue;}
      if(!force&&dirty&&!same){bases.set(remote.id,{text:fingerprint(remote),revision:remote._serverRevision});continue;}
      if(!same){if(local)Object.assign(local,remote);else{local=clone(remote);state.cases.push(local);}changed=true;}
      local._pendingServer=false;local._serverRevision=remote._serverRevision;
      bases.set(remote.id,{text:fingerprint(remote),revision:remote._serverRevision});
    }
    // Defaults remain local until edited. Deleted server records cannot be resurrected by a stale cache.
    state.cases=state.cases.filter(c=>{
      if(ids.has(c.id))return true;
      const base=bases.get(c.id);
      if((base?.revision||c._serverRevision)&&!c._pendingServer&&!isEditing(c.id)){bases.delete(c.id);changed=true;return false;}
      if(!base)bases.set(c.id,{text:c._pendingServer?null:fingerprint(c),revision:0});
      return true;
    });
    for(const key of SETTING_KEYS){
      const remote=snapshot.settings[key];
      const base=settingBases.get(key);
      if(!remote){if(!base)settingBases.set(key,{text:null,revision:0});continue;}
      const dirty=initial?(state._pendingSettings||[]).includes(key):base&&fingerprint(state[key])!==base.text;
      if(!force&&dirty&&remote.revision!==(initial?state._sharedSettingsRevisions?.[key]||0:base?.revision||0)){deferred=true;continue;}
      if(force||!dirty){if(fingerprint(state[key])!==fingerprint(remote.value)){state[key]=clone(remote.value);changed=true;}}
      settingBases.set(key,{text:fingerprint(remote.value),revision:remote.revision});
    }
    // Do not advance the cursor past a deferred edited record: retrieve it again after editing.
    if(!deferred)revision=snapshot.revision;
    if(deferred)status('다른 기기에서 변경됨 · 새 기록 확인','conflict');
    state._sharedSettingsRevisions=Object.fromEntries([...settingBases].map(([key,value])=>[key,value.revision]));
    if(!state.cases.some(c=>c.id===state.activeId))state.activeId=null;
    cache();
    return changed;
  }
  async function initialize(){
    // Import only legacy user-created records. Daily synthetic seed cases are generated locally.
    if(state._sharedStorageVersion!==1){
      for(const record of state.cases.filter(c=>!c.id.startsWith('FARMINGBOY-'))){await api('/import',{cases:[record]});}
    }
    const snapshot=await api('');
    applySnapshot(snapshot,{initial:true});
    state._sharedStorageVersion=1;ready=true;cache();
    onRemote();
  }
  async function flush(){
    if(busy||stopped||conflicts)return;
    busy=true;
    try{
      if(!ready)await initialize();
      const outgoing=changes(),settings=settingsChanges();
      if(!outgoing.length&&!Object.keys(settings).length){status('서버 저장 완료 · 기기 간 공유');return;}
      markPending();cache();status('서버에 저장 중…','saving');
      const result=await api('/sync',{changes:outgoing,settings});
      for(const remote of result.cases){
        const local=state.cases.find(c=>c.id===remote.id);
        const sent=outgoing.find(c=>c.record.id===remote.id).record;
        if(local&&fingerprint(local)===fingerprint(sent)){Object.assign(local,remote);local._pendingServer=false;}
        bases.set(remote.id,{text:fingerprint(remote),revision:remote._serverRevision});
        if(local)local._serverRevision=remote._serverRevision;
      }
      for(const [key,remote] of Object.entries(result.settings))settingBases.set(key,{text:fingerprint(remote.value),revision:remote.revision});
      state._sharedSettingsRevisions=Object.fromEntries([...settingBases].map(([key,value])=>[key,value.revision]));
      markPending();cache();status(hasPending()?'추가 변경 저장 중…':'서버 저장 완료 · 기기 간 공유',hasPending()?'saving':'saved');
    }catch(error){
      if(error.status===409){conflicts=true;status('동시 수정 감지 · 서버 기록 확인 필요','conflict');}
      else status('서버 저장 실패 · 재시도 대기','error');
    }finally{busy=false;}
  }
  const hasPending=()=>!ready||changes().length>0||Object.keys(settingsChanges()).length>0;
  async function refresh(){
    if(busy||stopped||conflicts)return;
    if(hasPending()){await flush();return;}
    busy=true;
    try{const snapshot=await api('?since='+revision);if(applySnapshot(snapshot))onRemote();if(snapshot.unchanged)status('서버 저장 완료 · 기기 간 공유');}
    catch{status('서버 연결 대기 · 자동 재연결','error');}
    finally{busy=false;}
  }
  return {
    get ready(){return ready;},get hasPending(){return hasPending();},
    async start(){await flush();if(!timer&&!stopped)timer=setInterval(refresh,3000);},
    schedule(){
      if(ready){markPending();cache();}
      if(!conflicts)status('서버에 저장 중…','saving');
      clearTimeout(debounce);debounce=setTimeout(flush,150);
    },
    refresh,
    async useServer(){
      if(busy)return;
      if(!ready){await flush();return;}
      busy=true;
      try{
        // Preserve conflicting committed form values on the server before accepting the winner.
        for(const change of changes())await api('/import',{cases:[change.record]});
        applySnapshot(await api(''),{force:true});conflicts=false;markPending();cache();onRemote(true);status('서버 기록을 불러왔습니다');
      }catch{status('서버 기록을 불러오지 못했습니다 · 다시 시도','error');}
      finally{busy=false;}
    },
    stop(){stopped=true;clearInterval(timer);clearTimeout(debounce);}
  };
}
