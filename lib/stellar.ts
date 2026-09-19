import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';

import {
  ASSETS,
  FX_ROUTER,
  NETWORK_PASSPHRASE,
  RPC_URL,
  TOKEN_SCALE,
  VIEW_ACCOUNT,
  type AssetKey,
} from './config';
import { readPayment, writePayment, type SendPayment } from './send-transaction';
import { signTransactionXdr } from './wallet';
import { FX_ROUTE_ENABLED } from './config';
import { parseUnits, quoteKey, decodeRoute, decodeHop, quoteFailure } from './fx-quote';
import { provedNeverApplied, type TxTracking } from './tx-outcome';

export {
  ASSETS,
  DEMO_AMOUNT,
  DEMO_RECIPIENT,
  EXPLORER_URL,
  FX_ROUTER,
  NETWORK_PASSPHRASE,
  PRICE_SCALE,
  PROVIDERS,
  REFLECTOR_ORACLE,
  RPC_URL,
  TOKEN_SCALE,
  VIEW_ACCOUNT,
  type AssetKey,
} from './config';

/** When the TRY demo/mock price was really set and when the demo oracle stops serving it. */
export type DemoFeed = { setAt: number; expires: number };
export type Quote = ReturnType<typeof decodeRoute> & { requestKey: string; validUntil: number; demo: boolean; demoFeed?: DemoFeed | null };

const server = new rpc.Server(RPC_URL);

function address(value: string) {
  return Address.fromString(value).toScVal();
}

function buildInvocation(
  sourceAccount: Awaited<ReturnType<typeof server.getAccount>>,
  contractId: string,
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
) {
  const contract = new Contract(contractId);
  return new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
}

async function simulate(
  source: string,
  contractId: string,
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
  minimumLedger = 0,
) {
  let failedMethod = 'getAccount';
  try {
    const sourceAccount = await server.getAccount(source);
    const transaction = buildInvocation(sourceAccount, contractId, method, args);
    failedMethod = method;
    const simulation = await server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      const message = 'error' in simulation ? simulation.error : 'Simulation returned no result';
      throw new Error(message);
    }
    if (minimumLedger > 0 && (!Number.isSafeInteger(simulation.latestLedger) || simulation.latestLedger < minimumLedger)) {
      throw new Error('RPC has not reached the confirmed transaction ledger. Refresh to try again.');
    }
    return scValToNative(simulation.result.retval);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    throw Object.assign(failure, {method:failedMethod});
  }
}

export const parseAmount = parseUnits;

export function formatAmount(value: bigint, maximumFractionDigits = 2) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / TOKEN_SCALE;
  const fraction = (absolute % TOKEN_SCALE)
    .toString()
    .padStart(7, '0')
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}

export function shorten(value: string, size = 5) {
  return `${value.slice(0, size)}…${value.slice(-size)}`;
}

export async function ensureFunded(account: string) {
  try {
    await server.getAccount(account);
  } catch {
    await server.fundAddress(account);
  }
}

export async function getTokenBalance(tokenId: string, account: string) {
  const result = await simulate(VIEW_ACCOUNT, tokenId, 'balance', [address(account)]);
  return BigInt(result);
}

