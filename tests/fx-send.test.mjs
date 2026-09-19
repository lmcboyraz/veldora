import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import ts from 'typescript';
import * as config from '../lib/config.ts';
import {quoteKey} from '../lib/fx-quote.ts';
let cursor=0;
const slots=[],effects=[],cleanups=[],timers=[],pending=[];
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
const hooks={
 useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},
 useRef(initial){const i=cursor++;return slots[i]??={current:initial};},
 useCallback(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={fn,deps};return slots[i].fn;},
 useMemo(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={value:fn(),deps};return slots[i].value;},
 useEffect(fn,deps){const i=cursor++;if(!same(slots[i],deps)){slots[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}
};
globalThis.__fxHooks=hooks;
const WALLET=config.VIEW_ACCOUNT,OTHER=config.PROVIDERS[1].address;globalThis.__fxWallet=globalThis.__fxActive=WALLET;
globalThis.__fxQuotes=(wallet,source,target,amount)=>new Promise(resolve=>pending.push({wallet,source,target,amount,resolve}));
const sourceUrl=new URL('../app/page.tsx',import.meta.url);
const data=source=>'data:text/javascript,'+encodeURIComponent(source);
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===sourceUrl.href){
  let source;
  if(specifier==='react')source='export const {useState,useRef,useCallback,useMemo,useEffect}=globalThis.__fxHooks;';
  if(specifier.startsWith('@/components/'))source="export const CurrencySelector='CurrencySelector',LiquidityPanel='LiquidityPanel',AnchorOnrampCard='AnchorOnrampCard',Card='Card',CardContent='CardContent',CardDescription='CardDescription',CardHeader='CardHeader',CardTitle='CardTitle',Badge='Badge',Button='Button',Input='Input';";
  if(specifier==='@/lib/stellar')source=`export * from ${JSON.stringify(new URL('../lib/config.ts',import.meta.url).href)};export const getQuote=globalThis.__fxQuotes;export {parseUnits as parseAmount} from ${JSON.stringify(new URL('../lib/fx-quote.ts',import.meta.url).href)};export const formatAmount=v=>v.toString(),shorten=v=>v;export async function getProviderStats(...args){globalThis.__providerReads?.push(args);if(globalThis.__providerRead)return globalThis.__providerRead(...args);return Object.fromEntries(['USD','EUR','GBP','TRY'].map(k=>[k,{balance:0n,fees:0n}]))};export const executeSwap=(...args)=>globalThis.__fxExecute(...args);export async function checkSendTransaction(){};export async function getTokenBalance(){return 0n};`;
  if(specifier==='@/lib/trustline')source="export async function checkTrustline(){return {state:'present'}};export async function ensureTrustline(){};export async function getWalletBalances(account){if(globalThis.__walletRead)return globalThis.__walletRead(account);if(globalThis.__failRefresh)throw Error('refresh unavailable');return {USD:1000000000n,EUR:1000000000n,GBP:1000000000n,TRY:1000000000n}};";
  if(specifier==='@/lib/wallet')source="export async function connectWallet(){return globalThis.__fxWallet};export async function assertConnectedWallet(expected){if(globalThis.__fxActive!==expected)throw Error('changed')};";
  if(source)return {url:data(source),shortCircuit:true};
  if(specifier.startsWith('@/lib/'))return next(new URL('../'+specifier.slice(2)+'.ts',import.meta.url).href,context);
 }
 return next(specifier,context);
},load(url,context,next){if(url===sourceUrl.href)return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(sourceUrl,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};return next(url,context);}});
const {default:Home}=await import(sourceUrl.href);
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)];
const render=()=>{cursor=0;return Home();};
const selector=label=>nodes(render()).find(n=>n.type==='CurrencySelector'&&n.props.label===label);
async function flush(){render();for(const effect of effects.splice(0))effect();for(const timer of timers.splice(0))if(!timer.cancelled)timer.fn();await Promise.resolve();await Promise.resolve();render();}
function reply(request,validUntil=9999999999){const h={provider:config.PROVIDERS[0].address,amountIn:request.amount,amountOut:1n,feeAmount:0n,feeBps:0,sourcePrice:1n,targetPrice:1n,sourceOracleTimestamp:1000,targetOracleTimestamp:1000};request.resolve({...h,path:[config.ASSETS[request.source].contract,config.ASSETS[request.target].contract],hops:[h],demo:false,validUntil,requestKey:quoteKey(config.FX_ROUTER,request.wallet,request.source,request.target,request.amount)});}
test('actual Send handlers keep currencies independent and discard late old quotes',async()=>{
 const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 globalThis.window={setTimeout:fn=>{const t={fn};timers.push(t);return t;},clearTimeout:t=>{t.cancelled=true;},setInterval:()=>0,clearInterval:()=>{}};
 try {
  render();await flush();assert.equal(pending.length,1);const old=pending.shift();
  selector('You send currency').props.onChange('TRY');
  assert.equal(selector('Recipient receives currency').props.value,'EUR');
  await flush();const current=pending.shift();assert.equal(current.source,'TRY');
  reply(old);await Promise.resolve();
  assert.equal(nodes(render()).some(n=>n.type==='details'&&nodes(n).some(x=>x.type==='summary'&&x.props.children==='Route details')),false);
  reply(current);await Promise.resolve();
  assert.equal(nodes(render()).some(n=>n.type==='details'&&nodes(n).some(x=>x.type==='summary'&&x.props.children==='Route details')),true);
  selector('Recipient receives currency').props.onChange('GBP');
  assert.equal(selector('You send currency').props.value,'TRY');
  assert.equal(nodes(render()).some(n=>n.type==='details'&&nodes(n).some(x=>x.type==='summary'&&x.props.children==='Route details')),false);
  const connect=nodes(render()).find(n=>n.type==='Button'&&nodes(n).length&&n.props.children?.includes('Connect wallet'));
  await connect.props.onClick();render();await flush();await flush();
  nodes(render()).find(n=>n.type==='Button'&&n.props.children==='Use my wallet').props.onClick();await flush();
  for(const request of pending.splice(0)) reply(request);await Promise.resolve();await flush();
  const input=nodes(render()).find(n=>n.props?.id==='send-amount');input.props.onChange({target:{value:'6'}});
  render();await flush();for(const request of pending.splice(0))reply(request);await Promise.resolve();
  const send=nodes(render()).find(n=>n.type==='Button'&&n.props.children?.includes('Swap & send'));
  assert.ok(send);assert.equal(send.props.disabled,false,'amount-only edit must retain both valid trustline checks');
  const refresh=()=>nodes(render()).find(n=>n.props?.['aria-label']==='Refresh quote');
  const expires=refresh().props.onClick();reply(pending.shift(),1);await expires;
  assert.ok(JSON.stringify(render(),(_,v)=>typeof v==='bigint'?v.toString():v).includes('Quote expired'));
  assert.equal(nodes(render()).find(n=>n.type==='Button'&&n.props.children?.includes('Swap & send')).props.disabled,true);
  const fresh=refresh().props.onClick();reply(pending.shift());await fresh;
  for(const value of ['6.','6.0','6,0','06']) {
   nodes(render()).find(n=>n.props?.id==='send-amount').props.onChange({target:{value}});
   await flush(); assert.equal(pending.length,0);
   assert.ok(nodes(render()).some(n=>n.type==='summary'&&n.props.children==='Route details'),'equivalent input retains quote');
  }
  const anchor=nodes(render()).find(n=>n.type==='AnchorOnrampCard');
  anchor.props.onVerified({id:'old',destination_address:WALLET,amount_usdc:'6'});await flush();
  nodes(render()).find(n=>n.props?.id==='send-amount').props.onChange({target:{value:''}});
  await flush();assert.ok(JSON.stringify(render(),(_,v)=>typeof v==='bigint'?v.toString():v).includes('Enter an amount'));for(const request of pending.splice(0))reply(request);await Promise.resolve();
  assert.ok(!JSON.stringify(render(),(_,v)=>typeof v==='bigint'?v.toString():v).includes('Anchor delivered'));
  nodes(render()).find(n=>n.props?.id==='send-amount').props.onChange({target:{value:'1'}});
  await flush();for(const request of pending.splice(0))reply(request);await Promise.resolve();await flush();
  let calls=0;
  globalThis.__fxExecute=async(wallet,recipient,source,target,amount,minimum,onPayment)=>{
   calls++;assert.equal(wallet,WALLET);assert.equal(recipient,WALLET,'signed recipient is the reviewed one');onPayment({hash:'a'.repeat(64),network:'testnet',wallet,recipient,router:config.FX_ROUTER,source,target,amount:String(amount),minimum:String(minimum),route:false,status:'success'});
   globalThis.__failRefresh=true;
   const hop={provider:config.PROVIDERS[0].address,amountIn:amount,amountOut:998n,feeAmount:2n,feeBps:20};
   return {hash:'a'.repeat(64),networkFee:100n,actual:{...hop,hops:[hop],path:[config.ASSETS[source].contract,config.ASSETS[target].contract]}};
  };
  const button=nodes(render()).find(n=>n.type==='Button'&&n.props.children?.includes('Swap & send'));
  const first=button.props.onClick();await button.props.onClick();
  // Send re-quotes on chain right before signing.
  for(let i=0;i<50&&!pending.length;i++)await new Promise(setImmediate);
  assert.equal(pending.length,1,'one fresh quote before signing');reply(pending.shift());await first;
  assert.equal(calls,1,'ref lock blocks simultaneous sends');
  const output=JSON.stringify(render(),(_,v)=>typeof v==='bigint'?v.toString():v);
  assert.ok(output.includes('Veldora settlement complete'));assert.ok(output.includes('could not refresh'));
  assert.ok(nodes(render()).some(n=>n.type==='Button'&&n.props.children==='New payment'));
  await button.props.onClick();assert.equal(calls,1,'confirmed receipt blocks stale Send handler');
 } finally {delete globalThis.window;}
});

