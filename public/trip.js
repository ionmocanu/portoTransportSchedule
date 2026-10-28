/*
 * trip.js — the "follow my trip" screen. Top: what's next, like a car
 * GPS's instruction card. Middle: a GPS-style view where you stay put two
 * thirds of the way down and the line slides towards you, stations spaced
 * by travel time. Below: the whole route as a list, forward pointing up.
 * GPS fixes go into trip-core's tracker; this file only draws what it
 * reports and wires up the buttons.
 *
 * Dev aid: open the app with ?tripsim=C:1 (route:direction) to ride that
 * whole line on a fake GPS at 10× speed, or ?tripsim=Viso>Fórum Maia to
 * ride just that trip — no phone or metro needed.
 */
import { createTracker, matchDeparture, ALL } from './trip-core.js';
import { t } from './i18n.js';

const TICK_MS = 1000;
const ARROW_PERIOD_S = 1.6;  // keep in sync with the trip-arrows animations
const NAV_YOU = 0.66;        // you sit two thirds of the way down the view
const NAV_AHEAD_SECS = 270;  // travel time above you while the direction is unknown
const NAV_AHEAD_STOPS = 3;   // auto-zoom so this many next stations fit above you
const NAV_MIN_SECS = 150;    // …but never zoom in or out past these spans
const NAV_MAX_SECS = 900;
const NAV_TOP_PAD = 48;      // room above the furthest station for its name
const NAV_BEHIND_STOPS = 2;  // passed stations still drawn below you
const FORK_GAP = 64;         // px between branches where lines split
const FORK_BEND = 40;        // height of the S-bend where a branch leaves

let ctx = null;      // { stops, getStopId }
let lines = null;    // /api/lines, fetched on first open
let tracker = null;
let watchId = null;
let timer = null;
let wakeLock = null;
let gpsError = null; // 'denied' | 'unavailable' | null
let showHistory = false; // route list: show every passed stop, not the folded run
let sim = null;
const last = { hero: '', rest: '', bar: '', fork: '' };
const stopTimes = new Map(); // stop id → { at, departures } from /api/stop-times
const matched = new Set();   // departures already checked against the timetable

const el = {};

export function initTrip({ stops, getStopId }) {
  ctx = { stops, getStopId };
  el.open = document.getElementById('trip-open');
  el.root = document.getElementById('trip');
  el.gps = document.getElementById('trip-gps');
  el.close = document.getElementById('trip-close');
  el.hero = document.getElementById('trip-hero');
  el.nav = document.getElementById('trip-nav');
  el.rest = document.getElementById('trip-rest');
  if (!el.open || !el.root) return;
  el.navAhead = el.nav.querySelector('.tnav__track--ahead');
  el.navBehind = el.nav.querySelector('.tnav__track--behind');
  el.navFork = el.nav.querySelector('.tnav__fork');
  el.navStops = el.nav.querySelector('.tnav__stops');
  el.navBar = el.nav.querySelector('.tnav__bar');

  const simParam = new URLSearchParams(location.search).get('tripsim');
  if (simParam?.includes('>')) sim = { from: simParam.split('>')[0].trim(), to: simParam.split('>')[1].trim() };
  else if (simParam) sim = { route: simParam.split(':')[0], dir: simParam.split(':')[1] ?? '0' };
  if (!navigator.geolocation && !sim) el.open.hidden = true;

  el.open.addEventListener('click', openTrip);
  el.close.addEventListener('click', () => history.state?.trip ? history.back() : closeTrip());
  window.addEventListener('popstate', () => { if (!el.root.hidden) closeTrip(); });
  el.root.addEventListener('click', onAction);
  document.addEventListener('visibilitychange', () => {
    if (!el.root.hidden && document.visibilityState === 'visible') keepAwake();
  });
  if (sim) openTrip();
}

/* Language switch re-renders with the new strings. */
export function refreshTrip() {
  Object.keys(last).forEach((k) => { last[k] = ''; });
  if (!el.root?.hidden) render();
}

