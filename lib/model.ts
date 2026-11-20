// Entry Radar value model.
//
// implied_value_usd = tvl_usd x sector_multiple(category) x momentum(change_7d) x age_premium(listed_at) x breadth(chains)
//
// Every factor is a function of the snapshot's own ten fields; no protocol name is ever special-cased.
// The board ranks every pre-token protocol the snapshot carries (no token on record, not a wrapped or
// staked product, not an exchange) and sets protocols whose token already trades apart in a live view.

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

export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  age_floor: number;
  age_range: number;
  age_cap_days: number;
  unknown_age_days: number;
  breadth_weight: number;
  breadth_cap_chains: number;
  default_multiple: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.4,
  growth_floor: -60,
  growth_cap: 150,
  age_floor: 0.85,
  age_range: 0.4,
  age_cap_days: 1095,
  unknown_age_days: 365,
  breadth_weight: 0.025,
  breadth_cap_chains: 12,
  default_multiple: 0.35,
};

export const MODEL_NAME = 'entry-radar/sector-x-momentum';
export const MODEL_VERSION = 'radar-2';

/** Sector multiples: what a dollar of TVL implies in equity value once a sector's token trades. */
export interface SectorRule {
  id: string;
  label: string;
  multiple: number;
  note: string;
  pattern: RegExp;
}

export const SECTORS: SectorRule[] = [
  { id: 'trading', label: 'Trading venue', multiple: 0.85, note: 'Derivatives, perps, prediction and basis venues monetize velocity, so a sector token prices richest per dollar of TVL.', pattern: /deriv|perpetual|basis|prediction|otc/i },
  { id: 'infrastructure', label: 'Infrastructure', multiple: 0.6, note: 'Chains, staking and restaking pools, bridges and insurance layers carry protocol-level option value.', pattern: /^chain$|staking|restak|bridge|insurance/i },
  { id: 'swap', label: 'Spot exchange', multiple: 0.55, note: 'Dexs and swap venues take a fee on volume, the most proven token-cashflow story in the market.', pattern: /\bdex|swap|amm/i },
  { id: 'credit', label: 'Credit', multiple: 0.4, note: 'Lending, CDP and collateral markets earn a spread; multiples sit near liquid lending peers.', pattern: /lend|cdp|collateral|cedefi/i },
  { id: 'cashflow', label: 'Cashflow asset', multiple: 0.35, note: 'RWA, payments, stablecoin wrappers, card issuers and indexes distribute a real yield to holders.', pattern: /rwa|payment|stablecoin|card|index|btc$/i },
  { id: 'yield', label: 'Yield product', multiple: 0.3, note: 'Yield vaults, farms and leveraged or managed liquidity products take a cut of an existing return.', pattern: /yield|farm|liquidity/i },
  { id: 'curation', label: 'Curation service', multiple: 0.28, note: 'Risk curators and capital allocators run other people\'s money for a performance fee.', pattern: /curator|allocator|governance/i },
];

export function sectorOf(category: string | null): SectorRule {
  const c = category ?? '';
  for (const s of SECTORS) if (s.pattern.test(c)) return s;
  return { id: 'default', label: 'Unclassified', multiple: MODEL.default_multiple, note: 'No category on record: scored at the default multiple.', pattern: /$^/ };
}

const DAY_MS = 86_400_000;
const IMPLIED_CAP = 100_000_000_000_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days between the snapshot date and the day the protocol was first tracked. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export interface FactorBreakdown {
  sector: SectorRule;
  age_days: number | null;
  growth_pct: number | null;
  growth_mult: number;
  age_mult: number;
  breadth_mult: number;
  implied: number;
}

export function impliedValue(p: SnapshotProtocol, asOf: string, model: ModelConstants = MODEL): FactorBreakdown {
  const sector = sectorOf(p.category);
  const age = ageDays(asOf, p.listed_at);
  const raw = p.change_7d === null || !Number.isFinite(p.change_7d) ? null : p.change_7d;
  const clamped = raw === null ? null : Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
  const growthMult = clamped === null ? 1 : 1 + (clamped / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const ageMult = model.age_floor + (Math.min(Math.max(ageForModel, 0), model.age_cap_days) / model.age_cap_days) * model.age_range;
  const breadthMult = 1 + model.breadth_weight * Math.min(p.chains.length, model.breadth_cap_chains);
  const implied = Math.min(IMPLIED_CAP, Math.max(1, Math.round(p.tvl_usd * sector.multiple * growthMult * ageMult * breadthMult)));
  return { sector, age_days: age, growth_pct: clamped, growth_mult: round4(growthMult), age_mult: round4(ageMult), breadth_mult: round4(breadthMult), implied };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

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

export interface FarmStep {
  do: string;
  cost: string;
  time: string;
}

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
  factors: {
    sector_id: string;
    sector_label: string;
    sector_multiple: number;
    sector_note: string;
    growth_pct: number | null;
    growth_mult: number;
    age_mult: number;
    breadth_mult: number;
  };
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  fetched: string;
  source_note: string;
  floor_usd: number;
  model: ModelConstants;
  model_name: string;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  sectors: Array<{ id: string; label: string; multiple: number; note: string }>;
  rows: BoardRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export function stepText(step: FarmStep): string {
  let s = `${step.do} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Watch the position weekly.`;
  return s;
}

function firstChain(p: SnapshotProtocol): string {
  return p.chains[0] ?? 'its main chain';
}

function secondChain(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1] : null;
}

function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 25_000_000) return 100;
  return 75;
}

