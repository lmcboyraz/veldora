#!/usr/bin/env node
// Keeps every ledger entry the live FX demo depends on alive (see demo-ledger.mjs for the exact
// set). Each persistent entry, contract instance and wasm code whose TTL is below the target is
// extended with ExtendFootprintTTL. That operation only raises live-until ledgers; it cannot
// change contract data. Inspect (simulate only) by default; --execute signs with rise-deployer.
import {writeFileSync} from 'node:fs';
import {Operation,SorobanDataBuilder,rpc} from '@stellar/stellar-sdk';
import {LEDGERS_PER_DAY,b64,ledgerDate,readEntries,requiredKeys,server,simulate} from './demo-ledger.mjs';
import {key,state,save} from './fx-bootstrap.mjs';

const execute=process.argv.includes('--execute');
const EXTEND_TO=60*LEDGERS_PER_DAY;                     // ~60 days at 5 s; network max is 3,110,400
const MAX_ENTRIES=150, MAX_READ_BYTES=150_000;         // tx limits are 200 entries / 200,000 bytes
const admin=key('rise-deployer');

console.log(execute?'TESTNET EXECUTE':'TESTNET INSPECT (simulation only)');
const required=await requiredKeys();
required.warnings.forEach(w=>console.warn('warning:',w));
const {latest,rows}=await readEntries(required);
const target=latest+EXTEND_TO;
// Entries within a day of the target are left alone, so a rerun right after success is a no-op.
const extend=rows.filter(r=>r.present&&r.live&&r.durability!=='temporary'&&r.live<target-LEDGERS_PER_DAY);
console.log(`latest ledger ${latest}; target live-until ≥ ${target} (≈${ledgerDate(target,latest)}, +${EXTEND_TO} ledgers)`);
console.log(`${required.keys.size} keys: ${rows.filter(r=>r.present).length} present, ${rows.filter(r=>!r.present).length} absent`);
console.table(rows.filter(r=>r.present).sort((a,b)=>(a.live??Infinity)-(b.live??Infinity)).map(r=>({entry:r.label,live_until:r.live??'—',
 expires_approx:r.live?ledgerDate(r.live,latest):'no TTL (classic)',
 action:!r.live?'none: classic entry':r.durability==='temporary'?'none: temporary, rewritten by owner':r.live>=target-LEDGERS_PER_DAY?'none: already ≥ target':'EXTEND'})));
console.log('absent (never written, nothing to extend):',rows.filter(r=>!r.present).map(r=>r.label.replace('router persistent ','')).join(' | '));

// Batch into ExtendFootprintTTL transactions within per-transaction read limits.
const batches=[];
for(const r of extend.sort((a,b)=>b.bytes-a.bytes)){
 const bin=batches.find(b=>b.rows.length<MAX_ENTRIES&&b.bytes+r.bytes<=MAX_READ_BYTES);
 if(bin){bin.rows.push(r);bin.bytes+=r.bytes;}else batches.push({rows:[r],bytes:r.bytes});
}
const plan=[];
for(const [i,b] of batches.entries()){
 const data=new SorobanDataBuilder().setReadOnly(b.rows.map(r=>r.key)).build();
 const {tx,sim}=await simulate(admin.publicKey(),Operation.extendFootprintTtl({extendTo:EXTEND_TO}),data);
 plan.push({tx:i+1,entries:b.rows.length,read_bytes:Math.round(b.bytes),sim:'SUCCESS',resource_fee_xlm:Number(sim.minResourceFee)/1e7});
 if(execute){
  const label=`ttl:${latest}:${i+1}`;
  if(state[label]?.done)continue;
  const prepared=rpc.assembleTransaction(tx,sim).build();prepared.sign(admin);
  state[label]={hash:Buffer.from(prepared.hash()).toString('hex'),xdr:prepared.toXdr()};save(); // persist before submit
  const sent=await server.sendTransaction(prepared);
  if(sent.status==='ERROR')throw Error(`RPC rejected ${label}`);
  for(let n=0;;n++){const r=await server.getTransaction(sent.hash);if(r.status==='SUCCESS')break;if(r.status==='FAILED')throw Error(`Failed ${label} ${sent.hash}`);if(n>30)throw Error(`Unconfirmed ${label} ${sent.hash}; rerun to reconcile`);await new Promise(r=>setTimeout(r,1000));}
  state[label]={hash:sent.hash,done:true};save();console.log('Confirmed:',label,sent.hash);
 }
}
if(plan.length)console.table(plan);else console.log('Nothing to extend: every required entry is within a day of the target.');
const out='work/ttl-plan.json';
writeFileSync(out,JSON.stringify({latest,extendTo:EXTEND_TO,target,batches:batches.map((b,i)=>({tx:i+1,extendTo:EXTEND_TO,readOnlyFootprint:b.rows.map(r=>({entry:r.label,liveUntil:r.live,keyXdr:b64(r.key)}))}))},null,2));
console.log(`Exact footprints written to ${out}.${execute?'':' Nothing was submitted; add --execute to extend.'}`);