test('reload restores pending summary and Check transaction without signing again',async()=>{
 slots.length=0;effects.length=0;timers.length=0;pending.length=0;cleanups.length=0;globalThis.__failRefresh=false;
 const saved={hash:'c'.repeat(64),network:'testnet',wallet:'wallet',recipient:config.DEMO_RECIPIENT,router:config.FX_ROUTER,source:'USD',target:'GBP',amount:'10000000',minimum:'10',route:true,status:'pending'};
 globalThis.localStorage={getItem:()=>JSON.stringify(saved)};
 globalThis.window={setTimeout:fn=>{const t={fn};timers.push(t);return t;},clearTimeout:t=>{t.cancelled=true;},setInterval:()=>0,clearInterval:()=>{}};
 globalThis.__fxExecute=()=>{throw Error('must not sign during recovery')};
 try {render();await flush();assert.ok(nodes(render()).some(n=>n.type==='Button'&&n.props.children==='Check transaction'));assert.ok(!nodes(render()).some(n=>n.type==='Button'&&n.props.children==='New payment'));assert.equal(nodes(render()).find(n=>n.props?.id==='send-amount').props.disabled,true);}
 finally {delete globalThis.window;delete globalThis.localStorage;}
});

test('recipient starts empty, is never auto-filled, and a wallet-filled recipient is cleared on account change',async()=>{
 slots.length=0;effects.length=0;timers.length=0;pending.length=0;cleanups.length=0;globalThis.__failRefresh=false;
 const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 globalThis.window={setTimeout:fn=>{const t={fn};timers.push(t);return t;},clearTimeout:t=>{t.cancelled=true;},setInterval:()=>0,clearInterval:()=>{}};
 const SECOND=config.PROVIDERS[0].address;
 const find=pred=>nodes(render()).find(pred);
 const field=()=>find(n=>n.props?.id==='send-recipient');
 const useMine=()=>find(n=>n.type==='Button'&&n.props.children==='Use my wallet');
 const send=()=>find(n=>n.type==='Button'&&n.props.children?.includes?.('Swap & send'));
 const text=()=>JSON.stringify(render(),(_,v)=>typeof v==='bigint'?v.toString():v);
 async function settle(){await flush();for(const r of pending.splice(0))reply(r);await Promise.resolve();await flush();}
 async function connectAs(address,current){
  globalThis.__fxWallet=globalThis.__fxActive=address;
  const header=find(n=>n.type==='Button'&&Array.isArray(n.props.children)&&n.props.children.includes(current??'Connect wallet'));
  await header.props.onClick();await settle();
 }
 try {
  await settle();
  assert.equal(field().props.value,'','no pre-filled recipient');
  assert.equal(useMine().props.disabled,true,'Use my wallet needs a connected wallet');
  await connectAs(WALLET);
  assert.equal(field().props.value,'','connecting does not fill the recipient');
  assert.equal(send().props.disabled,true,'no recipient, no send');

  field().props.onChange({target:{value:'GABC'}});await settle();
  assert.ok(text().includes('Enter a valid Stellar account (G…) or contract (C…) address.'));
  assert.equal(send().props.disabled,true,'invalid recipient cannot send');

  field().props.onChange({target:{value:` ${OTHER} `}});await settle();
  assert.equal(field().props.value,OTHER);
  await connectAs(SECOND,WALLET);
  assert.equal(field().props.value,OTHER,'a typed recipient survives an account change');
  const review=find(n=>n.type==='dl'&&n.props['aria-label']==='Review before signing');
  const reviewText=JSON.stringify(review,(_,v)=>typeof v==='bigint'?v.toString():v);
  for(const part of [SECOND,OTHER,config.ASSETS.USD.code,config.ASSETS.EUR.code])assert.ok(reviewText.includes(part),`review shows ${part}`);
  assert.ok(text().includes('This sends to another address, not your connected wallet.'));
  assert.equal(send().props.disabled,false);

  useMine().props.onClick();await settle();
  assert.equal(field().props.value,SECOND);
  assert.ok(!text().includes('This sends to another address'));
  await connectAs(SECOND,SECOND);
  assert.equal(field().props.value,SECOND,'reconnecting the same account keeps it');
  await connectAs(WALLET,SECOND);
  assert.equal(field().props.value,'','own-wallet recipient from the old account is cleared');
  assert.equal(send().props.disabled,true);

  // The wallet switches accounts without reconnecting: stop before signing.
  useMine().props.onClick();await settle();assert.equal(field().props.value,WALLET);
  globalThis.__fxActive=OTHER;let signed=0;globalThis.__fxExecute=()=>{signed++;};
  const clicked=send().props.onClick();
  for(let i=0;i<50&&!pending.length;i++)await new Promise(setImmediate);
  reply(pending.shift());await clicked;await flush();
  assert.equal(signed,0,'nothing is signed for a changed account');
  assert.equal(field().props.value,'','own-wallet recipient is cleared');
  assert.ok(text().includes('Your wallet account changed or disconnected'));
  assert.ok(find(n=>n.type==='Button'&&n.props.children?.includes?.('Connect wallet')),'wallet must be reconnected');
 } finally {delete globalThis.window;delete globalThis.localStorage;globalThis.__fxWallet=globalThis.__fxActive=WALLET;}
});


