import assert from 'node:assert/strict';
import test from 'node:test';
import {assertVerified} from '../scripts/fx-verify.mjs';
test('activation rejects missing, failed or skipped quotes/executions',()=>{
 const report={router:'router',quotes:[],executions:[]};
 assert.throws(()=>assertVerified(report));
 report.quotes=['USD','EUR','GBP','TRY'].flatMap(source=>['USD','EUR','GBP','TRY'].filter(t=>t!==source).map(target=>({source,target,quote:{amount_out:1n}})));
 assert.throws(()=>assertVerified(report));
 report.executions=[{verified:true,hash:'a'.repeat(64),actual:{amount_in:'200000000',hops:[{},{}]}},{verified:true,hash:'b'.repeat(64),actual:{amount_in:'600000000',hops:[{}]}}];
 assert.doesNotThrow(()=>assertVerified(report));
 for(const bad of [{submitted:false},{blocked:'no liquidity'},{verified:false}]) {const copy=structuredClone(report);Object.assign(copy.executions[0],bad);assert.throws(()=>assertVerified(copy));}
 report.quotes[0].error='NoLiquidity';assert.throws(()=>assertVerified(report));
});
