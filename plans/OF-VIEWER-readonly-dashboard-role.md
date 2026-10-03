# OF-VIEWER — a seventh role: read-only dashboard Viewer

Status: **implemented — gates green, role row not yet seeded**
Date: 2026-09-29

---

## 1. What was asked

A user who can **only** see the dashboard KPIs. View only — no create, edit,
update or delete anywhere in the application. Created by **Head Office and
Super Admin only**.

The role gets a **dedicated dashboard**, built from the existing one with
additions. No other role's dashboard changes:

1. Month-wise cost filtering.
2. Automatic refresh.
3. Order-status visibility across six buckets: Active, Delivered, Fulfilled,
   Delivered-but-pending-acknowledgment, Unfulfilled, Pending Approval.

Reach: dashboard KPIs only, drill-down included. Orders, Users, Budgets,
Reports, Settings, Inventory, Support are unreachable.

## 2. Decisions taken

### D1 — A seventh compiled role, `VIEWER`, not a custom-role engine

`plans/OF-CUSTOM-ROLES-rbac-permission-engine.md` records that the permission
catalogue in `lib/permissions.ts` is decorative: nothing reads it to make an
authorization decision. Real authorization is role-name matching in ~1,663
places. Building the permission engine to deliver one read-only role would be a
rewrite of every scope resolver. `VIEWER` is added the way `GROUP_USER` and
`GROUP_ORDER_PORTAL` were — as a compiled role name with an explicit branch in
each resolver that needs one.

### D2 — View-only is enforced by omission, and that is sound here

`requireApiRole` (`lib/api.ts`) **denies any role absent from a route's
allowlist**, and `isValidRole` rejects a role name outside the union outright.
So the default for a new role on all 118 route handlers is 403. This work only
ever *adds* `VIEWER` to read endpoints; no mutating route is touched, so no
mutating route admits it.

Two caveats that must be handled rather than assumed:

* `rolePortalRedirect` in `proxy.ts` **fails open for an unknown role** (F5 of
  the custom-roles investigation — `EMPLOYEE` renders the whole admin shell
  today). `VIEWER` therefore gets an explicit confinement branch. The proxy is
  navigation only; the endpoints are the boundary.
* `getSafeUserRole` in `lib/auth.ts` falls back to `BRANCH_ADMIN` for an
  unrecognised role. Both copies of `isValidRole` (`lib/auth.ts` and
  `lib/rbac.ts` — duplicated, F4) must learn `VIEWER`, or a viewer session
  silently becomes a branch administrator.

### D3 — Scope: organization-wide, narrowed to one branch when pinned

`VIEWER` requires an `organizationId`. `branchId` is **optional**:

| `users.branch_id` | What the viewer sees | Branch filter |
|---|---|---|
| null | the whole tenant | shown |
| set | that branch alone | hidden, server-enforced |

One rule, applied in every resolver the role is admitted to:

```
organizationId = scope.organizationId          // never from the request
branchId       = scope.branchId ?? request.branchId
```

A pinned viewer can never widen — its own `branchId` wins over anything on the
query string. This answers both framings in the request (an org-level watcher,
or a branch-level one) without a second role name.

Requested branch ids from an unpinned viewer are validated against the tenant
exactly as Head Office's are (`verifyHeadOfficeBranch`, and the tenant
predicate in `resolveDrillDownBranchIds`).

### D4 — Authority level 1, below every acting role

`ROLE_LEVEL` (`lib/server/user-access-policy.ts`) and `ROLE_HIERARCHY`
(`lib/rbac.ts`) are renumbered 1–7 with `VIEWER` at 1. The comment on
`ROLE_HIERARCHY` already states levels are compared only relative to one
another, so renumbering preserves every existing pairwise relationship.
`canAssignRole` then lets Head Office (6) and Super Admin (7) assign it, and
`USER_MANAGEMENT_ROLES` — already `["SUPER_ADMIN", "HEAD_OFFICE"]` — is what
keeps anyone else out of user creation entirely. Branch Admin is unchanged and
still has no user-management surface.