async function mountLiquidityParent(){
 if(globalThis.window)for(const cleanup of cleanups)cleanup?.();
 slots.length=0;effects.length=0;timers.length=0;pending.length=0;cleanups.length=0;globalThis.__failRefresh=false;
 globalThis.__fxWallet=globalThis.__fxActive=WALLET;globalThis.__providerReads=[];
 const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 globalThis.window={setTimeout:fn=>{const t={fn};timers.push(t);return t;},clearTimeout:t=>{t.cancelled=true;},setInterval:()=>0,clearInterval:()=>{}};
 const settle=async()=>{for(let i=0;i<3;i++){await flush();for(const r of pending.splice(0))reply(r);await new Promise(setImmediate);}};
 await settle();
 await nodes(render()).find(n=>n.type==='Button'&&n.props.children?.includes('Connect wallet')).props.onClick();await settle();
 return {settle,panel:()=>nodes(render()).find(n=>n.type==='LiquidityPanel'),text:()=>JSON.stringify(render(),(_,v)=>typeof v==='bigint'?String(v):v),close(){for(const f of cleanups)f?.();delete globalThis.__walletRead;delete globalThis.__providerRead;delete globalThis.window;delete globalThis.localStorage;}};
}
const walletAmounts=value=>Object.fromEntries(['USD','EUR','GBP','TRY'].map(k=>[k,value]));

