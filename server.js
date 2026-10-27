const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const gtfs = require('./gtfs');
const updater = require('./update-gtfs');

const PORT = process.env.PORT || 8088;
const ROOT = path.join(__dirname, 'public');
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

// App version shown in the page footer, so a deploy can be confirmed at a
// glance: the git commit the server was started from (the Docker build
// copies .git in with everything else), or APP_VERSION if set. The commit
// date is only readable while the commit is a loose object, so it's optional.
function readAppVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    const gitDir = path.join(__dirname, '.git');
    let sha = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (sha.startsWith('ref: ')) {
      const ref = sha.slice(5);
      try {
        sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
      } catch {
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
        sha = packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0];
      }
    }
    if (!/^[0-9a-f]{40}$/.test(sha || '')) return 'dev';
    let date = '';
    try {
      const obj = require('node:zlib').inflateSync(fs.readFileSync(path.join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2))));
      const ts = obj.toString('utf8').match(/^committer .* (\d+) [+-]\d{4}$/m)?.[1];
      if (ts) date = ` · ${new Date(ts * 1000).toISOString().slice(0, 10)}`;
    } catch { /* packed object — hash alone is enough */ }
    return `${sha.slice(0, 7)}${date}`;
  } catch {
    return 'dev';
  }
}
const APP_VERSION = readAppVersion();
console.log(`App version ${APP_VERSION}`);

gtfs.load();

async function checkFeed() {
  try {
    const changed = await updater.metro.checkAndUpdate();
    if (changed) gtfs.load();
  } catch (err) {
    console.error('GTFS update check failed (keeping current feed):', err.message);
  }
}
checkFeed();
setInterval(checkFeed, UPDATE_EVERY_MS);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Browsers (and proxies in front of the container) have been seen serving a
// previous deploy's app.js despite no-cache, mixing old code with new data.
// index.html is never stored, and every script/stylesheet URL it leads to
// carries the commit, so each deploy fetches fresh copies. The import map
// covers the modules app.js pulls in by plain relative path.
const INDEX_HTML = path.join(ROOT, 'index.html');
const ASSET_TAG = encodeURIComponent(APP_VERSION.split(' ')[0]);
const MODULES = ['data.js', 'i18n.js'];

function versionAssets(html) {
  const importMap = JSON.stringify({ imports: Object.fromEntries(MODULES.map((m) => [`./${m}`, `./${m}?v=${ASSET_TAG}`])) });
  return html
    .replace('href="style.css"', `href="style.css?v=${ASSET_TAG}"`)
    .replace('<script type="module" src="app.js"></script>',
      `<script type="importmap">${importMap}</script>\n  <script type="module" src="app.js?v=${ASSET_TAG}"></script>`);
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/config')  return json(res, 200, { ...gtfs.getConfig(), app_version: APP_VERSION });
  if (url.pathname === '/api/status')  return json(res, 200, { metro: updater.metro.readState() });
  if (url.pathname === '/api/departures') {
    const payload = gtfs.getDepartures(url.searchParams.get('stop'), url.searchParams.get('direction'));
    return json(res, payload.error ? 400 : 200, payload);
  }
  if (url.pathname === '/api/fare') {
    const payload = gtfs.getFare(url.searchParams.get('from'), url.searchParams.get('to'));
    return json(res, payload.error ? 400 : 200, payload);
  }
  if (url.pathname === '/api/trip') {
    const payload = gtfs.getTripPlan(url.searchParams.get('from'), url.searchParams.get('to'));
    return json(res, payload.error ? 400 : 200, payload);
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    if (file === INDEX_HTML) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      res.end(versionAssets(buf.toString('utf8')));
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Próximo running on http://localhost:${PORT}`));
