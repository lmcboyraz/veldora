import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {Account,Address,rpc,nativeToScVal,scValToNative} from '@stellar/stellar-sdk';
const data=s=>'data:text/javascript,'+encodeURIComponent(s);
registerHooks({resolve(s,c,next){
 if(s==='./wallet'&&c.parentURL?.includes('/lib/'))return {url:data('export async function signTransactionXdr(x){return x};'),shortCircuit:true};
 if(c.parentURL?.includes('/lib/')&&s.startsWith('./')&&!/\.(ts|json)$/.test(s))return next(s+'.ts',c);
 return next(s,c);
}});
const config=await import('../lib/config.ts');
const {getQuote}=await import('../lib/stellar.ts');
const {anchorRate}=await import('../scripts/try-price-keeper.mjs');
const now=1_800_000_000;
let snapshot=null;
const calls=[];
const ok=value=>({_parsed:true,id:'t',latestLedger:1,transactionData:{},minResourceFee:'1',result:{auth:[],retval:nativeToScVal(value)}});
rpc.Server.prototype.getAccount=async address=>new Account(address,'1');
rpc.Server.prototype.simulateTransaction=async tx=>{
 const fn=tx.operations[0].func.invokeContract,method=fn.functionName.toString(),args=fn.args.map(scValToNative);
 calls.push({contract:Address.fromScAddress(fn.contractAddress).toString(),method});
 // The TTL oracle reports the read time to the router, so hop timestamps are current.
 if(method==='quote_route'){const hop={provider:config.PROVIDERS[0].address,amount_in:args[2],gross_amount_out:1000n,amount_out:998n,fee_amount:2n,fee_bps:20,source_price:1n,target_price:1n,source_oracle_timestamp:BigInt(now),target_oracle_timestamp:BigInt(now)};return ok({path:[args[0],args[1]],hops:[hop],amount_in:args[2],amount_out:998n});}
 if(method==='get_max_price_age')return ok(900);
 if(method==='get_asset'){const a=Object.values(config.ASSETS).find(a=>a.contract===args[0]);return ok({enabled:true,is_oracle_base:a.currency==='USD',oracle:a.oracle,oracle_base:'USD',token_decimals:7,oracle_asset:['Other',a.oracleSymbol]});}
 if(method==='snapshot')return snapshot?ok(snapshot):{error:'HostError: Error(WasmVm, MissingValue) non-existent contract function'};
 throw Error('Unexpected RPC method '+method);
};
const originalNow=Date.now;
test.before(()=>{Date.now=()=>now*1000;});
test.after(()=>{Date.now=originalNow;});
test('TRY quotes show when the demo/mock price was really set and cannot outlive its snapshot',async()=>{
 snapshot={price:2_057_717_621_180n,timestamp:BigInt(now-6*3600),expires:BigInt(now+60)};calls.length=0;
 const q=await getQuote(config.VIEW_ACCOUNT,'TRY','USD',10_000_000n);
 assert.deepEqual(q.demoFeed,{setAt:now-6*3600,expires:now+60});
 assert.equal(q.validUntil,now+60);
 assert.equal(q.demo,true);
 assert.ok(calls.some(c=>c.method==='snapshot'&&c.contract===config.ASSETS.TRY.oracle));
 calls.length=0;
 const live=await getQuote(config.VIEW_ACCOUNT,'USD','EUR',10_000_000n);
 assert.equal(live.demoFeed,null);assert.equal(live.demo,false);assert.equal(live.validUntil,now+180);
 assert.ok(!calls.some(c=>c.method==='snapshot'));
});
test('the original demo oracle without snapshot() keeps quoting with the hop timestamps',async()=>{
 snapshot=null;
 const q=await getQuote(config.VIEW_ACCOUNT,'USD','TRY',10_000_000n);
 assert.equal(q.demoFeed,null);assert.equal(q.demo,true);assert.equal(q.validUntil,now+180);
});
test('keeper converts the Mock Anchor TRY-per-USDC price into the oracle 14-decimal USD price',async()=>{
 const reply=(price,ok=true)=>async()=>({ok,json:async()=>({price})});
 assert.deepEqual(await anchorRate(reply('48.597533')),{price:'48.597533',usd14:2_057_717_621_180n});
 assert.deepEqual(await anchorRate(reply('40')),{price:'40',usd14:2_500_000_000_000n});
 for(const bad of ['5','600','abc',undefined])await assert.rejects(anchorRate(reply(bad)));
 await assert.rejects(anchorRate(reply('48.5',false)));
});
