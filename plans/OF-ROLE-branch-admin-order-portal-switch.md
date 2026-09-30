# OF-ROLE — Switching a user between BRANCH_ADMIN and ORDER_PORTAL

## What is being asked

1. Let an administrator switch a user between `BRANCH_ADMIN` and `ORDER_PORTAL`
   from the user-management screen.
2. Refuse the switch while that user still has an order in flight — every order
   they raised must have reached the end of its lifecycle first.
3. Record **the role the creator held when the order was raised**, so a later
   role change cannot rewrite history.
4. Leave every existing report reading the same numbers it reads today.

Requirements 2 and 3 are the substance. Requirement 1 is, on its own, one
`disabled` attribute.

## What already exists

`PATCH /api/v1/users/[id]/access` is already the only endpoint permitted to
change a role, and it already authenticates, authorizes through
`canAssignRole`/`canManageUser`, fences Head Office to its own tenant, validates
the role's row shape, writes role + scope + audit in one transaction, deletes
every session row and bumps `sessionVersion`.

`BRANCH_ADMIN` (level 3) and `ORDER_PORTAL` (level 1) are both below Head Office
(level 5), so the privilege ladder needs no change. Both are single-branch
roles with identical row shape — `organizationId` and `branchId` required, no
group assignments — so neither `getAssignmentError` nor `resolveNextScope` has
anything to do for this transition. `resolveNextScope` returns `action: "none"`.

The Head Office table already routes `role` into the access body
(`accessKeys`, `buildUserUpdate`). Only `<Select disabled ...>` at
`components/users/head-office-users-table.tsx:416` stands in the way.

## Decision 1 — what "completed its lifecycle" means

Reuse, do not restate. `lib/budget-consumption.ts` already derives the two
in-flight buckets from `getOrderStatusesForFilter`:

```
CONSUMED_HELD_STATUSES = PENDING + APPROVED
```

That is exactly "raised and not yet settled": the order still holds budget and
still awaits a decision or a fulfilment. `FULFILLED` / `PARTIAL` /
`PARTIALLY_FULFILLED` have moved the money and released the hold; `REJECTED`,
`CANCELLED` and `REFUNDED` carry nothing. So the blocking set **is**
`CONSUMED_HELD_STATUSES`, imported rather than re-typed — the same discipline
`CLAUDE.md` imposes on every other reader of the status buckets.

There is no separate pending-refund state to consider: a refund is recorded
directly on the order (`refundedAt`, `statusAtRefund`, `refundAmountCents`), and
`REFUND_REQUESTED` is an activity-log action, not an order status.

The block is a hard one and returns **409** (state-machine violation, per rule
05). It is enforced in the route, not the dialog — the dialog only previews it.

## Decision 2 — record the creator's role on the order

Add `orders.created_by_role`. Precedent is on the same table:
`status_at_refund` already stores a point-in-time snapshot precisely because the
live value moves on.

Sequencing follows rule 06 (additive first, never drop in the release that stops
using a thing):

1. Migration adds a **nullable** `created_by_role varchar(32)`.
2. Every order insert populates it from the creating session's role.
3. Every reader resolves it as `COALESCE(orders.created_by_role, roles.name)`.
   Before the backfill this reproduces today's behaviour exactly for historical
   rows; after it, the join is dead weight but harmless.
4. A dry-run, digest-gated backfill script fills history from each creator's
   current role.
5. A later release may drop the fallback. Not this one.

Nullable plus COALESCE is what keeps this safe against a live `orders` table: no
bulk `UPDATE` is required for the feature to be correct, and the backfill can be
run in its own window.

One honest caveat for the backfill: the single KE account moved to
`GROUP_ORDER_PORTAL` on 2026-09-18 will have its earlier `ORDER_PORTAL` orders
stamped `GROUP_ORDER_PORTAL`. Both are in `ORDER_CREATOR_ROLES`, so no report
changes; only the `createdByRole` list tab would misfile those rows. Recorded
here rather than special-cased.

## Decision 3 — reporting

Five readers key on the creator's role. Four move to the recorded role; one
deliberately does not.

