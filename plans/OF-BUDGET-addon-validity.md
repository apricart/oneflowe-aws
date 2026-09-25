# OF-BUDGET — One-time add-on budgets carry a validity date

## Objective

A one-time add-on credited to a branch's money budget is granted **with a
validity date**. When that date passes, whatever part of the add-on is still
unspent stops counting toward the branch's available budget, and the system
records how much was withdrawn so an administrator can see what each add-on
did.

Today an add-on simply increases `budgets.amount_credited_cents` for the
current month and lives until the month rolls over. Nothing records when it
should stop, and nothing withdraws it.

## Acceptance criteria

1. Granting an add-on (`PUT /api/v1/budgets`, `type: "addon"`, amount > 0)
   **requires** a `validUntil` date. The date must be today or later and must
   fall inside the current budget month (add-ons already reset at month end,
   and the row they sit on is monthly). Malformed, past, or next-month dates
   are refused with 400 and a field-level message.
2. The add-on is available until **23:59:59 Asia/Karachi** on the chosen day.
3. After that instant, the **unspent part of the add-on is withdrawn**: the
   branch's `remainingCents` drops by `min(addonAmount, remainingAtExpiry)`,
   never below zero, and the withdrawal never violates
   `budgets_values_valid_ck` (spent + held are untouched).
4. The withdrawal is recorded on the add-on's own ledger row
   (`expired_at`, `forfeited_cents`) and in `audit_logs`
   (`EXPIRE_BUDGET_ADDON`), so "consumed all / 20% / 0%" is answerable per
   add-on.
5. An expired add-on cannot be spent: order placement, order edit and group
   order creation see the withdrawn figure even if nobody has opened the
   Budgets page since the date passed.
6. Add-ons granted before this change (no `valid_until`) behave exactly as
   before: they last until month end and are never withdrawn early.
7. The Budgets page collects the date in the add-on dialog and shows, per
   branch, the add-ons still in force and their dates; the shop shows the
   employee that part of the budget is time-limited.

## The consumption rule (decided 2026-09-19: ceiling model)

The branch has one pooled budget. To say what "unspent part of the add-on"
means, the rule is: **an add-on raises the branch's ceiling until its date;
the base allocation is spent first; on the date the ceiling drops back by
whatever part of the add-on is still unspent, but never below what is already
spent or held.**

Formally, at settlement time `T` for a budget row `B`, take every add-on on `B`
with `valid_until <= T` and `expired_at IS NULL`, ordered by `valid_until`,
then `id`. Walk them:

```
remaining = B.allocated + B.credited − B.spent − B.held
for each expired add-on A:
  forfeited(A) = clamp(min(A.amount, remaining), 0, A.amount)
  remaining   −= forfeited(A)
  B.credited  −= forfeited(A)
  A.expired_at = T, A.forfeited_cents = forfeited(A)
```

Properties that matter:
- Pure arithmetic on the row; no per-add-on spend snapshot, so refunds
  (which credit the same column) and order edits cannot confuse it.
- `B.credited` only ever falls by an amount ≤ current remaining, so
  `allocated + credited ≥ spent + held` still holds and the check constraint
  cannot reject the update.
- Idempotent: a settled row (`expired_at` set) is never touched again.
- The rejected alternative, "add-on consumed first, like a telecom bundle",
  needs a spent-at-grant snapshot per add-on and would rarely withdraw
  anything when a base allocation exists.

## Architecture

| Piece | Layer | File |
|---|---|---|
| Ledger columns | persistence | `db/schema.ts` (`budgetAddons`), `drizzle/20260919120000_budget_addon_validity.sql` |
| Validity parsing + settlement arithmetic (pure) | domain | `lib/budget-addon-expiry.ts` + `.test.ts` |
| Settlement against the database | server domain | `lib/server/budget-addon-expiry.ts` |
| Grant with validity; settle on read/write | route | `app/api/v1/budgets/route.ts` |
| Settle before holding budget | route / server | `app/api/v1/orders/route.ts`, `app/api/v1/orders/[id]/route.ts`, `lib/server/group-order-creation.ts` |
| Periodic sweep | route (cron) | `app/api/v1/budgets/cron/expire-addons/route.ts` |
| Date input, add-on list | UI | `app/(portal)/budgets/page.tsx`, `app/shop/page.tsx` |

