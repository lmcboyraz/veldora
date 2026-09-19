import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Horizon} from '@stellar/stellar-sdk';
const root=new URL('../',import.meta.url);
registerHooks({
 resolve(specifier,context,next){
  if(specifier.startsWith('@/'))specifier=new URL(specifier.slice(2),root).href;
  if((specifier.startsWith('.')||specifier.startsWith('file:'))&&context.parentURL){
   const url=new URL(specifier,context.parentURL);
   for(const ext of ['.ts','.tsx'])if(existsSync(fileURLToPath(url)+ext))return next(url.href+ext,context);
  }
  return next(specifier,context);
 },
 load(url,context,next){
  if(url.endsWith('.tsx'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext}}).outputText};
  return next(url,context);
 }
});
const {ASSETS}=await import('../lib/config.ts');
const {CurrencySelector}=await import('../components/currency-selector.tsx');
const {checkTrustline,getWalletBalances,getWalletHoldings}=await import('../lib/trustline.ts');
test('each currency can remain selected with zero balance and an accessible trigger',()=>{
 for(const key of Object.keys(ASSETS)){
  const html=renderToStaticMarkup(React.createElement(CurrencySelector,{value:key,onChange:()=>{},label:'You send currency',balances:{USD:0n,EUR:0n,GBP:0n,TRY:0n}}));
  assert.match(html,/role="combobox"/);assert.match(html,/aria-label="You send currency"/);assert.match(html,new RegExp(`>${key}<`));assert.match(html,/min-h-12/);
 }
});
test('trustline and spendable balances use issuer identity, authorization, capacity and liabilities',async()=>{
 const original=Object.getOwnPropertyDescriptor(Horizon.Server.prototype,'loadAccount').value;
 const account='G'+'A'.repeat(55);
 const line=(key,balance,extra={})=>({asset_type:'credit_alphanum4',asset_code:ASSETS[key].code,asset_issuer:ASSETS[key].issuer,balance,selling_liabilities:'0.5000000',buying_liabilities:'0.0000000',limit:'10.0000000',is_authorized:true,...extra});
 Horizon.Server.prototype.loadAccount=async()=>({balances:[line('USD','3.0000000'),line('GBP','2.0000000'),line('TRY','9.0000000',{asset_issuer:ASSETS.USD.issuer})]});
 try {
  assert.deepEqual(await getWalletBalances(account),{USD:25000000n,EUR:0n,GBP:15000000n,TRY:0n});
  // Same code with another issuer is a different asset: it counts as no trustline, not as a balance.
  assert.deepEqual(await getWalletHoldings(account),{USD:25000000n,EUR:null,GBP:15000000n,TRY:null});
  assert.equal((await checkTrustline(account,'TRY')).state,'missing');
  assert.equal((await checkTrustline(account,'GBP',90000000n)).state,'blocked');
  assert.equal((await checkTrustline(account,'GBP',10000000n)).state,'present');
  assert.equal((await checkTrustline('C'+'A'.repeat(55),'USD')).state,'not-required');
  Horizon.Server.prototype.loadAccount=async()=>({balances:[line('GBP','2.0000000',{is_authorized:false})]});
  assert.equal((await checkTrustline(account,'GBP')).state,'blocked');
  assert.equal((await getWalletBalances(account)).GBP,0n);
 } finally {Horizon.Server.prototype.loadAccount=original;}
});