async function openTrip() {
  el.root.hidden = false;
  document.body.classList.add('is-tripping');
  history.pushState({ trip: true }, '');
  gpsError = null;
  showHistory = false;
  matched.clear();
  navPxs = 0;
  Object.keys(last).forEach((k) => { last[k] = ''; });
  el.navStops.replaceChildren();
  el.navAhead.replaceChildren();
  el.navBehind.replaceChildren();
  el.nav.hidden = true;
  el.rest.innerHTML = '';
  el.hero.innerHTML = `<p class="trip__note">${t('trip.locating')}</p>`;

  try {
    if (!lines) {
      const res = await fetch('/api/lines');
      if (!res.ok) throw new Error(`lines ${res.status}`);
      lines = await res.json();
    }
  } catch (err) {
    console.error(err);
    el.hero.innerHTML = `<p class="trip__note">${t('boot.error.title')}</p>`;
    return;
  }

  tracker = createTracker(ctx.stops, lines);
  if (sim) await startSim();
  else watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
  });
  timer = setInterval(() => { tracker.tick(now()); render(); }, TICK_MS);
  keepAwake();
  render();
}

function closeTrip() {
  el.root.hidden = true;
  document.body.classList.remove('is-tripping');
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(timer);
  clearInterval(sim?.timer);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  tracker = null;
}

// A fix only updates the tracker. The screen redraws on the steady 1 s tick,
// so every move glides its full 1 s transition at an even speed — redrawing
// on each fix too would restart the glides mid-way and make them stutter.
function onFix(pos) {
  gpsError = null;
  const c = pos.coords;
  tracker.fix({ lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, speed: c.speed }, now());
}

function onGpsError(err) {
  // TIMEOUT just means no fix yet (e.g. underground) — keep watching.
  if (err.code === err.PERMISSION_DENIED) gpsError = 'denied';
  else if (err.code === err.POSITION_UNAVAILABLE) gpsError = 'unavailable';
  render();
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported or refused */ }
}

/* ── Which line is this? Ask the timetable ──────────────────────────
   When the metro leaves a station (seen by GPS, or "leaving now" tapped),
   the scheduled departures at that moment tell which line(s) it can be. */
async function getStopTimes(stop) {
  const hit = stopTimes.get(stop);
  if (hit && Date.now() - hit.fetched < 10 * 60000) return hit.departures;
  const res = await fetch(`/api/stop-times?stop=${encodeURIComponent(stop)}`);
  if (!res.ok) throw new Error(`stop-times ${res.status}`);
  const { departures } = await res.json();
  stopTimes.set(stop, { fetched: Date.now(), departures });
  return departures;
}

async function checkTimetable() {
  const dep = tracker?.lastDeparture();
  if (!dep) return;
  const k = `${dep.stop}|${dep.at}`;
  if (matched.has(k)) return;
  matched.add(k);
  try {
    const routes = matchDeparture(dep, await getStopTimes(dep.stop));
    if (routes.length && tracker) {
      tracker.setLikely(routes);
      last.bar = '';
      render();
    }
  } catch (err) {
    console.error(err); // no timetable answer — the rider can still choose
  }
}

/* ── Fake GPS for ?tripsim= ─────────────────────────────────────── */
// Simulated clock: 10× real time, starting at sim.clock0.
function now() {
  return sim?.clock0 ? sim.clock0 + (Date.now() - sim.t0) * 10 : Date.now();
}