export async function getQuote(
  sourceAccount: string,
  sourceAsset: AssetKey,
  targetAsset: AssetKey,
  amountIn: bigint,
): Promise<Quote> {
  try {
  if (sourceAsset === targetAsset) throw new Error('Choose different currencies for FX send.');
  if (!FX_ROUTE_ENABLED && (sourceAsset === 'TRY' || targetAsset === 'TRY' || sourceAsset === 'GBP' || targetAsset === 'GBP')) {
    throw new Error('Four-asset v2 is not activated: LP USDC funding and on-chain route verification must finish. TRY/GBP Send is unavailable.');
  }
  const raw = await simulate(sourceAccount, FX_ROUTER, FX_ROUTE_ENABLED ? 'quote_route' : 'quote', [
    address(ASSETS[sourceAsset].contract), address(ASSETS[targetAsset].contract), nativeToScVal(amountIn, { type: 'i128' }),
  ]);
  const route = FX_ROUTE_ENABLED ? decodeRoute(raw) : {
    ...decodeHop(raw), path: [ASSETS[sourceAsset].contract, ASSETS[targetAsset].contract], hops: [decodeHop(raw)],
  };
  if (route.path.includes(ASSETS.TRY.contract) && ASSETS.TRY.priceMode !== 'demo') throw new Error('TRY snapshot requires explicit testnet demo price mode. Live mode cannot use it.');
  const maxAge = FX_ROUTE_ENABLED ? Number(await simulate(sourceAccount, FX_ROUTER, 'get_max_price_age', [])) : 900;
  // Verify metadata against this router rather than labeling an arbitrary oracle as live.
  if (FX_ROUTE_ENABLED) for (const id of route.path) {
    const asset = Object.values(ASSETS).find(a => a.contract === id);
    if (!asset) throw new Error('Router returned an unknown asset.');
    const config = await simulate(sourceAccount, FX_ROUTER, 'get_asset', [address(id)]);
    if (!config.enabled || config.is_oracle_base !== (asset.currency === 'USD') || config.oracle !== asset.oracle || config.oracle_base !== 'USD' || Number(config.token_decimals) !== asset.decimals || config.oracle_asset?.[1] !== asset.oracleSymbol) {
      throw new Error('Asset/oracle configuration differs from the verified deployment.');
    }
  }
  const timestamp = Math.min(...route.hops.flatMap(h => [h.sourceOracleTimestamp, h.targetOracleTimestamp]));
  // The TTL demo oracle reports the read time to the router; its snapshot says when TRY was set.
  // The original demo oracle has no `snapshot`, and its hop timestamps are already the set time.
  const snapshot = route.path.includes(ASSETS.TRY.contract)
    ? await simulate(sourceAccount, ASSETS.TRY.oracle, 'snapshot', []).catch(() => null) : null;
  const demoFeed = snapshot ? { setAt: Number(snapshot.timestamp), expires: Number(snapshot.expires) } : null;
  return { ...route, requestKey: quoteKey(FX_ROUTER, sourceAccount, sourceAsset, targetAsset, amountIn),
    validUntil: Math.min(timestamp + maxAge, Math.floor(Date.now() / 1000) + 180, demoFeed?.expires ?? Infinity),
    demo: route.path.some(id => Object.values(ASSETS).some(a => a.contract === id && a.priceMode === 'demo')), demoFeed };
  } catch (error) {
    const failure = quoteFailure(error, sourceAsset, targetAsset, amountIn);
    // The demo oracle reports an expired TRY snapshot as a missing price (#9); its snapshot() then returns None.
    if ((failure.contractCode === 9 || failure.contractCode === 10) && (sourceAsset === 'TRY' || targetAsset === 'TRY') && ASSETS.TRY.priceMode === 'demo' &&
        await simulate(sourceAccount, ASSETS.TRY.oracle, 'snapshot', []).then(snapshot => snapshot === null, () => false))
      failure.message = 'The TRY demo price has expired, so TRY cannot be quoted. Refresh the TRY demo price, then quote again.';
    throw failure;
  }
}

export async function getProviderStats(provider: string, minimumLedger = 0) {
  const entries = await Promise.all((Object.keys(ASSETS) as AssetKey[]).map(async key => {
    const args = [address(provider), address(ASSETS[key].contract)];
    const [balance, fees] = await Promise.all(['get_balance','get_fees'].map(method => simulate(VIEW_ACCOUNT, FX_ROUTER, method, args, minimumLedger)));
    return [key, {balance: BigInt(balance), fees: BigInt(fees)}] as const;
  }));
  return Object.fromEntries(entries) as Record<AssetKey, {balance: bigint; fees: bigint}>;
}

/** A hash's settled state, read from the network. Never inferred from a client timeout or a submission reply. */
export async function checkTransaction(tracking: TxTracking) {
  const result = await server.getTransaction(tracking.hash);
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return { state: 'success' as const, result };
  if (result.status === rpc.Api.GetTransactionStatus.FAILED) return { state: 'failed' as const };
  if (provedNeverApplied(tracking, result)) return { state: 'expired' as const };
  // The network's latest close time, not the client clock, says whether it can still execute.
  return { state: 'pending' as const, networkTime: Number(result.latestLedgerCloseTime) || undefined };
}

/** Why a tracked hash is still unresolved; the record stays and nothing may be signed again. */
export function unresolvedMessage(tracking: TxTracking, what = 'payment', networkTime = Date.now() / 1_000) {
  if (!tracking.maxTime || !tracking.afterLedger) return `Not confirmed. This older record has no expiry data, so Veldora cannot prove it never ran. Check the hash in the explorer; do not sign another ${what}.`;
  if (networkTime <= tracking.maxTime) return `Not confirmed yet. It can still execute until ${new Date(tracking.maxTime * 1_000).toLocaleTimeString()}. Check again after that; do not sign another ${what}.`;
  return `Not confirmed. Network history cannot yet prove it never ran. Check again later or check the hash in the explorer; do not sign another ${what}.`;
}

