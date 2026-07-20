import { api } from './data.js';

/* ── State ──────────────────────────────────────────────────────── */
const state = {
  feeds: [],          // [{id,name,kind,default_stop}]
  feedId: null,
  cfg: null,          // current feed config (stops, colors)
  stopsById: new Map(),
  stopId: null,
  directionId: null,
  payload: null,
  fetchedAt: null,
  mode: 'name',       // name | line | near  (buses)
  lineRoutes: null,   // cached routes list for current feed
};

const el = (id) => document.getElementById(id);
const dom = {
  tabbar: el('tabbar'),
  stopButton: el('stop-button'), stopName: el('stop-name'), stopEyebrow: el('stop-eyebrow'),
  stopPanel: el('stop-panel'),
  modes: el('modes'), modeName: el('mode-name'), modeLine: el('mode-line'), modeNear: el('mode-near'),
  findName: el('find-name'), findLine: el('find-line'), findNear: el('find-near'),
  stopSearch: el('stop-search'), stopRecents: el('stop-recents'), stopList: el('stop-list'),
  lineSearch: el('line-search'), lineGrid: el('line-grid'), lineStopList: el('line-stop-list'),
  nearCta: el('near-cta'), nearNote: el('near-note'), nearList: el('near-list'),
  diagram: el('diagram'), board: el('board'), stamp: el('stamp'), refresh: el('refresh'),
};

/* ── Persistence (per feed) ─────────────────────────────────────── */
const store = {
  read() { try { return JSON.parse(localStorage.getItem('proximo') || '{}'); } catch { return {}; } },
  write(patch) { try { localStorage.setItem('proximo', JSON.stringify({ ...this.read(), ...patch })); } catch {} },
  feedState(feedId) { return this.read()[feedId] || {}; },
  saveFeed(feedId, patch) {
    const all = this.read();
    all[feedId] = { ...(all[feedId] || {}), ...patch };
    this.write(all);
  },
  pushRecent(feedId, stopId) {
    const fs = this.feedState(feedId);
    const recents = [stopId, ...(fs.recents || []).filter((x) => x !== stopId)].slice(0, 4);
    this.saveFeed(feedId, { recents });
  },
};

const LINE_COLORS = () => state.cfg?.line_colors || {};
const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/* ── Boot ───────────────────────────────────────────────────────── */
(async () => {
  try {
    const { feeds } = await api.feeds();
    state.feeds = feeds;
  } catch (err) {
    dom.board.innerHTML = `<div class="board__empty"><strong>Couldn't reach the server</strong>Is server.js running?</div>`;
    return;
  }
  renderTabs();
  wireChrome();

  const last = store.read().lastFeed;
  const startFeed = state.feeds.find((f) => f.id === last) || state.feeds[0];
  await selectFeed(startFeed.id);
})();

/* ── Tabs ───────────────────────────────────────────────────────── */
function renderTabs() {
  dom.tabbar.replaceChildren(...state.feeds.map((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.dataset.feed = f.id;
    b.setAttribute('role', 'tab');
    b.innerHTML = `<span class="tab__icon">${f.kind === 'metro' ? metroIcon() : busIcon()}</span><span class="tab__label">${f.name}</span>`;
    b.addEventListener('click', () => selectFeed(f.id));
    return b;
  }));
}

async function selectFeed(feedId) {
  state.feedId = feedId;
  state.lineRoutes = null;
  store.write({ lastFeed: feedId });
  for (const b of dom.tabbar.children) b.setAttribute('aria-selected', String(b.dataset.feed === feedId));

  const feed = state.feeds.find((f) => f.id === feedId);
  document.body.dataset.kind = feed.kind;

  // Buses get the mode switch; metro keeps the simple line-diagram flow.
  dom.modes.hidden = feed.kind === 'metro';
  state.mode = feed.kind === 'metro' ? 'name' : (store.feedState(feedId).mode || 'name');

  try {
    state.cfg = await api.config(feedId);
  } catch {
    dom.board.innerHTML = `<div class="board__empty"><strong>Couldn't load ${feed.name}</strong></div>`;
    return;
  }
  state.stopsById = new Map(state.cfg.stops.map((s) => [s.id, s]));

  // Restore last stop for this feed, else default, else first.
  const fs = store.feedState(feedId);
  let stopId = fs.stopId && state.stopsById.has(fs.stopId) ? fs.stopId
    : (state.cfg.default_stop && state.stopsById.has(state.cfg.default_stop) ? state.cfg.default_stop
    : state.cfg.stops[0]?.id);

  if (!stopId) {
    dom.board.innerHTML = `<div class="board__empty"><strong>No stops in this network</strong></div>`;
    dom.stopName.textContent = '—';
    return;
  }
  selectStop(stopId, fs.directionId, { fromFeedSwitch: true });
}

