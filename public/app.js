import { STOPS, LINE_COLORS, init, getDepartures } from './data.js';

const fetchDepartures = getDepartures;

const REFETCH_MS = 60_000;
const TICK_MS = 5_000;

const el = {
  stopButton: document.getElementById('stop-button'),
  stopName: document.getElementById('stop-name'),
  stopPanel: document.getElementById('stop-panel'),
  stopSearch: document.getElementById('stop-search'),
  stopRecents: document.getElementById('stop-recents'),
  stopList: document.getElementById('stop-list'),
  diagram: document.getElementById('diagram'),
  board: document.getElementById('board'),
  stamp: document.getElementById('stamp'),
  refresh: document.getElementById('refresh'),
};

const state = { stopId: null, directionId: null, payload: null, fetchedAt: null };

const remember = {
  read() {
    try { return JSON.parse(localStorage.getItem('proximo') || 'null'); }
    catch { return null; }
  },
  write(patch) {
    try {
      const cur = this.read() || {};
      localStorage.setItem('proximo', JSON.stringify({ ...cur, ...patch }));
    } catch { /* fine */ }
  },
  pushRecent(stopId) {
    const cur = this.read() || {};
    const recents = [stopId, ...(cur.recents || []).filter((id) => id !== stopId)].slice(0, 4);
    this.write({ recents });
    return recents;
  },
};

function selectStop(stopId, directionId) {
  const stop = STOPS[stopId];
  state.stopId = stopId;
  state.directionId = stop.directions.some((d) => d.id === directionId)
    ? directionId
    : stop.directions[0].id;

  remember.write({ stopId: state.stopId, directionId: state.directionId });
  remember.pushRecent(state.stopId);
  el.stopName.textContent = stop.name;
  closeChooser();
  renderDiagram();
  load();
}

function selectDirection(directionId) {
  state.directionId = directionId;
  remember.write({ directionId });
  renderDiagram();
  load();
}

/* ── Stop chooser ───────────────────────────────────────────────── */
function openChooser() {
  el.stopPanel.hidden = false;
  el.stopButton.setAttribute('aria-expanded', 'true');
  el.stopSearch.value = '';
  renderStopList('');
  renderRecents();
  el.stopSearch.focus();
}

function closeChooser() {
  el.stopPanel.hidden = true;
  el.stopButton.setAttribute('aria-expanded', 'false');
}

function renderRecents() {
  const recents = (remember.read()?.recents || []).filter(
    (id) => STOPS[id] && id !== state.stopId
  );
  el.stopRecents.replaceChildren(
    ...recents.map((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = STOPS[id].name;
      b.addEventListener('click', () => selectStop(id, state.directionId));
      return b;
    })
  );
}

const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function renderStopList(query) {
  const q = fold(query.trim());
  const matches = Object.values(STOPS).filter((s) => !q || fold(s.name).includes(q));

  if (!matches.length) {
    el.stopList.innerHTML = `<li class="chooser__none">No stop matches “${query}”</li>`;
    return;
  }

  el.stopList.replaceChildren(
    ...matches.map((stop) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chooser__item';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(stop.id === state.stopId));
      const dots = stop.lines
        .map((l) => `<span class="dot" style="--c:${LINE_COLORS[l] || ''}"></span>`)
        .join('');
      b.innerHTML = `<span>${stop.name}</span><span class="chooser__dots">${dots}</span>`;
      b.addEventListener('click', () => selectStop(stop.id, state.directionId));
      li.append(b);
      return li;
    })
  );
}

/* ── Direction diagram ──────────────────────────────────────────── */
function renderDiagram() {
  const stop = STOPS[state.stopId];
  const [left, right] = stop.directions;

  const track = document.createElement('div');
  track.className = 'track';
  for (const line of stop.lines) {
    const s = document.createElement('div');
    s.className = 'track__strand';
    s.style.background = LINE_COLORS[line] || 'var(--hairline-firm)';
    track.append(s);
  }

  const here = document.createElement('div');
  here.className = 'here';
  here.innerHTML = `<div class="here__dot"></div><div class="here__label">${stop.name}</div>`;

  const ends = right
    ? [end(left, 'left'), here, end(right, 'right')]
    : [document.createElement('span'), here, end(left, 'right')];
  el.diagram.replaceChildren(track, ...ends);
}

function end(direction, side) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `end end--${side}`;
  b.setAttribute('aria-pressed', String(direction.id === state.directionId));
  b.setAttribute('aria-label', `Show metros towards ${direction.label}`);
  b.innerHTML = `
    <span class="end__cap">
      <svg class="end__arrow" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12h13M12 5l7 7-7 7"/>
      </svg>
    </span>
    <span class="end__label">${direction.label}</span>
    ${direction.note ? `<span class="end__note">${direction.note}</span>` : ''}`;
  b.addEventListener('click', () => selectDirection(direction.id));
  return b;
}