### D5 — The six status buckets, defined once

The buckets are derived from two columns — `orders.status` and
`orders.fulfillment_status` — and are defined in one pure module,
`lib/order-delivery-status.ts`, so the KPI card, its SQL and its drill-down
cannot drift:

| Bucket | Rule |
|---|---|
| Pending Approval | `status = PENDING` |
| Active | `status = APPROVED` |
| Delivered | `fulfillment_status = DELIVERED` (any order status) |
| Delivered, pending acknowledgment | `status = APPROVED` **and** `fulfillment_status = DELIVERED` |
| Unfulfilled | `status = APPROVED` **and** `fulfillment_status <> DELIVERED` |
| Fulfilled | `status IN (FULFILLED, PARTIAL, PARTIALLY_FULFILLED)` |

Active = Delivered-pending-acknowledgment + Unfulfilled, exactly, which is what
makes the panel readable.

Only **Delivered** is new to the aggregate: `deliveredCount` in
`sales-performance` today is the APPROVED-and-delivered bucket, not a delivery
count. A new `deliveredTotalCount` is added alongside it. The existing field
keeps its meaning and its readers, so the other three dashboards do not move.

Note a pre-existing inconsistency deliberately **not** replicated: the "Not
Delivered" detail on the current cards counts APPROVED-only, while the
`NOT_DELIVERED` drill-down counts every status. The viewer dashboard uses
`UNFULFILLED`, a new drill-down type whose SQL is the same predicate as its
card.

### D6 — Prices stay visible

`lib/price-visibility.ts` hides prices from `BRANCH_ADMIN` and `ORDER_PORTAL`
where the tenant has set the flag. `VIEWER` is deliberately not added: the role
exists to watch cost, and month-wise cost filtering is an explicit requirement.
**Flagged for the client:** a branch-pinned viewer in a tenant that hides prices
from its Branch Admin will see costs that Branch Admin cannot. Say the word and
`VIEWER` joins `PRICE_RESTRICTED_ROLES` with its own setting key.

### D7 — Support is out

Every other client role holds a channel to Apricart. `VIEWER` does not, because
the answer was "dashboard only". It is one entry in `isSharedPortalArea` plus
three `SUPPORT_*` permissions if that turns out to be wrong.

## 3. Files

**Role plumbing**

| File | Change |
|---|---|
| `lib/rbac.ts` | `Role` union, `isValidRole`, `ROLE_HIERARCHY` renumber |
| `lib/auth.ts` | the duplicate `isValidRole` list |
| `lib/server/mutation-validation.ts` | `systemRoleSchema` |
| `lib/server/user-access-policy.ts` | `ROLE_LEVEL` renumber |
| `lib/permissions.ts` | `ROLE_TEMPLATES.VIEWER` — read-only keys only |
| `lib/seed.ts` | seeded role names derived from `ROLE_TEMPLATES`, not re-listed |
| `lib/invoice-access-policy.ts` | a `"none"` branch reach, so the role reads no invoice |
| `lib/viewer-access.ts` | **new** — the role's areas, admitted routes, scope rule |
| `proxy.ts` | explicit confinement to `/dashboard` + `/change-password` |
| `app/(auth)/login/page.tsx` | landing path |
| `components/shell/sidebar.tsx` | `getNavigationByRole`, `describeRole` |
| `components/context/app-context.tsx` | `Role`, `initializeRoleContext` |
| `app/(portal)/dashboard/page.tsx` | render `ViewerDashboard` |

**Creation (Head Office + Super Admin)**

| File | Change |
|---|---|
| `app/api/v1/users/route.ts` | role shape: org required, branch optional |
| `components/users/create-user-dialog.tsx` | option, label, validation |
| `components/users/head-office-users-table.tsx` | label, edit-role option, badge |

**Read endpoints admitted**

