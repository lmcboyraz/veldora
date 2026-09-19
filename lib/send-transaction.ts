import type { AssetKey } from './config';
// Kept dependency-free: tests import this module before their resolver hooks are registered.
const validTracking = (v: unknown) => v === undefined || (Number.isSafeInteger(v) && (v as number) > 0);

export type SendPayment = {
  hash: string; network: 'testnet'; wallet: string; router: string; recipient: string;
  source: AssetKey; target: AssetKey; amount: string; minimum: string; route: boolean;
  /** 'expired' = the network proved the envelope can no longer and never did execute. */
  status: 'pending' | 'success' | 'failed' | 'expired';
  /** Absent on records saved before expiry tracking; such a record is never closed automatically. */
  maxTime?: number; afterLedger?: number;
};
// ponytail: one outstanding Send per browser; no server or signed envelope storage.
const key = 'rise:send:testnet';
function payment(value: SendPayment): SendPayment {
  const { hash, network, wallet, router, recipient, source, target, amount, minimum, route, status, maxTime, afterLedger } = value;
  if (!/^[a-f0-9]{64}$/.test(hash) || network !== 'testnet' ||
      ![wallet,router,recipient].every(v=>typeof v==='string' && v.length>0) ||
      ![source,target].every(v=>['USD','EUR','GBP','TRY'].includes(v)) || source===target ||
      !/^\d+$/.test(amount) || BigInt(amount)<=0n || !/^\d+$/.test(minimum) || typeof route!=='boolean' ||
      !['pending','success','failed','expired'].includes(status) || !validTracking(maxTime) || !validTracking(afterLedger)) throw new Error('Invalid saved Send record. Check wallet activity before starting another payment.');
  return {hash,network,wallet,router,recipient,source,target,amount,minimum,route,status,
    ...(maxTime === undefined ? {} : {maxTime}), ...(afterLedger === undefined ? {} : {afterLedger})};
}
export function readPayment(): SendPayment | null {
  try { const raw=localStorage.getItem(key); return raw ? payment(JSON.parse(raw)) : null; }
  catch { throw new Error('Saved Send record is unreadable. Check wallet activity before starting another payment.'); }
}
export function writePayment(value: SendPayment) { localStorage.setItem(key,JSON.stringify(payment(value))); }
export function clearPayment() {
  if(readPayment()?.status==='pending') throw new Error('Check the pending transaction before starting another payment.');
  localStorage.removeItem(key);
}
