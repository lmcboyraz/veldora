import 'server-only';
import { Asset, StellarToml, StrKey } from '@stellar/stellar-sdk';
import { ASSETS, HORIZON_URL, NETWORK_PASSPHRASE } from '../config';
import {
  AnchorError,
  HOME_DOMAIN,
  object,
  text,
  units,
  decimal,
  tryAmount,
  identifier,
  validateDiscovery,
  validateQuote,
  validateChallenge,
  tokenSession,
  terminal,
  type Data,
  type Discovery,
} from './sep';

async function json(
  url: string,
  init: RequestInit = {},
  mutation = false,
): Promise<Data> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AnchorError(
      mutation
        ? 'The result is uncertain. Do not create it again; check the existing transaction.'
        : 'Could not reach the Anchor.',
    );
  }
  if (response.status >= 300 && response.status < 400)
    throw new AnchorError('Anchor redirect refused.');
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const reason =
      body &&
      typeof body === 'object' &&
      'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : undefined;
    let safeReason = reason ?? 'Anchor response has no JSON error field.';
    const authorization = new Headers(init.headers).get('authorization');
    if (authorization) {
      safeReason = safeReason.split(authorization).join('[redacted]');
      const token = authorization.replace(/^Bearer\s+/i, '');
      if (token) safeReason = safeReason.split(token).join('[redacted]');
    }
    safeReason = safeReason
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\bS[A-Z2-7]{55}\b/g, '[redacted]')
      .replace(/[A-Za-z0-9+/_=-]{100,}/g, '[redacted]')
      .replace(/[\r\n\t]/g, ' ')
      .slice(0, 500);
    // Request bodies and headers are never included. Only known, nonsecret query fields.
    const endpoint = new URL(url);
    endpoint.username = '';
    endpoint.password = '';
    for (const key of Array.from(endpoint.searchParams.keys())) {
      if (!['asset_code', 'kind', 'limit', 'paging_id', 'id'].includes(key))
        endpoint.searchParams.delete(key);
    }
    throw new AnchorError(
      response.status === 401
        ? 'Anchor session ended; authorize again with your wallet.'
        : `Anchor rejected the request (${response.status}). Check the existing transaction status.`,
      {
        method: init.method ?? 'GET',
        endpoint: endpoint.href,
        status: response.status,
        reason: safeReason,
      },
      reason,
    );
  }
  try {
    return object(await response.json());
  } catch {
    throw new AnchorError(
      mutation
        ? 'The result is uncertain. Check the existing transaction.'
        : 'Invalid Anchor response.',
    );
  }
}
async function discovery() {
  const toml = await StellarToml.Resolver.resolve(HOME_DOMAIN, {
    timeout: 15000,
  });
  const d = validateDiscovery(
    toml as unknown as Data,
    HOME_DOMAIN,
    NETWORK_PASSPHRASE,
    ASSETS.USD,
  );
  if (new Asset(d.code, d.issuer).contractId(d.network) !== ASSETS.USD.contract)
    throw new AnchorError(
      'The Anchor USDC asset does not match the Veldora router asset.',
    );
  return d;
}
function account(value: unknown): string {
  if (typeof value !== 'string' || !StrKey.isValidEd25519PublicKey(value))
    throw new AnchorError('Connect a valid Stellar wallet.');
  return value;
}
function bearer(request: Request) {
  const token = request.headers.get('authorization');
  if (!token || !/^Bearer [A-Za-z0-9_.-]+$/.test(token) || token.length > 10000)
    throw new AnchorError('Authorize with your wallet first.');
  return { Authorization: token };
}
async function capabilities(d: Discovery) {
  const info = await json(`${d.transfer}/info`);
  const cap = object(object(info['deposit-exchange'])[d.code]);
  if (
    cap.enabled !== true ||
    !Array.isArray(cap.funding_methods) ||
    !cap.funding_methods.includes('bank_account')
  )
    throw new AnchorError('The Anchor does not support bank deposits.');
  const fields = object(cap.fields ?? {});
  for (const [name, field] of Object.entries(fields)) {
    if (
      !['type', 'funding_method'].includes(name) &&
      object(field).optional !== true
    )
      throw new AnchorError('The Anchor requires an unsupported deposit field.');
  }
  const { min_amount, max_amount } = cap;
  if (
    (min_amount !== undefined &&
      typeof min_amount !== 'string' &&
      typeof min_amount !== 'number') ||
    (max_amount !== undefined &&
      typeof max_amount !== 'string' &&
      typeof max_amount !== 'number')
  )
    throw new AnchorError('Invalid Anchor amount limit.');
  return { ...cap, min_amount, max_amount };
}
async function balance(wallet: string) {
  const data = await json(`${HORIZON_URL}/accounts/${wallet}`);
  const line = (data.balances as unknown[])
    .map(object)
    .find(
      (b) =>
        b.asset_code === ASSETS.USD.code &&
        b.asset_issuer === ASSETS.USD.issuer,
    );
  if (!line || line.is_authorized !== true)
    throw new AnchorError('An authorized USDC trustline is required.');
  return {
    balance: units(line.balance, 7),
    spendable: units(line.balance, 7) - units(line.selling_liabilities, 7),
    capacity:
      units(line.limit, 7) -
      units(line.balance, 7) -
      units(line.buying_liabilities, 7),
  };
}
function query(base: string, params: Record<string, string>) {
  return `${base}?${new URLSearchParams(params)}`;
}
async function getTransaction(d: Discovery, headers: HeadersInit, id: string) {
  return object(
    (await json(query(`${d.transfer}/transaction`, { id }), { headers }))
      .transaction,
  );
}
function payment(t: Data, wallet: string, d: Discovery) {
  if (
    !['deposit', 'deposit-exchange'].includes(String(t.kind)) ||
    t.to !== wallet ||
    t.amount_in_asset !== 'iso4217:TRY' ||
    t.amount_out_asset !== `stellar:${d.code}:${d.issuer}`
  )
    throw new AnchorError(
      'The Anchor transaction account or asset does not match.',
    );
  const hash =
    typeof t.stellar_transaction_id === 'string' &&
    /^[a-f0-9]{64}$/.test(t.stellar_transaction_id)
      ? t.stellar_transaction_id
      : null;
  return {
    id: identifier(t.id),
    status: text(t, 'status'),
    destination_address: wallet,
    amount_try: tryAmount(t.amount_in),
    amount_usdc:
      t.amount_out == null && t.status !== 'completed'
        ? '0.0000000'
        : decimal(units(t.amount_out, 7), 7),
    stellar_tx_hash: hash,
    settlement: null as string | null,
    spendable: false,
    verification: 'pending',
    instructions: t.instructions ?? null,
  };
}
// Use the documented unfiltered asset history query and select deposit records locally.
async function depositHistory(
  d: Discovery,
  headers: HeadersInit,
  wallet: string,
) {
  const deposits: { id: string; status: string; quote_id?: string }[] = [];
  const cursors = new Set<string>();
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const history = await json(
      query(`${d.transfer}/transactions`, {
        asset_code: d.code,
        limit: '20',
        ...(cursor ? { paging_id: cursor } : {}),
      }),
      { headers },
    );
    if (!Array.isArray(history.transactions))
      throw new AnchorError('Could not load transaction history.');
    const rows = history.transactions.map(object);
    for (const row of rows) {
      if (!['deposit', 'deposit-exchange'].includes(text(row, 'kind')))
        continue;
      if (row.to !== wallet)
        throw new AnchorError('Transaction history account does not match.');
      deposits.push({
        id: identifier(row.id),
        status: text(row, 'status'),
        ...(typeof row.quote_id === 'string' ? { quote_id: row.quote_id } : {}),
      });
    }
    if (rows.length < 20) return deposits;
    cursor = identifier(rows[rows.length - 1].id);
    if (cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  // Never turn a truncated or repeating history into proof that no deposit exists.
  throw new AnchorError('Transaction history could not be fully verified. Try again.');
}
/**
 * An unpaid deposit whose firm quote has expired can never be simulated (see `simulate`),
 * so it is stale: it must not block a new deposit, and the UI offers to start over.
 */
async function staleUnpaid(
  d: Discovery,
  headers: HeadersInit,
  t: { status: string; quote_id?: unknown },
) {
  if (t.status !== 'pending_user_transfer_start' || typeof t.quote_id !== 'string')
    return false;
  const q = await json(`${d.quote}/quote/${identifier(t.quote_id)}`, { headers });
  const expires = Date.parse(text(q, 'expires_at'));
  return Number.isFinite(expires) && expires <= Date.now();
}

export async function demo(request: Request, input: Data) {
  const wallet = account(input.wallet);
  const d = await discovery();
  if (input.action === 'challenge') {
    const result = await json(
      query(d.auth, { account: wallet, home_domain: d.home }),
    );
    if (
      result.network_passphrase !== undefined &&
      result.network_passphrase !== d.network
    )
      throw new AnchorError('Anchor challenge network does not match.');
    validateChallenge(text(result, 'transaction'), d, wallet);
    return { transaction: result.transaction, discovery: d };
  }
  if (input.action === 'auth') {
    const transaction = text(input, 'transaction');
    validateChallenge(transaction, d, wallet);
    const result = await json(
      d.auth,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction }),
      },
      true,
    );
    tokenSession(text(result, 'token'), wallet, d);
    return { token: result.token, discovery: d };
  }
  const headers = bearer(request);
  tokenSession(headers.Authorization.slice(7), wallet, d);
  if (input.action === 'history') {
    const history = await depositHistory(d, headers, wallet);
    return { transactions: history.map(({ id, status }) => ({ id, status })) };
  }
  if (input.action === 'prepare') {
    const cap = await capabilities(d);
    let kyc = await json(query(`${d.kyc}/customer`, { account: wallet }), {
      headers,
    });
    if (kyc.status === 'NEEDS_INFO') {
      if (
        Object.values(object(kyc.fields ?? {})).some(
          (field) => object(field).optional !== true,
        )
      )
        throw new AnchorError(
          'The Anchor asks for personal data; simulated KYC cannot continue.',
        );
      await json(
        `${d.kyc}/customer`,
        {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{}',
        },
        true,
      );
      kyc = await json(query(`${d.kyc}/customer`, { account: wallet }), {
        headers,
      });
    }
    if (kyc.status !== 'ACCEPTED')
      throw new AnchorError(
        'Simulated KYC was not approved; do not send personal data.',
      );
    return {
      discovery: d,
      min_try: '50.00',
      max_try: '3000.00',
      min_usdc: cap.min_amount === undefined ? undefined : String(cap.min_amount),
      max_usdc: cap.max_amount === undefined ? undefined : String(cap.max_amount),
      mock_bank:
        d.home === HOME_DOMAIN &&
        d.network === 'Test SDF Network ; September 2015',
    };
  }
  if (input.action === 'quote') {
    const amount = tryAmount(input.amount_try);
    const cap = await capabilities(d);
    const q = await json(
      `${d.quote}/quote`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sell_asset: 'iso4217:TRY',
          buy_asset: `stellar:${d.code}:${d.issuer}`,
          sell_amount: amount,
          sell_delivery_method: 'bank_account',
          country_code: 'TUR',
          context: 'sep6',
        }),
      },
      true,
    );
    const result = validateQuote(q, d, amount);
    const out = units(result.destination_amount, 7);
    if (
      (cap.min_amount !== undefined && out < units(String(cap.min_amount), 7)) ||
      (cap.max_amount !== undefined && out > units(String(cap.max_amount), 7))
    )
      throw new AnchorError('The quoted USDC amount is outside the Anchor limits.');
    return result;
  }
  if (input.action === 'simulate') {
    if (
      d.home !== HOME_DOMAIN ||
      d.network !== 'Test SDF Network ; September 2015'
    )
      throw new AnchorError(
        'Bank simulation is only available on the mock testnet Anchor.',
      );
    const id = identifier(input.id);
    const raw = await getTransaction(d, headers, id);
    const t = payment(raw, wallet, d);
    if (t.id !== id) throw new AnchorError('Anchor transaction ID does not match.');
    if (t.status !== 'pending_user_transfer_start') return t;
    // The mock can fall back to a live rate for expired quotes: block that path.
    const quoteId = identifier(raw.quote_id);
    validateQuote(
      await json(`${d.quote}/quote/${quoteId}`, { headers }),
      d,
      t.amount_try,
    );
    await json(
      `${d.transfer}/tx/${id}/simulate-bank-transfer`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: t.amount_try }),
      },
      true,
    );
    return { id };
  }
  throw new AnchorError('Invalid Anchor action.');
}
export async function startOnramp(request: Request, input: Data) {
  const wallet = account(input.wallet),
    d = await discovery(),
    headers = bearer(request);
  tokenSession(headers.Authorization.slice(7), wallet, d);
  const qid = identifier(input.quote_id);
  const cap = await capabilities(d);
  const q = validateQuote(
    await json(`${d.quote}/quote/${qid}`, { headers }),
    d,
    input.amount_try,
  );
  const out = units(q.destination_amount, 7);
  if (
    (cap.min_amount !== undefined && out < units(String(cap.min_amount), 7)) ||
    (cap.max_amount !== undefined && out > units(String(cap.max_amount), 7))
  )
    throw new AnchorError('USDC amount is outside the Anchor limits.');
  for (const pending of (await depositHistory(d, headers, wallet)).filter(
    (t) => !terminal(t.status),
  )) {
    if (!(await staleUnpaid(d, headers, pending)))
      throw new AnchorError(
        `A pending deposit exists: ${identifier(pending.id)}. Check that transaction.`,
      );
  }
  const before = await balance(wallet);
  if (before.capacity < out)
    throw new AnchorError('USDC trustline limiti yetersiz.');
  // SEP-6 deposit-exchange uses GET but creates an order. Never retry this request.
  const result = await json(
    query(`${d.transfer}/deposit-exchange`, {
      destination_asset: d.code,
      source_asset: 'iso4217:TRY',
      amount: q.source_amount,
      account: wallet,
      quote_id: q.id,
      funding_method: 'bank_account',
      type: 'bank_account',
      claimable_balance_supported: 'false',
    }),
    { headers },
    true,
  );
  let instructions: Record<string, { value: string }>;
  try {
    const fields = object(result.instructions);
    instructions = Object.fromEntries(
      ['bank_name', 'bank_account_number', 'external_transfer_memo'].map(
        (key) => {
          const value = text(object(fields[key]), 'value');
          if (!value.trim()) throw new Error('empty');
          return [key, { value }];
        },
      ),
    );
  } catch {
    // Creation may have succeeded: the client retains its unknown-outcome journal.
    throw new AnchorError(
      'Invalid Anchor deposit instructions. Check the existing deposit before creating a new one.',
    );
  }
  return {
    id: identifier(result.id),
    status: 'pending_user_transfer_start',
    destination_address: wallet,
    amount_try: q.source_amount,
    amount_usdc: q.destination_amount,
    stellar_tx_hash: null,
    settlement: null,
    spendable: false,
    instructions,
  };
}
export async function onrampStatus(request: Request) {
  const params = new URL(request.url).searchParams;
  const wallet = account(params.get('wallet')),
    id = identifier(params.get('id')),
    d = await discovery(),
    headers = bearer(request);
  tokenSession(headers.Authorization.slice(7), wallet, d);
  const t = await getTransaction(d, headers, id);
  const result = payment(t, wallet, d);
  if (result.id !== id)
    throw new AnchorError('Anchor transaction ID does not match.');
  if (result.status !== 'completed' || !result.stellar_tx_hash)
    return {
      ...result,
      stale: await staleUnpaid(d, headers, { status: result.status, quote_id: t.quote_id }),
    };
  // Settlement may be read after expiry, but must still match the original firm quote.
  const lockedQuote = validateQuote(
    await json(`${d.quote}/quote/${identifier(t.quote_id)}`, { headers }),
    d,
    result.amount_try,
    true,
  );
  if (lockedQuote.destination_amount !== result.amount_usdc)
    throw new AnchorError('Delivered amount does not match the locked quote.');
  const hash = result.stellar_tx_hash;
  const [tx, operations] = await Promise.all([
    json(`${HORIZON_URL}/transactions/${hash}`),
    json(`${HORIZON_URL}/transactions/${hash}/operations?limit=200`),
  ]);
  const records = object(operations._embedded).records;
  if (!Array.isArray(records))
    throw new AnchorError('Could not load Stellar transaction records.');
  const paid = records
    .map(object)
    .filter(
      (op) =>
        op.type === 'payment' &&
        op.transaction_successful === true &&
        op.to === wallet &&
        op.asset_code === d.code &&
        op.asset_issuer === d.issuer,
    );
  const expected = units(result.amount_usdc, 7);
  if (tx.successful !== true || tx.hash !== hash)
    throw new AnchorError('Could not verify the Stellar transaction.');
  if (
    !paid.length &&
    records.map(object).some((op) => op.type === 'create_claimable_balance')
  )
    return {
      ...result,
      settlement: 'claimable_balance',
      verification: 'manual_recovery_required',
    };
  if (paid.length !== 1 || units(paid[0].amount, 7) !== expected)
    throw new AnchorError(
      'Stellar payment account, asset or amount does not match.',
    );
  const after = await balance(wallet);
  const verified = after.spendable >= expected;
  return {
    ...result,
    settlement: 'payment',
    verification: verified ? 'verified' : 'awaiting_usable_balance',
    spendable: verified,
    usdc_after: decimal(after.balance, 7),
  };
}
export async function handle(
  request: Request,
  operation: () => Promise<unknown>,
) {
  try {
    const origin = request.headers.get('origin');
    if (
      (origin && origin !== new URL(request.url).origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      throw new AnchorError('Origin does not match.');
    return Response.json(await operation(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    // Only local messages; upstream bodies, tokens and signed challenges are never logged/echoed.
    return Response.json(
      {
        error: {
          code:
            error instanceof AnchorError
              ? error.message
              : 'Anchor request failed.',
          ...(process.env.NODE_ENV === 'development' &&
          error instanceof AnchorError &&
          error.diagnostic
            ? { diagnostic: error.diagnostic }
            : {}),
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
export async function body(request: Request): Promise<Data> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new AnchorError('JSON required.');
  const raw = await request.text();
  if (raw.length > 16000) throw new AnchorError('Request too large.');
  return object(JSON.parse(raw));
}
