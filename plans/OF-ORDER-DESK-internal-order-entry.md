# OF-ORDER-DESK — Apricart's internal Order Desk role

Status: **implemented — gates green on the test database; migration not yet applied to staging or production**
Date: 2026-10-05
Jira: _to be assigned_

---

## 1. What was asked

Some customers send their orders to Apricart by email or WhatsApp, and an
internal team keys them in by hand. These customers are not tenants yet but
will be later. Super Admin already sets them up as organizations, with
branches, groups, product assignments and prices.

The internal team needs a role that can:

1. pick an **organization**, then one of its **branches**, and create an order;
2. skip approval. The order is **Active** (`status = APPROVED`) from the start;
3. take its own orders through delivery to **fulfilment**.

Two further conditions:

- **Assigned reach only.** A desk user may order only for the organizations or
  branches assigned to them.
- **Isolation.** Nothing may change for any other role, feature or tenant.

## 2. Findings that shaped the design

- **F1 — The creation engine already handles a named target.**
  `POST /api/v1/orders` already accepts an organization and branch from Super
  Admin, and runs the pricing, stock, budget, payment and delivery gates, the
  invoice number, the audit and idempotency for every caller. The desk reuses
  this path rather than getting a second one, so those rules cannot drift.
- **F2 — Auto-approval is per organization, not per creator.**
  `organizations.order_approval_required` cannot tell a desk entry from an
  order placed by the customer's own staff. The desk therefore gets its own
  rule, keyed on the creator's role.
- **F3 — Delivery and fulfilment are two steps, both Super Admin only.**
  Several contract tests pin the source of those two routes. Rather than widen
  them, the desk gets its own routes that call the same shared primitives
  (`transitionOrderFulfillmentStatusColumn`, `fulfillApprovedOrder`). The rule
  "no order is fulfilled before it is delivered, and nothing does both in one
  step" holds.
- **F4 — Most routes check roles inline.** Only 49 of 151 route handlers use
  `requireApiRole`. For a role with no organization of its own, an inline
  `if (orgId) filter` would apply no tenant filter at all. Hence the
  proxy-level allowlist (D4).
- **F5 — Two gaps that predate this work.**
  1. **Fixed here.** `POST /api/v1/orders` had **no role allowlist**, so a
     branch-pinned `VIEWER` could create orders (the known Playwright failure).
  2. **Not fixed here; needs its own change.** `GET /api/v1/branch/inventory`
     lets Head Office pass another tenant's `organizationId`. The desk does not
     use that route.

## 3. Decisions

### D1 — An eighth compiled role, `ORDER_DESK`

It is plumbed the same way `VIEWER` was:

- the `Role` union and both copies of `isValidRole`;
- `systemRoleSchema`;
- `ROLE_LEVEL` / `ROLE_HIERARCHY`;
- `ROLE_TEMPLATES` (descriptive only);
- `INVOICE_ROLE_RULES`;
- login landing → `/order-desk`.

### D2 — Platform staff, created and managed by Super Admin only

- A desk user has `organization_id = null` and `branch_id = null`.
- `ORDER_DESK` sits at level 7, between Head Office (6) and Super Admin (now 8).
  This makes `canAssignRole` and `canManageUser` refuse it to Head Office. The
  levels are compared only in user management, and no other caller uses the
  hierarchy helpers.
- `POST /api/v1/users` requires no organization and no branch for this role.
- `PATCH /api/v1/users/[id]/access` accepts only activation and MFA changes
  for a desk account. It refuses to switch any account into or out of
  `ORDER_DESK` (`orderDeskAccessChangeError`).

### D3 — Reach = Super Admin's assignment ∩ the organization's managed flag

Two grants, both made by Super Admin and both re-read from the database on
every request:

- **`organizations.managed_ordering`** (default false, audited as
  `UPDATE_ORGANIZATION_MANAGED_ORDERING`). It means "Apricart takes this
  customer's orders". Because it defaults to off, no existing tenant
  (K-Electric included) is reachable even by mistake.
- **`order_desk_assignments`**: one row per desk user per organization
  (`branch_id` null means every branch) or per single branch. It is a table of
  its own, because `user_branch_assignments` feeds the group roles' reports
  (`resolveUsersScopedToBranches` reads every row regardless of role).
  Replacing a user's assignments is audited as `UPDATE_ORDER_DESK_ASSIGNMENTS`.

`resolveDeskReach` (pure, `lib/order-desk-access.ts`) decides reach from the
rows `lib/server/order-desk-scope.ts` loads:

| Purpose | Requires |
|---|---|
| `order` — targets, catalogue, create | user row is `ORDER_DESK`, active, not deleted; organization managed **and** active; branch active and belonging to the assigned organization |
| `manage` — list, deliver, fulfil | the same, minus the status checks, so an order at a since-deactivated branch can still be finished; and the order was **entered by the desk** (`created_by_role = 'ORDER_DESK'`) |

- An empty reach matches nothing; it is never widened.
- All desk users share the desk's orders inside their own reach, so a
  colleague can finish an order someone else entered.
- Orders the customer's own staff raise later are never the desk's.

### D4 — A fail-closed API allowlist in `proxy.ts`

A desk token reaches only the calls listed in `ORDER_DESK_API_RULES`, matched
by exact method and path:

- `POST /orders`;
- `GET /order-desk/{targets,catalogue,orders}`;
- `POST /order-desk/orders/:id/{delivery,fulfil}`;
- the three change-password calls.

Everything else returns 403 before a handler runs. Each admitted handler
still checks the role and the reach itself; the allowlist is an extra layer,
not a replacement.

Pages work the same way: the desk is confined to `/order-desk`. Viewer and
desk now share a small `SINGLE_AREA_ROLES` table. `/desk-team` is Super Admin
only, and `/order-desk` is the desk's only page.

### D5 — Desk orders are Active whatever the tenant's switch says

`resolveInitialOrderApproval` takes the creator from the session. For
`ORDER_DESK` it writes the same approved values as auto-approval, with two
additions:

- `approved_by_user_id` is the desk user;
- the creation log records `approvalBasis: "ORDER_DESK_ENTRY"`.

The organization row is still read under the same `FOR SHARE` lock. Budget,
stock and both ordering gates behave exactly as for any other order. Every
other creator's approval is unchanged; the integration test proves Head Office
in the same tenant still gets `PENDING`.

### D6 — Where the order came from

- `orders.intake_channel` (`EMAIL | WHATSAPP | PHONE | OTHER`, with a CHECK
  constraint; labelled "Order channel" in the form) and
  `orders.intake_reference` (up to 255 characters).
- Both are required on a desk order and refused on any other order
  (`orderIntakeError`).
- They enter the idempotency fingerprint only when present, so every other
  order hashes exactly as before.

### D7 — Super Admin records delivery; the desk fulfils

Revised after review (2026-10-05). The desk asked not to handle delivery steps.
The rule that an order is never fulfilled before a delivery is recorded still
holds, so the work is split between two roles:

- **Delivery.** Super Admin records it through the existing progress route,
  from their own Orders screen; desk orders appear there like any other order.
  The desk sees the delivery status but has no way to change it. The desk
  delivery route was removed.
- **Fulfilment.** `POST /api/v1/order-desk/orders/[id]/fulfil` returns 409
  until the order is delivered, then calls `fulfillApprovedOrder`, which
  re-asserts `DELIVERED` in its claim, moves the budget from held to spent,
  and writes the audit row.
- **No token.** The token exists for a customer's staff to confirm receipt,
  and these customers have no accounts yet. The desk user is recorded as the
  one who fulfilled the order.
- **Super Admin routes untouched.** Both existing fulfil/progress routes are
  unchanged.

### D7a — Cancel, edit and refund

| State | The desk may |
|---|---|
| Active, not delivered | **Edit** or **Cancel** |
| Active, delivered | **Fulfil** |
| Fulfilled and delivered | **Request a refund** (Super Admin approves) |

- **Cancel**: `POST /api/v1/order-desk/orders/[id]/cancel`, handled by
  `cancelDeskOrder`.
  - A reason is required. The order becomes `CANCELLED`, recording who
    cancelled it, when and why (`cancelled_at`, `cancelled_by_user_id`,
    `cancellation_reason`).
  - The money hold and the quantity hold are released on the row for the
    order's own period (`budgetPeriodOf`), only if the order took a hold, with
    the same guard as rejection. Stock is restored.
  - Everything happens under a lock on the order and is audited as
    `ORDER_CANCELLED`.
- **Edit**: `PUT /api/v1/order-desk/orders/[id]`, handled by
  `lib/server/order-desk-edit.ts`. Lines, notes and PO number can change.
  - It is a separate path because the requester edit is PENDING-only and is
    left untouched.
  - The rules match that edit: everything locked; lines re-priced through the
    ladder and re-taxed; stock moved by the difference; expired add-ons
    settled under the budget row lock before the hold moves; the quantity
    budget re-checked; the invoice keeps its number, date and delivery
    address.
  - The branch must still be one the desk may order for (otherwise 403).
- **Refund**: the shared `POST /api/v1/orders/[id]/refunds` admits
  `ORDER_DESK` for its own orders, resolved through its live reach.
  - It is held to the same "fulfilled and delivered" and same-month rules as
    every requester.
  - The request is PENDING; Super Admin approves it in Refunds and is
    notified.

