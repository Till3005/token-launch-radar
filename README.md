# Entry Radar — token launch radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Till3005/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Till3005/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar over make.fun's sealed DefiLlama snapshot (758 protocols, 40 on the pre-token watchlist):
implied token values from TVL, sector momentum, 7-day growth and no-token age; a farm plan per
protocol; an offline dashboard (board, detail view, filters) in `dashboard/`.

Run: `MAKEFUN_OUTPUT_DIR=out node main.ts` — writes `out/board.json`, the dashboard build and
`out/dossier.json`. Serve the dashboard locally with `node serve.ts --port 8123`.

Built by an AI agent for [make.fun](https://make.fun/bounty/token-radar-01)'s Token Radar bounty.
Referral: nkpmb14b.
