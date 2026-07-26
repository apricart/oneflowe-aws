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

Vitest is configured for focused unit and security tests (`npm test`).

## Architecture

### Tech Stack
- **Framework**: Next.js 15 App Router (TypeScript)
- **UI**: shadcn/ui (New York style) + Radix UI + Tailwind CSS 4
- **Database**: PostgreSQL via Drizzle ORM (schema at `db/schema.ts`, migrations in `drizzle/`)
- **Auth**: NextAuth.js with credentials provider — 8-hour JWT sessions
- **Cache/MFA**: Redis via Upstash
- **Storage**: AWS S3
- **Email**: Nodemailer (SMTP)
- **Charts**: Recharts
- **PDF/Export**: jsPDF + xlsx

### Role-Based Routing

Middleware (`middleware.ts`) enforces routing by role at the edge:
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
| `lib/order-utils.ts` / `lib/order-status.ts` | Order state machine helpers |
| `lib/budget-allocation-mode.ts` | Budget allocation logic |
| `lib/error-handler.ts` | Centralized API error handling |
| `lib/rate-limiter.ts` | Rate limiting for API routes |
| `lib/cache-utils.ts` | Redis caching helpers |
| `lib/receipt-generator.ts` | jsPDF-based receipt generation |
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
- **Permissions**: Check `lib/permissions.ts` before adding any new admin-only feature — never inline permission logic in components.
- **Path aliases**: `@/` maps to the project root (configured in `tsconfig.json`).
