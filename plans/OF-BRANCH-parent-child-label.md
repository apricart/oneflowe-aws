# OF-BRANCH — Parent / child branch label

## Objective

When a branch is created, the administrator says whether it is a **parent**
branch, a **child** branch (and of which parent), or **standalone**. The label
is shown on the branch, the branch lists can be filtered by it, and the Branch
Report can be filtered by it and rolled up by parent.

**A label only.** Nothing about who may see, order, approve, spend, price or
stock anything changes. A parent's staff do not see a child's orders; a child's
budget, catalogue, prices, approvers and warehouse reach are its own, exactly as
today. Each of those would be a separate plan.

## Acceptance criteria

1. Create Branch (Super Admin on Organizations, Head Office on My Branches)
   asks "Branch type": Standalone (default) / Parent / Child. Child requires
   choosing a parent branch of the same organization.
2. Edit Branch (both dialogs) can change the type and a child's parent.
3. A child's parent must be a **parent** branch of the **same organization**.
   One level only: a parent is never a child, a child is never a parent, a
   branch is never its own parent.
4. A parent that still has children cannot stop being a parent (409); move or
   re-type its children first.
5. Every existing branch reads Standalone. The department sign-up and the
   K-Electric sync keep creating Standalone branches.
6. Branch lists (Super Admin Organizations page, Head Office My Branches) show
   the type and parent, and filter by type.
7. Branch Report: a Type column (with parent name), filters "Branch type" and
   "Parent branch" (a parent and its children), and a "Roll up by parent"
   toggle that folds children into one row per family. Exports follow the view.
8. Writes are audited (`CREATE_BRANCH` metadata, `UPDATE_BRANCH` before/after).

## Architecture

| Piece | Where |
|---|---|
| Labels, input rules, the edit planner, the report roll-up, query-param parsing — all pure | `lib/branch-hierarchy.ts` (+ `.test.ts`) |
| Parent lookup under lock, child count | `lib/server/branch-hierarchy.ts` |
| Create | `createBranchInTx` (`lib/server/branch-creation.ts`) takes an optional `hierarchy`; absent = Standalone, so the department sign-up is unchanged |
| Edit | `PATCH /api/v1/branches/[id]` — hierarchy change planned and checked inside the update transaction |
| Reads | `GET /api/v1/branches`, `GET /api/v1/branches/[id]`, `GET /api/v1/analytics/branches/performance` return `hierarchyRole`, `parentBranchId`, `parentBranchName` |
| UI | `components/branches/branch-hierarchy-field.tsx` (form field), `components/branches/branch-hierarchy-badge.tsx` (display) used by both dialogs pairs, both lists and the report |

No new endpoint, no new permission: the fields ride on the routes and the
roles that already create and edit branches (Super Admin anywhere, Head Office
in its own organization).

## API

`POST /api/v1/branches` — two optional fields:

- `hierarchyRole`: `"STANDALONE" | "PARENT" | "CHILD"` (default `STANDALONE`)
- `parentBranchId`: positive integer, required with `CHILD`, refused otherwise

`PATCH /api/v1/branches/[id]` — the same two, both optional. Sending
`parentBranchId` alone re-parents a child. Sending a non-child role clears the
parent.

| Case | Status |
|---|---|
| `CHILD` without a parent, a parent with a non-child role, unknown role | 400 |
| Parent not found in the branch's organization (incl. another tenant's id) | 400 |
| Parent is not a `PARENT` branch, or is the branch itself | 400 |
| Re-typing a parent that still has children | 409 |
| Concurrent change caught by the database guard | 409 |

`GET /api/v1/analytics/branches/performance` — two optional narrowing filters:

- `hierarchyRoles=PARENT,CHILD,STANDALONE`
- `parentBranchIds=1,2` — each named parent **and** its children

Both are bounded (≤ 3 roles, ≤ 200 ids), malformed values are 400, and both
only ever add predicates after the existing tenant/assignment scope — they
cannot widen a caller's reach.

## Data

Migration `20261024120000_branch_hierarchy.sql`, additive:

- `branches.hierarchy_role varchar(16) NOT NULL DEFAULT 'STANDALONE'` — a
  constant default, so Postgres adds it without a table rewrite.
- `branches.parent_branch_id integer NULL`.
- `branches_hierarchy_role_ck`: role in the three values.
- `branches_hierarchy_parent_ck`: `(role = 'CHILD') = (parent IS NOT NULL)` and
  `parent <> id`.
