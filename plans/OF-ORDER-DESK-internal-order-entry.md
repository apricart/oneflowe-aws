# OF-ORDER-DESK — Apricart's internal Order Desk role (investigation + plan)

Status: **investigation complete, not started**
Date: 2026-10-05
Jira: _to be assigned_

---

## 1. What was asked

Some customers send their orders to Apricart by email or WhatsApp, and an
internal team keys them in by hand. These customers are not tenants yet but
will be later. Super Admin already sets them up as organizations, with
branches, groups, product assignments and prices. That part works today.

What is missing is a role for the internal team that can:

1. pick an **organization** and then one of its **branches**, and create an
   order for that branch;
2. skip approval. The order goes straight to **Active** (`status = APPROVED`,
   the same bucket the Viewer dashboard calls "Active");
3. take its own orders through to **fulfilment**.

The role should not be able to do anything else a Super Admin can, such as
changing prices, users or organizations.

## 2. What is already there (findings)

### F1 — The order engine already accepts a chosen organization and branch

`POST /api/v1/orders` (`app/api/v1/orders/route.ts`) already reads
`organizationId` and `branchId` from the body for `SUPER_ADMIN`
(`resolveOrderTenant`, `getCreationBranchId`), and checks that the branch
belongs to that organization (`validateCreationBranch`). The rest of the
creation path is shared by every caller:

- prices come from `loadCreationInventory` through the price ladder;
- stock is locked and decremented;
- the payment-control gate and the unacknowledged-delivery gate run;
- budgets are held when the tenant has them on (`resolveOrderBudgetTracking`);
- the order gets an invoice number, a receipt snapshot, a `systemLogs` row and
  an idempotency key.

**The new role should reuse this path rather than get a second one.** A second
creation path would be a second copy of the budget, stock and pricing rules,
and the two copies would drift apart.

### F2 — "Approved at creation" already exists, but per organization

`resolveInitialOrderApproval` (`lib/server/order-creation-approval.ts`,
`plans/OF-ORDERS-organization-auto-approval.md`) creates an order as
`APPROVED` with `approvedAt` and a fulfilment token whenever
`organizations.order_approval_required = false`. That switch belongs to the
organization. It cannot tell an order the desk keyed in from an order the
customer's own staff will place after onboarding. The desk needs its own
rule, keyed on **who created the order**.

### F3 — Fulfilment is two steps, and both are Super Admin only

- `POST /api/v1/orders/[id]/fulfillment-status` moves delivery forward
  (`NOT_STARTED → IN_PROCESS → OUT_FOR_DELIVERY → DELIVERED`). It is
  `requireApiRole(["SUPER_ADMIN"])`.
- `POST /api/v1/orders/[id]/fulfill` settles the order to `FULFILLED`. It is
  `requireApiRole(["SUPER_ADMIN"])` and refuses an order that has not been
  delivered (`isOrderDelivered`). `fulfillApprovedOrder` enforces the same
  check in its single-winner claim, moves the budget from held to spent, and
  writes `ORDER_FULFILLED` to the audit log.

CLAUDE.md requires that **no order is fulfilled before it is delivered, and
that no mode fulfils and delivers in one step.** The desk keeps those two
steps separate.

### F4 — Authorization is role-name matching, and most handlers do it inline

The repository has 151 route handlers, and only 49 use `requireApiRole`. The
other 102 check the role inline in their own way
(`plans/OF-CUSTOM-ROLES-rbac-permission-engine.md` F2). This matters because
the desk role, like Super Admin, has **no organization** of its own. Many
handlers do something like `if (orgId) conditions.push(eq(...organizationId,
orgId))`. For a caller whose organization is null, that adds no tenant filter
at all, so the caller would see every tenant. Relying on "every handler
refuses a role it does not know" is therefore not safe for this role. See D4.

### F5 — Two existing gaps on the routes this feature reuses

Both of these predate this work. Each needs a fix **before** the desk role
goes through these routes.

1. **`POST /api/v1/orders` has no role allowlist.** Nothing in the handler,
   the creation transaction or `proxy.ts` checks the caller's role. Any
   authenticated role that has a `branchId` on its session can create an
   order, including a branch-pinned `VIEWER`. This is already recorded: the
   Playwright `viewer-role.spec.ts` asserts a 403 and currently fails.
2. **`GET /api/v1/branch/inventory` lets Head Office read another tenant.**
   `resolveInventoryContext` replaces the session's organization with the
   `organizationId` query parameter for `HEAD_OFFICE` as well as
   `SUPER_ADMIN`, and nothing later checks it against the caller. A Head
   Office user in tenant A who asks for `?organizationId=<B>&branchId=<a branch
   of B>` gets B's branch catalogue, prices included. This comes from reading
   the code and still needs an integration test to confirm it.

