#!/usr/bin/env node
// Refreshes the TRY demo/mock price every 5 minutes. Reflector's testnet FX feed has no TRY,
// so the TRY-only demo oracle serves the latest snapshot until its demo TTL (24 h on the TTL
// oracle) expires: if this keeper stops, TRY keeps routing until then. The rate is the Mock
// Anchor's public SEP-38 USD/TRY price, so Send and Fund agree.
// Inspect by default; --execute signs each snapshot with the rise-deployer CLI identity.
// --execute --once pushes a single snapshot and exits (the manual pre-demo refresh).
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ASSETS} from '../lib/config.ts';

const INTERVAL_MS = 5 * 60_000;
const root = fileURLToPath(new URL('..', import.meta.url));
const priceUrl = 'https://tr-mock-anchor.fly.dev/sep38/price?' + new URLSearchParams({
  sell_asset: 'iso4217:TRY', buy_asset: `stellar:${ASSETS.USD.code}:${ASSETS.USD.issuer}`, sell_amount: '100.00', context: 'sep6',
});

/** USD value of 1 TRY at the oracle's 14 decimals, from the anchor's TRY-per-USDC price. */
export async function anchorRate(fetchPrice = fetch) {
  const response = await fetchPrice(priceUrl, {signal: AbortSignal.timeout(15_000)});
  const {price} = await response.json();
  if (!response.ok || !/^\d+(\.\d+)?$/.test(price ?? '')) throw Error('Mock Anchor price unavailable');
  const [whole, fraction = ''] = price.split('.');
  const tryPerUsd = BigInt(whole + fraction), scale = 10n ** BigInt(fraction.length);
  if (tryPerUsd < 10n * scale || tryPerUsd > 500n * scale) throw Error(`Implausible USD/TRY ${price}`);
  return {price, usd14: (10n ** 14n * scale) / tryPerUsd};
}

async function main() {
  const execute = process.argv.includes('--execute');
  let rate;
  async function push() {
    try { rate = await anchorRate(); }
    catch (error) {
      console.warn(`${error.message}; ${rate ? 'reusing the previous rate' : 'skipping this round'}.`);
      if (!rate) { process.exitCode = 1; return; }
    }
    console.log(`${new Date().toISOString()} USD/TRY ${rate.price} → oracle price ${rate.usd14}`);
    if (!execute) return;
    execFileSync(process.execPath, [...process.execArgv, 'scripts/fx-bootstrap.mjs', '--snapshot-only', '--execute', '--demo-try'],
      {cwd: root, stdio: 'inherit', env: {...process.env, RISE_DEMO_TRY_USD_14: String(rate.usd14)}});
  }
  if (!execute || process.argv.includes('--once')) {
    await push();
    if (!execute) console.log('Inspect only. --execute --once pushes one snapshot; --execute alone refreshes every 5 minutes (Ctrl+C to stop).');
    return;
  }
  for (;;) {
    try { await push(); } catch { console.warn('Snapshot push failed; retrying next round.'); }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