| File | Change |
|---|---|
| `app/api/v1/analytics/sales-performance/route.ts` | allowlist, scope, `deliveredTotalCount` |
| `app/api/v1/analytics/drill-down/route.ts` | allowlist, scope, `DELIVERED_UNACKNOWLEDGED` + `UNFULFILLED` |
| `app/api/v1/analytics/earliest-record/route.ts` | allowlist |
| `app/api/v1/branches/route.ts` | GET allowlist (branch filter) |

**The dashboard**

| File | Change |
|---|---|
| `lib/order-delivery-status.ts` | **new** — the six buckets, pure |
| `components/dashboard/viewer-dashboard.tsx` | **new** |

## 4. Tests

* `lib/order-delivery-status.test.ts` — the six buckets, including that Active
  partitions into the two sub-buckets.
* `lib/viewer-access.test.ts` — contract: the admitted-route list, and that a
  pinned viewer's branch wins over the query string.
* `lib/server/user-access-policy.test.ts` — **new**: Head Office and Super Admin
  may assign `VIEWER`; nobody may assign `SUPER_ADMIN`; the renumbering left
  every existing pair intact.
* `proxy.test.ts` — a viewer is confined to `/dashboard`, and is bounced from
  `/orders`, `/users`, `/budgets`, `/reports`, `/settings`, `/shop`,
  `/group-portal`, `/organizations`, `/branches`.
* `tests/integration/viewer-role-api.test.ts` — unauthenticated 401;
  viewer on a read endpoint 200; viewer on a **mutating** endpoint 403;
  cross-tenant read denied; a pinned viewer asking for a sibling branch gets its
  own branch, not the sibling's.

## 5. Found on the way — not fixed here

`GET /api/v1/analytics/sales-performance` honours an `organizationIds` query
parameter **for Head Office**, and it takes precedence over the session's own
tenant in `addSalesScopeConditions`:

```ts
if (scope.organizationIds.length > 0) conditions.push(inArray(orders.organizationId, scope.organizationIds))
else if (scope.organizationId) conditions.push(eq(orders.organizationId, scope.organizationId))
```

Verified against the test database: a Head Office session in tenant A asking
for `?organizationIds=<tenant B>` was served tenant B's figures (1 approved, 0
pending) instead of its own (3 approved, 1 pending).

This predates the Viewer work and is **not** fixed here — it needs its own
change, because Super Admin passes the same parameter legitimately and other
callers may too. The Viewer role is explicitly fenced against it:
`organizationIds` is forced to `[]` for the role, which
`lib/server/group-user-dashboard.test.ts` now pins alongside the approver's
equivalent fence.

## 6. Rollout

`roles` is a seeded table. `lib/seed.ts` listed the six role names by hand, so
a seventh template would have been skipped and every attempt to assign it would
have failed with "Invalid role"; that list is now derived from `ROLE_TEMPLATES`.

The `VIEWER` row is created by `npm run db:seed`,
which is safe to re-run **only** with the caveat already recorded in memory:
the seed rewrites `role_permissions` from the templates and must be pointed at
the intended database explicitly. Until the row exists, `POST /api/v1/users`
with `role: "VIEWER"` returns 400 "Invalid role" — it does not half-create a
user.

Rollback is the reverse and is clean: no schema migration, no data backfill.
Existing users are untouched; the only new rows are viewer accounts.

## 7. Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, 1 warning (pre-existing, `branch-admin-dashboard.tsx`) |
| `npm test` | 3663 passed, 7 skipped, 245 files |
| `npm run test:integration` | 608 passed, 12 skipped, 24 files — **ran**, against `oneflowe_test` |
| `npm run build` | succeeded (with an `https://` `NEXTAUTH_URL` for the env validator) |

Two pinned contract strings in `lib/server/group-user-dashboard.test.ts` were
updated deliberately: they assert the exact allowlist source of the two
analytics routes, and both now name VIEWER.
