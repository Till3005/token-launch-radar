// Entry Radar value model, v3: a ridge regression fitted on the snapshot's own traded protocols.
//
// The board's implied value is fitted, not hand-set. The snapshot carries ~144 protocols whose token
// already trades (mcap_usd on record); the model regresses log(mcap) on each anchor's own figures —
// log(TVL), listing age, 7-day change, chain count and a grouped category — by ordinary least squares
// with a small ridge for stability, solved through normal equations and Gaussian elimination written
// here (no dependencies). Held-out validation (leave-one-out over the anchors, plus a walk-forward
// split) is measured at build time and printed on the board header.
//
// A pre-token protocol's implied value then discounts the fitted figure by its odds of ever issuing:
// P(launch) = shrinkage-smoothed category rate x TVL-band boost x token-less age-band discount, all
// estimated from the snapshot's own cohort. Every constant below is either fitted from the data or a
// stated assumption; no protocol name is special-cased anywhere.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

const DAY_MS = 86_400_000;
export const IMPLIED_CAP = 100_000_000_000_000;

export const MODEL_NAME = 'entry-radar/fitted-ridge';
export const MODEL_VERSION = 'radar-3';
export const RIDGE_LAMBDA = 1.0;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Whole days between the snapshot date and the day the protocol was first tracked. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Products of a token that already trades, and venues that never issue one, are not radar subjects. */
const DERIVED_NAME = /\b(wrapped|staked|staking)\b/i;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const NOT_A_LAUNCH = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !NOT_A_LAUNCH.has(p.category ?? '') && !DERIVED_NAME.test(p.name) && !VERSIONED.test(p.name);
}

// ---------------------------------------------------------------- category groups
// DefiLlama's ~40 categories grouped into 10 modelable sectors (plus a baseline) so the one-hot
// never outgrows the ~110 anchors. The regexes read the category text, never a protocol's name.

const GROUPS: Array<[string, RegExp]> = [
  ['trading', /deriv|perp|basis|prediction/i],
  ['swap', /\bdex|swap|amm/i],
  ['credit', /lend|cdp|collateral|cedefi/i],
  ['staking', /liquid staking|liquid restaking|restak|staking pool/i],
  ['yield', /yield|farm|liquidity manager|leveraged/i],
  ['bridge', /bridge/i],
  ['cex', /^cex$/i],
  ['chain', /^chain$/i],
  ['curation', /curator|capital allocator|governance/i],
  ['assets', /rwa|index|token locker|launchpad|payment|stablecoin|insurance/i],
];
export const GROUP_NAMES = ['trading', 'swap', 'credit', 'staking', 'yield', 'bridge', 'cex', 'chain', 'curation', 'assets'];

export function groupOf(category: string | null): string {
  const c = category ?? '';
  for (const [g, re] of GROUPS) if (re.test(c)) return g;
  return 'other';
}

// ---------------------------------------------------------------- linear algebra
// Ridge regression through normal equations (X'X + lambda*I) b = X'y with the intercept unpenalized,
// solved by Gaussian elimination with partial pivoting. Dim is small (~16), so this is exact.