### D7b — The customer's screenshot

- **Upload.** `POST /api/v1/upload/image` is the one raster path the
  production WAF allows, so it admits the desk. A desk upload is stored under
  a private `order-intake/` prefix and the route answers with its key, not a
  readable path.
- **No `data:` URLs.** If storage is not configured the upload returns 503,
  even in development.
- **Public route can't serve it.** The public image route is pinned to
  `products/`.
- **Binding.** On order creation the key must:
  - match the generated shape;
  - have been uploaded by this desk user (checked against the
    `UPLOAD_ORDER_INTAKE_ATTACHMENT` audit row);
  - be on no other order (`orders_intake_attachment_key_uq`).
- **Reading it back.** `GET /api/v1/order-desk/orders/[id]/attachment` serves
  it to a desk user who reaches that order, with `private, no-store` and a
  sandboxing content-security policy.
- **Allowlist.** The proxy allowlist now also admits:
  - the edit, cancel and attachment routes;
  - the upload route;
  - `GET`/`POST` on an order's refunds.

### D8 — Notifications

Desk entries queue no notification. Apricart keyed them in, and the customer
has no account to notify.

### D9 — Screens

- **`/order-desk`** — a self-contained workspace, like the group portal, so it
  never mounts the admin shell (whose calls the desk may not make).
  - *New order:* organization → branch → catalogue (the same price ladder as
    creation), quantities, order channel and reference, an optional screenshot
    of the message, an optional PO number and notes. One idempotency key per
    draft, and the button is disabled while a request is in flight.
  - *Orders:* filters (Active / Fulfilled / Cancelled / All), the delivery
    status Super Admin recorded (read-only), View screenshot, and the actions
    by state — Edit, Cancel, Fulfil (with a confirmation), Request refund —
    plus refund amounts, pending or approved.
- **`/desk-team`** (Super Admin, sidebar "Order Desk Team") — create desk
  users, tick managed organizations (whole) or single branches, and
  activate/deactivate them.
- **Create/Edit Company** gains the switch "Managed by Apricart Order Desk".
- The users table gets the role's label, badge and filter entry.

### Deferred

- **Invoices for the desk.** `INVOICE_ROLE_RULES.ORDER_DESK` reads nothing.
- **Desk reporting.**

## 4. Files

| Area | Files |
|---|---|
| Rules (pure) | `lib/order-desk-access.ts`, `lib/order-desk-query.ts`, `lib/order-desk-draft.ts`, `lib/order-desk-team-view.ts`, `lib/order-creation-access.ts` |
| Server | `lib/server/order-desk-scope.ts`, `lib/server/order-desk-catalogue.ts`, `lib/server/order-desk-orders.ts`, `lib/server/order-desk-edit.ts`, `lib/server/order-desk-attachments.ts`, `lib/server/order-desk-team.ts`, `lib/server/order-creation-approval.ts`, `lib/server/image-storage.ts` |
| Routes (new) | `app/api/v1/order-desk/{targets,catalogue,orders}/route.ts`, `orders/[id]/route.ts` (edit), `orders/[id]/{fulfil,cancel,attachment}/route.ts`, `team/route.ts`, `team/[userId]/assignments/route.ts` |
| Routes (changed) | `app/api/v1/orders/route.ts`, `app/api/v1/orders/[id]/refunds/route.ts`, `app/api/v1/upload/image/route.ts`, `app/api/v1/users/route.ts`, `app/api/v1/users/[id]/access/route.ts`, `app/api/v1/organizations/route.ts`, `app/api/v1/organizations/[id]/route.ts` |
| Role plumbing | `lib/rbac.ts`, `lib/auth.ts`, `lib/server/mutation-validation.ts`, `lib/server/user-access-policy.ts`, `lib/permissions.ts`, `lib/invoice-access-policy.ts`, `proxy.ts`, `app/(auth)/login/page.tsx` |
| Schema | `db/schema.ts`, `drizzle/20261005120000_add_order_desk.sql`, `drizzle/20261005130000_add_order_desk_attachment_and_cancellation.sql`, journal |
| UI | `app/order-desk/*`, `app/(portal)/desk-team/*`, `components/order-desk/*`, `app/(portal)/organizations/page.tsx`, `components/users/head-office-users-table.tsx`, `components/shell/sidebar.tsx` |

## 5. Tests

