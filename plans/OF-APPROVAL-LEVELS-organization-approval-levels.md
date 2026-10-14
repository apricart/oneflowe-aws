# OF-APPROVAL-LEVELS — Phase 1: per-organization order approval levels

Phase 1 of the amount-based approval work discussed in
`plans/OF-JOIN-department-signup-multi-user.md`. **Level 1 is the highest
level, with the highest amount**, as in that plan's original request.

> **Revised 2026-10-14.** The first version shipped the opposite direction
> (Level 1 lowest, each level approving orders *up to* its amount). Super Admin
> asked for Level 1 to be the highest level, approving orders *equal to or
> above* its amount. Only the ordering rule and the wording changed; the
> storage, endpoints and schema shapes are as before. The column keeps its name
> `max_amount_cents` (the API field `maxAmountCents`): it now holds the level's
> threshold, the smallest order that level approves. Renaming it would need a
> migration and a breaking API change for no behaviour, so it is left for a
> later release if wanted.

## What is being asked

1. A per-organization feature, **Order approval levels**, that Super Admin
   switches on or off.
2. It is on both **Create** and **Edit Organization**.
3. Switching it on shows **Level 1 approver** with an amount field. "Add level"
   adds Level 2 with its own amount, then Level 3, and so on, as many as
   needed.
4. A level's amount means: an order **equal to or above** that amount can be
   approved by a user who holds that level. Level 1 is the highest level.
5. **Only Super Admin** may switch it on or off, or change the levels.

## Scope of this phase

**Configuration only.** This phase stores, validates, audits and edits each
organization's switch and levels. It does **not** change how any order is
approved. Nothing in the order path reads these values yet, and the form says
so. The rest comes in later phases:

* assigning users to levels;
* routing an order to its level;
* the approve/reject checks;
* notifications.

The plan for those is in `plans/OF-JOIN-department-signup-multi-user.md`
(Part A).

So there is no behaviour change for any tenant, and no risk to any order, from
this phase.

## Decisions

1. **Amounts must strictly fall.** Level 1 has the highest amount; Level 2's
   must be lower than Level 1's, and so on. A level whose threshold is no lower
   than the level above it would add nothing. Equal amounts are refused for the
   same reason.
   *Open for phase 2:* who approves an order below the lowest level's amount,
   and whether a higher level may also approve a smaller order (a ceiling) or
   only its own band. Phase 1 stores the thresholds only, so neither question
   changes anything yet.
2. **Levels are positional and contiguous.** The request carries an ordered
   list; level number = position (1, 2, 3, …). Gaps are impossible by
   construction.
3. **Only the last level can be removed.** Removing a middle level would
   renumber every level after it. Once users are assigned to level numbers
   (phase 2), that would silently move someone's approval authority. The
   form therefore offers Remove on the highest level only. That keeps the
   React list keys stable too (the level number), with no module-level counter.
4. **Switching off keeps the levels.** Re-enabling restores them, like the
   ordering-block limits, which are kept while their block is off. On Edit, a
   disabled save sends `{ enabled: false }` with no `levels`, and the server
   leaves the stored levels untouched. Levels may also be sent while disabled,
   and are then validated and replaced.
5. **Switching on requires at least one level.** It is enforced in the form,
   the schema and the server.
6. **Bounds.**
   * At most **10** levels (`MAX_APPROVAL_LEVELS`).
   * Each amount is greater than 0 and at most PKR 1,000,000,000.00.
   * Amounts are stored and sent as **integer cents**. The form accepts digits
     with optional thousands commas and at most two decimals. Anything else is
     refused, never coerced. No floating-point arithmetic.
   * The bounds live in one place: `lib/order-approval-levels.ts`. The schema,
     the form and the database checks all hold them.
7. **Storage.**
   * The switch is a column, `organizations.order_approval_levels_enabled`,
     off by default.
   * The levels are a child table, `organization_approval_levels`. Phase 2
     will hang user assignments off the level rows.
   * `GET /api/v1/organizations` returns whole organization rows to tenant
     roles, so those roles see the boolean. That is acceptable: it is not a
     secret. The levels themselves are read only through a Super Admin
     endpoint.
8. **Edit follows the private-network-login precedent.**
   * `GET`/`PUT /api/v1/organizations/[id]/approval-levels`, Super Admin only.
   * `PUT` replaces the switch and the whole list in one transaction, under
     `FOR UPDATE` on the organization row.
   * Create sends `orderApprovalLevels` inside the existing organization
     `POST`, in its existing transaction.
   * The organization `PATCH` is not touched.
9. **An unchanged save writes nothing.** The Edit dialog saves this section
   every time, so a `PUT` that changes nothing writes no rows and no audit
   entry. The audit trail then records only real changes.

## Work

### Database — `drizzle/20261017120000_add_organization_approval_levels.sql`

Hand-written, like the recent migrations, with a journal entry at
`last + 3600000`.

* `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS
  order_approval_levels_enabled boolean NOT NULL DEFAULT false`. A constant
  default, so Postgres does not rewrite the table.
* `CREATE TABLE organization_approval_levels`:
  * `organization_id` → `organizations ON DELETE CASCADE`
  * `level smallint`, `max_amount_cents bigint`, `created_by uuid`,
    `created_at`
  * `UNIQUE (organization_id, level)`
  * checks: `level BETWEEN 1 AND 10`; `max_amount_cents BETWEEN 1 AND
    100000000000`

Rollback, after reverting the code:

```sql
DROP TABLE IF EXISTS organization_approval_levels;
ALTER TABLE organizations DROP COLUMN IF EXISTS order_approval_levels_enabled;
```

