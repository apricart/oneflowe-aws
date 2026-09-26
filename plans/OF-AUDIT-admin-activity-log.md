# OF-AUDIT — Admin activity log

One Super-Admin-only screen that answers *who changed what, when, from where*,
reading every audit row the application already writes, plus a single
centralized writer so the mutations that wrote nothing start appearing on it.

## Why

An audit review found the trail is real but partial and scattered:

* Records live in three tables with three different shapes — `audit_logs`
  (business mutations), `system_logs` (authentication, via
  `lib/server/auth-audit.ts`), `group_audit_logs` (group operations).
* Of the routes under `app/api/v1/` that mutate, 31 wrote no audit row at all —
  including order fulfilment, budget repair, and turning off a second factor.
  (An earlier count of "94 of 135 files" was wrong: it counted read-only routes
  too.)
* There is no working viewer. `components/admin/audit-log-viewer.tsx` and
  `useAuditLogs` in `lib/hooks/use-api.ts` both call `/api/v1/audit-logs`,
  which **does not exist**, and the component is imported by nothing.

## Scope

In:

1. `GET /api/v1/activity-logs` — one merged, keyset-paginated, filterable read
   across the three tables. Super Admin only.
2. `/activity` — the screen.
3. `recordAuditEvent` — one centralized, transaction-aware writer, retrofitted
   until **every** mutating route is audited or deliberately excluded, with a
   contract test that keeps it that way.
4. Unit, contract, integration and one Playwright end-to-end test.

Out, and deliberately so:

* **Rewriting the 38 routes that already audit by hand.** They write
  `insert(auditLogs)` directly rather than through the writer, so their action
  strings are unnormalised and their metadata is unmasked. Migrating them is a
  separate change: thirty-eight files across orders, budgets, pricing and RBAC,
  every one money- or permission-bearing, is not a diff anybody can review
  alongside a new screen. `LEGACY_DIRECT` in
  `lib/server/activity-audit-coverage.test.ts` names them and holds them to
  still writing.
* **Auditing reads.** No read in this application is audited. Recording the
  activity screen's own queries would make the newest page of the trail mostly
  the reader's own searches, and the screen is Super-Admin-only and rate
  limited. If read-auditing is required for compliance it needs its own
  retention story and its own change.
* **A schema migration.** `audit_logs` has no `ip_address`/`user_agent`
  column, so the writer puts both in `metadata` and the reader coalesces
  across the two shapes. Additive nullable columns would be safe, but on a
  live tenant database the no-migration option is safer still and costs the
  screen nothing but an index on IP it does not need. Recorded as a follow-up.

## The reading model

`ActivityEvent` is the one shape the screen speaks. The three tables map onto
it like this — the gaps are what the merge has to paper over:

| Field | `audit_logs` | `system_logs` | `group_audit_logs` |
|---|---|---|---|
| time | `created_at` | `timestamp` | `created_at` |
| actor | `user_id` (uuid) | `user_id` (varchar — may be `emp_42`) | `performed_by_user_id` |
| actor role | — | `user_role` | `performed_by_role` |
| actor email | — | `user_email` | — |
| organization | `organization_id` | `organization_id` | `organization_id` |
| branch | `branch_id` | `branch_id` | — |
| entity | `entity` | `resource_type` | `group` (literal) |
| entity id | `entity_id` | `resource_id` | `group_id` |
| payload | `metadata` | `details` | `metadata` |
| IP / agent | `metadata.ip` / `.userAgent` | `ip_address` / `user_agent` | `metadata.ip` |
| outcome | (written on success only) | `success`, `error_message` | (success only) |

An event id is `<source>:<row id>` — `audit:1204`, `system:88` — so one id is
unique across the union and names its own table.

### Why keyset pagination, not OFFSET

`audit_logs` and `system_logs` grow without bound. `OFFSET n` re-reads and
discards n rows, so page 500 of a busy tenant is a table scan, and
`COUNT(*)` over a filtered three-table union is the same cost again — which is
why the response carries `hasMore` and a cursor and **no total**.

The cursor is `(occurredAt, sourceRank, id)`, and the predicate is pushed into
each branch of the union so each branch uses its own time index
(`audit_created_action_idx`, `system_logs_timestamp_idx`,
`group_audit_timestamp_idx`). Each branch is ordered and limited to the page
size, then the branches are merged and limited again: the global top *n* is
necessarily inside the per-table top *n*, so this is exact, and it is a merge
of three index scans rather than a sort of everything.

The per-branch predicate depends on how that branch's source sorts against the
cursor's source at an identical timestamp — three cases, pure and unit-tested
in `lib/activity-log.ts`:

| branch vs cursor source | predicate |
|---|---|
| same | `ts < T OR (ts = T AND id < I)` |
| sorts *after* the cursor | `ts <= T` |
| sorts *before* the cursor | `ts < T` |

