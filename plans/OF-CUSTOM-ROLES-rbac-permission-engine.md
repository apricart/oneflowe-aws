# OF-CUSTOM-ROLES — Super Admin role builder (investigation + plan)

Status: **investigation complete, not started**
Date: 2026-09-07

---

## 1. What was asked

A form where `SUPER_ADMIN` creates new roles by ticking permissions from a
catalogue of every activity a user can perform, instead of being limited to the
six roles compiled into the application.

## 2. What is actually there (findings)

### F1 — The permission system in the repo today is decorative

`lib/permissions.ts` defines 54 permissions across 9 categories, 6
`ROLE_TEMPLATES`, and `PERMISSION_DEFINITIONS` with labels, descriptions and
`isHighRisk`. `db/schema.ts` has a `role_permissions` table. `lib/seed.ts`
populates it from the templates. `app/api/v1/roles/permissions/route.ts`
provides full GET/POST/PUT/DELETE with Zod validation and audit rows.

**None of it is ever read to make an authorization decision.** Only four files
import `lib/permissions.ts`:

| File | What it does with it |
|---|---|
| `app/api/v1/roles/permissions/route.ts` | writes the rows |
| `lib/seed.ts` | writes the rows |
| `components/admin/role-permissions-manager.tsx` | 415-line UI, **never mounted anywhere** |
| `lib/pricing-access.test.ts` | references `Permission.PRICING_MANAGE` as documentation only |

There is no `hasPermission()`, no `requirePermission()`, and no client hook.
Ticking a box in that UI today changes nothing about what any user can do.

### F2 — Real authorization is role-name string matching, in ~1,663 places

- 1,663 occurrences of the six role-name literals across `app/`, `lib/`,
  `components/`, `proxy.ts`.
- 118 route handler files. **39** use `requireApiRole([...])`. The other **79**
  do bespoke inline `getServerSession` / `getRequestScope` plus role comparisons,
  in at least three different idioms.
- `lib/rbac.ts` `Role` is a hardcoded six-string union. `isValidRole` is
  **duplicated** in `lib/rbac.ts` and `lib/auth.ts`.

Consequence for this feature: a role name outside that union is rejected by
`requireApiRole` with 403 "Invalid user role" on 39 routes, and behaves
unpredictably on the other 79.

### F3 — Role is not only permission; it is *data scope*. This is the hard part.

A checkbox "View Orders" cannot answer *which* orders. Scope is decided by role
name in these modules:

| Module | What role decides |
|---|---|
| `lib/auth.ts` `getRequestScope()` | `SUPER_ADMIN` short-circuits to `org=null, branch=null`, meaning "everything" |
| `lib/auth.ts` `verifyResourceAccess()` | `SUPER_ADMIN` full bypass; `HEAD_OFFICE` cross-branch bypass |
| `lib/server/multi-branch-scope.ts` | only `GROUP_USER` / `GROUP_ORDER_PORTAL` resolve branches from assignment tables; everyone else is pinned to `users.branch_id` |
| `lib/server/analytics-scope.ts` | `BRANCH_SCOPED_ROLES` / `MULTI_BRANCH_SCOPED_ROLES` sets |
| `lib/organization-report-scope.ts` | which organizations a report covers |
| `lib/group-order-visibility.ts` | `ORDER_PORTAL` narrowed to own orders **or** group orders for its branch |
| `lib/invoice-access-policy.ts` | which invoice a caller may read |
| `lib/fulfillment-token-access.ts` | five separate role branches |

**Permissions can be freeform checkboxes. Scope cannot.** Every tenant query in
the codebase is written against one of five scope shapes; a sixth shape is new
SQL, not a new checkbox.

### F4 — Role names are baked into the database, not only into code

- `organizations.order_approver_role` carries a CHECK constraint
  `IN ('BRANCH_ADMIN','HEAD_OFFICE')` (`db/schema.ts:47-49`). **A custom role can
  never be an order approver without a migration on a live table.**
- `roles` has **no `organization_id`**, and `roles_name_idx` is unique on `name`
  alone. Roles are global to the whole platform — a role created for one tenant
  is visible to every tenant. In a multi-tenant product this is a decision that
  must be made explicitly, not inherited by accident.
- `roles.permissions` (jsonb) duplicates `role_permissions` rows. Two sources of
  truth, kept in sync by hand in the PUT handler.

### F5 — Ghost roles already exist. The failure mode is not hypothetical.

