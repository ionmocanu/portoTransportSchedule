/*
 * trip-core.js — GPS trip follower, no DOM. Feed it position fixes and
 * clock ticks; it works out which station you're at (or heading to), which
 * way you're travelling, and which lines are still possible. Kept free of
 * browser APIs so it can be driven by simulated journeys.
 *
 * Model: stations are points, lines are ordered stop lists (from
 * /api/lines). No track geometry — "between A and B" means the fix sits
 * close to the straight A→B segment. Underground there are no fixes, so
 * the tracker advances on the timetable's hop times and flags it approx.
 */

const AT_ENTER_M = 110;      // within this of a station → at it
const AT_LEAVE_M = 170;      // must get this far again to count as departed
const MOVE_M = 300;          // movement needed to read a direction mid-hop
const FIX_FRESH_MS = 20_000; // no fix for longer → GPS lost (tunnel)
const DWELL_MS = 25_000;     // assumed stop time while running on the timetable
const MAX_SKIP = 4;          // stops one fix may jump ahead (gaps, express)
const ON_SEGMENT_M = 140;    // detour allowed to still be "on" a hop
// Standing still indoors, a phone's position can jump a couple of hundred
// metres. None of that may look like a departure:
const MAX_ACC_M = 150;       // vaguer fixes are shown but never acted on
const LEAVE_ACC_M = 100;     // only fixes at least this precise count towards leaving
const LEAVE_FIXES = 3;       // fixes in a row away from the station to count as leaving
const WALK_MPS = 2;          // a reported speed below this is not a metro
const AWAY_M = 250;          // how far we must really get before the timetable is asked
const MAX_MPS = 30;          // faster than any metro: a jump, not a journey
const AVG_FIXES = 3;         // decisions use the average of the last few fixes
const AVG_WINDOW_MS = 12_000;

export function distM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// How far out of the way p is when going a → b (0 = exactly on the segment).
const detour = (a, p, b) => distM(a, p) + distM(p, b) - distM(a, b);

const GPS_LAG_MS = 30_000;    // GPS notices a departure ~half a minute after the doors close
const MATCH_WINDOW_MS = 120_000;
const MATCH_SLACK_MS = 45_000;

// setFollow(ALL): show every possible line, ignoring the timetable's guess.
export const ALL = '*';

/* Which lines had a train leaving that station at that moment? `dep` is
   tracker.lastDeparture(), `departures` the /api/stop-times rows. Returns
   the routes whose scheduled departure is (nearly) the closest match — one
   route when the timetable is decisive, a few when trains leave together. */
export function matchDeparture(dep, departures) {
  const target = dep.at - (dep.by === 'gps' ? GPS_LAG_MS : 0);
  const options = new Set(dep.options.map((o) => `${o.route}|${o.dir}`));
  const hits = departures
    .filter((d) => options.has(`${d.route}|${d.dir}`) && Math.abs(d.at - target) <= MATCH_WINDOW_MS)
    .map((d) => ({ route: d.route, off: Math.abs(d.at - target) }));
  if (!hits.length) return [];
  const best = Math.min(...hits.map((h) => h.off));
  return [...new Set(hits.filter((h) => h.off <= best + MATCH_SLACK_MS).map((h) => h.route))];
}

