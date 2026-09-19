import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {NETWORK_PASSPHRASE,VIEW_ACCOUNT} from '../lib/config.ts';

// Wallet adapter contract tests only; no browser wallet, signature or chain submission.
const kit={
 init(options){assert.equal(options.network,NETWORK_PASSPHRASE);},
 authModal:async()=>({address:VIEW_ACCOUNT}),
 getNetwork:async()=>({networkPassphrase:NETWORK_PASSPHRASE}),
 selectedModule:{productId:'freighter'},
 fetchAddress:async()=>({address:VIEW_ACCOUNT}),
};
globalThis.__walletKit=kit;
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/lib/wallet.ts')){
  let source;
  if(specifier==='@creit.tech/stellar-wallets-kit')source=`export const StellarWalletsKit=globalThis.__walletKit;export const Networks={TESTNET:${JSON.stringify(NETWORK_PASSPHRASE)}};`;
  else if(specifier.startsWith('@creit.tech/stellar-wallets-kit/modules/'))source='export class FreighterModule{};export class xBullModule{};export class AlbedoModule{};export class RabetModule{};export class LobstrModule{};export class HanaModule{};';
  if(source)return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
  if(specifier==='./config')return next(new URL('../lib/config.ts',import.meta.url).href,context);
 }
 return next(specifier,context);
}});
const {connectWallet,assertAnchorWallet,signTransactionXdr}=await import('../lib/wallet.ts');

test('wallet rejects a known wrong network and a changed account before Anchor authorization',async()=>{
 globalThis.window={};
 try {
  kit.getNetwork=async()=>({networkPassphrase:'Public Global Stellar Network ; September 2015'});
  await assert.rejects(connectWallet(),/Switch your wallet to Stellar Testnet/);
  await assert.rejects(assertAnchorWallet(VIEW_ACCOUNT),/Stellar Testnet/);
  kit.getNetwork=async()=>({networkPassphrase:NETWORK_PASSPHRASE});
  assert.equal(await connectWallet(),VIEW_ACCOUNT);
  kit.fetchAddress=async()=>({address:'different account'});
  await assert.rejects(assertAnchorWallet(VIEW_ACCOUNT),/Wallet changed/);
 } finally {kit.fetchAddress=async()=>({address:VIEW_ACCOUNT});delete globalThis.window;}
});

test('signature rejection or missing signed envelope never returns a transaction',async()=>{
 globalThis.window={};
 try {
  kit.signTransaction=async(xdr,options)=>{
   assert.equal(options.address,VIEW_ACCOUNT);assert.equal(options.networkPassphrase,NETWORK_PASSPHRASE);
   throw {code:4001,message:'User declined signature'};
  };
  await assert.rejects(signTransactionXdr('unsigned test fixture',VIEW_ACCOUNT),/User declined signature/);
  kit.signTransaction=async()=>({});
  await assert.rejects(signTransactionXdr('unsigned test fixture',VIEW_ACCOUNT),/signature was rejected/);
 } finally {delete globalThis.window;}
});