**`EMPLOYEE`** — synthesized in `lib/auth-options.ts` (lines 887, 926, 950, 992)
for the employee-credentials login path. It is not in the `Role` union, not in
`systemRoleSchema`, and has no `roles` row. Effects observable today:

- `isValidRole("EMPLOYEE")` is false, so `requireApiRole` returns **403 on every
  one of the 39 gated routes**.
- `proxy.ts` `rolePortalRedirect("EMPLOYEE", …)` falls through every branch and
  returns **`null`** — the edge does **not** confine it to `/shop`. Only
  `/organizations` and `/branches` bounce it; `/dashboard`, `/orders`,
  `/inventory`, `/budgets`, `/reports`, `/settings`, `/users` all render the
  shell. `rolePortalRedirect` **fails open for an unknown role.**
- `app/api/v1/branch/inventory/route.ts:27` explicitly allows it.

**`BRANCH_MANAGER`** — appears in the allowed-role lists of 8+ analytics routes
(`analytics/refunds`, `analytics/summary`, `analytics/users/*`,
`analytics/products/*`, `analytics/budgets/summary`) and exists nowhere else. A
dead allowance that will silently activate the day someone names a role that.

Both are exactly what a custom role will hit at scale, already in production.

### F6 — The session carries a role name, not a permission set

The JWT holds `token.role` as a string. `invalidSessionReason` in
`lib/auth-options.ts:375` invalidates a session when `dbUser.role !== token.role`,
so a role *reassignment* correctly kills the session. But a **permission change
on an unchanged role name invalidates nothing** — every holder of that role keeps
the old rights until their fixed 8-hour token expires.

### F7 — The frontend is hardcoded per role too

- `components/shell/sidebar.tsx` `getNavigationByRole()` is a chain of
  `if (role === "SUPER_ADMIN")` … with no default. **A custom role gets an empty
  sidebar.** `describeRole()` has the same shape.
- 29 files under `components/` and 35 under `app/` contain role-name conditionals.
- No client-side permission hook exists; `lib/hooks/` has none.

### F8 — Contract tests pin role literals as source strings

`lib/pricing-access.test.ts` asserts exact source text, for example
`export const PRICE_MUTATION_ROLES = ["SUPER_ADMIN"] as const`, and lists nine
price-writing route paths. `lib/server/security-boundaries.test.ts` asserts
regexes against route source. These are the control mechanism (rule 03) and must
be updated deliberately as part of the work, never routed around.

### F9 — Activities that exist but have **no permission key**

The catalogue covers roughly half the application. Missing entirely:

- **Refunds** — request, approve, reject, view (`orders/[id]/refunds`,
  `admin/refunds`, `group-portal/refunds`). No `refund:*` key exists.
- **Fulfilment** — fulfil, fulfilment status, payment status, fulfilment token,
  send token email, auto-fulfil cron.
- **Invoices and receipts** — view, download, PDF generation.
- **Group Order Portal actions** — submission, draft, approvals, group refunds,
  group reports. The `GROUP_*` keys cover *administering* groups, not the portal.
- **Inventory tiers** — one `INVENTORY_*` set covers three distinct tiers
  (global catalogue / organization / branch) with different endpoints and
  different risk.
- **Imports** — inventory CSV, global inventory import, organization assignments
  import, employee credentials.
- **Destructive admin operations** — `admin/cleanup-inventory`,
  `admin/clear-branch-inventory`, `admin/delete-order`, `admin/repair-budgets`,
  `admin/migrate-product-code`. All high-risk, none catalogued.
- **User scope administration** — `users/[id]/scope`, `users/[id]/access`,
  `head-office/branch-assignments`.
- **Network policy** (per-organization IP allowlist), **image upload**,
  **notifications**, **executive analytics**, **drill-down**, **modifiers**,
  **budget-quantity mode**.
- **Price *visibility*** as distinct from price *mutation* — `PRICING_MANAGE`
  covers writes; read visibility is driven by organization settings with no key.

And keys that exist with **no enforcement point at all** (orphans to implement or
delete): `SYSTEM_VIEW_SYSTEM_HEALTH`, `SYSTEM_VIEW_AUDIT_LOGS`,
`USER_VIEW_SESSIONS`, `INVENTORY_TRANSFER`, `ORG_DELETE`,
`SETTINGS_MANAGE_PRODUCTS`, `FINANCE_APPROVE_EXPENSES`, `REPORTS_SCHEDULE`.

### F10 — Role hierarchy is a numeric ladder with no room for custom roles

