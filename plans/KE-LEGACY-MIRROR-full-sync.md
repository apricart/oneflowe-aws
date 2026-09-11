# KE-LEGACY-MIRROR — Full K-Electric legacy mirror

No Jira ID was supplied; rename this file when one exists.

## Objective

One command that makes the K-Electric organization in OneFlowe mirror the
legacy logistics portal (`https://logistics.oneflowe.com`) for **branches,
groups, products, users and orders**, such that:

- a K-Electric person signs in with the username and password they use on the
  legacy portal;
- a person legacy holds no email address for gets a derived, unroutable one;
- an employee code carrying punctuation yields a username of letters and digits
  only;
- it runs against an **empty** database (the test database has no K-Electric
  organization) and is **safe to re-run** against production, which already
  holds 323 K-Electric accounts, 134 branches and ~880 orders.

### Acceptance criteria

1. `npm run sync:ke` on the empty test database creates the organization, its
   branches, groups, catalogue, users and orders, and the resulting row counts
   match the legacy portal.
2. A user row created by the sync can authenticate through
   `authorizeStaffPassword` with the legacy passcode/password pair.
3. Re-running the command immediately afterwards writes nothing (idempotent).
4. Running it against a database that already holds K-Electric data adds only
   what is missing and modifies nothing that a person has since changed.
5. Dry run is the default; committing requires the confirmations the dry run
   printed, including a plan digest.
6. No organization other than K-Electric is read or written.

## Current state

Already built and working — this plan extends it, it does not replace it:

| Piece | Where | Status |
|---|---|---|
| Pure planners: branches, groups, username migration, users | `lib/legacy-import/ke-sync.ts` (829 lines, 554-line test) | done |
| Apply: org-pinned branches + user pairs, `external_source`/`external_id` stamping, dry run + digest | `scripts/sync-ke.ts` | done |
| Legacy credential mirroring | `hashMirroredLegacyPassword` in `lib/password-cli.ts` | done |
| Derived email for people with none | `fallbackEmail` → `@ke-legacy.invalid` | done |
| Orders from the legacy API, with rollback and validate counterparts | `scripts/import-ke-orders.ts` | done |
| Budget spend backfill | `scripts/backfill-ke-budget-spend.ts` | done |

`sync-ke.ts` documents two deliberate refusals: it will not create groups, and
it will not create catalogue entries, "because both carry pricing scope and
pricing is `SUPER_ADMIN`-only". **This plan reverses both** — see Decisions.

## Gaps to close

1. **Products are never created.** `import-ke-orders.ts` resolves each order
   line through `organization_inventory` → `global_products` and
   `legacy_product_mappings`, and rejects the order with `PRODUCT_NOT_FOUND`
   when there is no match. On an empty database every order fails. This is the
   single biggest gap.
2. **Groups are planned but not applied.**
3. **Orders are a separate command**, so "make it match" is three commands with
   an ordering constraint a person has to remember.
4. **Employee code is used verbatim**: `String(subUser.Passcode ?? "").trim()`.
   No stripping of punctuation.
5. **Organization identity is hardcoded** — `KE_SYNC_ORGANIZATION = { id: 10,
   code: "0001", name: "K-Electric" }` — and the org must already exist.

## Architecture

Layering follows rule 01: planning is pure and lives in `lib/legacy-import/`,
all I/O and writes live in `scripts/`.

```
lib/legacy-import/
  ke-sync.ts          extend: sanitizeEmployeeCode, group apply plan, org bootstrap plan
  ke-products.ts      NEW  pure planner: legacy Item[] -> catalogue + org inventory
  ke-sync.test.ts     extend
  ke-products.test.ts NEW
scripts/
  sync-ke.ts          extend into the single entry point, phase-ordered
```

**One script, phases, one digest.** Not a new script: `sync-ke.ts` already owns
the fetch, the confirmation protocol and the digest, and duplicating that is how
the eleven one-off KE scripts happened. Orders stay in
`import-ke-orders.ts` — it is battle-tested and carries rollback and validate
counterparts — and are *invoked* as a phase, not inlined.

Phase order is forced by referential dependency:

```
0  organization   (bootstrap when absent)
1  branches       needs org
2  groups         needs branches
3  products       needs org           <- new
4  users          needs branches
5  orders         needs branches + users + products
6  budget spend   needs orders
```