test('liquidity success refreshes parent balances/providers and refresh failure hides stale wallet amounts',async()=>{
 const c=await mountLiquidityParent();
 try {
  assert.equal(typeof c.panel().props.onConfirmed,'function');
  globalThis.__walletRead=async()=>walletAmounts(77000000n);
  await c.panel().props.onConfirmed(WALLET,77);await c.settle();
  assert.equal(selector('You send currency').props.balances.USD,77000000n);
  assert.ok(globalThis.__providerReads.length>=4,'providers re-read after confirmation');
  globalThis.__walletRead=async()=>{throw Error('Horizon offline');};
  await assert.rejects(c.panel().props.onConfirmed(WALLET,78));await c.settle();
  assert.equal(selector('You send currency').props.balances,undefined);assert.match(c.text(),/Balance unavailable/);
  assert.ok(!c.text().includes('Not enough USDC'),'read failure is not zero funds');
  globalThis.__walletRead=async()=>walletAmounts(66000000n);
  await c.panel().props.onConfirmed(WALLET,78);await c.settle();
  assert.equal(selector('You send currency').props.balances.USD,66000000n);
 } finally {c.close();}
});

test('late liquidity refresh cannot replace a newer balance read or a reconnected wallet',async()=>{
 const c=await mountLiquidityParent();
 try {
  assert.equal(typeof c.panel().props.onConfirmed,'function');
  const waiting=[];globalThis.__walletRead=account=>new Promise(resolve=>waiting.push({account,resolve}));
  const callback=c.panel().props.onConfirmed;
  const first=callback(WALLET,77),second=callback(WALLET,78);
  waiting[1].resolve(walletAmounts(88000000n));await second;waiting[0].resolve(walletAmounts(11000000n));await first;await c.settle();
  assert.equal(selector('You send currency').props.balances.USD,88000000n);
  const late=callback(WALLET,79);
  globalThis.__walletRead=async()=>walletAmounts(99000000n);globalThis.__fxWallet=globalThis.__fxActive=OTHER;
  await nodes(render()).find(n=>n.type==='Button'&&n.props.children?.includes(WALLET)).props.onClick();await c.settle();
  waiting[2].resolve(walletAmounts(12000000n));await late;await callback(WALLET,80);await c.settle();
  assert.equal(selector('You send currency').props.balances.USD,99000000n);
  assert.equal(c.panel().props.wallet,OTHER);
 } finally {c.close();}
});

