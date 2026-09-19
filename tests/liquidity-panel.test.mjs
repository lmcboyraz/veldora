import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import ts from 'typescript';
import {ASSETS,FX_ROUTER,VIEW_ACCOUNT} from '../lib/config.ts';

// Exercise the actual component handlers; only React scheduling, UI primitives and I/O are substituted.
let current;
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
globalThis.__lpHooks={
 useState(value){const c=current,i=c.cursor++;if(!(i in c.slots))c.slots[i]=value;return [c.slots[i],v=>c.slots[i]=typeof v==='function'?v(c.slots[i]):v];},
 useRef(value){const c=current,i=c.cursor++;return c.slots[i]??={current:value};},
 useCallback(fn,deps){const c=current,i=c.cursor++;if(!same(c.slots[i]?.deps,deps))c.slots[i]={fn,deps};return c.slots[i].fn;},
 useEffect(fn,deps){const c=current,i=c.cursor++;if(!same(c.slots[i],deps)){c.slots[i]=deps;c.effects.push(()=>{c.cleanups[i]?.();c.cleanups[i]=fn();});}}
};
const url=new URL('../components/liquidity-panel.tsx',import.meta.url),data=s=>'data:text/javascript,'+encodeURIComponent(s);
registerHooks({resolve(s,c,next){
 if(c.parentURL===url.href){
  if(s==='react')return {url:data('export const {useState,useRef,useCallback,useEffect}=globalThis.__lpHooks;'),shortCircuit:true};
  if(s.startsWith('./ui/'))return {url:data("export const Button='Button',Input='Input';"),shortCircuit:true};
  if(s==='@/lib/liquidity')return {url:data('export const getLiquidityState=(...a)=>globalThis.__lpIO.read(...a),moveLiquidity=(...a)=>globalThis.__lpIO.move(...a),checkLpRecord=(...a)=>globalThis.__lpIO.check(...a),registerProvider=()=>{throw Error("unexpected registration")},configureProvider=()=>{throw Error("unexpected pair")};'),shortCircuit:true};
  if(s==='@/lib/lp-transaction')return {url:data('export const readLpRecord=()=>globalThis.__lpIO.saved;'),shortCircuit:true};
  if(s==='@/lib/stellar')return {url:data("export const formatAmount=v=>String(v),shorten=v=>v,unresolvedMessage=()=> 'Still pending';"),shortCircuit:true};
  if(s.startsWith('@/lib/'))return next(new URL('../'+s.slice(2)+'.ts',import.meta.url).href,c);
 }
 return next(s,c);
},load(u,c,next){if(u===url.href)return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(url,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext}}).outputText};return next(u,c);}});
const {LiquidityPanel}=await import(url.href);
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)];
const snapshot=(balance=500n)=>({registered:true,paused:false,permissionless:true,pair:null,wallet:Object.fromEntries(Object.keys(ASSETS).map(k=>[k,1000n])),stats:Object.fromEntries(Object.keys(ASSETS).map(k=>[k,{balance,fees:0n}]))});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function setup(extra={}){
 const c={cursor:0,slots:[],effects:[],cleanups:[],timers:[],reads:[],notices:[],sends:0,props:{wallet:VIEW_ACCOUNT,visible:true,connect(){},onConfirmed:async(...a)=>{c.notices.push(a);},...extra}};
 globalThis.window={setTimeout(fn){const t={fn};c.timers.push(t);return t;},clearTimeout(t){t.cancelled=true;}};
 globalThis.__lpIO={saved:null,read:async(...a)=>{c.reads.push(a);return snapshot();},move:async()=>{c.sends++;return {hash:'a'.repeat(64),inventory:42n,result:{ledger:77,latestLedger:999}};},check:async()=>null};
 c.render=()=>{current=c;c.cursor=0;return LiquidityPanel(c.props);};
 c.flush=async()=>{for(let i=0;i<4;i++){c.render();for(const f of c.effects.splice(0))f();for(const t of c.timers.splice(0))if(!t.cancelled)t.fn();await new Promise(setImmediate);}};
 c.button=name=>nodes(c.render()).find(n=>n.type==='Button'&&n.props.children===name);
 c.text=()=>JSON.stringify(c.render(),(_,v)=>typeof v==='bigint'?String(v):v);
 c.inventory=()=>nodes(c.render()).find(n=>n.props?.className==='inventory-tile'&&nodes(n).some(x=>x.type==='p'&&[x.props.children].flat().join('')==='EURC router inventory'))?.props.children[1].props.children;
 c.amount=()=>nodes(c.render()).find(n=>n.props?.id==='lp-amount').props.onChange({target:{value:'1'}});
 c.unmount=()=>{for(const f of c.cleanups)f?.();};return c;
}