- **Unit:**
  - `lib/order-desk-access.test.ts` — reach, allowlist, intake, actions, account
    rules;
  - `lib/order-desk-query.test.ts`, `lib/order-desk-draft.test.ts`,
    `lib/order-desk-team-view.test.ts`;
  - `lib/order-creation-access.test.ts`;
  - additions to `lib/server/user-access-policy.test.ts` and
    `lib/server/order-creation-approval.test.ts`.
- **Contract:**
  - `lib/server/order-desk-contract.test.ts` — creation-gate order, locked
    re-check, reads through the reach, Super Admin routes untouched, schema;
  - `lib/order-desk-access.test.ts` — every desk handler is on the allowlist and
    admits the role itself; team routes are Super Admin only; no price, user,
    tenant or budget route on the list;
  - the new mutating routes classified in
    `lib/server/activity-audit-coverage.test.ts`, and the cancel and edit
    modules added to the ledger-mover, period-writer and add-on-settlement
    lists;
  - desk cases in `proxy.test.ts`.
- **Integration:** `tests/integration/order-desk-api.test.ts` (35 tests).
  - 401 without a session; 403 for other roles.
  - Reach: whole versus single branch; an unmanaged organization with a stale
    grant; an inactive branch; an inactive account; a branch named under the
    wrong organization.
  - Creation: Active, `approvedBy` set, intake recorded, stock decremented, no
    notification, the audit basis written; idempotent replay; budget hold at a
    budgeted tenant; intake required for the desk and refused for others; Head
    Office still `PENDING`; Viewer 403; Order Portal still works.
  - Orders: listing never shows portal orders; a filter cannot widen; the desk
    fulfils only after Super Admin records delivery (ledger move and audit by
    the right person); 404 outside reach.
  - Cancel: stock and hold released, reason required, delivered refused, final.
  - Edit: re-priced; stock and hold moved both ways; invoice number kept;
    refused when invalid, delivered, or the branch is no longer orderable.
  - Refund: refused before fulfilment; PENDING with a Super Admin notice and no
    money moved; refused outside reach and on orders the desk did not enter.
  - Screenshot: stored privately and audited to its uploader; shown only to the
    desk in reach (never by the public image route); another user's key, a
    reused key or a forged key refused; never a `data:` URL.
  - Super Admin administration: user creation, the assignment rules and audit,
    access guards, the managed switch withdrawing the desk at once.
- **Mutation check:** dropping the managed-flag rule, or the creation role
  gate, turns six integration tests red. Dropping the uploader binding, the
  stock restore on cancel, or the hold move on edit each turns its own test
  red.

## 6. Security impact

- **New cross-tenant role.** Its reach is the intersection of two grants made
  only by Super Admin, re-read from the database on every request and under
  `FOR SHARE` inside the creation transaction. It never comes from the session
  or the request.
- **Proxy allowlist.** It is fail-closed, and the handlers re-check.
- **No new writes for the desk.** It writes no price, user, tenant, budget or
  approval of anyone else's order. Its cancel and edit move holds only on
  orders it entered, under the same ledger rules as the existing paths, and its
  refunds wait for Super Admin.
- **Screenshots hold customer personal data.** They are kept off the public
  image route, never cached, bound to their uploader, and readable only within
  the desk's reach.
- **Creation is now allowlisted for every role.** `VIEWER` is refused.
  `EMPLOYEE` (the synthesized login) is kept.
- **404 for orders outside the desk's reach,** to avoid enumeration.
- **Audit.** Order creation (`systemLogs`, with `approvalBasis`), the managed
  switch, assignment changes, each delivery step and fulfilment are all
  recorded.

## 7. Database impact and rollout

- **Migration.** `20261005120000_add_order_desk`, additive only:
  - `organizations.managed_ordering` (`DEFAULT false`, metadata-only);
  - two nullable `orders` columns and a CHECK constraint. The column is new,
    so every row is NULL; a plain `ADD CONSTRAINT` suffices, because the
    runner applies all pending migrations in one transaction and
    `NOT VALID` + `VALIDATE` would gain nothing;
  - the `order_desk_assignments` table;
  - the `ORDER_DESK` role row (inserted here rather than by `db:seed` on
    production).
- **Second migration.** `20261005130000_add_order_desk_attachment_and_cancellation`,
  also additive: `orders.intake_attachment_key` (a shape CHECK and a partial
  unique index), `cancelled_at`, `cancelled_by_user_id`, `cancellation_reason`.
- **Apply both before deploying.** Order creation selects the new columns.
- **Rollback.** Redeploy the previous image; the columns can stay. The SQL to
  drop them is in the migration header.
- **Switching on for a customer.**
  1. Super Admin ticks "Managed by Apricart Order Desk" on the company.
  2. Super Admin creates the desk users.
  3. Super Admin grants each the organizations or branches they handle.
