import fxDeployment from './fx-testnet.json' with { type: 'json' };
import { Networks } from '@stellar/stellar-sdk';

/**
 * Deployment configuration for the Veldora FX demo.
 *
 * Every value can be overridden with a `NEXT_PUBLIC_*` environment variable so
 * that a different testnet deployment can be pointed at without code changes.
 * The defaults describe the currently deployed Stellar Testnet instance, so the
 * app keeps working with no `.env` file at all.
 */
const env: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {};

function value(raw: string | undefined, fallback: string) {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = value(env.NEXT_PUBLIC_RISE_RPC_URL, 'https://soroban-testnet.stellar.org');
export const HORIZON_URL = value(env.NEXT_PUBLIC_RISE_HORIZON_URL, 'https://horizon-testnet.stellar.org');
export const EXPLORER_URL = value(
  env.NEXT_PUBLIC_RISE_EXPLORER_URL,
  'https://stellar.expert/explorer/testnet',
);

/** Active four-asset router; earlier routers are listed under `previous` in fx-testnet.json. */
export const FX_ROUTER = value(env.NEXT_PUBLIC_RISE_FX_ROUTER, fxDeployment.router);

/** Funded testnet account used as the source of read-only simulations. */
export const VIEW_ACCOUNT = value(
  env.NEXT_PUBLIC_RISE_VIEW_ACCOUNT,
  'GBJTHJY5KZCMNDB3IFZHZRSILS7XFX6I6NCIDB4W6XD53CXPHUOXYXOC',
);

export const DEMO_RECIPIENT = value(
  env.NEXT_PUBLIC_RISE_DEMO_RECIPIENT,
  'GB2MBGVLUFHBSMNCBMAOXCNQTP2UWSNL6YTWJ5X2MN4BITHAY4FB3RC4',
);

/**
 * Amount prefilled in the UI. Kept small because Circle's testnet faucet grants
 * 20 units per asset per address every 2 hours.
 */
export const DEMO_AMOUNT = value(env.NEXT_PUBLIC_RISE_DEMO_AMOUNT, '1');

/** Reflector FX oracle used by the router. Informational for the UI only. */
export const REFLECTOR_ORACLE = value(
  env.NEXT_PUBLIC_RISE_REFLECTOR_ORACLE,
  'CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W',
);

/** Both SACs use 7 decimals, matching the router's stored `token_decimals`. */
export const TOKEN_SCALE = 10_000_000n;
export const PRICE_SCALE = 100_000_000_000_000n;

/**
 * Circle's Stellar Testnet assets, addressed through their Stellar Asset
 * Contract. `issuer` is the classic issuer and is only needed for trustlines.
 */
export const ASSETS = {
  USD: {
    currency: 'USD', decimals: 7, network: 'testnet', demo: false, symbol: '$', oracleSymbol: 'USD', oracle: REFLECTOR_ORACLE, priceMode: 'base',
    code: 'USDC',
    label: 'Circle USD Coin',
    contract: value(
      env.NEXT_PUBLIC_RISE_USDC_SAC,
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    ),
    issuer: value(
      env.NEXT_PUBLIC_RISE_USDC_ISSUER,
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    ),
  },
  EUR: {
    currency: 'EUR', decimals: 7, network: 'testnet', demo: false, symbol: '€', oracleSymbol: 'EUR', oracle: REFLECTOR_ORACLE, priceMode: 'live',
    code: 'EURC',
    label: 'Circle Euro Coin',
    contract: value(
      env.NEXT_PUBLIC_RISE_EURC_SAC,
      'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ',
    ),
    issuer: value(
      env.NEXT_PUBLIC_RISE_EURC_ISSUER,
      'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO',
    ),
  },
  GBP: {
    currency: 'GBP', code: 'rGBP', label: 'British pound', symbol: '£',
    ...fxDeployment.assets.GBP, decimals: 7, network: 'testnet', demo: true,
    oracleSymbol: 'GBP', oracle: REFLECTOR_ORACLE, priceMode: 'live',
  },
  TRY: {
    currency: 'TRY', code: 'rTRY', label: 'Turkish lira', symbol: '₺',
    ...fxDeployment.assets.TRY, decimals: 7, network: 'testnet', demo: true,
    oracleSymbol: 'TRY', oracle: fxDeployment.oracle, priceMode: fxDeployment.tryPriceMode,
  },
} as const;

export type AssetKey = keyof typeof ASSETS;

/** Known provider labels; registration, inventory and route fees are read from the chain. */
export const PROVIDERS = [
  {
    name: 'LP-1',
    address: value(
      env.NEXT_PUBLIC_RISE_LP1_ADDRESS,
      'GCXV2DY24I5ZJSV36KTCB2YHEAM6F7NM7OKJZUA6OI44XUMF76UD45NK',
    ),
  },
  {
    name: 'LP-2',
    address: value(
      env.NEXT_PUBLIC_RISE_LP2_ADDRESS,
      'GCNPJ2PETW564HLQ7SHCQ73E2F7EMUKTP52HSS555MSAJ2FVVXFUKSJQ',
    ),
  },
] as const;

export const FX_ROUTE_ENABLED = fxDeployment.ready && FX_ROUTER === fxDeployment.router;
export const DEMO_TOKEN_NOTICE = 'Testnet demo tokens; no fiat backing or redemption guarantee.';
export const FX_ROUTER_WASM_HASH = fxDeployment.routerWasmHash;
