#!/usr/bin/env node
// Moves rTRY pricing to the TTL demo oracle (24 h demo freshness): deploy it, push the first
// snapshot, point the router's rTRY asset at it, then record it in lib/fx-testnet.json.
// The router, its 900 s limit and the Reflector assets are not touched. Every step is
// re-checked on chain, so a rerun resumes. Inspect by default; --execute deploys and signs
// with rise-deployer. Rollback: set_asset rTRY back to the oracle listed under `previous`.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {nativeToScVal, xdr} from '@stellar/stellar-sdk';
import {ASSETS} from '../lib/config.ts';
import {read, call, key, struct, other, addr, i128, horizon, server, deployment, savePublic} from './fx-bootstrap.mjs';
import {anchorRate} from './try-price-keeper.mjs';

const execute = process.argv.includes('--execute');
const TTL = 86_400;
const wasm = 'soroban/target/wasm32v1-none/release/demo_oracle.wasm';
const wasmHash = createHash('sha256').update(readFileSync(wasm)).digest('hex');
const admin = key('rise-deployer');
const salt = createHash('sha256').update(`rise-fx-v2-try-ttl-oracle-${wasmHash}`).digest('hex');
const cli = args => execFileSync('stellar', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const oracle = cli(['contract', 'id', 'wasm', '--salt', salt, '--source-account', 'rise-deployer', '--network', 'testnet']);
const u64 = n => nativeToScVal(BigInt(n), {type: 'u64'});
const step = (done, text) => console.log(`${done ? 'done   ' : execute ? 'running' : 'pending'} ${text}`);

console.log(execute ? 'TESTNET EXECUTE' : 'TESTNET INSPECT', `\nTTL oracle ${oracle} (wasm ${wasmHash}, max_ttl ${TTL}s)`);
const deployed = await server.getContractInstance(oracle).then(i => Buffer.from(i.executable.wasmHash.value).toString('hex'), () => null);
if (deployed && deployed !== wasmHash) throw Error('A different contract already exists at the TTL oracle address.');
step(deployed, 'deploy TTL demo oracle');
if (!deployed && execute) {
  const id = cli(['contract', 'deploy', '--wasm', wasm, '--optimize=false', '--source', 'rise-deployer', '--network', 'testnet', '--salt', salt,
    '--', '--admin', admin.publicKey(), '--max_ttl', String(TTL)]);
  if (id !== oracle) throw Error(`Unexpected deployment address ${id}`);
}
if (!deployed && !execute) {
  for (const text of ['first TRY snapshot (Mock Anchor rate)', 'router rTRY asset → TTL oracle', 'lib/fx-testnet.json oracle']) step(false, text);
  process.exit(0);
}
if (Number(await read(oracle, 'max_ttl')) !== TTL) throw Error('TTL oracle max_ttl mismatch');

const live = await read(oracle, 'snapshot').catch(() => null);
step(live, 'first TRY snapshot (Mock Anchor rate)');
if (!live && execute) {
  const {price, usd14} = await anchorRate();
  const now = Math.floor(new Date((await horizon.ledgers().order('desc').limit(1).call()).records[0].closed_at).getTime() / 1000);
  console.log(`        USD/TRY ${price} → ${usd14}, valid until ${new Date((now + TTL) * 1000).toISOString()}`);
  await call(`snapshot:${now}`, admin, oracle, 'set_price', [struct({price: i128(usd14), timestamp: u64(now)}), u64(now + TTL)]);
}

const current = await read(deployment.router, 'get_asset', [addr(ASSETS.TRY.contract)]);
step(current.oracle === oracle, `router rTRY asset → TTL oracle (was ${current.oracle})`);
if (current.oracle !== oracle && execute) {
  if (!await read(oracle, 'lastprice', [other('TRY')])) throw Error('TTL oracle has no live TRY price; router left unchanged.');
  await call(`asset:TRY:${oracle}`, admin, deployment.router, 'set_asset', [addr(ASSETS.TRY.contract), struct({
    enabled: nativeToScVal(true), is_oracle_base: nativeToScVal(false), oracle: addr(oracle), oracle_asset: other('TRY'),
    oracle_base: xdr.ScVal.scvSymbol('USD'), token_decimals: nativeToScVal(7, {type: 'u32'}),
  })]);
}

step(deployment.oracle === oracle, 'lib/fx-testnet.json oracle');
if (deployment.oracle !== oracle && execute) {
  if ((await read(deployment.router, 'get_asset', [addr(ASSETS.TRY.contract)])).oracle !== oracle) throw Error('Router is not on the TTL oracle yet.');
  deployment.previous.push({name: 'oracle', address: deployment.oracle});
  deployment.oracle = oracle;
  savePublic();
}
if (execute) {
  const quote = await read(deployment.router, 'quote_route', [addr(ASSETS.TRY.contract), addr(ASSETS.USD.contract), i128(10_000_000n)]);
  console.log(`verified: 1 rTRY → ${Number(quote.amount_out) / 1e7} USDC through ${deployment.router}`);
}
