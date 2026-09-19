# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**OneFlowe** is a multi-tenant retail operations platform for Apricart. It has three distinct portals:
- **Super Admin portal** — global inventory, organizations, branches, and platform-level configuration
- **Organization/Branch portal** — day-to-day operations, budgets, orders, and inventory per org/branch
- **Order Portal** — employee-facing e-commerce interface for placing internal orders (`/shop`)

## Commands

```bash
# Development
npm run dev           # Start dev server with Turbopack (preferred)
npm run dev:legacy    # Start dev server with webpack (fallback if Turbopack issues)

# Production
npm run build
npm run start

# Linting
npm run lint

# Database
npm run db:migrate    # Run pending migrations
npm run db:generate   # Generate new migrations from schema changes
npm run db:seed       # Seed roles, permissions, and organization settings
npm run db:bootstrap-admin -- --confirm=CREATE_SUPER_ADMIN  # One-time admin bootstrap
npm run db:studio     # Open Drizzle Studio UI for inspection
npm run db:check      # Check current users in DB

# Data import
npm run import:products-csv  # Import products from CSV file
```

### Testing

```bash
npm test               # unit + contract tests (no external services needed)
npm run test:watch     # same, in watch mode
npm run test:integration  # needs a disposable Postgres; skips itself without one
npm run test:all       # both projects
npm run typecheck
```

Two Vitest projects: `vitest.config.ts` (jsdom, tests beside the code) and
`vitest.integration.config.ts` (node, `tests/integration/**`, one file at a
time). Both alias `server-only` to an empty module so tests can import code
under `lib/server/` directly.

Integration tests need `TEST_DATABASE_URL` pointing at a **migrated, disposable**
database whose name contains `test`; without it they skip and the command still
passes. See `tests/README.md` for the full setup and conventions.

## Architecture

### Tech Stack
- **Framework**: Next.js 15 App Router (TypeScript)
- **UI**: shadcn/ui (New York style) + Radix UI + Tailwind CSS 4
- **Database**: PostgreSQL via Drizzle ORM (schema at `db/schema.ts`, migrations in `drizzle/`)
- **Auth**: NextAuth.js credentials provider — encrypted JWT cookies backed by a per-browser revocation registry, with a 1-15-minute tenant idle timeout and fixed 8-hour absolute lifetime
- **Cache/MFA**: Redis via Upstash
- **Storage**: AWS S3
- **Email**: Nodemailer (SMTP)
- **Charts**: Recharts
- **PDF/Export**: jsPDF + xlsx

### Role-Based Routing

The request proxy (`proxy.ts`) enforces routing by role:
- `ORDER_PORTAL` users → only `/shop/*`
- All other roles → `/dashboard` and portal pages; redirected away from `/shop`
- Four roles: `SUPER_ADMIN`, `HEAD_OFFICE`, `BRANCH_ADMIN`, `ORDER_PORTAL`
- Granular permissions live in `rolePermissions` table, evaluated via `lib/permissions.ts`

### App Directory Layout

```
app/
  page.tsx                  → redirects to /login
  (auth)/login/             → login page
  (portal)/                 → main app shell (sidebar + topbar)
    dashboard/
    inventory/
    orders/
    reports/
    users/
    branches/
    budgets/
    global-inventory/       → SUPER_ADMIN only
    organizations/          → SUPER_ADMIN only
  shop/                     → ORDER_PORTAL (employee store)
  invoices/                 → PDF invoice generation
  receipts/                 → PDF receipt generation
  api/v1/                   → REST API (89 route handlers)
    admin/                  → global ops (assignments, refunds, migrations)
    analytics/
    budgets/
    inventory/
    orders/
    organizations/
    branches/
    users/
```

### Key Library Files

