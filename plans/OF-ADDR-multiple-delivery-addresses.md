# OF-ADDR — Multiple delivery addresses per branch, gated on Head Office approval

## The requirement

1. A single location (branch) may require **more than one delivery address**.
2. A user should be able to **request an additional address** through the portal.
3. That address requires **Head Office approval** before it becomes available
   for use.

"Available for use" is taken at full strength: an approved address is
selectable at checkout, is recorded on the order, and is the address the
receipt and the invoice print. An address that has not been approved is not
selectable anywhere and cannot reach an order.

## What exists today

A branch has exactly **one** address: the `address`, `city` and `province`
columns on `branches`, joined for display by `formatBranchAddress`
(`lib/branch-address.ts`). Order creation never asks where to deliver; it
snapshots that single branch address into `receipt_data.buyerAddress`
(`saveOrderReceipt` → `generateReceiptData`), and the invoice prints it under
"Deliver to" (`lib/server/invoice-pdf.ts`). There is no delivery-address table,
no request queue, and no column on `orders`.

The closest existing shape is the brand-new organization-join feature: a
request row raised by somebody without authority, decided by Head Office alone,
with the decision fenced to the decider's own tenant. This change deliberately
mirrors it — table shape, `FOR UPDATE` decision, role allowlist, audit trail —
so there is one way in this codebase to run an approval queue, not two.

## Design

### The row is the request *and* the address

There is no separate "request" table. A `branch_delivery_addresses` row is
created `pending` and becomes usable the moment Head Office moves it to
`approved`. One row, one lifecycle, one id — so "the address that was approved"
and "the address the order used" can never be two different records that drift
apart.

```
branch_delivery_addresses
  id, organization_id, branch_id
  label, label_key           -- "Warehouse Gate 2"; label_key is the normalized form
  address, city, province
  contact_person, contact_phone
  status                     -- pending | approved | rejected
  request_reason             -- why the branch says it needs another address
  requested_by_user_id
  decision_reason, decided_by_user_id, decided_at
  created_at, updated_at
```

Constraints carry the rules the endpoints must not be able to lose:

* `status` is one of the three, by check constraint;
* a `pending` row carries no decision, a decided row names its decider —
  so no endpoint can approve an address without recording who approved it;
* `label` and `address` are non-empty after trimming;
* **partial unique index on `(branch_id, label_key)` where
  `status IN ('pending','approved')`** — a branch cannot hold two live
  addresses under one name, and a duplicate submission is a database error
  rather than a race. A *rejected* label may be requested again.

`label_key` is stored already normalized (`deliveryAddressLabelKey`), exactly as
`organization_join_requests.email` is stored already lower-cased, which is what
lets the uniqueness index be a plain column index rather than a functional one.

### The order records which address it used

`orders.delivery_address_id` — nullable, FK to the table above.

**Nullable is load-bearing.** Every order ever placed has no delivery address,
and every order placed from a flow that does not offer the selector still has
none; all of them mean "the branch's own address", which is exactly what they
render today. Nothing is backfilled and no existing row changes.

Two further precautions, because production migrations here are applied by hand
and the application can be running ahead of them:

* `orderSelectColumns` reads the column through
  `to_jsonb("orders") ->> 'delivery_address_id'`, the same defensive read
  `fulfillment_status`, `payment_status` and `token_handoff_at` already use, so
  an environment whose migration has not landed reports "no delivery address"
  instead of failing every order read;
* the insert adds the key **only when an address was chosen**, so an order
  placed without one produces byte-identical SQL to today's.

`orderRequestFingerprint` gains the address the same conditional way: the field
is absent from the canonical object when no address was chosen, so a fingerprint
computed before this change still matches a retry of the same request after it.
Adding the key unconditionally would turn an in-flight idempotent retry across
the deploy into a 409.

### Who may do what

Two role allowlists, in `lib/delivery-address-access.ts`, following
`lib/organization-join-access.ts` rather than `Permission` — for the reasons
stated there: `ROLE_TEMPLATES.SUPER_ADMIN` is `Object.values(Permission)` so a
new permission is granted to Super Admin by construction, and `rolePermissions`
rows exist only after `db:seed` has run.

* **Request** — `ORDER_PORTAL`, `BRANCH_ADMIN`, `GROUP_ORDER_PORTAL`,
  `GROUP_USER`. The branch owns the request, not the author, matching
  `lib/order-write-access.ts`: a single-branch role may request for its own
  branch, a group role for any branch in its resolved assignment set. **An
  empty set denies everything** and never widens to the tenant.
* **Decide** — `HEAD_OFFICE` alone, on its own organization, resolved from the
  session with no `organizationId` parameter to substitute. `SUPER_ADMIN` is
  deliberately absent: the requirement names Head Office, and a tenant's
  delivery arrangements are the tenant's own. (Adding it later is one entry in
  `DELIVERY_ADDRESS_DECISION_ROLES`.)

### Layers

