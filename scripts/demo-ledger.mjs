// Read-only view of the ledger entries and routes the live FX demo depends on, shared by
// demo-preflight.mjs and extend-ttl.mjs. Nothing here signs, submits or reads secrets.
import {Address,BASE_FEE,Contract,Networks,TransactionBuilder,nativeToScVal,rpc,scValToNative,xdr} from '@stellar/stellar-sdk';
import {ASSETS,FX_ROUTER,RPC_URL,VIEW_ACCOUNT,DEMO_RECIPIENT,REFLECTOR_ORACLE} from '../lib/config.ts';
import deployment from '../lib/fx-testnet.json' with {type:'json'};

export {deployment};
export const server=new rpc.Server(RPC_URL);
export const LEDGERS_PER_DAY=17_280;
export const addr=s=>Address.fromString(s).toScVal(), i128=n=>nativeToScVal(n,{type:'i128'});
export const b64=k=>k.toXDR('base64');
export const names={[FX_ROUTER]:'router',[deployment.oracle]:'TRY oracle',[REFLECTOR_ORACLE]:'Reflector',
 [ASSETS.USD.contract]:'USDC SAC',[ASSETS.EUR.contract]:'EURC SAC',[ASSETS.GBP.contract]:'rGBP SAC',[ASSETS.TRY.contract]:'rTRY SAC'};
export const short=s=>names[s]??(/^[GC][A-Z2-7]{55}$/.test(s)?`${s.slice(0,4)}…${s.slice(-4)}`:s);
export const assetName=s=>Object.values(ASSETS).find(a=>a.contract===s)?.code??short(s);

/** Simulates one operation; an entry that must be restored first counts as a failure. */
export async function simulate(source,op,data){
 let b=new TransactionBuilder(await server.getAccount(source),{fee:BASE_FEE,networkPassphrase:Networks.TESTNET}).addOperation(op).setTimeout(120);
 if(data)b=b.setSorobanData(data);
 const tx=b.build(), sim=await server.simulateTransaction(tx);
 if(!rpc.Api.isSimulationSuccess(sim))throw Object.assign(Error(String(sim.error).split('\n')[0]),{simulationError:String(sim.error)});
 if(rpc.Api.isSimulationRestore(sim))throw Object.assign(Error('A required entry is archived and must be restored first.'),{restore:true});
 return {tx,sim};
}
export const read=async(contract,method,args=[])=>scValToNative((await simulate(VIEW_ACCOUNT,new Contract(contract).call(method,...args))).sim.result.retval);
const footprintOf=sim=>{const fp=sim.transactionData.build().resources.footprint;return [...fp.readOnly,...fp.readWrite];};
const dataKey=(contract,k)=>xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({contract:Address.fromString(contract).toScAddress(),key:k,durability:xdr.ContractDataDurability.persistent}));
const vec=(...items)=>xdr.ScVal.scvVec(items);
const sym=s=>xdr.ScVal.scvSymbol(s);

/**
 * Every ledger key the demo needs: the exact footprints of quote_route and transfer_route for
 * all 12 directions, every router Asset/Pair/Balance/Fees entry for every provider, the router's
 * custody balance in each asset contract, and the instance and wasm code of each contract.
 */
export async function requiredKeys(){
 const keys=new Map(), add=k=>keys.set(b64(k),k), warnings=[];
 const coins=Object.keys(ASSETS);
 for(const s of coins)for(const t of coins)if(s!==t){
  const args=[addr(ASSETS[s].contract),addr(ASSETS[t].contract),i128(10_000_000n)];
  footprintOf((await simulate(VIEW_ACCOUNT,new Contract(FX_ROUTER).call('quote_route',...args))).sim).forEach(add);
  // The demo sender holds no whole EURC, so the recipient demo wallet sends EURC routes.
  const [from,to]=s==='EUR'?[DEMO_RECIPIENT,VIEW_ACCOUNT]:[VIEW_ACCOUNT,DEMO_RECIPIENT];
  const transfer=new Contract(FX_ROUTER).call('transfer_route',addr(from),addr(to),...args,i128(0n),nativeToScVal(BigInt(Math.floor(Date.now()/1000)+600),{type:'u64'}));
  try{footprintOf((await simulate(from,transfer)).sim).forEach(add);}
  catch(error){if(error.restore)throw error;warnings.push(`${s}→${t} settlement footprint skipped (${error.message}); covered by explicit keys.`);}
 }
 const providers=await read(FX_ROUTER,'get_providers');
 for(const a of Object.values(ASSETS)){
  add(dataKey(FX_ROUTER,vec(sym('Asset'),addr(a.contract))));
  add(dataKey(a.contract,vec(sym('Balance'),addr(FX_ROUTER))));
 }
 for(const p of providers)for(const a of Object.values(ASSETS)){
  for(const kind of ['Balance','Fees'])add(dataKey(FX_ROUTER,vec(sym(kind),addr(p),addr(a.contract))));
  for(const b of Object.values(ASSETS))if(a!==b)add(dataKey(FX_ROUTER,vec(sym('Pair'),addr(p),addr(a.contract),addr(b.contract))));
 }
 const codeOwners={};
 for(const c of Object.keys(names)){
  add(dataKey(c,xdr.ScVal.scvLedgerKeyContractInstance()));
  const exe=(await server.getContractInstance(c)).executable;
  // Stellar Asset Contracts are built in and have no wasm code entry.
  if('wasmHash' in exe&&exe.wasmHash){const hash=Buffer.from(exe.wasmHash.value??exe.wasmHash);codeOwners[c]=hash.toString('hex');add(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({hash})));}
 }
 return {keys,codeOwners,providers,warnings};
}

// SDK v17 XDR unions expose the arm name as `type` and the arm as `value`.
export function describe(k,codeOwners){
 if(k.type==='contractCode')return `${Object.entries(codeOwners).filter(([,h])=>h===Buffer.from(k.value.hash.value??k.value.hash).toString('hex')).map(([c])=>short(c)).join('+')||'contract'} wasm code`;
 if(k.type!=='contractData')return `${k.type} (classic, no TTL)`;
 const cd=k.value, c=Address.fromScAddress(cd.contract).toString();
 if(cd.key.type==='scvLedgerKeyContractInstance')return `${short(c)} instance`;
 const v=scValToNative(cd.key), parts=Array.isArray(v)?v:[v];
 return `${short(c)} ${cd.durability.name} ${parts.map((p,i)=>i===0?p:assetName(String(p))).join(',')}`;
}

/** Current live-until ledger of each key; absent keys were never written. */
export async function readEntries({keys,codeOwners}){
 const latest=(await server.getLatestLedger()).sequence, all=[...keys.values()], rows=[];
 for(let i=0;i<all.length;i+=200){
  const chunk=all.slice(i,i+200), res=await server.getLedgerEntries(...chunk);
  const found=new Map(res.entries.map(e=>[b64(e.key),e]));
  for(const k of chunk){
   const e=found.get(b64(k));
   const durability=k.type==='contractData'?k.value.durability.name:k.type==='contractCode'?'code':'classic';
   rows.push({key:k,label:describe(k,codeOwners),present:!!e,live:e?.liveUntilLedgerSeq,bytes:e?b64(e.val).length*3/4:0,durability});
  }
 }
 return {latest,rows};
}
export const ledgerDate=(ledger,latest)=>new Date(Date.now()+(ledger-latest)*5000).toISOString().slice(0,16).replace('T',' ')+' UTC';
