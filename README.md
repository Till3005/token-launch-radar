[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Till3005/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Till3005/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Built for the [token-radar-01 bounty on make.fun](https://make.fun/bounty/token-radar-01).

# Entry Radar — pre-token protocols ranked by a fitted implied value

Reads the sealed snapshot, fits its value model on the snapshot's own traded protocols, and ranks
every rankable pre-token protocol by what its token would be worth if the record stays as it is,
discounted by data-derived launch odds, with a priced farm plan per row.

## The model (lib/model.ts)

Two fitted pieces, no hardcoded names anywhere:

- **Value**: ridge regression (λ=1, normal equations + Gaussian elimination, no dependencies) of
  `log(mcap_usd)` on the snapshot's traded anchors — protocols with a market cap on record, kept
  after dropping non-positive caps, sub-$1M caps and mcap/TVL above 60x (108 of 144 survive).
  Features: log TVL, listing age, 7-day change (clamped), chain count, and ten sector one-hots
  grouped from DefiLlama's categories. `implied = exp(fitted log mcap)`, rounded to whole dollars,
  capped at $100T.
- **Launch odds**: `P(launch) = category base × TVL-band boost × token-less age-band discount`,
  clipped to 1%–92%. The base is the category's own launch rate shrunk toward the snapshot-wide
  rate (k=6); the boost is the TVL band's launch rate relative to the whole snapshot; the discount
  compares the token-less share of the protocol's age band with the 0–90d band, so old protocols
  that never issued are discounted. Everything is computed from the snapshot's 758 protocols.
- **implied_value_usd = fitted mcap × launch odds**, ranked non-increasing. Traded protocols sit in
  a separate "Trained on" panel — they are the model's data, never ranked rows.

## Measured validation (this snapshot, as_of 2026-11-14)

- Leave-one-out over all 108 anchors, each fold refit with its own standardisation:
  **median fold error ×2.79** (p75 ×6.08).
- Walk-forward: trained on the 40 oldest anchors by `listed_at`, tested on the 41 newest:
  **median fold error ×2.22**.
- Both numbers are printed on the board header and in the model panel; the detail view re-derives
  each row's implied value from its printed factors and says whether it matches board.json.

## Farm verdicts

Each row carries a plan (3–7 steps) with per-step cost and time: position sized to TVL, gas priced
per chain (Ethereum $14/tx, L2s $0.80, Solana $0.15), bridge fees on dual-chain plans, hours priced
at $25. Expected value = implied × odds × 6% airdrop pool × capture, capture from the position's
share of farming TVL (12% of TVL) doubled for a dedicated wallet. `net = EV − gas − hours × $25`
reads **farm** (≥ $40), **thin** ($0–40) or **skip** (< $0). This snapshot: 44 farm, 14 thin, 140 skip.

## Run

    mkdir -p out && node main.ts --input data/snapshot.json

Reads `--input`, else `$MAKEFUN_INPUT_DIR`, else `/input/snapshot.json`, else `data/snapshot.json`.
Writes `board.json`, `data.js`, a copy of `dashboard/` and `screenshots/`, and `dossier.json`
(via `vendor/makefun-board.ts`) into `--output`/`$MAKEFUN_OUTPUT_DIR` (default `/output`).
Standard library only; runs on Node 22 as-is. Check with `node scripts/validate.mjs out data/snapshot.json`.

## Dashboard

Dark radar page, one accent hue, tabular numerals, 4/8px spacing: KPI strip with the measured
validation, sortable board (rank, TVL, 7d, token-less age, odds, implied value, farm net), filters
(search, category, chain, TVL range, watchlist-only, farm-worthy), a hash-routed detail view per
protocol (`#p=slug`) with the factor breakdown, odds derivation, verdict arithmetic and full farm
plan, a traded-comps panel of the fitted anchors, and a model panel with the fitted equation and
both validation splits. Offline: no network references anywhere.