function solveRidge(x: number[][], y: number[], dim: number, lambda: number): number[] {
  const a: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  const b = new Array<number>(dim).fill(0);
  for (let i = 0; i < x.length; i++) {
    const row = x[i]!;
    for (let r = 0; r < dim; r++) {
      b[r]! += row[r]! * y[i]!;
      for (let c = 0; c < dim; c++) a[r]![c]! += row[r]! * row[c]!;
    }
  }
  for (let r = 1; r < dim; r++) a[r]![r]! += lambda;
  for (let col = 0; col < dim; col++) {
    let piv = col;
    for (let r = col + 1; r < dim; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    const ar = a[col]!;
    a[col] = a[piv]!;
    a[piv] = ar;
    const t = b[col]!;
    b[col] = b[piv]!;
    b[piv] = t;
    const d = a[col]![col]!;
    for (let c = col; c < dim; c++) a[col]![c]! /= d;
    b[col] /= d;
    for (let r = 0; r < dim; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      if (f === 0) continue;
      const rr = a[r]!;
      for (let c = col; c < dim; c++) rr[c]! -= f * a[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  return b;
}

// ---------------------------------------------------------------- feature build
// Column order: intercept, log TVL, age years, age-unknown flag, 7d change, chain count, 10 group dummies.
export const FEATURE_DIM = 6 + GROUP_NAMES.length;

interface FeatStats {
  medAge: number;
  lT: { m: number; s: number };
  age: { m: number; s: number };
  growth: { m: number; s: number };
  chains: { m: number; s: number };
}

function meanSd(xs: number[]): { m: number; s: number } {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length) || 1;
  return { m, s };
}

function feats(p: SnapshotProtocol, asOf: string, st: FeatStats): number[] {
  const age = ageDays(asOf, p.listed_at);
  const ageYears = (age === null ? st.medAge : clamp(age, 0, 1826)) / 365;
  const growth = p.change_7d === null ? 0 : clamp(p.change_7d, -60, 150) / 100;
  const chains = Math.min(p.chains.length, 12);
  const g = groupOf(p.category);
  return [
    1,
    (Math.log(p.tvl_usd) - st.lT.m) / st.lT.s,
    (ageYears - st.age.m) / st.age.s,
    age === null ? 1 : 0,
    (growth - st.growth.m) / st.growth.s,
    (chains - st.chains.m) / st.chains.s,
    ...GROUP_NAMES.map((n) => (g === n ? 1 : 0)),
  ];
}

function featStats(list: SnapshotProtocol[], asOf: string): FeatStats {
  const ages = list.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null).sort((a, b) => a - b);
  const medAge = (ages.length > 0 ? ages[Math.floor(ages.length / 2)]! : 730) / 365;
  return {
    medAge,
    lT: meanSd(list.map((p) => Math.log(p.tvl_usd))),
    age: { m: 1.5, s: 1.2 },
    growth: { m: 0.08, s: 0.4 },
    chains: { m: 3, s: 3 },
  };
}

interface Fitted {
  beta: number[];
  st: FeatStats;
}

function fitAnchors(anchors: SnapshotProtocol[], asOf: string): Fitted {
  const st = featStats(anchors, asOf);
  const x = anchors.map((p) => feats(p, asOf, st));
  const y = anchors.map((p) => Math.log(p.mcap_usd as number));
  return { beta: solveRidge(x, y, FEATURE_DIM, RIDGE_LAMBDA), st };
}

function logMcapOf(p: SnapshotProtocol, asOf: string, f: Fitted): number {
  return feats(p, asOf, f.st).reduce((a, v, j) => a + v * f.beta[j]!, 0);
}

/** Per-term log contributions for the detail view: [label, log-points]. */
function contributions(p: SnapshotProtocol, asOf: string, f: Fitted): Array<[string, number]> {
  const x = feats(p, asOf, f.st);
  const labels = ['intercept', 'log TVL', 'listing age', 'age unknown', '7d change', 'chain count', ...GROUP_NAMES.map((n) => `sector: ${n}`)];
  return x.map((v, j) => [labels[j]!, round3(v * f.beta[j]!)] as [string, number]);
}

/** Raw (unstandardised) slopes so the model panel can print the fitted equation in plain units. */
function rawTerms(f: Fitted): { intercept: number; slopes: Array<[string, string, number]> } {
  const s = f.st;
  const defs: Array<[string, string, number, number, number]> = [
    ['log TVL', 'per log-TVL (x2.72)', f.beta[1]!, s.lT.m, s.lT.s],
    ['listing age', 'per year, to 5y', f.beta[2]!, s.age.m, s.age.s],
    ['7d change', 'per 100% change', f.beta[4]!, s.growth.m, s.growth.s],
    ['chain count', 'per chain, to 12', f.beta[5]!, s.chains.m, s.chains.s],
  ];
  let intercept = f.beta[0]!;
  const slopes: Array<[string, string, number]> = [];
  for (const [label, unit, bz, m, sd] of defs) {
    slopes.push([label, unit, round3(bz / sd)]);
    intercept -= bz * (m / sd);
  }
  slopes.push(['age unknown flag', 'when listed_at is null', round3(f.beta[3]!)]);
  GROUP_NAMES.forEach((n, i) => slopes.push([`sector: ${n}`, 'one-hot vs other', round3(f.beta[6 + i]!)]));
  return { intercept: round3(intercept), slopes };
}

const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;

// ---------------------------------------------------------------- launch odds
// P(ever launches) read off the snapshot's own cohort:
//   base    = (launched_in_category + k x overall_rate) / (in_category + k)   [shrinkage, k = 6]
//   boost   = launch rate of the protocol's TVL band / overall rate           [clamped 0.8..1.3]
//   discount= token-less share of its age band / token-less share of the 0-90d band
//             [clamped 0.35..1: peers of its standing have mostly launched, so an old token-less
//              protocol sits in a shrinking pool]
//   odds    = clamp(base x boost x discount, 0.01, 0.92)
// Age unknown falls back to the median known age of today's pre-token cohort.

export interface OddsTables {
  overall_rate: number;
  shrink_k: number;
  tvl_bands: Array<{ lo: number; hi: number; label: string; protocols: number; launch_rate: number; boost: number }>;
  age_bands: Array<{ lo: number; hi: number; label: string; protocols: number; pre_token_share: number; discount: number }>;
  category_rates: Array<{ category: string; protocols: number; launched: number; base: number }>;
}

export interface OddsParts {
  odds: number;
  base: number;
  boost: number;
  discount: number;
  band_note: string;
}

interface OddsModel {
  tables: OddsTables;
  tvlRates: number[];
  preShares: number[];
  catBase: Map<string | null, number>;
  medPreAge: number;
}

const TVL_BANDS: Array<[number, number, string]> = [
  [0, 50_000_000, '<$50M'],
  [50_000_000, 200_000_000, '$50-200M'],
  [200_000_000, 1_000_000_000, '$200M-1B'],
  [1_000_000_000, Infinity, '$1B+'],
];
const AGE_BANDS: Array<[number, number, string]> = [
  [0, 90, '0-90d'],
  [90, 180, '90-180d'],
  [180, 365, '6-12mo'],
  [365, 730, '1-2y'],
  [730, Infinity, '2y+'],
];

function bandIndex(bands: Array<[number, number, string]>, v: number): number {
  for (let i = 0; i < bands.length; i++) if (v >= bands[i]![0] && v < bands[i]![1]) return i;
  return bands.length - 1;
}

export function buildOddsModel(snapshot: Snapshot): OddsModel {
  const P = snapshot.protocols;
  const launched = P.filter((p) => !isPreToken(p));
  const overall = launched.length / P.length;
  const tvlRates = TVL_BANDS.map(([lo, hi]) => {
    let n = 0;
    let l = 0;
    for (const p of P) if (p.tvl_usd >= lo && p.tvl_usd < hi) { n++; if (!isPreToken(p)) l++; }
    return n > 0 ? l / n : overall;
  });
  const preShares = AGE_BANDS.map(([lo, hi]) => {
    let n = 0;
    let pre = 0;
    for (const p of P) {
      const d = ageDays(snapshot.as_of, p.listed_at);
      if (d !== null && d >= lo && d < hi) { n++; if (isPreToken(p)) pre++; }
    }
    return n > 0 ? pre / n : 1;
  });
  const catBase = new Map<string | null, number>();
  const byCat = new Map<string | null, [number, number]>();
  for (const p of P) {
    const e = byCat.get(p.category) ?? [0, 0];
    e[0]++;
    if (!isPreToken(p)) e[1]++;
    byCat.set(p.category, e);
  }
  const k = 6;
  for (const [cat, [n, l]] of byCat) catBase.set(cat, (l + k * overall) / (n + k));
  const preAges = P.filter((p) => isPreToken(p)).map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null).sort((a, b) => a - b);
  const medPreAge = preAges.length > 0 ? preAges[Math.floor(preAges.length / 2)]! : 365;
  const tables: OddsTables = {
    overall_rate: round3(overall),
    shrink_k: k,
    tvl_bands: TVL_BANDS.map(([lo, hi, label], i) => ({
      lo,
      hi,
      label,
      protocols: P.filter((p) => p.tvl_usd >= lo && p.tvl_usd < hi).length,
      launch_rate: round3(tvlRates[i]!),
      boost: round3(clamp(tvlRates[i]! / overall, 0.8, 1.3)),
    })),
    age_bands: AGE_BANDS.map(([lo, hi, label], i) => ({
      lo,
      hi,
      label,
      protocols: P.filter((p) => {
        const d = ageDays(snapshot.as_of, p.listed_at);
        return d !== null && d >= lo && d < hi;
      }).length,
      pre_token_share: round3(preShares[i]!),
      discount: round3(clamp(preShares[i]! / preShares[0]!, 0.35, 1)),
    })),
    category_rates: [...byCat.entries()]
      .map(([cat, [n, l]]) => ({ category: cat ?? '(none)', protocols: n, launched: l, base: round3(catBase.get(cat)!) }))
      .sort((a, b) => b.protocols - a.protocols),
  };
  return { tables, tvlRates, preShares, catBase, medPreAge };
}

export function launchOdds(p: SnapshotProtocol, asOf: string, m: OddsModel): OddsParts {
  const base = m.catBase.get(p.category) ?? m.tables.overall_rate;
  const tb = bandIndex(TVL_BANDS, p.tvl_usd);
  const boost = clamp(m.tvlRates[tb]! / m.tables.overall_rate, 0.8, 1.3);
  const d = ageDays(asOf, p.listed_at) ?? m.medPreAge;
  const ab = bandIndex(AGE_BANDS, d);
  const discount = clamp(m.preShares[ab]! / m.preShares[0]!, 0.35, 1);
  return {
    odds: clamp(base * boost * discount, 0.01, 0.92),
    base: round3(base),
    boost: round3(boost),
    discount: round3(discount),
    band_note: `TVL band ${TVL_BANDS[tb]![2]}, age band ${AGE_BANDS[ab]![2]}`,
  };
}

// ---------------------------------------------------------------- held-out validation
// Leave-one-out over the anchors: refit without anchor i (its own standardisation included), predict
// it, and take max(pred/actual, actual/pred) — the fold error as a factor, so x3.0 means the median
// held-out anchor is mispriced three-fold either way. Walk-forward: train on the older half by
// listed_at, test the newer half (anchors with no listed_at cannot be ordered and sit out of this
// one, reported as such).

export interface Validation {
  loo_folds: number;
  loo_median_ratio: number;
  loo_p75_ratio: number;
  wf_train: number;
  wf_test: number;
  wf_median_ratio: number;
  anchors_used: number;
  anchors_dropped_nonpositive: number;
  anchors_dropped_sub1m: number;
  anchors_dropped_ratio60: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const a = xs.slice().sort((x, z) => x - z);
  return a[Math.floor(a.length / 2)]!;
}

function ratioOf(predLog: number, actual: number): number {
  const pr = Math.exp(predLog);
  return Math.max(pr / actual, actual / pr);
}

function selectAnchors(P: SnapshotProtocol[]): { anchors: SnapshotProtocol[]; nonpos: number; sub1m: number; ratio60: number } {
  let nonpos = 0;
  let sub1m = 0;
  let ratio60 = 0;
  const anchors: SnapshotProtocol[] = [];
  for (const p of P) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    if (p.mcap_usd <= 0) { nonpos++; continue; }
    if (p.mcap_usd < 1_000_000) { sub1m++; continue; }
    if (p.mcap_usd / p.tvl_usd > 60) { ratio60++; continue; }
    anchors.push(p);
  }
  return { anchors, nonpos, sub1m, ratio60 };
}