### Pure logic — `lib/order-approval-levels.ts`

* the bounds;
* `parseApprovalLevelAmountDraft` (PKR text → cents) and
  `approvalLevelAmountText` (cents → text for the input);
* `formatApprovalLevelAmount` (cents → "PKR 40,000.00" for labels);
* `approvalLevelsError` (the list rule, shared by Zod and the form);
* the draft helpers `approvalLevelDraftErrors`, `approvalLevelDraftsError`
  and `toApprovalLevelsPayload`;
* `approvalLevelsChanged`;
* the audit action name.

### Validation — `lib/server/mutation-validation.ts`

`orderApprovalLevelsSchema`:

```
{ enabled: boolean, levels?: [{ maxAmountCents: int }] }
```

It is strict, refuses strings for amounts, and applies `approvalLevelsError`
through `superRefine`. `organizationCreateSchema` gains an optional
`orderApprovalLevels` field.

### Server — `lib/server/order-approval-levels.ts`

* `loadOrganizationApprovalLevels(executor, organizationId)`
* `replaceOrganizationApprovalLevels(tx, …)`: delete, then insert.
* `saveOrganizationApprovalLevels({ organizationId, input, actor })`: one
  transaction that locks the organization `FOR UPDATE`, compares with what is
  stored, replaces, and writes `UPDATE_ORDER_APPROVAL_LEVELS` with before and
  after values through `recordAuditEvent(tx, …)`.

### Endpoints

| Route | Change |
|---|---|
| `POST /api/v1/organizations` | Optional `orderApprovalLevels`. Absent = off with no levels. Written in the creation transaction, and recorded in the `CREATE_ORGANIZATION` metadata. |
| `GET /api/v1/organizations/[id]/approval-levels` | **New.** Super Admin only. Returns `{ enabled, levels: [{ level, maxAmountCents }] }`. 400 for a malformed id, 404 for an unknown organization. |
| `PUT /api/v1/organizations/[id]/approval-levels` | **New.** Super Admin only. Delegates to `saveOrganizationApprovalLevels`. Returns the saved state and `changed`. |

No Viewer marker goes in any write handler (`lib/viewer-access.test.ts`).

### UI

* `components/organizations/order-approval-levels-fields.tsx`:
  * the switch;
  * one row per level, "Level N approver — approves orders from (PKR)",
    each with its own inline error;
  * "Add approver level" (disabled at 10);
  * Remove on the last level only;
  * the phase note.
* `app/(portal)/organizations/page.tsx`:
  * **Create:** state, payload, reset, and submit blocked while the levels
    are invalid.
  * **Edit (Super Admin only):** levels loaded on open. A failed load leaves
    the stored levels unchanged and shows a warning, as private network login
    does. A fourth argument to `editOrganization` sends the `PUT`.

## Security

* **Authorization.** Super Admin only, checked in every handler with
  `requireApiRole(["SUPER_ADMIN"])`. Head Office's Edit dialog never shows the
  section and never sends the `PUT`. Organization creation is already Super
  Admin only.
* **Validation.** The schema is strict, amounts are JSON integers only, every
  bound is held in Zod and in the database checks, and the id is checked as a
  positive integer. Mass assignment is impossible: the server writes only
  `enabled` and the amounts.
* **Tenant isolation.** The organization comes from the path and is used only
  to scope the Super Admin's own write. No tenant user reaches these endpoints.
* **Concurrency.** The organization row is locked `FOR UPDATE` and the
  replacement happens in one transaction. `UNIQUE (organization_id, level)`
  backs it up.
* **Audit.** `CREATE_ORGANIZATION` metadata, and
  `UPDATE_ORDER_APPROVAL_LEVELS` with before and after values for every real
  change.
* **WAF.** Ten levels is about 300 bytes of JSON, far under the 8 KB limit.

## Tests

* **Unit** (`lib/order-approval-levels.test.ts`):
  * the parser at its edges (blank, 0, negative, letters, three decimals,
    commas, the maximum and one past it);
  * strictly falling, Level 1 highest (equal refused);
  * at most 10 levels;
  * enabled with no levels refused;
  * the payload builder (disabled omits levels);
  * change detection.
* **Schema** (`lib/server/order-approval-levels-schema.test.ts`): strict, an
  integer only, a string refused, 11 levels refused, enabled without levels
  refused, disabled without levels accepted.
* **Component** (`components/organizations/order-approval-levels-fields.test.tsx`):
  * Level 1 appears on enable;
  * Add creates Level 2;
  * Remove only on the last level;
  * per-level errors shown;
  * Add disabled at the maximum;
  * nothing shown while off.
* **Contract** (`lib/server/order-approval-levels-contract.test.ts`):
  * only the two routes and the server module write the table and the column;
  * both handlers are Super Admin only;
  * the lock is `FOR UPDATE`;
  * no Viewer marker.

  The new route also goes on `lib/server/activity-audit-coverage.test.ts`
  (`VIA_LIB`).
* **Integration** (`tests/integration/organization-approval-levels-api.test.ts`):
  * 401 when signed out;
  * 403 for Head Office, Branch Admin, Group User and Order Portal on both
    methods;
  * create with and without levels;
  * enable, edit and disable (levels kept);
  * each validation failure stores nothing;
  * an unchanged save writes no audit row;
  * before and after values in the audit;
  * 404 and 400 ids;
  * the database checks refusing raw invalid writes;
  * cascade on organization delete.

## Risk and rollback

There is no behaviour change for any tenant: nothing reads the values yet, and
the column defaults to off. Rollback is reverting the code and running the
two statements above. **Apply the migration before deploying**, because the
organization `POST` and the new route select the column.
