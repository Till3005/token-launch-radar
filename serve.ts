// Static server for the built dashboard: node serve.ts --port 8123 [--root out]
// Serves the output directory so dashboard/index.html can read ../data.js; no dependencies.

import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  return fallback;
}

const root = arg('root', process.env.MAKEFUN_OUTPUT_DIR ?? 'out');
const port = Number(arg('port', '8123'));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path === '/' || path === '\\') path = '/dashboard/index.html';
    const file = join(root, path);
    const st = await stat(file).catch(() => null);
    const target = st?.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target).catch(() => null);
    if (body === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('server error');
  }
});

server.listen(port, () => {
  process.stdout.write(`entry-radar: serving ${root} at http://localhost:${port}/\n`);
});