### One classifier, two languages

Action strings already in the database are inconsistent — `CREATE`,
`import_products`, `CASCADE_UPDATE`, `AUTH_LOGIN_SUCCESS`. The screen groups
them by operation (create / update / delete / approve / reject / auth / export /
other), category and severity, and the operation is also a *filter*, so the same
rule has to run in TypeScript (to label a row) and in SQL (to select rows).

They cannot be allowed to drift, so they are not written twice: the rule tables
in `lib/activity-log.ts` are the only statement of the classification, the
TypeScript classifier walks them, and `lib/server/activity-log-sql.ts`
*generates* the SQL `CASE` from the same tables. `CASE` takes the first arm that
matches, which is exactly what `matchActionRule` does, so emitting the arms in
table order is what makes the two agree — rather than a promise that they were
written to.

**There are three tables, not one, because operation and category are
orthogonal.** A single table keyed on the action string cannot say that
`DELETE_CATEGORY` is a *delete* of a *catalogue* thing: the first draft had one,
its `CATEGORY` rule sat ahead of the generic `DELETE` rule, and every category
delete was silently relabelled an update — with the operation filter then
agreeing with the wrong label instead of the right one. The integration suite
caught it. So `OPERATION_RULES` reads the verb, `CATEGORY_RULES` reads the noun,
`SEVERITY_RULES` reads weight, and severity takes the **highest** of the rules
that apply rather than the first, because `USER_DELETE` is a delete (critical) of
a user (notice) and reading either one first would let it decide for the other.

A unit test asserts the generated SQL emits one arm per rule in table order,
that every rule value arrives as a bound parameter, and that **no rule is
unreachable** — that last one found `FULFILL` already claimed by `FULFIL`, dead
weight that read as a statement of intent.

The operation predicate is evaluated after the date range has bounded the scan
through the time index, so it costs a filter over the page's candidate rows,
not a scan. When neither the operation nor the category is filtered, no `CASE`
is emitted at all.

### Search has to reach a person

Only `system_logs` denormalizes the actor's email; `audit_logs` and
`group_audit_logs` store an id alone. A free-text search for a person would
therefore have found their sign-ins and none of their changes — worse than not
offering the search, because the empty result reads as "they did nothing".
`loadActivityPage` resolves the term against `users` first, in one bounded
lookup, and passes the matching ids into the union, so search means the same
thing on all three sources without a join inside the part of the query that has
to stay cheap.

## Authorization

`lib/activity-log-access.ts` — `canViewActivityLog(role)`, true for
`SUPER_ADMIN` alone, carrying `Permission.SYSTEM_VIEW_AUDIT_LOGS`, which only
the Super Admin template holds. Same shape as `lib/pricing-access.ts`: the
rule lives in one pure module, the route calls it, and a test pins the whole
role matrix.

The trail spans every tenant and records administrative action, so this is not
narrowed to an organization — it is refused to every other role outright,
including Head Office. `proxy.ts` gates `/activity` for navigation only; the
route re-checks.

## The writer

`lib/server/activity-audit.ts` — `recordAuditEvent(executor, event)`.

* `executor` is a Drizzle transaction **or** `db`, so a caller inside a
  transaction gets a write that rolls back with the business change instead of
  the "best effort" pattern the review flagged. Every retrofit here passes a
  transaction.
* `action` is normalized to `UPPER_SNAKE_CASE` so the new rows are
  aggregatable whatever the caller typed.
* `entityId` is the id of **one** row. The rows a bulk write reached go in
  `metadata` — `lib/audit-entity-id.test.ts` is the standing control on this,
  because a comma-joined list overflows `varchar(128)` and throws after the
  business rows are already written.
* `metadata` carries `before`/`after` for an update, and is passed through
  `maskSensitiveData` so no password, token or OTP can reach the trail.
* IP and user agent are resolved from request headers, and a failure to
  resolve them never fails the write.

### Coverage

**Every mutating route is now accounted for.** The scan is
`grep -lE 'export async function (POST|PUT|PATCH|DELETE)' app/api/v1/**/route.ts`,
and `lib/server/activity-audit-coverage.test.ts` asserts each of those files sits
in exactly one of four lists. A *new* mutating route fails that test until
somebody classifies it, which is what makes the coverage keep itself.

| List | Count | What it means |
|---|---|---|
| `DIRECT` | 13 | The handler calls `recordAuditEvent` itself, inside the transaction that performs the change. |
| `VIA_LIB` | 21 | The write lives in a shared `lib/` module the route delegates to. |
| `LEGACY_DIRECT` | 38 | Already audited, by hand, before the writer existed. |
| `NOT_AUDITED` | 5 | Deliberately not recorded, each with its reason. |

