# 06 — Database

PostgreSQL via Drizzle ORM. Schema in `db/schema.ts`, migrations in `drizzle/`.

## Identities and least privilege

- `DATABASE_URL` — application runtime. Must **not** hold schema-admin rights.
- `MIGRATION_DATABASE_URL` — Drizzle and schema-sync commands only.
- `TEST_DATABASE_URL` — a disposable database whose name contains `test`.

Separate identities per environment and purpose. Credentials come from the
environment, never from source. Production developer access is restricted and
read-only or time-bound; a schema change reaches production through a migration
in CI, not through a console session.

## Queries

- Use the Drizzle query builder. Raw `sql` template literals are acceptable
  when every value is a parameter; **never** concatenate user input into one
  and never pass user input to `sql.raw()`.
- **Every tenant-data query carries its scope predicate.** Use
  `getRequestScope()`, `resolveScopedBranchIds()`,
  `lib/organization-report-scope.ts`. A missing tenant filter is a data breach,
  not a bug.
- Select the columns you need. `select()` on a wide table in a list endpoint is
  both a performance problem and an over-exposure problem.
- Check the index before adding a filter or sort on a large table. Look at the
  query plan for anything on `orders`, `orderItems`, or the inventory tables.
- Bound every query that can grow with tenant size.

## Transactions

Anything that writes more than one row, or reads-then-writes, runs in a
transaction. Budget spend, inventory cascade, order approval, and refunds are
all subject to concurrent modification — a `SELECT` followed by an `UPDATE`
outside a transaction is a TOCTOU bug that manifests as an over-spent budget or
negative stock.

## Migrations

- Generate with `npm run db:generate`; never hand-edit an applied migration.
- Migrations are controlled changes against a live production database:
  - Additive first. New columns are nullable or defaulted.
  - Never drop or rename a column in the same release that stops using it —
    deploy the code change, then drop in a later release.
  - A destructive migration needs a stated rollback plan and a backup.
  - Consider table size and lock duration. An index on a large table is
    created concurrently.
- `npm run db:validate` before committing a migration.

## Domain-specific rules

- **Inventory** cascades global → org → branch through
  `lib/inventory-cascade.ts`. Never write inventory rows directly.
- **Prices** resolve through `lib/server/effective-price.ts`. Never hand-write
  a `customPrice ?? basePrice` expression, and never cascade `basePrice` —
  `CASCADABLE_GLOBAL_FIELDS` is descriptive fields only.
- **Money** is stored and computed in integer cents.
- Privileged and financial writes are accompanied by an audit row
  (`systemLogs`, `groupAuditLogs`, `orderApprovals`). Audit rows are
  append-only — never updated, never deleted.

## Scripts

Scripts under `scripts/` that mutate data are dry-run by default and require
the printed plan digest to commit. Preserve that pattern in any new script. A
data-repair script gets a validation counterpart and, where feasible, a
rollback counterpart — as the K-Electric import scripts do.