### Why materialise rather than compute on read

`budgets.amount_credited_cents` is read directly by ~20 runtime call sites
(order hold, group orders, analytics, exports, KE scripts). Making each of
them subtract expired add-ons is the bug factory this plan avoids. Instead the
settlement **writes the withdrawal onto the row**, so every existing reader
stays correct and the check constraint keeps guarding it. The ledger row keeps
the history.

### When settlement runs (lazy + sweep)

Settlement is cheap (one indexed lookup; no write unless something expired)
and idempotent, so it runs at every point where the figure matters:

1. **Order placement** — inside the transaction, right after the
   `FOR UPDATE` lock on the budget row, before the hold. This is the security
   control; everything else is for display and reporting.
2. **Order edit** (`lockAndValidateOrderBudget`) and **group order creation**
   — same point, same reason.
3. **Budgets GET** — single-branch (shop and dialog) and the current-period
   list, before computing `remainingCents`. Same pattern as the existing
   `syncCurrentMoneyBudgets` write-on-read.
4. **Budgets PUT** — inside the transaction after the lock, before the new
   figure is applied, so a fresh add-on is never computed on top of a stale
   one.
5. **Cron sweep** `POST /api/v1/budgets/cron/expire-addons` — bearer
   `CRON_SECRET`, same shape as `orders/cron/auto-fulfill`. Keeps reports and
   exports honest for branches nobody has looked at since the date passed.
   `{ "dry_run": true }` previews.

## API

### `PUT /api/v1/budgets` (existing, extended)

Body gains `validUntil?: "YYYY-MM-DD"`. Rules, enforced server-side:
- `type === "addon"` and `amountAllocatedCents > 0` → `validUntil` required.
- Ignored (must be absent) for `type === "monthly"` and for the
  reset-to-zero calls the Empty buttons send.
- Must parse, be a real calendar day, end after `now`, and fall in a month
  `addonPeriodsOpenAt(now)` allows: the **UTC** `YYYY-MM` the ordering
  engine bills against (`currentBudgetPeriod`) or the Asia/Karachi month the
  administrator is in. Those are one month except between 00:00 and 05:00
  Karachi on the first of a month, when the engine still bills last month.
- **The add-on is filed on the row for the month its date is in**, not
  blindly on the engine's current period. In normal hours that is the same
  row. In the small-hours window a date in the new month lands on the new
  month's row — opened at the baseline if it does not exist yet — where it
  becomes spendable the moment the engine rolls over, and a date in the old
  month is refused because that day has ended. Nothing is refused for lack
  of any valid date, and nothing is filed on a row about to be superseded.
  Baseline updates and the reset-to-zero calls carry no date and stay on the
  engine's current period.

Response for add-ons gains `validUntil` (ISO instant). Audit metadata gains
`validUntil` and the ledger id.

`resetAddons: true` now also closes every open add-on on the row
(`expired_at = now`, `forfeited_cents` by the same walk) before zeroing
credited, so the ledger never shows an add-on as live after an Empty.

### `GET /api/v1/budgets` (existing, extended)

Both the single-branch payload and each row of the `all=true` list for a
single period gain:

```
addons: Array<{ id: number; amountCents: number; validUntil: string | null }>
```

Only open add-ons (not yet settled) for that period. `amountCents` is already
in `ANALYTICS_MONEY_KEYS`, so price redaction covers it. The aggregated
(multi-period) list does not carry it.

### `POST /api/v1/budgets/cron/expire-addons` (new)