// ---------------------------------------------------------------- farm economics
// A per-protocol plan: position sized to TVL, gas estimated per chain (stated per-action figures),
// hours priced at $25, and an expected airdrop of 6% of the implied value at launch captured in
// proportion to the position's share of farming TVL (12% of TVL at launch), doubled for a dedicated
// single wallet. net = EV - gas - hours x $25 decides the verdict: >= $40 farm, > $0 thin, else skip.

export const FARM_ASSUMPTIONS = {
  pool_share: 0.06,
  farm_tvl_share: 0.12,
  concentration: 2,
  hourly_usd: 25,
  farm_min_net: 40,
};

const GAS_PER_ACTION: Array<[RegExp, number, string]> = [
  [/^ethereum$/i, 14, 'a $14 tx on Ethereum mainnet'],
  [/arbitrum|optimism|base|zksync|scroll|linea|mantle|blast|mode|polygon zk|ink|unichain|sonic/i, 0.8, 'a $0.80 tx on that L2'],
  [/^solana$/i, 0.15, 'a $0.15 tx on Solana'],
  [/^binance$|^bsc$/i, 0.35, 'a $0.35 tx on BSC'],
  [/$^/, 0.6, 'a $0.60 tx on that chain'],
];

function gasNote(chain: string | undefined): number {
  const c = (chain ?? '').toLowerCase();
  for (const [re, usd] of GAS_PER_ACTION) if (re.test(c)) return usd;
  return 0.6;
}

