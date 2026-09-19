import {
  Asset,
  BASE_FEE,
  Horizon,
  NotFoundError,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { ASSETS, HORIZON_URL, NETWORK_PASSPHRASE, type AssetKey } from './config';
import { signTransactionXdr } from './wallet';
import { parseUnits } from './fx-quote';

const horizon = new Horizon.Server(HORIZON_URL);

export class TrustlineError extends Error {
  readonly account: string;
  readonly assetKey: AssetKey;

  constructor(message: string, account: string, assetKey: AssetKey) {
    super(message);
    this.name = 'TrustlineError';
    this.account = account;
    this.assetKey = assetKey;
  }
}

export function classicAsset(assetKey: AssetKey) {
  const asset = ASSETS[assetKey];
  return new Asset(asset.code, asset.issuer);
}

/**
 * Contract addresses hold SAC balances in contract storage, so only classic
 * `G...` accounts ever need a trustline.
 */
export function needsTrustline(account: string) {
  return account.startsWith('G');
}

export type TrustlineStatus =
  | { state: 'not-required' }
  | { state: 'present' }
  | { state: 'missing' }
  | { state: 'account-missing' }
  | { state: 'unknown'; reason: string }
  | { state: 'blocked'; reason: string };

export async function checkTrustline(
  account: string,
  assetKey: AssetKey,
  amount = 0n,
): Promise<TrustlineStatus> {
  if (!needsTrustline(account)) return { state: 'not-required' };

  const asset = ASSETS[assetKey];
  if (account === asset.issuer) return { state: 'not-required' };
  try {
    const loaded = await horizon.loadAccount(account);
    const present = loaded.balances.find(
      (balance) =>
        'asset_code' in balance &&
        balance.asset_code === asset.code &&
        balance.asset_issuer === asset.issuer,
    );
    if (!present) return { state: 'missing' };
    if ('is_authorized' in present && !present.is_authorized) return { state: 'blocked', reason: 'The issuer has not authorized this trustline.' };
    if ('asset_code' in present && parseUnits(present.limit) - parseUnits(present.balance) - parseUnits(present.buying_liabilities) < amount) return { state: 'blocked', reason: 'Recipient trustline has insufficient capacity.' };
    return { state: 'present' };
  } catch (error) {
    if (error instanceof NotFoundError) return { state: 'account-missing' };
    const reason = error instanceof Error ? error.message : String(error);
    return { state: 'unknown', reason };
  }
}

/**
 * Adds the trustline for `assetKey` to the connected account. Only the account
 * itself can authorize this, so `account` must be the connected wallet.
 */
export async function ensureTrustline(account: string, assetKey: AssetKey) {
  const status = await checkTrustline(account, assetKey);
  if (status.state === 'present' || status.state === 'not-required') return status;
  if (status.state === 'account-missing') {
    throw new TrustlineError(
      `${account.slice(0, 6)}… is not funded on Stellar Testnet yet.`,
      account,
      assetKey,
    );
  }
  if (status.state === 'blocked') throw new TrustlineError(status.reason, account, assetKey);
  if (status.state === 'unknown') {
    throw new TrustlineError(
      `Could not read the ${ASSETS[assetKey].code} trustline: ${status.reason}`,
      account,
      assetKey,
    );
  }

  const source = await horizon.loadAccount(account);
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: classicAsset(assetKey) }))
    .setTimeout(120)
    .build();

  const signedXdr = await signTransactionXdr(transaction.toXdr(), account);
  const signed = TransactionBuilder.fromXdr(signedXdr, NETWORK_PASSPHRASE);
  await horizon.submitTransaction(signed);
  return { state: 'present' } as const;
}

/**
 * Spendable classic balances (sell liabilities excluded) keyed by the exact
 * code + issuer the router uses. `null` means the account has no trustline.
 */
export async function getWalletHoldings(account: string): Promise<Record<AssetKey, bigint | null>> {
  const loaded = await horizon.loadAccount(account);
  return Object.fromEntries(Object.entries(ASSETS).map(([key, asset]) => {
    const balance = loaded.balances.find(b => 'asset_code' in b && b.asset_code === asset.code && b.asset_issuer === asset.issuer);
    if (!balance || !('asset_code' in balance)) return [key, null];
    return [key, balance.is_authorized ? parseUnits(balance.balance) - parseUnits(balance.selling_liabilities) : 0n];
  })) as Record<AssetKey, bigint | null>;
}

/** Spendable classic balances exclude outstanding sell liabilities. Missing lines are zero. */
export async function getWalletBalances(account: string): Promise<Record<AssetKey, bigint>> {
  const holdings = await getWalletHoldings(account);
  return Object.fromEntries(Object.entries(holdings).map(([key, value]) => [key, value ?? 0n])) as Record<AssetKey, bigint>;
}