async function startSim() {
  let line = lines.find((l) => l.route === sim.route && l.dir === sim.dir) || lines[0];
  let i0 = 0;
  let i1 = line.stops.length - 1;
  if (sim.from) {
    // A from>to trip: the line serving both in that order with the fewest stops.
    const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const idOf = (n) => Object.values(ctx.stops).find((s) => fold(s.name) === fold(n))?.id;
    const from = idOf(sim.from);
    const to = idOf(sim.to);
    const best = lines
      .map((l) => ({ l, a: l.stops.indexOf(from), b: l.stops.indexOf(to) }))
      .filter(({ a, b }) => a >= 0 && b > a)
      .sort((x, y) => (x.b - x.a) - (y.b - y.a))[0];
    if (!best) { console.error(`tripsim: no line from "${sim.from}" to "${sim.to}"`); return; }
    ({ l: line, a: i0, b: i1 } = best);
  }
  // Ride a real scheduled train when there is one: start the clock 20 s
  // before this line's next departure from the first station, so matching
  // against the timetable works like it would on a real trip.
  sim.t0 = Date.now();
  sim.clock0 = Date.now();
  try {
    const next = (await getStopTimes(line.stops[i0]))
      .find((d) => d.route === line.route && d.dir === line.dir && d.at >= Date.now() - 60000);
    if (next) sim.clock0 = next.at - 20000;
  } catch { /* no timetable: ride on the plain clock */ }
  sim.label = `${line.short} · ${ctx.stops[line.stops[i0]]?.name} → ${ctx.stops[line.stops[i1]]?.name}`;
  // Timeline: 20 s dwell at each station, then the hop at timetable speed.
  const legs = [];
  let at = 0;
  for (let i = i0; i <= i1; i++) {
    const id = line.stops[i];
    legs.push({ from: id, to: id, start: at, end: (at += 20000) });
    if (i < i1) legs.push({ from: id, to: line.stops[i + 1], start: at, end: (at += line.hop_secs[i] * 1000) });
  }
  sim.timer = setInterval(() => {
    const elapsed = now() - sim.clock0;
    const leg = legs.find((l) => elapsed < l.end) || legs.at(-1);
    const a = ctx.stops[leg.from];
    const b = ctx.stops[leg.to];
    const x = Math.min(1, (elapsed - leg.start) / (leg.end - leg.start));
    onFix({ coords: { latitude: a.lat + (b.lat - a.lat) * x, longitude: a.lon + (b.lon - a.lon) * x, accuracy: 15 } });
  }, 500);
}

/* ── Actions ────────────────────────────────────────────────────── */
function onAction(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !tracker) return;
  if (b.dataset.act === 'follow') tracker.setFollow(b.dataset.route);
  if (b.dataset.act === 'leave') tracker.startAt(b.dataset.from, b.dataset.to, now());
  if (b.dataset.act === 'history') showHistory = true;
  Object.keys(last).forEach((k) => { last[k] = ''; });
  render();
}

/* ── Helpers ────────────────────────────────────────────────────── */
const name = (id) => ctx.stops[id]?.name ?? '';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lineOf = (route) => lines.find((l) => l.route === route);
const mins = (secs) => Math.max(1, Math.round(secs / 60));
const minLabel = (secs) => `${mins(secs)} ${t('trip.min')}`;

function badge(route) {
  const l = lineOf(route);
  return `<span class="badge" style="--line:${l?.color}">${esc(l?.short ?? route)}</span>`;
}

function lineButton(route, follow, sm = false) {
  const l = lineOf(route);
  return `<button type="button" class="trip__linebtn${sm ? ' trip__linebtn--sm' : ''}" data-act="follow"
    data-route="${route}" aria-pressed="${follow === route}" style="--line:${l?.color}">${esc(l?.short ?? route)}</button>`;
}

// Parallel coloured tracks, one per line, with the direction arrows.
function stripes(routes, cls) {
  return `<span class="${cls}">${routes
    .map((r) => `<i style="--c:${lineOf(r)?.color}"></i>`).join('')}</span>`;
}

// Branches after a split, grouped by where they end up (B and Bx to Póvoa
// share one). A line that simply ends at the split has no `via`.
function branchGroups(v) {
  const groups = [];
  for (const b of v.branches || []) {
    const g = groups.find((x) => x.terminus === b.terminus && !x.via === !b.via);
    if (g) g.routes.push(b.route);
    else groups.push({ terminus: b.terminus, via: b.via, routes: [b.route] });
  }
  return groups;
}

// Replace a section's markup only when it changed. New arrows start in step
// with the ones already running (offset on that section only — changing it
// on running animations would make them jump).
function setHtml(node, key, html) {
  if (last[key] === html) return;
  last[key] = html;
  node.style.setProperty('--arrow-offset', arrowOffset());
  node.innerHTML = html;
}

const arrowOffset = () => `-${((performance.now() / 1000) % ARROW_PERIOD_S).toFixed(2)}s`;

// Left-to-right lane order in the GPS view, matching the geography where
// lines split off: A leaves left at Senhora da Hora, E left at Verdes, C
// right at Fonte do Cuco — so a branch never has to cross another lane.
const LANE_ORDER = ['A', 'E', 'B', 'Bexp', 'C', 'F', 'D'];
const laneRank = (r) => (LANE_ORDER.includes(r) ? LANE_ORDER.indexOf(r) : LANE_ORDER.length);

