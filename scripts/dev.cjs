#!/usr/bin/env node
/**
 * Dev server: build once, watch sources, rebuild dist, reload browser.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'packages', 'cascade-studio', 'dist');
const port = Number(process.env.PORT || getArg('--port') || 8080);
const host = process.env.HOST || '127.0.0.1';
const clients = new Set();
let building = false;
let pending = false;
let timer = null;

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function build(reason = 'startup') {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  console.log(`\n[dev] Build start (${reason})`);
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });
  building = false;
  if (result.status === 0) {
    console.log('[dev] Build complete. Reloading browsers.');
    broadcast('reload');
  } else {
    console.error(`[dev] Build failed with exit ${result.status}`);
    broadcast('build-error');
  }
  if (pending) {
    pending = false;
    build('pending changes');
  }
}

function scheduleBuild(file) {
  clearTimeout(timer);
  timer = setTimeout(() => build(file || 'file change'), 150);
}

function broadcast(event) {
  for (const res of clients) {
    res.write(`event: ${event}\ndata: ${Date.now()}\n\n`);
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, '');
  const full = path.join(base, normalized || 'index.html');
  if (!full.startsWith(base)) return null;
  return full;
}

const reloadScript = `\n<script>\n(() => {\n  const es = new EventSource('/__dev_events');\n  es.addEventListener('reload', () => location.reload());\n  es.addEventListener('build-error', () => console.warn('[dev] Build failed; keep old page.'));\n})();\n</script>\n`;

const server = http.createServer((req, res) => {
  if (req.url === '/__dev_events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  let file = safeJoin(distDir, req.url === '/' ? '/index.html' : req.url);
  if (!file) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    if (path.basename(file) === 'index.html') {
      res.end(String(data).replace('</body>', `${reloadScript}</body>`));
    } else {
      res.end(data);
    }
  });
});

function watchDir(rel) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return;
  fs.watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const name = String(filename);
    if (name.includes(`${path.sep}dist${path.sep}`) || name.includes('node_modules')) return;
    scheduleBuild(path.join(rel, name));
  });
  console.log(`[dev] Watching ${rel}`);
}

build('startup');
server.listen(port, host, () => {
  console.log(`[dev] Serving http://${host}:${port}`);
});

[
  'packages/cascade-core/src',
  'packages/cascade-core/types',
  'packages/cascade-core/fonts',
  'packages/cascade-studio/src',
  'packages/cascade-studio/css',
  'packages/cascade-studio/textures',
  'packages/cascade-studio/icon',
  'packages/cascade-studio/lib',
  'test/fixtures',
].forEach(watchDir);