for(const kind of ['Deposit','Withdraw'])test(`confirmed ${kind} refreshes parent and panel without replacing newer inventory`,async()=>{
 const c=setup();await c.flush();c.amount();await c.button(kind).props.onClick();await c.flush();
 assert.equal(c.inventory(),'500','new read wins over transaction return 42');
 assert.deepEqual(c.notices,[[VIEW_ACCOUNT,77]]);assert.equal(c.reads.at(-1)[3],77);assert.equal(c.sends,1);
 c.props.visible=false;await c.flush();const count=c.reads.length;c.props.visible=true;await c.flush();
 assert.equal(c.reads.length,count+1,'one read on tab return');assert.equal(c.reads.at(-1)[3],77,'ledger floor survives tab changes');
 await c.flush();assert.equal(c.reads.length,count+1,'no refresh loop');c.unmount();
});

test('recovered success propagates its execution ledger and parent refresh once',async()=>{
 const c=setup();const saved={hash:'b'.repeat(64),wallet:VIEW_ACCOUNT,network:'testnet',router:FX_ROUTER,kind:'withdraw'};
 globalThis.__lpIO.saved=saved;globalThis.__lpIO.check=async()=>{globalThis.__lpIO.saved=null;return {saved,state:'success',ledger:88};};
 await c.flush();assert.deepEqual(c.notices,[[VIEW_ACCOUNT,88]]);assert.equal(c.reads.at(-1)[3],88);assert.equal(c.sends,0);assert.match(c.text(),/confirmed/);
 await c.button('Refresh').props.onClick();assert.equal(c.reads.at(-1)[3],88);c.unmount();
});

test('confirmed success survives panel and parent refresh errors with its hash and no resubmission',async()=>{
 const c=setup({onConfirmed:async()=>{throw Error('parent offline');}});await c.flush();c.amount();
 globalThis.__lpIO.read=async()=>{throw Error('RPC behind');};
 await c.button('Deposit').props.onClick();await c.flush();
 assert.match(c.text(),/confirmed/);assert.match(c.text(),/could not|unavailable/i);assert.ok(c.text().includes('a'.repeat(64)));
 assert.equal(c.inventory(),'—');assert.equal(c.button('Check transaction'),undefined);assert.equal(c.sends,1);c.unmount();
});

test('recovered success remains settled when both refreshes fail',async()=>{
 const c=setup({onConfirmed:async()=>{throw Error('parent offline');}});
 const saved={hash:'c'.repeat(64),wallet:VIEW_ACCOUNT,network:'testnet',router:FX_ROUTER,kind:'deposit'};
 globalThis.__lpIO.saved=saved;globalThis.__lpIO.read=async()=>{throw Error('RPC behind');};
 globalThis.__lpIO.check=async()=>{globalThis.__lpIO.saved=null;return {saved,state:'success',ledger:91};};
 await c.flush();assert.match(c.text(),/confirmed/);assert.ok(c.text().includes(saved.hash));assert.equal(c.inventory(),'—');
 assert.equal(c.button('Check transaction'),undefined);assert.equal(c.sends,0);c.unmount();
});

