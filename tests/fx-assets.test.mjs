import test from 'node:test';
import assert from 'node:assert/strict';
import { Asset, Networks } from '@stellar/stellar-sdk';
import { ASSETS } from '../lib/config.ts';
test('four currency labels identify four distinct classic assets and SACs',()=>{
 assert.deepEqual(Object.keys(ASSETS).sort(),['EUR','GBP','TRY','USD']);
 assert.equal(new Set(Object.values(ASSETS).map(a=>a.contract)).size,4);
 for(const [key,a] of Object.entries(ASSETS)) {
  assert.equal(a.currency,key); assert.equal(a.decimals,7); assert.equal(a.network,'testnet');
  assert.equal(new Asset(a.code,a.issuer).contractId(Networks.TESTNET),a.contract);
 }
 assert.equal(ASSETS.USD.code,'USDC'); assert.equal(ASSETS.EUR.code,'EURC');
 assert.equal(ASSETS.TRY.code,'rTRY'); assert.equal(ASSETS.GBP.code,'rGBP');
 assert.equal(ASSETS.TRY.demo,true); assert.equal(ASSETS.GBP.demo,true);
});
