# Veldora FX

**Send one currency. Deliver another.** Veldora is a cross-currency payment router on
Stellar Testnet. A user funds a wallet with Turkish lira through a mock anchor, then
sends USDC, EURC, rGBP or rTRY and the recipient receives a different currency. The
swap and the payout settle **atomically in one transaction**, priced by on-chain
oracles and filled by competing liquidity providers.

> Testnet demo. USDC/EURC are Circle's testnet tokens and rGBP/rTRY are Veldora demo tokens;
> none carry monetary value. The anchor, its bank and KYC are simulated.

## How it works

```
 Fund:  TRY ──(TR Mock Anchor, SEP-6/10/12/38)──▶ USDC in the user's wallet

 Send:  wallet ──source──▶ fx-router ──target──▶ recipient     (one transaction)
                              ├─ Reflector FX oracle      EUR, GBP (USD base)
                              ├─ TRY demo/mock oracle     TRY snapshot, 24 h
                              └─ LP inventories           LP-1, LP-2, …
```

**Fund — Mock Anchor on-ramp.** The Fund tab uses the public
[TR Mock Anchor](https://tr-mock-anchor.fly.dev/sep) testnet sandbox. Veldora discovers its
endpoints from `stellar.toml`, authenticates with a SEP-10 challenge signed by the
connected wallet, auto-approves simulated KYC (no personal data), locks a firm SEP-38
quote, creates a SEP-6 deposit and lets you trigger the simulated bank transfer. The
USDC payment is then verified on-chain before Send is offered. This leg is separate
from the atomic Veldora swap.

**Send — best route, atomic settlement.** Each liquidity provider registers per
direction a fee, a maximum input per swap and an inventory cap. For every quote the
router evaluates every provider on the direct pair and on the two-hop path through the
USDC hub, and picks the highest net output. `transfer_route` pulls the sender's funds,
runs every hop against LP inventory, accrues fees and pays the recipient in the same
transaction, guarded by a minimum received (0.5 % below the quote) and a 3-minute
deadline. The app re-quotes on chain right before asking for a signature.

**Pricing.** Reflector publishes EUR and GBP against a USD base; USDC is the base
(1.0). The router rejects any Reflector price older than 900 seconds. Reflector's testnet
feed has no TRY, so TRY uses a TRY-only **demo/mock oracle**: an admin pushes a snapshot
priced from the Mock Anchor's SEP-38 USD/TRY rate, and the oracle serves it for up to
24 hours. The UI labels TRY as a demo/mock feed and shows when the snapshot was set and
when it expires.

**Liquidity.** Any wallet can register as a provider (permissionless), configure its
pairs and deposit or withdraw inventory from the Liquidity tab.

| Currency | Token | Price source | Demo LP fees |
| --- | --- | --- | --- |
| USD | USDC (Circle testnet) | router base, 1.0 | — |
| EUR | EURC (Circle testnet) | Reflector EUR | LP-1 20 bps · LP-2 30 bps |
| GBP | rGBP (Veldora demo token) | Reflector GBP | LP-1 20 bps · LP-2 30 bps |
| TRY | rTRY (Veldora demo token) | TRY demo/mock oracle | LP-1 20 bps · LP-2 30 bps |

Pairs are configured USDC ↔ each currency, so EURC ↔ rGBP, EURC ↔ rTRY and rGBP ↔ rTRY
route through USDC; LP-2 also offers a direct rTRY ↔ rGBP pair at 100 bps. Demo LP limits
are 10 units of input per swap (40 for rTRY).

## Testnet contracts

| Component | Address |
| --- | --- |
| FX router | `CA657TOFFYC7TLZ5C3G6SBEGYJNQMX6MA6VCN2YTSMKN4UIQWZYKGTR5` |
| TRY demo/mock oracle | `CBM45QZFZ6BUP4UK3QKAFOVV3KYDT5E43DWCN334Y35STREYID7ADY5N` |
| Reflector FX oracle | `CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W` |
| USDC SAC / issuer | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` / `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| EURC SAC / issuer | `CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ` / `GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO` |
| rGBP SAC | `CACLVWSJCCT2O4VJ4QMWPSP6YWRDU2BJE2BJ7367LQ5SO62RVGJ4WJXS` |
| rTRY SAC | `CD25ASKEVUKGASFQCJRHHUGPLQJOQXPJ5U574RB2ZABPIV62A3SX4ZKN` |
| rGBP / rTRY issuer | `GBH2SQKB6GSQNAANB7AQWVZHNTT4W66ROC3VYE6AYFKP6SBNVDTXXW3C` |
| LP-1 / LP-2 | `GCXV2DY24I5ZJSV36KTCB2YHEAM6F7NM7OKJZUA6OI44XUMF76UD45NK` / `GCNPJ2PETW564HLQ7SHCQ73E2F7EMUKTP52HSS555MSAJ2FVVXFUKSJQ` |

Retired contracts and migration receipts: [docs/deployment-history.md](docs/deployment-history.md).
Contract sources: `soroban/contracts/fx-router` and `soroban/contracts/demo-oracle`.

## Run locally

Requires Node 22.15+ within the Node 22 release line (and Rust with the
`wasm32v1-none` target for the contracts). Tests use Node's `registerHooks` API.

```bash
npm install
npm run dev
```

Open http://localhost:3000 and connect a Stellar Testnet wallet (Freighter, xBull, Albedo,
Rabet, LOBSTR or Hana via Stellar Wallets Kit). No environment variables are needed. A
recipient must hold a trustline for the asset it receives; the app offers to add the
connected wallet's own trustlines.