test('Refresh retries a failed parent read at the saved ledger without resubmitting',async()=>{
 const ledgers=[];let offline=true;
 const c=setup({onConfirmed:async(wallet,ledger)=>{ledgers.push(ledger);if(offline)throw Error('Horizon offline');}});
 await c.flush();c.amount();await c.button('Deposit').props.onClick();await c.flush();
 assert.match(c.text(),/could not refresh/);assert.deepEqual(ledgers,[77]);
 offline=false;await c.button('Refresh').props.onClick();await c.flush();
 assert.deepEqual(ledgers,[77,77]);assert.ok(!c.text().includes('could not refresh'));assert.match(c.text(),/confirmed/);assert.equal(c.sends,1);
 await c.button('Refresh').props.onClick();assert.deepEqual(ledgers,[77,77],'successful parent reads are not repeated on every panel refresh');c.unmount();
});

test('visibility and callback identity changes do not cause duplicate refresh loops',async()=>{
 const c=setup({visible:false});await c.flush();assert.equal(c.reads.length,0);
 c.props.visible=true;await c.flush();assert.equal(c.reads.length,1);
 c.props.onConfirmed=async()=>{};await c.flush();assert.equal(c.reads.length,1);c.unmount();
});

test('settlement from an unmounted wallet cannot notify or update the new wallet',async()=>{
 const old=setup();await old.flush();old.amount();const waiting=deferred();globalThis.__lpIO.move=()=>waiting.promise;
 const move=old.button('Deposit').props.onClick();old.unmount();
 const next=setup({wallet:'another-wallet'});await next.flush();
 waiting.resolve({hash:'d'.repeat(64),inventory:42n,result:{ledger:999}});await move;
 assert.deepEqual(old.notices,[]);assert.deepEqual(next.notices,[]);assert.equal(next.inventory(),'500');assert.equal(next.reads[0][3],0);next.unmount();
});

for(const reason of ['Signature rejected','The transaction failed on Stellar Testnet'])test(`${reason} produces no success callback or balance credit`,async()=>{
 const c=setup();await c.flush();c.amount();globalThis.__lpIO.move=async()=>{c.sends++;throw Error(reason);};
 await c.button('Deposit').props.onClick();await c.flush();assert.deepEqual(c.notices,[]);assert.equal(c.inventory(),'500');assert.ok(!c.text().includes('Transaction confirmed'));assert.equal(c.sends,1);c.unmount();
});

test('late refresh and unmounted old wallet cannot overwrite the current panel',async()=>{
 const old=setup();await old.flush();const first=deferred(),second=deferred();let n=0;
 globalThis.__lpIO.read=()=>++n===1?first.promise:second.promise;
 const a=old.button('Refresh').props.onClick(),b=old.button('Refresh').props.onClick();second.resolve(snapshot(900n));await b;first.resolve(snapshot(100n));await a;
 assert.equal(old.inventory(),'900');
 const pending=deferred();globalThis.__lpIO.read=()=>pending.promise;const late=old.button('Refresh').props.onClick();old.unmount();
 const next=setup({wallet:'another-wallet'});await next.flush();pending.resolve(snapshot(123n));await late;
 assert.equal(next.inventory(),'500');assert.equal(next.reads[0][3]??0,0);assert.deepEqual(next.notices,[]);next.unmount();
});

test('a recovered transaction for another router does not set the active router ledger floor',async()=>{
 const c=setup();const saved={hash:'b'.repeat(64),wallet:VIEW_ACCOUNT,network:'testnet',router:'previous-router',kind:'withdraw'};
 globalThis.__lpIO.saved=saved;globalThis.__lpIO.check=async()=>{globalThis.__lpIO.saved=null;return {saved,state:'success',ledger:88};};
 await c.flush();assert.equal(c.reads.at(-1)[3]??0,0);assert.deepEqual(c.notices,[]);c.unmount();
});
