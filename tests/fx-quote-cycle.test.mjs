import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import ts from 'typescript';
import {Account,Horizon,rpc,nativeToScVal,scValToNative} from '@stellar/stellar-sdk';
import * as config from '../lib/config.ts';
import {readPayment} from '../lib/send-transaction.ts';
// Same lightweight component hook renderer as fx-send; application/quote/payment functions stay real.
let cursor=0;
const slots=[],effects=[],cleanups=[],timers=[];
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
globalThis.__cycleHooks={
 useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},
 useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
 useCallback(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={fn,deps};return slots[i].fn;},
 useMemo(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={value:fn(),deps};return slots[i].value;},
 useEffect(fn,deps){const i=cursor++;if(!same(slots[i],deps)){slots[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}
};
const page=new URL('../app/page.tsx',import.meta.url);
const data=s=>'data:text/javascript,'+encodeURIComponent(s);
registerHooks({resolve(s,c,next){
 if((s==='./wallet'||s==='@/lib/wallet')&&(c.parentURL===page.href||c.parentURL?.includes('/lib/')))return {url:data(`export async function connectWallet(){return ${JSON.stringify(config.VIEW_ACCOUNT)}};export async function signTransactionXdr(x){return x};export async function assertConnectedWallet(){};`),shortCircuit:true};
 if(c.parentURL===page.href){
  if(s==='react')return {url:data('export const {useState,useRef,useCallback,useMemo,useEffect}=globalThis.__cycleHooks;'),shortCircuit:true};
  if(s.startsWith('@/components/'))return {url:data("export const CurrencySelector='CurrencySelector',LiquidityPanel='LiquidityPanel',AnchorOnrampCard='AnchorOnrampCard',Card='Card',CardContent='CardContent',CardDescription='CardDescription',CardHeader='CardHeader',CardTitle='CardTitle',Badge='Badge',Button='Button',Input='Input';"),shortCircuit:true};
  if(s.startsWith('@/lib/'))return next(new URL('../'+s.slice(2)+'.ts',import.meta.url).href,c);
 }
 if(c.parentURL?.includes('/lib/')&&s.startsWith('./')&&!/\.(ts|json)$/.test(s))return next(s+'.ts',c);
 return next(s,c);
},load(url,c,next){if(url===page.href)return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(page,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};return next(url,c);}});
const {default:Home}=await import(page.href);
const {getQuote}=await import('../lib/stellar.ts');
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)];
const render=()=>{cursor=0;return Home();};
const text=()=>JSON.stringify(render(),(_,v)=>typeof v==='bigint'?v.toString():v);
const button=name=>nodes(render()).find(n=>n.type==='Button'&&(n.props.children===name||Array.isArray(n.props.children)&&n.props.children.includes(name)));
const selector=label=>nodes(render()).find(n=>n.type==='CurrencySelector'&&n.props.label===label);
// Recipient starts empty; these payment cycles send to the connected wallet via "Use my wallet".
async function connect(){await nodes(render()).find(n=>n.type==='Button'&&n.props.children?.includes('Connect wallet')).props.onClick();await flush();button('Use my wallet').props.onClick();await flush();}
async function flush(){for(let i=0;i<12;i++){render();for(const effect of effects.splice(0))effect();for(const timer of timers.splice(0))if(!timer.cancelled)timer.fn();await new Promise(setImmediate);}}
const now=1800000000;
let snapshot,history={},sendStatus='PENDING',sequence=100,mode='',failureMethod='quote_route',submissions=0,failRefresh=false,failAfterSuccess=false,transactionStatus='SUCCESS',nextQuote=null,priceAge=0,worse=0n;
const intervals=[];
const calls=[],settled=new Map();
function route(source,target,amount){
 const path=source===config.ASSETS.USD.contract||target===config.ASSETS.USD.contract?[source,target]:[source,config.ASSETS.USD.contract,target];
 let input=amount;
 const hops=path.slice(1).map(()=>{const h={provider:config.PROVIDERS[0].address,amount_in:input,gross_amount_out:input/2n,amount_out:input/2n-2n-worse,fee_amount:2n,fee_bps:20,source_price:1n,target_price:2n,source_oracle_timestamp:BigInt(now-priceAge),target_oracle_timestamp:BigInt(now-priceAge)};input=h.amount_out;return h;});
 return {path,hops,amount_in:amount,amount_out:input};
}
const success=value=>({_parsed:true,id:'offline',latestLedger:1,transactionData:{},minResourceFee:'1',result:{auth:[],retval:nativeToScVal(value)}});
rpc.Server.prototype.getAccount=async address=>{if(mode==='connection'&&failureMethod==='getAccount')throw Object.assign(new Error('network detail '.repeat(30)),{code:'ERR_NETWORK'});return new Account(address,String(sequence));};
rpc.Server.prototype.simulateTransaction=async tx=>{
 const fn=tx.operations[0].func.invokeContract,method=fn.functionName.toString(),args=fn.args.map(scValToNative);calls.push({method,args});
 if(method==='quote_route'&&nextQuote){const deferred=nextQuote;nextQuote=null;return new Promise((resolve,reject)=>Object.assign(deferred,{resolve,reject}));}
 if(method===failureMethod&&mode){
  if(mode==='connection')throw Object.assign(new Error('network detail '.repeat(30)),{code:'ERR_NETWORK'});
  return {error:`Error(Contract, #${mode==='missing'?9:mode==='stale'?10:8})\n${'diagnostic event '.repeat(30)}`};
 }
 if(method==='snapshot'&&snapshot!==undefined)return success(snapshot);
 if(method==='quote_route')return success(route(...args));
 if(method==='get_max_price_age')return success(900);
 if(method==='get_asset'){const a=Object.values(config.ASSETS).find(a=>a.contract===args[0]);return success({enabled:true,is_oracle_base:a.currency==='USD',oracle:a.oracle,oracle_base:'USD',token_decimals:7,oracle_asset:['Other',a.oracleSymbol]});}
 if(['balance','get_balance'].includes(method))return success(10000000000n);
 if(method==='get_fees')return success(0n);
 throw Error('Unexpected RPC method '+method);
};
Horizon.Server.prototype.loadAccount=async()=>{if(failRefresh)throw Error('balance refresh offline');return {balances:Object.values(config.ASSETS).map(a=>({asset_code:a.code,asset_issuer:a.issuer,balance:'1000',limit:'1000000',buying_liabilities:'0',selling_liabilities:'0',is_authorized:true}))};};
rpc.Server.prototype.prepareTransaction=async tx=>tx;
rpc.Server.prototype.getLatestLedger=async()=>({sequence:500});
rpc.Server.prototype.sendTransaction=async tx=>{
 const hash=Buffer.from(tx.hash()).toString('hex');assert.equal(readPayment().hash,hash);assert.equal(readPayment().status,'pending');
 const args=tx.operations[0].func.invokeContract.args.map(scValToNative);assert.equal(args[1],config.VIEW_ACCOUNT,'signed recipient is the reviewed recipient');settled.set(hash,route(args[2],args[3],args[4]));submissions++;sequence++;
 if(sendStatus!=='PENDING'){submissions--;sequence--;settled.delete(hash);}
 return {status:sendStatus,hash};
};
rpc.Server.prototype.getTransaction=async hash=>{if(transactionStatus==='SUCCESS'&&failAfterSuccess)failRefresh=true;return {...history,status:transactionStatus,returnValue:nativeToScVal(settled.get(hash)),resultXdr:{feeCharged:100n}};};
const storage=new Map();
function setup(){
 slots.length=0;effects.length=0;timers.length=0;cleanups.length=0;calls.length=0;storage.clear();snapshot=undefined;history={};sendStatus='PENDING';mode='';failureMethod='quote_route';failRefresh=false;failAfterSuccess=false;transactionStatus='SUCCESS';nextQuote=null;priceAge=0;worse=0n;intervals.length=0;
 globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 globalThis.window={setTimeout:fn=>{const t={fn};timers.push(t);return t;},clearTimeout:t=>{t.cancelled=true;},setInterval:fn=>intervals.push(fn),clearInterval:()=>{}};
}
const originalNow=Date.now,originalTimeout=globalThis.setTimeout;
test.before(()=>{Date.now=()=>now*1000;globalThis.setTimeout=fn=>{queueMicrotask(fn);return 0;};});
test.after(()=>{Date.now=originalNow;globalThis.setTimeout=originalTimeout;delete globalThis.window;delete globalThis.localStorage;});
test('three real application payment cycles release New payment and actually request fresh pair quotes',async()=>{
 setup();render();await flush();await connect();
 for(const [source,target,amount] of [['USD','EUR','1'],['TRY','GBP','20.0'],['EUR','GBP','0,1']]){
  const before=calls.filter(c=>c.method==='quote_route').length;
  if(selector('You send currency').props.value!==source)selector('You send currency').props.onChange(source);
  if(selector('Recipient receives currency').props.value!==target)selector('Recipient receives currency').props.onChange(target);
  nodes(render()).find(n=>n.props?.id==='send-amount').props.onChange({target:{value:amount}});await flush();
  // First pair is unchanged; use the displayed refresh control in that case.
  if(calls.filter(c=>c.method==='quote_route').length===before){await nodes(render()).find(n=>n.props?.['aria-label']==='Refresh quote').props.onClick();await flush();}
  assert.ok(calls.filter(c=>c.method==='quote_route').length>before);assert.equal(button('Swap & send').props.disabled,false);
  failAfterSuccess=source==='EUR';
  await button('Swap & send').props.onClick();await flush();assert.equal(readPayment().status,'success');assert.ok(text().includes('Veldora settlement complete'));
  if(failAfterSuccess)assert.ok(text().includes('Payment confirmed. Some balance/liquidity displays could not refresh'));
  failRefresh=false;failAfterSuccess=false;
  const quoteCount=calls.filter(c=>c.method==='quote_route').length;
  button('New payment').props.onClick();await flush();assert.equal(readPayment(),null);assert.ok(calls.filter(c=>c.method==='quote_route').length>quoteCount);assert.ok(text().includes('Route details'));
 }
 assert.equal(submissions,3);
});
test('missing oracle and transport quote errors are not mislabeled as failed transactions',async()=>{
 setup();mode='missing';render();await flush();
 assert.ok(!text().includes('The Stellar transaction could not be completed'),'quote failure must not use transaction fallback');
 assert.ok(text().includes('Price feed is currently unavailable for this currency.'));
 mode='connection';failureMethod='get_asset';await nodes(render()).find(n=>n.props?.['aria-label']==='Refresh quote').props.onClick();await flush();
 assert.ok(text().includes('Could not reach Stellar Testnet. Retry the quote.'));
});
test('quote diagnostics are sanitized and development-only; feed recovery clears the same pair error',async()=>{
 const originalEnv=process.env.NODE_ENV,originalWarn=console.warn;
 try {
  for(const env of ['production','development']){
   process.env.NODE_ENV=env;const warnings=[];console.warn=(...args)=>warnings.push(args);
   setup();mode='missing';render();await flush();
   assert.equal(warnings.length,env==='development'?1:0);
   if(env==='development')assert.deepEqual(warnings[0],['Veldora quote unavailable',{
    method:'quote_route',contractCode:9,source:'USD',target:'EUR',amountIn:'10000000',
   }]);
   mode='';await nodes(render()).find(n=>n.props?.['aria-label']==='Refresh quote').props.onClick();await flush();
   assert.ok(text().includes('Route details'));assert.ok(!text().includes('Price feed is currently unavailable'));
   assert.equal(readPayment(),null);
  }
 } finally {console.warn=originalWarn;if(originalEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=originalEnv;}
});
test('RPC quote errors retain method, original contract code and pair/amount for diagnosis',async()=>{
 setup();mode='missing';
 await assert.rejects(getQuote(config.VIEW_ACCOUNT,'TRY','GBP',200000000n),error=>{
  assert.equal(error.method,'quote_route');assert.equal(error.contractCode,9);assert.equal(error.source,'TRY');assert.equal(error.target,'GBP');assert.equal(error.amountIn,'200000000');return true;
 });
});

test('FAILED permits New payment; PENDING blocks resubmission and recovers only the saved hash',async()=>{
 setup();render();await flush();await connect();
 transactionStatus='FAILED';await button('Swap & send').props.onClick();await flush();assert.equal(readPayment().status,'failed');
 button('New payment').props.onClick();await flush();assert.equal(readPayment(),null);assert.ok(text().includes('Route details'));
 transactionStatus='NOT_FOUND';const send=button('Swap & send');await send.props.onClick();await flush();
 const saved=readPayment(),count=submissions;assert.equal(saved.status,'pending');assert.equal(button('New payment'),undefined);
 await send.props.onClick();assert.equal(submissions,count);assert.equal(readPayment().hash,saved.hash);
 transactionStatus='SUCCESS';await button('Check transaction').props.onClick();await flush();assert.equal(readPayment().status,'success');assert.equal(readPayment().hash,saved.hash);assert.equal(submissions,count);
 button('New payment').props.onClick();await flush();assert.ok(text().includes('Route details'));
});
test('late RPC errors cannot replace a new quote; real expiry disables Send',async()=>{
 setup();render();await flush();await connect();
 const deferred={};nextQuote=deferred;const old=nodes(render()).find(n=>n.props?.['aria-label']==='Refresh quote').props.onClick();await flush();
 nodes(render()).find(n=>n.props?.id==='send-amount').props.onChange({target:{value:'2'}});await flush();assert.equal(button('Swap & send').props.disabled,false);
 deferred.resolve({error:'Error(Contract, #9) '+ 'old event '.repeat(30)});await old;await flush();
 assert.ok(text().includes('Route details'));assert.ok(!text().includes('Price feed is currently unavailable'));
 priceAge=901;await nodes(render()).find(n=>n.props?.['aria-label']==='Refresh quote').props.onClick();await flush();
 assert.ok(text().includes('Quote expired'));assert.equal(button('Swap & send').props.disabled,true);
});
test('controlled small-amount matrix and distinct quote/read failures use real quote decoding',async()=>{
 setup();
 const currencies=Object.keys(config.ASSETS);
 const matrix=currencies.flatMap(s=>currencies.filter(t=>t!==s).map(t=>[s,t,1000000n]));
 assert.equal(matrix.length,12);
 for(const [s,t,amount] of [...matrix,['USD','EUR',10000000n],['TRY','GBP',200000000n],['TRY','GBP',600000000n]]){
  const q=await getQuote(config.VIEW_ACCOUNT,s,t,amount);assert.equal(q.amountIn,amount);assert.ok(q.amountOut>0n);assert.ok(q.validUntil>now);
 }
 for(const [failure,method,code] of [['liquidity','quote_route',8],['stale','quote_route',10],['missing','quote_route',9],['connection','getAccount',undefined],['connection','get_asset',undefined],['connection','get_max_price_age',undefined]]){
  mode=failure;failureMethod=method;
  await assert.rejects(getQuote(config.VIEW_ACCOUNT,'EUR','GBP',failure==='liquidity'?2000000000n:1000000n),error=>{
   assert.equal(error.method,method);assert.equal(error.contractCode,code);assert.ok(error.cause);assert.ok(!error.message.includes('transaction could not'));return true;
  });
 }
});
test('an expired quote refreshes itself once and Send is available again',async()=>{
 setup();render();await flush();await connect();
 assert.equal(button('Swap & send').props.disabled,false);
 const before=calls.filter(c=>c.method==='quote_route').length;
 try {
  Date.now=()=>(now+200)*1000;for(const tick of intervals)tick();await flush();
  assert.equal(calls.filter(c=>c.method==='quote_route').length,before+1,'exactly one automatic refresh');
  assert.ok(!text().includes('Quote expired'));assert.equal(button('Swap & send').props.disabled,false);
 } finally {Date.now=()=>now*1000;}
});
test('Send re-quotes on chain before signing and stops if the rate moved beyond the reviewed minimum',async()=>{
 setup();render();await flush();await connect();
 assert.equal(button('Swap & send').props.disabled,false);
 const before=submissions;worse=100_000n;
 await button('Swap & send').props.onClick();await flush();
 assert.equal(submissions,before,'nothing is signed or submitted');
 assert.ok(text().includes('The rate moved more than 0.5%'));
 assert.ok(text().includes('Route details'),'the refreshed quote is shown for review');
});

// Reopening the page: component state is gone, the saved Send record (localStorage) stays.
async function reopen(){slots.length=0;effects.length=0;timers.length=0;cleanups.length=0;render();await flush();}
const open=now+30,expired=now+61;
test('a refused or lost submission stays pending (no resubmit) until the network proves it expired and never ran',async()=>{
 setup();render();await flush();await connect();
 sendStatus='TRY_AGAIN_LATER';transactionStatus='NOT_FOUND';history={latestLedgerCloseTime:open,oldestLedger:400};
 const before=submissions,send=button('Swap & send');
 await send.props.onClick();await flush();
 const saved=readPayment();
 assert.equal(saved.status,'pending','a submission reply alone is not an outcome');
 assert.equal(saved.maxTime,now+60);assert.equal(saved.afterLedger,500,'expiry metadata is saved before submission');
 assert.equal(button('New payment'),undefined);assert.equal(button('Swap & send'),undefined);
 await send.props.onClick();assert.equal(submissions,before,'a stale handler cannot submit again');
 // Past maxTime but the RPC history starts after the signing ledger: it may have run earlier.
 history={latestLedgerCloseTime:expired,oldestLedger:501+1};
 await button('Check transaction').props.onClick();await flush();
 assert.equal(readPayment().status,'pending');assert.ok(text().includes('cannot yet prove'));assert.equal(button('New payment'),undefined);
 // Past maxTime and the history covers every ledger it could have entered: proven never executed.
 history={latestLedgerCloseTime:expired,oldestLedger:400};
 await button('Check transaction').props.onClick();await flush();
 assert.equal(readPayment().status,'expired');assert.equal(readPayment().hash,saved.hash);
 assert.ok(text().includes('expired without executing'));
 button('New payment').props.onClick();await flush();assert.equal(readPayment(),null);assert.equal(submissions,before);
});
test('a reopened page looks the saved hash up itself and settles a later SUCCESS or FAILED without signing',async()=>{
 setup();render();await flush();await connect();
 for(const final of ['SUCCESS','FAILED']){
  transactionStatus='NOT_FOUND';history={latestLedgerCloseTime:open,oldestLedger:400};
  await button('Swap & send').props.onClick();await flush();
  const saved=readPayment(),count=submissions;assert.equal(saved.status,'pending');
  await reopen();
  assert.equal(readPayment().status,'pending','NOT_FOUND before expiry stays pending');
  assert.ok(text().includes('can still execute until'));assert.equal(button('New payment'),undefined);
  transactionStatus=final;await reopen();
  assert.equal(readPayment().status,final==='SUCCESS'?'success':'failed');assert.equal(readPayment().hash,saved.hash);assert.equal(submissions,count,'nothing re-signed');
  transactionStatus='SUCCESS';history={};
  await connect();button('New payment').props.onClick();await flush();
 }
});
test('an older pending record without expiry data is never closed automatically',async()=>{
 setup();transactionStatus='NOT_FOUND';history={latestLedgerCloseTime:expired+100000,oldestLedger:1};
 storage.set('rise:send:testnet',JSON.stringify({hash:'d'.repeat(64),network:'testnet',wallet:config.VIEW_ACCOUNT,router:config.FX_ROUTER,recipient:config.VIEW_ACCOUNT,source:'USD',target:'EUR',amount:'10000000',minimum:'1',route:true,status:'pending'}));
 await reopen();
 assert.equal(readPayment().status,'pending');assert.ok(text().includes('older record has no expiry data'));assert.equal(button('New payment'),undefined);
});

test('100 TRY -> EUR quote failures say which condition failed: liquidity limit, expired TRY price or unavailable price',async()=>{
 setup();const amount=1_000_000_000n;
 // The router's #8: every LP filtered out (here: the 40 rTRY per-trade limit on TRY -> USD).
 mode='liquidity';failureMethod='quote_route';
 await assert.rejects(getQuote(config.VIEW_ACCOUNT,'TRY','EUR',amount),error=>{
  assert.equal(error.contractCode,8);assert.match(error.message,/^Insufficient liquidity for this amount/);assert.doesNotMatch(error.message,/price/i);return true;});
 // An expired demo snapshot reaches the router as a missing price (#9); snapshot() is then None.
 mode='missing';snapshot=null;
 for(const [s,t] of [['TRY','EUR'],['EUR','TRY']])
  await assert.rejects(getQuote(config.VIEW_ACCOUNT,s,t,amount),error=>{assert.equal(error.contractCode,9);assert.match(error.message,/TRY demo price has expired/);return true;});
 // A live snapshot means the #9 came from another feed: keep the generic price message.
 snapshot={price:2049807115200n,timestamp:BigInt(now-60),expires:BigInt(now+3600)};
 await assert.rejects(getQuote(config.VIEW_ACCOUNT,'TRY','EUR',amount),error=>{assert.equal(error.message,'Price feed is currently unavailable for this currency.');return true;});
 // Non-TRY pairs never read the TRY oracle.
 snapshot=null;
 await assert.rejects(getQuote(config.VIEW_ACCOUNT,'EUR','GBP',amount),error=>{assert.equal(error.message,'Price feed is currently unavailable for this currency.');return true;});
});
