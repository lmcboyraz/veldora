import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {Account,rpc,scValToNative,nativeToScVal} from '@stellar/stellar-sdk';
import {ASSETS,VIEW_ACCOUNT,FX_ROUTER,FX_ROUTER_WASM_HASH} from '../lib/config.ts';
const calls=[];globalThis.__lpCalls=calls;globalThis.__lpWallet={USD:1000n,EUR:1000n,GBP:1000n,TRY:1000n};globalThis.__lpReturn=nativeToScVal(42n,{type:'i128'});
registerHooks({resolve(s,c,next){
 if(c.parentURL?.endsWith('/lib/liquidity.ts')&&s==='./wallet')return {url:'data:text/javascript,export async function assertConnectedWallet(){};',shortCircuit:true};
 if(c.parentURL?.endsWith('/lib/liquidity.ts')&&s==='./stellar')return {url:'data:text/javascript,'+encodeURIComponent(`export {getProviderStats} from ${JSON.stringify(new URL('../lib/stellar.ts',import.meta.url).href)};export async function submitContractCall(...args){globalThis.__lpCalls.push(args);if(globalThis.__lpSubmit)return globalThis.__lpSubmit(...args);return {hash:'test',result:{returnValue:globalThis.__lpReturn}}};export async function checkTransaction(t){globalThis.__lpChecked?.push(t.hash);return {state:globalThis.__lpOutcome??'pending',result:{ledger:77,latestLedger:999}}};`),shortCircuit:true};
 if(c.parentURL?.endsWith('/lib/liquidity.ts')&&s==='./trustline')return {url:'data:text/javascript,export async function getWalletHoldings(){return globalThis.__lpWallet};',shortCircuit:true};
 if(c.parentURL?.includes('/lib/')&&s.startsWith('./')&&!s.endsWith('.ts'))return next(s+'.ts',c);
 return next(s,c);
}});
const {getLiquidityState,configureProvider,moveLiquidity}=await import('../lib/liquidity.ts');
rpc.Server.prototype.getAccount=async()=>new Account(VIEW_ACCOUNT,'1');
rpc.Server.prototype.getContractInstance=async()=>({executable:{wasmHash:{value:Buffer.from(FX_ROUTER_WASM_HASH,'hex')}}});
let pairArgs;
rpc.Server.prototype.simulateTransaction=async tx=>{
 const fn=tx.operations[0].func.invokeContract;const method=fn.functionName.toString();
 if(method==='get_pair')pairArgs=fn.args.map(scValToNative);
 return {_parsed:true,id:'test',latestLedger:globalThis.__lpLagMethod===method?76:globalThis.__lpReadLedger??1,transactionData:{},minResourceFee:'1',result:{auth:[],retval:['get_balance','get_fees'].includes(method)?nativeToScVal(500n,{type:'i128'}):nativeToScVal(method==='get_providers'?[VIEW_ACCOUNT]:method==='is_paused'?false:null)}};
};
test('four asset LP reads and movements use exact token; pair target stays independent and same asset is blocked',async()=>{
 const state=await getLiquidityState(VIEW_ACCOUNT,'TRY','GBP');
 assert.deepEqual(Object.keys(state.stats),['USD','EUR','GBP','TRY']);assert.deepEqual(pairArgs,[VIEW_ACCOUNT,ASSETS.TRY.contract,ASSETS.GBP.contract]);
 const config={active:true,fee_bps:20,max_amount_in:0n,max_source_inventory:0n};
 await configureProvider(VIEW_ACCOUNT,'GBP','TRY',config);
 assert.deepEqual(calls.at(-1)[3].slice(0,3).map(scValToNative),[VIEW_ACCOUNT,ASSETS.GBP.contract,ASSETS.TRY.contract]);
 await assert.rejects(configureProvider(VIEW_ACCOUNT,'TRY','TRY',config),/different/);
 for(const key of Object.keys(ASSETS))for(const method of ['deposit','withdraw']) {
  const moved=await moveLiquidity(VIEW_ACCOUNT,key,100n,method);assert.equal(calls.at(-1)[2],method);assert.equal(scValToNative(calls.at(-1)[3][1]),ASSETS[key].contract);
  assert.equal(scValToNative(calls.at(-1)[3][0]),VIEW_ACCOUNT);assert.equal(moved.inventory,42n);
 }
 assert.deepEqual(state.wallet,globalThis.__lpWallet);
});
test('deposit/withdraw that the token transfer would reject never reaches the wallet for signing',async()=>{
 const before=calls.length;
 globalThis.__lpWallet={USD:1000n,EUR:1000n,GBP:1000n,TRY:null};
 await assert.rejects(moveLiquidity(VIEW_ACCOUNT,'TRY',50000000n,'deposit'),/no rTRY trustline/);
 await assert.rejects(moveLiquidity(VIEW_ACCOUNT,'TRY',1n,'withdraw'),/no rTRY trustline/);
 globalThis.__lpWallet={USD:1000n,EUR:1000n,GBP:1000n,TRY:40000000n};
 await assert.rejects(moveLiquidity(VIEW_ACCOUNT,'TRY',50000000n,'deposit'),/holds 4 rTRY/);
 await assert.rejects(moveLiquidity(VIEW_ACCOUNT,'TRY',501n,'withdraw'),/inventory is 0.00005 rTRY/);
 assert.equal(calls.length,before);
 globalThis.__lpWallet={USD:1000n,EUR:1000n,GBP:1000n,TRY:1000n};
});