| File | Holds |
|---|---|
| `lib/delivery-address.ts` | Pure: statuses, decisions, label normalization, length bounds, page bound. Formats through the existing `formatBranchAddress` — one formatter, not two. |
| `lib/delivery-address-access.ts` | The two role allowlists. |
| `lib/server/delivery-address-scope.ts` | Requester and approver scope, resolved from the session only. |
| `lib/server/delivery-addresses.ts` | List, create, decide (`FOR UPDATE` + status check), and `loadApprovedDeliveryAddress` — the one read order creation trusts. |
| `app/api/v1/delivery-addresses/route.ts` | `GET` (fenced list), `POST` (raise a request). |
| `app/api/v1/delivery-addresses/[id]/route.ts` | `PATCH` — approve or reject. |

### Endpoints

`GET /api/v1/delivery-addresses?branchId=&status=`
Requester roles and Head Office. The branch set comes from the session; a
`branchId` parameter is **intersected** with it, never trusted. Head Office sees
its whole tenant. `status` is validated against the three, never reaching SQL as
a string. The page is bounded at `MAX_DELIVERY_ADDRESS_PAGE` whatever `limit`
asks.

`POST /api/v1/delivery-addresses`
Requester roles. Rate limited. `branchId` must be in the caller's resolved set —
otherwise 403, before anything is read. Always creates the row `pending`;
`status`, `decidedBy` and friends are not in the schema, so they cannot be mass
assigned. A duplicate live label is 409.

`PATCH /api/v1/delivery-addresses/[id]`
Head Office only. Rate limited. Id is digits-only before parsing, as the join
decision route does, so `"1abc"` cannot decide row 1. The fence is the pair
`(id, organizationId-from-session)` inside the `FOR UPDATE` — another tenant's
row is *not found*, so the id space cannot be enumerated. A second approval of
an already-decided row is 409, not a second approval. Written to `audit_logs`
and `system_logs`.

### The page

`/delivery-addresses` is **one page for one subject**, the same shape as
`/join-requests`, which holds both the code and the queue. A requester sees its
branches' addresses and a button to ask for another; Head Office sees the
tenant's queue and the Review button. `canDecide` comes back from the server
with the data, so the page never infers authority from a role string of its own.

It lives at `app/delivery-addresses/`, **outside `(portal)`**, because five roles
across three portals reach it — exactly the shape `/support` and `/invoices`
already have. `proxy.ts` treats it as a shared portal area rather than a
role-gated one.

That made the shell a per-role choice, and `/support` had already answered the
same question: whoever the sidebar builds a menu for keeps that menu on a shared
page, so a requester arriving from `/shop` does not land inside the
administrator's navigation and an administrator does not lose theirs. Rather than
restate that list, it moved to `lib/portal-chrome.ts` and
`lib/support-shell.ts` now derives from it, keeping its exported names and
behaviour so `support-shell.test.ts` still holds.

### Checkout

`/shop` gains a "Deliver to" selector above the purchase-order field, listing the
branch's approved addresses with the branch's own address as the default first
entry, plus a "Request a new address" dialog — the same component the page uses
— that posts to the endpoint above. A pending address is counted on the hint line
but is never selectable.

Order creation validates the chosen address **inside the creation transaction**
(`loadApprovedDeliveryAddress(tx, …)`), against `(id, organizationId, branchId,
status='approved')`. A pending, rejected, other-branch or other-tenant address is
refused there, not at the UI — the selector is presentation.

The receipt then snapshots that address into `buyerAddress` in place of the
branch's, and carries the label in a new optional `deliveryAddressLabel`, which
the invoice PDF and the on-screen receipt print as a "Deliver to:" line. A
reissued invoice therefore shows where the goods were actually sent rather than
where the branch happens to be today.

## Explicitly out of scope

* **The Group Order Portal's multi-branch checkout** keeps the branch default.
  One submission there fans out to one order per branch, so offering a delivery
  address means a per-branch picker and a `branchId -> addressId` map through
  the envelope — a distinct piece of work. Nothing about it changes: those
  orders write no `delivery_address_id` and render exactly as they do today.
  The server lib is written so adding it is a call, not a redesign.
* **Retiring an approved address.** There is no archive column and no delete
  endpoint. An address that should stop being used is a follow-up; adding a
  `retired_at` later is additive and does not disturb any row written here.
* **Backfilling `branches.address` into the new table.** The branch's own
  address stays where it is and stays the default. Moving it would be a data
  migration with no behavioural gain.
* **`SUPER_ADMIN` is admitted to none of it** — not the list, not a request,
  not a decision. It administers the platform rather than a tenant's delivery
  arrangements, and `getRequestScope` gives it no organization, so admitting it
  would mean an `organizationId` parameter on these routes and a cross-tenant
  case to get wrong. The practical cost: a Super Admin placing an order through
  `/shop` gets no selector and the order goes to the branch's own address, as it
  does today. Admitting it later is one entry in
  `DELIVERY_ADDRESS_READ_ROLES` plus a scope branch.

## Security review

* **Tenant isolation** — every read and write carries `organization_id`, and
  every branch set is resolved from the session. The decision's fence is in the
  `WHERE` of the `FOR UPDATE`.
