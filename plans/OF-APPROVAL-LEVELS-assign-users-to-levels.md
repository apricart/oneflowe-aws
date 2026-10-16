# OF-APPROVAL-LEVELS — Phase 2a: assign users to approval levels

Builds on `plans/OF-APPROVAL-LEVELS-organization-approval-levels.md` (phase 1:
the per-organization switch and levels; Level 1 is the highest, each level
approves its own band of order amounts, and the lowest level's band reaches
down to zero).

## What is being asked

When Super Admin or Head Office **creates or edits** a user who approves orders,
and the user's organization **requires order approval** and **has approval
levels switched on**, they can give that user one of the organization's levels.

## Scope

**Assignment only.**

* It stores, validates, audits and edits each user's level.
* It does **not** change how any order is approved. No order path reads the
  level yet.
* Routing orders to levels and enforcing them at approve, reject and return
  time is phase 2b. The two questions phase 1 left open are now settled (see
  the phase 1 plan): strict bands, so a higher level does not also approve a
  smaller order, and an order below the lowest level's amount goes to the
  lowest level.

## Decisions

1. **Who may hold a level** — the roles that can decide that organization's
   orders today:
   * `GROUP_USER`, always;
   * the organization's configured `order_approver_role` (`BRANCH_ADMIN`, or
     `HEAD_OFFICE`).

   Anyone else is refused. The rule is `canHoldApprovalLevel`, a pure function
   in `lib/order-approval-levels.ts`. The form and both write paths use it.
2. **When a level may be given.** The organization must have
   `order_approval_required` and `order_approval_levels_enabled` both on. The
   level must be one of its current levels, `1..levelCount`.
3. **Optional, at most one level per user.** No level (null) is allowed.
4. **Storage.** `users.order_approval_level integer NULL`, with
   `users_order_approval_level_ck` holding it to 1..10 (`MAX_APPROVAL_LEVELS`).
   The column is nullable with no default, so existing rows are untouched and
   adding it is instant.
5. **A level that stops applying is kept, but inert.** If the organization
   switches levels or approval off, or changes its approver role, the stored
   level stays: it is shown and assignable again only while eligible. Phase 2b
   re-checks eligibility at decision time.

   There is one exception: changing a user's **role or organization** through
   `PATCH /users/[id]/access` clears the level, in the same transaction. A
   level means nothing in another role or tenant, and it must not come back if
   the user is switched back later.
6. **Removing a level someone holds is refused.**
   `PUT /organizations/[id]/approval-levels` with fewer levels than stored
   answers **409** while any non-deleted user of that organization holds a
   removed level. The message names the level and the count. The check runs
   under the same organization `FOR UPDATE` lock as the replacement, and every
   assignment write takes that row `FOR SHARE`. So a level cannot be assigned
   while it is being removed, nor removed while it is being assigned. No user
   ever silently loses a level.
7. **Assigning does not log the user out.** `PATCH /users/[id]/access` bumps
   `session_version` and drops every session on any change. The level is not
   part of the session, so it gets its own endpoint, as private network login
   did.

## Work

### Database — `drizzle/20261018120000_add_user_order_approval_level.sql`

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS order_approval_level integer;
ALTER TABLE users ADD CONSTRAINT users_order_approval_level_ck
  CHECK (order_approval_level IS NULL OR order_approval_level BETWEEN 1 AND 10) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_order_approval_level_ck;
