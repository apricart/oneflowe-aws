# OF-AUDIT — Activity log: filter by actor role

Builds on `plans/OF-AUDIT-admin-activity-log.md` and
`plans/OF-AUDIT-head-office-activity-log.md`.

## Request

Add a **Role** filter to `/activity` so a reader can narrow the trail to the
actions of one role (Head Office, Branch Admin, Order Portal, …).

## Behaviour

- `GET /api/v1/activity-logs?actorRole=<ROLE>`. The value must be one of
  `ACTIVITY_ACTOR_ROLES` (`lib/activity-log.ts`, every `Role` in `lib/rbac.ts`);
  anything else is 400, never "all".
- **The filter selects on the role the Who column shows**, so the filter and
  the label cannot disagree: the role the row recorded
  (`system_logs.user_role`, `group_audit_logs.performed_by_role`, blank treated
  as none), else the actor account's role today. `audit_logs` records no role,
  so it is the account's role there.
- **Organization reach (Head Office, organization-wide Viewer).** The page
  anonymises anyone outside the tenant and withholds their role unless it is
  Super Admin (`lib/activity-log-reach.ts`). A filter that matched such a row
  would reveal what the page hides, so for a tenant role the predicate matches
  only a person `classifyActivityActor` would show: an account in the tenant
  that is not platform staff, or a principal with no account whose row recorded
  the role.
- **A tenant filters by tenant roles only** (decided 2026-10-16): Head Office,
  Group User, Branch Admin, Group Order Portal, Order Portal, Viewer
  (`ACTIVITY_TENANT_ACTOR_ROLES`). Apricart's internal roles — Super Admin,
  Order Desk, Apricart Executive, Warehouse — are not offered to an organization
  reader, and `applyActivityReach` refuses one with 403. The Super Admin platform
  reader is offered every role.

## Implementation

- `lib/activity-log-request.ts` — `actorRole` in the strict query schema.
- `lib/server/activity-log-sql.ts` — `actorRolePredicate`, pushed into each
  branch of the union. The account lookups are uncorrelated `IN` subqueries
  (hashed once per query); the "no account" test is a `NOT EXISTS`. Every value
  is a parameter.
- `lib/activity-log-view.ts` — labels and per-reach options.
- `components/activity/activity-log-filters.tsx`, `activity-log-screen.tsx` —
  the Role select, its chip, and the query parameter.

No schema change, no new endpoint, no change to who may read the log.

## Tests

- Unit: request parsing, SQL shape (parameters only, tenant condition inside
  the role subqueries for an organization reach), options and chips.
- Integration (`tests/integration/activity-log-api.test.ts`, "the actor-role
  filter"): hand-worked expected rows per role for both reaches, and a row
  recorded with a tenant role by platform staff that Head Office must not find.
