# Finance role

## The requirement

> A Finance user sees the Orders page, and the only thing they can do is mark
> an order Paid or Unpaid. They see the complete Reports section, view only,
> and KPIs about payment status. When the user is created, Super Admin assigns
> them organizations through a searchable, multi-select organization filter
> with Select all.

Decisions taken with the requester (2026-10-26):

- **Orders and reports read "like Super Admin"** — every assigned organization
  together, with the organization filters Super Admin has — but never outside
  the assigned set.
- **Paid/Unpaid applies to any approved order**, not only to fulfilled and
  delivered ones. That is the shared rule, so it widens for Super Admin too.

## The rule this change implements

`FINANCE` (shown as **Finance**) is Apricart's own staff, like `ORDER_DESK`,
`APRICART_EXECUTIVE`, `WAREHOUSE` and `APRICART_SUPPORT`:

- **No organization and no branch on the user row.** Its reach is
  `finance_organization_assignments (user_id, organization_id)`, written by
  Super Admin when the account is created and replaceable later
  (`PUT /api/v1/users/[id]/finance-organizations`, audited
  `UPDATE_FINANCE_ORGANIZATIONS`). It is re-read on every request by
  `loadFinanceOrganizationIds` (`lib/server/finance-scope.ts`), and only while
  the account is an active, undeleted Finance account. **An empty set reads
  nothing**, never everything.
- **Only Super Admin creates or manages one** (`ROLE_LEVEL` 7). The account is
  never switched into or out of the role.
- **Confined by `proxy.ts`** to `/finance`, `/orders`, `/invoices`, `/reports`
  and `/change-password`, and to `FINANCE_API_RULES` (`lib/finance-access.ts`):
  the reads those pages make, one write (`POST /api/v1/orders/[id]/payment-status`)
  and the password-change calls. Every other API call is 403 before a handler
  runs. That is a second layer, never the boundary: every listed handler checks
  the role and the fence itself.

### How a read is fenced: "Super Admin with a forced organization filter"

Every listed read handler already scopes Super Admin by an optional
organization filter, and applies it to every query when one is given. Finance
takes that path with the filter forced:

```
fenced = requested ∩ assigned      (requested non-empty; any outside → 403)
fenced = assigned                  (nothing requested)
fenced = []                        → 403, never "all"
```

`fenceFinanceOrganizationIds` (`lib/finance-access.ts`) is that rule, pure;
`resolveFinanceReadScope` (`lib/server/finance-scope.ts`) loads the assignments
and applies it. A handler then continues as Super Admin with `fenced` as its
organization list. Because Super Admin's path treats an empty list as "every
organization", **the fence is never empty when the handler continues**.
`lib/finance-access.test.ts` lists every handler on the allowlist and checks it
fences Finance (directly or through a reviewed shared helper);
`tests/integration/finance-role.test.ts` calls **every** GET handler under
`app/api/v1` as a Finance user, the proxy skipped, with filters and ids pointed
at an unassigned organization, and fails if a response carries that
organization's name marker or its (deliberately huge) order amount — the second
check catches a total that folded another tenant in, which a name cannot.

The amount check found one pre-existing hole, fixed here:
`GET /api/v1/analytics/products/catalog-performance` summed every tenant's
sales for any caller with no organization (Finance, Warehouse, Desk,
Executive) that reached it past the proxy. It now refuses such a caller with
`lacksAnalyticsTenant`, like the three handlers the warehouse sweep fixed.

Prices: Finance reads as Super Admin, so prices are visible — the role exists
to reconcile amounts.

### What Finance may do

| Action | Finance |
|---|---|
| Read orders, order detail, refunds, challans, intake screenshot, invoices and credit notes of assigned organizations | yes |
| Mark an approved order Paid / Unpaid | yes — `APPROVED` or `FULFILLED`, assigned organization |
| Read every report Super Admin reads, export / download them | yes, fenced |
| Schedule a report email, approve, reject, fulfil, refund, edit, cancel, price, create anything | no |
| Payment KPIs page (`/finance`) | yes — its landing page |

### Paid / Unpaid

`isPaymentStatusUpdateEligible` becomes "status `APPROVED` or `FULFILLED`"
(any delivery stage); the atomic claim in `transitionOrderPaymentStatusColumn`
matches it. Every unpaid invoice the ordering block counts is still one the
control can act on (`lib/unpaid-invoice-block.test.ts`). An order with an
approved refund still cannot go back to Unpaid. The route admits `SUPER_ADMIN`
and `FINANCE`; for Finance the order's organization must be assigned (404
otherwise, so an id outside the reach is not confirmed). Audit row unchanged:
`ORDER_PAYMENT_STATUS_UPDATE`, with the actor's role in the metadata.

### Payment KPIs

`GET /api/v1/finance/payment-kpis` — `SUPER_ADMIN` and `FINANCE`, Finance
fenced as above. Over approved and fulfilled orders, net of refunds, created in
the selected window: Paid (count, amount), Unpaid (count, amount), collection
rate, unpaid delivered (invoiced and owed), unpaid aging since approval
(0–30, 31–60, 61–90, 90+ days), and a per-organization breakdown. Rules pure in
`lib/finance-payment-kpis.ts`.

### Organization multi-select

`components/finance/organization-multi-select.tsx`: searchable, multi-select,
Select all / Clear (over the filtered list). Used by Create User (Finance) and
Edit Finance Organizations on Users, and by the KPIs page's filter. It is
presentation only; the server validates every id.

## Non-goals

- No per-branch reach for Finance; organizations are the unit.
- No tenant-side finance user (a Head Office could not create one).
- No change to who may read prices or invoices for any other role.

## Changes

| Area | Change |
|---|---|
| `drizzle/20261102120000_finance_role.sql`, `db/schema.ts` | `FINANCE` roles row; `finance_organization_assignments` |
| `lib/finance-access.ts` | role, label, home, areas, API allowlist, account shape, access-change rule, fence |
| `lib/server/finance-scope.ts` | assignments loader, read scope, assignment replacement |
| role lists (`lib/rbac.ts`, `lib/auth.ts`, `mutation-validation`, `user-access-policy`, `permissions`, `invoice-access-policy`, `activity-log*`, `role-display-names`) | the role |
| `proxy.ts` | API confinement, page areas |
| listed read handlers | Finance branch through `resolveFinanceReadScope` |
| `app/api/v1/orders/[id]/payment-status/route.ts`, `lib/business-rules.ts`, `lib/order-select.ts` | Finance admitted; any approved order |
| `app/api/v1/finance/payment-kpis/route.ts`, `app/(portal)/finance/page.tsx` | KPIs |
| `app/api/v1/users/*`, `components/users/*` | create with organizations; edit organizations |
| `app/api/v1/analytics/products/catalog-performance/route.ts` | refuses an organization-less caller (`lacksAnalyticsTenant`) |
| sidebar, login, orders pages | Finance menu, landing, read-only view with Paid/Unpaid |

## Rollout

1. `npm run db:migrate:prod` (dry run, then `--confirm=<digest>`) — additive.
2. Deploy.
3. Super Admin creates Finance accounts on Users → Create User.

## Rollback

Deactivate every Finance account, deploy the previous build, then
`DROP TABLE "finance_organization_assignments"` and
`DELETE FROM "roles" WHERE "name" = 'FINANCE' AND NOT EXISTS (SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id")`.
Payment-status changes made on not-yet-delivered orders stay as recorded; the
old rule only refuses changing them again until delivery.
