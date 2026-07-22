# Próximo — Porto Metro departures

Timetable-based next departures for **any stop on the network** (85 stops),
computed from the official Metro do Porto GTFS. Zero dependencies.

## Run

```
cd porto-metro
node server.js
```

→ http://localhost:8088 (or http://<pc-ip>:8088 from your phone).

Folder layout must be:

```
porto-metro\
├─ server.js
├─ gtfs.js
├─ gtfs\      ← the 6 .txt GTFS files
└─ public\    ← index.html, style.css, app.js, data.js
```

## What's new

- Stop chooser: tap the stop name, search (accent-insensitive — "sao bento"
  finds São Bento), or pick from your recent stops. Line dots show which
  lines serve each stop.
- Every stop's directions and labels are derived from the feed itself:
  the label is the most common destination, "+N more" when several lines
  share the platform. Termini (Aeroporto, Fânzeres…) naturally show a
  single direction.
- Trips that terminate at a stop never appear as departures from it.
- Last stop + direction and your 4 most recent stops are remembered.

## API

- `GET /api/config` — all stops, directions, line colours
- `GET /api/departures?stop=<stop_id>&direction=<0|1>` — next 8, up to 2 h out
- `GET /api/cp/config`, `GET /api/cp/departures?...` — same, for CP trains
- `GET /api/stcp/config`, `GET /api/stcp/departures?...` — same, for STCP buses

## Automatic feed updates

The server now keeps the timetable fresh by itself:

- On startup and once a day, it asks the open-data portal's CKAN API which
  GTFS zip is newest for the Metro do Porto dataset
- If it's new, it downloads it, extracts it (built-in zip reader, still zero
  dependencies), validates it (all 6 files present, calendar not expired),
  swaps it into `gtfs/`, and hot-reloads — no restart needed
- If anything fails (portal down, broken zip, expired feed), it logs the
  error and keeps serving the current feed
- `gtfs/.state.json` records what's installed; `GET /api/status` shows it

Manual check any time:

```
node update-gtfs.js          # metro: check + install if newer
node update-gtfs.js --cp     # same for CP (Comboios de Portugal)
node update-gtfs.js --stcp   # same for STCP (Porto city buses)
node update-gtfs.js --force  # reinstall even if unchanged (combines with --cp/--stcp)
```

CP publishes a single zip URL updated in place; STCP uploads a new resource
to the Porto open-data portal every few days (the newest by date is used).