* **IDOR** — a `branchId` on the request body and on the query string is
  intersected with the caller's resolved set; an address id on the order body is
  re-read against `(organizationId, branchId, approved)` inside the transaction.
* **Mass assignment** — both bodies are `.strict()` Zod objects carrying only
  the fields a requester may set. `status`, `decidedByUserId`, `decidedAt`,
  `organizationId` and `requestedByUserId` are set server-side.
* **Privilege escalation** — approval is a separate endpoint on a separate
  allowlist. A requester cannot approve its own request; the create path writes
  `pending` unconditionally.
* **Replay** — the decision is `FOR UPDATE` plus a status check: two
  administrators approving at once produce one approval and one 409.
* **Enumeration** — out-of-tenant rows are 404, consistently with the join
  decision route.
* **Audit** — every decision writes `audit_logs` and `system_logs` through a
  `writeDeliveryAddressAudit` helper that assembles metadata explicitly.

## Database impact

One migration, additive only: one new table, one nullable column on `orders`,
one partial index on that column. No rewrite of `orders` (adding a nullable
column with no default does not rewrite the table in modern Postgres), no lock
beyond a brief `ACCESS EXCLUSIVE` for the catalog update, no backfill.

**Apply the migration before deploying the code**, not after. The defensive
`to_jsonb` read protects the many order *read* paths, but `lockOrderEditAccess`
takes a full-row `select()` on `orders`, which Drizzle expands to an explicit
column list — so the order-edit path needs the column to exist. This is the same
deploy order `created_by_role` needed in the previous release; it is stated here
because production migrations in this repo are applied by hand
(`npm run db:migrate` against `MIGRATION_DATABASE_URL`) and can otherwise lag a
deploy.

The generated migration's journal `when` was raised to the last applied value
plus an hour and the tag and snapshot renamed, because `db:generate` stamps
`Date.now()`, which sorts *below* this repo's journal values and would have been
skipped silently by `scripts/migrate.ts`.

Rollback:

```sql
ALTER TABLE "orders" DROP COLUMN "delivery_address_id";
DROP TABLE "branch_delivery_addresses";
```

Nothing else references either. An order that had recorded an address keeps its
receipt snapshot, because the address was snapshotted into `receipt_data` rather
than read live.

## Tests

Unit (`npm test`):

* `lib/delivery-address.test.ts` — label normalization and the key (the two must
  agree on what a duplicate is), status/decision guards, bounds.
* `lib/delivery-address-access.test.ts` — each role that may request, each that
  may not; Head Office alone decides; the allowlists are exhaustive over `Role`.

Contract (`npm test`):

* `lib/server/delivery-address-order-guard.test.ts` — the structural guarantee
  behaviour cannot easily prove: **every order route that writes
  `orders.delivery_address_id` goes through `loadApprovedDeliveryAddress`, on
  the transaction handle, and writes the verified row's id rather than the
  requested one.** It also pins the conditional fingerprint spread and the
  defensive `to_jsonb` read. A new order route goes on its list or it is
  silently unguarded.
* `lib/server/activity-audit-coverage.test.ts` — both new routes added to
  `VIA_LIB` against `lib/server/delivery-address-audit.ts`. That control caught
  them when they were first written; it is the reason it exists.

Integration (`npm run test:integration`, needs `TEST_DATABASE_URL`):

* `tests/integration/delivery-addresses.test.ts`, 57 cases over the real routes
  and a real database —
  * request → pending → approve → usable; request → reject → never usable;
  * 401 unauthenticated; 403 for Head Office and Super Admin raising a request;
    403 for every requester role deciding one; 403 for a branch in the caller's
    own tenant it is not assigned to, and for another tenant's branch;
  * 404 — in the same words as a non-existent id — for another tenant's row, so
    the id space cannot be walked; `"1abc"`, `"1.5"`, `"-1"` refused as ids;
  * duplicate live label → 409, including a differently-spelled one; a rejected
    label may be re-requested; two branches may share a label;
  * a body carrying `status`, `decidedByUserId`, `organizationId` or
    `requestedByUserId` is rejected rather than applied;
  * the list is fenced both ways: a `branchId` parameter narrows and never
    widens, for a requester and for Head Office alike;
  * `loadApprovedDeliveryAddress` — the guard order creation trusts — refuses a
    wrong branch, a wrong tenant and a missing id.

**What is not covered end-to-end**: placing a real order against an approved
address through `POST /api/v1/orders`. That needs inventory, a budget row and a
tax rate before it reaches the address at all, so the guard itself is tested
directly and the routes' use of it is pinned by the contract test above.

## Risk

The invasive part is order creation. It is mitigated by making every new field
optional and absent-when-unused: with no address chosen, the fingerprint input,
the insert, and the receipt are identical to today's. The failure mode of the
new read is a refused order, never a mispriced or misbudgeted one — it runs
after the budget lock and before the write, inside the same transaction, so a
refusal releases the hold with the rollback.
