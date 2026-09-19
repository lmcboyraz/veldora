export function parseLiquidityAmount(value: string, allowZero = false): bigint {
  const text = value.trim().replace(',', '.');
  if (!/^\d+(\.\d{0,7})?$/.test(text)) throw new Error('Enter an amount with at most 7 decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, '0'));
  if (amount < (allowZero ? 0n : 1n) || amount > (1n << 127n) - 1n) throw new Error('Amount is outside the supported range.');
  return amount;
}

const units = (value: bigint) => `${value / 10000000n}${value % 10000000n ? `.${(value % 10000000n).toString().padStart(7, '0').replace(/0+$/, '')}` : ''}`;

/**
 * Reasons a deposit/withdraw would fail inside the token transfer, checked before
 * asking for a signature. `wallet` is the spendable classic balance, or `null`
 * when the wallet has no trustline for this exact code + issuer.
 */
export function liquidityMoveBlocker(kind: 'deposit' | 'withdraw', code: string, amount: bigint, wallet: bigint | null, inventory: bigint) {
  if (wallet === null) return `Your wallet has no ${code} trustline for the router's issuer, so it cannot ${kind === 'deposit' ? 'send' : 'receive'} ${code}. Add the trustline and fund the wallet first.`;
  if (kind === 'deposit' && wallet < amount) return `Your wallet holds ${units(wallet)} ${code}. Deposits move tokens from your wallet, so deposit at most that amount.`;
  if (kind === 'withdraw' && inventory < amount) return `Your router inventory is ${units(inventory)} ${code}. Withdraw at most that amount.`;
  return null;
}

export function parsePairInput(fee: string, maxTrade: string, cap: string, active: boolean) {
  if (!/^\d+$/.test(fee) || Number(fee) > 1000) throw new Error('Fee must be a whole number from 0 to 1000 bps.');
  return { active, fee_bps: Number(fee), max_amount_in: parseLiquidityAmount(maxTrade, true), max_source_inventory: parseLiquidityAmount(cap, true) };
}