### F6 — Nothing marks an organization as "ordered for by Apricart"

`organizations` has no column that says this. `createdByRole` exists on
`orders` (`plans/OF-ROLE-branch-admin-order-portal-switch.md`) and records
the creator's role at the time the order was raised. That is enough to tell
which orders the desk keyed in.

## 3. Options considered

| Option | Verdict |
|---|---|
| **A. Give the internal team Super Admin accounts.** The API almost supports this already (F1). | **Rejected.** Super Admin can change prices at every tier, organizations, users and the whole platform. That breaks the pricing rule ("only Super Admin may write a price" is meant to be a small group) and least privilege. It also leaves no admin "create order" screen. |
| **B. Create an `ORDER_PORTAL` login per customer branch and let the team share them**, with the organization's auto-approval switched on. No code needed. | **Rejected.** Credentials are shared, so nobody can tell which staff member entered which order. It needs one login per branch. Fulfilment still needs a Super Admin. These accounts would also clash with the customer's real users after onboarding. |
| **C. A new compiled platform role, `ORDER_DESK`, limited to organizations that Super Admin marks as managed by Apricart.** It reuses the existing creation and fulfilment engine and gets its own workspace. | **Recommended.** |

## 4. Decisions (recommended design)

### D1 — An eighth compiled role, `ORDER_DESK`

The role is added the same way `VIEWER` was (`plans/OF-VIEWER-readonly-dashboard-role.md` D1):

- a compiled role name;
- an explicit branch in each place that needs one;
- the same plumbing list: the `Role` union, both copies of `isValidRole`,
  `ROLE_HIERARCHY`, `ROLE_LEVEL`, `systemRoleSchema`, `ROLE_TEMPLATES`,
  `getSafeUserRole`, the login landing path, the sidebar and `app-context`.

The working label is "Order Desk (Apricart)". The name is still open (§7).

The permission template is informative only (F4):

- `ORDER_CREATE`, `ORDER_VIEW`, `INVENTORY_VIEW`, `REPORTS_EXPORT`;
- **no** `PRICING_MANAGE`, `ORDER_APPROVE`, `USER_*` or `ORG_*` keys.

### D2 — Platform staff: no organization, created by Super Admin only

A desk user row has `organization_id = null` and `branch_id = null`, like
Super Admin. Every reach this role has comes from D3, never from the user row.

`ROLE_LEVEL` and `ROLE_HIERARCHY` are renumbered so that `ORDER_DESK` sits
**between `HEAD_OFFICE` and `SUPER_ADMIN`**, with Super Admin moving to 8:

- `canAssignRole` and `canManageUser` then let Super Admin create and manage
  desk users;
- Head Office can neither assign nor manage them. A desk user works across
  tenants, so a tenant administrator must not be able to create one;
- every existing pair of roles keeps its relative order. The Viewer
  renumbering relied on the same property.

`POST /api/v1/users` gains a "platform staff" row shape for this role:
organization and branch must both be absent, and the creator must be
`SUPER_ADMIN`. The create-user dialog offers the role only to Super Admin.

### D3 — Reach: organizations Super Admin has marked as managed by Apricart

Add a new column:

```sql
organizations.managed_ordering boolean NOT NULL DEFAULT false
```

- Super Admin sets it in Create/Edit Company, next to the existing order
  approval and budget switches.
- Changes are audited as `UPDATE_ORGANIZATION_MANAGED_ORDERING`, with the
  before and after values.
- The default is false, so **no existing tenant, K-Electric included, becomes
  reachable by the desk.**

A flag on the organization is better than "every organization":

- it limits what one desk account can touch;
- it records a business fact: "Apricart takes this customer's orders on their
  behalf".

That fact holds before onboarding and can stay true after it, for example if
the customer keeps phoning orders in. Turning the flag off takes the
organization out of the desk's reach.

All rules live in one pure module, `lib/order-desk-access.ts`. Its
server-side partner is `lib/server/order-desk-scope.ts`.

| Action | Rule |
|---|---|
| List organizations / branches to choose from | `managed_ordering = true`, organization and branch both `active` |
| Read a catalogue, create an order | the target organization is managed **at that moment**. It is re-read in the creation transaction under the same `FOR SHARE` lock the approval resolver already takes, and the branch belongs to it |
| List, view, invoice, deliver, fulfil an order | the order's organization is managed **and** `orders.created_by_role = 'ORDER_DESK'` |