test('an LP hash is saved per network + wallet before submission, blocks another LP transaction and is cleared only by a network result',async()=>{
 const data=new Map();globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const {readLpRecord}=await import('../lib/lp-transaction.ts');const {checkLpRecord}=await import('../lib/liquidity.ts');
 const OTHER='GCNPJ2PETW564HLQ7SHCQ73E2F7EMUKTP52HSS555MSAJ2FVVXFUKSJQ',hash='b'.repeat(64);
 try {
  // The submission reply is lost after the hash was saved.
  globalThis.__lpSubmit=(wallet,router,method,args,onStatus)=>{onStatus(hash,'pending',{maxTime:2000000000,afterLedger:10});
   assert.equal(readLpRecord(wallet).hash,hash,'saved before the network is contacted');throw new Error('Transaction confirmation timed out');};
  await assert.rejects(moveLiquidity(VIEW_ACCOUNT,'EUR',100n,'withdraw'),/timed out/);
  assert.deepEqual(readLpRecord(VIEW_ACCOUNT),{hash,network:'testnet',wallet:VIEW_ACCOUNT,router:FX_ROUTER,kind:'withdraw',asset:'EUR',amount:'100',maxTime:2000000000,afterLedger:10});
  // Another wallet neither sees nor clears it, and is not blocked by it.
  assert.equal(readLpRecord(OTHER),null);assert.equal(await checkLpRecord(OTHER),null);
  globalThis.__lpSubmit=undefined;await moveLiquidity(OTHER,'EUR',100n,'deposit');assert.equal(readLpRecord(VIEW_ACCOUNT).hash,hash);
  // Reload: the saved record alone blocks every LP transaction of this wallet before signing.
  const count=calls.length;
  await assert.rejects(moveLiquidity(VIEW_ACCOUNT,'EUR',100n,'withdraw'),/not confirmed yet/);
  await assert.rejects(configureProvider(VIEW_ACCOUNT,'USD','EUR',{active:true,fee_bps:20,max_amount_in:0n,max_source_inventory:0n}),/not confirmed yet/);
  assert.equal(calls.length,count,'nothing submitted');
  // NOT_FOUND / unresolved keeps it; any network result clears only this wallet's record.
  globalThis.__lpChecked=[];globalThis.__lpOutcome='pending';
  assert.equal((await checkLpRecord(VIEW_ACCOUNT)).state,'pending');assert.equal(readLpRecord(VIEW_ACCOUNT).hash,hash);
  for(const state of ['success','failed','expired']){
   data.set('rise:lp:testnet:'+VIEW_ACCOUNT,JSON.stringify(readLpRecord(VIEW_ACCOUNT)??{hash,network:'testnet',wallet:VIEW_ACCOUNT,router:FX_ROUTER,kind:'withdraw',asset:'EUR',amount:'100',maxTime:2000000000,afterLedger:10}));
   globalThis.__lpOutcome=state;assert.equal((await checkLpRecord(VIEW_ACCOUNT)).state,state);assert.equal(readLpRecord(VIEW_ACCOUNT),null);
  }
  assert.ok(globalThis.__lpChecked.every(h=>h===hash),'only the saved hash is looked up');
  // A settled submission clears its own record through the same callback.
  globalThis.__lpSubmit=(wallet,router,method,args,onStatus)=>{onStatus(hash,'pending',{});onStatus(hash,'success',{});return {hash,result:{returnValue:globalThis.__lpReturn}};};
  await moveLiquidity(VIEW_ACCOUNT,'EUR',100n,'deposit');assert.equal(readLpRecord(VIEW_ACCOUNT),null);
  // A record for another wallet stored under this key is rejected, never shown as this wallet's.
  data.set('rise:lp:testnet:'+VIEW_ACCOUNT,JSON.stringify({hash,network:'testnet',wallet:OTHER,router:FX_ROUTER,kind:'deposit'}));
  assert.throws(()=>readLpRecord(VIEW_ACCOUNT),/unreadable/);const n=calls.length;await assert.rejects(moveLiquidity(VIEW_ACCOUNT,'EUR',100n,'deposit'),/unreadable/);assert.equal(calls.length,n);
 } finally {globalThis.__lpSubmit=undefined;globalThis.__lpOutcome=undefined;delete globalThis.localStorage;}
});


