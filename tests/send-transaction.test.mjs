import assert from 'node:assert/strict';
import test from 'node:test';
import {readPayment,writePayment,clearPayment} from '../lib/send-transaction.ts';
const record={hash:'a'.repeat(64),network:'testnet',wallet:'Gwallet',router:'Crouter',recipient:'Grecipient',source:'USD',target:'GBP',amount:'10000000',minimum:'100',route:true,status:'pending'};
test('pending hash survives reload; no secrets or XDR are stored; only final payment can be cleared',()=>{
 const data=new Map();globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 writePayment({...record,signedXdr:'do not persist',secret:'do not persist'});
 assert.deepEqual(readPayment(),record);assert.ok(![...data.values()][0].includes('do not persist'));
 assert.throws(()=>clearPayment(),/pending/i);
 writePayment({...record,status:'success'});clearPayment();assert.equal(readPayment(),null);
 data.set('rise:send:testnet','bad json');assert.throws(()=>readPayment(),/record/i);
 delete globalThis.localStorage;
});
