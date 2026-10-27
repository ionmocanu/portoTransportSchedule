/*
 * map.js — map of the whole network in the style of Metro do Porto's own:
 * each stretch of track is one smooth hand-drawn curve (traced from the
 * official map, not the stations' exact coordinates), stations sit evenly
 * along it, and lines sharing a stretch run side by side in fixed lanes
 * that follow the same curve. Which lines run where comes from /api/lines.
 * Drag to pan, pinch or scroll to zoom; tap a station to open its
 * departures. B and Bx are one track (Bx = white centre stripe, dots where
 * it stops).
 */
import { t } from './i18n.js';

const W = 5;   // lane width, map units
// Lanes, to the right of each line's direction-0 travel. Every line that
// uses the main stretch runs it the same way in direction 0, so these give
// one fixed side-by-side order there.
const LANES = { C: 2, B: 1, E: 0, F: -1, A: -2, D: 0 };
const DRAWN = ['D', 'A', 'F', 'E', 'B', 'C']; // paint order

const LABEL_FONT = 9.5;      // keep in sync with .nm-label text
const CHAR_W = LABEL_FONT * 0.56;

/* ── Corridors ──────────────────────────────────────────────────────
   Each stretch between junctions: its stations in order, and the control
   points of its curve (in the official map's own proportions, ×SCALE).
   A curve starts and ends exactly on its first and last station, and the
   stations in between are spaced evenly along it. */
const SCALE = 2;
const CORRIDORS = [
  [['Verdes', 'Pedras Rubras', 'Lidador', 'Vilar do Pinheiro', 'Modivas Sul', 'Modivas Centro',
    'VC Fashion Outlet I Modivas', 'Mindelo', 'Espaço Natureza', 'Varziela', 'Árvore', 'Azurara',
    'Santa Clara', 'Vila do Conde', 'Alto de Pega', 'Portas Fronhas', 'São Brás', 'Póvoa de Varzim'],
  [[262, 385], [244, 352], [200, 295], [150, 240], [125, 212], [110, 178], [100, 135], [80, 95], [55, 52], [35, 8]]],
  [['Verdes', 'Botica', 'Aeroporto'],
    [[262, 385], [242, 383], [222, 371], [200, 364], [176, 361], [156, 360]]],
  [['Verdes', 'Crestins', 'Esposade', 'Custóias', 'Fonte do Cuco'],
    [[262, 385], [262, 450], [263, 520]]],
  [['Fonte do Cuco', 'Cândido dos Reis', 'Pias', 'Araújo', 'Custió', 'Parque Maia', 'Fórum Maia',
    'Zona Industrial', 'Mandim', 'Castêlo da Maia', 'ISMAI'],
  [[263, 520], [285, 496], [330, 480], [365, 465], [385, 440], [395, 410], [410, 385], [428, 360], [440, 338], [448, 318]]],
  [['Fonte do Cuco', 'Senhora da Hora'],
    [[263, 520], [264, 548]]],
  [['Senhora da Hora', 'Vasco da Gama', 'Estádio do Mar', 'Pedro Hispano', 'Parque de Real',
    'Câmara Matosinhos', 'Matosinhos Sul', 'Brito Capelo', 'Mercado', 'Senhor de Matosinhos'],
  [[264, 548], [258, 528], [244, 519], [231, 530], [228, 560], [221, 592], [200, 613], [165, 613],
    [125, 612], [103, 595], [105, 565], [123, 548], [142, 540]]],
  [['Senhora da Hora', 'NorteShopping I Sete Bicas', 'Viso', 'Ramalde', 'Francos', 'Casa da Música',
    'Carolina Michaelis', 'Lapa', 'Trindade'],
  [[264, 548], [268, 585], [282, 625], [305, 655], [335, 685], [360, 712], [380, 750]]],
  [['Trindade', 'Bolhão', '24 de Agosto', 'Heroísmo', 'Campanhã'],
    [[380, 750], [410, 772], [445, 792], [475, 803], [505, 800], [522, 788]]],
  [['Campanhã', 'Estádio do Dragão'],
    [[522, 788], [534, 760], [538, 735]]],
  [['Estádio do Dragão', 'Contumil', 'Nasoni', 'Nau Vitória', 'Levada', 'Rio Tinto', 'Campainha',
    'Baguim', 'Carreira', 'Venda Nova', 'Fânzeres'],
  [[538, 735], [548, 702], [578, 665], [612, 632], [640, 603], [665, 582], [690, 572], [708, 588], [713, 618], [700, 645]]],
  [['Trindade', 'Faria Guimarães', 'Marquês', 'Combatentes', 'Salgueiros', 'Pólo Universitário', 'IPO',
    'Hospital São João'],
  [[380, 750], [408, 728], [435, 700], [455, 665], [462, 620], [458, 580], [478, 548]]],
  [['Trindade', 'Aliados', 'São Bento', 'Jardim do Morro', 'General Torres', 'Câmara Gaia', 'João de Deus',
    'D. João II', 'Santo Ovídio', 'Manuel Leão', 'Hospital Santos Silva', "Vila d'Este"],
  [[380, 750], [380, 772], [376, 800], [390, 838], [425, 865], [436, 900], [436, 945], [450, 978],
    [495, 1000], [518, 1030], [512, 1065], [501, 1082]]],
];

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── Geometry ───────────────────────────────────────────────────── */
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v) => Math.hypot(v.x, v.y) || 1;
const unit = (v) => ({ x: v.x / len(v), y: v.y / len(v) });
const rightOf = (a, b) => { const d = unit(sub(b, a)); return { x: -d.y, y: d.x }; };