Each phase is individually skippable (`--only=products`) so a failed run can be
resumed without redoing what already committed.

## Data

| Table | Phase | Key | Write |
|---|---|---|---|
| `organizations` | 0 | `code` | insert only when absent |
| `branches` | 1 | `external_source`+`external_id` | insert; pin existing by name once |
| `groups`, `group_branches` | 2 | name within org | insert |
| `global_products`, `organization_products`, `organization_inventory`, `legacy_product_mappings` | 3 | `legacy_product_mappings.normalized_name` | insert |
| `users` | 4 | `external_source`+`external_id`, else employee code | insert pair (`-ba`/`-op`) |
| `orders`, `order_items`, `legacy_order_imports` | 5 | `KE-LEGACY-<id>` invoice no. | existing script |
| `legacy_import_batches` | all | batch uuid | one row per commit |

Idempotency rests on `external_source`/`external_id` for branches and users,
`legacy_product_mappings` for catalogue, and the `KE-LEGACY-<id>` invoice number
for orders. No phase updates a row a person may have edited; it inserts what is
missing and reports the rest.

**No schema migration is required.** Every column needed exists.

## Security (rule 04)

- **Mirrored credentials.** Legacy passwords are 8-digit numerics and fail
  `validatePassword`. They are hashed through `hashMirroredLegacyPassword`,
  which exists for exactly this and is *not* shared with the UBL spreadsheet
  import path. `external_source` is set on every synced row, which by
  `loadStaffLoginRecord` means these accounts **cannot sign in by email**, only
  by username — load-bearing, because K-Electric emails are shared across up to
  18 accounts.
- **Pricing.** Phase 3 writes `base_price`. See Decision 2 — this needs
  explicit sign-off, because `lib/pricing-access.ts` makes price writes
  `SUPER_ADMIN`-only and `sync-ke.ts` currently refuses catalogue writes for
  that reason. A script is not a route handler, so the control is not bypassed
  technically, but the intent is being reversed and that belongs in `CLAUDE.md`.
- **Tenant isolation.** Every statement is scoped by the resolved organization
  id. Organization 2 (`K-E-Demo`) shares many K-Electric emails and must never
  be touched; the existing organization confirmation string guards this and is
  retained.
- **Legacy fetch.** Base URL is a constant, never user input — no SSRF surface.
  The legacy API takes credentials in the URL path
  (`GET /api/Login/{email}/{password}`); those come from the environment and are
  never logged.
- **Secrets** stay in the environment. The plan file written to disk contains
  no passwords.

## Tests (rule 03)

Unit, beside the code:

- `sanitizeEmployeeCode`: punctuation stripped, letters+digits kept, unicode,
  empty result rejected, collision between two codes that sanitise alike.
- `planProducts`: new product, already-mapped product, two legacy names that
  normalise to one, missing price, inactive product.
- `planOrganization`: absent → create; present by code → reuse; present with a
  different name → refuse.
- Idempotency: planning against the post-apply state yields an empty plan.

Integration, `tests/integration/`:

- Full sync against a disposable database, asserting counts and that a second
  run is a no-op.
- A synced user authenticates with the legacy pair; the same user is **refused**
  when signing in by email.

`npm run test:integration` skips silently without `TEST_DATABASE_URL` — its
value in `.env.local` currently has a **trailing quote** and would fail to
parse; that needs fixing before the integration suite means anything.

## Risks

| Risk | Blast radius | Mitigation |
|---|---|---|
| Run against production by mistake | 323 accounts, 880 orders | dry run default; org confirmation; plan digest; print target host and refuse without `--commit` |
| Price data written to live catalogue | every K-Electric order total | Decision 2; phase skippable; prices reported in the dry run |
| Username rule change orphans existing logins | up to 323 accounts | Decision 3; sanitisation applies to *new* accounts unless a rename is explicitly planned |
| Duplicate people, as happened on 2026-09-05 | 8 accounts had to be soft-deleted | identity resolution by `external_id` first, employee code second; dry run lists every create |
| Legacy API shape drift | run fails | fail closed, commit nothing, report |

## Decisions taken (2026-09-06)

1. **Test organization gets its own code.** Zoomato keeps `0001`; the test
   K-Electric is created under a distinct code. Consequence: the organization
   identity can no longer be a hardcoded constant — `KE_SYNC_ORGANIZATION`
   becomes a resolved value, and the confirmation string is derived from
   whatever the run targets (`10:0001:K-Electric` in production). This is a
   prerequisite for phase 0, not an optional extra.
