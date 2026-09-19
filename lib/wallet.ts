'use client';

import { NETWORK_PASSPHRASE } from './config';

type Kit = typeof import('@creit.tech/stellar-wallets-kit').StellarWalletsKit;

/**
 * Stellar Wallets Kit is loaded lazily and only in the browser: it registers
 * custom elements at import time, so it must never be pulled into an
 * RSC/SSR module graph.
 */
let kitPromise: Promise<Kit> | null = null;

async function loadKit(): Promise<Kit> {
  if (typeof window === 'undefined') {
    throw new Error('Wallet access is only available in the browser.');
  }
  if (!kitPromise) {
    kitPromise = (async () => {
      const [kitModule, freighter, xbull, albedo, rabet, lobstr, hana] = await Promise.all([
        import('@creit.tech/stellar-wallets-kit'),
        import('@creit.tech/stellar-wallets-kit/modules/freighter'),
        import('@creit.tech/stellar-wallets-kit/modules/xbull'),
        import('@creit.tech/stellar-wallets-kit/modules/albedo'),
        import('@creit.tech/stellar-wallets-kit/modules/rabet'),
        import('@creit.tech/stellar-wallets-kit/modules/lobstr'),
        import('@creit.tech/stellar-wallets-kit/modules/hana'),
      ]);
      kitModule.StellarWalletsKit.init({
        network: kitModule.Networks.TESTNET,
        modules: [
          new freighter.FreighterModule(),
          new xbull.xBullModule(),
          new albedo.AlbedoModule(),
          new rabet.RabetModule(),
          new lobstr.LobstrModule(),
          new hana.HanaModule(),
        ],
      });
      return kitModule.StellarWalletsKit;
    })().catch((error) => {
      kitPromise = null;
      throw error;
    });
  }
  return kitPromise;
}

/** The kit rejects with plain `{ code, message }` objects, not `Error`s. */
export function walletError(error: unknown, fallback: string) {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String((error as { message: unknown }).message));
  }
  return new Error(fallback);
}

/**
 * Opens the wallet picker, then returns the address of the selected wallet.
 * Supports Freighter, xBull, Albedo, Rabet, LOBSTR and Hana.
 */
export async function connectWallet() {
  const kit = await loadKit();
  let address: string;
  try {
    ({ address } = await kit.authModal());
  } catch (error) {
    throw walletError(error, 'Wallet connection was rejected');
  }
  if (!address) throw new Error('Wallet connection was rejected');

  try {
    const network = await kit.getNetwork();
    if (network.networkPassphrase !== NETWORK_PASSPHRASE) {
      throw new Error('Switch your wallet to Stellar Testnet and reconnect.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Switch your wallet')) throw error;
    // Not every wallet exposes the active network; the RPC will reject a
    // mismatched signature anyway, so a failed probe is not fatal here.
  }
  return address;
}

export async function disconnectWallet() {
  const kit = await loadKit();
  await kit.disconnect();
}

/** Re-read the selected wallet before an Anchor write or handing funds to Veldora. */
export async function assertConnectedWallet(expected: string) {
  const kit = await loadKit();
  let address: string;
  try {
    // Freighter reports its active account silently. Other wallets (xBull,
    // Albedo…) open a popup on every fetch, so they use the connected address.
    ({ address } = kit.selectedModule.productId === 'freighter'
      ? await kit.fetchAddress()
      : await kit.getAddress());
  } catch (error) {
    throw walletError(error, 'Could not read the connected wallet. Reconnect and try again.');
  }
  if (!expected || address !== expected) {
    throw new Error('Wallet changed. Anchor flow stopped; reconnect the original demo wallet to check its order.');
  }
}

/** Signs an XDR with the connected wallet, preserving the previous behavior. */
export async function signTransactionXdr(xdr: string, address: string) {
  const kit = await loadKit();
  let signedTxXdr: string | undefined;
  try {
    ({ signedTxXdr } = await kit.signTransaction(xdr, {
      networkPassphrase: NETWORK_PASSPHRASE,
      address,
    }));
  } catch (error) {
    throw walletError(error, 'Transaction signature was rejected');
  }
  if (!signedTxXdr) throw new Error('Transaction signature was rejected');
  return signedTxXdr;
}

/** Anchor sessions must not be reused after an account or network change. */
export async function assertAnchorWallet(expected: string) {
  await assertConnectedWallet(expected);
  const kit = await loadKit();
  let networkPassphrase: string;
  try {
    ({ networkPassphrase } = await kit.getNetwork());
  } catch {
    // Only Freighter exposes its network; as in connectWallet, the others are
    // asked to sign for Testnet and a mismatched signature is rejected anyway.
    return;
  }
  if (networkPassphrase !== NETWORK_PASSPHRASE) throw new Error('Switch your wallet to Stellar Testnet and authorize again.');
}
