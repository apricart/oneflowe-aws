# OF-SUPPORT — Support queue: organization, branch and group filters

## Request

The support queue (`/support`) filters only by status and category. Apricart
Support needs searchable filters for **organization, branch and group**, and the
search box must accept a **transaction ID**.

## Findings

- The search box already matched the cited order's transaction ID
  (`orders.tid ILIKE`, escaped) and, for a bare number, the order id. It was
  labelled "Search by order ID", which read as if transaction IDs were not
  supported. Only the label changes.
- The list route already let Apricart's side narrow by `organizationId`; the
  page never offered it.

## Design

- **Filtering** (`listSupportThreads`): `branchId` and `groupId` join
  `organizationId`. A thread is "at" a branch when it was raised there **or**
  cites an order there — a Head Office query has no branch of its own, so the
  order is often the only place it names. Group = either of those branches'
  `group_id`. Both sides hold the branch/order to the thread's own organization,
  `EXISTS` so the count still reads `support_threads` alone.
  Every filter is pushed onto the array the scope condition opens, so it only
  narrows. Branch and group are accepted from every participant (narrowing within
  one tenant is harmless); organization stays Apricart-side only, as before. A
  malformed id is ignored (`parseSupportPlaceFilterId`), never "match nothing".
- **Options** (`GET /api/v1/support/filters`, `getSupportFilterOptions`): the
  organizations, branches and groups **the caller has a thread at**, under the
  same `supportScopeCondition`. No parameters; ids and names only; bounded at
  `SUPPORT_FILTER_OPTIONS_MAX`; `private, no-store`. Organizations are returned
  only to Apricart's side. Deriving the choices from visible threads rather than
  the tenant tables means Apricart Support and the warehouse need no new read
  of organizations or branches, and nothing outside their queue is named.
- **Access**: the route is added to `APRICART_SUPPORT_API_RULES` and
  `WAREHOUSE_API_RULES` (GET only), and to the support contract route list.
- **UI**: `SupportFilterCombobox` (Popover + Command, searchable) for each
  filter. Organization shows when more than one is offered; group when any is;
  branch when more than one is. Choosing an organization or group clears a
  branch/group that cannot match it; branch options narrow to the chosen
  organization and group.

## Tests

- Unit: `parseSupportPlaceFilterId`; contract assertions in
  `lib/server/support-boundaries.test.ts` (filters only narrow, tenant held,
  options scoped and bounded, organizations Apricart-only); allowlists.
- UI: branch and group selection reach the list request; organization filter
  absent for a single tenant.
- Integration (`tests/integration/support-threads-api.test.ts`): branch by raiser
  and by cited order, group, combined filters, malformed ids ignored, no widening
  across tenants/branches/own scope, options per role. The warehouse isolation
  sweep covers the new GET.

## Database / rollout

No schema change, no migration. Rollback is reverting the change.