function positionFor(tvl: number): number {
  return tvl < 50_000_000 ? 800 : tvl < 200_000_000 ? 1_200 : tvl < 1_000_000_000 ? 2_000 : 3_000;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 90;
  if (age < 180) return 120;
  if (age < 365) return 90;
  return 60;
}

export interface FarmPlan {
  verdict: 'farm' | 'thin' | 'skip';
  position_usd: number;
  gas_usd: number;
  hours: number;
  pool_usd: number;
  capture: number;
  ev_usd: number;
  cost_usd: number;
  net_usd: number;
  steps: Array<{ do: string; cost: string; time: string }>;
}

function farmPlan(p: SnapshotProtocol, odds: number, implied: number, age: number | null): FarmPlan {
  const pos = positionFor(p.tvl_usd);
  const chain = p.chains[0] ?? 'its main chain';
  const g1 = gasNote(p.chains[0]);
  let gas = Math.round(g1 * 7 + 4);
  let hours = 3.25;
  const alt = p.chains.length > 1 ? p.chains[1] : null;
  if (alt !== null) {
    gas += Math.round(5 + gasNote(alt) * 3);
    hours += 0.75;
  }
  const pool = implied * odds * FARM_ASSUMPTIONS.pool_share;
  const capture = clamp((pos / (p.tvl_usd * FARM_ASSUMPTIONS.farm_tvl_share)) * FARM_ASSUMPTIONS.concentration, 5e-6, 0.01);
  const ev = pool * capture;
  const cost = Math.round(4 + gas);
  const net = Math.round(ev - cost - hours * FARM_ASSUMPTIONS.hourly_usd);
  const verdict: FarmPlan['verdict'] = net >= FARM_ASSUMPTIONS.farm_min_net ? 'farm' : net > 0 ? 'thin' : 'skip';
  const hold = holdDaysFor(age);
  const cat = (p.category ?? '').toLowerCase();
  const usd = (n: number): string => (n >= 1000 ? `$${Math.round(n / 100) / 10}k` : `$${Math.round(n)}`);

  let action: string;
  if (/deriv|perp|basis|prediction/.test(cat)) {
    action = `Deposit ${usd(pos)} USDC as collateral on ${p.name} (${chain}), open one small long and hedge it with an equal opposite trade so funding cost stays near zero.`;
  } else if (/lend|cdp|collateral/.test(cat)) {
    action = `Supply ${usd(pos)} USDC as collateral on ${p.name} (${chain}) and borrow a stable worth about a quarter of it, keeping both sides open.`;
  } else if (/\bdex|swap|amm/.test(cat)) {
    action = `Pair ${usd(pos / 2)}/${usd(pos / 2)} of the pool's two assets and provide liquidity in ${p.name}'s deepest pool on ${chain}, ranged wide.`;
  } else if (/yield|farm|liquidity manager|leveraged/.test(cat)) {
    action = `Deposit ${usd(pos)} of the vault asset into ${p.name}'s main strategy on ${chain} and let it compound; touch nothing until the hold ends.`;
  } else if (/curator|capital allocator/.test(cat)) {
    action = `Deposit ${usd(pos)} into one of ${p.name}'s curated vaults on ${chain}, keep the receipt shares, and leave the allocator's picks untouched.`;
  } else if (/restak|staking/.test(cat)) {
    action = `Stake ${usd(pos)} of the native asset through ${p.name} on ${chain} and hold the liquid receipt token it mints.`;
  } else if (/rwa|index|token locker|launchpad|payment|stablecoin|insurance/.test(cat)) {
    action = `Mint or buy ${usd(pos)} of ${p.name}'s yield-bearing asset on ${chain} and hold it through at least one full payout cycle.`;
  } else {
    action = `Deposit ${usd(pos)} USDC into ${p.name}'s main pool on ${chain} and leave the position open for the whole hold window.`;
  }

  const steps: Array<{ do: string; cost: string; time: string }> = [
    { do: `Open a fresh wallet for this farm alone and fund it with ${usd(pos)} of USDC plus gas; keep the seed offline and reuse it for nothing else.`, cost: `about $${(Math.round(g1 * 10) / 10)} to fund and first tx`, time: '15 minutes' },
    { do: action, cost: `${usd(pos)} of capital, ${usd(g1 * 2)} in gas for entry`, time: '30 minutes' },
  ];
  if (alt !== null) {
    steps.push({ do: `Split a third of the position onto ${alt} through ${p.name} so activity shows on two chains; bridge over, position, and leave it.`, cost: `about $5 bridge fee plus ${usd(gasNote(alt) * 2)} gas`, time: '45 minutes' });
  }
  steps.push({ do: `Do one qualifying action a week for four weeks (small deposit, swap, vote), alternating the type so the wallet reads as one real user.`, cost: `about ${usd(g1 * 4)} in gas over the month`, time: '10 minutes a week' });
  steps.push({ do: `Hold at least ${hold} days so the wallet spans several monthly snapshots; check the position weekly and never claim from a chat link.`, cost: `the ${usd(pos)} stays locked meanwhile`, time: `${hold} days, 5 min a week` });
  steps.push({ do: `When a token is announced, claim through ${p.name}'s own interface only, then unwind: exit the position and log the tx hashes for the filing.`, cost: `${usd(g1 + 4)} gas to exit`, time: '45 minutes' });
  return { verdict, position_usd: pos, gas_usd: cost, hours, pool_usd: Math.round(pool), capture, ev_usd: Math.round(ev), cost_usd: cost, net_usd: net, steps };
}