```

Every existing row holds null, so the validation is quick, and `NOT VALID`
first keeps the `ACCESS EXCLUSIVE` lock momentary.

Rollback, after reverting the code:

```sql
ALTER TABLE users DROP COLUMN IF EXISTS order_approval_level;
```

### Pure logic — `lib/order-approval-levels.ts`

* `canHoldApprovalLevel(role, organization)`;
* `approvalLevelAssignmentRefusal({ role, organization, levelCount, level })`
  — the message, or null;
* `USER_APPROVAL_LEVEL_AUDIT_ACTION = "ASSIGN_ORDER_APPROVAL_LEVEL"`.

### Server — `lib/server/user-approval-level.ts`

* `loadApprovalLevelContext(executor, organizationId, lock)`: the
  organization's approval switch, level switch, approver role and level count.
  It reads `FOR SHARE` inside a write.
* `assertAssignableApprovalLevel(tx, …)`: used by user creation inside its
  transaction.
* `setUserApprovalLevel({ scope, targetUserId, level })`: one transaction. It
  locks the target user `FOR UPDATE` and its organization `FOR SHARE`, checks,
  writes, and records `ASSIGN_ORDER_APPROVAL_LEVEL` (before/after) through
  `recordAuditEvent(tx, …)`. An unchanged save writes nothing.
* `heldRemovedLevels(tx, organizationId, keepCount)`: used by the levels
  `PUT`.

### Endpoints

| Route | Change |
|---|---|
| `POST /api/v1/users` | Optional `orderApprovalLevel` (integer 1..10 or null). Checked and written inside the creation transaction under the organization `FOR SHARE` lock. 400 when the user may not hold it. Recorded in the `USER_CREATE` log. |
| `PUT /api/v1/users/[id]/approval-level` | **New.** `{ level: number \| null }`. Super Admin, or Head Office for a user in its own organization. Uses the same fence as the access route: `canManageUser`, the Head Office tenant check, never one's own account, and deleted users are 404. |
| `PATCH /api/v1/users/[id]/access` | Clears the level when the role or organization changes. |
| `GET /api/v1/users` | Returns `orderApprovalLevel`. |
| `GET /api/v1/organizations/[id]/approval-levels` | Opened to Head Office **for its own organization** (any other is 404), so its forms can list the levels. Adds `orderApprovalRequired` and `orderApproverRole`. `PUT` stays Super Admin only. |
| `PUT /api/v1/organizations/[id]/approval-levels` | 409 when a removed level is held (decision 6). |

### UI

* `components/users/approval-level-field.tsx`:
  * reads the organization's levels;
  * shows a select only when `canHoldApprovalLevel` allows it: "No level",
    then each level with its band, e.g. "Level 2 — PKR 40,000.00 to under
    PKR 80,000.00" (`approvalLevelBandText`);
  * shows nothing otherwise.
* **Create User** (step 2, under Role): sends `orderApprovalLevel`. The choice
  resets when the role or organization changes.
* **Edit User**: prefilled from the list row. After the existing access and
  profile saves, it sends the `PUT` only if the level changed.

## Security

* **Authorization.** Only `USER_MANAGEMENT_ROLES` (Super Admin, Head Office)
  can assign. Head Office is fenced to its organization, and no one can assign
  their own account.
* **Validation.** The organization comes from the target user's row, never
  from the request. Zod is strict and the level must be an integer.
* **Concurrency.** Writes are transactional and lock the rows described in
  decision 6.
* **Audit.** `audit_logs` for assignments, and `system_logs` for creation (as
  user creation already does).
* **Exposure.** Head Office learns only its own organization's level amounts.

## Tests

* **Unit:** eligibility and refusal rules.
* **Component:** the field shows only when eligible, and lists levels with
  their amounts.
* **Contract:** the writers of `orderApprovalLevel`, the role fence on the new
  route, and the audit-coverage entry.
* **Integration** (`tests/integration/user-approval-level-api.test.ts`):
  * the role matrix (401, 403, cross-tenant 404, self 403);
  * create with a level;
  * ineligible role, approval off or levels off refused;
  * a level above the count refused;
  * edit sets and clears the level;
  * a role change clears it;
  * removing a held level is 409, and freeing it allows the removal;
  * Head Office reads its own levels but not another organization's.

## Risk and rollback

There is no behaviour change for orders. Rollback is reverting the code and
dropping the column. **Apply the migration before deploying**, because the
users list selects the column.
