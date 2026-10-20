# Warehouse: the support queue of the branches it serves

## The requirement

> Give the warehouse user access to `/support`, and make sure it receives the
> support queries of only the organizations and branches assigned to it.

## The rule this change implements

`WAREHOUSE` joins the support conversation **on Apricart's side**, as Super
Admin and Apricart Support do — it replies as Apricart, resolves, closes,
reopens and reprioritises — but its queue is **fenced to its reach**, never the
whole platform.

| | Super Admin, Apricart Support | Warehouse |
|---|---|---|
| Side of the conversation | Apricart | Apricart |
| Threads it reads | every thread, every organization | a thread **at a branch it serves**, or one that **cites an order at a branch it serves** |
| Reply, resolve, triage (priority, close, reopen) | yes | yes, on those threads |
| Raise a thread | no (no tenant) | no (no tenant) |
| Emailed when a customer writes, opens or resolves | every thread | only threads it can read |
| Bell rows | Super Admin yes; agent no | no — its bell lists order-stage notices only |
| Assignable (`assignedToUserId`) | yes | no — an assignee must be able to read every thread |

"Branches it serves" is `loadWarehouseReach` — the branches assigned one by one
on Warehouse Team **and** every branch in a city assigned to it — re-read from
the database on every request, exactly as every other warehouse endpoint does.
The Warehouse Team page assigns branches per organization, so "the
organizations assigned" is the organizations of those branches; a warehouse is
never given a whole organization, and this change does not add one.

**A thread with no branch and no order is not in any warehouse's queue.** Head
Office has no branch, so a Head Office thread that cites no order is an
organization-wide matter (billing, a catalogue question) that no single
warehouse is accountable for. It stays with Super Admin and Apricart Support.
A Head Office thread that cites an order at a served branch *is* in the queue.

### Where it is decided

- `lib/support-thread.ts` separates two questions that were one list:
  `SUPPORT_APRICART_ROLES` (which **side** a role speaks for — now including
  `WAREHOUSE`) and `SUPPORT_WHOLE_QUEUE_ROLES` (who reads **every** tenant, is
  mailed for every thread and may be assigned one — still Super Admin and
  Apricart Support only).
- `lib/support-access.ts`: `WAREHOUSE` is a participant; its visibility scope
  is `{ kind: "branches", branchIds }`, built from `SupportViewer.reachBranchIds`.
  A viewer without a loaded reach — or with an empty one — is `none`, so a path
  that forgets to load the reach shows nothing rather than everything.
- `lib/server/support-session.ts`: `withSupportReach(viewer)` loads the reach
  for a warehouse viewer; every support handler calls it.
- `lib/server/support-threads.ts`: the `branches` scope becomes SQL — the
  thread's branch in reach (and of the thread's own organization), or an
  `EXISTS` on the cited order at a branch in reach (and of the thread's own
  organization).
- `lib/server/support-notifications.ts`: a customer's message or status change
  mails the whole-queue roles and the warehouse users whose reach covers the
  thread. The delivery-time re-check reloads the warehouse's reach, so a branch
  withdrawn between queueing and sending is not mailed.

### Confinement

- `WAREHOUSE_AREAS` gains `/support`.
- `WAREHOUSE_API_RULES` gains exactly the calls the Apricart side of the support
  pages makes — the same set as `APRICART_SUPPORT_API_RULES` — and not
  `POST /api/v1/support/threads` or `/api/v1/support/products`.
- The support layout gives the warehouse a bar with its profile menu and a link
  back to `/warehouse`; the thread page names an order's invoice without
  linking it (the warehouse prints invoices from its own order sheet).
- The warehouse workspace menu gains **Support**, with the unread count from
  `GET /api/v1/support/stats`.

### People's names

The warehouse's own order reads name no one. A support thread is a
conversation with a person, so the thread and message authors' names are shown
to it, as they are to every Apricart reader. That is deliberate and limited to
the threads in its reach.

## Non-goals

- No organization-wide assignment for warehouses.
- No support rows in the warehouse bell.
- No raising of threads by the warehouse.

## Tests

- `lib/support-access.test.ts`, `lib/support-thread.test.ts` — the warehouse is
  Apricart's side, triages, reads exactly its branches and cited orders, reads
  nothing without a loaded reach.
- `lib/apricart-support-access.test.ts` — the whole-queue list stays two roles.
- `lib/warehouse-access.test.ts` — the allowlist admits the support calls and
  refuses raising a thread and the product picker; every support handler loads
  the reach.
- `tests/integration/warehouse-support-api.test.ts` — list, detail, stats,
  reply, triage, attachments and notifications against a real database, with
  in-reach, other-branch, other-tenant, city-reach and order-cited threads.
- `tests/integration/warehouse-isolation-sweep.test.ts` — out-of-reach threads
  planted with markers; the products picker reviewed as answering an
  organization-less caller with an empty list.

## Rollout

No migration. Deploy. Warehouse users see the threads of the branches already
assigned to them on Warehouse Team.

## Rollback

Deploy the previous build. Messages a warehouse user wrote keep
`author_role = 'WAREHOUSE'` and `author_side = 'APRICART'`; both are snapshots
and remain correct.