/* stops: { [id]: { id, name, lat, lon } }, lines: /api/lines rows */
export function createTracker(stops, lines) {
  const at = (id) => stops[id];
  const linesThrough = (id) => lines.filter((l) => l.stops.includes(id));

  const s = {
    phase: 'locating', // locating | at | between
    stop: null,        // station we're at, or the last one passed
    cands: null,       // null = direction unknown, else [{ line, idx }]
    follow: null,      // route the rider chose — always wins
    likely: null,      // Set of routes the timetable says this train can be
    arrivedAt: 0,
    leftAt: 0,
    leftBy: null,      // how we know we left: 'gps' | 'manual' | 'timetable'
    approx: false,     // position is a timetable estimate, not GPS
    progress: null,    // 0..1 along the current hop, from GPS
    fix: null,         // averaged position we act on
    fixAt: -Infinity,
    recent: [],        // last accepted raw fixes, for the average
    jumps: 0,          // impossible jumps rejected in a row
    firstFix: null,    // where we were when tracking started off-station
  };

  function nearestStop(p) {
    let best = null;
    for (const st of Object.values(stops)) {
      if (st.lat == null) continue;
      const d = distM(p, st);
      if (!best || d < best.d) best = { id: st.id, d };
    }
    return best;
  }

  // The candidates we show: the rider's line if they chose one, else the
  // lines the timetable says this train can be, else every possible one.
  function chosen(list = s.cands) {
    if (!list) return [];
    if (s.follow === ALL) return list;
    if (s.follow) {
      const f = list.filter((c) => c.line.route === s.follow);
      if (f.length) return f;
    }
    if (s.likely) {
      const l = list.filter((c) => s.likely.has(c.line.route));
      if (l.length) return l;
    }
    return list;
  }

  // The candidate whose figures we show: among the chosen ones, the one with
  // the nearest next stop (an express skipping stops goes last).
  function primary() {
    if (!s.cands) return null;
    const live = s.cands.filter((c) => c.idx + 1 < c.line.stops.length);
    const pool = chosen(live);
    if (!pool.length) return chosen()[0] || s.cands[0];
    const here = s.fix || at(s.stop);
    return pool.reduce((a, b) =>
      distM(here, at(a.line.stops[a.idx + 1])) <= distM(here, at(b.line.stops[b.idx + 1])) ? a : b);
  }

  // Lines that go from `from` to `to` within a few stops, in that order.
  function directionFrom(from, to) {
    const out = [];
    for (const line of lines) {
      const i = line.stops.indexOf(from);
      const j = line.stops.indexOf(to);
      if (i >= 0 && j > i && j - i <= MAX_SKIP) out.push({ line, idx: j });
    }
    return out;
  }

  function arrive(id, t, approx) {
    if (id === s.stop && s.phase !== 'locating') {
      // Back at the station we "left" without ever getting clear of it: that
      // was GPS noise, so forget anything it made us believe.
      if (s.phase === 'between' && s.leftBy === 'gps' && (s.awayM || 0) < AWAY_M) {
        s.cands = s.candsBefore;
        s.likely = s.likelyBefore;
      }
      s.phase = 'at';
      s.approx = approx;
      s.progress = null;
      return;
    }
    let cands = null;
    if (s.cands) {
      cands = [];
      for (const c of s.cands) {
        const seq = c.line.stops;
        const j = seq.indexOf(id);
        if (j > c.idx && j - c.idx <= MAX_SKIP) cands.push({ line: c.line, idx: j });
        // Running on the timetable can overshoot; GPS coming back wins.
        else if (s.approx && j >= 0 && c.idx - j <= MAX_SKIP && j <= c.idx) cands.push({ line: c.line, idx: j });
        // An express passing through a station it doesn't serve.
        else if (j < 0 && c.idx + 1 < seq.length
          && detour(at(seq[c.idx]), at(id), at(seq[c.idx + 1])) < ON_SEGMENT_M) cands.push(c);
      }
      if (!cands.some((c) => c.line.stops[c.idx] === id)) cands = null;
    }
    if (!cands && s.stop && s.stop !== id) {
      cands = directionFrom(s.stop, id);
      if (!cands.length) cands = null;
    }
    s.stop = id;
    s.cands = cands;
    s.phase = 'at';
    s.arrivedAt = t;
    s.approx = approx;
    s.progress = null;
    dropImpossible();
  }

  // GPS took us somewhere the chosen/likely line doesn't go: forget it.
  function dropImpossible() {
    if (!s.cands) { s.likely = null; return; }
    const routes = new Set(s.cands.map((c) => c.line.route));
    if (s.follow && s.follow !== ALL && !routes.has(s.follow)) s.follow = null;
    if (s.likely) {
      const keep = [...s.likely].filter((r) => routes.has(r));
      s.likely = keep.length ? new Set(keep) : null;
    }
  }

  function depart(t, approx, by = approx ? 'timetable' : 'gps') {
    s.candsBefore = s.cands;
    s.likelyBefore = s.likely;
    s.phase = 'between';
    s.leftAt = t;
    s.leftBy = by;
    s.leftFrom = s.stop;
    s.awayM = 0;
    s.leaving = 0;
    s.approx = approx;
    s.progress = approx ? null : 0;
  }

  // Off-station with a known last station: which neighbour are we heading to?
  function readDirection(p) {
    const fits = [];
    for (const line of linesThrough(s.stop)) {
      const i = line.stops.indexOf(s.stop);
      if (i + 1 >= line.stops.length) continue;
      fits.push({ line, idx: i, fit: detour(at(s.stop), p, at(line.stops[i + 1])) });
    }
    if (!fits.length) return;
    const best = Math.min(...fits.map((f) => f.fit));
    if (best > ON_SEGMENT_M) return;
    s.cands = fits.filter((f) => f.fit <= best + 60).map(({ line, idx }) => ({ line, idx }));
  }

  // Started tracking between stations: once we've moved, the hop we're on is
  // the one we fit best, and its direction is the end we're getting closer to.
  function readHop(p) {
    let best = null;
    for (const line of lines) {
      for (let i = 0; i + 1 < line.stops.length; i++) {
        const a = at(line.stops[i]);
        const b = at(line.stops[i + 1]);
        const fit = detour(a, p, b);
        const closer = distM(s.firstFix, b) - distM(p, b);
        if (closer < MOVE_M / 2) continue;
        if (!best || fit < best.fit - 1) best = { fit, hops: [{ line, idx: i }] };
        else if (Math.abs(fit - best.fit) <= 1) best.hops.push({ line, idx: i });
      }
    }
    if (!best || best.fit > ON_SEGMENT_M) return;
    s.cands = best.hops;
    s.stop = best.hops[0].line.stops[best.hops[0].idx];
    s.phase = 'between';
    s.leftAt = s.fixAt;
    s.leftBy = null; // we never saw it leave, so its time proves nothing
    s.leftFrom = null;
    s.progress = null;
  }

  // Between stations with a known direction: slide along the line to the
  // hop that fits the fix best (covers fixes missed at a station).
  function slide(p) {
    for (const c of s.cands) {
      const seq = c.line.stops;
      let bestK = c.idx;
      let bestFit = Infinity;
      for (let k = c.idx; k + 1 < seq.length && k - c.idx < MAX_SKIP; k++) {
        const fit = detour(at(seq[k]), p, at(seq[k + 1]));
        if (fit < bestFit - 20) { bestFit = fit; bestK = k; }
      }
      c.idx = bestK;
    }
    const pc = primary();
    if (!pc || pc.idx + 1 >= pc.line.stops.length) return;
    if (pc.line.stops[pc.idx] !== s.stop) {
      s.stop = pc.line.stops[pc.idx];
      s.leftAt = s.fixAt;
    }
    const a = at(pc.line.stops[pc.idx]);
    const b = at(pc.line.stops[pc.idx + 1]);
    const da = distM(a, p);
    s.progress = Math.min(1, da / (da + distM(p, b) || 1));
  }

  // A fix we act on: not too vague, and not an impossible jump from the
  // last one (two jumps in a row that agree are believed, though — that's
  // GPS coming back somewhere new, not noise). Returns the averaged position.
  function accept(raw, t) {
    if ((raw.accuracy ?? 30) > MAX_ACC_M) return null;
    const prev = s.recent.at(-1);
    if (prev && s.jumps < 2) {
      const d = distM(prev, raw);
      const dt = Math.max(1, (t - prev.t) / 1000);
      if (d > 100 && d / dt > MAX_MPS) { s.jumps += 1; return null; }
    }
    s.jumps = 0;
    s.recent = [...s.recent.filter((f) => t - f.t <= AVG_WINDOW_MS), { lat: raw.lat, lon: raw.lon, t }].slice(-AVG_FIXES);
    const n = s.recent.length;
    return {
      lat: s.recent.reduce((a, f) => a + f.lat, 0) / n,
      lon: s.recent.reduce((a, f) => a + f.lon, 0) / n,
      accuracy: raw.accuracy,
      speed: raw.speed,
    };
  }

  function fix(raw, t) {
    s.fixAt = t;
    // Too vague or a jump: GPS is alive, nothing more.
    const p = accept(raw, t);
    if (!p) return;
    s.fix = p;
    const acc = Math.min(p.accuracy ?? 30, 80);
    const still = p.speed != null && p.speed < WALK_MPS;
    const near = nearestStop(p);
    if (!near) return;

    if (near.d <= AT_ENTER_M + acc / 2 && (near.id !== s.stop || s.phase !== 'at')) {
      arrive(near.id, t, false);
      s.leaving = 0;
      return;
    }
    if (s.phase === 'locating') {
      // Where we started: the first full average, not one noisy fix.
      if (!s.firstFix) {
        if (s.recent.length >= AVG_FIXES) s.firstFix = p;
      } else if (!still && (p.accuracy ?? 30) <= LEAVE_ACC_M && distM(s.firstFix, p) >= MOVE_M) {
        readHop(p);
      }
      if (s.cands) slide(p);
      return;
    }
    if (s.phase === 'at') {
      // One fix out of the station is noise; leaving takes several in a row,
      // and never at walking speed. The departure is dated from the first.
      if (still || (p.accuracy ?? 30) > LEAVE_ACC_M || distM(p, at(s.stop)) <= AT_LEAVE_M + acc) {
        s.approx = false;
        s.leaving = 0;
        return;
      }
      if (!s.leaving) s.leavingSince = t;
      s.leaving = (s.leaving || 0) + 1;
      if (s.leaving < LEAVE_FIXES) return;
      depart(s.leavingSince, false);
    }
    s.approx = false;
    if (!s.cands) readDirection(p);
    if (s.cands) slide(p);
    // Only a fix that's both on the line and well clear of the station we
    // left proves we're really travelling.
    if (s.cands && s.leftFrom && at(s.leftFrom)) s.awayM = Math.max(s.awayM || 0, distM(at(s.leftFrom), p));
  }

  function tick(t) {
    if (t - s.fixAt < FIX_FRESH_MS) return;
    const pc = primary();
    if (!pc) return;
    const seq = pc.line.stops;
    if (s.phase === 'between' && pc.idx + 1 < seq.length) {
      const hopMs = pc.line.hop_secs[pc.idx] * 1000;
      // From the last GPS progress if we had one on this hop, else from departure.
      const due = s.progress != null && s.fixAt > s.leftAt
        ? s.fixAt + hopMs * (1 - s.progress)
        : s.leftAt + hopMs;
      if (t >= due) arrive(seq[pc.idx + 1], t, true);
    } else if (s.phase === 'at' && pc.idx + 1 < seq.length && t - Math.max(s.arrivedAt, s.fixAt) >= DWELL_MS) {
      depart(t, true);
    }
  }

  function setFollow(route) {
    s.follow = route && s.follow !== route ? route : null;
  }

  // The departure we can match against the timetable: the station we just
  // left, when, and the line/direction pairs that could have taken us.
  // Departures guessed by the timetable itself are no evidence.
  function lastDeparture() {
    if (s.phase !== 'between' || !s.cands || !s.leftFrom) return null;
    if (s.leftBy === 'gps' ? (s.awayM || 0) < AWAY_M : s.leftBy !== 'manual') return null;
    return {
      stop: s.leftFrom,
      at: s.leftAt,
      by: s.leftBy,
      options: s.cands.map((c) => ({ route: c.line.route, dir: c.line.dir })),
    };
  }

  // What the timetable says about that departure: the routes that had a
  // train leaving then. Narrows what we already believed when it agrees.
  function setLikely(routes) {
    const possible = new Set((s.cands || []).map((c) => c.line.route));
    const fresh = routes.filter((r) => possible.has(r));
    if (!fresh.length) return;
    const both = s.likely ? fresh.filter((r) => s.likely.has(r)) : [];
    s.likely = new Set(both.length ? both : fresh);
  }

  // Where you can go from a station: each neighbouring station one stop
  // along some line, with the lines that go there.
  function neighbours(id) {
    const out = new Map();
    for (const line of linesThrough(id)) {
      const next = line.stops[line.stops.indexOf(id) + 1];
      if (!next) continue;
      if (!out.has(next)) out.set(next, new Set());
      out.get(next).add(line.route);
    }
    return [...out].map(([next, routes]) => ({ next, routes: [...routes] }));
  }

  // No GPS (underground station), or the rider would rather say it: the
  // metro is leaving `id` now, towards `next`. The timetable takes it from
  // there until GPS turns up, and GPS still overrides it if they picked wrong.
  function startAt(id, next, t) {
    const cands = lines
      .map((line) => ({ line, idx: line.stops.indexOf(id) }))
      .filter(({ line, idx }) => idx >= 0 && line.stops.slice(idx + 1, idx + 1 + MAX_SKIP).includes(next));
    if (!cands.length) return;
    s.stop = id;
    s.cands = cands;
    s.arrivedAt = t;
    dropImpossible();
    depart(t, s.fixAt === -Infinity || t - s.fixAt >= FIX_FRESH_MS, 'manual');
  }

  // Remaining stops of one candidate, with seconds until each.
  function remaining(c, t) {
    const seq = c.line.stops;
    const hops = c.line.hop_secs;
    const out = [];
    let secs = 0;
    if (s.phase === 'between' && c.idx + 1 < seq.length) {
      const hop = hops[c.idx];
      secs = s.progress != null && t - s.fixAt < FIX_FRESH_MS
        ? hop * (1 - s.progress)
        : Math.max(0, hop - (t - s.leftAt) / 1000);
      out.push({ id: seq[c.idx + 1], secs });
      for (let k = c.idx + 2; k < seq.length; k++) out.push({ id: seq[k], secs: (secs += hops[k - 1]) });
    } else {
      for (let k = c.idx + 1; k < seq.length; k++) out.push({ id: seq[k], secs: (secs += hops[k - 1]) });
    }
    return out;
  }

  function view(t) {
    const gps = s.fixAt === -Infinity ? 'waiting' : t - s.fixAt < FIX_FRESH_MS ? 'ok' : 'lost';
    const likely = s.likely ? [...s.likely] : null;
    const base = {
      phase: s.phase, gps, approx: s.approx, stop: s.stop,
      follow: s.follow,
      likely,
      // The timetable alone has pinned down the line (rider didn't choose).
      auto: !s.follow && likely?.length === 1 ? likely[0] : null,
    };
    if (s.phase === 'locating') {
      return { ...base, nearest: s.fix ? nearestStop(s.fix)?.id : null, routes: [] };
    }
    if (!s.cands) {
      const routes = [...new Set(linesThrough(s.stop).map((l) => l.route))];
      return { ...base, directionKnown: false, routes, shown: routes };
    }

    const pc = primary();
    const routes = [...new Set(s.cands.map((c) => c.line.route))];
    const shownCands = chosen();
    const shown = [...new Set(shownCands.map((c) => c.line.route))];

    // The stretch every shown line still runs along, then where they split.
    // A line "runs along" up to the last of the main line's stops it also
    // has, so an express skipping stations doesn't count as splitting off.
    const lists = shownCands.map((c) => ({ c, rest: remaining(c, t) }));
    const main = lists.find((l) => l.c === pc) || lists[0];
    let shared = main.rest.length;
    for (const l of lists) {
      const ids = new Set(l.rest.map((r) => r.id));
      let last = -1;
      main.rest.forEach((r, k) => { if (ids.has(r.id)) last = k; });
      shared = Math.min(shared, last + 1);
    }
    const ahead = main.rest.slice(0, shared);
    const splitAt = ahead.at(-1)?.id ?? s.stop;
    const branches = shared === main.rest.length ? [] : lists
      .filter((l, i, all) => all.findIndex((m) => m.c.line.route === l.c.line.route) === i)
      .map((l) => {
        const from = l.rest.findIndex((r) => r.id === splitAt);
        return {
          route: l.c.line.route,
          short: l.c.line.short,
          color: l.c.line.color,
          terminus: l.c.line.terminus,
          via: l.rest[from + 1]?.id ?? null,
        };
      });

    const seq = main.c.line.stops;
    const before = seq.slice(0, main.c.idx + (s.phase === 'between' ? 1 : 0));
    // How far along the current hop: GPS if fresh, else the timetable.
    let progress = null;
    if (s.phase === 'between' && main.c.idx + 1 < seq.length) {
      progress = s.progress != null && t - s.fixAt < FIX_FRESH_MS
        ? s.progress
        : Math.min(1, (t - s.leftAt) / 1000 / main.c.line.hop_secs[main.c.idx]);
    }
    const atEnd = s.phase === 'at' && main.c.idx === seq.length - 1;
    // At a junction with nothing shared ahead there's no single next stop.
    const nextRow = ahead[0] ?? (branches.length ? null : main.rest[0]);
    return {
      ...base,
      directionKnown: true,
      routes,
      shown,
      line: main.c.line,
      next: nextRow?.id ?? null,
      secsToNext: nextRow?.secs ?? null,
      progress,
      passed: before,
      ahead,
      splitAt: branches.length ? splitAt : null,
      branches,
      terminus: shown.length === 1 ? main.c.line.terminus : null,
      atEnd,
    };
  }

  return { fix, tick, view, setFollow, setLikely, lastDeparture, startAt, neighbours, state: s };
}
