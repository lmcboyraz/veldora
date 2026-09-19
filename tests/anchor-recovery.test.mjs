import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

// Exercise the actual card's event handlers with Node's existing test runner.
// These minimal hooks record state; no DOM, wallet extension or new test dependency.
let slots = [],
  cursor = 0,
  effects = [],
  cleanups = [];
const sameDeps = (a, b) =>
  a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const hookModule = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots))
      slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      slots[index],
      (value) => {
        slots[index] =
          typeof value === 'function' ? value(slots[index]) : value;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    return (slots[index] ??= { current: initial });
  },
  useCallback(fn, deps) {
    const index = cursor++;
    if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { fn, deps };
    return slots[index].fn;
  },
  useEffect(fn, deps) {
    const index = cursor++;
    if (!sameDeps(slots[index], deps)) {
      slots[index] = deps;
      effects.push(() => {
        cleanups[index]?.();
        cleanups[index] = fn();
      });
    }
  },
};
globalThis.__anchorTestHooks = hookModule;
const sourceUrl = new URL(
  '../components/anchor-onramp-card.tsx',
  import.meta.url,
);
const moduleUrl = (source) =>
  'data:text/javascript,' + encodeURIComponent(source);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourceUrl.href) {
      if (specifier === 'react')
        return {
          url: moduleUrl(
            'export const {useState,useRef,useCallback,useEffect}=globalThis.__anchorTestHooks;',
          ),
          shortCircuit: true,
        };
      if (specifier.startsWith('@/components/ui/')) {
        return {
          url: moduleUrl(
            "export const Card='Card',CardContent='CardContent',CardDescription='CardDescription',CardHeader='CardHeader',CardTitle='CardTitle',Button='Button',Input='Input';",
          ),
          shortCircuit: true,
        };
      }
      if (specifier === '@/lib/config')
        return next(new URL('../lib/config.ts', import.meta.url).href, context);
      if (specifier === '@/lib/wallet')
        return {
          url: moduleUrl(
            "export async function assertAnchorWallet(){}; export async function signTransactionXdr(){return 'signed';}",
          ),
          shortCircuit: true,
        };
      if (specifier === '@/lib/trustline')
        return {
          url: moduleUrl(
            "export async function checkTrustline(){return {state:'present'}}; export async function ensureTrustline(){};",
          ),
          shortCircuit: true,
        };
      if (specifier === '@/lib/anchor/sep')
        return {
          url: moduleUrl(
            `export * from ${JSON.stringify(new URL('../lib/anchor/sep.ts', import.meta.url).href)}; export function validateChallenge(){return {hash:()=>new Uint8Array([1])}};`,
          ),
          shortCircuit: true,
        };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === sourceUrl.href)
      return {
        format: 'module',
        source: ts.transpileModule(readFileSync(sourceUrl, 'utf8'), {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { AnchorOnrampCard } = await import(sourceUrl.href);
const { NETWORK_PASSPHRASE } = await import('../lib/config.ts');
const wallet = 'test-wallet';
const journal = `rise:anchor:tr-mock-anchor.fly.dev:${NETWORK_PASSPHRASE}:${wallet}`;
const token = `e30.${Buffer.from(JSON.stringify({ sub: wallet, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
function nodes(tree) {
  return !tree || typeof tree !== 'object'
    ? []
    : Array.isArray(tree)
      ? tree.flatMap(nodes)
      : [tree, ...nodes(tree.props?.children)];
}
function label(node) {
  const c = node?.props?.children;
  return Array.isArray(c) ? c.filter((x) => typeof x === 'string').join('') : c;
}

let verifiedCalls = 0,
  continueCalls = 0;
function render() {
  cursor = 0;
  return AnchorOnrampCard({
    wallet,
    onVerified: () => verifiedCalls++,
    onContinue: () => continueCalls++,
  });
}
function content(tree = render()) {
  return nodes(tree)
    .flatMap((n) => {
      const c = n.props?.children;
      return (Array.isArray(c) ? c : [c]).filter((x) => typeof x === 'string');
    })
    .join(' ');
}
function findButton(name) {
  return nodes(render()).find((n) => n.type === 'Button' && label(n) === name);
}
function button(name) {
  const n = findButton(name);
  assert.ok(n, `Missing button ${name}`);
  return n;
}
function input() {
  return nodes(render()).find((n) => n.props?.['aria-label'] === 'TRY amount');
}
function alert() {
  return nodes(render()).find((n) => n.props?.role === 'alert');
}
async function flush() {
  for (let i = 0; i < 8; i++) {
    render();
    const pending = effects;
    effects = [];
    pending.forEach((fn) => fn());
    await new Promise((resolve) => setImmediate(resolve));
  }
}
async function click(name) {
  const n = button(name);
  assert.equal(!!n.props.disabled, false, `${name} disabled`);
  await n.props.onClick();
  await flush();
}
const create = 'Continue to deposit';
const payment = (extra = {}) => ({
  id: 'sep_existing',
  status: 'pending_user_transfer_start',
  amount_try: '50.00',
  amount_usdc: '1.02',
  destination_address: wallet,
  settlement: null,
  stellar_tx_hash: null,
  instructions: {
    bank_name: { value: 'Mock Bank' },
    bank_account_number: { value: 'TR-TEST-IBAN' },
    external_transfer_memo: { value: 'TEST-REF' },
  },
  ...extra,
});
async function scenario(options, run) {
  const originalFetch = globalThis.fetch,
    originalStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    );
  const originalNow = Date.now,
    originalInterval = globalThis.setInterval,
    originalClearInterval = globalThis.clearInterval,
    originalTimeout = globalThis.setTimeout,
    originalClearTimeout = globalThis.clearTimeout;
  let clock = originalNow(),
    timerId = 0;
  const timers = new Map();
  let creates = 0,
    reads = 0,
    historyReads = 0,
    quoteReads = 0,
    current = payment();
  const storage = new Map(options.storage ?? []);
  if (options.saved) storage.set(journal, options.saved);
  slots = [];
  effects = [];
  cleanups = [];
  verifiedCalls = 0;
  continueCalls = 0;
  Date.now = () => clock;
  globalThis.setInterval = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, delay, interval: true, at: clock + delay });
    return id;
  };
  globalThis.setTimeout = (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, at: clock + delay });
    return id;
  };
  globalThis.clearInterval = globalThis.clearTimeout = (id) =>
    timers.delete(id);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });
  globalThis.fetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (body.action === 'challenge')
      return Response.json({ transaction: 'challenge', discovery: {} });
    if (body.action === 'auth')
      return Response.json({
        token,
        discovery: {
          network: NETWORK_PASSPHRASE,
          home: 'tr-mock-anchor.fly.dev',
        },
      });
    if (body.action === 'prepare') return Response.json({ mock_bank: true });
    if (body.action === 'quote') {
      quoteReads++;
      return Response.json({
        id: `q_${quoteReads}`,
        source_amount: body.amount_try,
        destination_amount: '1.02',
        rate: '49',
        fee: { total: '0.25', asset: 'iso4217:TRY' },
        expires_at: new Date(clock + 60000).toISOString(),
      });
    }
    if (body.action === 'history') {
      historyReads++;
      return options.historyError
        ? Response.json(
            {
              error: {
                code: 'Anchor rejected the request (503).',
                diagnostic: options.diagnostic,
              },
            },
            { status: 400 },
          )
        : Response.json({ transactions: options.history ?? [] });
    }
    if (body.action === 'simulate') {
      current = payment({ status: 'pending_anchor' });
      return Response.json({ id: current.id });
    }
    if (path.startsWith('/api/anchor/onramp?')) {
      reads++;
      if (options.transactionError)
        return Response.json(
          {
            error: {
              code: 'Anchor rejected the request (400).',
              diagnostic: options.diagnostic,
            },
          },
          { status: 400 },
        );
      return Response.json(
        typeof options.transaction === 'function'
          ? options.transaction()
          : (options.transaction ?? current),
      );
    }
    if (path === '/api/anchor/onramp') {
      creates++;
      if (options.createError) throw new Error('The result is uncertain.');
      assert.equal(
        body.quote_id,
        `q_${quoteReads}`,
        'deposit uses latest firm quote',
      );
      return Response.json(current);
    }
    throw Error('Unexpected request');
  };
  const advance = async (ms) => {
    clock += ms;
    for (const [id, t] of Array.from(timers))
      if (t.at <= clock) {
        if (t.interval) t.at = clock + t.delay;
        else timers.delete(id);
        t.fn();
      }
    await flush();
  };
  try {
    await flush();
    await run({
      storage,
      creates: () => creates,
      reads: () => reads,
      historyReads: () => historyReads,
      quoteReads: () => quoteReads,
      advance,
    });
  } finally {
    cleanups.forEach((fn) => fn?.());
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClearInterval;
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (originalStorage)
      Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
  }
}
test('fresh visit shows amount and wallet CTA without a red error', async () => {
  await scenario({}, async () => {
    assert.ok(input());
    assert.equal(alert(), undefined);
    assert.equal(button('Continue with wallet').props.disabled, false);
    assert.match(content(), /How much do you want to deposit/);
  });
});
test('persisted unknown is explanatory recovery and authentication automatically checks history', async () => {
  await scenario({ saved: 'unknown' }, async ({ creates, historyReads }) => {
    assert.equal(alert(), undefined);
    assert.match(content(), /Let's check your previous deposit/);
    assert.equal(creates(), 0);
    await click('Continue with wallet');
    assert.equal(historyReads(), 1);
    assert.equal(creates(), 0);
  });
});
test('successful scoped empty history removes unknown and restores amount and quote flow', async () => {
  await scenario({ saved: 'unknown' }, async ({ storage, creates }) => {
    await click('Continue with wallet');
    assert.equal(storage.has(journal), false);
    assert.ok(input());
    assert.equal(alert(), undefined);
    await click('Show price');
    assert.equal(button(create).props.disabled, false);
    assert.equal(creates(), 0);
  });
});
test('existing deposit-exchange is loaded automatically instead of creating a duplicate', async () => {
  await scenario(
    {
      saved: 'unknown',
      history: [{ id: 'sep_existing', status: 'pending_user_transfer_start' }],
    },
    async ({ storage, creates, reads }) => {
      await click('Continue with wallet');
      assert.equal(storage.get(journal), 'sep_existing');
      assert.ok(reads() > 0);
      assert.equal(creates(), 0);
      assert.equal(findButton(create), undefined);
      assert.match(content(), /TR-TEST-IBAN/);
      assert.match(content(), /Waiting for bank transfer/);
    },
  );
});
test('history HTTP failure keeps recovery protection with an actionable retry', async () => {
  await scenario(
    { saved: 'unknown', historyError: true },
    async ({ storage, creates }) => {
      await click('Continue with wallet');
      assert.equal(storage.get(journal), 'unknown');
      assert.equal(creates(), 0);
      assert.match(content(), /transaction history is unreachable/);
      assert.equal(button('Retry check').props.disabled, false);
      assert.doesNotMatch(label(alert()), /not found/);
    },
  );
});
test('expired quote preserves amount and shows renewal, never submitting the old quote', async () => {
  await scenario({}, async ({ advance, creates }) => {
    await click('Continue with wallet');
    input().props.onChange({ target: { value: '75' } });
    await flush();
    await click('Show price');
    const staleSubmit = button(create).props.onClick;
    await advance(61000);
    assert.equal(input().props.value, '75');
    assert.match(content(), /The price expired/);
    assert.equal(alert(), undefined);
    assert.equal(button('Refresh price').props.disabled, false);
    await staleSubmit();
    await flush();
    assert.equal(creates(), 0);
    assert.equal(alert(), undefined);
  });
});
test('renewing an expired quote restores review and submits only the new quote ID', async () => {
  await scenario({}, async ({ advance, quoteReads, creates }) => {
    await click('Continue with wallet');
    await click('Show price');
    await advance(61000);
    await click('Refresh price');
    assert.equal(quoteReads(), 2);
    assert.equal(button(create).props.disabled, false);
    await click(create);
    assert.equal(creates(), 1);
  });
});
test('authorized without an active transaction or quote always shows amount entry', async () => {
  await scenario({}, async () => {
    await click('Continue with wallet');
    assert.match(content(), /Wallet authorized/);
    assert.ok(input());
    assert.equal(button('Show price').props.disabled, false);
  });
});
test('deposit instructions expose amount, IBAN, reference, ID and mock bank CTA', async () => {
  await scenario({}, async ({ creates }) => {
    await click('Continue with wallet');
    await click('Show price');
    await click(create);
    assert.equal(creates(), 1);
    for (const text of [
      'Your deposit instructions are ready',
      'TR-TEST-IBAN',
      'TEST-REF',
      'sep_existing',
      'Waiting for bank transfer',
    ])
      assert.ok(content().includes(text));
    await click('Simulate test bank transfer');
    assert.equal(creates(), 1);
  });
});
test('only verified spendable delivery completes the flow and enables Send', async () => {
  await scenario(
    {
      saved: 'sep_existing',
      transaction: payment({
        status: 'completed',
        verification: 'verified',
        spendable: true,
        settlement: 'payment',
        usdc_after: '2.00',
      }),
    },
    async ({ storage, creates }) => {
      await click('Continue with wallet');
      assert.match(content(), /USDC arrived in your wallet/);
      assert.equal(storage.has(journal), false);
      assert.equal(verifiedCalls, 1);
      await click('Continue to Send');
      assert.equal(continueCalls, 1);
      assert.equal(creates(), 0);
    },
  );
});
test('unknown records for other wallets, networks and anchors never block this wallet', async () => {
  await scenario(
    {
      storage: [
        [journal + ':another-wallet', 'unknown'],
        [journal.replace(NETWORK_PASSPHRASE, 'other-network'), 'unknown'],
        [journal.replace('tr-mock-anchor.fly.dev', 'other.example'), 'unknown'],
      ],
    },
    async ({ historyReads }) => {
      assert.ok(input());
      assert.equal(alert(), undefined);
      await click('Continue with wallet');
      assert.equal(historyReads(), 0);
      assert.equal(button('Show price').props.disabled, false);
    },
  );
});
test('old terminal history does not trap an unknown recovery in a completed order', async () => {
  await scenario(
    { saved: 'unknown', history: [{ id: 'sep_old', status: 'completed' }] },
    async ({ storage, reads }) => {
      await click('Continue with wallet');
      assert.equal(storage.has(journal), false);
      assert.equal(reads(), 0);
      assert.ok(input());
      assert.equal(button('Show price').props.disabled, false);
    },
  );
});
test('pending trust and unclaimed balances never announce spendable delivery', async () => {
  for (const extra of [
    { status: 'pending_trust' },
    {
      status: 'completed',
      settlement: 'claimable_balance',
      verification: 'manual_recovery_required',
    },
  ])
    await scenario(
      { saved: 'sep_existing', transaction: payment(extra) },
      async () => {
        await click('Continue with wallet');
        assert.equal(findButton('Continue to Send'), undefined);
        assert.doesNotMatch(content(), /USDC arrived in your wallet/);
        assert.equal(alert(), undefined);
      },
    );
});
test('a lost deposit response remains recoverable while preserving a valid quote', async () => {
  await scenario({ createError: true }, async ({ storage, creates }) => {
    await click('Continue with wallet');
    await click('Show price');
    await click(create);
    assert.equal(storage.get(journal), 'unknown');
    assert.match(content(), /Let's check your previous deposit/);
    await click('Retry check');
    assert.equal(storage.has(journal), false);
    assert.equal(button(create).props.disabled, false);
    assert.equal(creates(), 1);
  });
});

test('development recovery exposes safe diagnostics for both history and saved-ID failures', async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    for (const knownId of [false, true]) {
      const diagnostic = {
        method: 'GET',
        endpoint: knownId
          ? 'https://tr-mock-anchor.fly.dev/sep6/transaction?id=sep_existing'
          : 'https://tr-mock-anchor.fly.dev/sep6/transactions?asset_code=USDC&limit=20',
        status: 400,
        reason: 'fixture error reason',
      };
      await scenario(
        {
          saved: knownId ? 'sep_existing' : 'unknown',
          historyError: !knownId,
          transactionError: knownId,
          diagnostic,
        },
        async ({ storage, creates }) => {
          await click('Continue with wallet');
          assert.ok(content().includes(diagnostic.endpoint));
          assert.match(content(), /fixture error reason/);
          assert.equal(
            storage.get(journal),
            knownId ? 'sep_existing' : 'unknown',
          );
          assert.equal(creates(), 0);
        },
      );
    }
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

test('a same-ID manual recovery that becomes verified refreshes the parent exactly once', async () => {
  let verified = false;
  await scenario(
    {
      saved: 'sep_existing',
      transaction: () =>
        payment({
          status: 'completed',
          verification: verified ? 'verified' : 'awaiting_usable_balance',
          spendable: verified,
          settlement: 'payment',
        }),
    },
    async ({ storage }) => {
      await click('Continue with wallet');
      assert.equal(verifiedCalls, 0);
      verified = true;
      await click('Look up by transaction ID');
      assert.equal(verifiedCalls, 1);
      assert.equal(storage.has(journal), false);
      await click('Look up by transaction ID');
      assert.equal(verifiedCalls, 1);
    },
  );
});

test('recovering instructions keeps stored bank details when transaction response omits them', async () => {
  const context = {
    id: 'sep_existing',
    quote_id: 'q_1',
    amount_try: '50.00',
    amount_usdc: '1.02',
    instructions: payment().instructions,
  };
  await scenario(
    {
      saved: 'sep_existing',
      storage: [[journal + ':context', JSON.stringify(context)]],
      transaction: payment({ instructions: null }),
    },
    async () => {
      await click('Continue with wallet');
      assert.match(content(), /TR-TEST-IBAN/);
      assert.match(content(), /TEST-REF/);
    },
  );
});

test('new deposit stores public quote/instruction context and never session tokens', async () => {
  await scenario({}, async ({ storage }) => {
    await click('Continue with wallet');
    await click('Show price');
    await click(create);
    const raw = storage.get(journal + ':context');
    const context = JSON.parse(raw);
    assert.equal(context.id, 'sep_existing');
    assert.equal(context.quote_id, 'q_1');
    assert.equal(
      context.instructions.bank_account_number.value,
      'TR-TEST-IBAN',
    );
    assert.ok(!raw.includes(token));
  });
});

test('recovery ignores context belonging to another transaction and unknown status stays unverified', async () => {
  await scenario(
    {
      saved: 'sep_existing',
      storage: [
        [
          journal + ':context',
          JSON.stringify({
            id: 'sep_other',
            quote_id: 'q_other',
            amount_try: '50.00',
            amount_usdc: '9.99',
            instructions: payment().instructions,
          }),
        ],
      ],
      transaction: payment({
        status: 'new_anchor_status',
        instructions: null,
        amount_usdc: '0.0000000',
      }),
    },
    async () => {
      await click('Continue with wallet');
      assert.doesNotMatch(content(), /TR-TEST-IBAN|9.99|USDC arrived in your wallet/);
      assert.match(content(), /new_anchor_status/);
      assert.equal(findButton('Continue to Send'), undefined);
    },
  );
});
test('an unpaid deposit whose quote expired offers a new deposit instead of a dead simulate button', async () => {
  await scenario(
    { saved: 'sep_existing', transaction: payment({ stale: true }) },
    async ({ storage, creates }) => {
      await click('Continue with wallet');
      assert.match(content(), /locked quote expired before the bank transfer/);
      assert.equal(findButton('Simulate test bank transfer'), undefined);
      await click('New deposit');
      assert.equal(storage.get(journal), undefined);
      assert.ok(findButton('Show price'));
      assert.equal(creates(), 0);
    },
  );
});