The last row is how "**their** orders" is read. All desk users share the desk's
orders, so a colleague can finish an order someone else entered. The desk never
touches orders the customer's own staff raise after onboarding; those follow
the normal approval and token hand-off. (Open question Q2.)

The organization id always comes from the request and is always checked
against `managed_ordering` on the server. A desk session has no organization
of its own that could serve as a fallback.

### D4 — An API allowlist enforced in `proxy.ts`, fail-closed

Because of F4, the desk gets an allowlist in `handleApiRequest`, as a second
layer behind the handlers. There is an exact precedent: a session that must
change its password is already held to
`isPasswordChangePendingApiPathAllowed` there, using the token `proxy.ts`
already decodes.

The allowlist is `ORDER_DESK_API_ROUTES` in `lib/order-desk-access.ts`:

- `GET  /api/v1/order-desk/targets`
- `GET  /api/v1/branch/inventory`
- `GET  /api/v1/delivery-addresses`
- `GET|POST /api/v1/orders`
- `GET  /api/v1/orders/[id]`
- `POST /api/v1/orders/[id]/fulfillment-status`
- `POST /api/v1/orders/[id]/fulfill`
- the invoice/receipt read routes
- session and password routes

Any other `/api/v1/*` path returns **403 before any handler runs**. This does
not replace the handler checks. Each admitted handler still authenticates,
authorizes and fences the request through `order-desk-scope.ts`. What the
proxy layer adds is a guarantee that the 102 inline-checked handlers can never
serve an organization-less desk session by accident.

The page side is confined the same way. `rolePortalRedirect` gets an explicit
`ORDER_DESK` branch that allows `/order-desk`, `/orders`, `/invoices` and
`/change-password`, and sends everything else to `/order-desk`. This explicit
branch is required because an unknown role currently fails open
(`OF-VIEWER` D2).

### D5 — Desk orders are created Active, whatever the organization's switch says

`resolveInitialOrderApproval` takes the creator's role. When
`orderDeskBypassesApproval(role)` is true, it returns the same `APPROVED`
values the auto-approval path writes: `approvedAt`, a generated token and its
bcrypt hash. It does this regardless of `order_approval_required`.

- **`approvedByUserId` is the desk user.** In the organization auto-approval
  case nobody approved the order, so the column stays null. Here a named staff
  member accepted the customer's order and is responsible for it. Recording
  them keeps "who approved what" answerable (rule 04).
- The `ORDER_CREATE` system log already records `autoApproved`. It gains
  `approvalBasis: "ORDER_DESK_ENTRY"`.
- Budget, stock and the two ordering gates behave exactly as for any other
  order (F1). Customers ordered for by the desk would normally be created with
  budgets **off**, which is already the product default. If a customer has
  budgets on, the server still enforces them, and the desk sees the refusal.

### D6 — Record where the order came from

Add two nullable columns:

```sql
orders.intake_channel   varchar(16)   CHECK (intake_channel IN ('EMAIL','WHATSAPP','PHONE','OTHER'))
orders.intake_reference varchar(255)  -- e.g. sender, message time, email subject
```

- **Both are required for a desk order** (Zod schema in the route) and stay
  null for every portal order.
- The existing `poNumber`, `notes` and delivery address fields are used as
  they are.
- These fields support later reconciliation ("which WhatsApp message was this?")
  and a channel breakdown in reports. They are cheap to add now and impossible
  to backfill later.
- They are part of the request fingerprint, so an idempotent retry still
  matches.

### D7 — Fulfilment: the existing two routes, opened to the desk on desk orders

Both routes change from `requireApiRole(["SUPER_ADMIN"])` to
`["SUPER_ADMIN", "ORDER_DESK"]`. For the desk, the order must also pass the
D3 order fence. The routes currently call `verifyResourceAccess`, which would
fail for an organization-less role. Nothing else changes:

- delivery is still recorded only through `fulfillment-status`;
- the fulfil call still refuses an undelivered order with 409;
- `fulfillApprovedOrder` still writes the audit row, with `fulfilledByUserId`
  set to the desk user.

The desk **does not use the fulfilment token**. That token exists so the
customer's staff can confirm receipt, and these customers have no staff
accounts yet. After onboarding, their Branch Admin can still hand it over on a
desk order, because the token hand-off is already open to operational roles on
any approved order in their scope.

### D8 — Notifications

An auto-approved order currently queues `ORDER_APPROVED_ADMIN` to every Super
Admin (`enqueueAutoApprovedOrderEvents`). For desk orders this is noise:
Apricart already knows about an order Apricart staff entered. **Recommended:
suppress it for desk orders.** (Q4.) No email goes to the customer, because
there is no customer user to send it to.

