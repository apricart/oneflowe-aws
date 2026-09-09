# OF-SUPPORT — sidebar chrome on `/support`, and a KPI row

## Problem

Two complaints, from the same screen.

1. **`/support` drops the navigation.** `app/support/layout.tsx` renders its own
   minimal shell, so an administrator who clicks *Support* in the sidebar loses
   the sidebar and can only get back through a "Back to dashboard" link. The
   comment there gives the reason — an `ORDER_PORTAL` user arriving from `/shop`
   must not land inside the administrator's navigation — and that reason is
   still right. It is the *unconditional* part that is wrong.
2. **The queue has no figures.** Every other landing screen in the portal leads
   with a KPI row; support opens on a filter bar and a list, so nobody can see
   how much is outstanding without counting rows.

## Decisions

### The shell is chosen by role, from one pure rule

`lib/support-shell.ts` holds `supportUsesPortalShell(role)`. True for the roles
the sidebar already builds a menu for — `SUPER_ADMIN`, `HEAD_OFFICE`,
`BRANCH_ADMIN`, `GROUP_USER`; false for `ORDER_PORTAL` and
`GROUP_ORDER_PORTAL`, who live in `/shop` and `/group-portal` and keep the
minimal shell they have today.

The rule has to agree with `components/shell/sidebar.tsx`, which is where a role
either does or does not get a `/support` entry. A contract test reads that file
and asserts the two lists match, so adding a role to the sidebar without adding
it here fails rather than producing a menu entry that leads somewhere menu-less.

The portal chrome itself is extracted from `app/(portal)/layout.tsx` into
`components/shell/portal-shell.tsx` and used by both layouts, so the two cannot
drift. `PreloadData` stays opt-in: the support page has no use for a prefetched
order and user list, and firing those requests from it is waste.

Because the layout now supplies the `<main>` landmark, `SupportList` and
`SupportThreadView` drop their own `<main>` wrappers — nested `<main>` is
invalid, and the landmark belongs to the shell.

`SupportHeader` gains an `embedded` variant: inside the portal chrome it loses
the back button (the sidebar is the way back) and the white banner, which would
otherwise sit directly under the topbar as a second one.

### KPIs come from a scoped endpoint, never from the loaded page

`GET /api/v1/support/stats` → `getSupportThreadStats(viewer)` in
`lib/server/support-threads.ts`, built on the **existing**
`supportScopeCondition`. That is the whole tenant-isolation story: a branch
administrator's counts cover the same threads their list covers, because both
predicates come from `supportThreadVisibilityScope`. There is no
`organizationId` parameter — not even for Apricart — so there is nothing to
widen, and the counts are one aggregate query rather than one per tile.

Counting on the client from the loaded page was rejected: the list is paginated
at 20, so every figure would have been wrong.

The stats deliberately ignore the list's status/category filters. A KPI row is
the overview the filters narrow *against*; recomputing it per filter would make
"3 open" disappear the moment someone filtered to resolved.

### Which figures, and for whom

The two sides of a support conversation care about different things, the same
way they already read the same status differently
(`SUPPORT_STATUS_LABELS_APRICART`). `supportStatCards(stats, side)` in
`lib/support-stats.ts` is pure and decides both the set and the wording:

| Apricart | Customer |
|---|---|
| Total requests | Total requests |
| Needs a reply | Open |
| Never answered | Awaiting your reply |
| Urgent & high | Unread |
| Avg first reply | Resolved |
| Settled | Raised this week |

`firstResponseAt`, `resolvedAt` and `closedAt` are already on the table — the
schema comment says they were recorded so response time could be measured
without a backfill — so "avg first reply" needs no migration.

Tiles that map to exactly one status carry that status and filter the list when
clicked; "Settled" (resolved *and* closed) and "Avg first reply" do not map to
one filter and are inert.

## Files

| File | Change |
|---|---|
| `lib/support-shell.ts` | new — the pure shell rule |
| `lib/support-shell.test.ts` | new — behaviour + the sidebar contract |
| `lib/support-stats.ts` | new — pure stat shape, wording, formatting |
| `lib/support-stats.test.ts` | new |
| `components/shell/portal-shell.tsx` | new — chrome extracted from the portal layout |
| `app/(portal)/layout.tsx` | uses `PortalShell` |
| `app/support/layout.tsx` | picks the shell by role |
| `lib/server/support-threads.ts` | `getSupportThreadStats` |
| `app/api/v1/support/stats/route.ts` | new endpoint |
| `lib/server/support-boundaries.test.ts` | the new route joins `SUPPORT_ROUTES` |
| `components/support/support-stats.tsx` | new — the KPI row |
| `components/support/support-list.tsx` | renders the row, owns the status filter |
| `components/support/support-chrome.tsx` | `embedded` header variant |
| `components/support/support-thread-view.tsx` | landmark + embedded header |

## Security impact

- New read endpoint. Authenticates, checks `isSupportParticipantRole`, rate
  limits through `withRateLimit("search")`, scopes through
  `supportScopeCondition`, errors through `handleError`. Added to the contract
  test's route list.
- No tenant identifier is read from the request anywhere in it.
- Aggregate counts only — no subject, no message body, no name leaves the
  endpoint, so a tile cannot disclose a thread the caller could not open.
- The shell change is presentation. `proxy.ts` already admits every
  participant role to `/support`, and the endpoints behind the page decide what
  is returned; wearing the sidebar grants nothing.

## Database impact

None. No schema change, no migration. One added aggregate query over
`support_threads`, filtered by the indexed scope columns.
