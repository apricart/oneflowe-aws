# Same-day rider routes, shared geometry, live tracking

## Objective
Warehouse assigns for **today (Asia/Karachi)** only on the plan/track surfaces. Undelivered past that day are **overdue** — flagged + notified (warehouse in-app, rider API). Rider map gets the **same open road route** warehouse planned (depot → stops, no return). Warehouse **Track** screen shows live rider GPS + stop markers (delivered flagged). Web UI/API stays **WAREHOUSE**-scoped.

## Acceptance
1. Plan route / rider route / track focus on Karachi-today assignments; earlier open legs are `overdue: true`
2. Overdue → warehouse notification once per assignment/day; rider orders/route carry `overdue`
3. `GET /api/v1/rider/route` returns depot, sequenced stops (incl. delivered-today), OSRM `geometry`, same order as Plan route
4. Warehouse Track rider: live Redis location + planned stops + delivered flags; WAREHOUSE only
5. Delivered stops marked on warehouse Plan/Track maps and in rider route payload (`delivered: true`)

## Steps
1. Same-day helpers + overdue notifications
2. Enrich getRiderRoute + assignments list with overdue/delivered + geometry
3. Scope locations API to warehouse riders; track payload with stops
4. Warehouse Track UI + plan-route delivered styling
5. Allowlists / docs