`Authorization: Bearer <CRON_SECRET>` → 401 otherwise. Settles up to 200
budget rows per call. Returns `{ dryRun, settled, withdrawnCents, budgetIds }`;
with `{ "dry_run": true }` it returns the due ids and writes nothing. It is
not yet wired to a scheduler — the lazy settlement covers every user-facing
path on its own; scheduling it is an infrastructure change alongside
`auto-fulfill`.

## Data

`budget_addons` gains three columns and one partial index. Purely additive,
`IF NOT EXISTS`, no backfill; rolling the application back leaves them unused.

| Column | Type | Meaning |
|---|---|---|
| `valid_until` | timestamptz null | instant the add-on stops being available; NULL = legacy, lasts the month |
| `expired_at` | timestamptz null | when the system settled it |
| `forfeited_cents` | bigint not null default 0 | what the settlement withdrew |

Check `budget_addons_forfeit_bounds_ck`: `forfeited_cents BETWEEN 0 AND amount_cents`.
Index `budget_addons_open_expiry_idx ON (valid_until) WHERE expired_at IS NULL`
for the sweep; the per-budget path uses the existing `budget_id` index. The
table is small (one row per add-on ever granted), so a plain `CREATE INDEX`
is fine.

Rollback: drop the three columns and the index in a later release once the
code that writes them is gone; nothing else references them.

## Security

- No new permission. Granting stays behind `canManageMoneyBudgets` +
  `allocationAccessError` (tenant + assigned-branch fence). The date is just
  another validated field on that request.
- Settlement never widens scope: the lazy paths settle only budget ids the
  caller has already been scoped to; the cron settles globally but is behind
  `CRON_SECRET` and writes nothing a caller could steer.
- `validUntil` is Zod-validated at the boundary (`^\d{4}-\d{2}-\d{2}$`) and
  bounded to the current month; nothing from it reaches SQL except as a
  parameter.
