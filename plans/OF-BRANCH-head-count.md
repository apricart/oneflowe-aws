# OF-BRANCH — Branch head count, set by administrators or requested by the branch

## The requirement

1. A branch carries one more fact: its **head count** — how many people work
   there.
2. **Super Admin and Head Office** set it directly, in the Create Branch and
   Edit Branch forms.
3. **Branch Admin and Group User** may not set it. They **request** a value, and
   it reaches the branch only when **Head Office approves** the request — the
   same shape as the delivery-address request (`plans/OF-ADDR-multiple-delivery-addresses.md`).

## Design

### Data

`branches.head_count integer NULL` — null means "not provided", which is every
existing branch. Check `branches_head_count_ck`: `head_count IS NULL OR
head_count BETWEEN 0 AND 1000000` (`MAX_BRANCH_HEAD_COUNT`).

`branch_head_count_requests`, mirroring `branch_delivery_addresses`:

```
id, organization_id, branch_id
requested_head_count        -- integer, same bounds
current_head_count          -- what the branch held when it was asked (display only)
status                      -- pending | approved | rejected
request_reason
requested_by_user_id
applied_previous_head_count -- what approval overwrote (audit)
decision_reason, decided_by_user_id, decided_at
created_at, updated_at
```

* status check, and a pending row carries no decision while a decided row
  names its decider (same constraint shape as delivery addresses);
* **partial unique index on `branch_id` where `status = 'pending'`** — one live
  request per branch; a second is 409, and a race is a database error;
* composite key `branch_head_count_requests_branch_org_fk` →
  `branches (id, organization_id)`, per `plans/OF-DB-tenant-composite-foreign-keys.md`,
  and the table goes on `tests/integration/tenant-composite-foreign-keys.test.ts`.

### Who may do what — `lib/branch-head-count-access.ts`

Role allowlists, for the reasons `lib/delivery-address-access.ts` states.

* **Set directly** — `SUPER_ADMIN`, `HEAD_OFFICE` (Head Office only on its own
  organization's branches). Through the existing `POST /api/v1/branches` and
  `PATCH /api/v1/branches/[id]`, which already admit exactly those two and
  already fence Head Office to its tenant.
* **Request** — `BRANCH_ADMIN` (its own branch), `GROUP_USER` (its resolved
  assignment set). An empty set refuses; it never widens to the tenant.
* **Decide** — `HEAD_OFFICE` alone, own organization, from the session.

### Approval

`decideBranchHeadCountRequest` in one transaction: lock the request
`FOR UPDATE` on `(id, organizationId)` (another tenant's row is 404), refuse a
non-pending one with 409, lock the branch row `FOR UPDATE` on `(branch_id,
organization_id)`, write `branches.head_count`, record what it overwrote, mark
the request decided, and write the audit row (`recordAuditEvent`, same
transaction). A rejection changes only the request.

A direct edit by an administrator while a request is pending leaves the request
pending; Head Office sees the current and the requested figure side by side
when it reviews.

### Endpoints

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/v1/branch-head-count-requests?status=&branchId=` | requesters (their branches) and Head Office (tenant); bounded page; returns `canDecide` and `requestableBranches` |
| `POST` | `/api/v1/branch-head-count-requests` | `BRANCH_ADMIN`, `GROUP_USER`; rate limited; always `pending` |
| `PATCH` | `/api/v1/branch-head-count-requests/[id]` | `HEAD_OFFICE`; rate limited; digits-only id |

Bodies are `.strict()` Zod; `status`, `organizationId`, `decidedBy*` cannot be
sent. Branch `GET`s add `headCount` to their selected columns; the branch
create/update schemas gain an optional `headCount` (integer or null).

### UI

* Super Admin — Organizations page Create Branch / Edit Branch: a "Head count"
  number field.
* Head Office — My Branches: the Create Branch dialog gains the field. Head
  Office had no edit-branch form (only a status toggle), so it gets a full
  **Edit Branch** dialog (decided 2026-10-16): name, province, city, address,
  cost center, head count. No new authority — `PATCH /api/v1/branches/[id]`
  already admitted Head Office for exactly those fields on its own tenant's
  branches; region stays Super Admin's and is not on the form.
* Head count is shown on the branch cards / detail sheet.
* `/head-count-requests` (admin shell): requesters see their branches' requests
  and a "Request head count change" button; Head Office sees the queue with
  Review (approve/reject). Sidebar entry for Head Office, Branch Admin and Group
  User; `proxy.ts` gates the area to those three.

## Out of scope

* **Notifications.** Like delivery addresses, a new request sends no email or
  in-app notice; Head Office sees it on the queue's "waiting" badge.
* **Exports.** The branch Excel exports do not carry the head count yet.
* **Cancelling a pending request.** The requester cannot withdraw one; Head
  Office rejects it.

## Security

* Tenant isolation — every query carries `organization_id`; branch sets come
  from the session; the decision's fence is in the `FOR UPDATE` `WHERE`.
* IDOR — a body/query `branchId` is intersected with the caller's resolved set.
* Mass assignment — strict schemas; the create path writes `pending`
  unconditionally.
* Escalation — requesters cannot reach the branch PATCH (role allowlist) or the
  decision route; Head Office cannot raise a request, so every approval has two
  parties.
* Replay — `FOR UPDATE` + status check, and the partial unique index.
* Audit — `REQUEST_BRANCH_HEAD_COUNT`, `APPROVE_BRANCH_HEAD_COUNT`,
  `REJECT_BRANCH_HEAD_COUNT`; direct edits are covered by the existing
  `UPDATE_BRANCH` / `CREATE_BRANCH` rows.
* Warehouse / desk / executive / viewer — refused (no organization or not on
  the allowlist), so the isolation sweeps stay green.

## Database impact

One additive migration (`20261022120000_branch_head_count`): one nullable
column on `branches` (no rewrite), one new table. Apply before deploying — the
branch reads select the column.

Rollback:

```sql
DROP TABLE IF EXISTS "branch_head_count_requests";
ALTER TABLE "branches" DROP COLUMN IF EXISTS "head_count";
```

## Tests

* Unit — `lib/branch-head-count.test.ts` (bounds, parsing, status/decision),
  `lib/branch-head-count-access.test.ts` (role matrix),
  `components/organizations/head-office-edit-branch-dialog.test.tsx` and the
  create dialog's test (what the forms send).
* Contract — both routes in `VIA_LIB` of
  `lib/server/activity-audit-coverage.test.ts`; the GET in
  `VIEWER_ORGANIZATION_READ_ROUTES`; the new key counted in
  `tests/integration/tenant-composite-foreign-keys.test.ts` (39 → 40).
* Integration — `tests/integration/branch-head-count.test.ts`: request →
  approve → branch updated; reject → unchanged; 401/403 per role; cross-tenant
  404; group user outside its assignment 403; duplicate pending 409; replayed
  approval 409; mass-assignment refused; direct set by Super Admin and Head
  Office, refused for Branch Admin, Head Office refused on another tenant.