| Reader | Today | After |
|---|---|---|
| `app/api/v1/orders/route.ts` `addOrderCreatorRoleCondition` | EXISTS on `users`→`roles` | recorded role, falling back to the join |
| `app/api/v1/analytics/users/performance/route.ts` | `inArray(roles.name, ORDER_CREATOR_ROLES)` | recorded role |
| `app/api/v1/analytics/users/list/route.ts` | users whose *current* role is a creator role | **union**: current creator roles ∪ anyone with a recorded creator-role order |
| `lib/server/budget-burn-queries.ts` | `role: roles.name` fed to `isOrderCreatorRole` | recorded role |
| `lib/server/order-notifications.ts` | `inArray(roles.name, ORDER_CREATOR_ROLES)` | **unchanged** |

`order-notifications.ts` stays on the live role on purpose: it decides who to
notify *now*, which is a question about the person's present role, not about the
order's history.

`analytics/users/list` needs the union, not a swap. It populates a filter
dropdown. Keyed on the recorded role alone, a person who has not yet raised an
order disappears from it; keyed on the current role alone, a promoted requester
disappears and their historical orders become unfilterable. Both halves are
required for "nothing breaks in reporting".

### The contract test

`lib/server/group-order-cross-role-visibility.test.ts` asserts the literal
string `inArray(roles.name, [...ORDER_CREATOR_ROLES])` appears in
`performance/route.ts` and `list/route.ts`. Changing those routes breaks it.

The test is **updated deliberately, not weakened**. Its guarantee — *both*
requester roles count, and `ORDER_PORTAL` is never named alone — is what
matters and is preserved; only the expression carrying it changes. The
`not.toContain` assertions stay as they are, and equivalents are added for the
recorded-role form.

## Scope

In: all four branch and group roles — `BRANCH_ADMIN`, `ORDER_PORTAL`,
`GROUP_USER`, `GROUP_ORDER_PORTAL` — in every direction, from the Head Office
table. Twelve transitions.

Out: `HEAD_OFFICE` (a tenant-wide role, and `canAssignRole` refuses it to a Head
Office administrator anyway), the Super Admin table (no role field at all), and
any override of the in-flight block.

## Decision 4 — the group roles: two shapes, not four roles

The four roles reduce to two row shapes, and that is what makes the matrix
tractable:

| Shape | Roles | `branch_id` | Assignments |
|---|---|---|---|
| Single-branch | `BRANCH_ADMIN`, `ORDER_PORTAL` | **required** | forbidden |
| Group-based | `GROUP_USER`, `GROUP_ORDER_PORTAL` | **must be null** | **≥1 required** |

So the twelve transitions are four classes, and only the two cross-shape classes
need anything from the administrator:

* **single → single** and **group → group**: nothing new. A group→group switch
  with the scope untouched sends no lists at all, so `resolveNextScope` returns
  `action: "none"` and the existing assignment rows — including who granted them
  and when — survive rather than being deleted and reinserted identically.
* **single → group**: the dialog must collect at least one group or branch, and
  clear the pinned branch. `validateMultiBranchScope` refuses an empty scope,
  because a group user with no assignments reaches nothing.
* **group → single**: the dialog must collect a branch, and the server deletes
  every assignment (`action: "clear"`).

`budgetAllocationEnabled` needs no special handling: it is already zeroed on the
way out of `GROUP_USER`, defaults to off on the way in, and every read re-checks
`role === "GROUP_USER" && flag` — including at session build, so a stale token
cannot carry it.

## Decision 5 — the reporting hole the group roles open

`created_by_role` fixes attribution for orders, but the group roles have a second
historical dependency that it does not cover.

A `GROUP_ORDER_PORTAL` user has no `users.branch_id`. It reaches branches through
`user_group_assignments`/`user_branch_assignments`, which
`resolveUsersScopedToBranches` reads to decide who belongs to a branch in the
requester filter list. **Those rows are deleted when the user leaves the group
role.** After the switch, nothing connects that person to the branches they spent
months ordering for: their orders stay in each branch's totals while the person
disappears from the filter meant to select them. The figures stop being
reconcilable against the people who produced them.

`analytics/users/list` therefore asks three questions, not two — pinned branch,
assignment, **and an order actually raised there**
(`raisedOrderAtBranchesSql`). `orders.branch_id` does not move and
`orders.created_by_role` does not change, so the third arm survives both the role
change and the assignment clear. An empty branch list matches nothing, never
everything.

### What was checked and needed no change

* **`group_orders`** needs no `created_by_role`: `loadRequesterNames` joins
  `users` for the requester's *name* only, and the report is scoped by the
  caller's live assignments (`requireGroupApprover`), not the creator's role.
* **`group_audit_logs`** already stores `performed_by_role`, so group actions are
  already attributed to the role held at the time.