- The settlement is a financial write: it runs in a transaction under
  `FOR UPDATE`, and every withdrawal writes an `audit_logs` row
  (`EXPIRE_BUDGET_ADDON`, `user_id` null for system, or the actor when it is
  triggered inside a user's request).
- Replay: the settle is idempotent by construction (`expired_at IS NULL`
  predicate under the lock); a concurrent caller finds nothing to do.
- Threats considered: spending an expired add-on via a path that skipped
  settlement (covered by settling under the same lock the hold takes);
  an admin back-dating to extend an add-on (dates are validated ≥ today and
  ≤ month end; extending means granting a new one, which is audited);
  cross-tenant settlement (filters carry the caller's scoped ids only).

## Tests

Unit (`lib/budget-addon-expiry.test.ts`):
- `planAddonSettlement`: nothing expired → no change; one expired fully
  unspent → whole amount withdrawn; partially spent → capped at remaining;
  remaining already 0 → withdraws 0 but still closes the row; two add-ons
  expiring together → earlier `valid_until` withdrawn first, cap shared;
  NULL `valid_until` never expires; already-settled rows ignored;
  credited never goes below 0 and `allocated + credited ≥ spent + held`
  after every plan.
- `resolveAddonValidUntil`: valid date → 23:59:59.999+05:00 of that day and
  its `YYYY-MM`; yesterday → refused; next month → refused; malformed →
  refused; today → accepted; last day of the month → accepted. In the
  small-hours window: `addonPeriodsOpenAt` opens both months; a new-month
  date is accepted on the new month; the old month's last day is refused as
  passed; the month after next is refused.
- Validation schema: `validUntil` shape.

Integration (`tests/integration/budget-addon-expiry.test.ts`, needs
`TEST_DATABASE_URL`; the clock is pinned with a fake `Date` only, so the
tests can walk an add-on past its date without touching the driver's
timers):
- PUT add-on without `validUntil` → 400; past / next-month / malformed →
  400; `validUntil` on a baseline update → 400; with it → 200, ledger row
  carries `valid_until`, credited raised, audit carries the date.
- Settlement: after `valid_until` passes, single-branch GET and list GET show
  the reduced `remainingCents`, ledger row closed with the right
  `forfeited_cents`, audit row written, second read is a no-op; capped at
  remaining; a fully consumed add-on closes with 0 withdrawn; a legacy row
  is never touched; a new grant settles what expired first.
- In the small-hours window (clock pinned to 20:00Z on the period's last
  day): the old month's last day → 400; a new-month date → 200, filed on the
  new month's row, which is opened at the baseline with the credit on it,
  while the current row is untouched.
- Reset closes every open add-on with a `RESET_BUDGET_ADDONS` audit row.
- `group-roles-api.test.ts`: the single-branch read fence — foreign Head
  Office → 403 and no row opened; unknown id → 404; own tenant → 200.
- Cron route: no bearer → 401; `dry_run` writes nothing; a real run settles.
- Existing `group-roles-api.test.ts` add-on calls gain `validUntil` (the
  contract changed; noted here deliberately).

The "cannot spend an expired add-on" guarantee is not driven through
`POST /api/v1/orders` — no integration fixture seeds branch inventory or an
ordering user, and building one is a separate piece of work. Instead the
settlement is exercised directly under a transaction (the same call the
order path makes under the same lock), and `lib/server/budget-addon-expiry.test.ts`
is a source contract that pins every hold path to settle before it checks
the budget. A new spending path belongs on that list.

## Risks

- **Live tenant impact**: existing add-on rows have NULL `valid_until` and
  are never settled, so no existing balance moves on deploy. The first
  withdrawal happens only for add-ons granted after deploy, on the date the
  administrator chose.
- **Blast radius of the lazy settle**: it adds one indexed query to budget
  reads and one under the existing lock on order placement. If the
  `budget_addons` lookup ever failed it would fail the request; it is a
  plain select on a small table.
- **Wrong rule**: if the ceiling model turns out not to be what
  administrators mean, the ledger still holds every grant with its date, so
  a different rule can be applied later; nothing is lost.
- **Timezone**: validity is end-of-day Asia/Karachi, matching how the app
  already derives the budget period. A server in UTC does not shift it.

## Found along the way, fixed in the same change

`GET /api/v1/budgets?branchId=<id>` for `HEAD_OFFICE` read any branch by id
with no tenant predicate (`loadSingleBranchBudget` is keyed on the id alone;
only `SUPER_ADMIN` and `HEAD_OFFICE` may pass one), and that load opens the
period row when it is missing — so a cross-tenant read also wrote a row into
the other organization. Now a branch id that arrived on the query string
passes `queriedBranchAccessError` before the load: 404 when the branch does
not exist, 403 "Branch belongs to different organization" when it is outside
the caller's tenant — the same fence and message the PUT already used
(`tenantFenceError`, shared by both). The session's own branch (the shop's
read) is scoped by construction and is not re-fenced, so a malformed legacy
session cannot start refusing the shop. Pinned by an integration test that
reads a fresh branch as the foreign Head Office and checks no row appeared.

## Steps

1. Schema + migration + journal entry. `npm run db:validate`.
2. `lib/budget-addon-expiry.ts` (pure) with tests.
3. `lib/server/budget-addon-expiry.ts` (settle under lock, audit).
4. Wire settlement into orders POST, orders PATCH, group order creation.
5. Extend `moneyBudgetUpdateSchema`; wire grant-with-validity, reset closing
   rows, settle-on-read, `addons` in GET payloads.
6. Cron route.
7. UI: date field in the dialog, add-on list per row, shop hint.
8. Integration tests; update `group-roles-api.test.ts` fixtures.
9. Gates: typecheck, lint, test, build, test:integration (against the local
   docker test database — confirm it ran).
10. Security self-review of the diff; update this plan if anything diverged.