/* ── Stop selection ─────────────────────────────────────────────── */
function selectStop(stopId, directionId, opts = {}) {
  const stop = state.stopsById.get(stopId);
  if (!stop) return;
  state.stopId = stopId;
  state.directionId = stop.directions.some((d) => d.id === directionId)
    ? directionId : stop.directions[0].id;

  store.saveFeed(state.feedId, { stopId: state.stopId, directionId: state.directionId });
  store.pushRecent(state.feedId, stopId);

  dom.stopName.textContent = stop.name;
  dom.stopEyebrow.textContent = state.feeds.find((f) => f.id === state.feedId).kind === 'metro' ? 'Station' : 'Stop';
  closeChooser();
  renderDiagram();
  load();
}

/* ── Chooser open/close + modes ─────────────────────────────────── */
function wireChrome() {
  dom.stopButton.addEventListener('click', () => dom.stopPanel.hidden ? openChooser() : closeChooser());
  dom.refresh.addEventListener('click', load);
  document.addEventListener('click', (e) => {
    if (!dom.stopPanel.hidden && !e.target.closest('.chooser')) closeChooser();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChooser(); });

  dom.stopSearch.addEventListener('input', () => renderNameList(dom.stopSearch.value));
  dom.lineSearch.addEventListener('input', () => renderLineGrid(dom.lineSearch.value));
  dom.nearCta.addEventListener('click', useLocation);

  dom.modeName.addEventListener('click', () => setMode('name'));
  dom.modeLine.addEventListener('click', () => setMode('line'));
  dom.modeNear.addEventListener('click', () => setMode('near'));

  setInterval(() => { renderBoard(); stamp(); }, 5000);
  setInterval(load, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
}

function openChooser() {
  dom.stopPanel.hidden = false;
  dom.stopButton.setAttribute('aria-expanded', 'true');
  applyMode();
}
function closeChooser() {
  dom.stopPanel.hidden = true;
  dom.stopButton.setAttribute('aria-expanded', 'false');
}

function setMode(mode) {
  state.mode = mode;
  store.saveFeed(state.feedId, { mode });
  applyMode();
}

function applyMode() {
  const m = state.mode;
  for (const [btn, name] of [[dom.modeName,'name'],[dom.modeLine,'line'],[dom.modeNear,'near']]) {
    btn.setAttribute('aria-selected', String(name === m));
  }
  dom.findName.hidden = m !== 'name';
  dom.findLine.hidden = m !== 'line';
  dom.findNear.hidden = m !== 'near';

  if (m === 'name') { dom.stopSearch.value = ''; renderNameList(''); renderRecents(); dom.stopSearch.focus(); }
  if (m === 'line') { dom.lineSearch.value = ''; dom.lineStopList.hidden = true; renderLineGrid(''); }
  if (m === 'near') { dom.nearList.replaceChildren(); dom.nearNote.textContent = ''; }
}

/* ── Mode: name search ──────────────────────────────────────────── */
function renderRecents() {
  const recents = (store.feedState(state.feedId).recents || [])
    .filter((id) => state.stopsById.has(id) && id !== state.stopId);
  dom.stopRecents.replaceChildren(...recents.map((id) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = state.stopsById.get(id).name;
    b.addEventListener('click', () => selectStop(id, state.directionId));
    return b;
  }));
}

function renderNameList(query) {
  const q = fold(query.trim());
  let matches = state.cfg.stops;
  if (q) matches = matches.filter((s) => fold(s.name).includes(q));
  matches = matches.slice(0, 80); // bus networks are large; cap the DOM

  if (!matches.length) {
    dom.stopList.innerHTML = `<li class="chooser__none">No stop matches “${query}”</li>`;
    return;
  }
  dom.stopList.replaceChildren(...matches.map((stop) => stopRow(stop)));
}