### D9 — The workspace (`/order-desk`)

The workspace sits inside the portal shell with the sidebar. Data is loaded
through SWR, following the existing pattern.

1. **New order.** The desk user chooses:
   - an **Organization** (only managed ones, from `GET /api/v1/order-desk/targets`,
     which returns `id, name, code` and each active branch's `id, name, city` —
     bounded, no prices);
   - a **Branch**, filtered to that organization;
   - products from the branch catalogue, using the same
     `GET /api/v1/branch/inventory` the shop uses, so the price shown is the
     price charged (one price ladder).

   Then they fill in quantities, the intake channel and reference, an optional
   PO number, notes and a delivery address. They review the totals and submit.
   The submit sends an `Idempotency-Key` that is generated once per draft, and
   the button is disabled while the request is in flight.
2. **Desk orders.** The existing orders directory, with organization, branch,
   status and delivery-status filters, shows desk orders only (D3 fence,
   server-side). Each row offers **Advance delivery** and, once delivered,
   **Fulfil**, as two separate actions (F3), plus **Invoice** so the PDF can be
   sent back to the customer.

`components/orders/orders-directory.tsx` currently gates those actions on
`isSuperAdmin`. Those checks become capability flags computed by one pure rule
(`orderDeskActions(role, order)` alongside the Super Admin case), rather than
another inline role comparison (rule 09).

## 5. Files (expected)

**Role plumbing**

| File | Change |
|---|---|
| `lib/rbac.ts`, `lib/auth.ts` | `Role` union, both copies of `isValidRole`, hierarchy renumber, `getSafeUserRole` |
| `lib/server/user-access-policy.ts` | `ROLE_LEVEL` renumber (desk 7, Super Admin 8) |
| `lib/server/mutation-validation.ts` | `systemRoleSchema`; `managedOrdering` on the organization schemas; intake fields on `orderCreateSchema` |
| `lib/permissions.ts` | `ROLE_TEMPLATES.ORDER_DESK` |
| `lib/order-desk-access.ts` | **new**. The pure rules: areas, API allowlist, approval bypass, action capabilities |
| `lib/server/order-desk-scope.ts` | **new**. Managed-organization reads, the target fence, the order fence (a SQL condition) |
| `proxy.ts` | page confinement and the API allowlist (D4) |
| `components/shell/sidebar.tsx`, `components/context/app-context.tsx`, `app/(auth)/login/page.tsx` | navigation, role context, landing path |
| `lib/invoice-access-policy.ts` | a desk entry: platform reach, limited to desk orders |

**Organization switch**

| File | Change |
|---|---|
| `db/schema.ts` + migration | `organizations.managed_ordering`; `orders.intake_channel`, `orders.intake_reference` |
| `app/api/v1/organizations/route.ts`, `[id]/route.ts` | accept and audit the switch (Super Admin only, as today) |
| `app/(portal)/organizations/page.tsx` | the toggle in Create/Edit Company |

**Order engine**

| File | Change |
|---|---|
| `app/api/v1/orders/route.ts` | an explicit creation allowlist (F5.1); desk tenant and branch resolution through the fence; desk scope on GET; intake fields |
| `lib/server/order-creation-approval.ts` | the creator-role bypass (D5) |
| `app/api/v1/orders/[id]/fulfillment-status/route.ts`, `fulfill/route.ts` | allowlist and the desk order fence (D7) |
| `app/api/v1/branch/inventory/route.ts` | desk branch in `resolveInventoryContext` and the Head Office tenant fence (F5.2) |
| `app/api/v1/order-desk/targets/route.ts` | **new** |

**Users**

| File | Change |
|---|---|
| `app/api/v1/users/route.ts` | the platform-staff row shape |
| `components/users/create-user-dialog.tsx` | the option, shown to Super Admin only |

**UI**

| File | Change |
|---|---|
| `app/(portal)/order-desk/**` | **new** workspace |
| `components/order-desk/**` | **new** |
| `components/orders/orders-directory.tsx` | capability flags instead of `isSuperAdmin` |

## 6. Tests

- **Unit:**
  - `lib/order-desk-access.test.ts`: approval bypass, action capabilities, and
    that the allowlist names no price-, user- or organization-writing route.
  - `lib/server/user-access-policy.test.ts`: Super Admin may assign `ORDER_DESK`,
    Head Office may not, and every existing pair is unchanged.
  - `lib/server/order-creation-approval.test.ts`: a desk order is APPROVED
    even when `order_approval_required = true`.