Retrofitted in this change — `DIRECT`:
`categories`, `subcategories`, `modifiers`, `suppliers` (+`[id]`),
`branches/[id]`, `reports/schedule`, `reports/process-schedules`,
`admin/cleanup-inventory`, `admin/repair-budgets`, `admin/delete-order`,
`support/attachments`, `upload/image`.

**Where several routes reach one transition, the record goes with the
transition, not the route.** Three routes fulfil an order — the Super Admin
route, a token hand-off whose goods had arrived, and a delivery that settles a
waiting hand-off — and all three call `fulfillApprovedOrder`. That function had
no audit row at all, so the moment a branch's *held* money became *spent* money
was unrecorded. The row now sits inside its transaction, beside the ledger move.
`lib/server/support-threads.ts` was given the same treatment for the three
support routes.

Authentication events go to `system_logs` through `recordAuthAuditEvent`, whose
looser columns suit an event with no verified tenant or account. Three actions
were added to that closed set: `AUTH_MFA_ENABLED`, `AUTH_MFA_DISABLED` and
`AUTH_MFA_VERIFIED`. **Turning MFA off recorded nothing before**, which is the
one an attacker holding a session would do first; it is now `critical`. The two
login OTP routes record every attempt — including an unknown account — while
answering identically, because the *response* must not become an
account-enumeration oracle and the *trail* is where a probe is told apart.

`app/api/v1/settings/route.ts` already wrote a transactional audit row with a
`previousValue`; it is the pattern the writer generalizes, and is left alone.

### Two rules restored along the way

* **`admin/delete-order` no longer deletes the order's `system_logs` history.**
  Rule 06 makes audit rows append-only precisely so that deleting the subject
  cannot erase the record of it, and an administrative hard delete is the case
  where that matters most. The deletion is itself recorded now, carrying the
  order, its lines and the money released — afterwards that entry is the only
  place the order existed. **This is a behaviour change**: the rows outlive the
  order, which `system_logs.resource_id` (no foreign key) allows.
* **`admin/repair-budgets` rebuilds inside one transaction.** It deletes a
  branch's whole budget history; a failure part-way through the rebuild used to
  leave some months restored and the rest simply gone.
* **`admin/migrate-product-code` is deleted.** It ran
  `CREATE UNIQUE INDEX … ON global_products (product_code) WHERE deleted_at IS NULL`
  over HTTP against the live database — a schema change through a request rather
  than a migration in CI (rule 06), and its own first line said
  `DELETE THIS FILE AFTER RUNNING`. It was also **redundant**:
  `drizzle/20260713010000_add_normalized_global_product_code_uniqueness.sql`
  already creates `global_products_code_active_normalized_uq` on
  `lower(btrim(product_code))` under the same `WHERE deleted_at IS NULL`, which
  is strictly stronger — identical strings normalise identically, so every
  duplicate the endpoint's index would have rejected is already rejected.
  Nothing called it, nothing referenced its index name, and deleting the route
  does not drop an index a past run may have created (a redundant one, harmless
  where it exists). The `docs/PRD.md` row went with it, as did the
  `MIGRATE_SCHEMA` classifier rules, which nothing writes any more.

## The screen

`/activity`, Super Admin only, server-gated then client-rendered:

* Date range (default the last 7 days, so the first read is bounded), source,
  operation, action, organization, branch, actor, outcome, and a debounced
  free-text search over actor email, action and entity id.
* A row is a button; it opens a detail panel with the actor, IP, user agent,
  the before/after diff and the raw metadata.
* Load-more appends the next cursor page. No page numbers, because there is no
  total to number against.
* CSV export of the rows already loaded — no second endpoint, so no second
  unbounded read path.
* Operation and outcome are never carried by colour alone: every badge carries
  its own text and an icon.
* Loading, empty and error states are all explicit, and the error shows the
  message from `lib/error-handler.ts`.

`components/admin/audit-log-viewer.tsx` and `useAuditLogs` are deleted — dead
code pointing at an endpoint that never existed.

## Tests

Unit and contract (`npm test`):

| File | Covers |
|---|---|
| `lib/activity-log.test.ts` | classifier over the action strings the app really writes, no unreachable rule, cursor round-trip and rejection, the three-case cursor predicate, window and page bounds, metadata masking |
| `lib/activity-log-access.test.ts` | the whole role matrix, and that RBAC grants the permission to exactly those roles |
| `lib/activity-log-request.test.ts` | every bound and every refusal of the query string |
| `lib/activity-log-view.test.ts` | window presets, a tone and label for every value, the before/after diff, CSV escaping and formula neutralisation |
| `lib/server/activity-log-sql.test.ts` | SQL generated from the rule tables covers every rule in order; no user value reaches the template except as a parameter; no `OFFSET`, no `COUNT` |
| `lib/server/activity-audit.test.ts` | action normalization, single `entityId`, masking, before/after shape, executor is honoured |
| `lib/server/activity-audit-coverage.test.ts` | **every** mutating route is classified exactly once; each records; each `DIRECT` write passes `tx`, not `db`; the two that cannot say why; the legacy 38 still write; each exclusion states a reason |
| `components/activity/activity-log-screen.test.tsx` | loading / empty / error, filters become query parameters, a row opens the detail panel |
| `components/shell/sidebar.activity.test.ts` | only Super Admin gets the entry |