test('provider ledger floors survive later refreshes and an older provider response cannot replace current inventory',async()=>{
 const c=await mountLiquidityParent(),lp=config.PROVIDERS[0].address;
 const stats=value=>Object.fromEntries(['USD','EUR','GBP','TRY'].map(k=>[k,{balance:value,fees:0n}]));
 const refresh=()=>nodes(render()).find(n=>n.props?.['aria-label']==='Refresh liquidity').props.onClick();
 const card=()=>JSON.stringify(nodes(render()).find(n=>n.key===lp),(_,v)=>typeof v==='bigint'?String(v):v);
 try {
  globalThis.__fxWallet=globalThis.__fxActive=lp;
  await nodes(render()).find(n=>n.type==='Button'&&n.props.children?.includes(WALLET)).props.onClick();await c.settle();
  assert.equal(c.panel().props.visible,false);
  nodes(render()).find(n=>n.props?.id==='nav-liquidity').props.onClick();await c.settle();assert.equal(c.panel().props.visible,true);
  assert.equal(c.panel().key,`testnet:${config.FX_ROUTER}:${lp}`);
  let resolveOld,hold=true;
  globalThis.__providerRead=async account=>{
   if(account===lp&&hold){hold=false;return new Promise(resolve=>{resolveOld=resolve;});}
   return stats(555000000n);
  };
  const old=refresh();globalThis.__providerReads.length=0;
  await c.panel().props.onConfirmed(lp,77);await c.settle();
  assert.deepEqual(globalThis.__providerReads,[[lp,77],[config.PROVIDERS[1].address,0]],'floor belongs only to the confirmed provider');
  assert.ok(card().includes('555000000'));
  resolveOld(stats(111000000n));await old;await c.settle();
  assert.ok(card().includes('555000000'));assert.ok(!card().includes('111000000'));
  globalThis.__providerReads.length=0;await refresh();await c.settle();
  assert.deepEqual(globalThis.__providerReads,[[lp,77],[config.PROVIDERS[1].address,0]],'ordinary later refresh preserves the bound');
 } finally {c.close();}
});
