/*
 * gtfs_stcp.js — same engine shape as gtfs.js, loading STCP (Porto city
 * buses). Directions use the feed's direction_id like the metro. Two STCP
 * quirks handled here: calendar.txt is empty (every service day arrives as
 * a calendar_dates.txt exception, in a rolling ~10-day window), and the
 * feed is refreshed on the portal every few days — so "grace mode" for an
 * expired feed replays the most recent same-weekday service day instead of
 * relying on calendar weekday patterns that don't exist.
 * The feed also gives each roadside its own stop_id ("MAJOR PALA" exists
 * twice, one per side of the road, each with a single direction). Riders
 * think of those as ONE stop with two directions — like the metro — so
 * same-named stops within ~250 m are merged into one logical stop whose id
 * is the member ids joined with '~' (URL-safe — '+' would decode to a
 * space in query strings).
 * No fares or parking: out of scope for the bus network.
 */

const fs = require('node:fs');
const path = require('node:path');

const GTFS_DIR = process.env.GTFS_STCP_DIR || path.join(__dirname, 'gtfs_stcp');
const TZ = 'Europe/Lisbon';
// Big downtown stops (Aliados…) are split into one stop_id per platform, so
// there's no single obvious id there; Carmo is one physical stop serving ~15
// lines. If a future feed drops it, load() falls back to the busiest stop.
const PREFERRED_STOP = 'CMO'; // Carmo
const FALLBACK_COLOR = '#16305C';

function readCsv(file, onRow) {
  const text = fs.readFileSync(path.join(GTFS_DIR, file), 'utf8');
  const lines = text.split('\n');
  const header = lines[0].replace(/^﻿/, '').trim().split(',');
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

const MERGE_RADIUS_KM = 0.25;

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const db = {
  routes: new Map(),      // route_id → { short, color }
  stopNames: new Map(),   // stop_id → name
  stopCoords: new Map(),  // stop_id → { lat, lon }
  calendar: new Map(),    // service_id → { days:[7], start, end } (usually empty)
  exceptions: new Map(),  // 'YYYYMMDD' → Map(service_id → 1|2)
  departures: new Map(),  // 'stopId|dir' → [{ sec, route, headsign, service }]
  stops: [],
  defaultStop: PREFERRED_STOP,
  loadedAt: null,
};

const key = (stopId, dir) => `${stopId}|${dir}`;

function load() {
  const t0 = Date.now();

  db.routes.clear();
  readCsv('routes.txt', (r) => {
    const raw = (r.route_color || '').toUpperCase();
    const color = raw && raw !== 'FFFFFF' ? `#${raw}` : FALLBACK_COLOR;
    db.routes.set(r.route_id, { short: r.route_short_name || r.route_id, color });
  });

  db.stopNames.clear();
  db.stopCoords.clear();
  const byName = new Map();
  readCsv('stops.txt', (r) => {
    const stop = { id: r.stop_id, name: r.stop_name, lat: Number(r.stop_lat), lon: Number(r.stop_lon) };
    db.stopNames.set(stop.id, stop.name);
    db.stopCoords.set(stop.id, { lat: stop.lat, lon: stop.lon });
    if (!byName.has(stop.name)) byName.set(stop.name, []);
    byName.get(stop.name).push(stop);
  });

  // Merge same-named roadside twins into one logical stop. Distance-gated:
  // unrelated stops elsewhere in town can share a generic name and must
  // stay separate, so a name group is first clustered by proximity.
  const canonical = new Map(); // physical stop_id → merged stop id
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const clusters = [];
    for (const s of group) {
      const c = clusters.find((cl) => haversineKm(cl[0].lat, cl[0].lon, s.lat, s.lon) <= MERGE_RADIUS_KM);
      if (c) c.push(s);
      else clusters.push([s]);
    }
    for (const c of clusters) {
      if (c.length < 2) continue;
      const id = c.map((s) => s.id).sort().join('~');
      for (const s of c) canonical.set(s.id, id);
      db.stopNames.set(id, name);
      db.stopCoords.set(id, {
        lat: c.reduce((t, s) => t + s.lat, 0) / c.length,
        lon: c.reduce((t, s) => t + s.lon, 0) / c.length,
      });
    }
  }

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

  const candidates = [];
  const lastSeq = new Map();
  readCsv('stop_times.txt', (r) => {
    const seq = Number(r.stop_sequence);
    const prev = lastSeq.get(r.trip_id);
    if (prev === undefined || seq > prev) lastSeq.set(r.trip_id, seq);
    candidates.push({
      tripId: r.trip_id,
      stop: canonical.get(r.stop_id) || r.stop_id,
      sec: hmsToSec(r.departure_time),
      seq,
    });
  });

  // A bus terminus is where the return trip starts (other direction), so
  // unlike the metro there's no value in keeping terminating arrivals.
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
    `STCP GTFS loaded: ${trips.size} trips, ${db.stops.length} stops, ${kept} departures (${Date.now() - t0} ms)`
  );
}

/* Per-stop directions from direction_id, with per-line destination pills —
   same shape the metro produces, minus the terminating-arrivals split. */
