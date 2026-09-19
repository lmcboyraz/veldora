import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const contract = JSON.parse(
  readFileSync(
    new URL('./fixtures/tr-mock-anchor-contract.json', import.meta.url),
    'utf8',
  ),
);
const instructions = {
  bank_name: { value: 'TR Mock Bank' },
  bank_account_number: { value: 'TR-TEST' },
  external_transfer_memo: { value: 'TEST-REF' },
};
import { registerHooks } from 'node:module';
import { StellarToml, Keypair } from '@stellar/stellar-sdk';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only')
      return { url: 'data:text/javascript,export {}', shortCircuit: true };
    if (
      context.parentURL?.includes('/lib/anchor/') &&
      (specifier === '../config' || specifier === './sep')
    )
      return next(specifier + '.ts', context);
    return next(specifier, context);
  },
});
const { demo, startOnramp, onrampStatus, handle } =
  await import('../lib/anchor/server.ts');
const { ASSETS, NETWORK_PASSPHRASE, HORIZON_URL } =
  await import('../lib/config.ts');
const wallet = Keypair.random().publicKey(),
  signing = Keypair.random().publicKey();
const base = 'https://tr-mock-anchor.fly.dev';
const token = `e30.${Buffer.from(JSON.stringify({ sub: wallet, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
const request = (id = 'sep_test') =>
  new Request(
    `https://veldora.example/api/anchor/onramp?wallet=${wallet}&id=${id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
