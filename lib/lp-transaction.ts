import { ASSETS, type AssetKey } from './config';
import { validTracking, type TxTracking } from './tx-outcome';

/** A signed LP transaction whose result is not known yet. Only its hash and metadata are stored. */
export type LpRecord = TxTracking & {
  network: 'testnet'; wallet: string; router: string;
  kind: 'register' | 'pair' | 'deposit' | 'withdraw'; asset?: AssetKey; amount?: string;
};
// ponytail: one unresolved LP transaction per network + wallet; another wallet's record is never touched.
const key = (wallet: string) => `rise:lp:testnet:${wallet}`;
function record(value: LpRecord, wallet: string): LpRecord {
  const { hash, network, router, kind, asset, amount, maxTime, afterLedger } = value;
  if (!/^[a-f0-9]{64}$/.test(hash) || network !== 'testnet' || value.wallet !== wallet || typeof router !== 'string' || !router ||
      !['register', 'pair', 'deposit', 'withdraw'].includes(kind) || (asset !== undefined && !(asset in ASSETS)) ||
      (amount !== undefined && !/^\d+$/.test(amount)) || !validTracking(maxTime) || !validTracking(afterLedger))
    throw new Error('Saved liquidity record is unreadable. Check wallet activity in the explorer before another liquidity transaction.');
  return { hash, network, wallet, router, kind, asset, amount, maxTime, afterLedger };
}
export function readLpRecord(wallet: string): LpRecord | null {
  let raw: string | null;
  try { raw = localStorage.getItem(key(wallet)); } catch { return null; }
  if (!raw) return null;
  try { return record(JSON.parse(raw), wallet); }
  catch { throw new Error('Saved liquidity record is unreadable. Check wallet activity in the explorer before another liquidity transaction.'); }
}
export function writeLpRecord(value: LpRecord) { localStorage.setItem(key(value.wallet), JSON.stringify(record(value, value.wallet))); }
/** Only called once the network has settled the saved hash (success, failed or proven expired). */
export function clearLpRecord(wallet: string, hash: string) { if (readLpRecord(wallet)?.hash === hash) localStorage.removeItem(key(wallet)); }