// ---------------------------------------------------------------- board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  launch_odds: number;
  odds_parts: { base: number; boost: number; discount: number; band_note: string };
  fitted_mcap_usd: number;
  value_factors: Array<[string, number]>;
  verdict: FarmPlan['verdict'];
  farm: {
    position_usd: number;
    gas_usd: number;
    hours: number;
    ev_usd: number;
    cost_usd: number;
    net_usd: number;
    hourly_usd: number;
    pool_usd: number;
    capture: number;
  };
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  mcap_tvl: number;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  fetched: string;
  source_note: string;
  floor_usd: number;
  model_name: string;
  model_version: string;
  ridge_lambda: number;
  n_protocols: number;
  n_pre_token: number;
  n_rankable: number;
  watchlist_size: number;
  board_size: number;
  fit: {
    equation_intercept: number;
    equation_slopes: Array<[string, string, number]>;
    n_anchors: number;
    validation: Validation;
  };
  odds: OddsTables;
  odds_formula: string;
  farm_assumptions: typeof FARM_ASSUMPTIONS;
  rows: BoardRow[];
  live: LiveRow[];
}

const IMPLIED_CAP_N = IMPLIED_CAP;

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;
  const { anchors, nonpos, sub1m, ratio60 } = selectAnchors(snapshot.protocols);
  if (anchors.length < FEATURE_DIM * 2) throw new Error(`only ${anchors.length} traded anchors: too few to fit`);
  const fitted = fitAnchors(anchors, asOf);
  const validation = validateWithCounts(anchors, asOf, nonpos, sub1m, ratio60);
  const oddsModel = buildOddsModel(snapshot);

  const watch = new Set(snapshot.watchlist);
  const subjects = snapshot.protocols.filter(isRankable);
  const rows: BoardRow[] = subjects.map((p) => {
    const odds = launchOdds(p, asOf, oddsModel);
    const lm = logMcapOf(p, asOf, fitted);
    const fittedMcap = Math.min(IMPLIED_CAP_N, Math.max(1, Math.round(Math.exp(lm))));
    const implied = Math.min(IMPLIED_CAP_N, Math.max(1, Math.round(fittedMcap * odds.odds)));
    const plan = farmPlan(p, odds.odds, implied, ageDays(asOf, p.listed_at));
    return {
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: ageDays(asOf, p.listed_at),
      on_watchlist: watch.has(p.slug),
      implied_value_usd: implied,
      launch_odds: odds.odds,
      odds_parts: { base: odds.base, boost: odds.boost, discount: odds.discount, band_note: odds.band_note },
      fitted_mcap_usd: fittedMcap,
      value_factors: contributions(p, asOf, fitted),
      verdict: plan.verdict,
      farm: {
        position_usd: plan.position_usd,
        gas_usd: plan.gas_usd,
        hours: plan.hours,
        ev_usd: plan.ev_usd,
        cost_usd: plan.cost_usd,
        net_usd: plan.net_usd,
        hourly_usd: FARM_ASSUMPTIONS.hourly_usd,
        pool_usd: plan.pool_usd,
        capture: Math.round(plan.capture * 1e6) / 1e6,
      },
      farm_steps: plan.steps.map(stepText),
    };
  });
  rows.sort((a, b) =>
    b.implied_value_usd - a.implied_value_usd ||
    b.tvl_usd - a.tvl_usd ||
    (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  rows.forEach((r, i) => { r.rank = i + 1; });

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .slice(0, 40)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      mcap_tvl: Math.round(((p.mcap_usd as number) / p.tvl_usd) * 100) / 100,
      change_7d: p.change_7d,
    }));

  const raw = rawTerms(fitted);
  const { note, fetched } = sourceNote(snapshot.source);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    fetched: fetched ?? snapshot.as_of,
    source_note: note,
    floor_usd: snapshot.floor_usd,
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    ridge_lambda: RIDGE_LAMBDA,
    n_protocols: snapshot.protocols.length,
    n_pre_token: snapshot.protocols.filter(isPreToken).length,
    n_rankable: subjects.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    fit: {
      equation_intercept: raw.intercept,
      equation_slopes: raw.slopes,
      n_anchors: anchors.length,
      validation,
    },
    odds: oddsModel.tables,
    odds_formula:
      'P(launch) = clamp( base x TVL-boost x age-discount, 1%, 92% ) where base = (category launches + 6 x overall rate) / (category size + 6), TVL-boost = band launch rate / overall (0.8-1.3), age-discount = token-less share of its age band / of the 0-90d band (0.35-1).',
    farm_assumptions: FARM_ASSUMPTIONS,
    rows,
    live,
  };
  return { board: rows, radar };
}

