/*
 * data.js — API client. The backend computes departures from the
 * Metro do Porto GTFS.
 */

export let STOPS = {};
export let LINE_COLORS = {};
export let HOLIDAYS = [];
export let FEED_VALID_UNTIL = null;
export let DEFAULT_STOP = null;

export async function init() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`config ${res.status}`);
  const cfg = await res.json();

  LINE_COLORS = cfg.line_colors;
  DEFAULT_STOP = cfg.default_stop;
  HOLIDAYS = cfg.holidays || [];
  FEED_VALID_UNTIL = cfg.feed_valid_until || null;
  STOPS = Object.fromEntries(
    cfg.stops.map((s) => [
      s.id,
      { id: s.id, name: s.name, directions: s.directions, lines: s.lines, parking: s.parking },
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

export async function getFare(fromStopId, toStopId) {
  const res = await fetch(
    `/api/fare?from=${encodeURIComponent(fromStopId)}&to=${encodeURIComponent(toStopId)}`
  );
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || `fare ${res.status}`);
  return payload;
}

export async function getTripPlan(fromStopId, toStopId) {
  const res = await fetch(
    `/api/trip?from=${encodeURIComponent(fromStopId)}&to=${encodeURIComponent(toStopId)}`
  );
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || `trip ${res.status}`);
  return payload;
}
