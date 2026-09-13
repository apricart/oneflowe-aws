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
- **K-Electric legacy sync**: Reference data comes from the legacy platform via `npm run sync:ke` (organization, branches, groups, catalogue, users), and orders via `npm run import:ke-orders` — in that order, because an order cannot be written until its branch, ordering user **and products** exist. Both are dry-run by default and require the plan digest they print in order to commit. Planning logic is pure and lives in `lib/legacy-import/ke-sync.ts` and `lib/legacy-import/ke-products.ts`; branches are matched by `external_id`, never by name once pinned. Organization 2 (`K-E-Demo`) shares many of the same emails and must never be touched.
  - **The target organization is resolved by `--organization-code`, not compiled in** (default `0001`). Both scripts refuse if that code belongs to a differently-named tenant, and `sync-ke.ts` creates the organization only with `--create-organization`. This is what lets the whole sync be rehearsed on a test database, where `0001` is taken by another tenant. The two scripts must always be pointed at the same code or the orders land in a tenant the sync never populated.
  - **The sync creates catalogue entries and groups, and writes `base_price`.** It previously refused both because pricing is `SUPER_ADMIN`-only; the refusal was reversed because the order import rejects every line as `PRODUCT_NOT_FOUND` without them. It still never changes the price of a product that already exists — legacy prices per branch, OneFlowe has no per-branch tier, so a new product takes the price most of its branches agree on and every disagreement is reported, not applied. Groups are created with no price of their own.
  - **`normalizeProductName` in `lib/legacy-import/ke-electric.ts` is the single join key** between a legacy order line and the catalogue. `ke-products.ts` re-exports it rather than reimplementing it: a normaliser that merely looks equivalent splits one product into two, and the order line then matches both and is refused as `PRODUCT_AMBIGUOUS`.
  - **A first run against an empty database needs two passes.** People at a branch created in the same run are skipped as `BRANCH_NOT_PINNED`, because the branch did not exist when the plan was built. Re-run and they are picked up; a third run reports nothing to do. Branch budgets follow the same rule, for the same reason.
  - **Branch budgets come from the location rows, not a separate endpoint** (`lib/legacy-import/ke-budgets.ts`). `MonthlyBudget` is the allocation; `TotalBudget` is what is **left**, not what was granted, and is deliberately ignored — KE HOUSE carries MonthlyBudget 900,000 against TotalBudget 6. The API exposes only the current tenure, so this plans the current month; historical months still come from the report file via `scripts/import-ke-branch-budgets.ts`. An allocation already present is never rewritten: `budgets_values_valid_ck` requires allocated + credited to cover spent + held, so lowering one to match legacy can fail outright. Spend stays the job of `backfill-ke-budget-spend.ts`.
  - **`import:ke-orders` defaults to the whole history** and fetches the order list **one calendar month at a time** (`monthWindows`). A single request for twenty months returns ~1MB and the legacy platform answers by throttling or dropping the connection. Detail fetches run at concurrency 3, and 403/429/503 back off exponentially in seconds — sub-second retries just burn the attempt budget and kill the run.
  - **A person's branch comes from `SubuserLocations`, never from `LocationID`** (`legacyLocationOf` in `ke-sync.ts`). `LocationID` looks authoritative and is not — legacy populates it for everyone, overwhelmingly with 2 (KE HOUSE). For 13 of the 148 people the two disagree, and trusting `LocationID` parked all 13 at KE HOUSE, left branches such as GSMP-KKI with no staff at all, and made their orders unattributable. `LocationID` is honoured only when `SubuserLocations` agrees the person is there. The sync also *moves* an existing account that is on the wrong branch (`branchMoves`), because the assignment is legacy's to state, not ours.
  - **An imported order's branch comes from the legacy `LocationID`, never from the location name** (`lib/legacy-import/ke-order-branches.ts`, used by `import-ke-orders.ts`). Legacy has twins whose names differ only in punctuation or case — `Johar |` / `Johar ||`, `society cluster` / `Society Cluster` — and both halves normalise to one string, so a name-keyed map kept one twin and filed the other's orders at it (production orders 1472 and 2519). The name is a fallback for a branch nobody has pinned yet, and it never matches a branch pinned to a different id; that case is refused as `BRANCH_NOT_FOUND` with a pointer at `sync:ke`. An order already filed at the wrong twin is moved by `npm run repair:ke-order-branches` (dry-run, digest-gated, rollback-able), which also recomputes the branch/month budget rows it touches — the backfill cannot, because a month whose only order left produces no consumption row.
  - **An order whose tax split does not reproduce its own total is rejected, not fatal** (`TAX_SPLIT_MISMATCH`). Legacy is inconsistent about VAT: most orders price inclusive of it, a few add it on top (order 50 is one line at 355 against a GrandTotal of 418.90). Importing one of those under the inclusive model would understate the money, so it is refused — per order, so one bad row cannot block the rest of the history.
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