test('LP getter rejects a ledger older than settlement, while unbounded reads keep working',async()=>{
 globalThis.__lpReadLedger=76;
 try {
  await assert.rejects(getLiquidityState(VIEW_ACCOUNT,'USD','EUR',77),/ledger|catch|current/i);
  assert.equal((await getLiquidityState(VIEW_ACCOUNT,'USD','EUR')).registered,true);
  globalThis.__lpReadLedger=77;
  assert.equal((await getLiquidityState(VIEW_ACCOUNT,'USD','EUR',77)).registered,true);
  for(const method of ['get_balance','get_fees','get_pair']){globalThis.__lpLagMethod=method;await assert.rejects(getLiquidityState(VIEW_ACCOUNT,'USD','EUR',77),/ledger/i);}
  delete globalThis.__lpLagMethod;
 } finally {delete globalThis.__lpReadLedger;delete globalThis.__lpLagMethod;}
});

test('shared provider getter optionally enforces simulation latestLedger without changing its result shape',async()=>{
 const {getProviderStats,getProviders}=await import('../lib/stellar.ts');
 globalThis.__lpReadLedger=76;
 try {
  await assert.rejects(getProviders(77),/ledger|catch|current/i);
  assert.deepEqual(await getProviders(),[VIEW_ACCOUNT]);
  await assert.rejects(getProviderStats(VIEW_ACCOUNT,77),/ledger|catch|current/i);
  assert.deepEqual(await getProviderStats(VIEW_ACCOUNT),Object.fromEntries(Object.keys(ASSETS).map(k=>[k,{balance:500n,fees:500n}])));
  globalThis.__lpReadLedger=77;assert.deepEqual(await getProviders(77),[VIEW_ACCOUNT]);assert.equal((await getProviderStats(VIEW_ACCOUNT,77)).EUR.balance,500n);
 } finally {delete globalThis.__lpReadLedger;delete globalThis.__lpLagMethod;}
});

test('recovery returns the transaction execution ledger, not latestLedger',async()=>{
 const {checkLpRecord}=await import('../lib/liquidity.ts');
 let raw=JSON.stringify({hash:'d'.repeat(64),network:'testnet',wallet:VIEW_ACCOUNT,router:FX_ROUTER,kind:'deposit'});
 globalThis.localStorage={getItem:()=>raw,removeItem:()=>{raw=null;}};globalThis.__lpOutcome='success';
 try {assert.equal((await checkLpRecord(VIEW_ACCOUNT)).ledger,77);assert.equal(raw,null);}
 finally {delete globalThis.localStorage;delete globalThis.__lpOutcome;}
});
