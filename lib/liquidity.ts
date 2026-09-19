import { Address, BASE_FEE, Contract, TransactionBuilder, nativeToScVal, rpc, scValToNative } from '@stellar/stellar-sdk';
import { ASSETS, FX_ROUTER, FX_ROUTER_WASM_HASH, NETWORK_PASSPHRASE, RPC_URL, VIEW_ACCOUNT, type AssetKey } from './config';
import { checkTransaction, getProviderStats, submitContractCall } from './stellar';
import { clearLpRecord, readLpRecord, writeLpRecord, type LpRecord } from './lp-transaction';
import { assertConnectedWallet } from './wallet';
import { liquidityMoveBlocker, parsePairInput } from './liquidity-input';
import { getWalletHoldings } from './trustline';

const server = new rpc.Server(RPC_URL);
const address = (value: string) => Address.fromString(value).toScVal();
export type ProviderPair = ReturnType<typeof parsePairInput>;
async function read(method: string, args: ReturnType<typeof nativeToScVal>[] = [], minimumLedger = 0) {
  const tx = new TransactionBuilder(await server.getAccount(VIEW_ACCOUNT), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(FX_ROUTER).call(method, ...args)).setTimeout(60).build();
  const result = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(result) || !result.result) throw new Error('Could not read liquidity from the active router.');
  if (minimumLedger > 0 && (!Number.isSafeInteger(result.latestLedger) || result.latestLedger < minimumLedger)) {
    throw new Error('RPC has not reached the confirmed transaction ledger. Refresh to try again.');
  }
  return scValToNative(result.result.retval);
}
export async function getLiquidityState(wallet: string, source: AssetKey, target: AssetKey, minimumLedger = 0) {
  const [providers, paused, pair, stats, instance, holdings] = await Promise.all([
    read('get_providers', [], minimumLedger), read('is_paused', [], minimumLedger), source === target ? null : read('get_pair', [address(wallet), address(ASSETS[source].contract), address(ASSETS[target].contract)], minimumLedger),
    getProviderStats(wallet, minimumLedger), server.getContractInstance(FX_ROUTER),
    // Wallet (classic trustline) balances are separate from router inventory; a Horizon failure must not hide inventory.
    getWalletHoldings(wallet).catch(() => null),
  ]);
  // Only the verified implementation is known to authorize self-registration.
  // Unknown/legacy deployments fail closed without changing the active address.
  const executable = instance.executable;
  const hash = 'wasmHash' in executable ? Array.from(executable.wasmHash.value, b => b.toString(16).padStart(2, '0')).join('') : '';
  return { registered: (providers as string[]).includes(wallet), paused: Boolean(paused), pair: pair as ProviderPair | null, stats, wallet: holdings,
    permissionless: [FX_ROUTER_WASM_HASH, 'd9ce795649404c2ce433bf95a803bcbe7c85d734921e416c57b542a57264049f'].includes(hash) };
}
/** Persists the hash before submission and clears it only once the network settles it. */
function tracked(wallet: string, kind: LpRecord['kind'], extra: Pick<LpRecord, 'asset' | 'amount'> = {}) {
  if (readLpRecord(wallet)) throw new Error('A previous liquidity transaction is not confirmed yet. Check it before signing another.');
  return (hash: string, status: string, tracking: Pick<LpRecord, 'maxTime' | 'afterLedger'>) =>
    status === 'pending' ? writeLpRecord({ ...tracking, hash, network: 'testnet', wallet, router: FX_ROUTER, kind, ...extra }) : clearLpRecord(wallet, hash);
}
/** Looks the saved hash up (read-only). A still-unresolved record stays and keeps blocking new LP transactions. */
export async function checkLpRecord(wallet: string) {
  const saved = readLpRecord(wallet);
  if (!saved) return null;
  const outcome = await checkTransaction(saved);
  if (outcome.state !== 'pending') clearLpRecord(wallet, saved.hash);
  return { saved, state: outcome.state, ledger: outcome.state === 'success' ? outcome.result.ledger : undefined,
    networkTime: outcome.state === 'pending' ? outcome.networkTime : undefined };
}
export async function registerProvider(wallet: string) {
  await assertConnectedWallet(wallet);
  const state = await getLiquidityState(wallet, 'USD', 'EUR');
  if (!state.permissionless) throw new Error('Self-registration is not enabled on the active router.');
  if (state.registered) throw new Error('This wallet is already registered. Refresh its status.');
  return submitContractCall(wallet, FX_ROUTER, 'register_provider', [address(wallet)], tracked(wallet, 'register'));
}
export async function configureProvider(wallet: string, source: AssetKey, target: AssetKey, config: ProviderPair) {
  await assertConnectedWallet(wallet);
  if(source === target) throw new Error('Choose different currencies for the LP pair.');
  return submitContractCall(wallet, FX_ROUTER, 'set_provider_pair', [address(wallet), address(ASSETS[source].contract), address(ASSETS[target].contract),
    nativeToScVal(config, { type: { active: ['symbol','bool'], fee_bps: ['symbol','u32'], max_amount_in: ['symbol','i128'], max_source_inventory: ['symbol','i128'] } })],
    tracked(wallet, 'pair'));
}
export async function moveLiquidity(wallet: string, asset: AssetKey, amount: bigint, method: 'deposit' | 'withdraw') {
  await assertConnectedWallet(wallet);
  const args = [address(wallet), address(ASSETS[asset].contract)];
  // Without this, a missing trustline or empty wallet only surfaces as a long simulation error and nothing is submitted.
  const [holdings, inventory] = await Promise.all([getWalletHoldings(wallet), read('get_balance', args)]);
  const blocker = liquidityMoveBlocker(method, ASSETS[asset].code, amount, holdings[asset], BigInt(inventory));
  if (blocker) throw new Error(blocker);
  const settled = await submitContractCall(wallet, FX_ROUTER, method, [...args, nativeToScVal(amount, {type:'i128'})],
    tracked(wallet, method, { asset, amount: amount.toString() }));
  // deposit/withdraw return the provider's new recorded inventory for this asset.
  const next = settled.result?.returnValue ? BigInt(scValToNative(settled.result.returnValue)) : null;
  return { ...settled, inventory: next };
}
