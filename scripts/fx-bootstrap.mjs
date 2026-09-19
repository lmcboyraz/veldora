#!/usr/bin/env node
// Isolated testnet v2 setup. No upgrade, withdrawal, reset, mainnet or wallet funding.
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Address,Asset,BASE_FEE,Contract,Horizon,Keypair,Networks,NotFoundError,Operation,TransactionBuilder,nativeToScVal,rpc,scValToNative,xdr} from '@stellar/stellar-sdk';
import {ASSETS,REFLECTOR_ORACLE,VIEW_ACCOUNT,DEMO_RECIPIENT,PROVIDERS} from '../lib/config.ts';
import {anchorRate} from './try-price-keeper.mjs';
const execute=process.argv.includes('--execute');
const stateFile='work/fx-bootstrap.json', publicFile='lib/fx-testnet.json';
const state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile)):{};
const deployment=JSON.parse(readFileSync(publicFile));
const save=()=>{writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n',{mode:0o600});chmodSync(stateFile,0o600);};
const savePublic=()=>writeFileSync(publicFile,JSON.stringify(deployment,null,2)+'\n');
const rpcUrl='https://soroban-testnet.stellar.org',horizon=new Horizon.Server('https://horizon-testnet.stellar.org'),server=new rpc.Server(rpcUrl);
const passphrase=Networks.TESTNET;
const addr=s=>Address.fromString(s).toScVal(), i128=n=>nativeToScVal(BigInt(n),{type:'i128'}), sym=s=>xdr.ScVal.scvSymbol(s);
const struct=o=>xdr.ScVal.scvMap(Object.entries(o).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>new xdr.ScMapEntry({key:sym(k),val:v})));
const other=s=>xdr.ScVal.scvVec([sym('Other'),sym(s)]);
const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
const units=s=>{if(!/^\d+(\.\d{1,7})?$/.test(s))throw Error('Invalid configured demo amount');const [w,f='']=s.split('.');return BigInt(w)*10000000n+BigInt(f.padEnd(7,'0'));};
function key(alias){try{return Keypair.fromSecret(execFileSync('stellar',['keys','secret',alias],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());}catch{throw Error(`Missing authorized CLI identity: ${alias}`);}}
async function read(id,method,args=[]) {
 const account=await server.getAccount(VIEW_ACCOUNT);
 const tx=new TransactionBuilder(account,{fee:BASE_FEE,networkPassphrase:passphrase}).addOperation(new Contract(id).call(method,...args)).setTimeout(60).build();
 const r=await server.simulateTransaction(tx);
 if(!rpc.Api.isSimulationSuccess(r)||!r.result)throw Error(`Read ${method} failed: ${r.error??'no result'}`);
 return scValToNative(r.result.retval);
}
async function confirm(hash){
 for(let i=0;i<30;i++) {const r=await server.getTransaction(hash);if(r.status==='SUCCESS')return r;if(r.status==='FAILED')throw Error(`Failed transaction ${hash}`);await new Promise(r=>setTimeout(r,1000));}
 throw Error(`Unconfirmed transaction ${hash}; rerun to reconcile, do not resubmit manually.`);
}
async function once(label,kp,operation,soroban=false) {
 if(state[label]?.done)return;
 if(!execute){console.log('Pending:',label);return;}
 if(state[label]?.hash) {
  if(soroban)await confirm(state[label].hash);else await horizon.transactions().transaction(state[label].hash).call();
  state[label].done=true;save();return;
 }
 const account=await server.getAccount(kp.publicKey());
 let tx=new TransactionBuilder(account,{fee:BASE_FEE,networkPassphrase:passphrase}).addOperation(operation).setTimeout(120).build();
 if(soroban)tx=await server.prepareTransaction(tx);
 tx.sign(kp);
 // Persist signed envelope before submission. On uncertainty stop; never blindly repeat mint/deposit.
 state[label]={hash:Buffer.from(tx.hash()).toString('hex'),xdr:tx.toXdr()};save();
 if(soroban){const sent=await server.sendTransaction(tx);if(sent.status==='ERROR')throw Error(`RPC rejected ${label}`);await confirm(sent.hash);}
 else await horizon.submitTransaction(tx);
 state[label]={hash:state[label].hash,done:true};save();console.log('Confirmed:',label,state[label].hash);
}
const call=(label,kp,id,method,args=[])=>once(`${id}:${label}`,kp,new Contract(id).call(method,...args),true);
async function fund(kp) {
 try{await server.getAccount(kp.publicKey());}catch{
  // Verify real not-found with Horizon; RPC wraps network errors as account-not-found.
  try{await horizon.loadAccount(kp.publicKey());return;}catch(h){if(!(h instanceof NotFoundError))throw h;}
  if(!execute){console.log('Pending Friendbot:',kp.publicKey());return;}
  await server.fundAddress(kp.publicKey());
 }
}
async function trust(kp,keyName) {
 const asset=ASSETS[keyName];const a=await horizon.loadAccount(kp.publicKey());
 if(a.balances.some(b=>b.asset_code===asset.code&&b.asset_issuer===asset.issuer))return;
 await once(`trust:${kp.publicKey()}:${keyName}`,kp,Operation.changeTrust({asset:new Asset(asset.code,asset.issuer)}));
}
async function deploy(name,file,args) {
 const wasmHash=createHash('sha256').update(readFileSync(file)).digest('hex');
 if(deployment[name]) {
  const instance=await server.getContractInstance(deployment[name]);
  if ('wasmHash' in instance.executable && Buffer.from(instance.executable.wasmHash.value).toString('hex')===wasmHash) return;
  throw Error(`${name} source differs from the existing deployment; automatic redeployment is disabled.`);
 }
 if(!execute){console.log('Pending isolated deployment:',name);return;}
 const salt=createHash('sha256').update(`rise-fx-v2-${name}-${ASSETS.TRY.issuer}-${wasmHash}`).digest('hex');
 const output=execFileSync('stellar',['contract','deploy','--wasm',file,'--optimize=false','--source','rise-deployer','--network','testnet','--salt',salt,'--',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 if(!/^C[A-Z2-7]{55}$/.test(output))throw Error(`Unexpected ${name} deployment response`);
 deployment[name]=output;savePublic();console.log('Deployed',name,output);
}
async function refreshSnapshot(){
 if(!execute) throw Error('Snapshot refresh requires --execute --demo-try.');
 const admin=key('rise-deployer');
  if(!process.argv.includes('--demo-try'))throw Error('TRY has no live feed. Explicit --demo-try is required for the synthetic snapshot.');
  const latest=await horizon.ledgers().order('desc').limit(1).call();
  const now=Math.floor(new Date(latest.records[0].closed_at).getTime()/1000);
  // Default to the Mock Anchor's USD/TRY so Send and Fund agree; RISE_DEMO_TRY_USD_14 overrides it.
  const price=BigInt(process.env.RISE_DEMO_TRY_USD_14??(await anchorRate()).usd14);
  // Use the oracle's demo TTL (24 h on the TTL oracle); the original oracle only allows 900 s.
  const ttl=await read(deployment.oracle,'max_ttl').then(Number,()=>900);
  await call(`snapshot:${now}`,admin,deployment.oracle,'set_price',[struct({price:i128(price),timestamp:nativeToScVal(BigInt(now),{type:'u64'})}),nativeToScVal(BigInt(now+ttl),{type:'u64'})]);
  state.snapshot={oracle:deployment.oracle,price:price.toString(),timestamp:now,expires:now+ttl};save();
}
async function depositMissingUsdc() {
 if(!execute)throw Error('Deposit-only requires --execute; inspect wallet funding first.');
 for(const [i,p] of PROVIDERS.entries()) {
  const label=`deposit:${i}:USD`, journal=state[`${deployment.router}:${label}`];
  if(journal?.done) {console.log('Already deposited; preserved journal:',p.name);continue;}
  const kp=key(`rise-lp${i+1}`);if(kp.publicKey()!==p.address)throw Error('LP identity mismatch');
  const a=ASSETS.USD;
  if(await read(a.contract,'name')!==`${a.code}:${a.issuer}`)throw Error('USDC issuer mismatch');
  const account=await horizon.loadAccount(p.address),b=account.balances.find(b=>b.asset_code===a.code&&b.asset_issuer===a.issuer);
  if(!b||units(b.balance)-units(b.selling_liabilities??'0')<units('2'))throw Error(`${p.name} ${p.address} needs 2 USDC in its wallet before deposit.`);
  const before=BigInt(await read(deployment.router,'get_balance',[addr(p.address),addr(a.contract)]));
  await call(label,kp,deployment.router,'deposit',[addr(p.address),addr(a.contract),i128(units('2'))]);
  const after=BigInt(await read(deployment.router,'get_balance',[addr(p.address),addr(a.contract)]));
  if(!journal && after-before!==units('2'))throw Error('Deposit inventory delta mismatch');
  console.log('Wallet funding → router inventory verified:',p.name,String(before),'→',String(after));
 }
}
async function main(){
 console.log(execute?'TESTNET EXECUTE':'TESTNET INSPECT');
 if((await server.getNetwork()).passphrase!==passphrase)throw Error('Not Stellar Testnet');
 if(process.argv.includes('--snapshot-only')) { await refreshSnapshot(); console.log('Synthetic TRY snapshot refreshed; no preparation or activation performed.'); return; }
 if(process.argv.includes('--deposit-only')) {await depositMissingUsdc();return;}
 const admin=key('rise-deployer');
 for(const k of ['USD','EUR']) {
  const a=ASSETS[k];if(await read(a.contract,'name')!==`${a.code}:${a.issuer}`||Number(await read(a.contract,'decimals'))!==7)throw Error(`${k} existing SAC identity mismatch`);
 }
 const [supported,base,decimals]=await Promise.all(['assets','base','decimals'].map(m=>read(REFLECTOR_ORACLE,m)));
 console.log('Reflector',json({supported,base,decimals}));
 if(json(base)!==json(['Other','USD'])||Number(decimals)!==14)throw Error('Unexpected oracle base/precision');
 for(const s of ['EUR','GBP','TRY']){
  const p=await read(REFLECTOR_ORACLE,'lastprice',[other(s)]);
  console.log('Oracle',s,json(p));
  if(s!=='TRY'&&(!p||p.price<=0n||Number(p.timestamp)>Date.now()/1000||Date.now()/1000-Number(p.timestamp)>900))throw Error(`${s} oracle missing/stale`);
 }
 const supply=units(process.env.RISE_DEMO_SUPPLY??'10000'),allocation=units(process.env.RISE_DEMO_ALLOCATION??'1000');
 if(supply<=0n||supply>units('1000000')||allocation<units('500')||allocation*3n>supply)throw Error('Demo supply must cover three allocations, at most 1,000,000 units; each LP allocation must cover 500 units.');
 const secrets=JSON.parse(readFileSync('work/fx-secrets.json'));chmodSync('work/fx-secrets.json',0o600);
 const issuer=Keypair.fromSecret(secrets.issuer),distribution=Keypair.fromSecret(secrets.distribution);
 if(issuer.publicKey()!==ASSETS.TRY.issuer||issuer.publicKey()!==ASSETS.GBP.issuer)throw Error('Persistent issuer mismatch; do not regenerate');
 const blockers=[];
 const lps=PROVIDERS.map((p,i)=>{const k=key(`rise-lp${i+1}`);if(k.publicKey()!==p.address)throw Error('LP key mismatch');return k;});
 const sender=key('rise-wallet-a'),recipient=key('rise-wallet-b');
 if(sender.publicKey()!==VIEW_ACCOUNT||recipient.publicKey()!==DEMO_RECIPIENT)throw Error('Demo wallet key mismatch');
 for(const kp of [issuer,distribution])await fund(kp);
 if(!execute)return;
 for(const c of ['TRY','GBP']){
  const a=ASSETS[c]; await trust(distribution,c);
  await once(`issue:${c}`,issuer,Operation.payment({destination:distribution.publicKey(),asset:new Asset(a.code,a.issuer),amount:process.env.RISE_DEMO_SUPPLY??'10000'}));
  try{await server.getContractInstance(a.contract);}catch{
   const output=execFileSync('stellar',['contract','asset','deploy','--asset',`${a.code}:${a.issuer}`,'--source','rise-deployer','--network','testnet'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
   if(output!==a.contract)throw Error('SAC deployment identity mismatch');
  }
  for(const kp of [...lps,sender,recipient])await trust(kp,c);
  for(const kp of [...lps,sender])await once(`distribute:${c}:${kp.publicKey()}`,distribution,Operation.payment({destination:kp.publicKey(),asset:new Asset(a.code,a.issuer),amount:process.env.RISE_DEMO_ALLOCATION??'1000'}));
 }
 await deploy('router','soroban/target/wasm32v1-none/release/fx_router.wasm',['--admin',admin.publicKey(),'--max_price_age','900']);
 await deploy('oracle','soroban/target/wasm32v1-none/release/demo_oracle.wasm',['--admin',admin.publicKey()]);
 if(state.snapshot?.oracle!==deployment.oracle||process.argv.includes('--refresh-snapshot')) await refreshSnapshot();
 for(const [c,a] of Object.entries(ASSETS)) {
  const config=struct({enabled:nativeToScVal(true),is_oracle_base:nativeToScVal(c==='USD'),oracle:addr(c==='TRY'?deployment.oracle:REFLECTOR_ORACLE),oracle_asset:other(c),oracle_base:sym('USD'),token_decimals:nativeToScVal(7,{type:'u32'})});
  if(json(await read(deployment.router,'get_asset',[addr(a.contract)]))===json(scValToNative(config)))continue;
  await call(`asset:${c}:${c==='TRY'?deployment.oracle:REFLECTOR_ORACLE}`,admin,deployment.router,'set_asset',[addr(a.contract),config]);
 }
 await call('hub',admin,deployment.router,'set_hub',[addr(ASSETS.USD.contract)]);
 for(const [i,kp] of lps.entries()){
  await call(`register:${i}`,kp,deployment.router,'register_provider',[addr(kp.publicKey())]);
  for(const [s,t] of [['USD','EUR'],['EUR','USD'],['USD','TRY'],['TRY','USD'],['USD','GBP'],['GBP','USD'],...(i===1?[['TRY','GBP'],['GBP','TRY']]:[])]){
   const direct=s!=='USD'&&t!=='USD';
   await call(`pair:${i}:${s}:${t}`,kp,deployment.router,'set_provider_pair',[addr(kp.publicKey()),addr(ASSETS[s].contract),addr(ASSETS[t].contract),struct({active:nativeToScVal(true),fee_bps:nativeToScVal(direct?100:i===0?20:30,{type:'u32'}),max_amount_in:i128(direct?0:units(s==='TRY'?'40':'10')),max_source_inventory:i128(0)})]);
  }
  for(const [c,a] of Object.entries(ASSETS)) {
   const amount=units(c==='USD'||c==='EUR'?(process.env.RISE_FX_LP_RESERVE??'2'):'500');
   if(state[`${deployment.router}:deposit:${i}:${c}`]?.done)continue;
   const account=await horizon.loadAccount(kp.publicKey());const b=account.balances.find(b=>b.asset_code===a.code&&b.asset_issuer===a.issuer);
   if(!b||units(b.balance)-units(b.selling_liabilities??'0')<amount){blockers.push(`${PROVIDERS[i].name} (${kp.publicKey()}) needs ${amount} stroops of ${a.code} outside the old router. Fund this demo LP via the legitimate issuer faucet, then rerun.`);continue;}
   await call(`deposit:${i}:${c}`,kp,deployment.router,'deposit',[addr(kp.publicKey()),addr(a.contract),i128(amount)]);
  }
 }
 if(blockers.length)throw Error(blockers.join('\n'));
 for(const [s,t,n,hops] of [['TRY','GBP','20',2],['TRY','GBP','60',1],['USD','EUR','1',1]]){
  const quote=await read(deployment.router,'quote_route',[addr(ASSETS[s].contract),addr(ASSETS[t].contract),i128(units(n))]);
  if(quote.hops.length!==hops)throw Error(`${s} → ${t} (${n}) did not select the expected demo scenario; activation withheld.`);
  console.log('Verified quote',s,t,n,json(quote));
 }
 for(const s of Object.keys(ASSETS))for(const t of Object.keys(ASSETS))if(s!==t)await read(deployment.router,'quote_route',[addr(ASSETS[s].contract),addr(ASSETS[t].contract),i128(units('0.1'))]);
 deployment.routerWasmHash=createHash('sha256').update(readFileSync('soroban/target/wasm32v1-none/release/fx_router.wasm')).digest('hex');
 deployment.ready=false;savePublic();console.log('Preparation complete; run fx-verify.mjs --execute --activate to verify settlement before enabling v2.');
}
export { read, call, once, key, struct, other, addr, i128, state, save, server, horizon, deployment, savePublic };
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e instanceof Error?e.message:'Bootstrap failed');process.exitCode=1;});
