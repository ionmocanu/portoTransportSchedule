import { STOPS, LINE_COLORS, HOLIDAYS, FEED_VALID_UNTIL, init, getDepartures, getFare } from './data.js';
import { initI18n, setLang, getLang, t, LANGS } from './i18n.js';


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
  lineDots: document.getElementById('line-dots'),
  lineFilter: document.getElementById('line-filter'),
  lineFilterLabel: document.getElementById('line-filter-label'),
  lineFilterClear: document.getElementById('line-filter-clear'),
  board: document.getElementById('board'),
  stamp: document.getElementById('stamp'),
  feedValidity: document.getElementById('feed-validity'),
  fareFrom: document.getElementById('fare-from'),
  fareTo: document.getElementById('fare-to'),
  fareResult: document.getElementById('fare-result'),
  langSwitch: document.getElementById('lang-switch'),
  refresh: document.getElementById('refresh'),
  clockDisplay: document.getElementById('clock-display'),
  holidayWarning: document.getElementById('holiday-warning'),
};

const state = { stopId: null, directionId: null, lineFilter: null, payload: null, fetchedAt: null, fareFromTouched: false };

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

function parkingIconHtml(stop) {
  if (!stop.parking?.hasParking) return '';
  const src = stop.parking.free ? './images/parking_free.svg' : './images/parking_paid.svg';
  const alt = t(stop.parking.free ? 'parking.free' : 'parking.paid');
  return `<img class="parking-icon" src="${src}" alt="${alt}" title="${alt}">`;
}

function selectStop(stopId, directionId) {
  const stop = STOPS[stopId];
  state.stopId = stopId;
  state.directionId = stop.directions.some((d) => d.id === directionId)
    ? directionId
    : stop.directions[0].id;
  state.lineFilter = null;

  remember.write({ stopId: state.stopId, directionId: state.directionId });
  remember.pushRecent(state.stopId);
  el.stopName.innerHTML = `${stop.name}${parkingIconHtml(stop)}`;
  closeChooser();
  renderDiagram();
  renderLineControls();
  load();
  syncFareFrom(state.stopId);
}

function selectDirection(directionId) {
  if (directionId !== state.directionId) state.lineFilter = null;
  state.directionId = directionId;
  remember.write({ directionId });
  renderDiagram();
  renderLineControls();
  load();
}

function selectLine(routeId, directionId) {
  const directionChanged = directionId !== state.directionId;
  state.directionId = directionId;
  state.lineFilter = routeId;
  remember.write({ directionId });
  renderDiagram();
  renderLineControls();
  if (directionChanged) load();
  else renderBoard();
}

function clearLineFilter() {
  state.lineFilter = null;
  renderDiagram();
  renderLineControls();
  renderBoard();
}

function renderLineFilter() {
  if (!el.lineFilter) return;
  if (!state.lineFilter) {
    el.lineFilter.hidden = true;
    return;
  }
  const stop = STOPS[state.stopId];
  const direction = stop.directions.find((d) => d.id === state.directionId);
  const line = direction?.lines.find((l) => l.route === state.lineFilter);
  el.lineFilterLabel.innerHTML = line
    ? `<span class="dirpill__badge" style="background:${line.color}">${line.short}</span>`
    : '';
  el.lineFilter.hidden = false;
}

function renderLineControls() {
  renderLineFilter();
  renderLineDots();
}

/* Big, thumb-friendly line-color dots above the board — the easy tap
   target for filtering on a phone (the pills inside the direction card
   are small). Shown only when the current direction has more than one line. */
function renderLineDots() {
  if (!el.lineDots) return;
  const stop = STOPS[state.stopId];
  const direction = stop?.directions.find((d) => d.id === state.directionId);
  const lines = direction?.lines || [];

  if (lines.length < 2) {
    el.lineDots.hidden = true;
    el.lineDots.replaceChildren();
    return;
  }

  el.lineDots.replaceChildren(
    ...lines.map((l) => {
      const isActive = l.route === state.lineFilter;
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'linedot' + (isActive ? ' linedot--active' : '');
      dot.style.setProperty('--c', l.color);
      dot.textContent = l.short;
      dot.setAttribute('aria-pressed', String(isActive));
      dot.setAttribute('aria-label', t('line.filterAria', { line: l.short, headsign: l.headsign }));
      dot.addEventListener('click', () => {
        isActive ? clearLineFilter() : selectLine(l.route, direction.id);
      });
      return dot;
    })
  );
  el.lineDots.hidden = false;
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
    el.stopList.innerHTML = `<li class="chooser__none">${t('station.none', { query })}</li>`;
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
      b.innerHTML = `<span class="chooser__itemname">${stop.name}${parkingIconHtml(stop)}</span><span class="chooser__dots">${dots}</span>`;
      b.addEventListener('click', () => selectStop(stop.id, state.directionId));
      li.append(b);
      return li;
    })
  );
}