/* ── Board ──────────────────────────────────────────────────────── */
function renderBoard() {
  const { payload } = state;
  if (!payload) return;

  const live = payload.departures
    .map((d) => ({ ...d, seconds_left: secondsLeft(d) }))
    .filter((d) => d.seconds_left > -30);

  if (!live.length) {
    el.board.innerHTML =
      `<div class="board__empty"><strong>No metros right now</strong>Service runs about 06:00–01:00.</div>`;
    return;
  }

  const [first, ...rest] = live;
  el.board.replaceChildren(nextCard(first), ...rest.slice(0, 5).map(row));
}

function nextCard(d) {
  const div = document.createElement('article');
  div.className = 'next';
  div.style.setProperty('--line', LINE_COLORS[d.route_id] || 'var(--ink)');
  const mins = Math.floor(d.seconds_left / 60);
  div.innerHTML = `
    <span class="badge badge--lg">${d.line}</span>
    <div>
      <div class="next__headsign">${d.headsign}</div>
      <div class="next__time">${d.departure_time}</div>
    </div>
    ${
      mins < 1
        ? `<div class="next__due">Due</div>`
        : `<div class="next__count"><span class="next__min">${mins}</span><span class="next__unit">min</span></div>`
    }`;
  return div;
}

function row(d) {
  const div = document.createElement('article');
  div.className = 'row';
  const mins = Math.max(0, Math.floor(d.seconds_left / 60));
  div.innerHTML = `
    <span class="badge" style="--line:${LINE_COLORS[d.route_id] || 'var(--ink)'}">${d.line}</span>
    <div>
      <div class="row__headsign">${d.headsign}</div>
      <div class="row__time">${d.departure_time}</div>
    </div>
    <div class="row__count">${mins}<span>min</span></div>`;
  return div;
}

function secondsLeft(d) {
  const elapsed = (Date.now() - state.fetchedAt) / 1000;
  return d.seconds_until - elapsed;
}

/* ── Load ───────────────────────────────────────────────────────── */
let inflight = 0;

async function load() {
  const token = ++inflight;
  document.body.dataset.loading = 'true';
  el.board.setAttribute('aria-busy', 'true');
  el.refresh.dataset.spinning = 'true';

  try {
    const payload = await fetchDepartures(state.stopId, state.directionId);
    if (token !== inflight) return;
    state.payload = payload;
    state.fetchedAt = Date.now();
    renderBoard();
    stamp();
  } catch (err) {
    console.error(err);
    el.board.innerHTML =
      `<div class="board__empty"><strong>Couldn't load times</strong>Check the connection and try refresh.</div>`;
  } finally {
    if (token === inflight) {
      document.body.dataset.loading = 'false';
      el.board.setAttribute('aria-busy', 'false');
      el.refresh.dataset.spinning = 'false';
    }
  }
}

function stamp() {
  if (!state.fetchedAt) return;
  const age = Math.round((Date.now() - state.fetchedAt) / 1000);
  const when = age < 10 ? 'just now' : `${age}s ago`;
  if (state.payload?.stale) {
    const until = state.payload.feed_valid_until;
    const pretty = until
      ? `${until.slice(6, 8)}/${until.slice(4, 6)}/${until.slice(0, 4)}`
      : '';
    el.stamp.textContent = `⚠ Timetable expired ${pretty} — showing last known schedule`;
    el.stamp.dataset.stale = 'true';
  } else {
    el.stamp.textContent = `Timetable · updated ${when}`;
    el.stamp.dataset.stale = 'false';
  }
}

/* ── Boot ───────────────────────────────────────────────────────── */
el.refresh.addEventListener('click', load);

setInterval(() => { renderBoard(); stamp(); }, TICK_MS);
setInterval(load, REFETCH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

(async () => {
  try {
    await init();
  } catch (err) {
    console.error(err);
    el.board.innerHTML =
      `<div class="board__empty"><strong>Couldn't reach the server</strong>Is server.js running?</div>`;
    return;
  }

  el.stopButton.addEventListener('click', () =>
    el.stopPanel.hidden ? openChooser() : closeChooser()
  );
  el.stopSearch.addEventListener('input', () => renderStopList(el.stopSearch.value));
  document.addEventListener('click', (e) => {
    if (!el.stopPanel.hidden && !e.target.closest('.chooser')) closeChooser();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeChooser();
  });

  const saved = remember.read();
  const legacy = { viso: '5729', forum_maia: '5760' };
  let startId = saved?.stopId;
  if (startId && !STOPS[startId]) startId = legacy[startId];
  if (!startId || !STOPS[startId]) startId = window.DEFAULT_STOP;
  selectStop(startId, saved?.directionId);
})();
