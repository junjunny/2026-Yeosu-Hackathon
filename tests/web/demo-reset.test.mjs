import assert from 'node:assert/strict';
import test from 'node:test';
import {loadState,saveState} from '../../web/services.js';
test('rehearsal cache is ignored, then new presentation records survive reload',()=>{
 const values=new Map([['yeosu-fieldnote-chat-v2',JSON.stringify({cases:[{id:'OLD',customerName:'한준희'}],role:'engineer'})]]);
 const previous=globalThis.localStorage;
 globalThis.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 try{
  assert.deepEqual(loadState().cases,[]);assert.equal(loadState().role,'counselor');assert.equal(values.has('yeosu-fieldnote-chat-v2'),false);
  const next={cases:[{id:'NEW',customerName:'합성 시연'}],role:'counselor'};saveState(next);assert.deepEqual(loadState(),next);
 }finally{globalThis.localStorage=previous;}
});