- `branches_parent_org_fk`: `(parent_branch_id, organization_id) →
  branches (id, organization_id)`, NO ACTION — the database refuses a parent in
  another organization, and refuses deleting a parent that still has children.
- `branches_parent_idx` on `parent_branch_id` (partial, non-null).
- Trigger `branches_hierarchy_guard_trg` (BEFORE INSERT OR UPDATE OF
  `hierarchy_role`, `parent_branch_id`): the parent must be a `PARENT` (read
  `FOR SHARE`), and a `PARENT` with children may not change role. Raises 23514
  with constraint `branches_hierarchy_guard`. This is the backstop; the routes
  check first and answer with a specific message.

Race: a child insert takes the parent `FOR SHARE`; re-typing the parent updates
its row (a conflicting lock), and the trigger then counts children with a fresh
snapshot. Either the child sees the new role and is refused, or the re-type sees
the child and is refused.

Rollback (after reverting the code):

```sql
DROP TRIGGER IF EXISTS branches_hierarchy_guard_trg ON public.branches;
DROP FUNCTION IF EXISTS public.branches_hierarchy_guard();
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_parent_org_fk;
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_hierarchy_parent_ck;
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_hierarchy_role_ck;
DROP INDEX IF EXISTS branches_parent_idx;
ALTER TABLE branches DROP COLUMN IF EXISTS parent_branch_id;
ALTER TABLE branches DROP COLUMN IF EXISTS hierarchy_role;
```

**Apply before deploying**: the branch reads select both columns.

## Security

- Authentication/authorization unchanged: the existing role allowlists and
  `resolveBranchCreationAccess` / `branchWriteRefusal` run first.
- Tenant: the parent is looked up with `organization_id = <the branch's own
  organization>` (never the request's), and the composite key refuses it in the
  database as well. Another tenant's branch id reads as "not found" (400), with
  no hint that it exists.
- Mass assignment: both fields are named in the strict Zod schemas; the patch
  sets them explicitly.
- Report filters are parsed and bounded, interpolated only as parameters, and
  applied after the scope predicates.
- Reads expose a parent's name only within the same organization (the key
  guarantees it); a Branch Admin already reads its own branch row.
- No price, budget or access rule reads the new columns.

## Tests

- Unit `lib/branch-hierarchy.test.ts`: input rules, the edit planner (every
  transition, self-parent, no-op), roll-up arithmetic and naming, param parsing
  and bounds, describe/label.
- Unit for the schema fields (strict, unknown role refused).
- Integration `tests/integration/branches-api.test.ts`: create parent / child,
  child without parent, child of a non-parent, child of another tenant's branch,
  re-parent, re-type a parent with children (409), type change audited, list
  returns the fields; database guard refuses a direct child-of-non-parent insert
  and a cross-tenant parent.
- Integration `tests/integration/tenant-composite-foreign-keys.test.ts`: the new
  key is declared and present (count 40 → 41) and refuses another tenant's
  parent.
- Integration for the report filters (family filter, role filter, no widening
  for Head Office, malformed values) — in the same suite.
- Integration for both race orders (child insert vs. its parent's re-type).
- Component tests for both Head Office dialogs; a behaviour test for the
  report's Type column and roll-up.

## As built

- The parent's name on the branch reads is a correlated subquery whose outer
  column is named in full (`parentBranchNameSql`): Drizzle leaves a
  single-table select's columns unqualified, and a bare `parent_branch_id`
  inside the subquery resolved to the parent's own (null) column. The
  integration suite caught it.
- The Head Office create-dialog test asserted "no combobox" to mean "no
  organization picker"; Branch type is a combobox, so the assertion now names
  the one combobox it expects.

## Risks

- A trigger on `branches` runs on every insert/update of those two columns
  only; ordinary branch edits are unaffected.
- Test cleanups that delete branches one at a time would trip the key only if
  they created children; only the new tests do, and they delete by
  organization in one statement.
- The Super Admin branches table already had a "Parent" column meaning the
  **company**; it is renamed "Company" so the two are not confused.

## Steps

1. Pure module + tests.
2. Schema, migration, journal.
3. Server helpers, create/edit wiring, reads.
4. UI field and badge; both dialog pairs; both lists.
5. Report filters, column, roll-up, export.
6. Integration tests; gates.
