/*
 * connections.js — cross-feed interchange detection. After every feed is
 * loaded, link() walks each stop of each feed and looks for the nearest
 * stop of every OTHER feed within walking distance (e.g. Campanhã: get off
 * the bus and the metro and train stations are right there). The result is
 * written onto the stop objects themselves (stop.connections), which are
 * the same objects each feed's getConfig() serves — so the frontend gets
 * the flags for free. Re-run after any feed hot-reloads, since a reload
 * rebuilds its stop array.
 */

// A short walk. 250 m looked right on paper but misses real interchanges at
// big station complexes — Campanhã's intermodal bus terminal sits ~370 m
// crow-fly from the CP entrance yet is directly connected by a footbridge.
const RADIUS_KM = 0.4;

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/* feeds: [{ type: 'metro'|'cp'|'stcp', stops: [{ id, name, lat, lon, … }] }] */
function link(feeds) {
  for (const feed of feeds) {
    for (const stop of feed.stops) stop.connections = [];
  }

  for (const feed of feeds) {
    for (const other of feeds) {
      if (other === feed) continue;
      for (const stop of feed.stops) {
        if (stop.lat == null || stop.lon == null) continue;
        let best = null;
        let bestKm = RADIUS_KM;
        for (const cand of other.stops) {
          if (cand.lat == null || cand.lon == null) continue;
          const km = haversineKm(stop.lat, stop.lon, cand.lat, cand.lon);
          if (km <= bestKm) { bestKm = km; best = cand; }
        }
        if (best) {
          stop.connections.push({ type: other.type, name: best.name, dist_m: Math.round(bestKm * 1000) });
        }
      }
    }
  }
}

module.exports = { link };