export async function submitContractCall(
  source: string,
  contractId: string,
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
  onStatus?: (hash: string, status: SendPayment['status'], tracking: TxTracking) => void,
) {
  const sourceAccount = await server.getAccount(source);
  const transaction = buildInvocation(sourceAccount, contractId, method, args);
  const prepared = await server.prepareTransaction(transaction);
  // Read before signing: the envelope cannot be in this ledger or any earlier one.
  const afterLedger = (await server.getLatestLedger()).sequence;
  const signedTxXdr = await signTransactionXdr(prepared.toXdr(), source);

  const signedTransaction = TransactionBuilder.fromXdr(signedTxXdr, NETWORK_PASSPHRASE);
  const hash = Array.from(signedTransaction.hash(), b=>b.toString(16).padStart(2,'0')).join('');
  const tracking: TxTracking = { hash, maxTime: Number(('timeBounds' in signedTransaction && signedTransaction.timeBounds?.maxTime) || 0) || undefined, afterLedger };
  onStatus?.(hash, 'pending', tracking); // Must persist before the first network submission.
  // The submission reply (PENDING/DUPLICATE/TRY_AGAIN_LATER/ERROR) is not the outcome: only the
  // ledger lookup, or proof that the envelope expired without executing, settles the record.
  const sent = await server.sendTransaction(signedTransaction);

  // The envelope's maxTime is 60 s out, so this covers the expiry proof for a lost or refused send.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const outcome = await checkTransaction(tracking);
    if (outcome.state === 'success') {
      onStatus?.(hash, 'success', tracking);
      return { hash, result: outcome.result };
    }
    if (outcome.state === 'failed') {
      onStatus?.(hash, 'failed', tracking);
      throw new Error('The transaction failed on Stellar Testnet');
    }
    if (outcome.state === 'expired') {
      onStatus?.(hash, 'expired', tracking);
      throw new Error(`The network did not execute this transaction${sent.status === 'PENDING' || sent.status === 'DUPLICATE' ? '' : ` (${sent.status})`} and it has expired. Nothing moved.`);
    }
  }
  throw new Error(`Transaction confirmation timed out. ${unresolvedMessage(tracking, 'transaction')}`);
}

export async function executeSwap(
  sender: string,
  recipient: string,
  sourceAsset: AssetKey,
  targetAsset: AssetKey,
  amountIn: bigint,
  minAmountOut: bigint,
  onPayment: (payment: SendPayment) => void,
) {
  if (readPayment()) throw new Error('Check the saved transaction or explicitly start a new payment first.');
  const settled = await submitContractCall(sender, FX_ROUTER, FX_ROUTE_ENABLED ? 'transfer_route' : 'transfer_with_swap', [
    address(sender),
    address(recipient),
    address(ASSETS[sourceAsset].contract),
    address(ASSETS[targetAsset].contract),
    nativeToScVal(amountIn, { type: 'i128' }),
    nativeToScVal(minAmountOut, { type: 'i128' }),
    nativeToScVal(BigInt(Math.floor(Date.now() / 1_000) + 180), { type: 'u64' }),
  ], (hash, status, {maxTime, afterLedger}) => {
    const payment: SendPayment = {hash, status, network:'testnet', wallet:sender, router:FX_ROUTER, recipient, source:sourceAsset, target:targetAsset, amount:amountIn.toString(), minimum:minAmountOut.toString(), route:FX_ROUTE_ENABLED, maxTime, afterLedger};
    onPayment(payment);
    writePayment(payment);
  });
  return decodeSettlement(settled, {source:sourceAsset,target:targetAsset,route:FX_ROUTE_ENABLED});
}

function decodeSettlement(settled: {hash:string; result:rpc.Api.GetSuccessfulTransactionResponse}, payment: Pick<SendPayment,'source'|'target'|'route'>) {
  const raw = settled.result.returnValue ? scValToNative(settled.result.returnValue) : null;
  if (!raw) throw new Error(`Transaction ${settled.hash} settled but its receipt is unavailable. Check the explorer before retrying.`);
  const actual = payment.route ? decodeRoute(raw) : { ...decodeHop(raw), path: [ASSETS[payment.source].contract, ASSETS[payment.target].contract], hops: [decodeHop(raw)] };
  return { ...settled, actual, networkFee: BigInt(settled.result.resultXdr.feeCharged.toString()) };
}

export async function checkSendTransaction(payment: SendPayment, onPayment: (payment: SendPayment) => void) {
  const outcome = await checkTransaction(payment);
  if (outcome.state === 'pending') throw new Error(unresolvedMessage(payment, 'payment', outcome.networkTime));
  const next = {...payment, status: outcome.state};
  onPayment(next); writePayment(next);
  if (outcome.state === 'success') return decodeSettlement({hash:payment.hash,result:outcome.result},payment);
  throw new Error(outcome.state === 'failed' ? 'The transaction failed on Stellar Testnet. No payment was delivered.'
    : 'The network did not execute this transaction and it has expired. No payment was delivered.');
}