| File | Purpose |
|---|---|
| `lib/auth.ts` / `lib/auth-options.ts` | NextAuth config, session helpers |
| `lib/db.ts` | Drizzle + connection pooling |
| `lib/permissions.ts` | RBAC permission checks |
| `lib/inventory-cascade.ts` | Multi-level inventory sync logic (global → org → branch) |
| `lib/price-ladder.ts` / `lib/server/effective-price.ts` | Price resolution: group → organization → global base price |
| `lib/order-utils.ts` / `lib/order-status.ts` | Order state machine helpers |
| `lib/budget-allocation-mode.ts` | Budget allocation logic |
| `lib/error-handler.ts` | Centralized API error handling |
| `lib/rate-limiter.ts` | Rate limiting for API routes |
| `lib/cache-utils.ts` | Redis caching helpers |
| `lib/receipt-generator.ts` | jsPDF-based receipt generation |
| `lib/server/image-storage.ts` | S3 upload/fetch for product images, key generation and validation |
| `lib/hooks/` | Data-fetching React hooks (useApi, useDashboardAnalytics, etc.) |

### Database Schema (Key Tables)

Defined in `db/schema.ts`:
- **Multi-tenant hierarchy**: `organizations` → `branches` → `users`
- **Inventory cascade**: `products` → `skus` → `inventory` (org-level and branch-level records)
- **Orders**: `orders`, `orderItems`, `orderApprovals` (with approval workflow)
- **Budgets**: `budgets`, `budgetAllocations`
- **RBAC**: `roles`, `rolePermissions`
- **MFA**: `mfaCodes` (Redis-backed OTP for login)
- **Config**: `organizationSettings`

### Component Organization

`components/` is organized by feature domain (e.g., `inventory/`, `orders/`, `budgets/`). Layout scaffolding lives in `components/shell/` (Sidebar, Topbar, SessionGuard). Base shadcn/ui primitives are in `components/ui/`. Context providers (org/branch selection, app state) are in `components/context/`.

### Environment Variables

Copy `.env.example` to `.env.local`. The application runtime uses
`DATABASE_URL`; Drizzle and schema-sync commands use only
`MIGRATION_DATABASE_URL`. AWS SES uses the default AWS credential provider chain,
not credentials configured in application code. The general seed never creates
an administrator; use the explicit one-time bootstrap command when required.

## Important Patterns