* **`analytics/summary`, `analytics/refunds`, `executive-analytics-scope`,
  `order-decision-policy`, `group-user-budget-allocation`** all read the
  **caller's own current role** to scope a request. That is what they should
  read, and none of them was touched.
* **`sales-performance`** excludes `SUPER_ADMIN` creators; no switchable role
  crosses that line.
* **`budget_addons`** records no role, and nothing reports on one.

## Decision 6 — the departing approver

`GROUP_USER` is the only group role that decides orders. Moving one off that role
removes an approver from its branches, but strands nothing: `BRANCH_ADMIN` and
`HEAD_OFFICE` can still approve every one of those orders. Refusing the change
would be obstruction; saying nothing would hide a real operational consequence.

So it is **advisory**: `loadRoleChangeReadiness` counts the orders still awaiting
a decision across the departing approver's assigned branches and the dialog
states the number. It never blocks, and it is 0 for an approver with no
assignments — an empty scope reaches no branches, never all of them.

### Mirrored accounts — refusal reversed

An earlier revision of this plan refused a role change on any account with
`external_source` set. The reason was `sync:ke`: it backfills a "missing" role
for anyone who still has a branch-pinned account
(`lib/legacy-import/ke-sync.ts:790,813`), so switching one half of a `-ba`/`-op`
pair would have made the next run create a third account.

**The K-Electric migration is complete and the legacy sync is not run again**, so
that reason no longer holds and the refusal was removed — it would otherwise have
locked the role field on the bulk of organization 10, which is most of the users
an administrator actually needs to switch.

Nothing else about a mirrored account changed, and two things were checked rather
than assumed:

* **Email login stays blocked.** `loadStaffLoginRecord` keys on
  `external_source`, not on role, so a mirrored person still signs in by username
  only. An integration test asserts `external_source`, `external_id` and
  `username` are all untouched by the switch.
* **The username suffix becomes cosmetically wrong** — `…-ba` holding
  `ORDER_PORTAL`. The account is not renamed and the person keeps signing in with
  it. Support reads that suffix as the role, so the dialog says so
  (`usernameSuffixWarning`) instead of blocking.

A mirrored account is still held to the lifecycle rule like any other.

## Work — as built

1. `db/schema.ts` + `drizzle/20260928120000_add_order_created_by_role.sql` —
   nullable `created_by_role`, a column comment, and a partial index on
   `(created_by_role, created_by_user_id) WHERE created_by_role IS NOT NULL`.
   Hand-written, because `db:generate` was broken when this was written — now
   fixed, see below.
1b. `drizzle/20260928130000_snapshot_baseline.sql` — repairs the migration
   tooling. See "The snapshot baseline".
2. `lib/server/order-creator-role-sql.ts` — `effectiveCreatorRoleSql`,
   `isRequesterCreatedOrderSql`, `orderCreatedByRoleMatches`,
   `hasRaisedOrderAsRequesterSql`. The fallback is stated once, here.
3. Write path: orders POST (`context.role`), group-order fan-out
   (`context.actor.role`), KE order import (literal `ORDER_PORTAL`, the only
   role it resolves a creator to).
4. `lib/role-change-preconditions.ts` — pure. `ROLE_CHANGE_BLOCKING_STATUSES`
   is `CONSUMED_HELD_STATUSES`, imported.
5. `lib/server/role-change-readiness.ts` — one grouped aggregate, so the two
   counts cannot come from two different instants.
6. `PATCH .../access` enforces the block (409) via `getRoleChangeBlock`;
   `GET .../access` previews it behind the same tenant fence.
7. All four reporting readers moved; `order-notifications.ts` deliberately not.
8. UI: the select offers all four roles and is enabled only once the server says
   the user is clear. `MultiAssignSelector` was extracted from the create dialog
   to `components/users/multi-assign-selector.tsx` and is now shared, so the two
   screens grant scope through one control. `GroupScopeFields` collects the
   groups and branches, seeded from `/scope` so an administrator sees the reach
   the user already has. Changing role clears the other shape's fields, and the
   form refuses an empty group scope or a missing branch before submitting.
   `RoleSwitchNotice` states the obstruction, the sign-out, the assignments
   about to be removed, the departing-approver count, the username-suffix
   mismatch, and — for a mirrored account — that username-only sign-in is
   unaffected.
