# OF-WAREHOUSE — scope a warehouse user's cities to chosen organizations

Jira: _to be assigned_
Narrows: `plans/OF-WAREHOUSE-city-assignments.md` (a city rule reached every
branch in the city, in **every** organization).

## Requirement

Super Admin assigns a warehouse user's city reach in two steps:

1. choose one or more **organizations**;
2. choose **cities** — the list offers the cities those organizations have
   branches in.

The user then serves, through cities, exactly the branches that are in a
chosen organization **and** in a chosen city. Single-branch assignment
("By branch") is unchanged and still adds to that.

## Decisions

| Question | Decision |
|---|---|
| Pairs (`org × city` rows) or two sets? | **Two sets**, intersected: `warehouse_city_organizations (user, organization)` beside the existing `warehouse_city_assignments (user, city)`. It is what the two-step screen says, and each tick stays one tiny request (WAF 8 KB). A city chosen for one organization therefore also applies to the other chosen organizations — that is the stated rule ("branches in the selected organizations and in the selected cities"). Finer exceptions use "By branch". |
| Still a standing rule? | Yes. A branch opened later, in a chosen organization, in a chosen city, is reached with no write. A branch in a **new** organization is not, until that organization is ticked. |
| Empty organization set | Reaches nothing through cities — never "every organization". |
| Existing city rows (production has some) | The migration ticks, for each user with cities, every organization that **now** has a branch in one of those cities. Every branch reached today is still reached (proof: such a branch's organization is by construction in the set) and nothing new is reached. Only the "future organization" coverage changes, which is the point. |
| Assigning a city | Needs a branch in that city **in one of the user's organizations** now (400 otherwise — choose an organization first). Withdrawing never needs anything. |
| Withdrawing an organization | Allowed any time; its cities stay assigned (they may serve other organizations). The dialog shows a city no chosen organization has as "not in the chosen organizations" so it can still be withdrawn. |
| Department join (`attachNewBranchToCityWarehouses`) | A whole-city warehouse "already reaches" a new branch only when the branch's organization is in its set. Single-branch warehouses are attached as before. The review's served-city counts take the request's organization. |

## Design

### Data

`warehouse_city_organizations (id, user_id → users ON DELETE CASCADE,
organization_id → organizations ON DELETE CASCADE, created_by_user_id,
created_at)`, unique `(user_id, organization_id)`, index on
`organization_id`. No branch or group column, so no composite tenant key
(`plans/OF-DB-tenant-composite-foreign-keys.md` covers tables with both).

### Reach — one join rule

Every reader that matches a branch to a city rule goes through
`warehouseCityRuleJoin` (`lib/server/warehouse-city-rule.ts`): the branch's
city key equals the rule's key **and** a `warehouse_city_organizations` row
for the same user names the branch's organization. The four readers are
`loadWarehouseReach`, the order-stage recipients, the support-thread
recipients and the join coverage; `lib/warehouse-access.test.ts` pins them.
Inside a write `loadWarehouseReach` takes `FOR SHARE` on both rule tables'
rows, so a withdrawal waits for an in-flight write.

### API

- `GET /api/v1/warehouse-team` — additive: `members[].cityOrganizationIds`
  and `cities[].organizations` (`{ organizationId, branchCount }`, aggregated
  in SQL) so the dialog narrows the list and its counts to the chosen
  organizations without deriving anything from the capped branch list.
- `PUT /api/v1/warehouse-team/[userId]/city-organizations` — Super Admin only,
  rate limited, Zod-strict `{ organizationId, assigned }`, idempotent, at most
  `WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER` (200). Row-locks the user (the
  same lock the city route takes), writes and audits
  `UPDATE_WAREHOUSE_CITY_ORGANIZATIONS` (before/after ids, organization set
  on the row) in the same transaction. A non-warehouse target is 404; an
  unknown organization is 400.
- `PUT .../cities` — unchanged body; the "has a branch" check is now "has a
  branch in one of the user's organizations".

### UI

"By city" becomes two numbered steps in the same tab: **1. Organizations**
(filterable checklist, each tick saved at once) and **2. Cities** (only the
cities of the ticked organizations, counts for those organizations; disabled
until an organization is ticked). "By branch" shows a branch as covered only
when its organization is ticked and its city is. The members table names the
organizations and cities.

## Security

Super Admin only, re-checked in the handler; the warehouse's proxy allowlist
does not list the route (contract test). Organization id is a bound integer
parameter. Audited. The change only ever narrows what a city rule reaches.

## Database impact

Migration `20261027120000_warehouse_city_organizations`: one new table and an
insert-select backfill (rows = users with cities × organizations with a branch
in them — a few dozen). No lock on `branches` beyond a read.

**Apply before deploying**: the reach reads the new table, and until the
backfill exists every city rule reaches nothing.

Rollback: deploy the previous code, then
`DROP TABLE warehouse_city_organizations;` — city rules revert to every
organization.

## Tests

- Unit: request schema; view helpers (cities narrowed to organizations,
  covering city needs the organization, description); the dialog (step 2
  disabled until an organization is ticked, one request per tick, counts
  narrowed, orphan city withdrawable); contract (four readers use the join
  rule, audit coverage, proxy refusal, write sweep).
- Integration (`tests/integration/warehouse-api.test.ts`): role matrix for the
  new route; a city reaches only the ticked organizations' branches; ticking a
  second organization extends it, withdrawing it narrows it; a city with
  branches only outside the user's organizations is 400; idempotence and audit;
  migration backfill preserves reach. Existing suites that plant city rows
  plant the organization too.