2. **Products and prices are in scope.** The sync creates catalogue entries and
   writes `base_price`, and creates groups. This reverses the refusal documented
   in `sync-ke.ts`; both that comment and `CLAUDE.md` are updated to say so and
   why. Every price the run would write is listed in the dry run.
3. **No username sanitisation.** Usernames stay exactly as the legacy portal
   has them — the `Passcode` verbatim, as today. The punctuation-stripping rule
   is dropped from scope, and no existing username is renamed.

## Steps

1. Fix the `TEST_DATABASE_URL` trailing quote. *(verifiable: integration suite reports it ran)*
2. `sanitizeEmployeeCode` + tests. *(unit)*
3. Phase 0 organization bootstrap + tests. *(unit; then dry run on test DB)*
4. `ke-products.ts` planner + tests. *(unit)*
5. Phase 3 apply: catalogue, org inventory, `legacy_product_mappings`. *(dry run, then commit on test DB)*
6. Phase 2 apply: groups. *(same)*
7. Phase orchestration + `--only`, single digest. *(dry run shows all phases)*
8. Phase 5/6: invoke order import and budget backfill. *(commit on test DB)*
9. Full run on the empty test database; compare counts against legacy.
10. Re-run; assert nothing written.
11. Integration tests; quality gates; `standard-security-check` on the diff.

---

## Round 2 (2026-09-06): full order history, budgets, price history

Three further requirements, and what each turned out to need.

### 1. Import every order, not just a window

Not a matching failure — a scope one. `--start-date`/`--end-date` were required,
so the first run only covered August. Both now default to a full sweep
(`LEGACY_EPOCH` .. today); orders already present are recognised and skipped, so
a wide default is safe rather than merely convenient.

Three real defects surfaced only once the range widened:

- **One bad order killed the run.** A failed tax reconciliation was a hard
  `assert`, so order 50 aborted all ~1,000. Now `TAX_SPLIT_MISMATCH`, rejected
  per order. Legacy is inconsistent about VAT: most orders price inclusive of
  it, a few add it on top (order 50: one line at 355 against a GrandTotal of
  418.90 — 355 x 1.18).
- **The legacy platform throttles.** A ~1,000-call sweep drew 403s partway
  through, and the retry backoff was sub-second — it burned its attempts and
  died. 403/429/503 now back off exponentially in seconds, detail concurrency
  dropped 6 -> 3.
- **One request for twenty months returns ~1MB** and the connection dropped.
  The list is now fetched one calendar month at a time (`monthWindows` in
  `ke-orders-api.ts`, deduped by order id).

### 2. Historical product prices — and why it unblocked #1

`POST /api/ProductSummary/GetSummaryItemHistory` returns ~4,420 rows
(`Date, ItemName, Location, LocationGroup, Price`), 2025-01-06 onward, 160
distinct items, 109 of which changed price at least once.

The item list holds what K-Electric sells **today** (142 names); the history
holds everything they have **ever** sold (160). That difference is retired
products — and historical orders still reference them, which is why 124 orders
failed as `PRODUCT_NOT_FOUND`. All ten missing names were present in the
history. `planProducts` therefore takes the history as a **second product
source**, priced at the most recent price recorded, tagged
`source: "price-history"`.

**Still open:** the price *timeline* itself is not stored — there is no price
history table, and adding one is a schema change. What is imported today is the
latest price per retired product, which is what the orders need. A table holding
the full timeline remains a separate decision.

### 3. Branch budgets

`lib/legacy-import/ke-budgets.ts`. The budget is already on the location rows
the sync fetches, so no new endpoint: `MonthlyBudget` is the allocation,
`TotalBudget` is what is **left** (KE HOUSE: monthly 900,000, total 6) and is
ignored, `BudgetTenureFrom` gives the period.

Limits, both deliberate:

- **Current month only.** The API exposes one tenure. History still comes from
  the report file via `scripts/import-ke-branch-budgets.ts`.
- **Never overwrites.** `budgets_values_valid_ck` requires allocated + credited
  to cover spent + held, so lowering an allocation to match legacy can fail
  outright. A row that disagrees is reported as drift.

Spend remains the job of `backfill-ke-budget-spend.ts`, computed from the orders
themselves.