9. Tests: `lib/role-change-preconditions.test.ts` (21),
   `lib/server/order-creator-role.test.ts` (13 — the reader/writer control, plus
   the branch-history arm), `tests/integration/requester-role-switch.test.ts`
   (43 against a real database, including **all twelve transitions** asserting
   the row shape each one lands in, every refusal of an invalid shape, the
   group→group scope carry-over, and two end-to-end reporting-continuity tests).
   Two existing contract tests updated deliberately — see below.
10. `scripts/backfill-order-creator-roles.ts` + `backfill:order-creator-roles`.
    Dry-run by default, digest-gated, batched at 5,000 rows, advisory-locked,
    writes only NULL rows so it is re-runnable, and reports orders whose creator
    row is gone rather than inventing a role for them.

### Contract tests updated, not weakened

Two files asserted on the old expression and would have failed:

* `lib/server/group-order-cross-role-visibility.test.ts` — "counts both
  requester roles in user performance" now looks for
  `isRequesterCreatedOrderSql` and additionally asserts that module is built
  from `ORDER_CREATOR_ROLES`. The `not.toContain('eq(roles.name,
  "ORDER_PORTAL")')` guarantee is untouched.
* `lib/server/multi-branch-order-scope.test.ts` — the SQL-injection guard on the
  `createdByRole` filter. The predicate moved modules, so the assertion follows
  it: the value is still bound through drizzle's `eq`, and the new module is
  additionally asserted to contain no `sql.raw(`.

## The snapshot baseline — fixing `db:generate`

`drizzle-kit generate` diffs `db/schema.ts` against the newest snapshot in
`drizzle/meta`. Snapshots stopped being written after `20260709000000`: every
migration since was hand-written, and a hand-written migration does not update
the snapshot. There were 19 snapshots for 67 journal entries.

So the newest snapshot was eleven weeks stale — 42 tables, a 32-column `orders`,
no `auth_sessions` — and `db:generate` emitted a 44 KB "migration" of 18 CREATE
TABLE, 76 CREATE INDEX and 118 ALTER TABLE statements for objects that already
exist everywhere. It contained no DROP, but it would have failed on the first
existing object, and the real hazard was that it looked like a normal migration.

**The fix**: keep the generated snapshot, which is an accurate picture of the
current schema, and replace the generated SQL with a no-op
(`20260928130000_snapshot_baseline.sql`, a documented `SELECT 1`). That
re-baselines the diff without touching any database.

**Discarding that SQL was verified safe, not assumed safe.** `db/schema.ts` was
compared column by column against a database migrated from this journal alone:
**662 columns on each side, zero drift in either direction**. Every object the
diff described already existed because the journal's hand-written migrations
created them — they were simply never snapshotted.

Proof it works, all run:

* `db:generate` on the clean schema: *"No schema changes, nothing to migrate"* —
  previously 44 KB.
* A throwaway probe column added to `db/schema.ts` produced a correct **66-byte**
  incremental migration, then was reverted.
* `db:migrate` applied both new entries to the test database (`applied 2`).
* A **brand-new** database migrated from scratch applied all 69 entries and came
  out matching `db/schema.ts` exactly — 662 columns, zero drift. This is the CI
  path, so the no-op baseline does not break a fresh install.
* `db:validate` passes; every journal tag has a matching `.sql` file.

Left alone deliberately: ten `.sql` files are not in `_journal.json`
(`0019_add_performance_indexes.sql`, `MANUAL_RUN_THIS.sql` and eight others) and
are therefore never applied by `db:migrate`. They are historical one-offs and the
from-scratch migration above proves they are not load-bearing.

**The rule going forward** is in the baseline file's own header: use
`npm run db:generate` and let it write both the SQL and the snapshot. Hand-writing
a migration re-staleness the snapshot and hands the next person this same problem.

## Defects found by the test pass, and fixed

The dedicated test pass over this feature found five. Three were mine, two were
pre-existing but reachable through the new control.

**1. The budget-burn aggregate split a creator and lost their money.** The worst
of them, and it only appears once this feature is used. Keying the aggregate's
`GROUP BY` on the **per-row** recorded creator role meant a person whose role
changed mid-window had orders carrying two different roles and so became two
rows. The panel keys creators on `userId:branchId` (`creatorKey`), so
`unionCreators` hit its `if (byKey.has(key)) continue` and **silently dropped one
row**: a requester who consumed ₨1,000,000 was reported at ₨700,000. Fixed by
`aggregatedRequesterRoleSql`, which collapses the role to one value per group
(a requester role if any order in the window was raised under one). Pinned by
`tests/integration/role-switch-reporting-integrity.test.ts`, which was confirmed
to fail — 700,000 against an expected 1,000,000 — with the fix reverted.