function stopRow(stop, extra = '') {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chooser__item';
  b.setAttribute('role', 'option');
  b.setAttribute('aria-selected', String(stop.id === state.stopId));
  const dots = stop.lines.slice(0, 8)
    .map((l) => `<span class="dot" style="--c:${LINE_COLORS()[l] || ''}"></span>`).join('');
  b.innerHTML = `<span class="chooser__itemname">${stop.name}</span>${extra}<span class="chooser__dots">${dots}</span>`;
  b.addEventListener('click', () => selectStop(stop.id, state.directionId));
  li.append(b);
  return li;
}

/* ── Mode: line-first ───────────────────────────────────────────── */
async function renderLineGrid(query) {
  if (!state.lineRoutes) {
    try { state.lineRoutes = (await api.routes(state.feedId)).routes; }
    catch { dom.lineGrid.innerHTML = `<div class="chooser__none">Couldn't load lines</div>`; return; }
  }
  dom.lineStopList.hidden = true;
  const q = fold(query.trim());
  const routes = q ? state.lineRoutes.filter((r) => fold(r.short).includes(q)) : state.lineRoutes;

  dom.lineGrid.replaceChildren(...routes.slice(0, 60).map((r) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'linebadge';
    b.style.setProperty('--c', r.color); b.style.setProperty('--t', r.text);
    b.textContent = r.short;
    b.title = r.long || r.short;
    b.addEventListener('click', () => showLineStops(r));
    return b;
  }));
}

async function showLineStops(route) {
  dom.lineGrid.replaceChildren();
  dom.lineStopList.hidden = false;
  dom.lineStopList.innerHTML = `<li class="chooser__none">Loading stops on ${route.short}…</li>`;
  let stops = [];
  try { stops = (await api.routeStops(state.feedId, route.id)).stops; }
  catch { dom.lineStopList.innerHTML = `<li class="chooser__none">Couldn't load stops</li>`; return; }

  const header = document.createElement('li');
  header.className = 'lineback';
  header.innerHTML = `<button type="button" class="lineback__btn">← Lines</button>
    <span class="lineback__title" style="--c:${route.color};--t:${route.text}">${route.short}</span>`;
  header.querySelector('button').addEventListener('click', () => { dom.lineSearch.value=''; renderLineGrid(''); });

  dom.lineStopList.replaceChildren(header, ...stops.map((s) => stopRow(s)));
}

/* ── Mode: near me ──────────────────────────────────────────────── */
function useLocation() {
  if (!navigator.geolocation) { dom.nearNote.textContent = 'Location not available on this device.'; return; }
  dom.nearNote.textContent = 'Locating…';
  dom.nearCta.disabled = true;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      try {
        const { stops } = await api.nearest(state.feedId, latitude.toFixed(6), longitude.toFixed(6));
        dom.nearNote.textContent = stops.length ? 'Nearest stops to you:' : 'No stops found nearby.';
        dom.nearList.replaceChildren(...stops.map((s) =>
          stopRow(s, `<span class="dist">${fmtDist(s.distance_m)}</span>`)));
      } catch { dom.nearNote.textContent = 'Could not fetch nearby stops.'; }
      finally { dom.nearCta.disabled = false; }
    },
    (err) => {
      dom.nearNote.textContent = err.code === 1
        ? 'Location permission denied.' : 'Could not get your location.';
      dom.nearCta.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}
function fmtDist(m) { return m < 1000 ? `${m} m` : `${(m/1000).toFixed(1)} km`; }

/* ── Direction diagram (metro-style; works for buses too) ───────── */
function renderDiagram() {
  const stop = state.stopsById.get(state.stopId);
  const [left, right] = stop.directions;

  const track = document.createElement('div');
  track.className = 'track';
  for (const line of stop.lines.slice(0, 8)) {
    const s = document.createElement('div');
    s.className = 'track__strand';
    s.style.background = LINE_COLORS()[line] || 'var(--hairline-firm)';
    track.append(s);
  }

  const here = document.createElement('div');
  here.className = 'here';
  here.innerHTML = `<div class="here__dot"></div><div class="here__label">${stop.name}</div>`;

  const ends = right
    ? [end(left, 'left'), here, end(right, 'right')]
    : [document.createElement('span'), here, end(left, 'right')];
  dom.diagram.replaceChildren(track, ...ends);
}