// Keep one bar per line in a tracks element, in LANE_ORDER: lines that drop
// out shrink and fade instead of vanishing, new ones grow in.
function syncStripes(box, routes) {
  let wrap = box.firstElementChild;
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'trip-tracks trip-tracks--v trip-tracks--up';
    box.append(wrap);
  }
  const want = new Set(routes);
  for (const i of [...wrap.children]) {
    if (!want.has(i.dataset.route) && !i.classList.contains('is-leaving')) {
      i.classList.add('is-leaving');
      setTimeout(() => i.remove(), 600);
    }
  }
  const sorted = [...routes].sort((a, b) => laneRank(a) - laneRank(b));
  for (const r of sorted) {
    if (wrap.querySelector(`i[data-route="${r}"]:not(.is-leaving)`)) continue;
    const i = document.createElement('i');
    i.dataset.route = r;
    i.style.setProperty('--c', lineOf(r)?.color);
    i.style.setProperty('--arrow-offset', arrowOffset());
    wrap.append(i); // grows in via trip-stripe-in
  }
  // Re-insert only when the order is actually wrong: moving a node restarts
  // its grow-in animation, so doing it every tick made the stripes flicker.
  const live = [...wrap.querySelectorAll('i:not(.is-leaving)')];
  if (live.map((i) => i.dataset.route).join() !== sorted.join()) {
    for (const r of sorted) wrap.append(live.find((i) => i.dataset.route === r));
  }
}

/* ── Rendering ──────────────────────────────────────────────────── */
function render() {
  if (!tracker) return;
  checkTimetable();
  const v = tracker.view(now());
  el.gps.textContent = gpsError ? '' : sim ? `SIM 10× · ${sim.label ?? ''}` : t(`trip.gps.${v.gps}`);
  el.gps.dataset.state = v.gps;

  if (gpsError) {
    setHtml(el.hero, 'hero', `<p class="trip__note trip__note--warn">${t(`trip.gps.${gpsError}`)}</p>`);
    el.nav.hidden = true;
    setHtml(el.rest, 'rest', manualStartHtml() + footHtml());
    return;
  }
  if (v.phase === 'locating') {
    const near = v.nearest ? `<p class="trip__note">${t('trip.nearest', { name: esc(name(v.nearest)) })}</p>` : '';
    setHtml(el.hero, 'hero', `<p class="trip__note">${t('trip.locating')}</p>${near}`);
    el.nav.hidden = true;
    setHtml(el.rest, 'rest', manualStartHtml() + footHtml());
    return;
  }

  setHtml(el.hero, 'hero', heroHtml(v));
  renderNav(v);
  setHtml(el.rest, 'rest', (v.directionKnown ? routeHtml(v) : directionPickHtml(v.stop)) + footHtml());
}

const footHtml = () => `<p class="trip__foot">${t('trip.disclaimer')}</p>`;

// No GPS yet: offer to start from the station picked on the main screen.
function manualStartHtml() {
  const from = ctx.getStopId();
  if (!from || !ctx.stops[from]) return '';
  return `<div class="trip__block"><h3 class="trip__h">${t('trip.manual', { name: esc(name(from)) })}</h3>${leaveButtons(from)}</div>`;
}

function directionPickHtml(stop) {
  return `<div class="trip__block"><h3 class="trip__h">${t('trip.where')}</h3>
    <p class="trip__hint">${t('trip.whereHint', { name: esc(name(stop)) })}</p>${leaveButtons(stop)}</div>`;
}

function leaveButtons(from) {
  return `<div class="trip__leave">${tracker.neighbours(from).map((n) => `
    <button type="button" class="trip__leavebtn" data-act="leave" data-from="${from}" data-to="${n.next}">
      <span class="trip__leavearrow" aria-hidden="true">→</span>
      <span class="trip__leaveto">${esc(name(n.next))}</span>
      <span class="trip__leavelines">${n.routes.map((r) => badge(r)).join('')}</span>
    </button>`).join('')}</div>`;
}

