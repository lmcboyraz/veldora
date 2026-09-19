#!/usr/bin/env node
// Moves idle demo USDC/EURC into the active router's LP inventory, at most 100 of each.
// --consolidate first returns the retired v1 router's LP inventory and LP-3's funds to
// LP-1/LP-2, and sweeps the demo recipient's EURC above a 2 EURC reserve.
// Inspect by default; --execute signs with the rise-* CLI identities. Amounts are re-read
// live at every step, so rerunning after a faucet request only deposits what is idle.
import {Address,Asset,Operation,nativeToScVal} from '@stellar/stellar-sdk';
import {ASSETS,PROVIDERS,DEMO_RECIPIENT} from '../lib/config.ts';
import {read,call,once,key,horizon,deployment} from './fx-bootstrap.mjs';

const execute=process.argv.includes('--execute'), consolidate=process.argv.includes('--consolidate');
const RETIRED_ROUTER=deployment.previous.find(p=>p.name==='router-v1-permissionless-usdc-eurc').address;
const CAP=1_000_000_000n, RESERVE=20_000_000n;
const coins={USDC:ASSETS.USD,EURC:ASSETS.EUR};
const run=Date.now();
const addr=s=>Address.fromString(s).toScVal(), i128=n=>nativeToScVal(n,{type:'i128'});
const units=s=>{const [w,f='']=s.split('.');return BigInt(w)*10_000_000n+BigInt(f.padEnd(7,'0'));};
const show=n=>`${n/10_000_000n}.${String(n%10_000_000n).padStart(7,'0')}`;
const lp1=key('rise-lp1'), lp2=key('rise-lp2');
if(lp1.publicKey()!==PROVIDERS[0].address||lp2.publicKey()!==PROVIDERS[1].address)throw Error('LP identity mismatch');
const name=kp=>kp===lp1?'LP-1':kp===lp2?'LP-2':kp.publicKey().slice(0,6);

/** Spendable classic balance; null when the account has no trustline. */
async function wallet(account,asset){
 const b=(await horizon.loadAccount(account)).balances.find(b=>b.asset_code===asset.code&&b.asset_issuer===asset.issuer);
 return b?units(b.balance)-units(b.selling_liabilities):null;
}
const inventory=async(router,provider,asset)=>BigInt(await read(router,'get_balance',[addr(provider),addr(asset.contract)]));
async function pay(label,from,to,asset,amount){
 console.log(`pay ${show(amount)} ${asset.code}: ${name(from)} → ${to.slice(0,6)}`);
 await once(`topup:${run}:${label}`,from,Operation.payment({destination:to,asset:new Asset(asset.code,asset.issuer),amount:show(amount)}));
}

async function consolidateFunds(){
 const lp3=key('rise-lp3-permissionless'), recipient=key('rise-wallet-b');
 if(recipient.publicKey()!==DEMO_RECIPIENT)throw Error('Demo recipient identity mismatch');
 for(const kp of [lp1,lp2,lp3])for(const [code,asset] of Object.entries(coins)){
  const amount=await inventory(RETIRED_ROUTER,kp.publicKey(),asset);
  if(amount<=0n)continue;
  // A SAC transfer to a classic account needs its trustline first.
  if(await wallet(kp.publicKey(),asset)===null)await once(`topup:${run}:trust:${kp.publicKey()}:${code}`,kp,Operation.changeTrust({asset:new Asset(asset.code,asset.issuer)}));
  console.log(`withdraw ${show(amount)} ${code} from retired v1 router: ${name(kp)}`);
  await call(`topup:${run}:v1-withdraw:${kp.publicKey()}:${code}`,kp,RETIRED_ROUTER,'withdraw',[addr(kp.publicKey()),addr(asset.contract),i128(amount)]);
 }
 // LP-3 is not a provider on the active router: its funds go to LP-1.
 for(const [code,asset] of Object.entries(coins)){
  const amount=await wallet(lp3.publicKey(),asset);
  if(amount>0n)await pay(`lp3:${code}`,lp3,lp1.publicKey(),asset,amount);
 }
 const eurc=await wallet(recipient.publicKey(),coins.EURC);
 if(eurc>RESERVE)await pay('recipient:EURC',recipient,lp2.publicKey(),coins.EURC,eurc-RESERVE);
}

async function depositIdle(){
 const providers=await read(deployment.router,'get_providers');
 for(const [code,asset] of Object.entries(coins)){
  let total=0n;
  for(const p of providers)total+=await inventory(deployment.router,p,asset);
  for(const kp of [lp1,lp2]){
   const idle=await wallet(kp.publicKey(),asset)??0n, amount=idle<CAP-total?idle:CAP-total;
   if(amount<=0n)continue;
   console.log(`deposit ${show(amount)} ${code} into active router: ${name(kp)}`);
   await call(`topup:${run}:deposit:${kp.publicKey()}:${code}`,kp,deployment.router,'deposit',[addr(kp.publicKey()),addr(asset.contract),i128(amount)]);
   if(execute)total+=amount;
  }
  console.log(`${code} active router inventory ${execute?'now':'before'}: ${show(total)} (cap ${show(CAP)})`);
 }
}

console.log(execute?'TESTNET EXECUTE':'TESTNET INSPECT (amounts are re-read at execution)',consolidate?'with consolidation':'');
if(consolidate)await consolidateFunds();
await depositIdle();
