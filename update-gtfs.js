const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  accept: 'application/zip,application/octet-stream,*/*',
};

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  if (count === 0) throw new Error('zip is empty (0 entries) — portal likely has a placeholder upload');
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (!name.endsWith('/')) {
      files.set(path.basename(name),
        method === 8 ? zlib.inflateRawSync(data) : method === 0 ? Buffer.from(data) : (() => { throw new Error(`unsupported zip method ${method}`); })());
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function downloadZip(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  const looksZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (!res.ok || !looksZip) {
    const ct = res.headers.get('content-type') || '?';
    const snippet = buf.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ');
    throw new Error(`not a zip (HTTP ${res.status}, content-type ${ct}, ${buf.length} bytes): "${snippet}"`);
  }
  return buf;
}

function validate(files, required) {
  for (const f of required) {
    if (!files.has(f)) throw new Error(`feed is missing ${f}`);
  }
  const cal = files.get('calendar.txt').toString('utf8');
  let ends = [...cal.matchAll(/,(\d{8})\s*$/gm)].map((m) => m[1]);
  // STCP ships an empty calendar.txt and drives all service through
  // calendar_dates.txt exceptions — the latest exception date is the
  // feed's real validity horizon then.
  if (!ends.length && files.has('calendar_dates.txt')) {
    const cd = files.get('calendar_dates.txt').toString('utf8');
    ends = [...cd.matchAll(/,(\d{8}),/g)].map((m) => m[1]);
  }
  if (!ends.length) throw new Error('feed has no service end dates');
  const maxEnd = ends.sort().at(-1);
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  if (maxEnd < today) throw new Error(`feed already expired (ends ${maxEnd})`);
  return { valid_until: maxEnd };
}

// One updater engine, reused per feed (metro, CP) via a small config: where
// to look for a newer zip, which files must be present, and where to
// install it. Files the new zip doesn't include (e.g. metro's "for apps"
// export skips fares/amenities) are simply left as whatever is already
// installed, since the swap below only touches filenames present in the zip.
function makeUpdater({ label, dir, findResources, required }) {
  const stateFile = path.join(dir, '.state.json');

  function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { return {}; }
  }

  async function checkAndUpdate({ force = false, log = console.log } = {}) {
    const resources = await findResources();
    const state = readState();
    if (!force && state.resource_id === resources[0].id && state.modified === resources[0].modified) {
      log(`${label} update: already on latest (${resources[0].modified || resources[0].id})`);
      return false;
    }
    let files = null, chosen = null, valid_until = null;
    const errors = [];
    for (const r of resources.slice(0, 3)) {
      if (!force && state.resource_id === r.id && state.modified === r.modified) break;
      try {
        log(`${label} update: downloading ${r.url}`);
        const buf = await downloadZip(r.url);
        const extracted = unzip(buf);
        ({ valid_until } = validate(extracted, required));
        files = extracted; chosen = r; break;
      } catch (err) {
        errors.push(`${r.name}: ${err.message}`);
        log(`${label} update: ${r.name} failed, trying next — ${err.message}`);
      }
    }
    if (!files) {
      if (errors.length) throw new Error(errors.join(' | '));
      log(`${label} update: nothing newer than the installed feed`);
      return false;
    }
    const staging = dir + '.new';
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const [name, data] of files) fs.writeFileSync(path.join(staging, name), data);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of files.keys()) fs.renameSync(path.join(staging, name), path.join(dir, name));
    fs.rmSync(staging, { recursive: true, force: true });
    fs.writeFileSync(stateFile, JSON.stringify({ resource_id: chosen.id, modified: chosen.modified, url: chosen.url, valid_until, installed_at: new Date().toISOString() }, null, 2));
    log(`${label} update: installed feed valid until ${valid_until}`);
    return true;
  }

  return { checkAndUpdate, readState };
}

// --- Metro do Porto ---------------------------------------------------

const METRO_DIR = process.env.GTFS_DIR || path.join(__dirname, 'gtfs');
const METRO_CKAN_API = 'https://opendata.porto.digital/api/3/action/package_show?id=horarios-paragens-e-rotas-em-formato-gtfs';
const METRO_SITE = 'https://www.metrodoporto.pt';
const METRO_PAGE = `${METRO_SITE}/pages/337`;
// calendar_dates.txt is required in the CKAN exports but the metro site's
// own "for apps" zip omits it (along with fares/amenities).
const METRO_REQUIRED = ['routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt', 'calendar.txt'];

async function findZipResourcesCkan(apiUrl) {
  const res = await fetch(apiUrl, { headers: { ...BROWSER_HEADERS, accept: 'application/json' } });
  if (!res.ok) throw new Error(`portal API ${res.status}`);
  const body = await res.json();
  if (!body.success || !body.result?.resources) throw new Error('unexpected portal response');
  const zips = body.result.resources.filter((r) => (r.url || '').toLowerCase().endsWith('.zip'));
  if (!zips.length) throw new Error('no zip resources in dataset');
  zips.sort((a, b) => String(b.last_modified || b.created || '').localeCompare(String(a.last_modified || a.created || '')));
  return zips.map((r) => ({ id: r.id, url: r.url, modified: r.last_modified || r.created || '', name: r.name || r.url.split('/').at(-1) }));
}

