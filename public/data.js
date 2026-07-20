/*
 * data.js — API client. The backend computes departures from the
 * Metro do Porto GTFS.
 */

export let STOPS = {};
export let LINE_COLORS = {};

export async function init() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`config ${res.status}`);
  const cfg = await res.json();

  LINE_COLORS = cfg.line_colors;
  window.DEFAULT_STOP = cfg.default_stop;
  STOPS = Object.fromEntries(
    cfg.stops.map((s) => [
      s.id,
      { id: s.id, name: s.name, directions: s.directions, lines: s.lines },
    ])
  );
}

export async function getDepartures(stopId, directionId) {
  const res = await fetch(
    `/api/departures?stop=${encodeURIComponent(stopId)}&direction=${encodeURIComponent(directionId)}`
  );
  if (!res.ok) throw new Error(`departures ${res.status}`);
  return res.json();
}
