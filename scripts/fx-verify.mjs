#!/usr/bin/env node
// Public quote inspection by default; --execute settles each named demo scenario only once.
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {Address,Keypair,nativeToScVal,scValToNative} from '@stellar/stellar-sdk';
import {ASSETS,PROVIDERS,VIEW_ACCOUNT,DEMO_RECIPIENT,NETWORK_PASSPHRASE} from '../lib/config.ts';
import {read,call,state,save,server} from './fx-bootstrap.mjs';
const deployment=JSON.parse(readFileSync('lib/fx-testnet.json'));
const id=deployment.router;
const addr=s=>Address.fromString(s).toScVal(),i128=n=>nativeToScVal(n,{type:'i128'});
const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,null,2);
const balance=(token,account)=>read(token,'balance',[addr(account)]);
const report={router:id,at:new Date().toISOString(),quotes:[],executions:[]};
async function inventories(){
 return Object.fromEntries(await Promise.all(PROVIDERS.flatMap(p=>Object.values(ASSETS).flatMap(a=>['get_balance','get_fees'].map(async method=>[`${p.address}:${a.contract}:${method}`,BigInt(await read(id,method,[addr(p.address),addr(a.contract)]))])))));
}
export function assertVerified(result) {
 const directions=new Set(result.quotes.filter(q=>!q.error && q.quote?.amount_out>0 && q.source!==q.target).map(q=>`${q.source}:${q.target}`));
 assert.equal(directions.size,12,'All 12 directional quotes must pass');
 for(const [amount,hops] of [['200000000',2],['600000000',1]]) {
  const proof=result.executions.find(e=>String(e.actual?.amount_in)===amount);
  assert.ok(proof?.verified && !proof.blocked && proof.submitted!==false && /^[a-f0-9]{64}$/.test(proof.hash) && proof.actual.hops.length===hops,`Missing verified ${hops}-hop execution`);
 }
}
async function validateIdentity() {
 assert.equal((await server.getNetwork()).passphrase,NETWORK_PASSPHRASE);
 const instance=await server.getContractInstance(id);
 assert.ok('wasmHash' in instance.executable);
 assert.equal(Buffer.from(instance.executable.wasmHash.value).toString('hex'),deployment.routerWasmHash,'Router ABI/hash mismatch');
 for(const [currency,asset] of Object.entries(ASSETS)) {
  assert.equal(await read(asset.contract,'name'),`${asset.code}:${asset.issuer}`);
  const config=await read(id,'get_asset',[addr(asset.contract)]);
  assert.ok(config.enabled && Number(config.token_decimals)===7);
  assert.equal(config.oracle,asset.oracle);assert.equal(config.oracle_asset[1],currency);
 }
 for(const name of ['NEXT_PUBLIC_FX_ROUTER','NEXT_PUBLIC_RISE_FX_ROUTER']) if(process.env[name]) assert.equal(process.env[name],id,'Public router override conflicts with verified v2');
}
async function main(){
 await validateIdentity();
 for(const s of Object.keys(ASSETS))for(const t of Object.keys(ASSETS))if(s!==t){
  try{const q=await read(id,'quote_route',[addr(ASSETS[s].contract),addr(ASSETS[t].contract),i128(1000000n)]);report.quotes.push({source:s,target:t,quote:q});}
  catch(e){report.quotes.push({source:s,target:t,error:e.message});}
 }
 for(const [amount,hops] of [[20n,2],[60n,1]]){
  const input=amount*10000000n, source=ASSETS.TRY.contract,target=ASSETS.GBP.contract;
  const label=`verify:TRY:GBP:${amount}`,saved=state[`${id}:${label}:verified`];
  if(saved){
   const result=await server.getTransaction(saved.hash);
   assert.equal(result.status,'SUCCESS','Saved execution must still have verifiable chain evidence; do not resend');
   assert.equal(json(scValToNative(result.returnValue)),json(saved.actual));
   assert.equal(BigInt(saved.senderBefore)-BigInt(saved.senderAfter),input);
   assert.equal(BigInt(saved.recipientAfter)-BigInt(saved.recipientBefore),BigInt(saved.actual.amount_out));
   assert.equal(saved.actual.hops.length,hops);
   assert.deepEqual([saved.actual.path[0],saved.actual.path.at(-1)],[source,target]);
   report.executions.push({...saved,reused:true});continue;
  }
  const q=await read(id,'quote_route',[addr(source),addr(target),i128(input)]);
  if(q.hops.length!==hops){report.executions.push({amount:amount.toString(),expectedHops:hops,actualHops:q.hops.length,blocked:'Required route is not currently feasible; no transaction submitted.'});continue;}
  if(!process.argv.includes('--execute')){report.executions.push({amount:amount.toString(),quote:q,submitted:false});continue;}
  const kp=Keypair.fromSecret(execFileSync('stellar',['keys','secret','rise-wallet-a'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());
  assert.equal(kp.publicKey(),VIEW_ACCOUNT);
  const beforeKey=`${id}:${label}:before`;
  if(!state[beforeKey]){
   state[beforeKey]={sender:(await balance(source,VIEW_ACCOUNT)).toString(),recipient:(await balance(target,DEMO_RECIPIENT)).toString(),hub:(await balance(ASSETS.USD.contract,id)).toString(),inventory:JSON.parse(json(await inventories()))};save();
  }
  const before=state[beforeKey];
  await call(label,kp,id,'transfer_route',[addr(VIEW_ACCOUNT),addr(DEMO_RECIPIENT),addr(source),addr(target),i128(input),i128(q.amount_out*9950n/10000n),nativeToScVal(BigInt(Math.floor(Date.now()/1000)+180),{type:'u64'})]);
  const hash=state[`${id}:${label}`].hash,result=await server.getTransaction(hash);
  assert.equal(result.status,'SUCCESS');const actual=scValToNative(result.returnValue);
  assert.equal(actual.hops.length,hops);assert.equal(actual.amount_in,input);
  assert.deepEqual([actual.path[0],actual.path.at(-1)],[source,target]);
  const senderAfter=await balance(source,VIEW_ACCOUNT),recipientAfter=await balance(target,DEMO_RECIPIENT);
  assert.equal(BigInt(before.sender)-senderAfter,input);
  assert.equal(recipientAfter-BigInt(before.recipient),actual.amount_out);
  assert.equal(await balance(ASSETS.USD.contract,id),BigInt(before.hub));
  const expected=Object.fromEntries(Object.entries(before.inventory).map(([k,v])=>[k,BigInt(v)]));
  actual.hops.forEach((h,i)=>{expected[`${h.provider}:${actual.path[i]}:get_balance`]+=h.amount_in;expected[`${h.provider}:${actual.path[i+1]}:get_balance`]-=h.amount_out;expected[`${h.provider}:${actual.path[i+1]}:get_fees`]+=h.fee_amount;});
  assert.deepEqual(await inventories(),expected);
  const verified=JSON.parse(json({hash,actual,inventoryBefore:before.inventory,inventoryAfter:expected,hubBefore:before.hub,hubAfter:(await balance(ASSETS.USD.contract,id)),senderBefore:before.sender,senderAfter,recipientBefore:before.recipient,recipientAfter,networkFee:result.resultXdr.feeCharged,verified:true}));
  state[`${id}:${label}:verified`]=verified;save();report.executions.push(verified);
 }
 assertVerified(report);
 if(process.argv.includes('--activate')) { deployment.ready=true; writeFileSync('lib/fx-testnet.json',JSON.stringify(deployment,null,2)+'\n'); }
 writeFileSync('work/fx-verification.json',json(report)+'\n');
 console.log(json(report));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{if(process.argv.includes('--activate')) {deployment.ready=false;writeFileSync('lib/fx-testnet.json',JSON.stringify(deployment,null,2)+'\n');}writeFileSync('work/fx-verification.json',json({...report,error:e.message})+'\n');console.error(e.message);process.exitCode=1;});