const q = () => ({
  id: 'q_test',
  sell_asset: 'iso4217:TRY',
  buy_asset: `stellar:USDC:${ASSETS.USD.issuer}`,
  sell_amount: '100.00',
  buy_amount: '2.0000000',
  price: '49.75',
  expires_at: new Date(Date.now() + 60000).toISOString(),
  fee: { total: '0.50', asset: 'iso4217:TRY' },
});
const tx = () => ({
  id: 'sep_test',
  kind: 'deposit',
  to: wallet,
  quote_id: 'q_test',
  amount_in: '100.00',
  amount_out: '2.0000000',
  amount_in_asset: 'iso4217:TRY',
  amount_out_asset: `stellar:USDC:${ASSETS.USD.issuer}`,
  status: 'pending_user_transfer_start',
});
const cap = contract.sep6_info;
const line = {
  asset_code: 'USDC',
  asset_issuer: ASSETS.USD.issuer,
  is_authorized: true,
  balance: '10.0000000',
  selling_liabilities: '0.0000000',
  buying_liabilities: '0.0000000',
  limit: '1000.0000000',
};
async function withAnchor(handler, run) {
  const oldFetch = globalThis.fetch,
    oldResolve = Object.getOwnPropertyDescriptor(
      StellarToml.Resolver,
      'resolve',
    ).value;
  StellarToml.Resolver.resolve = async () => ({
    NETWORK_PASSPHRASE,
    SIGNING_KEY: signing,
    CURRENCIES: [{ code: 'USDC', issuer: ASSETS.USD.issuer }],
    WEB_AUTH_ENDPOINT: base + '/auth',
    TRANSFER_SERVER: base + '/sep6',
    KYC_SERVER: base + '/sep12',
    ANCHOR_QUOTE_SERVER: base + '/sep38',
  });
  globalThis.fetch = async (url, init = {}) => {
    const result = await handler(new URL(url), init);
    return result instanceof Response ? result : Response.json(result);
  };
  try {
    await run();
  } finally {
    globalThis.fetch = oldFetch;
    StellarToml.Resolver.resolve = oldResolve;
  }
}
// Live /sep6/info on 2026-09-19 omits both limits. /sep38/price for
// 50.00 TRY returned string amounts 50.00 / 1.0198045 (not a firm quote).
test('quote accepts omitted capability limits and still enforces supplied limits', async () => {
  for (const [limits, expected] of [
    [{}, 200],
    [{ min_amount: 0.5 }, 200],
    [{ max_amount: 300 }, 200],
    [{ min_amount: 1.0198045, max_amount: 1.0198045 }, 200],
    [{ min_amount: 1.0198046 }, 400],
    [{ max_amount: 1.0198044 }, 400],
    [{ min_amount: null }, 400],
    [{ max_amount: 'invalid' }, 400],
  ]) {
    const info = structuredClone(cap);
    delete info['deposit-exchange'].USDC.min_amount;
    delete info['deposit-exchange'].USDC.max_amount;
    Object.assign(info['deposit-exchange'].USDC, limits);
    await withAnchor(
      (u, init) => {
        if (u.pathname === '/sep6/info') return info;
        if (u.pathname === '/sep38/quote') {
          assert.equal(JSON.parse(init.body).sell_amount, '50.00');
          return { ...q(), sell_amount: '50.00', buy_amount: '1.0198045' };
        }
        throw Error('Unexpected endpoint ' + u.pathname);
      },
      async () => {
        const response = await handle(request(), () =>
          demo(request(), { action: 'quote', wallet, amount_try: '50.00' }),
        );
        const result = await response.json();
        assert.equal(response.status, expected, JSON.stringify({ limits, result }));
        if (expected === 200) {
          assert.equal(result.source_amount, '50.00');
          assert.equal(result.destination_amount, '1.0198045');
        }
      },
    );
  }
});
test('prepare rejects nonnumeric capability limit types instead of stringifying them', async () => {
  for (const name of ['min_amount', 'max_amount']) {
    for (const value of [null, true, [], {}]) {
      const info = structuredClone(cap);
      info['deposit-exchange'].USDC[name] = value;
      await withAnchor(
        (u) => {
          if (u.pathname === '/sep6/info') return info;
          if (u.pathname === '/sep12/customer') return { status: 'ACCEPTED' };
          throw Error('Unexpected endpoint ' + u.pathname);
        },
        async () => {
          await assert.rejects(
            () => demo(request(), { action: 'prepare', wallet }),
            /Invalid Anchor amount limit/,
          );
        },
      );
    }
  }
});
test('SEP-12 sends empty simulated KYC and verifies acceptance', async () => {
  let accepted = false;
  await withAnchor(
    (u, i) => {
      if (u.pathname === '/sep6/info') return cap;
      if (u.pathname === '/sep12/customer') {
        if (i.method === 'PUT') {
          assert.equal(i.body, '{}');
          accepted = true;
          return { id: 'customer' };
        }
        return accepted
          ? { status: 'ACCEPTED' }
          : {
              status: 'NEEDS_INFO',
              fields: { first_name: { optional: true } },
            };
      }
      throw Error('Unexpected endpoint');
    },
    async () => {
      assert.equal(
        (await demo(request(), { action: 'prepare', wallet })).mock_bank,
        true,
      );
      assert.equal(accepted, true);
    },
  );
});
test('prepare and deposit accept absent limits without weakening quote or amount checks', async () => {
  const info = structuredClone(cap);
  delete info['deposit-exchange'].USDC.min_amount;
  delete info['deposit-exchange'].USDC.max_amount;
  let creates = 0;
  await withAnchor(
    (u) => {
      if (u.pathname === '/sep6/info') return info;
      if (u.pathname === '/sep12/customer') return { status: 'ACCEPTED' };
      if (u.pathname === '/sep38/quote/q_test') return q();
      if (u.pathname === '/sep6/transactions') return { transactions: [] };
      if (u.origin === HORIZON_URL) return { balances: [line] };
      if (u.pathname === '/sep6/deposit-exchange') {
        assert.equal(u.searchParams.get('amount'), '100.00');
        assert.equal(u.searchParams.get('quote_id'), 'q_test');
        creates++;
        return { id: 'sep_test', instructions };
      }
      throw Error('Unexpected endpoint ' + u.pathname);
    },
    async () => {
      const prepared = await demo(request(), { action: 'prepare', wallet });
      assert.equal(prepared.min_usdc, undefined);
      assert.equal(prepared.max_usdc, undefined);
      for (const amount_try of ['49.99', '3000.01', '50.001', '99.00']) {
        await assert.rejects(() => startOnramp(request(), {
          wallet, quote_id: 'q_test', amount_try,
        }));
      }
      assert.equal(creates, 0);
      assert.equal((await startOnramp(request(), {
        wallet, quote_id: 'q_test', amount_try: '100',
      })).amount_try, '100.00');
      assert.equal(creates, 1);
    },
  );
});
test('deposit-exchange binds quote ID and exact TRY input; pending order blocks another deposit', async () => {
  let creates = 0,
    pending = false;
  await withAnchor(
    (u) => {
      if (u.pathname === '/sep6/info') return cap;
      if (u.pathname === '/sep38/quote/q_test') return q();
      if (u.pathname === '/sep6/transactions')
        return { transactions: pending ? [tx()] : [] };
      if (u.origin === HORIZON_URL && u.pathname.startsWith('/accounts/'))
        return { balances: [line] };
      if (u.pathname === '/sep6/deposit-exchange') {
        if (
          !Object.hasOwn(
            cap['deposit-exchange'],
            u.searchParams.get('destination_asset'),
          )
        )
          return Response.json(
            { error: contract.user_observed_error.error },
            { status: contract.user_observed_error.status },
          );
        assert.equal(u.searchParams.get('quote_id'), 'q_test');
        assert.equal(u.searchParams.get('amount'), '100.00');
        for (const [key, value] of Object.entries(contract.exchange_request))
          assert.equal(u.searchParams.get(key), value);
        assert.ok(
          cap['deposit-exchange'][u.searchParams.get('destination_asset')]
            .enabled,
        );
        assert.deepEqual(
          [...u.searchParams.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
          [
            'account',
            'amount',
            'claimable_balance_supported',
            'destination_asset',
            'funding_method',
            'quote_id',
            'source_asset',
            'type',
          ].sort(),
        );
        creates++;
        return { id: 'sep_test', instructions };
      }
      throw Error('Unexpected endpoint ' + u.pathname);
    },
    async () => {
      assert.equal(
        (
          await startOnramp(request(), {
            wallet,
            quote_id: 'q_test',
            amount_try: '100',
          })
        ).id,
        'sep_test',
      );
      pending = true;
      await assert.rejects(
        () =>
          startOnramp(request(), {
            wallet,
            quote_id: 'q_test',
            amount_try: '100',
          }),
        /pending deposit exists/,
      );
      assert.equal(creates, 1);
    },
  );
});
test('expired firm quote prevents bank simulation; polling never creates deposits', async () => {
  let mutations = 0;
  await withAnchor(
    (u, i) => {
      if (i.method === 'POST') mutations++;
      if (u.pathname === '/sep6/transaction') return { transaction: tx() };
      if (u.pathname === '/sep38/quote/q_test')
        return { ...q(), expires_at: '2000-01-01' };
      throw Error('Unexpected endpoint');
    },
    async () => {
      await assert.rejects(
        () => demo(request(), { action: 'simulate', wallet, id: 'sep_test' }),
        /expired/,
      );
      const status = await onrampStatus(request());
      assert.equal(status.spendable, false);
      assert.equal(status.stale, true);
      assert.equal(mutations, 0);
    },
  );
});
test('an unpaid deposit whose firm quote expired no longer blocks a new deposit', async () => {
  let creates = 0;
  await withAnchor(
    (u) => {
      if (u.pathname === '/sep6/info') return cap;
      if (u.pathname === '/sep38/quote/q_test') return q();
      if (u.pathname === '/sep38/quote/q_old')
        return { ...q(), id: 'q_old', expires_at: '2000-01-01' };
      if (u.pathname === '/sep6/transactions')
        return { transactions: [{ ...tx(), id: 'sep_old', quote_id: 'q_old' }] };
      if (u.pathname.startsWith('/accounts/')) return { balances: [line] };
      if (u.pathname === '/sep6/deposit-exchange') {
        creates++;
        return { id: 'sep_new', instructions };
      }
      throw Error('Unexpected endpoint ' + u.pathname);
    },
    async () => {
      const created = await startOnramp(request(), {
        wallet,
        quote_id: 'q_test',
        amount_try: '100',
      });
      assert.equal(created.id, 'sep_new');
      assert.equal(creates, 1);
    },
  );
});
test('on-chain payment verifies exact destination/issuer/amount; unclaimed balance stays blocked', async () => {
  const hash = 'a'.repeat(64);
  let mode = 'payment';
  await withAnchor(
    (u) => {
      if (u.pathname === '/sep6/transaction')
        return {
          transaction: {
            ...tx(),
            status: 'completed',
            stellar_transaction_id: hash,
          },
        };
      if (u.pathname === '/sep38/quote/q_test')
        return { ...q(), expires_at: '2000-01-01' };
      if (u.pathname === `/transactions/${hash}`)
        return { successful: true, hash };
      if (u.pathname.endsWith('/operations'))
        return {
          _embedded: {
            records: [
              mode === 'claim'
                ? { type: 'create_claimable_balance' }
                : {
                    type: 'payment',
                    transaction_successful: true,
                    to: mode === 'wrong' ? signing : wallet,
                    asset_code: 'USDC',
                    asset_issuer: ASSETS.USD.issuer,
                    amount: '2.0000000',
                  },
            ],
          },
        };
      if (u.pathname.startsWith('/accounts/')) {
        assert.notEqual(
          mode,
          'claim',
          'Claimable balance verification must not require a trustline',
        );
        return { balances: [line] };
      }
      throw Error('Unexpected endpoint');
    },
    async () => {
      assert.equal((await onrampStatus(request())).verification, 'verified');
      mode = 'wrong';
      await assert.rejects(() => onrampStatus(request()), /does not match/);
      mode = 'claim';
      const result = await onrampStatus(request());
      assert.equal(result.spendable, false);
      assert.equal(result.settlement, 'claimable_balance');
    },
  );
});

test('history forwards exact SEP-6 URL and maps HTTP 200 empty/nonempty bodies without writes', async () => {
  let transactions = [];
  await withAnchor(
    (url, init) => {
      assert.equal(
        url.href,
        base + '/sep6/transactions?asset_code=USDC&limit=20',
      );
      assert.equal(init.method ?? 'GET', 'GET');
      assert.ok(init.headers.Authorization.startsWith('Bearer '));
      return Response.json({ transactions }, { status: 200 });
    },
    async () => {
      assert.deepEqual(await demo(request(), { action: 'history', wallet }), {
        transactions: [],
      });
      transactions = [tx()];
      assert.deepEqual(await demo(request(), { action: 'history', wallet }), {
        transactions: [
          { id: 'sep_test', status: 'pending_user_transfer_start' },
        ],
      });
    },
  );
});

test('history HTTP failure or malformed body is never converted into an empty history', async () => {
  for (const response of [
    Response.json({ error: 'unavailable' }, { status: 503 }),
    Response.json({ unexpected: [] }),
  ]) {
    await withAnchor(
      () => response,
      async () => {
        await assert.rejects(
          () => demo(request(), { action: 'history', wallet }),
          /503|Could not load transaction history/,
        );
      },
    );
  }
});

test('recovery scans pages without excluding deposit-exchange and ignores withdrawals', async () => {
  let pages = 0;
  await withAnchor(
    (url) => {
      assert.equal(url.searchParams.has('kind'), false);
      pages++;
      if (!url.searchParams.has('paging_id'))
        return {
          transactions: Array.from({ length: 20 }, (_, i) => ({
            ...tx(),
            id: `withdraw_${i}`,
            kind: 'withdrawal',
          })),
        };
      assert.equal(url.searchParams.get('paging_id'), 'withdraw_19');
      return { transactions: [{ ...tx(), kind: 'deposit-exchange' }] };
    },
    async () => {
      assert.deepEqual(await demo(request(), { action: 'history', wallet }), {
        transactions: [
          { id: 'sep_test', status: 'pending_user_transfer_start' },
        ],
      });
      assert.equal(pages, 2);
    },
  );
});

test('incomplete pagination or wrong-account deposits never establish empty scoped history', async () => {
  for (const wrongAccount of [false, true]) {
    await withAnchor(
      () => ({
        transactions: wrongAccount
          ? [{ ...tx(), to: signing }]
          : Array.from({ length: 20 }, (_, i) => ({
              ...tx(),
              id: `repeat_${i}`,
              kind: 'withdrawal',
            })),
      }),
      async () => {
        await assert.rejects(
          () => demo(request(), { action: 'history', wallet }),
          /history|account/,
        );
      },
    );
  }
});

test('failed recovery preserves the Anchor error field and exact request without exposing credentials', async () => {
  // Fixture verifies diagnostic preservation; this is not a claimed live error.
  const reason = 'fixture: transaction not found';
  await withAnchor(
    () => Response.json({ error: reason }, { status: 400 }),
    async () => {
      await assert.rejects(
        () => onrampStatus(request()),
        (error) => {
          assert.equal(error.upstreamReason, reason);
          assert.deepEqual(error.diagnostic, {
            method: 'GET',
            endpoint: base + '/sep6/transaction?id=sep_test',
            status: 400,
            reason,
          });
          assert.ok(!JSON.stringify(error.diagnostic).includes(token));
          return true;
        },
      );
    },
  );
});

test('development diagnostics redact secrets; production does not return upstream details', async () => {
  const before = process.env.NODE_ENV;
  try {
    await withAnchor(
      () => Response.json({ error: `fixture error ${token}` }, { status: 400 }),
      async () => {
        process.env.NODE_ENV = 'development';
        const dev = await (
          await handle(request(), () => onrampStatus(request()))
        ).json();
        assert.equal(dev.error.diagnostic.status, 400);
        assert.equal(dev.error.diagnostic.reason, 'fixture error [redacted]');
        assert.ok(!JSON.stringify(dev).includes(token));
        process.env.NODE_ENV = 'production';
        const prod = await (
          await handle(request(), () => onrampStatus(request()))
        ).json();
        assert.equal(prod.error.diagnostic, undefined);
        assert.ok(!JSON.stringify(prod).includes('fixture error'));
      },
    );
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

test('bank simulation rejects a transaction ID mismatch before any simulated transfer', async () => {
  let writes = 0;
  await withAnchor(
    (u, i) => {
      if (i.method === 'POST') {
        writes++;
        return {};
      }
      if (u.pathname === '/sep6/transaction')
        return { transaction: { ...tx(), id: 'sep_different' } };
      if (u.pathname === '/sep38/quote/q_test') return q();
      throw Error('Unexpected endpoint');
    },
    async () => {
      await assert.rejects(
        () => demo(request(), { action: 'simulate', wallet, id: 'sep_test' }),
        /transaction ID/,
      );
      assert.equal(writes, 0);
    },
  );
});

test('malformed bank instructions do not become a successful deposit instruction screen', async () => {
  await withAnchor(
    (u) => {
      if (u.pathname === '/sep6/info') return cap;
      if (u.pathname === '/sep38/quote/q_test') return q();
      if (u.pathname === '/sep6/transactions') return { transactions: [] };
      if (u.pathname.startsWith('/accounts/')) return { balances: [line] };
      if (u.pathname === '/sep6/deposit-exchange')
        return { id: 'sep_test', instructions: {} };
      throw Error('Unexpected endpoint');
    },
    async () => {
      await assert.rejects(
        () =>
          startOnramp(request(), {
            wallet,
            quote_id: 'q_test',
            amount_try: '100',
          }),
        /instructions/,
      );
    },
  );
});