`lib/rbac.ts` `ROLE_HIERARCHY` and `lib/server/user-access-policy.ts`
`ROLE_LEVEL` both map the six roles to 1–6, and `canAssignRole` /
`canManageUser` compare integers. **A custom role has no number.** This must be
replaced by a subset comparison before any custom role can be assigned to a user.

---

## 3. The design decision this forces

A role is **two independent things**, and only one of them can be a checkbox:

```
role = {
  name, description,
  scopeArchetype,      // CLOSED enum — five values, cannot be invented
  portalHome,          // CLOSED enum — /dashboard | /shop | /group-portal
  permissions[],       // OPEN checklist — the catalogue
  organizationId,      // null = platform role, else tenant-owned
  isSystem,            // the six templates: uneditable, undeletable
}
```

`scopeArchetype` values, each already implemented in code today:

| Archetype | Today's role | Scope resolution |
|---|---|---|
| `PLATFORM` | SUPER_ADMIN | all tenants; `getRequestScope` returns nulls |
| `ORGANIZATION` | HEAD_OFFICE | one tenant, all its branches |
| `MULTI_BRANCH` | GROUP_USER, GROUP_ORDER_PORTAL | `resolveScopedBranchIds()` from assignment tables |
| `BRANCH` | BRANCH_ADMIN | `users.branch_id` |
| `SELF` | ORDER_PORTAL | own rows within a branch, plus group orders for that branch |

**Recommendation — constrained variant.** Rather than fully arbitrary roles, a
custom role picks one archetype and may only **subtract** permissions from that
archetype's template, never add beyond it. This delivers most of the business
value (a read-only Head Office; a Branch Admin who cannot approve) at a fraction
of the risk, and shrinks Phase 3 from a rewrite of every scope resolver to a
lookup. Full additive freedom can follow later on the same foundation.

---

## 4. Plan

### Phase 0 — Freeze the ground truth (no behaviour change)

1. **Route authorization manifest.** Build `lib/authz/route-manifest.ts`: one
   entry per route file and HTTP method, recording the roles allowed today and
   the scope archetype it assumes. Derived from the 118-route scan already done.
2. **Contract test** asserting every exported handler in `app/api/v1/**` appears
   in the manifest, in the style of `lib/pricing-access.test.ts`. A route missing
   from the manifest fails the build. This is the control for everything after.
3. **Resolve the ghost roles.** Decide whether `EMPLOYEE` is a real role (then
   add it to `Role`, `systemRoleSchema`, the `roles` table and `proxy.ts`
   confinement) or an alias of `ORDER_PORTAL`. Delete `BRANCH_MANAGER` from the
   analytics allowlists. **Make `rolePortalRedirect` fail closed** for an unknown
   role — it currently fails open.
4. **De-duplicate `isValidRole`** — one definition in `lib/rbac.ts`, with
   `lib/auth.ts` re-exporting it.

### Phase 1 — Make the catalogue complete and true

5. Extend `Permission` and `PERMISSION_DEFINITIONS` to cover every area in F9.
   Every key must name a real, enforced action — a checkbox that does nothing is
   worse than no checkbox.
6. Delete or implement the orphan keys.
7. Add the metadata each permission needs: `minimumScopeArchetype` (for example
   `PRICING_MANAGE` and every `SYSTEM_*` require `PLATFORM`), `impliedBy`, and
   `dangerous` for the destructive admin endpoints.

### Phase 2 — Build the evaluation path (still no custom roles)

8. `lib/authz/permission-set.ts` — pure and unit-testable: given a role's rows,
   answer `can(permission)`. No database import.
9. `lib/server/authz.ts` — `requirePermission(Permission.X)` mirroring
   `requireApiRole`, loading the set from `role_permissions`, Redis-cached
   through `lib/cache-utils.ts` with a **tenant-scoped key** (rule 05: a cache
   key missing the tenant is a cross-tenant leak).
10. Add `roles.permission_version`; bump it on every permission write and carry
    it as a JWT claim, extending `invalidSessionReason` so a permission change
    ends stale sessions instead of waiting out the 8-hour token (F6).
11. **Dual-check migration.** Route by route: keep `requireApiRole([...])` and
    add `requirePermission(...)`; both must pass. The six system roles are seeded
    from `ROLE_TEMPLATES`, so the new check is a no-op for them. Remove the role
    check only once the manifest test proves parity for that route. Do the 39
    `requireApiRole` routes first, then the 79 bespoke ones — which is the bulk
    of the work and where the real defects will be found.