/* ── Direction picker ───────────────────────────────────────────── */
function renderDiagram() {
  const stop = STOPS[state.stopId];

  el.diagram.replaceChildren(
    ...stop.directions.map((dir) => dirCard(dir, stop.directions.length))
  );
}

function dirCard(direction, total) {
  const isLeft = direction.id === '1'; // toward city = left arrow
  const active = direction.id === state.directionId;

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'dircard' + (active ? ' dircard--active' : '');
  card.setAttribute('aria-pressed', String(active));
  card.setAttribute('aria-label', t('direction.aria', { label: direction.label }));
  if (total === 1) card.classList.add('dircard--full');

  const arrow = isLeft
    ? `<svg class="dircard__arrow" viewBox="0 0 24 24"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>`
    : `<svg class="dircard__arrow" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;

  card.innerHTML = `
    <div class="dircard__top">
      ${arrow}
      <span class="dircard__label">${direction.label}</span>
    </div>
    <div class="dircard__lines"></div>`;

  const linesEl = card.querySelector('.dircard__lines');
  linesEl.append(...(direction.lines || []).map((l) => linePill(l, direction.id)));

  card.addEventListener('click', () => selectDirection(direction.id));
  return card;
}

function linePill(l, directionId) {
  const isActive = l.route === state.lineFilter && directionId === state.directionId;
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'dirpill' + (isActive ? ' dirpill--active' : '');
  pill.setAttribute('aria-pressed', String(isActive));
  pill.setAttribute('aria-label', t('line.filterAria', { line: l.short, headsign: l.headsign }));
  pill.innerHTML = `
    <span class="dirpill__badge" style="background:${l.color}">${l.short}</span>
    <span class="dirpill__dest">${l.headsign}</span>`;
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    isActive ? clearLineFilter() : selectLine(l.route, directionId);
  });
  return pill;
}

/* ── Board ──────────────────────────────────────────────────────── */
function renderBoard() {
  const { payload } = state;
  if (!payload) return;

  const live = payload.departures
    .filter((d) => !state.lineFilter || d.route_id === state.lineFilter)
    .map((d) => ({ ...d, seconds_left: secondsLeft(d) }))
    .filter((d) => d.seconds_left > -30);

  if (!live.length) {
    el.board.innerHTML =
      `<div class="board__empty"><strong>${t('board.empty.title')}</strong>${t('board.empty.body')}</div>`;
    return;
  }

  const maxTotal = state.lineFilter ? 5 : 6;
  const [first, ...rest] = live;
  el.board.replaceChildren(nextCard(first), ...rest.slice(0, maxTotal - 1).map(row));
}

function lastTagHtml(d) {
  return d.is_last ? `<span class="last-tag">${t('board.last')}</span>` : '';
}

function nextCard(d) {
  const div = document.createElement('article');
  div.className = 'next';
  div.style.setProperty('--line', LINE_COLORS[d.route_id] || 'var(--ink)');
  const mins = Math.floor(d.seconds_left / 60);
  div.innerHTML = `
    <span class="badge badge--lg">${d.line}</span>
    <div>
      <div class="next__headsign">${d.headsign}${lastTagHtml(d)}</div>
      <div class="next__time">${d.departure_time}</div>
    </div>
    ${mins < 1
      ? `<div class="next__due">${t('board.due')}</div>`
      : `<div class="next__count"><span class="next__min">${mins}</span><span class="next__unit">${t('board.min')}</span></div>`
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
      <div class="row__headsign">${d.headsign}${lastTagHtml(d)}</div>
      <div class="row__time">${d.departure_time}</div>
    </div>
    <div class="row__count">${mins}<span>${t('board.min')}</span></div>`;
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
      `<div class="board__empty"><strong>${t('board.error.title')}</strong>${t('board.error.body')}</div>`;
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
  const when = age < 10 ? t('stamp.justNow') : t('stamp.secondsAgo', { age });
  if (state.payload?.stale) {
    const until = state.payload.feed_valid_until;
    const pretty = until
      ? `${until.slice(6, 8)}/${until.slice(4, 6)}/${until.slice(0, 4)}`
      : '';
    el.stamp.textContent = t('stamp.stale', { date: pretty });
    el.stamp.dataset.stale = 'true';
  } else {
    el.stamp.textContent = t('stamp.updated', { when });
    el.stamp.dataset.stale = 'false';
  }
}

const DEFAULT_FARE_TO = '5726'; // Trindade — the most central stop

/* ── Fare calculator ────────────────────────────────────────────── */
function initFareCalculator() {
  if (!el.fareFrom || !el.fareTo) return;

  const stops = Object.values(STOPS).sort((a, b) => a.name.localeCompare(b.name, 'pt'));
  const options = stops.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  el.fareFrom.innerHTML = options;
  el.fareTo.innerHTML = options;

  el.fareFrom.value = state.stopId || stops[0]?.id;
  el.fareTo.value = STOPS[DEFAULT_FARE_TO] && DEFAULT_FARE_TO !== el.fareFrom.value
    ? DEFAULT_FARE_TO
    : stops.find((s) => s.id !== el.fareFrom.value)?.id || stops[0]?.id;

  el.fareFrom.addEventListener('change', () => {
    state.fareFromTouched = true;
    loadFare();
  });
  el.fareTo.addEventListener('change', loadFare);
  loadFare();
}

/* Keeps the fare "from" in sync with the main stop selector, unless the
   user has manually changed it — then it stops following. */
function syncFareFrom(stopId) {
  if (!el.fareFrom || state.fareFromTouched) return;
  if (el.fareFrom.value === stopId) return;
  el.fareFrom.value = stopId;
  loadFare();
}

async function loadFare() {
  const from = el.fareFrom.value;
  const to = el.fareTo.value;
  if (!from || !to) return;

  try {
    const fare = await getFare(from, to);
    el.fareResult.innerHTML = fare.fares
      .map((f) => `
        <div class="fare__option">
          <span class="fare__price">€${f.price.toFixed(2)}</span>
          ${f.route_name ? `<span class="fare__line">${t('fare.via', { line: f.route_name })}</span>` : ''}
        </div>`)
      .join('');
  } catch (err) {
    console.error(err);
    el.fareResult.innerHTML = `<span class="fare__error">${t('fare.error')}</span>`;
  }
}

function renderFeedValidity() {
  if (!FEED_VALID_UNTIL || !el.feedValidity) return;
  const until = FEED_VALID_UNTIL;
  const pretty = `${until.slice(6, 8)}/${until.slice(4, 6)}/${until.slice(0, 4)}`;
  el.feedValidity.textContent = t('feed.validUntil', { date: pretty });
}

/* ── Clock & Holiday Logic ──────────────────────────────────────── */

function updateClock() {
  const now = new Date();

  const locale = getLang() === 'pt' ? 'pt-PT' : 'en-US';
  const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const dateString = now.toLocaleDateString(locale, dateOptions);
  const timeString = now.toLocaleTimeString(locale);

  el.clockDisplay.textContent = `${dateString} • ${timeString}`;

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayKey = `${yyyy}-${mm}-${dd}`;

  // This now checks against the dynamically loaded GTFS data!
  if (HOLIDAYS.includes(todayKey)) {
    el.holidayWarning.hidden = false;
  } else {
    el.holidayWarning.hidden = true;
  }
}

/* ── Language switcher ─────────────────────────────────────────── */
function renderLangSwitch() {
  if (!el.langSwitch) return;
  el.langSwitch.replaceChildren(
    ...LANGS.map(({ code, label }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lang-switch__btn';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(code === getLang()));
      b.addEventListener('click', () => switchLang(code));
      return b;
    })
  );
}

async function switchLang(code) {
  if (code === getLang()) return;
  await setLang(code);
  renderLangSwitch();
  refreshUI();
}

/* Re-render everything that has translated text baked into it. */
function refreshUI() {
  updateClock();
  if (state.stopId) {
    const stop = STOPS[state.stopId];
    el.stopName.innerHTML = `${stop.name}${parkingIconHtml(stop)}`;
    renderDiagram();
  }
  if (!el.stopPanel.hidden) {
    renderStopList(el.stopSearch.value);
    renderRecents();
  }
  renderLineControls();
  renderBoard();
  stamp();
  renderFeedValidity();
  if (el.fareFrom.value && el.fareTo.value) loadFare();
}

/* ── Boot ───────────────────────────────────────────────────────── */
el.refresh.addEventListener('click', load);
el.lineFilterClear?.addEventListener('click', clearLineFilter);

// Start the clock and update it every 1 second (1000ms)
updateClock();
setInterval(updateClock, 1000);

setInterval(() => { renderBoard(); stamp(); }, TICK_MS);
setInterval(load, REFETCH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

(async () => {
  await initI18n();
  renderLangSwitch();

  try {
    await init();
  } catch (err) {
    console.error(err);
    el.board.innerHTML =
      `<div class="board__empty"><strong>${t('boot.error.title')}</strong>${t('boot.error.body')}</div>`;
    return;
  }

  renderFeedValidity();
  initFareCalculator();

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