function holdFor(age: number | null): number {
  if (age === null) return 40;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const chain = firstChain(p);
  if (/deriv|perp|basis|prediction/.test(c)) return `Deposit $${capital} of USDC as margin on ${name} (${chain}) and open one small position; hedge it with an equal opposite trade on the same venue so funding cost stays near zero.`;
  if (/lend|cdp|collateral|cedefi/.test(c)) return `Supply $${capital} of USDC as collateral on ${name} (${chain}), borrow a stablecoin worth about a quarter of it, and keep both sides of the loan open.`;
  if (/\bdex|swap|amm/.test(c)) return `Pair $${capital}/$${capital} of the pool's two assets and provide liquidity to ${name}'s deepest pool on ${chain}; range it wide if the venue is concentrated.`;
  if (/yield|farm|liquidity/.test(c)) return `Deposit $${capital} of the vault's asset into ${name}'s main strategy on ${chain} and let it auto-compound; withdraw nothing for the full hold window.`;
  if (/curator|allocator|governance/.test(c)) return `Deposit $${capital} into one of ${name}'s curated vaults on ${chain}, keep the receipt shares, and leave the curator's allocation untouched.`;
  if (/rwa|payment|stablecoin|card|index/.test(c)) return `Mint or buy $${capital} of ${name}'s yield-bearing asset on ${chain}, hold it through at least one payout cycle, and keep the balance in the protocol.`;
  if (/staking|restak/.test(c)) return `Stake $${capital} of the chain's native asset through ${name} on ${chain} and hold the liquid receipt token it mints.`;
  if (/^chain$|bridge/.test(c)) return `Bridge $${capital} of USDC onto ${name} and spend a few dollars a week in one of its native apps so the address shows real usage.`;
  if (/insurance/.test(c)) return `Buy $${capital} of cover on ${name} for the largest protocol you already use, and renew it once before the hold window ends.`;
  return `Deposit $${capital} of USDC into ${name}'s main pool on ${chain} and keep the position open for the full hold window.`;
}

export function farmStepsFor(p: SnapshotProtocol, floorUsd: number, age: number | null): string[] {
  const capital = capitalFor(p.tvl_usd);
  const hold = holdFor(age);
  const chain = firstChain(p);
  const alt = secondChain(p);
  const steps: FarmStep[] = [
    { do: 'Open a fresh wallet used for this farm alone and fund it with only what you plan to park; keep the seed phrase offline.', cost: 'under $3 in gas to fund', time: '5 minutes' },
    { do: actionFor(p, capital), cost: `$${capital} of capital plus about $${capital >= 150 ? 9 : 4} in gas`, time: '15 minutes to set up' },
  ];
  if (alt !== null) {
    steps.push({ do: `Split the farm: open a second, smaller position of about $${Math.round(capital / 3)} on ${alt} through ${p.name} so activity shows on more than one chain.`, cost: `$${Math.round(capital / 3)} plus about $6 in gas`, time: '20 minutes' });
  }
  steps.push({ do: `Do one qualifying action each week: a deposit, a swap, a borrow-repay loop, or a governance vote, alternating between them.`, cost: 'about $2 in gas a week', time: '10 minutes a week' });
  steps.push({ do: `Hold the position for at least ${hold} days so the wallet's activity spans multiple monthly snapshots instead of one.`, cost: `the $${capital} stays locked in the position`, time: `${hold} days` });
  if (p.tvl_usd >= floorUsd) {
    steps.push({ do: `This protocol clears the watchlist floor of $${Math.round(floorUsd / 1e6)}M TVL, so treat it as a headline target: top up the position once mid-window rather than opening new ones elsewhere.`, cost: 'optional $50 top-up', time: '10 minutes' });
  }
  steps.push({ do: `Claim rewards only from ${p.name}'s own interface, never from a link in chat or mail, and check the claims tab weekly once a token is announced.`, cost: 'no fee to check; never pay to claim', time: '10 minutes a week' });
  steps.push({ do: `Log the wallet address, every transaction hash and the dates in a notes file so the position can be repeated or unwound without guessing.`, cost: 'nothing but the note-taking', time: '5 minutes' });
  return steps.map(stepText);
}

export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const subjects = snapshot.protocols.filter(isRankable);
  const watch = new Set(snapshot.watchlist);
  const scored = subjects.map((p) => {
    const f = impliedValue(p, snapshot.as_of, model);
    return { p, f };
  });
  scored.sort((a, b) => b.f.implied - a.f.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, f }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: f.age_days,
    on_watchlist: watch.has(p.slug),
    implied_value_usd: f.implied,
    factors: {
      sector_id: f.sector.id,
      sector_label: f.sector.label,
      sector_multiple: f.sector.multiple,
      sector_note: f.sector.note,
      growth_pct: f.growth_pct,
      growth_mult: f.growth_mult,
      age_mult: f.age_mult,
      breadth_mult: f.breadth_mult,
    },
    farm_steps: farmStepsFor(p, snapshot.floor_usd, f.age_days),
  }));
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The snapshot's fetch time, as text with no address in it, for the page's own footer. */
function sourceNote(source: string): { note: string; fetched: string | null } {
  const at = source.indexOf('fetched ');
  const fetched = at >= 0 ? source.slice(at + 8).trim() : null;
  return { note: 'DefiLlama protocols index', fetched };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const { note, fetched } = sourceNote(snapshot.source);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    fetched: fetched ?? snapshot.as_of,
    source_note: note,
    floor_usd: snapshot.floor_usd,
    model,
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    sectors: SECTORS.map((s) => ({ id: s.id, label: s.label, multiple: s.multiple, note: s.note })),
    rows: board,
    live: liveRows(snapshot),
  };
  return { board, radar };
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