### Phase 3 — Scope as a first-class column

12. Add `roles.scope_archetype` (not null) and `roles.portal_home`. Backfill the
    six system roles.
13. Refactor to branch on archetype rather than role name: `getRequestScope`,
    `verifyResourceAccess`, `lib/server/analytics-scope.ts`,
    `lib/server/multi-branch-scope.ts`, `lib/organization-report-scope.ts`,
    `lib/invoice-access-policy.ts`, `lib/fulfillment-token-access.ts`,
    `lib/group-order-visibility.ts`. **Largest and riskiest piece.** Under the
    constrained variant (section 3) this reduces to mapping archetype to the
    existing resolver, with no new SQL.
14. `proxy.ts` reads `portal_home` from the token.
15. `sidebar.tsx` becomes permission-driven — each nav item declares its
    required permission; no role-name chain, and a sensible default.

### Phase 4 — The role builder

16. **Migration** on `roles`: `organization_id` (nullable), `is_system`,
    `scope_archetype`, `portal_home`, `permission_version`, `status`.
    Replace `roles_name_idx` with unique `(organization_id, name)` — **hazard:**
    Postgres treats NULLs as distinct, so platform-role uniqueness needs a
    partial unique index `WHERE organization_id IS NULL`. Additive first,
    nullable or defaulted, per rule 06.
17. **Widen `organizations_order_approver_role_ck`** (F4) or replace the column
    with a foreign key to `roles.id`. Required before any custom role can approve
    orders. Lock duration on a live table must be considered.
18. `POST /api/v1/roles`, `PUT /api/v1/roles/[id]`, `DELETE /api/v1/roles/[id]` —
    `SUPER_ADMIN` only, Zod-validated, rate-limited, transactional, audited via
    `lib/global-logger.ts`. Server-side guards, **not** UI guards:
    - no self-escalation: an actor cannot grant a permission it does not hold;
    - `PRICING_MANAGE` and `SYSTEM_*` refused for any non-`PLATFORM` role — this
      is the rule `lib/pricing-access.ts` encodes and it must survive intact;
    - system roles are uneditable and undeletable;
    - a role with users attached cannot be deleted without reassignment;
    - permission keys allowlisted against the `Permission` enum (already done in
      the existing PUT handler — keep it).
19. Replace the numeric `ROLE_LEVEL` ladder (F10) in
    `lib/server/user-access-policy.ts` with: *an actor may assign a role whose
    permission set is a subset of its own and whose scope archetype is no broader
    than its own.*
20. **UI**: mount `components/admin/role-permissions-manager.tsx` — currently
    dead code and a good starting point — under a new `/settings/roles` page, add
    name / description / scope archetype / portal home fields, and show which
    permissions are locked and why.

### Phase 5 — Verification (rules 03 and 04)

21. For every migrated route: 401 unauthenticated, 403 unauthorized, success
    authorized, cross-tenant denied, escalation denied.
22. New contract test: no route handler contains a bare role-name comparison
    outside `lib/authz/`.
23. Integration tests against a real Postgres for the migration, the partial
    unique index, and the widened check constraint. Confirm `TEST_DATABASE_URL`
    is set — the suite skips silently and still passes without it.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Big-bang swap of 118 routes produces an outage or a silent hole | Dual-check migration (step 11), route by route, manifest test as the control |
| Scope refactor (Phase 3) changes which rows a role sees | Constrained variant; per-route tenant-isolation tests before and after |
| `order_approver_role` check constraint blocks the feature late | Address in Phase 4 step 17, planned with lock duration and rollback |
| Permission cache key missing the tenant | Tenant-scoped keys via `scopedCacheKey`, asserted in a test |
| Custom role granted `PRICING_MANAGE` | Refused at the endpoint by the archetype rule; keep `lib/pricing-access.ts` as the single authority |
| Existing contract tests break | Update deliberately and say so in the PR — never weaken (rule 03) |
| Roles global across tenants | `organization_id` in Phase 4; decide platform-versus-tenant ownership explicitly |

## 6. Sequencing note

Phases 0–1 are safe, self-contained, and valuable on their own — they produce the
authoritative activity catalogue the request asks for. Phase 2 is the bulk of the
effort. Phase 3 carries the real risk. Phase 4 is the visible feature and the
smallest slice. Do not start Phase 4 before Phase 2 is complete, or the form will
create roles that do nothing — which is the state the repo is in today.
