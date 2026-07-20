const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const GTFS_DIR = process.env.GTFS_DIR || path.join(__dirname, 'gtfs');
const STATE_FILE = path.join(GTFS_DIR, '.state.json');
const DATASET_API = 'https://opendata.porto.digital/api/3/action/package_show?id=horarios-paragens-e-rotas-em-formato-gtfs';
const REQUIRED = ['routes.txt', 'trips.txt', 'stop_times.txt', 'stops.txt', 'calendar.txt', 'calendar_dates.txt'];

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

async function findZipResources() {
  const res = await fetch(DATASET_API, { headers: { ...BROWSER_HEADERS, accept: 'application/json' } });
  if (!res.ok) throw new Error(`portal API ${res.status}`);
  const body = await res.json();
  if (!body.success || !body.result?.resources) throw new Error('unexpected portal response');
  const zips = body.result.resources.filter((r) => (r.url || '').toLowerCase().endsWith('.zip'));
  if (!zips.length) throw new Error('no zip resources in dataset');
  zips.sort((a, b) => String(b.last_modified || b.created || '').localeCompare(String(a.last_modified || a.created || '')));
  return zips.map((r) => ({ id: r.id, url: r.url, modified: r.last_modified || r.created || '', name: r.name || r.url.split('/').at(-1) }));
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

function validate(files) {
  for (const f of REQUIRED) {
    if (!files.has(f)) throw new Error(`feed is missing ${f}`);
  }
  const cal = files.get('calendar.txt').toString('utf8');
  const ends = [...cal.matchAll(/,(\d{8})\s*$/gm)].map((m) => m[1]);
  if (!ends.length) throw new Error('calendar.txt has no end dates');
  const maxEnd = ends.sort().at(-1);
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  if (maxEnd < today) throw new Error(`feed already expired (ends ${maxEnd})`);
  return { valid_until: maxEnd };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

async function checkAndUpdate({ force = false, log = console.log } = {}) {
  const resources = await findZipResources();
  const state = readState();
  if (!force && state.resource_id === resources[0].id && state.modified === resources[0].modified) {
    log(`GTFS update: already on latest (${resources[0].modified || resources[0].id})`);
    return false;
  }
  let files = null, chosen = null, valid_until = null;
  const errors = [];
  for (const r of resources.slice(0, 3)) {
    if (!force && state.resource_id === r.id && state.modified === r.modified) break;
    try {
      log(`GTFS update: downloading ${r.url}`);
      const buf = await downloadZip(r.url);
      const extracted = unzip(buf);
      ({ valid_until } = validate(extracted));
      files = extracted; chosen = r; break;
    } catch (err) {
      errors.push(`${r.name}: ${err.message}`);
      log(`GTFS update: ${r.name} failed, trying next — ${err.message}`);
    }
  }
  if (!files) {
    if (errors.length) throw new Error(errors.join(' | '));
    log('GTFS update: nothing newer than the installed feed');
    return false;
  }
  const staging = GTFS_DIR + '.new';
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const [name, data] of files) fs.writeFileSync(path.join(staging, name), data);
  fs.mkdirSync(GTFS_DIR, { recursive: true });
  for (const name of files.keys()) fs.renameSync(path.join(staging, name), path.join(GTFS_DIR, name));
  fs.rmSync(staging, { recursive: true, force: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ resource_id: chosen.id, modified: chosen.modified, url: chosen.url, valid_until, installed_at: new Date().toISOString() }, null, 2));
  log(`GTFS update: installed feed valid until ${valid_until}`);
  return true;
}

module.exports = { checkAndUpdate, readState, unzip, validate };

if (require.main === module) {
  checkAndUpdate({ force: process.argv.includes('--force') })
    .then((c) => console.log(c ? 'Feed updated.' : 'No change.'))
    .catch((err) => { console.error('Update failed:', err.message); process.exitCode = 1; });
}
