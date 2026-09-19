import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, Networks, WebAuth } from '@stellar/stellar-sdk';
import {
  tryAmount,
  validateChallenge,
  sessionValid,
  validateQuote,
  validateDiscovery,
} from '../lib/anchor/sep.ts';
const domain = 'tr-mock-anchor.fly.dev';
const server = Keypair.random(),
  user = Keypair.random();
const discovery = {
  home: domain,
  auth: `https://${domain}/auth`,
  signingKey: server.publicKey(),
  network: Networks.TESTNET,
  issuer: user.publicKey(),
  code: 'USDC',
};
test('TRY uses exact cents and enforces mock bank ceiling', () => {
  assert.equal(tryAmount('50'), '50.00');
  assert.equal(tryAmount('50.00'), '50.00');
  assert.equal(tryAmount('3000'), '3000.00');
  assert.equal(tryAmount('3000.00'), '3000.00');
  for (const x of ['49.99', '3000.01', '50.001', '50.0000000', '1e2', '-100', '', ' 50', '50,00', 50, null])
    assert.throws(() => tryAmount(x));
});
test('SEP-10 checks server signature, account, network, domain and time', () => {
  const xdr = WebAuth.buildChallengeTx(
    server,
    user.publicKey(),
    domain,
    300,
    Networks.TESTNET,
    domain,
  );
  assert.doesNotThrow(() =>
    validateChallenge(xdr, discovery, user.publicKey()),
  );
  assert.throws(() => validateChallenge(xdr, discovery, server.publicKey()));
  assert.throws(() =>
    validateChallenge(
      xdr,
      { ...discovery, signingKey: user.publicKey() },
      user.publicKey(),
    ),
  );
  assert.throws(() =>
    validateChallenge(
      xdr,
      { ...discovery, network: Networks.PUBLIC },
      user.publicKey(),
    ),
  );
  assert.throws(() =>
    validateChallenge(
      xdr,
      { ...discovery, home: 'other.example' },
      user.publicKey(),
    ),
  );
  const realNow = Date.now;
  Date.now = () => realNow() - 600000;
  const expired = WebAuth.buildChallengeTx(
    server,
    user.publicKey(),
    domain,
    1,
    Networks.TESTNET,
    domain,
  );
  Date.now = realNow;
  assert.throws(() => validateChallenge(expired, discovery, user.publicKey()));
});
test('session cannot survive account/network/anchor changes or expiry', () => {
  const s = {
    wallet: 'a',
    network: 'n',
    home: domain,
    expires: 2000,
    token: 'private',
  };
  assert.equal(sessionValid(s, 'a', 'n', domain, 1000), true);
  for (const args of [
    ['b', 'n', domain, 1000],
    ['a', 'x', domain, 1000],
    ['a', 'n', 'other', 1000],
    ['a', 'n', domain, 2000],
  ])
    assert.equal(sessionValid(s, ...args), false);
});
test('quote locks exact TRY input, asset pair and expiration', () => {
  const q = {
    id: 'q1',
    sell_asset: 'iso4217:TRY',
    buy_asset: `stellar:USDC:${user.publicKey()}`,
    sell_amount: '100.00',
    buy_amount: '2.0000000',
    price: '50',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    fee: { total: '0.50', asset: 'iso4217:TRY' },
  };
  assert.equal(
    validateQuote(q, discovery, '100').destination_amount,
    '2.0000000',
  );
  assert.throws(() =>
    validateQuote({ ...q, sell_amount: '99.00' }, discovery, '100'),
  );
  assert.throws(() =>
    validateQuote({ ...q, expires_at: '2000-01-01' }, discovery, '100'),
  );
  assert.throws(() =>
    validateQuote({ ...q, buy_asset: 'stellar:OTHER' }, discovery, '100'),
  );
});
test('discovery blocks incompatible router asset and foreign endpoints', () => {
  const toml = {
    NETWORK_PASSPHRASE: Networks.TESTNET,
    SIGNING_KEY: server.publicKey(),
    CURRENCIES: [{ code: 'USDC', issuer: user.publicKey() }],
    WEB_AUTH_ENDPOINT: discovery.auth,
    TRANSFER_SERVER: `https://${domain}/sep6`,
    KYC_SERVER: `https://${domain}/sep12`,
    ANCHOR_QUOTE_SERVER: `https://${domain}/sep38`,
  };
  assert.equal(
    validateDiscovery(toml, domain, Networks.TESTNET, {
      code: 'USDC',
      issuer: user.publicKey(),
    }).issuer,
    user.publicKey(),
  );
  assert.throws(() =>
    validateDiscovery(toml, domain, Networks.TESTNET, {
      code: 'USDC',
      issuer: server.publicKey(),
    }),
  );
  assert.throws(() =>
    validateDiscovery(
      { ...toml, WEB_AUTH_ENDPOINT: 'https://other.example/auth' },
      domain,
      Networks.TESTNET,
      { code: 'USDC', issuer: user.publicKey() },
    ),
  );
});
