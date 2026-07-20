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
  amenities: new Map(),   // stop_id → { hasParking, free }
  stopZones: new Map(),   // stop_id → zone_id
  fares: new Map(),       // fare_id → price (EUR)
  fareRules: new Map(),   // 'originZone|destZone' → [{ route, price }]
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
  db.stopZones.clear();
  readCsv('stops.txt', (r) => {
    db.stopNames.set(r.stop_id, r.stop_name);
    db.stopZones.set(r.stop_id, r.zone_id);
  });

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

  db.amenities.clear();
  readCsv('stop_amenities.txt', (r) => {
    if (r.has_parking === '1') {
      db.amenities.set(r.stop_id, { hasParking: true, free: r.is_free === '1' });
    }
  });

  db.fares.clear();
  readCsv('fare_attributes.txt', (r) => {
    db.fares.set(r.fare_id, Number(r.price));
  });

  db.fareRules.clear();
  readCsv('fare_rules.txt', (r) => {
    const k = `${r.origin_id}|${r.destination_id}`;
    if (!db.fareRules.has(k)) db.fareRules.set(k, []);
    db.fareRules.get(k).push({ route: r.route_id || null, price: db.fares.get(r.fare_id) });
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

/* Derive per-stop directions with full per-line destination breakdown. */
function buildStopConfig() {
  // stop_id → { dirs: Map(dir → { counts: Map(headsign→n), byLine: Map(route→Set(headsign)) }), lines: Set }
  const perStop = new Map();
  for (const [k, list] of db.departures) {
    const [stopId, dir] = k.split('|');
    if (!perStop.has(stopId)) perStop.set(stopId, { dirs: new Map(), lines: new Set() });
    const entry = perStop.get(stopId);
    if (!entry.dirs.has(dir)) entry.dirs.set(dir, { counts: new Map(), byLine: new Map() });
    const d = entry.dirs.get(dir);
    for (const dep of list) {
      d.counts.set(dep.headsign, (d.counts.get(dep.headsign) || 0) + 1);
      entry.lines.add(dep.route);
      if (!d.byLine.has(dep.route)) d.byLine.set(dep.route, new Set());
      d.byLine.get(dep.route).add(dep.headsign);
    }
  }

  db.stops = [...perStop]
    .map(([stopId, entry]) => ({
      id: stopId,
      name: db.stopNames.get(stopId) || stopId,
      parking: db.amenities.get(stopId) || null,
      lines: [...entry.lines].sort(),
      directions: [...entry.dirs]
        .sort(([a], [b]) => b.localeCompare(a)) // dir '1' (toward centre) first
        .map(([dir, { counts, byLine }]) => {
          const ranked = [...counts].sort((a, b) => b[1] - a[1]);
          // Per-line: sort lines, pick the most common headsign per line
          const lines = [...byLine]
            .sort(([a], [b]) => a.localeCompare(b, 'pt'))
            .map(([route, headsigns]) => {
              const r = db.routes.get(route);
              // pick the most frequent headsign for this line at this stop
              const hs = [...headsigns].sort((a, b) =>
                (counts.get(b) || 0) - (counts.get(a) || 0)
              )[0];
              return { route, short: r?.short || route, color: r?.color || '#16305C', headsign: hs };
            });
          return {
            id: dir,
            label: ranked[0][0],   // most common overall headsign
            lines,                  // [{route, short, color, headsign}]
          };
        }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt'));
}

/* ── Service calendar ───────────────────────────────────────────── */

function serviceRunsOn(serviceId, ymd, weekday, ignoreWindow = false) {
  const ex = db.exceptions.get(ymd)?.get(serviceId);
  if (ex === 1) return true;
  if (ex === 2) return false;
  const cal = db.calendar.get(serviceId);
  if (!cal) return false;
  if (ignoreWindow) return cal.days[weekday]; // grace mode: right weekday, ignore expired date range
  return cal.days[weekday] && ymd >= cal.start && ymd <= cal.end;
}

/* Latest end_date across all services — the day the feed stops being valid. */
function feedValidUntil() {
  let max = '';
  for (const cal of db.calendar.values()) if (cal.end > max) max = cal.end;
  return max;
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
    feed_valid_until: feedValidUntil(),
    holidays: getHolidayDates(),
  };
}

function getDepartures(stopId, directionId, limit = 8) {
  const stop = db.stops.find((s) => s.id === stopId);
  if (!stop) return { error: 'unknown_stop' };
  const direction = stop.directions.find((d) => d.id === directionId);
  if (!direction) return { error: 'unknown_direction' };

  const list = db.departures.get(key(stopId, directionId)) || [];
  const now = lisbonNow();

  // Yesterday's service day spills past midnight (GTFS times ≥ 24:00).
  const days = [
    { ...shiftYmd(now.ymd, -1), offset: -86400 },
    { ymd: now.ymd, weekday: now.weekday, offset: 0 },
  ];

  // First try a strict match. If the feed has expired (nothing active on any
  // day), retry in grace mode: same weekday pattern, ignore the stale date
  // window. A metro timetable rarely changes between exports, so yesterday's
  // schedule is a far better answer than an empty board.
  let results = collect(list, days, now, false);
  let stale = false;
  if (!results.length && now.ymd > feedValidUntil()) {
    results = collect(list, days, now, true);
    stale = results.length > 0;
  }

  results.sort((a, b) => a.seconds_until - b.seconds_until);

  return {
    stop_id: stop.id,
    stop_name: stop.name,
    direction_id: directionId,
    direction_label: direction.label,
    generated_at: new Date().toISOString(),
    realtime: false,
    stale,                          // true → timetable is past its validity date
    feed_valid_until: feedValidUntil(),
    departures: results.slice(0, limit),
  };
}

/* Zone-based fare between two stops. Most zone-pairs have a single price;
   a handful (the Póvoa/Vila do Conde branch) price differently depending on
   whether the regular (B) or express (Bexp) line is used — for those we
   return every matching price so the caller can show all options. */
function getFare(originStopId, destStopId) {
  const originZone = db.stopZones.get(originStopId);
  const destZone = db.stopZones.get(destStopId);
  if (!originZone || !destZone) return { error: 'unknown_stop' };

  const rules = db.fareRules.get(`${originZone}|${destZone}`);
  if (!rules || !rules.length) return { error: 'no_fare_rule' };

  return {
    origin_stop: originStopId,
    destination_stop: destStopId,
    origin_zone: originZone,
    destination_zone: destZone,
    fares: rules.map((r) => ({
      route_id: r.route,
      route_name: r.route ? db.routes.get(r.route)?.short || r.route : null,
      price: r.price,
    })),
  };
}

/* Extract all dates where an exception/holiday is explicitly configured, converted to YYYY-MM-DD */
function getHolidayDates() {
  const dates = [];
  for (const rawDate of db.exceptions.keys()) {
    if (rawDate.length === 8) {
      // Formats '20260815' into '2026-08-15'
      const formatted = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      dates.push(formatted);
    }
  }
  return dates.sort();
}

function collect(list, days, now, ignoreWindow) {
  const out = [];
  for (const day of days) {
    const active = new Set(
      [...db.calendar.keys()].filter((s) =>
        serviceRunsOn(s, day.ymd, day.weekday, ignoreWindow)
      )
    );
    for (const [sid, type] of db.exceptions.get(day.ymd) || []) {
      if (type === 1) active.add(sid);
    }
    if (!active.size) continue;

    for (const d of list) {
      const untilSec = d.sec + day.offset - now.sec;
      if (untilSec < 0 || untilSec > 2 * 3600) continue;
      if (!active.has(d.service)) continue;
      out.push({
        line: db.routes.get(d.route)?.short || d.route,
        route_id: d.route,
        headsign: d.headsign,
        departure_time: secToHm(d.sec),
        seconds_until: untilSec,
        realtime: false,
      });
    }
  }
  return out;
}

function secToHm(sec) {
  const m = Math.floor(sec / 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

module.exports = { load, getConfig, getDepartures, getFare };
