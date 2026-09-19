/** What a saved transaction needs to be looked up, and possibly closed, after a lost reply or a reload. */
export type TxTracking = {
  hash: string;
  /** The signed envelope's timeBounds.maxTime: no ledger closing after it can include the envelope. */
  maxTime?: number;
  /** A network ledger read before signing: the envelope cannot be in this ledger or any earlier one. */
  afterLedger?: number;
};

export type TxLookup = { status: string; latestLedgerCloseTime?: number | string; oldestLedger?: number | string };

export const validTracking = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);

/**
 * True only when the network's own reply proves the envelope never executed: it can no longer be
 * included (the latest ledger closed after maxTime) AND it was never included (NOT_FOUND across a
 * history window that starts no later than the first ledger it could have entered). A client
 * timeout, a single NOT_FOUND or a record without metadata never qualifies.
 */
export function provedNeverApplied(tracking: TxTracking, lookup: TxLookup) {
  const { maxTime, afterLedger } = tracking;
  if (lookup.status !== 'NOT_FOUND' || !maxTime || !afterLedger || !validTracking(maxTime) || !validTracking(afterLedger)) return false;
  const closed = Number(lookup.latestLedgerCloseTime), oldest = Number(lookup.oldestLedger);
  return Number.isFinite(closed) && Number.isFinite(oldest) && closed > maxTime && oldest <= afterLedger + 1;
}