function buildStopConfig() {
  // stop_id → { dirs: Map(dir → { counts:Map(headsign→n), byLine:Map(route→Map(headsign→n)) }), lines: Set }
  const perStop = new Map();
  for (const [k, list] of db.departures) {
    const sep = k.lastIndexOf('|');
    const stopId = k.slice(0, sep);
    const dir = k.slice(sep + 1);
    if (!perStop.has(stopId)) perStop.set(stopId, { dirs: new Map(), lines: new Set() });
    const entry = perStop.get(stopId);
    if (!entry.dirs.has(dir)) entry.dirs.set(dir, { counts: new Map(), byLine: new Map() });
    const d = entry.dirs.get(dir);
    for (const dep of list) {
      d.counts.set(dep.headsign, (d.counts.get(dep.headsign) || 0) + 1);
      entry.lines.add(dep.route);
      if (!d.byLine.has(dep.route)) d.byLine.set(dep.route, new Map());
      const hs = d.byLine.get(dep.route);
      hs.set(dep.headsign, (hs.get(dep.headsign) || 0) + 1);
    }
  }

  let busiest = null;
  let busiestCount = 0;

  db.stops = [...perStop]
    .map(([stopId, entry]) => {
      let total = 0;
      for (const d of entry.dirs.values()) for (const n of d.counts.values()) total += n;
      if (total > busiestCount) { busiestCount = total; busiest = stopId; }
      return {
        id: stopId,
        name: db.stopNames.get(stopId) || stopId,
        lat: db.stopCoords.get(stopId)?.lat ?? null,
        lon: db.stopCoords.get(stopId)?.lon ?? null,
        lines: [...entry.lines].sort((a, b) => a.localeCompare(b, 'pt')),
        directions: [...entry.dirs]
          .sort(([a], [b]) => b.localeCompare(a)) // dir '1' first, like the metro
          .map(([dir, { counts, byLine }]) => {
            const ranked = [...counts].sort((a, b) => b[1] - a[1]);
            const lines = [...byLine]
              .sort(([a], [b]) => a.localeCompare(b, 'pt'))
              .map(([route, headsigns]) => {
                const r = db.routes.get(route);
                const hs = [...headsigns].sort((a, b) => b[1] - a[1])[0][0];
                return { route, short: r?.short || route, color: r?.color || FALLBACK_COLOR, headsign: hs };
              });
            return { id: dir, label: ranked[0][0], lines };
          }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt'));

  // The preferred stop may have been merged, so match it as a member too.
  const preferred = [...perStop.keys()].find(
    (id) => id === PREFERRED_STOP || id.split('~').includes(PREFERRED_STOP)
  );
  db.defaultStop = preferred || busiest;
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

function activeServicesOn(ymd, weekday) {
  const active = new Set(
    [...db.calendar.keys()].filter((s) => serviceRunsOn(s, ymd, weekday))
  );
  for (const [sid, type] of db.exceptions.get(ymd) || []) {
    if (type === 1) active.add(sid);
  }
  return active;
}

/* Feed validity = latest date any service runs: calendar end dates when
   present, otherwise (the STCP norm) the latest calendar_dates entry. */
function feedValidUntil() {
  let max = '';
  for (const cal of db.calendar.values()) if (cal.end > max) max = cal.end;
  for (const ymd of db.exceptions.keys()) if (ymd > max) max = ymd;
  return max;
}

function ymdWeekday(ymd) {
  return new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay();
}

/* Grace fallback for an expired feed: the most recent service day in the
   feed with the same weekday — a Tuesday is replayed from the last known
   Tuesday, a Sunday from the last Sunday/holiday pattern. */
function latestServiceDayForWeekday(weekday) {
  let best = null;
  for (const ymd of db.exceptions.keys()) {
    if (ymdWeekday(ymd) !== weekday) continue;
    if (!best || ymd > best) best = ymd;
  }
  return best;
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
    default_stop: db.defaultStop,
    stops: db.stops,
    line_colors: Object.fromEntries([...db.routes].map(([id, r]) => [id, r.color])),
    line_names: Object.fromEntries([...db.routes].map(([id, r]) => [id, r.short])),
    feed_loaded_at: db.loadedAt,
    feed_valid_until: feedValidUntil(),
    // STCP expresses EVERY service day as a calendar_dates exception, so
    // exception dates carry no "holiday" signal — flagging them all would
    // show the holiday warning every single day.
    holidays: [],
  };
}

function getDepartures(stopId, directionId, limit = 60) {
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
    stale,
    feed_valid_until: feedValidUntil(),
    departures: results.slice(0, limit),
  };
}

function collect(list, days, now, grace) {
  const activeByDay = days.map((day) => {
    let active = activeServicesOn(day.ymd, day.weekday);
    if (!active.size && grace) {
      const fallback = latestServiceDayForWeekday(day.weekday);
      if (fallback) active = activeServicesOn(fallback, day.weekday);
    }
    return active;
  });

  const lastForRoute = days.map((day, i) => {
    const active = activeByDay[i];
    const last = new Map();
    if (!active.size) return last;
    for (const d of list) {
      if (!active.has(d.service)) continue;
      const absSec = d.sec + day.offset;
      if (!last.has(d.route) || absSec > last.get(d.route)) last.set(d.route, absSec);
    }
    return last;
  });

  const out = [];
  days.forEach((day, i) => {
    const active = activeByDay[i];
    if (!active.size) return;

    for (const d of list) {
      const untilSec = d.sec + day.offset - now.sec;
      // keep recently-departed rows (down to -150s) so the board can show
      // "departed X min ago" even right after a refetch
      if (untilSec < -150 || untilSec > 3 * 3600) continue;
      if (!active.has(d.service)) continue;
      out.push({
        line: db.routes.get(d.route)?.short || d.route,
        route_id: d.route,
        headsign: d.headsign,
        departure_time: secToHm(d.sec),
        seconds_until: untilSec,
        realtime: false,
        is_last: d.sec + day.offset === lastForRoute[i].get(d.route),
      });
    }
  });
  return out;
}

function secToHm(sec) {
  const m = Math.floor(sec / 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

module.exports = { load, getConfig, getDepartures };
