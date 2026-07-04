# Supreme Rubber Industries — Machine Monitor

Live machine-card dashboard for plant telemetry stored in MongoDB Atlas
(`sanmati` database — `machines` + `telemetries` time-series collections).
Light-themed UI; every card links to a full machine detail page.

## Run

```
npm install
npm start
```

Open http://localhost:3000

Connection settings live in `.env` (`MONGODB_URI`, `DB_NAME`, `PORT`).

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/machines` | Every registered machine joined with its latest telemetry payload |
| `GET /api/machines/:machineId` | Full detail for one machine, incl. raw PLC registers |
| `GET /api/machines/:machineId/history?minutes=15` | Recent points for the pressure trend (max 180) |
| `GET /api/health` | Liveness check |
| `GET /machine/:machineId` | Machine detail page (server-routed) |

## How the cards work

The frontend renders **one card per machine returned by `/api/machines`** —
nothing is hard-coded to RUBBERMOLDING01. When a new machine (JCI, EKC, …)
starts posting telemetry and appears in the `machines` collection, its card
shows up automatically. Sections (curing ring, bump profile, utilization)
only render when the machine actually reports those metrics.

Status logic: a machine is **OFFLINE** if no telemetry arrived in the last
60 seconds; otherwise the card shows the machine's own reported `status`
(running / idle). Metrics refresh every 4 s, the pressure sparkline every 20 s.

All metric values are displayed exactly as reported by the PLC — no unit
labels or time conversions are added on top of the server data.

## Deploying to Render

This app must be deployed as a **Web Service** (it runs a Node server), NOT a
Static Site — a static site serves only `public/` and every `/api/*` call 404s.

1. Render Dashboard → **New + → Web Service** → pick this repo (`render.yaml`
   is auto-detected if you use **New + → Blueprint** instead).
2. Build command `npm install`, start command `npm start`.
3. Environment variables: `MONGODB_URI` (the Atlas connection string) and
   `DB_NAME=sanmati`. Do **not** set `PORT` — Render injects its own.
4. In MongoDB Atlas → **Network Access**, allow `0.0.0.0/0` (or Render's
   outbound IPs) so the server can reach the cluster.
5. Once the web service is live, delete the old static site.

Note: on the free plan the service sleeps after ~15 min idle and takes
~1 minute to wake on the next visit.