Note the row-count assertion alone would *not* have caught it: the count stayed
1 because the row was dropped rather than duplicated. The money assertion is the
control.

**2. The group picker was always empty.** `GET /api/v1/groups` answers under
`groups`; the new picker read `items`. No group could ever be selected, making
every move into a group role impossible from the UI. Found by the E2E run.

**3. The readiness check was a read-then-write across two statements.** Decided
before the transaction, so an order raised in between would slip past a rule that
says there are none — the TOCTOU shape rule 06 forbids. It now runs on the
transaction handle, immediately before the write. The residual (another
transaction committing during the switch) is documented and benign: the order is
stamped with its creator's role at creation and the switch kills that session.

**4. A soft-deleted account could have its role changed.** Pre-existing on this
route and harmless while the role field was disabled. Both the read and the write
now require `deleted_at IS NULL` and answer 404.

**5. `Role *` and `Branch Assignment *` were not associated with their controls.**
`<Label htmlFor>` pointed at ids nothing carried, so both were unlabelled for
assistive technology — a rule 09 violation, found because the E2E test could not
reach them by label either. Both now carry the matching `id`.

Two UI consistency gaps were closed while there: the Save button now refuses a
group role with no assignment (it already refused a single-branch role with no
branch), and the branch requirement is stated live beside the field rather than
only on submit.

### Two harness defects, also fixed

* **The E2E suite could not start.** `destroyActivityLogE2E` never cleaned
  `notifications`, which reference the seeded users, so any run that produced one
  left the *next* run's teardown failing on the foreign key before a single test
  executed.
* **Seeded E2E users had no first or last name**, and the edit dialog requires
  both before it will save — so no UI journey that saves a user could run. The
  seed now derives them from `fullName`.

## Verification

`npm run typecheck`, `npm run lint` (0 errors), `npm test` (3495 passed),
`npm run build`, and `npm run db:validate` all pass.

`npm run test:integration` **ran** against the Docker test database — all 22 files,
537
passed.

`npm run e2e` — the three browser journeys pass against a real Next.js server:
the guard refusing a switch while an order is in flight, the full cross-shape
journey (Branch Admin → Order Portal → `/shop`, then → Group Order Portal →
`/group-portal`), and a Group User moving to a pinned role being made to supply a
branch.

### On the "pre-existing" integration failure

Earlier revisions of this plan recorded
`executive-analytics-api.test.ts > "lets Super Admin see both tenants in one
grid"` as a pre-existing failure on `dev`. That was correct as far as it went —
it did fail with this branch stashed — but the cause was **local test-database
pollution, not a defect**. The database had accumulated 33 organizations and 383
users across runs whose teardown had failed part-way (the same foreign-key
pattern as the E2E harness defect above), and the extra rows pushed the expected
row past the matrix query's cap.

Dropping, recreating and re-migrating `oneflowe_test` makes the whole suite pass.
CI provisions a fresh service-container database on every run, so it was never
failing there. A local suite that has ever errored in teardown should be reset
before its results are trusted.

The backfill was exercised end to end on the test database: 54 rows filled, a
re-run reported 0 to fill, and a wrong digest was refused.

## Where these tests run

Unit and contract tests are picked up by `npm test` (they live beside the code).
The two integration files match `tests/integration/**/*.test.ts`, which
`npm run test:integration` already globs.

The E2E spec needed wiring: both `.github/workflows/dev-check.yml` and
`.github/workflows/deploy-test.yml` run `npm run e2e:smoke`, which named the
role-smoke spec alone. That script now runs `role-switch.spec.ts` as well, so the
browser journeys gate every PR to `dev` **and** every test deployment without
either workflow changing.

`role-switch.spec.ts` changes two seeded users' roles and does not restore them.
It sorts last among the E2E specs and the seed upserts `role_id` on every run, so
this is safe — but a spec added after it alphabetically must not assume the
seeded roles, which is recorded in the file's own header.

## Risk and rollback

The column is additive and nullable; reverting the code leaves it unread. The
reporting change is the real risk — it is covered by the contract test plus the
integration oracle, and the COALESCE means a missing backfill degrades to
current behaviour rather than to wrong numbers.
