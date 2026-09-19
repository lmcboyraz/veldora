import { Networks, StrKey, WebAuth } from '@stellar/stellar-sdk';

export type AnchorDiagnostic = {
  method: string;
  endpoint: string;
  status: number;
  reason: string;
};
export class AnchorError extends Error {
  readonly diagnostic?: AnchorDiagnostic;
  declare readonly upstreamReason?: string;
  constructor(
    message: string,
    diagnostic?: AnchorDiagnostic,
    upstreamReason?: string,
  ) {
    super(message);
    this.diagnostic = diagnostic;
    // Preserve the upstream reason for code-level diagnosis, never implicit serialization.
    Object.defineProperty(this, 'upstreamReason', {
      value: upstreamReason,
      enumerable: false,
    });
  }
}
export const HOME_DOMAIN = 'tr-mock-anchor.fly.dev';
export type Data = Record<string, unknown>;
export type Discovery = {
  home: string;
  network: string;
  code: string;
  issuer: string;
  auth: string;
  transfer: string;
  kyc: string;
  quote: string;
  signingKey: string;
};
export type Session = {
  wallet: string;
  network: string;
  home: string;
  token: string;
  expires: number;
};
export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AnchorError('Invalid Anchor response.');
  return value as Data;
}
export function text(data: Data, key: string): string {
  if (typeof data[key] !== 'string')
    throw new AnchorError('Invalid Anchor response.');
  return data[key] as string;
}
export function units(value: unknown, decimals: number): bigint {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(value)
  )
    throw new AnchorError('Invalid amount.');
  const [whole, fraction = ''] = value.split('.');
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0'))
  );
}
export function decimal(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  return `${value / scale}.${String(value % scale).padStart(decimals, '0')}`;
}
export function tryAmount(value: unknown): string {
  const amount = units(value, 2);
  if (amount < 5000n || amount > 300000n)
    throw new AnchorError('Amount must be between 50 and 3000 TRY.');
  return decimal(amount, 2);
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new AnchorError('Invalid transaction ID.');
  return value;
}
export function validateDiscovery(
  toml: Data,
  home: string,
  network: string,
  asset: { code: string; issuer: string },
): Discovery {
  const currencies = toml.CURRENCIES;
  const currency = Array.isArray(currencies)
    ? currencies.map(object).find((c) => c.code === 'USDC')
    : undefined;
  if (
    network !== Networks.TESTNET ||
    toml.NETWORK_PASSPHRASE !== network ||
    !currency ||
    currency.code !== asset.code ||
    currency.issuer !== asset.issuer
  )
    throw new AnchorError(
      'The Anchor asset or network does not match the Veldora USDC configuration.',
    );
  function endpoint(key: string) {
    const url = new URL(text(toml, key));
    if (
      url.origin !== `https://${home}` ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new AnchorError('Invalid Anchor endpoint domain.');
    return url.href.replace(/\/$/, '');
  }
  const signingKey = text(toml, 'SIGNING_KEY');
  if (!StrKey.isValidEd25519PublicKey(signingKey))
    throw new AnchorError('Invalid Anchor signing key.');
  return {
    home,
    network,
    code: asset.code,
    issuer: asset.issuer,
    signingKey,
    auth: endpoint('WEB_AUTH_ENDPOINT'),
    transfer: endpoint('TRANSFER_SERVER'),
    kyc: endpoint('KYC_SERVER'),
    quote: endpoint('ANCHOR_QUOTE_SERVER'),
  };
}
export function validateChallenge(xdr: string, d: Discovery, wallet: string) {
  const result = WebAuth.readChallengeTx(
    xdr,
    d.signingKey,
    d.network,
    d.home,
    new URL(d.auth).host,
  );
  const bounds = result.tx.timeBounds;
  const now = Math.floor(Date.now() / 1000);
  if (
    result.clientAccountID !== wallet ||
    !bounds ||
    Number(bounds.minTime) > now ||
    Number(bounds.maxTime) <= now
  )
    throw new AnchorError(
      'The wallet authorization request is invalid or expired.',
    );
  return result.tx;
}
export function sessionValid(
  s: Session | null,
  wallet: string,
  network: string,
  home: string,
  now = Date.now(),
): boolean {
  return (
    !!s &&
    s.wallet === wallet &&
    s.network === network &&
    s.home === home &&
    s.expires > now
  );
}
export function tokenSession(
  token: string,
  wallet: string,
  d: Discovery,
): Session {
  // Only lifetime/context bookkeeping: the anchor validates the bearer on every API call.
  const claims = object(
    JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))),
  );
  if (
    claims.sub !== wallet ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= Date.now()
  )
    throw new AnchorError('Invalid Anchor session.');
  return {
    token,
    wallet,
    network: d.network,
    home: d.home,
    expires: claims.exp * 1000,
  };
}
export function validateQuote(
  q: Data,
  d: Discovery,
  amount: unknown,
  allowExpired = false,
) {
  const source = tryAmount(amount);
  if (
    q.sell_asset !== 'iso4217:TRY' ||
    q.buy_asset !== `stellar:${d.code}:${d.issuer}` ||
    tryAmount(q.sell_amount) !== source
  )
    throw new AnchorError('Quote amount or asset does not match.');
  const expires = text(q, 'expires_at');
  if (
    !Number.isFinite(Date.parse(expires)) ||
    (!allowExpired && Date.parse(expires) <= Date.now())
  )
    throw new AnchorError('The quote expired; get a new quote.');
  const destination = units(q.buy_amount, 7);
  if (destination <= 0n) throw new AnchorError('Invalid USDC quote.');
  const fee = object(q.fee);
  return {
    id: identifier(q.id),
    source_amount: source,
    destination_amount: decimal(destination, 7),
    rate: text(q, 'price'),
    fee: { total: text(fee, 'total'), asset: text(fee, 'asset') },
    expires_at: expires,
  };
}
export function terminal(status: string) {
  return [
    'completed',
    'error',
    'expired',
    'refunded',
    'no_market',
    'too_small',
    'too_large',
  ].includes(status);
}
