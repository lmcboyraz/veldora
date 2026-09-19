import assert from 'node:assert/strict';
import test from 'node:test';
import { liquidityMoveBlocker, parseLiquidityAmount, parsePairInput } from '../lib/liquidity-input.ts';
await test('liquidity amounts reject truncation, negatives and i128 overflow', () => {
 for (const value of ['0', '-1', '1.00000001', 'NaN', '170141183460469231731687303715885']) assert.throws(() => parseLiquidityAmount(value));
 assert.equal(parseLiquidityAmount('0.0000001'), 1n);
});
await test('pair limits allow exact zero and fees respect contract bounds', () => {
 assert.deepEqual(parsePairInput('20', '3', '10', true), { active: true, fee_bps: 20, max_amount_in: 30000000n, max_source_inventory: 100000000n });
 assert.equal(parsePairInput('0', '0', '0', false).max_amount_in, 0n);
 for(const fee of ['-1', '1001', '2.5', '']) assert.throws(() => parsePairInput(fee, '3', '10', true));
 assert.throws(() => parsePairInput('20', '-1', '10', true));
});
await test('LP moves are blocked by trustline, wallet balance (deposit) and router inventory (withdraw)', () => {
 assert.match(liquidityMoveBlocker('deposit', 'rTRY', 50000000n, null, 0n), /no rTRY trustline/);
 assert.match(liquidityMoveBlocker('deposit', 'rTRY', 50000000n, 49999999n, 0n), /holds 4.9999999 rTRY/);
 assert.equal(liquidityMoveBlocker('deposit', 'rTRY', 50000000n, 50000000n, 0n), null);
 assert.match(liquidityMoveBlocker('withdraw', 'rTRY', 50000001n, 0n, 50000000n), /inventory is 5 rTRY/);
 assert.equal(liquidityMoveBlocker('withdraw', 'rTRY', 50000000n, 0n, 50000000n), null);
});
