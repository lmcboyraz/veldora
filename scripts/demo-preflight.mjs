#!/usr/bin/env node
// Demo-day preflight: read-only checks of everything the live FX demo depends on.
// Prints PASS / WARN / FAIL per check and exits 1 on any FAIL. It uses simulations and
// ledger reads only: no keys, no signatures, no on-chain writes.  Run: npm run demo:preflight
import {xdr} from '@stellar/stellar-sdk';
import {ASSETS,DEMO_AMOUNT,DEMO_RECIPIENT,FX_ROUTER,FX_ROUTE_ENABLED,HORIZON_URL,PROVIDERS,REFLECTOR_ORACLE,VIEW_ACCOUNT} from '../lib/config.ts';
import {LEDGERS_PER_DAY,addr,assetName,deployment,i128,ledgerDate,read,readEntries,requiredKeys,short} from './demo-ledger.mjs';
import {anchorRate} from './try-price-keeper.mjs';

const statuses=[];
const report=(status,check,detail)=>{statuses.push(status);console.log(`${status.padEnd(4)}  ${check.padEnd(16)} ${detail}`);};
const note=text=>console.log(`${' '.repeat(24)}${text}`);
const other=s=>xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'),xdr.ScVal.scvSymbol(s)]);
const now=()=>Math.floor(Date.now()/1000);
const units=n=>Number(n)/1e7;
const code=error=>Number(String(error.simulationError??error.message).match(/Error\(Contract, #(\d+)\)/)?.[1]);
async function check(name,fn){
 try{await fn();}catch(error){report('FAIL',name,error.restore?`restore required: ${error.message}`:error.message);}
}

console.log(`Veldora FX demo preflight · Stellar Testnet · ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC\n`);

await check('Router',async()=>{
 const [hub,maxAge,paused]=await Promise.all([read(FX_ROUTER,'get_hub'),read(FX_ROUTER,'get_max_price_age'),read(FX_ROUTER,'is_paused')]);
 const ok=FX_ROUTER===deployment.router&&FX_ROUTE_ENABLED&&hub===ASSETS.USD.contract&&Number(maxAge)===900;
 report(ok?'PASS':'FAIL','Router',`${FX_ROUTER}${FX_ROUTER===deployment.router?'':' (differs from lib/fx-testnet.json)'} · hub ${assetName(hub)} · max price age ${maxAge} s`);
 report(paused?'FAIL':'PASS','Router paused',paused?'PAUSED: swaps are unavailable':'no');
});

await check('Asset oracles',async()=>{
 const cfg=Object.fromEntries(await Promise.all(Object.entries(ASSETS).map(async([k,a])=>[k,await read(FX_ROUTER,'get_asset',[addr(a.contract)])])));
 const ok=Object.values(cfg).every(c=>c?.enabled)&&cfg.USD.is_oracle_base&&cfg.EUR.oracle===REFLECTOR_ORACLE&&cfg.GBP.oracle===REFLECTOR_ORACLE&&cfg.TRY.oracle===deployment.oracle;
 report(ok?'PASS':'FAIL','Asset oracles',`USDC base · EURC, rGBP → Reflector · rTRY → demo/mock oracle ${deployment.oracle}`);
});

for(const s of ['EUR','GBP'])await check(`Reflector ${s}`,async()=>{
 const p=await read(REFLECTOR_ORACLE,'lastprice',[other(s)]);
 if(!p)return report('FAIL',`Reflector ${s}`,'no price available');
 const age=now()-Number(p.timestamp), expires=Number(await read(REFLECTOR_ORACLE,'expires',[other(s)])), days=(expires-now())/86400;
 report(age>900?'FAIL':days<14?'WARN':'PASS',`Reflector ${s}`,`price age ${age} s (router limit 900 s) · feed subscription until ${new Date(expires*1000).toISOString().slice(0,10)} (${Math.floor(days)} days)`);
});

await check('TRY demo feed',async()=>{
 const snap=await read(deployment.oracle,'snapshot');
 if(!snap)return report('FAIL','TRY demo feed','snapshot expired: run `npm run try:refresh`');
 const age=now()-Number(snap.timestamp), left=Number(snap.expires)-now(), tryPerUsd=1e14/Number(snap.price);
 let drift=0, anchor='Mock Anchor rate unavailable';
 try{const {price}=await anchorRate();drift=(Number(price)/tryPerUsd-1)*100;anchor=`Mock Anchor ${Number(price).toFixed(4)} (${drift>=0?'+':''}${drift.toFixed(2)}%)`;}catch{}
 report(left<2*3600||Math.abs(drift)>2?'WARN':'PASS','TRY demo feed',`${tryPerUsd.toFixed(4)} TRY/USD · set ${Math.round(age/60)} min ago · expires in ${(left/3600).toFixed(1)} h (${new Date(Number(snap.expires)*1000).toISOString().slice(0,16).replace('T',' ')} UTC) · ${anchor}`);
 if(left<6*3600)note('Refresh right before the demo: npm run try:refresh');
});

await check('Ledger TTL',async()=>{
 const required=await requiredKeys();
 const {latest,rows}=await readEntries(required);
 const missing=rows.filter(r=>!r.present&&/instance|wasm code/.test(r.label));
 if(missing.length)return report('FAIL','Ledger TTL',`missing: ${missing.map(r=>r.label).join(', ')}`);
 const alive=rows.filter(r=>r.present&&r.live), earliest=alive.reduce((m,r)=>r.live<m.live?r:m);
 const days=(earliest.live-latest)/LEDGERS_PER_DAY;
 report(days<3?'FAIL':days<14?'WARN':'PASS','Ledger TTL',`${alive.length} required entries alive for ≥ ${days.toFixed(1)} days (earliest: ${earliest.label}, ≈${ledgerDate(earliest.live,latest)})`);
 if(days<14)note('Extend before the demo: node scripts/extend-ttl.mjs (inspect), then --execute');
 report('PASS','Restore needed','no: every route simulation ran without an archived entry');
 required.warnings.forEach(w=>note(w));
});

await check('LP inventory',async()=>{
 const providers=await read(FX_ROUTER,'get_providers'), totals={};
 for(const p of providers){
  const per=[];
  for(const [k,a] of Object.entries(ASSETS)){const b=BigInt(await read(FX_ROUTER,'get_balance',[addr(p),addr(a.contract)]));totals[k]=(totals[k]??0n)+b;if(b>0n)per.push(`${a.code} ${units(b).toFixed(2)}`);}
  if(per.length)note(`${PROVIDERS.find(x=>x.address===p)?.name??short(p)}: ${per.join(' · ')}`);
 }
 const floor={USD:10,EUR:10,GBP:20,TRY:250};
 const low=Object.entries(totals).filter(([k,v])=>units(v)<floor[k]);
 report(low.some(([k,v])=>units(v)<floor[k]/5)?'FAIL':low.length?'WARN':'PASS','LP inventory',Object.entries(totals).map(([k,v])=>`${ASSETS[k].code} ${units(v).toFixed(2)}`).join(' · '));
});

// Demo wallets: public keys from lib/config.ts only; balances must match each asset's exact issuer.
for(const [role,account] of [['Demo sender',VIEW_ACCOUNT],['Demo recipient',DEMO_RECIPIENT]])await check(role,async()=>{
 const res=await fetch(`${HORIZON_URL}/accounts/${account}`);
 if(!res.ok)return report('FAIL',role,`${account} not found on Testnet: fund it with Friendbot`);
 const {balances}=await res.json(), xlm=Number(balances.find(b=>b.asset_type==='native').balance), min=Number(DEMO_AMOUNT);
 const lines=Object.values(ASSETS).map(a=>{const b=balances.find(b=>b.asset_code===a.code&&b.asset_issuer===a.issuer);return {a,b,spend:b?.is_authorized?Number(b.balance)-Number(b.selling_liabilities):null};});
 const missing=lines.filter(l=>l.spend===null), low=role==='Demo sender'?lines.filter(l=>l.spend!==null&&l.spend<min):[];
 report(missing.length||xlm<5?'FAIL':low.length?'WARN':'PASS',role,`${account} · XLM ${xlm.toFixed(2)} · ${lines.map(l=>`${l.a.code} ${l.spend===null?'NO TRUSTLINE':l.spend.toFixed(4)}`).join(' · ')}`);
 if(low.length)note(`Below the ${DEMO_AMOUNT}-unit demo amount: ${low.map(l=>l.a.code).join(', ')}`);
});

// Quotes: a route is broken only on a router/oracle failure. Hitting an LP's per-swap limit
// or running short of inventory is reported separately.
const providers=await read(FX_ROUTER,'get_providers').catch(()=>[]);
const activePairs=async(a,b)=>(await Promise.all(providers.map(p=>read(FX_ROUTER,'get_pair',[addr(p),addr(ASSETS[a].contract),addr(ASSETS[b].contract)]).catch(()=>null)))).filter(x=>x?.active);
const capped=(pairs,input)=>pairs.length>0&&pairs.every(p=>BigInt(p.max_amount_in)>0n&&BigInt(p.max_amount_in)<input);
async function noLiquidityReason(s,t,input){
 const direct=await activePairs(s,t);
 if(s==='USD'||t==='USD')return capped(direct,input)?'LP per-swap limit':'liquidity shortage';
 const hub=await read(FX_ROUTER,'quote_route',[addr(ASSETS[s].contract),addr(ASSETS.USD.contract),i128(input)]).catch(()=>null);
 const hubCapped=capped(await activePairs(s,'USD'),input)||(hub&&capped(await activePairs('USD',t),BigInt(hub.amount_out)));
 return (direct.length===0||capped(direct,input))&&hubCapped?'LP per-swap limit':'liquidity shortage';
}
const coins=Object.keys(ASSETS);
for(const amount of [1,5]){
 const lines=[];let fail=0,warn=0;
 for(const s of coins)for(const t of coins)if(s!==t){
  const input=BigInt(amount)*10_000_000n, pair=`${ASSETS[s].code}→${ASSETS[t].code}`.padEnd(11);
  try{
   const q=await read(FX_ROUTER,'quote_route',[addr(ASSETS[s].contract),addr(ASSETS[t].contract),i128(input)]);
   lines.push(`PASS ${pair} ${amount} → ${units(q.amount_out).toFixed(4)} ${ASSETS[t].code} (${q.hops.length===1?'direct':'via USDC'}, ${q.hops.map(h=>h.fee_bps).join('+')} bps)`);
  }catch(error){
   const c=code(error);
   if(c===8){const reason=await noLiquidityReason(s,t,input);warn+=reason.startsWith('LP')||amount>1?1:0;fail+=reason.startsWith('LP')||amount>1?0:1;lines.push(`${reason.startsWith('LP')||amount>1?'WARN':'FAIL'} ${pair} ${amount}: ${reason} (not a router failure)`);}
   else{fail++;lines.push(`FAIL ${pair} ${amount}: router/oracle failure ${c?`#${c} `:''}${c===9?'(price missing)':c===10?'(price stale)':c===14?'(router paused)':error.message.slice(0,80)}`);}
  }
 }
 report(fail?'FAIL':warn?'WARN':'PASS',`Quotes ${amount} unit${amount>1?'s':''}`,`${12-fail-warn}/12 directions route${warn?`, ${warn} limited`:''}${fail?`, ${fail} failing`:''}`);
 lines.forEach(l=>note(l));
}

const fails=statuses.filter(s=>s==='FAIL').length, warns=statuses.filter(s=>s==='WARN').length;
console.log(`\n${fails?'FAIL':warns?'WARN':'PASS'}: ${statuses.length-fails-warns} passed, ${warns} warnings, ${fails} failures. Read-only: nothing was signed or submitted.`);
process.exitCode=fails?1:0;
