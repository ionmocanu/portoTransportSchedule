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
  stopCoords: new Map(),  // stop_id → { lat, lon }
  fares: new Map(),       // fare_id → price (EUR)
  fareRules: new Map(),   // 'originZone|destZone' → [{ route, price }]
  departures: new Map(),  // 'stopId|dir' → [{ sec, route, headsign, service }]
  routeStopOrder: new Map(), // 'route|dir' → [stopId, ...] in travel order
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
  db.stopCoords.clear();
  readCsv('stops.txt', (r) => {
    db.stopNames.set(r.stop_id, r.stop_name);
    db.stopZones.set(r.stop_id, r.zone_id);
    db.stopCoords.set(r.stop_id, { lat: Number(r.stop_lat), lon: Number(r.stop_lon) });
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
    db.fareRules.get(k).push({ route: r.route_id || null, ticket: r.fare_id, price: db.fares.get(r.fare_id) });
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
  // Also keep each trip's full ordered stop list, for the trip planner's
  // "which stops does this line pass through, in order" question.
  const candidates = [];
  const lastSeq = new Map();
  const tripStops = new Map(); // tripId → [{ seq, stop }]
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
    if (!tripStops.has(r.trip_id)) tripStops.set(r.trip_id, []);
    tripStops.get(r.trip_id).push({ seq, stop: r.stop_id });
  });

  // Per (route, direction), keep the longest observed trip as the
  // representative stopping pattern — short-turning trips would otherwise
  // under-report which stops a line actually serves.
  db.routeStopOrder.clear();
  const bestPattern = new Map(); // 'route|dir' → ordered stop array
  for (const [tripId, stopsArr] of tripStops) {
    const trip = trips.get(tripId);
    if (!trip) continue;
    const k = key(trip.route, trip.dir);
    const cur = bestPattern.get(k);
    if (cur && cur.length >= stopsArr.length) continue;
    bestPattern.set(k, [...stopsArr].sort((a, b) => a.seq - b.seq).map((s) => s.stop));
  }
  for (const [k, stops] of bestPattern) db.routeStopOrder.set(k, stops);

  db.departures.clear();
  let kept = 0;
  for (const c of candidates) {
    const trip = trips.get(c.tripId);
    if (!trip) continue;
    // A trip's last stop is an arrival, not a departure — but riders at a
    // terminus (or a short-turn stop like Fórum Maia) still want to see the
    // metro that ends there, so keep it flagged instead of dropping it.
    const terminates = c.seq === lastSeq.get(c.tripId);
    const k = key(c.stop, trip.dir);
    if (!db.departures.has(k)) db.departures.set(k, []);
    db.departures.get(k).push({
      sec: c.sec,
      route: trip.route,
      headsign: trip.headsign,
      service: trip.service,
      terminates,
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

/* Derive per-stop directions with full per-line destination breakdown.
   Real departures and terminating arrivals are counted apart: arrivals never
   steal a direction's label or a line's headsign from through-traffic, but
   at a pure terminus (Aeroporto, ISMAI…) they're all there is, so they alone
   create the direction card. */
function buildStopConfig() {
  // stop_id → { dirs: Map(dir → { thru, term }), lines: Set }, where thru/term
  // are each { counts: Map(headsign→n), byLine: Map(route→Set(headsign)) }
  const perStop = new Map();
  const bucket = () => ({ counts: new Map(), byLine: new Map() });
  for (const [k, list] of db.departures) {
    const [stopId, dir] = k.split('|');
    if (!perStop.has(stopId)) perStop.set(stopId, { dirs: new Map(), lines: new Set() });
    const entry = perStop.get(stopId);
    if (!entry.dirs.has(dir)) entry.dirs.set(dir, { thru: bucket(), term: bucket() });
    const dd = entry.dirs.get(dir);
    for (const dep of list) {
      const d = dep.terminates ? dd.term : dd.thru;
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
      lat: db.stopCoords.get(stopId)?.lat ?? null,
      lon: db.stopCoords.get(stopId)?.lon ?? null,
      lines: [...entry.lines].sort(),
      directions: [...entry.dirs]
        .sort(([a], [b]) => b.localeCompare(a)) // dir '1' (toward centre) first
        .map(([dir, { thru, term }]) => {
          // Label/headsigns come from through departures when there are any;
          // arrivals-only directions (termini) fall back to the term bucket.
          const primary = thru.counts.size ? thru : term;
          const ranked = [...primary.counts].sort((a, b) => b[1] - a[1]);
          // Per-line: through lines first-class; lines that only ever
          // terminate here still get a pill so the stop shows they serve it.
          const byLine = new Map(thru.byLine);
          for (const [route, hs] of term.byLine) if (!byLine.has(route)) byLine.set(route, hs);
          const lines = [...byLine]
            .sort(([a], [b]) => a.localeCompare(b, 'pt'))
            .map(([route, headsigns]) => {
              const r = db.routes.get(route);
              // pick the most frequent headsign for this line at this stop
              const hs = [...headsigns].sort((a, b) =>
                (primary.counts.get(b) || term.counts.get(b) || 0) -
                (primary.counts.get(a) || term.counts.get(a) || 0)
              )[0];
              return { route, short: r?.short || route, color: r?.color || '#16305C', headsign: hs };
            });
          return {
            id: dir,
            label: ranked[0][0],   // most common overall headsign
            arrivals_only: !thru.counts.size,
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
      ticket: r.ticket,   // Andante occasional title to buy (Z2, Z3, …)
      price: r.price,
    })),
  };
}

/* Trip planner — no real-time chaining (no arrival times used), just: is
   there a shared line (direct), and if not, what's the nearest stop where a
   line reachable from the origin crosses a line that reaches the
   destination. "Nearest" means fewest stops away from the origin, checked
   in order — the first valid interchange found along the way, not just any
   interchange on the line. When several lines equally serve a leg (e.g.
   multiple lines run through the same interchange toward the destination),
   all of them are returned instead of picking one arbitrarily. */
function getTripPlan(originId, destId) {
  const origin = db.stops.find((s) => s.id === originId);
  const dest = db.stops.find((s) => s.id === destId);
  if (!origin) return { error: 'unknown_origin' };
  if (!dest) return { error: 'unknown_destination' };
  if (originId === destId) return { error: 'same_stop' };

  // Does `to` appear after `from` along (route, some direction)? Returns the
  // direction and hop count if so, checking both directions since we don't
  // know upfront which one heads the right way.
  function reachable(route, fromStop, toStop) {
    let best = null;
    for (const dir of ['0', '1']) {
      const order = db.routeStopOrder.get(key(route, dir));
      if (!order) continue;
      const i = order.indexOf(fromStop);
      const j = order.indexOf(toStop);
      if (i === -1 || j === -1 || j <= i) continue;
      const hops = j - i;
      if (!best || hops < best.hops) best = { direction: dir, hops };
    }
    return best;
  }

  // Every line shared between two stops that actually goes the right way,
  // narrowed down to the ones tied for fewest stops — if two lines both get
  // you there in the same number of hops, both are genuinely valid options.
  function findOptions(fromStopObj, toStopObj) {
    const candidates = [];
    const shared = fromStopObj.lines.filter((l) => toStopObj.lines.includes(l));
    for (const route of shared) {
      const leg = reachable(route, fromStopObj.id, toStopObj.id);
      if (leg) candidates.push({ route, direction: leg.direction, hops: leg.hops });
    }
    if (!candidates.length) return [];
    const minHops = Math.min(...candidates.map((c) => c.hops));
    return candidates.filter((c) => c.hops === minHops);
  }

  function buildLeg(fromStopObj, toStopObj, candidates) {
    // Andante zones this leg actually rides through, in stop order. All the
    // candidates here are tied on the same from→to pair along the same
    // corridor, so the first option's stop sequence is representative.
    const { route: zRoute, direction: zDir } = candidates[0];
    const order = db.routeStopOrder.get(key(zRoute, zDir)) || [];
    const i = order.indexOf(fromStopObj.id);
    const j = order.indexOf(toStopObj.id);
    const zones = [];
    if (i !== -1 && j > i) {
      for (const sid of order.slice(i, j + 1)) {
        const z = db.stopZones.get(sid);
        if (z && zones.at(-1) !== z) zones.push(z);
      }
    }
    const options = candidates.map(({ route, direction }) => {
      const r = db.routes.get(route);
      // The headsign is what a rider actually sees on the platform at the
      // departure stop for THIS specific line — not the stop's generic
      // direction label, which is just whichever headsign is most common
      // across every line sharing that direction_id.
      const directionMeta = fromStopObj.directions.find((d) => d.id === direction);
      const lineMeta = directionMeta?.lines.find((l) => l.route === route);
      return {
        route,
        route_short: r?.short || route,
        route_color: r?.color || '#16305C',
        direction_id: direction,
        headsign: lineMeta?.headsign || directionMeta?.label || toStopObj.name,
      };
    });
    return {
      from_stop: fromStopObj.id,
      from_name: fromStopObj.name,
      to_stop: toStopObj.id,
      to_name: toStopObj.name,
      zones,
      options,
    };
  }

  // Whole-trip zone list: legs joined end-to-end (the transfer stop's zone
  // ends one leg and starts the next, so consecutive duplicates collapse).
  function withZones(plan) {
    const zones = [];
    for (const leg of plan.legs) {
      for (const z of leg.zones) if (zones.at(-1) !== z) zones.push(z);
    }
    return { ...plan, zones };
  }

  // 1. Direct: any line(s) serving both stops, in a direction that actually
  // goes from origin toward destination.
  const directOptions = findOptions(origin, dest);
  if (directOptions.length) {
    return withZones({ type: 'direct', legs: [buildLeg(origin, dest, directOptions)] });
  }

  // 2. One transfer: walk forward from the origin along each of its lines,
  // stop by stop, and take the first stop reached that also sits on a line
  // which can get to the destination — then separately collect every line
  // option for each leg of that specific path.
  let best = null; // { stop, hop1 }
  for (const route1 of origin.lines) {
    for (const dir1 of ['0', '1']) {
      const order1 = db.routeStopOrder.get(key(route1, dir1));
      if (!order1) continue;
      const i0 = order1.indexOf(originId);
      if (i0 === -1) continue;

      for (let idx = i0 + 1; idx < order1.length; idx++) {
        const hop1 = idx - i0;
        if (best && hop1 >= best.hop1) break; // can't beat the current best from here on
        const stopId = order1[idx];
        const stop = db.stops.find((s) => s.id === stopId);
        if (!stop) continue;

        const canTransfer = stop.lines.some(
          (l) => l !== route1 && dest.lines.includes(l) && reachable(l, stopId, destId)
        );
        if (canTransfer) {
          if (!best || hop1 < best.hop1) best = { stop, hop1 };
          break; // nearest transfer-capable stop on this particular path
        }
      }
    }
  }

  if (!best) return { error: 'no_route_found' };

  const leg1Options = findOptions(origin, best.stop);
  const leg2Options = findOptions(best.stop, dest);

  return withZones({
    type: 'transfer',
    legs: [
      buildLeg(origin, best.stop, leg1Options),
      buildLeg(best.stop, dest, leg2Options),
    ],
  });
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
  const activeByDay = days.map((day) => {
    const active = new Set(
      [...db.calendar.keys()].filter((s) => serviceRunsOn(s, day.ymd, day.weekday, ignoreWindow))
    );
    for (const [sid, type] of db.exceptions.get(day.ymd) || []) {
      if (type === 1) active.add(sid);
    }
    return active;
  });

  // A recurring service is active on both "yesterday" and "today", so the
  // same time-of-day trip template genuinely occurs once as yesterday's
  // service winding down (near future) and again ~24h later as today's own
  // service closing out (far future) — two real, different occurrences, not
  // a duplicate. So "last of day" must be tracked per day-frame separately;
  // merging them would compare tonight's closing train against tomorrow's.
  const lastForRoute = days.map((day, i) => {
    const active = activeByDay[i];
    const last = new Map();
    if (!active.size) return last;
    for (const d of list) {
      if (!active.has(d.service)) continue;
      const absSec = d.sec + day.offset;
      const lk = d.terminates ? `${d.route}|t` : d.route; // arrivals ranked apart
      if (!last.has(lk) || absSec > last.get(lk)) last.set(lk, absSec);
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
        terminates: !!d.terminates,
        is_last: d.sec + day.offset === lastForRoute[i].get(d.terminates ? `${d.route}|t` : d.route),
      });
    }
  });
  return out;
}

function secToHm(sec) {
  const m = Math.floor(sec / 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

module.exports = { load, getConfig, getDepartures, getFare, getTripPlan };
