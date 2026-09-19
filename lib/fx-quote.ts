export function parseUnits(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(\.\d{0,7})?$/.test(normalized)) return 0n;
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
  return amount <= (1n << 127n) - 1n ? amount : 0n;
}
/** Why a non-empty amount parses to zero, so the field can say so instead of silently quoting nothing. */
export function amountInputError(value: string) {
  const text = value.trim().replace(',', '.');
  if (!text) return null;
  if (!/^\d+(\.\d*)?$/.test(text)) return 'Use digits and one decimal point, e.g. 12.5.';
  if (/\.\d{8,}$/.test(text)) return 'Use at most 7 decimal places.';
  if (parseUnits(text) > 0n) return null;
  return /[1-9]/.test(text) ? 'Amount is too large.' : 'Enter an amount greater than 0.';
}
export const quoteKey =(router: string, wallet: string, source: string, target: string, amount: bigint) =>
  [router, wallet, source, target, amount.toString()].join(':');
export function isCurrentQuote(quote: { requestKey: string; validUntil: number } | null, key: string, now: number) {
  return !!quote && quote.requestKey === key && now <= quote.validUntil;
}
export type RawHop = {
  provider: string; amount_in: bigint; gross_amount_out: bigint; amount_out: bigint;
  fee_amount: bigint; fee_bps: number; source_price: bigint; target_price: bigint;
  source_oracle_timestamp: number; target_oracle_timestamp: number;
};
export function decodeHop(raw: RawHop) {
  return {
    provider: raw.provider, amountIn: BigInt(raw.amount_in), grossAmountOut: BigInt(raw.gross_amount_out),
    amountOut: BigInt(raw.amount_out), feeAmount: BigInt(raw.fee_amount), feeBps: Number(raw.fee_bps),
    sourcePrice: BigInt(raw.source_price), targetPrice: BigInt(raw.target_price),
    sourceOracleTimestamp: Number(raw.source_oracle_timestamp), targetOracleTimestamp: Number(raw.target_oracle_timestamp),
  };
}
export function decodeRoute(raw: {path: string[]; hops: RawHop[]; amount_in: bigint; amount_out: bigint}) {
  const hops = raw.hops.map(decodeHop);
  if (hops.length < 1 || hops.length > 2 || raw.path.length !== hops.length + 1) throw new Error('Invalid route receipt');
  return { ...hops[hops.length - 1], path: raw.path, hops, amountIn: BigInt(raw.amount_in), amountOut: BigInt(raw.amount_out),
    sourcePrice: hops[0].sourcePrice, sourceOracleTimestamp: hops[0].sourceOracleTimestamp };
}

/** Safe quote diagnostics: never serialize RPC requests, headers or signed envelopes. */
export function quoteFailure(error: unknown, source: string, target: string, amountIn: bigint) {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = error as { method?: string; code?: string; response?: { status?: number } } | null;
  const method = detail?.method ?? 'validation';
  const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  const contractCode = match ? Number(match[1]) : undefined;
  const reasons: Record<number, string> = {
    3: 'This asset is not enabled on the router. A quote is unavailable.',
    // #8: every LP was filtered out by its per-trade limit, source inventory cap or target inventory.
    8: 'Insufficient liquidity for this amount: no Veldora LP accepts a trade this size right now (per-trade limit or inventory). Try a smaller amount.',
    9: 'Price feed is currently unavailable for this currency.',
    10: 'Price feed is stale. Refresh the demo price/feed before quoting.',
    14: 'The router is paused. Quotes are temporarily unavailable.',
  };
  const transport = /network|fetch|timeout|timed out|connection|429|503/i.test(raw) ||
    ['ERR_NETWORK','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND'].includes(detail?.code ?? '') || Number(detail?.response?.status) >= 400;
  const message = contractCode !== undefined && reasons[contractCode] ? reasons[contractCode]
    : transport ? 'Could not reach Stellar Testnet. Retry the quote.'
    : method === 'getAccount' ? 'Could not load the account for this quote. Check the connection and account.'
    : method === 'validation' && /^(Choose different|Four-asset v2|TRY snapshot|Router returned|Asset\/oracle)/.test(raw) ? raw
    : 'Quote unavailable. Refresh to try again; this quote request did not submit a payment.';
  return Object.assign(new Error(message, {cause:error}), {method,contractCode,source,target,amountIn:amountIn.toString()});
}