/* Instruction card: where you are, or the next stop and how long to it. */
function heroHtml(v) {
  let eyebrow;
  let title;
  let side = '';
  if (v.atEnd) {
    eyebrow = t('trip.end');
    title = name(v.stop);
  } else if (v.phase === 'at') {
    eyebrow = t('trip.at');
    title = name(v.stop);
  } else if (v.next) {
    eyebrow = t('trip.next');
    title = name(v.next);
    side = v.secsToNext <= 30
      ? `<span class="trip__eta trip__eta--now">${t('trip.arriving')}</span>`
      : `<span class="trip__eta"><b>${mins(v.secsToNext)}</b> ${t('trip.min')}</span>`;
  } else {
    eyebrow = t('trip.after', { name: esc(name(v.stop)) });
    title = t('trip.junction');
  }
  const approx = v.approx ? `<span class="trip__approx">${t('trip.approx')}</span>` : '';
  const towards = v.terminus && !v.atEnd ? `<span class="trip__towards">${t('trip.towards', { name: esc(v.terminus) })}</span>` : '';
  return `<div class="trip__hero">
    <div class="trip__herotext"><span class="trip__eyebrow">${eyebrow}${approx}</span>
      <span class="trip__stop${title.length > 16 ? ' is-long' : ''}">${esc(title)}</span>${towards}</div>${side}</div>`;
}

/* ── GPS view ───────────────────────────────────────────────────────
   You're fixed at NAV_YOU of the height; every station sits at
   (seconds away × px per second) above or below you. Elements are kept
   between renders and only their positions change, with a 1 s linear
   transition, so the line glides down towards you like a road in a car
   GPS. Where lines split, the track forks into one branch per group. */
/* Branches past a split, for the GPS view: lines grouped by the track they
   take — same next station, or an express skipping along the same track
   (Bx with B). The group's stations are the ones all its stopping lines
   share, up to where they split again. Busiest branch straight on, others
   fanning out left, then right. */
function navBranches(v) {
  const groups = [];
  for (const b of v.branches || []) {
    if (!b.via) continue; // ends at the split: no branch to draw
    const ids = b.after.map((r) => r.id);
    const g = groups.find((x) => x.ids.includes(b.via) || ids.includes(x.via));
    if (!g) { groups.push({ via: b.via, ids, after: b.after, routes: [b.route], members: [b] }); continue; }
    g.routes.push(b.route);
    g.members.push(b);
    if (b.via !== g.via && ids.includes(g.via)) Object.assign(g, { via: b.via, ids, after: b.after }); // b stops sooner
  }
  if (!groups.length) return [];
  // The busiest branch goes straight on; the others fan out to the side
  // their lanes are on (see LANE_ORDER), nearest first.
  const rank = (g) => g.routes.reduce((s, r) => s + laneRank(r), 0) / g.routes.length;
  const main = groups.reduce((a, b) => (b.routes.length > a.routes.length ? b : a));
  const lefts = groups.filter((g) => g !== main && rank(g) < rank(main)).sort((a, b) => rank(b) - rank(a));
  const rights = groups.filter((g) => g !== main && rank(g) >= rank(main)).sort((a, b) => rank(a) - rank(b));
  const placed = [
    { g: main, dx: 0 },
    ...lefts.slice(0, 2).map((g, i) => ({ g, dx: -FORK_GAP * (i + 1) })),
    ...rights.slice(0, 2).map((g, i) => ({ g, dx: FORK_GAP * (i + 1) })),
  ];
  return placed.map(({ g, dx }) => {
    const stopping = g.members.filter((m) => m.via === g.via);
    const stops = [];
    for (const s of g.after) {
      if (stops.length >= NAV_AHEAD_STOPS || !stopping.every((m) => m.after.some((r) => r.id === s.id))) break;
      stops.push(s);
    }
    return { routes: g.routes, stops, dx };
  });
}

/* Auto-zoom, like a car GPS: pixels per second of travel chosen so the next
   NAV_AHEAD_STOPS stations fit above you — along every branch when a split
   is coming, so each option shows its own next stations. The span is
   counted from the last station passed, so it holds steady along a hop and
   only changes at a station — and then the zoom eases over instead of
   jumping. */
