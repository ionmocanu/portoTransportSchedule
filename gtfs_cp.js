/*
 * gtfs_cp.js — same engine shape as gtfs.js, loading CP (Comboios de
 * Portugal) national rail instead of the metro. One structural difference
 * from the metro feed: trips.txt has no direction_id (always blank), so
 * "direction" here is grouped by trip_headsign — the destination shown on a
 * real departure board — rather than a numeric 0/1. No fares or parking
 * amenities: CP fares aren't zone-based like the metro's, out of scope.
 */

const fs = require('node:fs');
const path = require('node:path');

const GTFS_DIR = process.env.GTFS_CP_DIR || path.join(__dirname, 'gtfs_cp');
const TZ = 'Europe/Lisbon';
const DEFAULT_STOP = '94_2006'; // Porto Campanha — busiest Porto-area station
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

const db = {
  routes: new Map(),      // route_id → { short, color }
  stopNames: new Map(),   // stop_id → name
  calendar: new Map(),    // service_id → { days:[7], start, end }
  exceptions: new Map(),  // 'YYYYMMDD' → Map(service_id → 1|2)
  departures: new Map(),  // 'stopId|headsign' → [{ sec, route, headsign, service }]
  stops: [],
  loadedAt: null,
};

const key = (stopId, dir) => `${stopId}|${dir}`;

function load() {
  const t0 = Date.now();

  // CP's route_id is unique per origin-destination pair, not per named line
  // (e.g. "Linha de Aveiro" shows up as several different route_ids
  // depending on which stops a given trip starts/ends at). The real line
  // identity is route_short_name, so every route_id is normalized down to
  // that — otherwise the same line would render as duplicate pills.
  db.routes.clear();
  const lineKeyByRouteId = new Map();
  readCsv('routes.txt', (r) => {
    // Most CP intercity routes (AP/IC/IR/R/U) all share white/black — not a
    // real distinguishing color, so give them the app's neutral ink instead.
    const raw = (r.route_color || '').toUpperCase();
    const color = raw && raw !== 'FFFFFF' ? `#${raw}` : FALLBACK_COLOR;
    // "Linha de Braga" etc. are too long for the small line-badge pills —
    // the city name alone reads fine there. AP/IC/IR/R/U stay as-is.
    const short = r.route_short_name.replace(/^Linha d[aeo] /, '');
    lineKeyByRouteId.set(r.route_id, short);
    if (!db.routes.has(short)) db.routes.set(short, { short, color });
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
      route: lineKeyByRouteId.get(r.route_id) || r.route_id,
      service: r.service_id,
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
    if (!trip || !trip.headsign) continue;
    const k = key(c.stop, trip.headsign);
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
    `CP GTFS loaded: ${trips.size} trips, ${db.stops.length} stops, ${kept} departures (${Date.now() - t0} ms)`
  );
}

/* Direction = destination headsign. Multiple routes sharing the same
   headsign at a stop (e.g. AP and IC both to "Braga") collapse into one
   direction card with both line pills, same as the metro's per-direction
   line list. */
function buildStopConfig() {
  const perStop = new Map(); // stop_id → { dirs: Map(headsign → { count, byLine }), lines: Set }
  for (const [k, list] of db.departures) {
    const sep = k.lastIndexOf('|');
    const stopId = k.slice(0, sep);
    const headsign = k.slice(sep + 1);
    if (!perStop.has(stopId)) perStop.set(stopId, { dirs: new Map(), lines: new Set() });
    const entry = perStop.get(stopId);
    if (!entry.dirs.has(headsign)) entry.dirs.set(headsign, { count: 0, byLine: new Map() });
    const d = entry.dirs.get(headsign);
    for (const dep of list) {
      d.count += 1;
      entry.lines.add(dep.route);
      if (!d.byLine.has(dep.route)) d.byLine.set(dep.route, true);
    }
  }

  db.stops = [...perStop]
    .map(([stopId, entry]) => ({
      id: stopId,
      name: db.stopNames.get(stopId) || stopId,
      lines: [...entry.lines].sort(),
      directions: [...entry.dirs]
        .sort(([a], [b]) => a.localeCompare(b, 'pt'))
        .map(([headsign, { byLine }]) => {
          const lines = [...byLine.keys()]
            .sort((a, b) => a.localeCompare(b, 'pt'))
            .map((route) => {
              const r = db.routes.get(route);
              return { route, short: r?.short || route, color: r?.color || FALLBACK_COLOR, headsign };
            });
          return { id: headsign, label: headsign, lines };
        }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt'));
}

function serviceRunsOn(serviceId, ymd, weekday, ignoreWindow = false) {
  const ex = db.exceptions.get(ymd)?.get(serviceId);
  if (ex === 1) return true;
  if (ex === 2) return false;
  const cal = db.calendar.get(serviceId);
  if (!cal) return false;
  if (ignoreWindow) return cal.days[weekday];
  return cal.days[weekday] && ymd >= cal.start && ymd <= cal.end;
}

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

function getDepartures(stopId, directionId, limit = 60) {
  const stop = db.stops.find((s) => s.id === stopId);
  if (!stop) return { error: 'unknown_stop' };
  const direction = stop.directions.find((d) => d.id === directionId);
  if (!direction) return { error: 'unknown_direction' };

  const list = db.departures.get(key(stopId, directionId)) || [];
  const now = lisbonNow();

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

function getHolidayDates() {
  const dates = [];
  for (const rawDate of db.exceptions.keys()) {
    if (rawDate.length === 8) {
      const formatted = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      dates.push(formatted);
    }
  }
  return dates.sort();
}

function collect(list, days, now, ignoreWindow) {
  const activeByDay = days.map((day) => {
    const active = new Set(
      [...db.calendar.keys()].filter((s) => serviceRunsOn(s, day.ymd, day.weekday, ignoreWindow))
    );
    for (const [sid, type] of db.exceptions.get(day.ymd) || []) {
      if (type === 1) active.add(sid);
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
      if (untilSec < 0 || untilSec > 3 * 3600) continue;
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
