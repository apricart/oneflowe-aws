# OF-VIEWER — the Viewer reads everything Head Office reads, and changes nothing

Status: **implemented — gates below**
Date: 2026-10-14
Builds on: `plans/OF-VIEWER-readonly-dashboard-role.md` (dashboard-only Viewer)

---

## 1. What was asked

> Show this user all the side menu items that Head Office sees, but view only.
> This user should never be able to change anything — only view, and only the
> data of the organization assigned to it. Tenant isolation must hold.

Clarified with the client (2026-10-14):

* **Organization-wide Viewers** (no branch on the user row) get Head Office's
  whole menu: My Branches, Users, Join Requests, Delivery Addresses, Orders,
  Product Catalog (Organization's Products, Product Price History, Product
  Requests), Group Management, Budgets, Budget by Quantity, every Head Office
  report, Support, Activity Log, Settings — all read-only.
* **Branch-pinned Viewers** keep today's dashboard-only access, unchanged.
* The sensitive pages (Users, Activity Log, Join Requests, Support) are
  included, read-only.

## 2. Decisions

### D1 — A Viewer reads *as* Head Office, inside the read handler only

Each admitted GET handler resolves the role it scopes by through one pure rule,
`viewerReadRole` (`lib/viewer-access.ts`):

| caller | scoped as |
|---|---|
| `VIEWER`, organization set, no branch | `HEAD_OFFICE` |
| `VIEWER`, branch set (pinned) | refused (403) — dashboard only |
| `VIEWER`, no organization | refused (403) |
| any other role | itself |

The organization comes from the session (revalidated against the `users` row
on every request; a changed organization or branch ends the session —
`lib/auth-options.ts`), never from the request. So the Viewer's reach is
*exactly* Head Office's: one tenant, every branch in it.

This is applied **per handler, by name**, never centrally. A central "a Viewer
is Head Office on every GET" switch was rejected because it would silently open
reads that are really actions — the fulfilment-token reveal is the obvious one —
and would stamp audit rows with the wrong role. Every handler that maps the
role is on `VIEWER_READ_ROUTES`, the control list.

Inside a mapped handler, three things keep the **real** role:

* anything that releases the fulfilment token (`canViewFulfillmentToken`) —
  handing it over settles an order, which is an action;
* audit rows written by a read (e.g. the consolidated-invoice download);
* capability flags returned to the UI (`canDecide`, …) — cosmetic, since the
  write is refused anyway, but they must not claim a right the role lacks.

### D2 — View-only is enforced three times

1. **Handlers.** No write handler admits `VIEWER`; this work adds the role to
   GET paths only. `tests/integration/viewer-write-sweep.test.ts` calls every
   POST/PUT/PATCH/DELETE under `app/api/v1` as an organization-wide and as a
   pinned Viewer, with ids inside its own tenant, and fails on any 2xx outside
   the reviewed own-account list or any changed protected row.
2. **Proxy.** `proxy.ts` refuses a Viewer token every non-GET API request
   except its own account's (`VIEWER_OWN_ACCOUNT_WRITES`: password change,
   own MFA, marking its own notifications read). Defence in depth, never the
   boundary.
3. **UI.** Every write control on the shared pages is hidden for the role
   (`isReadOnlyRole`). Presentation only.

### D3 — Only the account's own password change stays

Changing its own password (forced on first sign-in) and the email check that
goes with it are the only writes the proxy lets a Viewer send. The Viewer was
never in `MFA_SELF_SERVICE_ROLES` and still is not, so Settings hides the MFA
card for it. It has no notifications (the notification list excludes the role).

Reads that do system bookkeeping are accepted as reads: opening the Budgets list
opens the month's period row at the baseline and settles expired add-ons,
exactly as Head Office's identical read does; opening a support thread records
the caller's own "read" marker.

### D4 — Prices and invoices

Prices stay visible (D6 of the original plan). Invoices become readable with
Head Office's reach (`lib/invoice-access-policy.ts`): the role now reads the
Consolidated Invoice Report, so refusing the single invoice behind a row would
be inconsistent. The fulfilment token is never shown.

### D5 — Pinned Viewers lose nothing and gain nothing

The branch-pinned Viewer's four dashboard routes are unchanged. Several
analytics helpers treat an unknown role carrying an organization as
organization-wide, so before this change a pinned Viewer calling those
endpoints directly would have read its whole tenant. Every analytics handler
that scopes through those helpers now refuses a pinned Viewer, and the GET
isolation sweep pins it.

## 3. Tests

* `lib/viewer-access.test.ts` — `viewerReadRole` table; the route list is the
  control; areas for pinned vs organization-wide; the proxy's write fence.
* `proxy.test.ts` — organization-wide Viewer reaches every Head Office area and
  is refused writes; pinned Viewer still confined to `/dashboard`.
* `tests/integration/viewer-write-sweep.test.ts` — **new**, as above.
* `tests/integration/viewer-isolation-sweep.test.ts` — **new**: every GET
  handler as an organization-wide Viewer returns nothing from another tenant;
  as a pinned Viewer, only the dashboard routes (and own-account reads) answer
  and nothing from a sibling branch leaks.
* `tests/integration/viewer-role-api.test.ts` — updated for the widened reach.

## 4. Found on the way — fixed here

* **`GET /api/v1/branch/inventory` read any tenant for Head Office.** The
  resolver took `organizationId` from the query string for Head Office as well
  as Super Admin, so Head Office could read another tenant's branch catalogue
  and prices. Only Super Admin chooses the tenant now.
* **A branch-pinned Viewer read past its branch** on handlers with no role
  allowlist, because the analytics scope helpers treat an unrecognised role
  that carries an organization as organization-wide:
  `analytics/products/catalog-performance` (every branch's figures), the
  sibling branch names in the `sales-performance` breakdown, and the tenant's
  groups and catalogue. Each now scopes through `viewerReadRole`, and
  `viewer-isolation-sweep.test.ts` holds the pinned Viewer to its dashboard's
  four routes.
* **`/activity` was not in the proxy's `protectedPrefixes`**, so its entry in
  `ROLE_GATED_AREAS` never ran for any role. The page and its endpoint
  checked regardless; the proxy now does too.
* The Viewer's top bar offered an "All Organizations" picker (the context
  selector fell through to Super Admin's); it now gets Head Office's read-only
  breadcrumb.

## 5. Rollout

No migration. Existing organization-wide Viewers see the full menu on their
next page load; pinned Viewers are unchanged. Rollback is a code revert.