// The polyline shifted `o` to the right of travel. Corners are mitred, but
// the miter is capped so a sharp turn can't throw a lane far off its track.
function offsetLine(pts, o) {
  return pts.map((p, i) => {
    const n1 = i > 0 ? rightOf(pts[i - 1], p) : null;
    const n2 = i < pts.length - 1 ? rightOf(p, pts[i + 1]) : null;
    if (!n1) return { ...p, x: p.x + n2.x * o, y: p.y + n2.y * o };
    if (!n2) return { ...p, x: p.x + n1.x * o, y: p.y + n1.y * o };
    const k = Math.max(0.6, 1 + n1.x * n2.x + n1.y * n2.y);
    return { ...p, x: p.x + (o * (n1.x + n2.x)) / k, y: p.y + (o * (n1.y + n2.y)) / k };
  });
}

// Points by distance along a polyline.
function alongPolyline(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
  return {
    length: cum.at(-1),
    point(d) {
      let i = 1;
      while (i < pts.length - 1 && cum[i] < d) i++;
      const a = pts[i - 1];
      const b = pts[i];
      const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    },
  };
}

// A corridor's curve (Catmull-Rom through its control points), resampled
// evenly so that station i sits exactly at sample i·step.
function sampleCorridor(ctrl, stations) {
  const pts = ctrl.map(([x, y]) => ({ x: x * SCALE, y: y * SCALE }));
  const dense = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    for (let k = 1; k <= 24; k++) {
      const u = k / 24;
      const v = 1 - u;
      dense.push({
        x: v * v * v * p1.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * p2.x,
        y: v * v * v * p1.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * p2.y,
      });
    }
  }
  const along = alongPolyline(dense);
  const step = Math.max(2, Math.ceil(along.length / (4 * (stations - 1)))); // samples per hop
  const n = (stations - 1) * step;
  const out = [];
  for (let k = 0; k <= n; k++) out.push(along.point((k * along.length) / n));
  return { pts: out, step };
}

/* Labels: each name tries right, left, above and below its station and
   takes the spot that overlaps the fewest names and lines already there. */
