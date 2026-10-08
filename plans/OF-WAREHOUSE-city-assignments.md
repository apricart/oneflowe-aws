# OF-WAREHOUSE — assign a warehouse user whole cities

Jira: _to be assigned_
Builds on: `plans/OF-WAREHOUSE-warehouse-fulfilment-role.md` (D2 — reach is a
table of branches).

## Requirement

Super Admin sees the list of cities that branches are in, across every
organization, and assigns a city to a warehouse user. Every branch in that city
is then served by that user — **including branches opened in the city later**
(a standing rule, chosen by the product owner on 2026-10-08 over a one-off
"tick today's branches" snapshot).

## Investigation

| Finding | Consequence |
|---|---|
| Every warehouse endpoint resolves its reach through `loadWarehouseReach` (`lib/server/warehouse-scope.ts`) — list, detail, progress, challan, invoice, timeline, workload. Nothing else reads `warehouse_assignments`. | The rule is added in exactly one place; no route changes. |
| `branches.city` is free text (`varchar(100)`), and spellings already differ in data ("Karachi" / "karachi"). | Cities are grouped by a normalised key: whitespace collapsed, trimmed, lower-cased — the same rule as the delivery dashboard's `placeKey`. |
| Head Office creates branches and edits their city (`POST /api/v1/branches`, `PATCH /api/v1/branches/[id]`). | With a standing rule a tenant's city edit moves the branch into or out of a warehouse's reach. Accepted: the warehouse is Apricart's own staff and the tenant only routes its *own* orders, so nothing crosses tenants. The operational risk (a misspelt city reaches no warehouse) is mitigated by the city list showing every spelling as its own city with its branch count, and by explicit branch assignment still working. |
| `GET /api/v1/warehouse-team` ships every branch (capped at 5,000) to the browser. | The city list is aggregated in SQL (one row per city), not derived in the browser from a possibly truncated branch list. |
| The production WAF refuses bodies over 8 KB. | A city change is one city per request (`{ city, assigned }`): the body is tiny however many branches or organizations the city spans, and the server resolves the branches. |

## Design

### Data

New table `warehouse_city_assignments (id, user_id → users ON DELETE CASCADE,
city_key varchar(100), created_by_user_id, created_at)`, unique
`(user_id, city_key)`. It stores the **key**, never branch ids, so a branch
added to the city later is reached with no write.

The key is computed **only in SQL**, by one fragment
(`branchCityKeySql`, `lib/server/branch-city-key.ts`):
`lower(btrim(regexp_replace(city, '\s+', ' ', 'g')))`. Both sides of every
comparison go through it — the branch column and the city Super Admin names —
so the browser never normalises anything and JS/Postgres differences in case
folding or whitespace cannot split a city. An expression index
`branches_city_key_idx` on the same expression serves the reach join.

### Reach

`loadWarehouseReach` = explicit branch assignments **∪** branches whose city key
is assigned to the user, judged by the unchanged `resolveWarehouseReach`
(active, undeleted warehouse account only; empty never widens). Inside a write
it takes `FOR SHARE` on both assignment tables' rows, so a Super Admin removal
waits for an in-flight write, exactly as before. Branch and organization status
are still not required (an approved order must be delivered after a branch is
deactivated).

### API

- `GET /api/v1/warehouse-team` — additive fields: `members[].cityKeys`,
  `branches[].cityKey`, and `cities[]` (`key`, `label` = the most common
  spelling, `branchCount`, `organizationCount`), including any assigned city
  that currently has no branch so it can still be removed.
- `PUT /api/v1/warehouse-team/[userId]/cities` — Super Admin only, rate
  limited, Zod-strict `{ city: string(1..100), assigned: boolean }`.
  Idempotent. Assigning requires at least one branch currently in that city
  (400 otherwise); removing does not. A target that is not an undeleted
  warehouse account is 404. At most `WAREHOUSE_CITY_MAX_PER_USER` (200) cities
  per user (409 beyond). Row-locks the user, writes, and audits
  `UPDATE_WAREHOUSE_CITY_ASSIGNMENTS` (before/after keys, the city, its branch
  count at the time) in the same transaction. The audit row carries no
  organization: a city rule spans tenants and changes with them.

### UI

The Branches dialog gets two tabs. **By city**: filterable list of cities with
branch and organization counts; ticking one saves at once (one request, the
control disabled while in flight). **By branch**: the existing per-organization
picker; a branch already covered by an assigned city shows ticked, disabled and
labelled with that city, because unticking it would not remove it. The members
table names the cities and counts the effective branches.

## Security

Super Admin only (route role check; `proxy.ts` already confines the warehouse
to its own allowlist, which does not list this route). No tenant input decides
what is assigned beyond the branch city the tenant already controls (above). No
raw SQL from input: the city is a bound parameter. Audited.

## Database impact

Additive: one new empty table, one expression index on `branches` (small
table; plain `CREATE INDEX` takes a brief lock — acceptable at its size).
Migration `20261013120000_add_warehouse_city_assignments`. No backfill.

Rollback: `DROP TABLE warehouse_city_assignments; DROP INDEX
branches_city_key_idx;` — warehouse users keep their explicit branches.

## Tests

- Unit: request schema, view helpers (effective branches, city coverage), the
  dialog (tab, one request per toggle, covered branches disabled), contract
  entries (audit coverage, proxy refusal for the warehouse).
- Integration (`tests/integration/warehouse-api.test.ts`): role matrix;
  assignment normalises spelling and spans organizations; a branch created
  later in the city is reached at once; a city edit moves the branch out;
  removal; 400 for a city with no branch; 404 for a non-warehouse target;
  audit row; union with explicit branches; deactivated account reaches nothing.
