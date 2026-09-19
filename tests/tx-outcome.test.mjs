import assert from 'node:assert/strict';
import test from 'node:test';
import {provedNeverApplied} from '../lib/tx-outcome.ts';
test('an unresolved hash is closed only when the network proves it can no longer and never did execute',()=>{
 const t={hash:'a'.repeat(64),maxTime:1000,afterLedger:500};
 const proven={status:'NOT_FOUND',latestLedgerCloseTime:1001,oldestLedger:501};
 assert.equal(provedNeverApplied(t,proven),true);
 for(const [why,tracking,lookup] of [
  ['still inside its time bounds',t,{...proven,latestLedgerCloseTime:1000}],
  ['history starts after the first ledger it could enter',t,{...proven,oldestLedger:502}],
  ['found in a ledger',t,{...proven,status:'SUCCESS'}],
  ['failed in a ledger',t,{...proven,status:'FAILED'}],
  ['reply without network times',t,{status:'NOT_FOUND'}],
  ['older record without expiry data',{hash:t.hash},proven],
  ['no signing ledger',{hash:t.hash,maxTime:1000},proven],
  ['unbounded envelope (maxTime 0)',{...t,maxTime:0},proven],
  ['corrupt metadata',{...t,maxTime:1.5},proven],
 ]) assert.equal(provedNeverApplied(tracking,lookup),false,why);
});