function boxesOverlap(a, b) {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function segHitsBox(p, q, b) {
  // Sample the segment; plenty for short map segments.
  for (let k = 0; k <= 8; k++) {
    const x = p.x + ((q.x - p.x) * k) / 8;
    const y = p.y + ((q.y - p.y) * k) / 8;
    if (x > b.x1 && x < b.x2 && y > b.y1 && y < b.y2) return true;
  }
  return false;
}

function placeLabels(stations, segments, taken = []) {
  const placed = [];
  const order = [...stations].sort((a, b) => b.served.length - a.served.length || a.r - b.r);
  for (const st of order) {
    const w = st.name.length * CHAR_W;
    const h = LABEL_FONT + 2;
    const g = st.half + 6;
    const cands = [
      { side: 'r', x1: st.x + g, y1: st.y - h / 2, cost: 0 },
      { side: 'l', x1: st.x - g - w, y1: st.y - h / 2, cost: 1 },
      { side: 'a', x1: st.x - w / 2, y1: st.y - g - h, cost: 2 },
      { side: 'b', x1: st.x - w / 2, y1: st.y + g, cost: 2 },
    ].map((c) => ({ ...c, x2: c.x1 + w, y2: c.y1 + h }));
    for (const c of cands) {
      for (const o of placed) if (boxesOverlap(c, o)) c.cost += 40;
      for (const o of taken) if (boxesOverlap(c, o)) c.cost += 100; // line badges never get covered
      for (const [p, q] of segments) if (segHitsBox(p, q, c)) c.cost += 12;
      for (const o of stations) if (o !== st && o.x > c.x1 - 4 && o.x < c.x2 + 4 && o.y > c.y1 - 4 && o.y < c.y2 + 4) c.cost += 25;
    }
    const best = cands.reduce((a, b) => (b.cost < a.cost ? b : a));
    placed.push(best);
    st.label = best;
  }
}

/* ── Build ──────────────────────────────────────────────────────── */
let ctx = null;   // { stops, onPick, getStopId }
let model = null; // { svg, bbox, stations, routes, meta }
const el = {};
const view = { s: 1, x: 0, y: 0, fit: 1 };
let focus = null;

export function initMap({ stops, onPick, getStopId }) {
  ctx = { stops, onPick, getStopId };
  el.open = document.getElementById('map-open');
  el.root = document.getElementById('netmap');
  el.close = document.getElementById('map-close');
  el.stage = document.getElementById('map-stage');
  el.chips = document.getElementById('map-chips');
  el.card = document.getElementById('map-card');
  if (!el.open || !el.root) return;
  el.open.addEventListener('click', openMap);
  el.close.addEventListener('click', () => history.state?.netmap ? history.back() : closeMap());
  window.addEventListener('popstate', () => { if (!el.root.hidden) closeMap(); });
  el.root.addEventListener('click', onClick);
  setupGestures();
  window.addEventListener('resize', () => { if (!el.root.hidden) fitView(); });
}

export function refreshMap() {
  if (!el.root || el.root.hidden || !model) return;
  renderChips();
  el.card.hidden = true;
}

async function openMap() {
  el.root.hidden = false;
  document.body.classList.add('is-mapping');
  history.pushState({ netmap: true }, '');
  if (!model) {
    try {
      const res = await fetch('/api/lines');
      if (!res.ok) throw new Error(`lines ${res.status}`);
      model = build(await res.json());
      el.stage.innerHTML = model.svg;
      el.svg = el.stage.querySelector('svg');
      el.world = el.svg.querySelector('.nm-world');
    } catch (err) {
      console.error(err);
      el.stage.innerHTML = `<p class="trip__note">${t('boot.error.title')}</p>`;
      return;
    }
  }
  renderChips();
  setFocus(focus);
  el.card.hidden = true;
  requestAnimationFrame(() => {
    fitView();
    // On a phone the whole network is too small to read: start zoomed in
    // on the station picked on the main screen, ringed. ⤢ shows it all.
    const here = model.stations.find((s) => s.id === ctx.getStopId?.());
    const ring = el.svg.querySelector('.nm-here');
    ring.setAttribute('cx', here ? here.x : -9999);
    ring.setAttribute('cy', here ? here.y : -9999);
    if (here && view.fit < READABLE) centerOn(here, READABLE);
  });
}

const READABLE = 1.1; // zoom at which 10 px labels read comfortably

function centerOn(pt, s) {
  view.s = s;
  view.x = el.stage.clientWidth / 2 - pt.x * s;
  view.y = el.stage.clientHeight / 2 - pt.y * s;
  applyView();
}

function closeMap() {
  el.root.hidden = true;
  document.body.classList.remove('is-mapping');
}

function build(lines) {
  const byName = new Map(Object.values(ctx.stops).map((s) => [fold(s.name), s.id]));
  const corridors = CORRIDORS.map(([names, ctrl]) => {
    const ids = names.map((n) => byName.get(fold(n)) ?? (console.warn(`map: no stop called "${n}"`), null));
    return { ids, ...sampleCorridor(ctrl, names.length) };
  });
  // The curve between two neighbouring stations, in travel order.
  const hop = (a, b) => {
    for (const c of corridors) {
      const i = c.ids.indexOf(a);
      const j = c.ids.indexOf(b);
      if (i < 0 || j < 0 || Math.abs(i - j) !== 1) continue;
      const seg = c.pts.slice(Math.min(i, j) * c.step, Math.max(i, j) * c.step + 1);
      return i < j ? seg : seg.reverse();
    }
    return null;
  };

  const meta = new Map(lines.map((l) => [l.route, l]));
  const bxStops = new Set(lines.filter((l) => l.route === 'Bexp').flatMap((l) => l.stops));
  const routes = DRAWN.filter((r) => lines.some((l) => l.route === r && l.dir === '0'));
  const segments = []; // drawn lane segments (thinned), for label placement
  const lanePts = new Map(); // stop id → [{ route, x, y }]
  const parts = [];
  const ends = [];

  for (const route of routes) {
    const line = lines.find((l) => l.route === route && l.dir === '0');
    // Stitch the line together hop by hop from its corridors; a hop with no
    // corridor (a renamed or new station) just leaves that stretch out.
    const pts = [];
    for (let i = 1; i < line.stops.length; i++) {
      const seg = hop(line.stops[i - 1], line.stops[i]);
      if (!seg) { console.warn(`map: no corridor for ${route} ${line.stops[i - 1]}→${line.stops[i]}`); continue; }
      if (!pts.length) pts.push({ ...seg[0], id: line.stops[i - 1] });
      seg.slice(1, -1).forEach((p) => pts.push({ ...p }));
      pts.push({ ...seg.at(-1), id: line.stops[i] });
    }
    if (pts.length < 2) continue;
    const off = offsetLine(pts, (LANES[route] ?? 0) * W);
    for (let i = 3; i < off.length; i += 3) segments.push([off[i - 3], off[i]]);
    for (const p of off) {
      if (!p.id) continue;
      if (!lanePts.has(p.id)) lanePts.set(p.id, []);
      lanePts.get(p.id).push({ route, x: p.x, y: p.y });
    }
    const color = meta.get(route)?.color || '#16305C';
    const d = `M${off.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L')}`;
    parts.push(`<g class="nm-route r-${route}"><path d="${d}" stroke="${color}" />${
      route === 'B' ? `<path class="nm-express" d="${d}" />` : ''}</g>`);
    // Line badges just past both ends (kept only at the end of a branch).
    for (const [a, b] of [[off[1], off[0]], [off.at(-2), off.at(-1)]]) {
      const dir = unit(sub(b, a));
      ends.push({ route, color, short: meta.get(route)?.short ?? route, stop: b.id, x: b.x + dir.x * 16, y: b.y + dir.y * 16 });
    }
  }
  const busy = (id) => new Set((lanePts.get(id) || []).map((a) => a.route)).size >= 3;
  const branchEnds = ends.filter((e) => !busy(e.stop));

  // Stations: a pill across every lane that stops there, else a dot.
  const stations = [];
  const marks = [];
  const labels = [];
  for (const [id, at] of lanePts) {
    const served = [...new Set(at.map((a) => a.route))];
    const cls = served.map((r) => `s-${r}`).join(' ');
    // The main stretch's pill leaves out D, which crosses Trindade on its own.
    const pill = at.filter((a) => a.route !== 'D' || at.length === 1);
    const ends2 = pill.reduce((best, a) => {
      for (const b of pill) {
        const dd = Math.hypot(a.x - b.x, a.y - b.y);
        if (dd >= best.d) best = { d: dd, a, b };
      }
      return best;
    }, { d: -1, a: pill[0], b: pill[0] });
    const { a: p1, b: p2 } = ends2;
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    const onlyB = served.length === 1 && served[0] === 'B';
    marks.push(`<g class="nm-stop ${cls}" data-stop="${id}">
      <line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" class="nm-stop-edge" />
      <line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" class="nm-stop-fill" />
      ${onlyB && bxStops.has(id) ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="1.4" class="nm-bx" />` : ''}
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="12" class="nm-hit" /></g>`);
    stations.push({
      id, served, cls, x: cx, y: cy,
      name: ctx.stops[id]?.name ?? id,
      half: Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2 + 3,
      r: Math.hypot(cx, cy), // distance from the centre: crowded ones get first pick
    });
  }
  placeLabels(stations, segments, branchEnds.map((e) => ({ x1: e.x - 10, y1: e.y - 10, x2: e.x + 10, y2: e.y + 10 })));
  for (const st of stations) {
    const b = st.label;
    labels.push(`<g class="nm-label ${st.cls}" data-stop="${st.id}"><text x="${b.x1.toFixed(1)}" y="${(b.y2 - 2.5).toFixed(1)}">${esc(st.name)}</text></g>`);
  }

  const badges = branchEnds.map((e) => `<g class="nm-badge r-${e.route}"><circle cx="${e.x.toFixed(1)}" cy="${e.y.toFixed(1)}" r="8" fill="${e.color}" />
    <text x="${e.x.toFixed(1)}" y="${(e.y + 3.3).toFixed(1)}" text-anchor="middle">${esc(e.short)}</text></g>`);

  // Bounding box from stations and badges, with room for the labels.
  const xs = [...stations.map((s) => s.x), ...branchEnds.map((e) => e.x)];
  const ys = [...stations.map((s) => s.y), ...branchEnds.map((e) => e.y)];
  const bbox = { x: Math.min(...xs) - 130, y: Math.min(...ys) - 30 };
  bbox.w = Math.max(...xs) + 130 - bbox.x;
  bbox.h = Math.max(...ys) + 30 - bbox.y;

  const focusCss = routes.map((r) => `.netmap svg[data-focus="${r}"] .r-${r}, .netmap svg[data-focus="${r}"] .s-${r} { opacity: 1; }`).join('\n');
  const svg = `<svg class="nm-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(t('map.title'))}">
    <style>${focusCss}</style>
    <g class="nm-world">${parts.join('')}<circle class="nm-here" r="12" cx="-9999" cy="-9999" />${marks.join('')}${labels.join('')}${badges.join('')}</g></svg>`;
  return { svg, bbox, stations, routes, meta };
}

/* ── View: pan & zoom ───────────────────────────────────────────── */
function applyView() {
  el.world?.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.s})`);
}

function fitView() {
  if (!model || !el.stage) return;
  const cw = el.stage.clientWidth;
  const ch = el.stage.clientHeight;
  const { bbox } = model;
  view.fit = Math.min(cw / bbox.w, ch / bbox.h);
  view.s = view.fit;
  view.x = (cw - bbox.w * view.s) / 2 - bbox.x * view.s;
  view.y = (ch - bbox.h * view.s) / 2 - bbox.y * view.s;
  applyView();
}

function zoomAt(factor, cx, cy) {
  const s = Math.min(Math.max(view.s * factor, view.fit * 0.8), 5);
  const k = s / view.s;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.s = s;
  applyView();
}

/* Gestures. The stage captures the pointer so a drag keeps going outside
   it — which also means the browser then reports taps as landing on the
   stage, not on the station. So the station is read when the finger goes
   down, and a tap is a down/up without dragging. */
function setupGestures() {
  const pts = new Map();
  let moved = 0;
  let pinch = null;
  let downStop = null;
  let multi = false;
  const local = (e) => {
    const r = el.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  el.stage.addEventListener('pointerdown', (e) => {
    if (!pts.size) {
      moved = 0;
      multi = false;
      downStop = e.target.closest?.('[data-stop]')?.dataset.stop ?? null;
    }
    try { el.stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pts.set(e.pointerId, local(e));
    if (pts.size === 2) {
      multi = true;
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  });
  el.stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    const cur = local(e);
    pts.set(e.pointerId, cur);
    if (pts.size === 1) {
      view.x += cur.x - prev.x;
      view.y += cur.y - prev.y;
      moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
      applyView();
    } else if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.d = d;
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size || e.type === 'pointercancel') return;
    if (multi || moved > 8) return;
    if (downStop) showCard(downStop);
    else el.card.hidden = true;
  };
  el.stage.addEventListener('pointerup', up);
  el.stage.addEventListener('pointercancel', up);
  el.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  el.stage.addEventListener('dblclick', (e) => {
    const p = local(e);
    zoomAt(2, p.x, p.y);
  });
}

/* ── Chips, focus, station card ─────────────────────────────────── */
function renderChips() {
  const chip = (route, label, color) => `<button type="button" class="trip__linebtn${route ? '' : ' is-all'}"
    data-map-focus="${route ?? ''}" aria-pressed="${focus === route}" ${color ? `style="--line:${color}"` : ''}>${esc(label)}</button>`;
  el.chips.innerHTML = chip(null, t('trip.all'))
    + model.routes.slice().sort().map((r) => chip(r, model.meta.get(r)?.short ?? r, model.meta.get(r)?.color)).join('');
}

function setFocus(route) {
  focus = route;
  if (el.svg) {
    if (route) el.svg.dataset.focus = route;
    else delete el.svg.dataset.focus;
  }
  renderChips();
}

function showCard(id) {
  const st = model.stations.find((s) => s.id === id);
  if (!st) return;
  const badges = st.served.slice().sort().map((r) => {
    const m = model.meta.get(r);
    return `<span class="badge" style="--line:${m?.color}">${esc(m?.short ?? r)}</span>`;
  }).join('');
  el.card.innerHTML = `<div class="nm-card__head"><span class="nm-card__name">${esc(ctx.stops[id]?.name ?? '')}</span>
    <span class="nm-card__lines">${badges}</span></div>
    <button type="button" class="nm-card__go" data-map-pick="${id}">${t('map.schedule')}</button>`;
  el.card.hidden = false;
}

function onClick(e) {
  const f = e.target.closest('[data-map-focus]');
  if (f) {
    const r = f.dataset.mapFocus || null;
    setFocus(r === focus ? null : r);
    return;
  }
  const z = e.target.closest('[data-map-zoom]');
  if (z) {
    const r = el.stage.getBoundingClientRect();
    if (z.dataset.mapZoom === 'fit') fitView();
    else zoomAt(z.dataset.mapZoom === 'in' ? 1.5 : 1 / 1.5, r.width / 2, r.height / 2);
    return;
  }
  const p = e.target.closest('[data-map-pick]');
  if (p) {
    ctx.onPick(p.dataset.mapPick);
    history.state?.netmap ? history.back() : closeMap();
  }
}
