# Apricart Support role

## The requirement

> A new Apricart-internal role whose user reaches **only** the support page, and
> on that page can do everything Super Admin does.

Today Apricart answers support threads as `SUPER_ADMIN`, so whoever handles
the queue holds the keys to the whole platform — pricing, tenants, users,
refunds. This role separates the two: a support agent works the queue and
nothing else.

## The rule this change implements

`APRICART_SUPPORT` (shown as **Apricart Support**) is Apricart's own staff, on
the **Apricart side** of every support conversation, exactly as Super Admin is:

| Support activity (Super Admin today)                    | Apricart Support |
|---------------------------------------------------------|------------------|
| Read every thread, in every organization                | yes              |
| Filter the queue by organization, see the Apricart KPIs | yes              |
| Reply, with image attachments                           | yes              |
| Resolve / reopen a resolved thread                      | yes              |
| Triage: priority, close, reopen a closed thread         | yes              |
| Be assigned a thread (`assignedToUserId`)               | yes              |
| Emailed when a customer writes, resolves or opens       | yes              |
| Raise a thread                                          | no — nor can Super Admin; Apricart has no tenant to raise one for |

And nothing outside `/support`:

- **No organization and no branch.** Its reach is every tenant's support
  threads, by definition, so neither is written onto the user row.
- **Only Super Admin creates or manages one** — `ROLE_LEVEL` 7, beside
  `ORDER_DESK`, `APRICART_EXECUTIVE` and `WAREHOUSE`. The account can never be
  switched into or out of the role; create a separate account instead.
- **Confined by `proxy.ts`** to the `/support` pages (plus `/change-password`)
  and to `APRICART_SUPPORT_API_RULES` (`lib/apricart-support-access.ts`): the
  support thread, message, stats and attachment calls the page makes, and the
  password-change calls. Every other API call is 403 before a handler runs.
  That is a second layer: each listed handler already checks
  `isSupportParticipantRole` and the thread visibility itself.
- **The invoice link on an order-referencing thread is not shown** to this
  role: the invoice page is outside its area, and its invoice policy refuses it
  (no organization, `branches: "none"`).

### Where "Apricart side" is decided

Once, in `lib/support-thread.ts`: `SUPPORT_APRICART_ROLES =
["SUPER_ADMIN", "APRICART_SUPPORT"]`, read by `supportSideForRole` and
`isSupportApricartRole`. Every former `role === "SUPER_ADMIN"` comparison in the
support code reads it instead — visibility (`all`), the order-reference rule,
the organization filter on the list, the Apricart recipients of a notification,
the assignee check, the `toApricart` email flag and the responder's display
name fallback. `lib/support-access.test.ts` pins that no support module compares
against `"SUPER_ADMIN"` directly any more.

### Notifications

A support agent is an Apricart recipient for **email**, like Super Admin. It is
**not** given in-app bell rows: it has no topbar and the notifications API is
outside its allowlist, so the rows could never be read. The unread marker in the
thread list is how it sees movement. The delivery-time re-check
(`deliverClaimedSupportEmail` → `canReadSupportThread`) applies unchanged.

## Non-goals

- No per-organization assignment of agents. Super Admin reads every tenant's
  queue today and the requirement is parity; narrowing later is an assignment
  table and a scope kind in `supportThreadVisibilityScope`, as the executive's
  approval reach was done.
- No assignment UI. Assignment is API-only today for Super Admin too.
- No invoice/order reading for the agent.

## Changes

| Area | Change |
|---|---|
| `drizzle/20261023120000_add_apricart_support_role.sql` | insert the `roles` row (not the seed, which rewrites `role_permissions`) |
| `lib/apricart-support-access.ts` | role, label, home, area, API allowlist, account shape and access-change rules |
| `lib/rbac.ts`, `lib/auth.ts`, `lib/server/mutation-validation.ts`, `lib/server/user-access-policy.ts`, `lib/permissions.ts`, `lib/invoice-access-policy.ts`, `lib/activity-log.ts`, `lib/activity-log-view.ts` | the role in every role list |
| `lib/support-thread.ts`, `lib/support-access.ts`, `lib/server/support-*.ts`, `app/api/v1/support/threads/route.ts` | Apricart side by `SUPPORT_APRICART_ROLES` |
| `proxy.ts` | API confinement, single-area confinement to `/support` |
| `app/api/v1/users/route.ts`, `app/api/v1/users/[id]/access/route.ts` | no organization/branch; role fixed |
| `app/(auth)/login/page.tsx` | lands on `/support` |
| `app/support/layout.tsx`, `components/support/*` | header with profile menu (sign out, reset password); no "back to dashboard"; no invoice link |
| `components/users/create-user-dialog.tsx`, `components/users/head-office-users-table.tsx` | Super Admin can create and filter the role |

## Tests

- `lib/apricart-support-access.test.ts` — the role in every list; allowlist
  admits/refuses; every allowlisted handler exists and checks the support
  participant rule; the proxy enforces it; Super Admin alone creates/manages it;
  creates no orders, writes no prices.
- `lib/support-access.test.ts` / `lib/support-thread.test.ts` — the agent reads
  every organization, may triage, is the Apricart side; no support module
  compares against `"SUPER_ADMIN"` inline.
- `lib/support-shell.test.ts` — unchanged: the role does not wear the portal
  chrome.

## Rollout

1. `npm run db:migrate:prod` (dry run, then `--confirm=<digest>`) — adds the
   role row. Additive; nothing reads it until an account holds it.
2. Deploy.
3. Super Admin creates the support accounts on Users → Create User.

## Rollback

Deactivate every support account, deploy the previous build, then:

```sql
DELETE FROM "roles" WHERE "name" = 'APRICART_SUPPORT' AND NOT EXISTS (
  SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id");
```

Messages an agent wrote keep `author_role = 'APRICART_SUPPORT'` and
`author_side = 'APRICART'`; both are snapshots and remain correct.