## Deploy to Vercel

Import `lmcboyraz/veldora`, branch `main`, with root directory `./`. Choose the
**Other** application preset. The committed `vercel.json` sets install to `npm ci`,
build to `npm run build:vercel`, and output to `.vercel/output`. Node 22 is selected
by `package.json`. Leave Environment Variables empty and click **Deploy**.

The Vercel build uses Vinext with [Nitro's Vercel preset](https://nitro.build/deploy/providers/vercel).
It produces Build Output API v3 static assets plus a Node 22 server function for
SSR, `/api/anchor/demo`, and `/api/anchor/onramp`; it is not a static-only export.
The function has a 300-second limit for multi-request anchor flows. Requests may
still time out: preserve the existing recovery flow and check a deposit's status
before creating another one. No session or secret is stored in the function.

```bash
npm run build:vercel
npm run verify:vercel
# After deployment, repeat the unsigned HTTP checks against the real URL:
npm run verify:vercel -- https://YOUR-PROJECT.vercel.app
```

Verification checks SSR, referenced JS/CSS, both API routes, HTTPS same-origin
requests, cross-origin rejection, and request validation. It does not sign or
submit blockchain transactions. Open the deployed HTTPS origin, select Stellar
Testnet in your wallet, and authorize that new site origin. Fund authentication
and any subsequent trustline, payment or liquidity signature must be approved in
the wallet by its owner. TRY snapshot expiry is independent of hosting.

`npm run dev`, `npm run build`, and `npm start` retain the existing local
Cloudflare development/build/preview flow. Vercel selects Nitro through
`build:vercel` (or its `VERCEL=1` build environment). No contract redeployment,
Cloudflare publication, API key, seed, or private key is needed.

## Tests

```bash
npm run typecheck
npm run lint
npm test
npm run build
cd soroban && cargo test
```

## Demo day

```bash
npm run demo:preflight
```

Read-only. Prints PASS / WARN / FAIL for the router, its paused state, the asset oracles,
Reflector EUR/GBP freshness, the TRY snapshot, ledger TTLs of every required contract
entry (and whether any needs a restore), LP inventory, and quotes for all 12 directions
at 1 and 5 units. It never signs or submits.

```bash
npm run try:refresh
```

Pushes one fresh TRY snapshot (valid 24 hours) at the current Mock Anchor rate, signed
with the `rise-deployer` Stellar CLI identity. Run it shortly before presenting. A
persistent keeper (`node scripts/try-price-keeper.mjs --execute`, every 5 minutes) is
optional; TRY keeps working until the snapshot expires without it.

Maintenance scripts inspect by default and only sign with `--execute`:

| Script | Purpose |
| --- | --- |
| `scripts/extend-ttl.mjs` | extend ledger TTLs of every entry the demo needs (currently to ≈ 2026-11-10) |
| `scripts/lp-topup.mjs` | deposit idle LP wallet USDC/EURC into the router, at most 100 of each |
| `scripts/try-price-keeper.mjs` | TRY snapshot at the Mock Anchor rate (`--once` for a single push) |
| `scripts/fx-verify.mjs` | settle the recorded v2 verification scenarios once |
| `scripts/fx-bootstrap.mjs` | original v2 deployment and configuration (already done) |
| `scripts/try-oracle-ttl.mjs` | TRY oracle migration to the 24 h demo oracle (already done) |

## Limitations

- **Testnet only.** No real money, fiat or production KYC; the Mock Anchor is a
  third-party sandbox, not production fiat infrastructure, and speaks SEP-6, not SEP-24.
- **TRY is a demo/mock price.** It is a 24-hour snapshot of the Mock Anchor's rate, not a
  decentralized oracle; the router's 900-second freshness rule applies to Reflector only.
- **Liquidity is small.** Demo LPs hold roughly 68 USDC, 56 EURC, 1,000 rGBP and 1,080
  rTRY, with per-swap limits of 10 units (40 rTRY); larger amounts report no route.
- **Expiring testnet state.** Ledger TTLs of the demo entries run to about 2026-11-10 and
  the Reflector EUR/GBP feed subscription to 2026-11-09; the preflight shows both.
- **Permissionless provider list.** The router scans every registered provider for each
  quote, so registration spam could exhaust transaction resources. Acceptable for a
  testnet demo; production needs bounded provider discovery.
- **Atomicity.** Only the Veldora swap and payout are atomic; the anchor deposit is a
  separate leg.
