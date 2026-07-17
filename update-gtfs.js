/*
 * update-gtfs.js — keeps the Metro do Porto GTFS fresh.
 *
 * Flow:
 *   1. Ask the open-data portal (CKAN API) for the dataset's resources
 *   2. Pick the newest .zip
 *   3. If it's not the one we already have → download, extract, validate
 *   4. Atomically swap into gtfs/ and tell the caller to reload
 *
 * Zero dependencies: uses global fetch (Node ≥ 18) and a minimal ZIP reader
 * built on zlib. State (which resource we last installed) lives in
 * gtfs/.state.json. If anything fails, the current feed stays in place.
 *
 * CLI:  node update-gtfs.js [--force]
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const GTFS_DIR = process.env.GTFS_DIR || path.join(__dirname, 'gtfs');
const STATE_FILE = path.join(GTFS_DIR, '.state.json');
const DATASET_API =
  'https://opendata.porto.digital/api/3/action/package_show?id=horarios-paragens-e-rotas-em-formato-gtfs';
const REQUIRED = [
  'routes.txt', 'trips.txt', 'stop_times.txt',
  'stops.txt', 'calendar.txt', 'calendar_dates.txt',
];

/* ── Minimal ZIP extraction (stored + deflate entries) ──────────── */

function unzip(buf) {
  // Find End Of Central Directory (signature 0x06054b50), scan from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: EOCD not found');

  const count = buf.readUInt16LE(eocd + 10);
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

    // Local header: sizes of name/extra can differ from the central record.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);

    if (!name.endsWith('/')) {
      files.set(
        path.basename(name), // feeds sometimes nest files in a folder
        method === 8 ? zlib.inflateRawSync(data)
          : method === 0 ? Buffer.from(data)
          : (() => { throw new Error(`unsupported zip method ${method} for ${name}`); })()
      );
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ── Portal discovery ───────────────────────────────────────────── */

async function findLatestResource() {
  const res = await fetch(DATASET_API, {
    headers: { accept: 'application/json', 'user-agent': 'proximo-gtfs-updater' },
  });
  if (!res.ok) throw new Error(`portal API ${res.status}`);
  const body = await res.json();
  if (!body.success || !body.result?.resources) throw new Error('unexpected portal response');

  const zips = body.result.resources.filter((r) =>
    (r.url || '').toLowerCase().endsWith('.zip')
  );
  if (!zips.length) throw new Error('no zip resources in dataset');

  // Newest by last_modified, falling back to created.
  zips.sort((a, b) =>
    String(b.last_modified || b.created || '').localeCompare(
      String(a.last_modified || a.created || '')
    )
  );
  const r = zips[0];
  return { id: r.id, url: r.url, modified: r.last_modified || r.created || '' };
}

/* ── Validation: don't install a broken or stale feed ───────────── */

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

/* ── State ──────────────────────────────────────────────────────── */

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

/* ── Main entry: returns true if the feed on disk changed ───────── */

async function checkAndUpdate({ force = false, log = console.log } = {}) {
  const latest = await findLatestResource();
  const state = readState();

  if (!force && state.resource_id === latest.id && state.modified === latest.modified) {
    log(`GTFS update: already on latest (${latest.modified || latest.id})`);
    return false;
  }

  log(`GTFS update: downloading ${latest.url}`);
  const res = await fetch(latest.url, {
    headers: { 'user-agent': 'proximo-gtfs-updater' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const files = unzip(buf);
  const { valid_until } = validate(files);

  // Write to a staging dir, then swap file-by-file (same volume, atomic-ish).
  const staging = GTFS_DIR + '.new';
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const [name, data] of files) fs.writeFileSync(path.join(staging, name), data);

  fs.mkdirSync(GTFS_DIR, { recursive: true });
  for (const name of files.keys()) {
    fs.renameSync(path.join(staging, name), path.join(GTFS_DIR, name));
  }
  fs.rmSync(staging, { recursive: true, force: true });

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    resource_id: latest.id,
    modified: latest.modified,
    url: latest.url,
    valid_until,
    installed_at: new Date().toISOString(),
  }, null, 2));

  log(`GTFS update: installed feed valid until ${valid_until}`);
  return true;
}

module.exports = { checkAndUpdate, readState, unzip, validate };

if (require.main === module) {
  checkAndUpdate({ force: process.argv.includes('--force') })
    .then((changed) => {
      console.log(changed ? 'Feed updated — restart or wait for auto-reload.' : 'No change.');
    })
    .catch((err) => {
      console.error('GTFS update failed:', err.message);
      process.exitCode = 1;
    });
}
