const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const gtfs = require('./gtfs');
const updater = require('./update-gtfs');

const PORT = process.env.PORT || 8088;
const ROOT = path.join(__dirname, 'public');
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

gtfs.load();

async function checkFeed() {
  try {
    const changed = await updater.checkAndUpdate();
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

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/config')  return json(res, 200, gtfs.getConfig());
  if (url.pathname === '/api/status')  return json(res, 200, updater.readState());
  if (url.pathname === '/api/departures') {
    const payload = gtfs.getDepartures(url.searchParams.get('stop'), url.searchParams.get('direction'));
    return json(res, payload.error ? 400 : 200, payload);
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Próximo running on http://localhost:${PORT}`));