// Metro do Porto publishes the current GTFS export directly on its own site
// (the CKAN open-data portal has lagged behind it before). The page has a
// single "GTFS Horários (para aplicações)" download link — scrape it rather
// than hardcoding a URL, since the filename/id changes every season.
async function findZipResourcesMetroSite() {
  const res = await fetch(METRO_PAGE, { headers: { ...BROWSER_HEADERS, accept: 'text/html' } });
  if (!res.ok) throw new Error(`metro site ${res.status}`);
  const html = await res.text();
  const match = [...html.matchAll(/<a[^>]+href="([^"]+\.zip)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, href, inner]) => ({ href, text: inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
    .find((r) => /gtfs/i.test(r.text));
  if (!match) throw new Error('GTFS download link not found on metro site');
  const url = new URL(match.href, METRO_SITE).href;
  return [{ id: url, url, modified: '', name: match.text }];
}

async function findMetroResources() {
  const lists = await Promise.allSettled([findZipResourcesMetroSite(), findZipResourcesCkan(METRO_CKAN_API)]);
  const resources = [];
  const errors = [];
  for (const [i, r] of lists.entries()) {
    if (r.status === 'fulfilled') resources.push(...r.value);
    else errors.push(`${i === 0 ? 'metro site' : 'CKAN portal'}: ${r.reason.message}`);
  }
  if (!resources.length) throw new Error(errors.join(' | '));
  return resources;
}

const metro = makeUpdater({ label: 'Metro GTFS', dir: METRO_DIR, findResources: findMetroResources, required: METRO_REQUIRED });

// --- CP (Comboios de Portugal) -----------------------------------------

const CP_DIR = process.env.GTFS_CP_DIR || path.join(__dirname, 'gtfs_cp');
const CP_ZIP_URL = 'https://publico.cp.pt/gtfs/gtfs.zip';
const CP_REQUIRED = ['agency.txt', 'calendar.txt', 'calendar_dates.txt', 'routes.txt', 'stops.txt', 'stop_times.txt', 'trips.txt'];

// CP publishes one static zip URL and updates it in place (delays, strikes
// and minimum-service schedules all land as calendar_dates.txt exceptions
// inside it), so a HEAD request's Last-Modified is enough to detect change
// without downloading the whole zip every night.
async function findCpResources() {
  let modified = '';
  try {
    const head = await fetch(CP_ZIP_URL, { method: 'HEAD', headers: BROWSER_HEADERS });
    modified = head.headers.get('last-modified') || head.headers.get('etag') || '';
  } catch { /* fall through — checkAndUpdate will do a real GET and surface any error */ }
  return [{ id: CP_ZIP_URL, url: CP_ZIP_URL, modified, name: 'CP GTFS' }];
}

const cp = makeUpdater({ label: 'CP GTFS', dir: CP_DIR, findResources: findCpResources, required: CP_REQUIRED });

// --- STCP (Porto city buses) --------------------------------------------

const STCP_DIR = process.env.GTFS_STCP_DIR || path.join(__dirname, 'gtfs_stcp');
const STCP_CKAN_API = 'https://opendata.porto.digital/api/3/action/package_show?id=horarios-paragens-e-rotas-em-formato-gtfs-stcp';
// calendar.txt is present but empty in STCP exports — all service dates
// live in calendar_dates.txt, so that one is genuinely required here.
const STCP_REQUIRED = ['routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt', 'calendar.txt', 'calendar_dates.txt'];

// STCP publishes on the same CKAN portal as the metro, but as a new resource
// every few days ("GTFS STCP 21-07-2026 Mais Recente", …) — the shared CKAN
// lookup already sorts by last_modified, so the newest upload wins.
const stcp = makeUpdater({
  label: 'STCP GTFS',
  dir: STCP_DIR,
  findResources: () => findZipResourcesCkan(STCP_CKAN_API),
  required: STCP_REQUIRED,
});

module.exports = {
  // back-compat: default export is the metro updater, as before
  checkAndUpdate: metro.checkAndUpdate,
  readState: metro.readState,
  unzip,
  metro,
  cp,
  stcp,
};

if (require.main === module) {
  const which = process.argv.includes('--stcp') ? stcp : process.argv.includes('--cp') ? cp : metro;
  which.checkAndUpdate({ force: process.argv.includes('--force') })
    .then((c) => console.log(c ? 'Feed updated.' : 'No change.'))
    .catch((err) => { console.error('Update failed:', err.message); process.exitCode = 1; });
}