let navPxs = 0;
function navScale(v, youY, branches) {
  let span = NAV_AHEAD_SECS;
  const routes = branches.length ? branches.map((b) => [...v.ahead, ...b.stops]) : [v.ahead];
  const furthest = Math.max(0, ...routes.map((r) => r[Math.min(NAV_AHEAD_STOPS, r.length) - 1]?.secs ?? 0));
  if (v.directionKnown && furthest) {
    const idx = v.line.stops.indexOf(v.stop);
    const elapsed = v.phase === 'between' && idx >= 0 ? (v.progress ?? 0) * v.line.hop_secs[idx] : 0;
    span = elapsed + furthest;
  }
  const target = (youY - NAV_TOP_PAD) / Math.min(NAV_MAX_SECS, Math.max(NAV_MIN_SECS, span));
  navPxs = navPxs ? navPxs + (target - navPxs) * 0.3 : target;
  return navPxs;
}

function renderNav(v) {
  el.nav.hidden = false;
  el.nav.classList.toggle('is-approx', !!v.approx);
  el.nav.classList.toggle('is-unknown', !v.directionKnown);
  const H = el.nav.clientHeight;
  const W = el.nav.clientWidth;
  const youY = Math.round(H * NAV_YOU);
  const branches = v.directionKnown ? navBranches(v) : [];
  const pxs = navScale(v, youY, branches);
  // With a fork coming, the track moves to the middle (it glides there —
  // lanes and dots transition) so every branch has room for its names.
  const x = Math.round(W * (branches.length ? 0.5 : 0.3));
  // Names go on the outside of each branch; the straight-on branch takes
  // the side no other branch fans out to.
  const mainLeft = branches.some((b) => b.dx > 0) && !branches.some((b) => b.dx < 0);
  el.nav.style.setProperty('--x', `${x}px`);
  el.nav.style.setProperty('--you', `${youY}px`);

  const routes = (v.directionKnown ? v.shown : v.routes) || [];
  syncStripes(el.navAhead, routes);
  syncStripes(el.navBehind, routes);
  el.nav.style.setProperty('--n', String(Math.max(1, routes.length)));

  const items = [];
  let aheadTop = -40;   // where the coloured track ahead ends (y)
  let behindEnd = H + 40;
  let forkY = null;

  if (!v.directionKnown) {
    items.push({ id: v.stop, y: youY, cls: 'is-current', right: '' });
    aheadTop = -40;
  } else {
    const seq = v.line.stops;
    const hops = v.line.hop_secs;
    const idx = seq.indexOf(v.stop);
    const elapsed = v.phase === 'between' && idx >= 0 ? (v.progress ?? 0) * hops[idx] : 0;
    if (idx >= 0) {
      let back = elapsed;
      items.push({ id: v.stop, y: youY + back * pxs, cls: v.phase === 'at' ? 'is-current' : 'is-passed', right: v.phase === 'at' ? t('trip.here') : '' });
      for (let k = idx - 1; k >= 0 && k >= idx - NAV_BEHIND_STOPS; k--) {
        back += hops[k];
        items.push({ id: seq[k], y: youY + back * pxs, cls: 'is-passed', right: '' });
      }
      let toStart = elapsed;
      for (let k = 0; k < idx; k++) toStart += hops[k];
      behindEnd = Math.min(H + 40, youY + toStart * pxs);
    }
    v.ahead.forEach((a, i) => {
      const first = i === 0 && v.phase === 'between';
      items.push({
        id: a.id,
        y: youY - a.secs * pxs,
        cls: first ? 'is-next' : '',
        right: first && a.secs <= 30 ? t('trip.arriving') : minLabel(a.secs),
      });
    });
    const lastY = items.find((it) => it.id === (v.splitAt ?? v.ahead.at(-1)?.id))?.y;
    if (v.branches.length) forkY = lastY ?? youY;
    // Each branch's own next stations, on its own bundle; the first one
    // carries the branch's line letters.
    if (forkY != null) {
      for (const b of branches) {
        b.stops.forEach((s, i) => items.push({
          id: s.id,
          y: youY - s.secs * pxs,
          sx: x + b.dx,
          sw: b.routes.length * 8,
          left: b.dx < 0 || (b.dx === 0 && mainLeft),
          cls: 'is-branch',
          right: minLabel(s.secs) + (i === 0 ? ` ${b.routes.map((r) => `<i class="tnav__tag" style="--line:${lineOf(r)?.color}">${esc(lineOf(r)?.short ?? r)}</i>`).join('')}` : ''),
        }));
      }
    }
    if (v.atEnd) aheadTop = youY;
    else if (forkY != null) aheadTop = forkY;
    else if (v.ahead.at(-1)?.id === seq.at(-1)) aheadTop = lastY; // line ends on screen
  }

  // Tracks: coloured ahead of you, greyed behind. The coloured one is a long
  // strip that only moves (its top end glides with the stations) and is cut
  // off at you by its clip box — animating its height instead stalls and
  // costs a re-layout on every frame.
  el.navAhead.style.transform = `translateY(${Math.min(aheadTop, youY).toFixed(1)}px)`;
  el.navBehind.style.height = `${Math.max(0, behindEnd - youY).toFixed(1)}px`;

  // A passed station's name gives way when it would sit on top of another.
  for (const it of items) {
    if (it.cls !== 'is-passed') continue;
    it.quiet = items.some((o) => o !== it && o.cls !== 'is-passed' && (o.sx ?? x) === x && Math.abs(o.y - it.y) < 44);
  }

  // Stations: keyed by stop id so each one glides instead of being redrawn.
  const keep = new Set();
  for (const it of items) {
    keep.add(it.id);
    let node = el.navStops.querySelector(`[data-stop="${it.id}"]`);
    const inner = `<span class="tnav__dot"></span><span class="tnav__label"><span class="tnav__name">${esc(name(it.id))}</span>${it.right ? `<span class="tnav__min">${it.right}</span>` : ''}</span>`;
    if (!node) {
      node = document.createElement('div');
      node.dataset.stop = it.id;
      node.style.transform = `translateY(${it.y}px)`;
      el.navStops.append(node);
    }
    node.className = `tnav__stop ${it.cls}${it.left ? ' is-left' : ''}${it.quiet ? ' is-quiet' : ''}`;
    if (node.dataset.html !== inner) { node.innerHTML = inner; node.dataset.html = inner; }
    node.style.transform = `translateY(${it.y.toFixed(1)}px)`;
    // Stations on a branch sit on that branch's bundle, not the main track.
    if (it.sx != null) {
      node.style.setProperty('--sx', `${it.sx}px`);
      node.style.setProperty('--sw', `${it.sw}px`);
    } else {
      node.style.removeProperty('--sx');
      node.style.removeProperty('--sw');
    }
  }
  for (const node of [...el.navStops.children]) if (!keep.has(node.dataset.stop)) node.remove();

  // Fork: past the split, one branch per group of lines heading the same
  // way — the busiest straight on, the others fanning out — each a bundle
  // of its own lanes with its next stations on it.
  let forkHtml = '';
  if (forkY != null && branches.length) {
    const order = [...el.navAhead.querySelectorAll('i[data-route]:not(.is-leaving)')].map((i) => i.dataset.route);
    const n = Math.max(1, order.length);
    const lane = (k, count, cx) => cx - (count - 1) * 4 + k * 8; // stripe centres, 8 apart
    const top = 1500;
    const paths = [];
    for (const b of branches) {
      const cx = x + b.dx;
      const mine = order.filter((r) => b.routes.includes(r));
      mine.forEach((r, k) => {
        const from = lane(order.indexOf(r), n, x);
        const to = lane(k, mine.length, cx);
        const d = `M${from} ${top} C${from} ${top - FORK_BEND / 2} ${to} ${top - FORK_BEND / 2} ${to} ${top - FORK_BEND} L${to} 0`;
        paths.push(`<path d="${d}" stroke="${lineOf(r)?.color}" /><path class="tnav__forkarrows" d="${d}" />`);
      });
    }
    forkHtml = `<svg class="tnav__forksvg" width="${W}" height="${top}" viewBox="0 0 ${W} ${top}">${paths.join('')}</svg>`;
  }
  // The fork fades out (rather than vanishing) once the lines are settled.
  if (forkHtml && last.fork !== forkHtml) { last.fork = forkHtml; el.navFork.innerHTML = forkHtml; }
  el.navFork.classList.toggle('is-gone', !forkHtml);
  if (forkHtml) el.navFork.style.transform = `translateY(${forkY.toFixed(1)}px)`;

  // Bottom bar: which line are you on? Your pick wins — one line, or "All"
  // to see every possible line at once; otherwise the one the timetable
  // matched is marked "auto". Plus how long to the end or split.
  const routesHere = v.routes || [];
  let chooser = '';
  if (routesHere.length > 1 || v.follow) {
    const all = `<button type="button" class="trip__linebtn is-all" data-act="follow" data-route="${ALL}"
      aria-pressed="${v.follow === ALL}">${t('trip.all')}</button>`;
    const btns = all + routesHere.map((r) => {
      const l = lineOf(r);
      const pressed = v.follow === r;
      const auto = v.auto === r;
      const unlikely = !v.follow && v.likely && !v.likely.includes(r);
      return `<button type="button" class="trip__linebtn${auto ? ' is-auto' : ''}${unlikely ? ' is-unlikely' : ''}"
        data-act="follow" data-route="${r}" aria-pressed="${pressed}" style="--line:${l?.color}">${esc(l?.short ?? r)}${auto ? `<small>${t('trip.auto')}</small>` : ''}</button>`;
    }).join('');
    const hint = v.follow === ALL ? t('trip.allHint')
      : v.follow ? t('trip.chosen')
      : v.auto ? t('trip.autoHint')
      : t('trip.which');
    chooser = `<div class="tnav__choose"><span class="tnav__ask">${hint}</span><span class="tnav__lines">${btns}</span></div>`;
  }
  let summary = '';
  if (v.directionKnown && !v.atEnd) {
    const end = v.ahead.at(-1);
    if (end && v.splitAt) summary = t('trip.toSplit', { name: esc(name(v.splitAt)), min: mins(end.secs) });
    else if (end) summary = t('trip.toEnd', { name: esc(name(end.id)), min: mins(end.secs) });
  }
  setHtml(el.navBar, 'bar', `${chooser}<span class="tnav__summary">${summary}</span>`);
}

