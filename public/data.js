/*
 * data.js — API client for the multi-feed backend.
 */

export const api = {
  feeds: () => get('/api/feeds'),
  config: (feed) => get(`/api/${feed}/config`),
  routes: (feed) => get(`/api/${feed}/routes`),
  routeStops: (feed, route) => get(`/api/${feed}/route-stops?route=${encodeURIComponent(route)}`),
  nearest: (feed, lat, lon) => get(`/api/${feed}/nearest?lat=${lat}&lon=${lon}`),
  departures: (feed, stop, dir) =>
    get(`/api/${feed}/departures?stop=${encodeURIComponent(stop)}&direction=${encodeURIComponent(dir)}`),
};

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}
