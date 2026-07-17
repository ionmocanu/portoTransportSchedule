/*
 * gtfs.js — loads the Metro do Porto GTFS at startup and answers
 * "next departures at stop X, direction Y" for ANY stop in the network.
 *
 * Zero dependencies. ~64k stop_times rows → ~60k in-memory departures.
 *
 * Directions are the feed's own direction_id (0 = outbound, 1 = toward the
 * centre in this export). Labels are derived per stop from the headsigns
 * actually seen there, so termini naturally end up with a single direction.
 */

const fs = require('node:fs');
const path = require('node:path');

const GTFS_DIR = process.env.GTFS_DIR || path.join(__dirname, 'gtfs');
const TZ = 'Europe/Lisbon';
const DEFAULT_STOP = '5729'; // Viso

/* ── Tiny CSV reader (feed has no quoted commas; strips \r and BOM) ── */
function readCsv(file, onRow) {
  const text = fs.readFileSync(path.join(GTFS_DIR, file), 'utf8');
  const lines = text.split('\n');
  const header = lines[0].replace(/^\uFEFF/, '').trim().split(',');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(',');
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? '';
    onRow(row);
  }
}

function hmsToSec(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

/* ── In-memory database ─────────────────────────────────────────── */

const db = {
  routes: new Map(),      // route_id → { short, color }
  stopNames: new Map(),   // stop_id → name
  calendar: new Map(),    // service_id → { days:[7], start, end }
  exceptions: new Map(),  // 'YYYYMMDD' → Map(service_id → 1|2)
  departures: new Map(),  // 'stopId|dir' → [{ sec, route, headsign, service }]
  stops: [],              // config for the frontend, built after load
  loadedAt: null,
};

const key = (stopId, dir) => `${stopId}|${dir}`;

function load() {
  const t0 = Date.now();

  db.routes.clear();
  readCsv('routes.txt', (r) => {
    db.routes.set(r.route_id, {
      short: r.route_short_name,
      color: `#${r.route_color || '16305C'}`,
    });
  });

  db.stopNames.clear();
  readCsv('stops.txt', (r) => db.stopNames.set(r.stop_id, r.stop_name));

  db.calendar.clear();
  readCsv('calendar.txt', (r) => {
    db.calendar.set(r.service_id, {
      days: [
        r.sunday === '1', r.monday === '1', r.tuesday === '1',
        r.wednesday === '1', r.thursday === '1', r.friday === '1',
        r.saturday === '1',
      ],
      start: r.start_date,
      end: r.end_date,
    });
  });

  db.exceptions.clear();
  readCsv('calendar_dates.txt', (r) => {
    if (!db.exceptions.has(r.date)) db.exceptions.set(r.date, new Map());
    db.exceptions.get(r.date).set(r.service_id, Number(r.exception_type));
  });

  const trips = new Map();
  readCsv('trips.txt', (r) => {
    trips.set(r.trip_id, {
      route: r.route_id,
      service: r.service_id,
      dir: r.direction_id,
      headsign: r.trip_headsign,
    });
  });

  // Pass 1 over stop_times: every row is a candidate; track last stop_sequence
  // per trip so we can drop rows where the trip terminates (nothing departs).
  const candidates = [];
  const lastSeq = new Map();
  readCsv('stop_times.txt', (r) => {
    const seq = Number(r.stop_sequence);
    const prev = lastSeq.get(r.trip_id);
    if (prev === undefined || seq > prev) lastSeq.set(r.trip_id, seq);
    candidates.push({
      tripId: r.trip_id,
      stop: r.stop_id,
      sec: hmsToSec(r.departure_time),
      seq,
    });
  });

  db.departures.clear();
  let kept = 0;
  for (const c of candidates) {
    if (c.seq === lastSeq.get(c.tripId)) continue;
    const trip = trips.get(c.tripId);
    if (!trip) continue;
    const k = key(c.stop, trip.dir);
    if (!db.departures.has(k)) db.departures.set(k, []);
    db.departures.get(k).push({
      sec: c.sec,
      route: trip.route,
      headsign: trip.headsign,
      service: trip.service,
    });
    kept++;
  }
  for (const list of db.departures.values()) list.sort((a, b) => a.sec - b.sec);

  buildStopConfig();

  db.loadedAt = new Date().toISOString();
  console.log(
    `GTFS loaded: ${trips.size} trips, ${db.stops.length} stops, ${kept} departures (${Date.now() - t0} ms)`
  );
}

/* Derive per-stop directions: label = most frequent headsign seen there,
   note = how many other destinations share that platform. */
function buildStopConfig() {
  const perStop = new Map(); // stop_id → { dirs: Map(dir → Map(headsign→n)), lines:Set }
  for (const [k, list] of db.departures) {
    const [stopId, dir] = k.split('|');
    if (!perStop.has(stopId)) perStop.set(stopId, { dirs: new Map(), lines: new Set() });
    const entry = perStop.get(stopId);
    if (!entry.dirs.has(dir)) entry.dirs.set(dir, new Map());
    const counts = entry.dirs.get(dir);
    for (const d of list) {
      counts.set(d.headsign, (counts.get(d.headsign) || 0) + 1);
      entry.lines.add(d.route);
    }
  }

  db.stops = [...perStop]
    .map(([stopId, entry]) => ({
      id: stopId,
      name: db.stopNames.get(stopId) || stopId,
      lines: [...entry.lines].sort(),
      directions: [...entry.dirs]
        .sort(([a], [b]) => b.localeCompare(a)) // '1' (centre) first, like before
        .map(([dir, counts]) => {
          const ranked = [...counts].sort((a, b) => b[1] - a[1]);
          const others = ranked.length - 1;
          return {
            id: dir,
            label: ranked[0][0],
            note: others > 0 ? `+${others} more` : '',
          };
        }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt'));
}

/* ── Service calendar ───────────────────────────────────────────── */

function serviceRunsOn(serviceId, ymd, weekday) {
  const ex = db.exceptions.get(ymd)?.get(serviceId);
  if (ex === 1) return true;
  if (ex === 2) return false;
  const cal = db.calendar.get(serviceId);
  if (!cal) return false;
  return cal.days[weekday] && ymd >= cal.start && ymd <= cal.end;
}

function lisbonNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .indexOf(get('weekday'));
  return {
    ymd: `${get('year')}${get('month')}${get('day')}`,
    weekday,
    sec: (Number(get('hour')) % 24) * 3600 + Number(get('minute')) * 60 + Number(get('second')),
  };
}

function shiftYmd(ymd, deltaDays) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return {
    ymd: d.toISOString().slice(0, 10).replaceAll('-', ''),
    weekday: d.getUTCDay(),
  };
}

/* ── Public API ─────────────────────────────────────────────────── */

function getConfig() {
  return {
    default_stop: DEFAULT_STOP,
    stops: db.stops,
    line_colors: Object.fromEntries([...db.routes].map(([id, r]) => [id, r.color])),
    line_names: Object.fromEntries([...db.routes].map(([id, r]) => [id, r.short])),
    feed_loaded_at: db.loadedAt,
  };
}

function getDepartures(stopId, directionId, limit = 8) {
  const stop = db.stops.find((s) => s.id === stopId);
  if (!stop) return { error: 'unknown_stop' };
  const direction = stop.directions.find((d) => d.id === directionId);
  if (!direction) return { error: 'unknown_direction' };

  const list = db.departures.get(key(stopId, directionId)) || [];
  const now = lisbonNow();
  const results = [];

  // Yesterday's service day spills past midnight (GTFS times ≥ 24:00).
  const days = [
    { ...shiftYmd(now.ymd, -1), offset: -86400 },
    { ymd: now.ymd, weekday: now.weekday, offset: 0 },
  ];

  for (const day of days) {
    const active = new Set(
      [...db.calendar.keys()].filter((s) => serviceRunsOn(s, day.ymd, day.weekday))
    );
    for (const [sid, type] of db.exceptions.get(day.ymd) || []) {
      if (type === 1) active.add(sid);
    }
    if (!active.size) continue;

    for (const d of list) {
      const untilSec = d.sec + day.offset - now.sec;
      if (untilSec < 0 || untilSec > 2 * 3600) continue;
      if (!active.has(d.service)) continue;
      results.push({
        line: db.routes.get(d.route)?.short || d.route,
        route_id: d.route,
        headsign: d.headsign,
        departure_time: secToHm(d.sec),
        seconds_until: untilSec,
        realtime: false,
      });
    }
  }

  results.sort((a, b) => a.seconds_until - b.seconds_until);

  return {
    stop_id: stop.id,
    stop_name: stop.name,
    direction_id: directionId,
    direction_label: direction.label,
    generated_at: new Date().toISOString(),
    realtime: false,
    departures: results.slice(0, limit),
  };
}

function secToHm(sec) {
  const m = Math.floor(sec / 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

module.exports = { load, getConfig, getDepartures };