/* ── Route list ─────────────────────────────────────────────────────
   The whole line as one straight run, forward pointing up: where the line
   ends (or splits) at the top, you in the middle, passed stops below. */
function routeHtml(v) {
  const routes = v.shown;
  const rows = []; // built in travel order, flipped at the end

  const fold = !showHistory && v.passed.length > 4;
  const passed = fold ? [v.passed[0], ...v.passed.slice(-2)] : v.passed;
  passed.forEach((id, i) => {
    rows.push(routeRow(id, 'is-passed', ''));
    if (fold && i === 0) {
      rows.push(`<li class="troute__row is-passed is-fold">${stripes(routes, 'trip-tracks trip-tracks--v trip-tracks--up')}
        <button type="button" class="troute__more" data-act="history">${t('trip.more', { n: v.passed.length - 3 })}</button></li>`);
    }
  });
  if (v.phase === 'at') rows.push(routeRow(v.stop, 'is-current', t('trip.here')));
  else rows.push(`<li class="troute__row is-you">${stripes(routes, 'trip-tracks trip-tracks--v trip-tracks--up')}
    <span class="troute__dot"></span><span class="troute__name">${t('trip.onTheWay')}</span><span class="troute__min"></span></li>`);
  v.ahead.forEach((a, i) => {
    const label = i === 0 && v.phase === 'between' && a.secs <= 30 ? t('trip.arriving') : minLabel(a.secs);
    rows.push(routeRow(a.id, i === 0 && v.phase === 'between' ? 'is-next' : '', label));
  });

  const groups = branchGroups(v);
  const split = groups.length ? `<div class="troute__split">
    <h3 class="trip__h">${t('trip.split', { name: esc(name(v.splitAt)) })}</h3>
    ${groups.map((g) => `<div class="troute__branch">
      <span class="troute__branchlines">${g.routes.map((r) => lineButton(r, v.follow, true)).join('')}</span>
      <span class="troute__branchto">${g.via ? t('trip.towards', { name: esc(g.terminus) }) : t('trip.endsHere')}</span>
      ${g.via ? `<span class="troute__via">${t('trip.via', { name: esc(name(g.via)) })}</span>` : ''}</div>`).join('')}
  </div>` : '';

  return `<div class="trip__block"><h3 class="trip__h">${t('trip.route')}</h3>${split}
    <ol class="troute" style="--n:${routes.length}">${rows.reverse().join('')}</ol></div>`;

  function routeRow(id, cls, right) {
    return `<li class="troute__row ${cls}">${stripes(routes, 'trip-tracks trip-tracks--v trip-tracks--up')}
      <span class="troute__dot"></span><span class="troute__name">${esc(name(id))}</span>
      <span class="troute__min">${right}</span></li>`;
  }
}
