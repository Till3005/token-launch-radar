// Entry Radar build: reads the sealed snapshot, scores every pre-token protocol with lib/model.ts,
// writes /output/board.json and the dashboard's data.js, copies dashboard/ and screenshots/ into the
// output, and writes /output/dossier.json with make.fun's vendored buildDossier.
//
// Input order: --input <file|dir>, then $MAKEFUN_INPUT_DIR, then the mounted /input, then the copy
// bundled at data/snapshot.json so the page builds standalone outside the grader.
//
//   mkdir -p out && node main.ts --input data/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function resolveInput(): string | null {
  const candidates: string[] = [];
  const flag = process.argv.indexOf('--input') >= 0 || process.argv.some((a) => a.startsWith('--input=')) ? arg('input', '') : '';
  if (flag) candidates.push(flag.endsWith('.json') ? flag : join(flag, 'snapshot.json'));
  const env = process.env.MAKEFUN_INPUT_DIR;
  if (env) candidates.push(env.endsWith('.json') ? env : join(env, 'snapshot.json'));
  candidates.push('/input/snapshot.json');
  candidates.push(join(here, 'data', 'snapshot.json'));
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

const inputFile = resolveInput();
if (inputFile === null) {
  process.stderr.write('entry-radar: no snapshot found: pass --input <snapshot.json|dir>, set MAKEFUN_INPUT_DIR, mount /input, or keep data/snapshot.json\n');
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`entry-radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));
const pages = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`entry-radar: screenshots/ holds ${shots.length} file(s): hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));

const watched = board.filter((r) => r.on_watchlist).length;
const top = board[0]!;
const bytes = (p: string) => statSync(join(out, p)).size;
process.stdout.write(
  `entry-radar: snapshot ${snapshot.as_of}, ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watched, board ${board.length} rows (${watched} watchlist covered)\n` +
    `entry-radar: rank 1 ${top.name} at $${Math.round(top.implied_value_usd / 1e6)}M implied from $${Math.round(top.tvl_usd / 1e6)}M TVL\n` +
    `entry-radar: wrote board.json (${bytes('board.json')}B), data.js (${bytes('data.js')}B), dashboard/ (${pages.length} files), screenshots/ (${shots.length}) and dossier.json (${bytes('dossier.json')}B) from ${inputFile}\n`,
);