- **Contract:**
  - `proxy.test.ts`: a desk session gets 403 on `/api/v1/users`,
    `/api/v1/organizations`, any pricing route and `/api/v1/budgets`; desk page
    confinement.
  - `lib/pricing-access.test.ts`: unchanged, and the desk appears on no price
    route.
  - A route-list contract pinning `ORDER_DESK_API_ROUTES` to the handlers that
    really admit the role.
- **Integration** (`tests/integration/order-desk-api.test.ts`):
  - unauthenticated → 401;
  - desk creates an order in a managed organization → `APPROVED`, with
    `approvedByUserId`, intake fields, stock decremented and the budget held
    when the organization has budgets on;
  - desk targets an **unmanaged** organization (K-Electric shape) → 403;
  - desk names a branch of another organization → 400;
  - desk delivers and then fulfils its order → `FULFILLED`, ledger moved,
    audit row written;
  - desk fulfils before delivery → 409;
  - desk acts on a portal-raised order in a managed organization → 404;
  - desk lists orders → sees desk orders of managed organizations only;
  - Head Office cannot create or manage a desk user;
  - an idempotent retry → one order;
  - the managed flag turned off mid-flow → creation refused.
- **Regression for F5:**
  - a branch-pinned `VIEWER` POSTing an order → 403. This makes the existing
    Playwright spec pass;
  - Head Office reading another tenant's branch inventory → 403.
- **E2E:** one Playwright journey: desk logs in → creates an order → advances it
  to delivered → fulfils it.

## 7. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Role name and label | `ORDER_DESK`, "Order Desk (Apricart)" |
| Q2 | Should the desk fulfil **any** order in a managed organization, or only orders it entered? | Only desk-entered orders (D3) |
| Q3 | Should the intake channel and reference be mandatory? | Yes (D6) |
| Q4 | Should Super Admins still be emailed on each desk order? | No (D8) |
| Q5 | A desk user keys in a wrong order. Who corrects it? Today an `APPROVED` order cannot be edited, and only Super Admin can delete or refund it. | Leave this with Super Admin for the first release. If it happens often, add a desk "void within N minutes" later |
| Q6 | When a customer onboards, does `managed_ordering` stay on? | Super Admin decides per customer. The desk keeps its old orders visible only while the flag is on |
| Q7 | Do desk users need reports (for example, desk orders by channel or by person)? | Not in the first release. The orders directory export covers it |

## 8. Security impact

- **New role that works across tenants.** Its reach is the managed flag that
  only Super Admin sets, checked on the server on every request. It never
  comes from the user row or the request alone (D3).
- **Defense in depth:** a fail-closed API allowlist at the proxy (D4), plus
  checks in each handler.
- **No price writes.** The role is in no `PRICING_MANAGE` path, and the
  contract test pins this.
- **No approval-workflow bypass for anyone else.** The bypass is keyed on the
  creator's role. The creator's role comes from the session, and only Super
  Admin can grant it.
- **Closes two existing gaps** (F5) on the routes the desk reuses.
- **Audit:** order creation (`systemLogs`, with `approvalBasis`), the
  organization switch, delivery progress and fulfilment (`ORDER_FULFILLED`)
  each name the desk user.

## 9. Database impact and rollout

- **One migration, additive only:**
  - `organizations.managed_ordering` (`NOT NULL DEFAULT false`, metadata-only
    on Postgres 11+);
  - two nullable `orders` columns;
  - the `intake_channel` CHECK, added `NOT VALID` and then `VALIDATE`d so the
    `orders` table is not locked while existing rows are scanned;
  - an `INSERT INTO roles (name, ...) VALUES ('ORDER_DESK', ...) ON CONFLICT
    DO NOTHING`.

  The role row is inserted here **instead of running `db:seed` against
  production**, because the seed rewrites `role_permissions` from the
  templates.
- Raise the journal `when` above the last applied migration, as with every
  migration in this repository.
- **Apply the migration to staging and production before the code reaches
  them.** Both creation paths will select the new columns.
- **Rollback:** redeploy the previous image. The columns can stay, because
  their defaults reproduce today's behaviour. Deactivate any desk users. Desk
  orders already created are ordinary orders and stay valid.

## 10. Delivery order

1. **Fix F5 in its own PR** (creation allowlist; Head Office inventory fence).
   It is small, it is independently valuable, and it unblocks the failing
   Playwright spec.
2. **Backend:** role plumbing, migration, organization switch, the proxy
   allowlist, desk creation and fulfilment, and the targets endpoint, with
   unit, contract and integration tests.
3. **UI:** the `/order-desk` workspace and the directory capability flags,
   plus the E2E journey.