- **API routes** follow the pattern `app/api/v1/<resource>/route.ts` and use `lib/error-handler.ts` for consistent error responses.
- **Server components vs client components**: API data fetching happens in client components via `lib/hooks/` and `lib/api.ts`; use `"use client"` at the top of interactive components.
- **Inventory cascade**: When inventory changes at the global level, `lib/inventory-cascade.ts` propagates changes down to org and branch levels. Always go through this utility rather than writing directly.
- **Pricing — resolving**: A product's price is layered — group override, then organization override, then global base price. Always resolve it through `lib/server/effective-price.ts` (`resolveEffectivePriceCents`, `effectivePriceCentsSql`, `scopedOverrideCentsSql`); never write a `customPrice ?? basePrice` expression by hand, or the price charged and the price displayed will drift. The group tier applies only where exactly one group is in scope (a branch, or an authorized group-portal submission).
- **Pricing — the downward rule**: A price change never reaches past a tier that has set its own price. Changing the global base price does **not** touch any organization or group price, whatever their values happen to be; changing an organization price does not touch the global one, and reaches groups only as the administrator chose; changing a group price touches nothing above it. `cascadeGlobalProductFieldUpdate` cascades descriptive fields only (`CASCADABLE_GLOBAL_FIELDS`) — never `basePrice`.
- **Pricing — propagating**: Changing an organization price moves every group that has no override of its own, because those groups inherit it. `lib/group-price-propagation.ts` turns an administrator's choice into a plan: `all` (clear group overrides so everyone follows), `selected` (the chosen groups follow; every other unpriced group is *pinned* at its current price so it does not drift), or `none` (the default and the pre-existing behaviour). The planner is pure and shared — the confirmation dialog previews with it and the server rebuilds the plan with it from rows read **before** the price update, inside the same transaction. Clients send a mode, never a plan.
- **Pricing — changing**: **Only `SUPER_ADMIN` may write a price, at any tier.** The rule lives in `lib/pricing-access.ts` (`canMutatePrices`, `priceMutationFailure`, `rejectPriceFieldsForRole`) and is carried in RBAC as `Permission.PRICING_MANAGE`, granted to Super Admin alone. Administering a catalogue, tenant, or group does not carry the right to change what anyone is charged — Head Office may read prices but never set them. Any new endpoint that writes a price column must go through that module and be added to the route list in `lib/pricing-access.test.ts`. Reading a price is a separate concern, governed by `lib/price-visibility.ts`.
- **Image storage**: Uploaded images live in S3, never in the database. `POST /api/v1/upload/image` sanitises through `sharp`, writes the object, and returns an application path (`/api/v1/images/products/<uuid>.<ext>`) which is what gets stored in `imageUrl`/`customImageUrl`. `GET /api/v1/images/*` streams it back to signed-in users; the bucket itself is private. Rows written before this change still hold `data:` URLs and still render — use `isDataUrl`/`isStoredImagePath` from `lib/server/image-storage.ts` to tell the two apart, and `npm run migrate:images-to-s3` to move the remainder. Never write a `data:` URL to a column.
- **Mirrored accounts and email login**: A user row with `external_source` set was mirrored from another system and **cannot sign in with an email address** — only with its username (`lib/auth-options.ts`, `loadStaffLoginRecord`). Such a person holds one account per role behind a single shared email (`<employee code>-ba` to approve, `-op` to order), so an email alone cannot say which portal they meant. Accounts created in the portal leave `external_source` null and keep email-or-username login. Never relax that guard to "fix" a login complaint from a K-Electric user; point them at their username.
- **Forced password change and the emailed proof**: every K-Electric account was flagged `must_change_password` on 2026-09-17; the flagged session is sent to `/change-password` and refused on every other `/api/v1/*` path (`lib/password-change-pending.ts`). The change itself (`lib/server/password-change.ts`) was gated on a `VERIFY_EMAIL` code entered on the same session. **That proof is switched off for now** by `PASSWORD_CHANGE_EMAIL_VERIFICATION` in `lib/password-change-policy.ts` — a constant in code, deliberately not an environment variable, read by the server module and the page alike (`plans/OF-KE-password-change-without-email-verification.md`). With it off, the change still requires the current password, the policy, new ≠ old, still clears the flag, bumps `session_version` and drops every session, and still has to find the token's own live `auth_sessions` row (only the freshness term goes); the audit row says `emailVerified: false`. To re-enable, set the constant back to `"required"` and update `lib/password-change-policy.test.ts`. The required path keeps running in `tests/integration/password-rotation.test.ts` (policy mocked on); the shipped path in `tests/integration/password-change-direct.test.ts`.
- **K-Electric legacy sync**: Reference data comes from the legacy platform via `npm run sync:ke` (organization, branches, groups, catalogue, users), and orders via `npm run import:ke-orders` — in that order, because an order cannot be written until its branch, ordering user **and products** exist. Both are dry-run by default and require the plan digest they print in order to commit. Planning logic is pure and lives in `lib/legacy-import/ke-sync.ts` and `lib/legacy-import/ke-products.ts`; branches are matched by `external_id`, never by name once pinned. Organization 2 (`K-E-Demo`) shares many of the same emails and must never be touched.
  - **The target organization is resolved by `--organization-code`, not compiled in** (default `0001`). Both scripts refuse if that code belongs to a differently-named tenant, and `sync-ke.ts` creates the organization only with `--create-organization`. This is what lets the whole sync be rehearsed on a test database, where `0001` is taken by another tenant. The two scripts must always be pointed at the same code or the orders land in a tenant the sync never populated.
  - **The sync creates catalogue entries and groups, and writes `base_price`.** It previously refused both because pricing is `SUPER_ADMIN`-only; the refusal was reversed because the order import rejects every line as `PRODUCT_NOT_FOUND` without them. It still never changes the price of a product that already exists — legacy prices per branch, OneFlowe has no per-branch tier, so a new product takes the price most of its branches agree on and every disagreement is reported, not applied. Groups are created with no price of their own.
  - **`normalizeProductName` in `lib/legacy-import/ke-electric.ts` is the single join key** between a legacy order line and the catalogue. `ke-products.ts` re-exports it rather than reimplementing it: a normaliser that merely looks equivalent splits one product into two, and the order line then matches both and is refused as `PRODUCT_AMBIGUOUS`.
  - **A first run against an empty database needs two passes.** People at a branch created in the same run are skipped as `BRANCH_NOT_PINNED`, because the branch did not exist when the plan was built. Re-run and they are picked up; a third run reports nothing to do. Branch budgets follow the same rule, for the same reason.
  - **Branch budgets come from the location rows, not a separate endpoint** (`lib/legacy-import/ke-budgets.ts`). `MonthlyBudget` is the allocation; `TotalBudget` is what is **left**, not what was granted — KE HOUSE carries MonthlyBudget 900,000 against TotalBudget 6. It is never written as an allocation, but it is exactly OneFlowe's `allocated + credited − spent − held` (verified to the rupee across every funded branch), so for a location whose `MonthlyBudget` is 0 yet still has money left (HSEQ: 0 / 5) the allocation is `TotalBudget + our used`. **Legacy is authoritative for the current month's allocation**: a missing row is created, a lower one is raised (always safe under `budgets_values_valid_ck`), a higher one is lowered only with `--lower-budgets` and only if the invariant still holds — otherwise it is reported as drift. A location legacy leaves at 0/0 gets no row of its own (the shop creates one at zero on demand) but a row we already hold for it is compared like any other. The API exposes only the current tenure; historical months still come from the report file via `scripts/import-ke-branch-budgets.ts`. Spend stays the job of `backfill-ke-budget-spend.ts` — and a branch showing exactly 0 remaining is usually a row that backfill created at `allocated = spent + held` before the sync could set the real figure. That is the default mode, `--budgets=legacy`. **`--budgets=zero` is the other one** (`planZeroBudgets`): every active branch's allocation for the month goes to the floor `budgets_values_valid_ck` allows (`spent + held − credited`, so nothing remains to order against), a missing row is created at 0, and **`branches.baseline_budget_cents` is cleared** — two paths in `app/api/v1/budgets/route.ts` re-fund from it (a missing month row is created at the baseline; a zero row with no spend is treated as stale and reset to it), so a zero that keeps the baseline is undone by the next page load. Legacy figures are ignored for that run. `--budgets=skip` leaves budgets alone. Choose the mode deliberately on every run: the default would raise a zeroed month straight back to the legacy figure. **A committed zero run is reversed by `npm run restore:ke-zeroed-budgets`** (`lib/legacy-import/ke-budget-restore.ts`), from the before-values in that run's own commit report — not from legacy, whose figures differ from OneFlowe's on a few locations. It raises each lowered allocation back only if the row still holds what the zero run wrote, puts each cleared baseline back only if it is still 0 (that is what switches the monthly re-allocation on again — no code condition was ever changed), leaves the rows the zero run created at 0 alone, and reports anything that moved since rather than overwriting it. Dry-run and digest-gated like the sync.
  - **Which branch sees which product is the legacy per-location item list, and the sync mirrors it** (`lib/legacy-import/ke-branch-catalogue.ts`). Legacy keeps one item row per product per location (`Item.CategoryID -> Category.LocationID`); a Distribution-group location carries ~63 items, an Enabling-group one ~120. The shop lists a product only when its `branch_inventory` row is visible **and** active, its `organization_inventory` row is active, its `global_products` row is active, and `stock_quantity` covers the order — so the sync does all four: it wakes a global product the KE import parked `inactive` (only one it created — `metadata.legacySource = KE_LOGISTICS` or a `KE-` code; anything another hand retired stays retired), activates the organization entry, gives every product legacy sells `--stock` units (default 500; legacy tracks no stock, OneFlowe decrements it on every order) — a zero-stock product on every run, and every product only with `--reset-stock`, so a figure an administrator typed or orders wore down is not clobbered by a routine sync — and upserts the branch row. It never hides: a product visible at a branch that legacy does not list there is reported as an extra. The Head Office "assign" endpoint skips any existing non-deleted row, visible or not, which is why a dormant row from the legacy order import cannot be surfaced through the UI. Products created in the same run are assigned on the next — the same two-pass rule as branches and people.
  - **`import:ke-orders` defaults to the whole history** and fetches the order list **one calendar month at a time** (`monthWindows`). A single request for twenty months returns ~1MB and the legacy platform answers by throttling or dropping the connection. Detail fetches run at concurrency 3, and 403/429/503 back off exponentially in seconds — sub-second retries just burn the attempt budget and kill the run.
  - **A person's branch comes from `SubuserLocations`, never from `LocationID`** (`legacyLocationOf` in `ke-sync.ts`). `LocationID` looks authoritative and is not — legacy populates it for everyone, overwhelmingly with 2 (KE HOUSE). For 13 of the 148 people the two disagree, and trusting `LocationID` parked all 13 at KE HOUSE, left branches such as GSMP-KKI with no staff at all, and made their orders unattributable. `LocationID` is honoured only when `SubuserLocations` agrees the person is there. The sync also *moves* an existing account that is on the wrong branch (`branchMoves`), because the assignment is legacy's to state, not ours.
  - **An imported order's branch comes from the legacy `LocationID`, never from the location name** (`lib/legacy-import/ke-order-branches.ts`, used by `import-ke-orders.ts`). Legacy has twins whose names differ only in punctuation or case — `Johar |` / `Johar ||`, `society cluster` / `Society Cluster` — and both halves normalise to one string, so a name-keyed map kept one twin and filed the other's orders at it (production orders 1472 and 2519). The name is a fallback for a branch nobody has pinned yet, and it never matches a branch pinned to a different id; that case is refused as `BRANCH_NOT_FOUND` with a pointer at `sync:ke`. An order already filed at the wrong twin is moved by `npm run repair:ke-order-branches` (dry-run, digest-gated, rollback-able), which also recomputes the branch/month budget rows it touches — the backfill cannot, because a month whose only order left produces no consumption row.
  - **An order whose tax split does not reproduce its own total is rejected, not fatal** (`TAX_SPLIT_MISMATCH`). Legacy is inconsistent about VAT: most orders price inclusive of it, a few add it on top (order 50 is one line at 355 against a GrandTotal of 418.90). Importing one of those under the inclusive model would understate the money, so it is refused — per order, so one bad row cannot block the rest of the history.
