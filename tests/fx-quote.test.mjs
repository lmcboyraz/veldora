import assert from 'node:assert/strict';
import test from 'node:test';
import {parseUnits,quoteKey,isCurrentQuote,decodeRoute} from '../lib/fx-quote.ts';
test('money precision and overflow never silently truncate',()=>{
 assert.equal(parseUnits('1.0000001'),10000001n);
 for(const s of ['1.00000001','-1','Infinity','170141183460469231731687303715885'])assert.equal(parseUnits(s),0n);
});
test('old selection, router or amount responses cannot enable send',()=>{
 const key=quoteKey('r1','a','TRY','GBP',100n);
 assert.equal(isCurrentQuote({requestKey:key,validUntil:200},key,199),true);
 for(const next of [quoteKey('r2','a','TRY','GBP',100n),quoteKey('r1','a','USD','GBP',100n),quoteKey('r1','a','TRY','GBP',101n)])assert.equal(isCurrentQuote({requestKey:key,validUntil:200},next,199),false);
 assert.equal(isCurrentQuote({requestKey:key,validUntil:200},key,201),false);
});
test('route decoder preserves hop fee units, actual second input and oracle timestamp',()=>{
 const hop={provider:'lp',amount_in:100n,gross_amount_out:50n,amount_out:49n,fee_amount:1n,fee_bps:200,source_price:10n,target_price:20n,source_oracle_timestamp:100,target_oracle_timestamp:110};
 const q=decodeRoute({path:['TRY','USD','GBP'],hops:[hop,{...hop,amount_in:49n,amount_out:24n}],amount_in:100n,amount_out:24n});
 assert.equal(q.hops[1].amountIn,49n);assert.equal(q.amountOut,24n);assert.equal(q.hops[0].feeAmount,1n);
});

test('amount field explains why an entry cannot be quoted instead of silently using zero', async () => {
  const { amountInputError, parseUnits } = await import('../lib/fx-quote.ts');
  for (const valid of ['', '1', '6.', '6,5', ' 12.5 ', '0.0000001', '1.1234567']) assert.equal(amountInputError(valid), null, valid);
  for (const [value, message] of [
    ['abc', 'Use digits and one decimal point, e.g. 12.5.'], ['1a', 'Use digits and one decimal point, e.g. 12.5.'],
    ['-1', 'Use digits and one decimal point, e.g. 12.5.'], ['1.2.3', 'Use digits and one decimal point, e.g. 12.5.'],
    ['.5', 'Use digits and one decimal point, e.g. 12.5.'], ['1.12345678', 'Use at most 7 decimal places.'],
    ['0', 'Enter an amount greater than 0.'], ['0.0000000', 'Enter an amount greater than 0.'],
    ['9'.repeat(40), 'Amount is too large.'],
  ]) { assert.equal(amountInputError(value), message, value); assert.equal(parseUnits(value), 0n, value); }
});
