import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {Account,rpc,nativeToScVal} from '@stellar/stellar-sdk';
import {VIEW_ACCOUNT,DEMO_RECIPIENT,ASSETS} from '../lib/config.ts';
import {readPayment,writePayment,clearPayment} from '../lib/send-transaction.ts';
registerHooks({resolve(s,c,next){
 if(c.parentURL?.endsWith('/lib/stellar.ts')&&s==='./wallet')return {url:'data:text/javascript,export const signTransactionXdr=async x=>x;',shortCircuit:true};
 if(c.parentURL?.includes('/lib/')&&s.startsWith('./')&&!s.endsWith('.ts'))return next(s+'.ts',c);
 return next(s,c);
}});
const {executeSwap,checkSendTransaction}=await import('../lib/stellar.ts');
const data=new Map();globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
rpc.Server.prototype.getAccount=async()=>new Account(VIEW_ACCOUNT,'100');
rpc.Server.prototype.prepareTransaction=async tx=>tx;
rpc.Server.prototype.getLatestLedger=async()=>({sequence:500});
test('submit disconnect retains precomputed hash and blocks second signature; same hash recovers SUCCESS',async()=>{
 let sends=0,saved;const statuses=[];
 rpc.Server.prototype.sendTransaction=async tx=>{
  sends++;saved=readPayment();assert.equal(saved.hash,Buffer.from(tx.hash()).toString('hex'));assert.equal(saved.status,'pending');throw new Error('network disconnected');
 };
 const onPayment=p=>statuses.push(p.status);
 await assert.rejects(executeSwap(VIEW_ACCOUNT,DEMO_RECIPIENT,'USD','EUR',10000000n,100n,onPayment),/disconnected/);
 await assert.rejects(executeSwap(VIEW_ACCOUNT,DEMO_RECIPIENT,'USD','EUR',10000000n,100n,onPayment),/saved transaction/);
 assert.equal(sends,1);assert.deepEqual(statuses,['pending']);
 const hop={provider:VIEW_ACCOUNT,amount_in:10000000n,gross_amount_out:1000n,amount_out:998n,fee_amount:2n,fee_bps:20,source_price:1n,target_price:1n,source_oracle_timestamp:1000,target_oracle_timestamp:1000};
 rpc.Server.prototype.getTransaction=async hash=>{assert.equal(hash,saved.hash);return {status:'SUCCESS',returnValue:nativeToScVal(saved.route?{...hop,path:[ASSETS.USD.contract,ASSETS.EUR.contract],hops:[hop]}:hop),resultXdr:{feeCharged:100n}};};
 const result=await checkSendTransaction(saved,onPayment);
 assert.equal(result.actual.amountOut,998n);assert.equal(readPayment().status,'success');assert.equal(sends,1);
 clearPayment();
});
test('FAILED is final, while NOT_FOUND remains pending',async()=>{
 const p={hash:'b'.repeat(64),network:'testnet',wallet:VIEW_ACCOUNT,router:ASSETS.USD.contract,recipient:DEMO_RECIPIENT,source:'USD',target:'EUR',amount:'100',minimum:'1',route:false,status:'pending'};
 writePayment(p);rpc.Server.prototype.getTransaction=async()=>({status:'NOT_FOUND'});
 await assert.rejects(checkSendTransaction(p,()=>{}),/not confirmed/i);assert.equal(readPayment().status,'pending');
 rpc.Server.prototype.getTransaction=async()=>({status:'FAILED'});
 await assert.rejects(checkSendTransaction(p,()=>{}),/failed/);assert.equal(readPayment().status,'failed');clearPayment();
});
