/*
 * data_cp.js — API client for the CP (Comboios de Portugal) feed. Mirrors
 * data.js's shape so app.js can treat both feeds the same way; no fares or
 * parking here, CP is departures-only.
 */

export let STOPS = {};
export let LINE_COLORS = {};
export let HOLIDAYS = [];
export let FEED_VALID_UNTIL = null;
export let DEFAULT_STOP = null;

export async function init() {
  const res = await fetch('/api/cp/config');
  if (!res.ok) throw new Error(`cp config ${res.status}`);
  const cfg = await res.json();

  LINE_COLORS = cfg.line_colors;
  DEFAULT_STOP = cfg.default_stop;
  HOLIDAYS = cfg.holidays || [];
  FEED_VALID_UNTIL = cfg.feed_valid_until || null;
  STOPS = Object.fromEntries(
    cfg.stops.map((s) => [
      s.id,
      { id: s.id, name: s.name, directions: s.directions, lines: s.lines },
    ])
  );
}

export async function getDepartures(stopId, directionId) {
  const res = await fetch(
    `/api/cp/departures?stop=${encodeURIComponent(stopId)}&direction=${encodeURIComponent(directionId)}`
  );
  if (!res.ok) throw new Error(`cp departures ${res.status}`);
  return res.json();
}