- **One-time add-on budgets carry a validity date, and the expiry is materialised onto the row** (`plans/OF-BUDGET-addon-validity.md`). A branch's money budget is one pool — `remaining = allocated + credited − spent − held` — and `budgets.amount_credited_cents` is read directly by the order hold, group orders, analytics, exports and the KE scripts, so an expired add-on is never subtracted at read time; it is withdrawn from the column. Every add-on that credits money (`PUT /api/v1/budgets`, `type: "addon"`, amount > 0) must carry `validUntil` (`YYYY-MM-DD`, resolved to 23:59:59 Asia/Karachi, today or later) and **is filed on the row for the month that date is in**, which must be one `addonPeriodsOpenAt` allows: the engine's **UTC** period or the administrator's Karachi month — the same month except 00:00–05:00 Karachi on the 1st, when a new-month date opens next month's row at the baseline rather than being refused. When that instant passes, `settleDueAddonsOnBudget` (`lib/server/budget-addon-expiry.ts`) withdraws `min(addonAmount, remaining)` — the **ceiling model**: base is spent first, spent and held are never touched, the check constraint always holds — records it on the `budget_addons` row (`expired_at`, `forfeited_cents`) and in `audit_logs` (`EXPIRE_BUDGET_ADDON`). The arithmetic is pure in `lib/budget-addon-expiry.ts`. **Every path that takes a hold settles under its own `FOR UPDATE` first** (orders POST, orders PATCH, group order creation); budget reads and writes settle too, and `POST /api/v1/budgets/cron/expire-addons` sweeps the rest behind `CRON_SECRET`. `lib/server/budget-addon-expiry.test.ts` pins that list — a new spending path goes on it. A row with `valid_until IS NULL` predates validity and is never settled. Refund credits land in the same column and are treated as non-expiring ceiling. A branch id on the budgets GET query string is fenced to the caller's tenant **before** `loadSingleBranchBudget`, because that load opens a period row when one is missing (`queriedBranchAccessError`, sharing `tenantFenceError` with the PUT).
- **Group orders belong to the branch, not just to the requester**: a Group Order Portal submission is recorded as one ordinary `orders` row per branch, carrying a nullable `groupOrderId` back-reference. Every branch-scoped and organization-scoped read therefore already returns them — `BRANCH_ADMIN` and `HEAD_OFFICE` see and decide them with no special case, and **no query may ever add a `groupOrderId IS NULL` filter**. `ORDER_PORTAL` is the one role narrowed by creator, and it is narrowed to *own orders **or** group orders for its branch* (`lib/group-order-visibility.ts`), because a group order spends that branch's budget. Reports that attribute orders to a user must filter creators through `ORDER_CREATOR_ROLES`, never `roles.name = 'ORDER_PORTAL'` alone, or the group requester's orders vanish from the branch's own figures.
- **The branch owns its orders — writes follow branch assignment, not authorship** (`lib/order-write-access.ts`). Either requester role may **edit** a pending order or **request a refund** on any order at a branch it is assigned to, whoever raised it: `ORDER_PORTAL` for its own branch (group orders included), `GROUP_ORDER_PORTAL` across its resolved assignment set (orders raised by branch staff included). The branch set is resolved server-side — `scope.branchId` for the single-branch role, `resolveScopedBranchIds()` for the group role — and **an empty set denies everything rather than widening to the tenant**. This reversed an earlier creator-equality rule, which was proving branch membership and personal accountability at once; only the first survives. The second moved to the trail: every cross-actor write records `onBehalfOfUserId` in its audit row and notifies the raiser through `notifyRaiserOfOrderWrite`, on the same transaction, so a rolled-back edit never announces itself. Deciding an order did **not** widen — approve, reject, fulfil and payment-status still refuse `GROUP_ORDER_PORTAL` — and neither did the fulfilment token, its email, or the invoice, which stay with the raiser. See `plans/OF-GROUP-branch-owns-order-writes.md`.
- **Permissions**: Check `lib/permissions.ts` before adding any new admin-only feature — never inline permission logic in components.
- **Path aliases**: `@/` maps to the project root (configured in `tsconfig.json`).

## Engineering Development & Security Standard

This repository follows the Engineering Development & Security Standard v1.0.
The mandatory rules are imported below and apply to all work in this
repository. Read `.claude/README.md` for how they map to the source standard.

@.claude/rules/00-project-overview.md
@.claude/rules/01-architecture.md
@.claude/rules/02-typescript-standards.md
@.claude/rules/03-testing.md
@.claude/rules/04-security.md
@.claude/rules/05-api-standards.md
@.claude/rules/06-database.md
@.claude/rules/07-git-pr.md
@.claude/rules/08-ai-development.md
@.claude/rules/09-frontend.md

Workflow skills live in `.claude/skills/` and are invoked by name:
`/standard-feature-development`, `/standard-api-endpoint`, `/standard-testing`,
`/standard-security-check`, `/standard-code-review`.