function validateWithCounts(anchors: SnapshotProtocol[], asOf: string, nonpos: number, sub1m: number, ratio60: number): Validation {
  const loo: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const rest = anchors.filter((_, j) => j !== i);
    const f = fitAnchors(rest, asOf);
    loo.push(ratioOf(logMcapOf(anchors[i]!, asOf, f), anchors[i]!.mcap_usd as number));
  }
  const dated = anchors
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.listed_at !== null)
    .sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : a.p.listed_at! > b.p.listed_at! ? 1 : a.i - b.i));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half).map(({ p }) => p);
  const test = dated.slice(half).map(({ p }) => p);
  const wf = fitAnchors(train, asOf);
  const wfRatios = test.map((p) => ratioOf(logMcapOf(p, asOf, wf), p.mcap_usd as number));
  return {
    loo_folds: loo.length,
    loo_median_ratio: Math.round(median(loo) * 100) / 100,
    loo_p75_ratio: Math.round(loo.slice().sort((a, b) => a - b)[Math.floor(loo.length * 0.75)]! * 100) / 100,
    wf_train: train.length,
    wf_test: test.length,
    wf_median_ratio: Math.round(median(wfRatios) * 100) / 100,
    anchors_used: anchors.length,
    anchors_dropped_nonpositive: nonpos,
    anchors_dropped_sub1m: sub1m,
    anchors_dropped_ratio60: ratio60,
  };
}

export function stepText(step: { do: string; cost: string; time: string }): string {
  let s = `${step.do} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Watch the position weekly.`;
  return s;
}

/** The snapshot's fetch time, as text with no address in it, for the page's own footer. */
function sourceNote(source: string): { note: string; fetched: string | null } {
  const at = source.indexOf('fetched ');
  const fetched = at >= 0 ? source.slice(at + 8).trim() : null;
  return { note: 'DefiLlama protocols index', fetched };
}

// ---------------------------------------------------------------- parsing and gate checks

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i): SnapshotProtocol => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Every gate row, checked before anything is written; returns the first failure's text or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100 minimum`;
  if (board.length > 4000) return `the board holds ${board.length} rows, over the 4000 maximum`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (!/^\S{1,128}$/.test(r.slug)) return `${r.slug} has whitespace or a bad length`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) return `${r.slug} has rank ${r.rank}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > IMPLIED_CAP) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is missing or duplicated`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `every row shares one implied value: the board ranks nothing`;
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
