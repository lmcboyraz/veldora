# Veldora FX — Testnet deployment history

Rollback and audit reference. The live configuration is in `lib/fx-testnet.json`; its
`previous` list holds the same retired addresses. All hashes are Stellar Testnet
transactions (look them up on `https://stellar.expert/explorer/testnet/tx/<hash>`).

## Contracts

| Role | Address | Status |
| --- | --- | --- |
| FX router v2 (four assets, multi-hop) | `CA657TOFFYC7TLZ5C3G6SBEGYJNQMX6MA6VCN2YTSMKN4UIQWZYKGTR5` | **active**, wasm `74cab7dd…d3cfa` |
| TRY demo/mock oracle (24 h TTL) | `CBM45QZFZ6BUP4UK3QKAFOVV3KYDT5E43DWCN334Y35STREYID7ADY5N` | **active**, wasm `b3bebdc8…b47acf` |
| TRY demo oracle (15 min snapshots) | `CDFKSRQKR6GY5XHCQMRRLPCTIAS7ZL6VV4ADCGENHPGLNEP3UH7CZJOI` | retired 2026-09-11 (rollback target) |
| First four-asset router attempt | `CAYTKYYMESLUOM54JFKJXSHSXJMBVJXDPAI4X32IENXQ3ETSHG75OWC4` | retired, no providers |
| FX router v1 (permissionless, USDC/EURC) | `CA6KVTW5X7DG4ZGZ7JBIKOHGSGVHKLZMUGWGJKWMSFMBD5P3NAPE7ZAR` | retired, inventory moved to v2 on 2026-09-11, wasm `d9ce7956…4049f` |
| FX router v0 (admin-registered LPs) | `CCFCOCQI3RJEQNG3LC6WELSSJDPY6ZCGXISWI7YAAQHAMYVG4GVKLHQZ` | paused |

## 2026-09-11 — stabilization for the demo

| Step | Transaction |
| --- | --- |
| TRY oracle migration: first 24 h snapshot on the new oracle | `ee5344a3b6fda6aebbd2e53fdf52c9194c9235097e4562940e1824b6b9edf51d` |
| TRY oracle migration: router `set_asset(rTRY)` → new oracle | `a23f0073a70d2cf6ecaf4cf2777e20e9821e62dc9e30c9c2aa8bf5938ec5b659` |
| `ExtendFootprintTTL` of 43 demo entries to ≈ 2026-11-10 | `ca64ee4510530380a9466d14a135af727a2cbc1fcaeb1bfdc2273eb4536f4591` |
| LP top-up: v1 inventory, LP-3 and demo-recipient EURC moved into v2 (USDC 8 → 67, EURC 0.56 → 57) | 14 transactions, journaled in the ignored `work/fx-bootstrap.json` under `topup:1789135711495:*` |

Rollback of the TRY oracle: `set_asset(rTRY)` on the router back to `CDFKSRQ…` (same config
apart from `oracle`) and restore `oracle` in `lib/fx-testnet.json`. The router itself was not
changed by any of these steps.

## 2026-09-08 → 09-11 — four-asset v2 activation

| Step | Transaction |
| --- | --- |
| TRY snapshot (original oracle) | `c20cebb289b817d30c17df8cd2426569259b9bee36c04458cd8ef165477332d8` |
| LP-1 / LP-2 initial USDC deposits (2 each) | `33fb6aca986afdcea9daf8d1822d3b187187ceed8e1a4f9c9640f297048518fc`, `a670dc8ef1d799bf3a515497549f47ccecdb4e94687bc4a7daa665e6b56bde8b` |
| Verified 20 rTRY → rGBP two-hop settlement | `eafdb47220e703105e8371ace23911e4a5dd74240d90948400768245b56b2747` |
| Verified 60 rTRY → rGBP direct settlement | `1311397783b2c345a205c6679fb54b69fd9b5f86aa63573e183d6961e4b45470` |

## 2026-09-06 → 09-07 — v0 → v1 permissionless migration

Asset configuration (`0943006d…dd0bc`, `1aad1fd0…ba364`), LP-1 registration and pairs
(`8839bde9…eec85`, `e08dbf44…35351`, `34d4c8c9…9c94a`), LP-2 registration and pairs
(`08f491bc…92b7b`, `348dff2e…c8c14`, `1e76a249…25f94`), v0 pause (`78717cdf…1cb79`),
inventory moves (`31b1c847…49645`, `9c85b7b6…9b1a1`, `a3d060a6…d786b`, `08572e88…66bac`,
`4c7f3c50…d1a4d`, `39e276ca…4e180`), permissionless LP-3 registration (`88ab4438…babb43`,
`328476c2…ea9df`), Reflector EUR feed renewal paid in XRF (`653003ec…259ff`), first v1
settlement 2 USDC → EURC (`471071e7…fa3417d`) and LP-3 settlement (`b88b9b4b…ce46d`).
