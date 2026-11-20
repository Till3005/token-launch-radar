// Quick gate validator: node scripts/validate.mjs /tmp/radar-out [snapshot.json]
// Checks board.json against every row of the scorer's seven checks that touch board data.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '/tmp/radar-out';
const snapArg = process.argv[3] ?? (existsSync('/input/snapshot.json') ? '/input/snapshot.json' : join(process.cwd(), 'data/snapshot.json'));
const snap = JSON.parse(readFileSync(snapArg, 'utf8'));
const board = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8'));
const rows = Array.isArray(board) ? board : board.rows;

let fail = 0;
const bad = (msg) => { fail++; console.log('FAIL', msg); };
const ok = (msg) => console.log('ok  ', msg);

if (!Array.isArray(rows)) bad('rows is not an array');
else {
  if (rows.length < 100 || rows.length > 4000) bad(`rows ${rows.length} outside 100..4000`);
  else ok(`${rows.length} rows`);

  const known = new Map(snap.protocols.map((p) => [p.slug, p]));
  const slugs = new Set();
  for (const r of rows) {
    if (!known.has(r.slug)) bad(`slug ${r.slug} not in snapshot`);
    if (slugs.has(r.slug)) bad(`slug ${r.slug} appears twice`);
    slugs.add(r.slug);
    if (typeof r.slug !== 'string' || !/^\S{1,128}$/.test(r.slug)) bad(`bad slug ${r.slug}`);
    if (typeof r.name !== 'string' || r.name.length === 0) bad(`empty name on ${r.slug}`);
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) bad(`rank ${r.rank} on ${r.slug}`);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) bad(`implied ${r.implied_value_usd} on ${r.slug}`);
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) bad(`${r.slug} farm_steps count ${r.farm_steps?.length}`);
    else for (const s of r.farm_steps) {
      const t = String(s).trim();
      if (t.length < 20 || t.length > 600) bad(`${r.slug} step length ${t.length}`);
    }
  }
  if (slugs.size === rows.length) ok('slugs unique, all in snapshot, names and farm_steps in range');

  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  if (ranks.every((v, i) => v === i + 1)) ok(`ranks exactly 1..${rows.length}`);
  else bad('ranks are not exactly 1..N');

  let sortedOk = true;
  for (let i = 1; i < rows.length; i++) if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) sortedOk = false;
  if (sortedOk) ok('implied_value_usd non-increasing by rank');
  else bad('implied value rises with rank');

  const distinct = new Set(rows.map((r) => r.implied_value_usd));
  if (rows.length >= 2 && distinct.size === 1) bad('all implied values identical');
  else ok(`${distinct.size} distinct implied values`);

  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length === 0) ok(`all ${snap.watchlist.length} watchlist slugs covered`);
  else bad(`missing watchlist slugs: ${missing.join(', ')}`);

  const outside = rows.filter((r) => !snap.watchlist.includes(r.slug)).length;
  if (outside < 60) bad(`only ${outside} rows outside the watchlist (need >=60)`);
  else ok(`${outside} rows beyond the watchlist floor`);

  const spot = rows.slice(0, 3).map((r) => `${r.rank} ${r.slug} $${Math.round(r.implied_value_usd / 1e6)}M (tvl $${Math.round(known.get(r.slug).tvl_usd / 1e6)}M)`);
  console.log('spot', spot.join(' | '));
}

const dash = join(outDir, 'dashboard');
for (const f of ['index.html']) {
  if (!existsSync(join(dash, f))) bad(`dashboard/${f} missing`);
}
const css = readdirSync(dash).filter((f) => f.endsWith('.css'));
const js = readdirSync(dash).filter((f) => f.endsWith('.js'));
if (!css.length || !js.length) bad('dashboard needs at least one .css and one .js');
else ok(`dashboard files: ${readdirSync(dash).join(', ')}`);

const shots = readdirSync(join(outDir, 'screenshots')).filter((f) => !f.startsWith('.'));
if (shots.length < 3 || shots.length > 4) bad(`screenshots ${shots.length}, need 3..4`);
else {
  for (const f of shots) {
    const st = statSync(join(outDir, 'screenshots', f));
    if (st.size > 524288) bad(`screenshot ${f} ${st.size}B over 512KiB`);
    else console.log('ok   shot', f, Math.round(st.size / 1024) + 'KB');
  }
}

const dossierBytes = statSync(join(outDir, 'dossier.json')).size;
if (dossierBytes > 1.5 * 1024 * 1024) bad(`dossier ${dossierBytes}B over 1.5MiB`);
else ok(`dossier ${(dossierBytes / 1024).toFixed(0)}KB`);

const boardBytes = statSync(join(outDir, 'board.json')).size;
if (boardBytes > 8 * 1024 * 1024) bad('board.json over 8MiB');
else ok(`board.json ${(boardBytes / 1024).toFixed(0)}KB`);

const dashBytes = readdirSync(dash).reduce((n, f) => n + statSync(join(dash, f)).size, 0);
console.log((dashBytes < 65536 ? 'ok   ' : 'WARN ') + `dashboard sources ${dashBytes}B (dossier text cap 65536)`);

console.log(fail === 0 ? 'ALL CHECKS PASS' : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