function end(direction, side) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `end end--${side}`;
  b.setAttribute('aria-pressed', String(direction.id === state.directionId));
  b.setAttribute('aria-label', `Towards ${direction.label}`);
  b.innerHTML = `
    <span class="end__cap"><svg class="end__arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12 5l7 7-7 7"/></svg></span>
    <span class="end__label">${direction.label}</span>
    ${direction.note ? `<span class="end__note">${direction.note}</span>` : ''}`;
  b.addEventListener('click', () => {
    state.directionId = direction.id;
    store.saveFeed(state.feedId, { directionId: direction.id });
    renderDiagram(); load();
  });
  return b;
}

/* ── Board ──────────────────────────────────────────────────────── */
let inflight = 0;
async function load() {
  const token = ++inflight;
  document.body.dataset.loading = 'true';
  dom.board.setAttribute('aria-busy', 'true');
  dom.refresh.dataset.spinning = 'true';
  try {
    const payload = await api.departures(state.feedId, state.stopId, state.directionId);
    if (token !== inflight) return;
    state.payload = payload; state.fetchedAt = Date.now();
    renderBoard(); stamp();
  } catch {
    dom.board.innerHTML = `<div class="board__empty"><strong>Couldn't load times</strong>Try refresh.</div>`;
  } finally {
    if (token === inflight) {
      document.body.dataset.loading = 'false';
      dom.board.setAttribute('aria-busy', 'false');
      dom.refresh.dataset.spinning = 'false';
    }
  }
}

function renderBoard() {
  const p = state.payload;
  if (!p) return;
  const live = p.departures
    .map((d) => ({ ...d, seconds_left: d.seconds_until - (Date.now() - state.fetchedAt) / 1000 }))
    .filter((d) => d.seconds_left > -30);

  if (!live.length) {
    dom.board.innerHTML = `<div class="board__empty"><strong>No departures right now</strong>Check back later.</div>`;
    return;
  }
  const [first, ...rest] = live;
  dom.board.replaceChildren(nextCard(first), ...rest.slice(0, 5).map(row));
}

function nextCard(d) {
  const div = document.createElement('article');
  div.className = 'next';
  div.style.setProperty('--line', d.color || 'var(--ink)');
  const mins = Math.floor(d.seconds_left / 60);
  div.innerHTML = `
    <span class="badge badge--lg" style="--line:${d.color};--txt:${d.text_color||'#fff'}">${d.line}</span>
    <div><div class="next__headsign">${d.headsign}</div><div class="next__time">${d.departure_time}</div></div>
    ${mins < 1 ? `<div class="next__due">Due</div>`
      : `<div class="next__count"><span class="next__min">${mins}</span><span class="next__unit">min</span></div>`}`;
  return div;
}

function row(d) {
  const div = document.createElement('article');
  div.className = 'row';
  const mins = Math.max(0, Math.floor(d.seconds_left / 60));
  div.innerHTML = `
    <span class="badge" style="--line:${d.color};--txt:${d.text_color||'#fff'}">${d.line}</span>
    <div><div class="row__headsign">${d.headsign}</div><div class="row__time">${d.departure_time}</div></div>
    <div class="row__count">${mins}<span>min</span></div>`;
  return div;
}

function stamp() {
  if (!state.fetchedAt) return;
  const age = Math.round((Date.now() - state.fetchedAt) / 1000);
  const when = age < 10 ? 'just now' : `${age}s ago`;
  if (state.payload?.stale) {
    const u = state.payload.feed_valid_until;
    const pretty = u ? `${u.slice(6,8)}/${u.slice(4,6)}/${u.slice(0,4)}` : '';
    dom.stamp.textContent = `⚠ Timetable expired ${pretty} — showing last known schedule`;
    dom.stamp.dataset.stale = 'true';
  } else {
    dom.stamp.textContent = `Timetable · updated ${when}`;
    dom.stamp.dataset.stale = 'false';
  }
}

/* ── Icons ──────────────────────────────────────────────────────── */
function metroIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C7 2 4 3 4 7v7a3 3 0 0 0 3 3l-1.5 2.5h2L9 19h6l1.5 2.5h2L17 17a3 3 0 0 0 3-3V7c0-4-3-5-8-5Zm-5 13a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm10 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm1-6H6V7h12Z"/></svg>`;
}
function busIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6c0-2 2-3 8-3s8 1 8 3v9a2 2 0 0 1-1 1.7V18a1 1 0 0 1-2 0v-1H7v1a1 1 0 0 1-2 0v-1.3A2 2 0 0 1 4 15Zm3 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm1-5V7H6v5Z"/></svg>`;
}