Integration (`npm run test:integration`, real Postgres):

`tests/integration/activity-log-api.test.ts` — seeded rows in all three tables
across two tenants:

* 401 unauthenticated; 403 for Head Office, Branch Admin, Group User, Group
  Order Portal and Order Portal; 200 for Super Admin
* the merge is correctly ordered across the three sources
* keyset paging: successive pages neither overlap nor skip, and concatenated
  equal the whole ordered list
* every filter, including the operation filter against the generated SQL
* the limit bound and the date-window bound are enforced
* driving the categories route writes an audit row that then appears on the
  read — the writer and the reader checked against each other

End to end (`npm run e2e`): a minimal standalone `playwright.config.ts` plus
`tests/e2e/activity-log.spec.ts` — seven tests in a real browser. A Super Admin
signs in, reaches `/activity` from the sidebar, sees rows from all three tables,
filters, searches, opens the detail panel and reads the diff; Head Office is not
offered the entry, is redirected away from the address, **and is refused by the
endpoint itself** — that last one because the redirect is navigation only.

The repository's former Playwright harness was deleted in the two "sonar"
commits; this is a fresh minimal one for this screen, not a restoration. Three
things about it are deliberate:

* **It cannot reach a real database.** `tests/e2e/global-setup.ts` refuses to
  proceed unless `TEST_DATABASE_URL` is set, names a database with `test` in it,
  and is not the same identity as `DATABASE_URL`. That connection is passed to
  the server through `webServer.env`, and `@next/env` never overwrites a
  variable already in the process environment — so `.env.local`, which on a
  developer machine may well point at the live pooler, cannot replace it. The
  seed builds its own pool from that argument rather than importing `@/lib/db`,
  so it physically cannot reach whatever `DATABASE_URL` resolved to.
* **It runs beside `npm run dev`.** Next keeps its dev-server lock at
  `<distDir>/dev/lock` and refuses to start twice against the same one, so
  `next.config.mjs` now reads `distDir: process.env.NEXT_DIST_DIR || '.next'`
  and the suite sets `.next-e2e`. Inert everywhere else. `.gitignore`,
  `eslint.config.mjs`, `vitest.shared.ts` and `tsconfig.json` all exclude that
  directory — the ESLint one matters, because without it `npm run lint` lints
  the generated output and reports thousands of errors in it.
* **`next start` was not an option.** It forces production mode, where the
  server env validator rightly requires HTTPS for `NEXTAUTH_URL` and for the
  Redis URL. The suite runs the dev server instead.

## Risk

* **Read path only, for existing data.** The reader adds no write and changes
  no existing query, so the screen cannot affect what the application does.
* **The retrofit is the real risk**, and it is bounded: each added write is
  inside the transaction that already wraps the business change, so the worst
  case is that a mutation which used to succeed now rolls back on an audit
  failure. That is the intended trade — a silent gap in the trail is the thing
  being fixed — and it is why the retrofit is limited to seven files whose
  writes are small and whose tests run here.
* **Rollback** is to revert the commit; nothing is migrated and no existing row
  is rewritten.

## Gates

All green as shipped:

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors (1 pre-existing warning in `analytics/executive/compare`) |
| `npm test` | 227 files, 3255 passed, 7 pre-existing skips |
| `npm run build` | compiled; `/activity` and `/api/v1/activity-logs` both present |
| `npm run test:integration` | 17 files, 446 passed against `oneflowe_test` — the stderr notice confirms it ran rather than skipped |
| `npm run e2e` | 7 passed, Chromium |

## Still open

Every mutating route is now audited or deliberately excluded. What remains:

* **The 38 `LEGACY_DIRECT` routes**, which audit by hand rather than through the
  writer — so their actions are unnormalised, their metadata unmasked, and they
  record no IP. Migrating them is the natural next change, and the list is the
  work order.
* **`ip_address` / `user_agent` as columns on `audit_logs`**, so an address can
  be filtered rather than only displayed.
* **Read auditing**, with its own retention story.
* **Retention and archival.** Nothing prunes these three tables, and the keyset
  reader is what makes that survivable rather than urgent.
* **`mfa/toggle` disables a second factor without re-proving identity** — the
  route's comment argues the session is proof enough. Recording it does not make
  that true. Worth a decision of its own.
