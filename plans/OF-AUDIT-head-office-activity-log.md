# OF-AUDIT — Head Office reads its own organization's activity log

Builds on `plans/OF-AUDIT-admin-activity-log.md`, which made `/activity` a
Super-Admin-only, cross-tenant screen and **deliberately refused Head Office**.
This change reverses that one decision, on the product owner's request, and
keeps every other guarantee of that plan.

## Objective

A Head Office user can open Activity Log from the sidebar and read the trail of
**their own organization only** — sign-ins, business changes and group
operations — with the same filters, detail panel and CSV export Super Admin
has. Nothing else changes for Super Admin, and every other role stays refused.

### Acceptance criteria

1. `HEAD_OFFICE` sees the *Activity Log* menu entry, reaches `/activity`, and
   `GET /api/v1/activity-logs` answers 200.
2. Every row returned to Head Office has `organization_id` equal to the
   caller's own organization, read from the `users` row — never from the
   session cookie, the query string, or a header. Platform rows
   (`organization_id IS NULL`) and other tenants' rows are never returned, from
   any of the three tables.
3. `organizationId=<another tenant>` is refused with 403; `organizationId=<own>`
   is accepted. `branchId` of another tenant returns nothing.
4. A Head Office account with no organization is refused (403), never widened
   to "all".
5. Free-text search cannot be used as an oracle on people outside the tenant:
   it resolves names/emails only against the caller's own organization's
   accounts, and does not match the actor-email / actor-id columns of the
   trail.
6. An `actorId` that is not an account in the caller's organization returns an
   empty page.
7. An action taken inside the tenant by someone outside it — in practice an
   Apricart Super Admin — is shown, but **anonymised**: no actor id, email,
   name, IP address or user agent, and actor-identifying keys are removed from
   its metadata. The row says it was an Apricart administrator. On a sign-in
   (`auth`) or `user` row the record id is withheld too, because there it is
   the identifier that person typed.
8. `BRANCH_ADMIN`, `GROUP_USER`, `GROUP_ORDER_PORTAL`, `ORDER_PORTAL`, `VIEWER`
   stay refused (403, no menu entry, redirected away from `/activity`).
9. Super Admin's view is unchanged.

## Why the original refusal is reversed

The first plan argued that an organization-scoped view "would let the audited
party curate their own audit". Read access does not let anyone curate: the
three tables stay append-only, Head Office gets no write, delete or export
endpoint beyond the CSV of rows it was already shown, and the read is
re-scoped server-side on every request. What remained of the concern —
that Head Office could learn about Apricart staff, or about other tenants —
is handled by criteria 2, 5, 6 and 7 rather than by refusing the screen.

## Architecture

| Piece | Layer | Change |
|---|---|---|
| `lib/permissions.ts` | RBAC | New `Permission.ORG_VIEW_AUDIT_LOGS` (`org:view_audit_logs`), granted to the Head Office template. `SYSTEM_VIEW_AUDIT_LOGS` stays Super-Admin-only and still means *the whole platform*. |
| `lib/activity-log-access.ts` | pure rule | Two role lists — platform readers (`SUPER_ADMIN`) and organization readers (`HEAD_OFFICE`). `resolveActivityLogReach(scope)` turns the server-resolved scope into a reach or a refusal; `applyRequestedOrganization` refuses a foreign `organizationId`. Fail closed on a missing organization. |
| `lib/activity-log-reach.ts` | pure rule | The anonymisation: `classifyActivityActor` and `redactForeignActorMetadata`. Unit-tested without a database. |
| `lib/activity-log.ts` | types | `ActivityReach`; `ActivityFilters` = the request's filters **plus a required `reach`**, so no caller can build a query without stating it. `ActivityActor.redacted`. |
| `lib/server/activity-log-sql.ts` | SQL | With an organization reach, every branch of the union carries `organization_id = $org`, and search skips the actor-email/actor-id columns. |
| `lib/server/activity-log-queries.ts` | server | Search-actor lookup and `actorId` validated against the reach's organization; actor enrichment reads the account's organization; foreign actors anonymised. |
| `app/api/v1/activity-logs/route.ts` | route | Authenticate → resolve reach → validate → apply reach → load. Thin. |
| `app/(portal)/activity/page.tsx`, `proxy.ts`, sidebar | UI / navigation | Admit Head Office. Presentation only — the route is the control. |
| `components/activity/*` | UI | Copy says "your organization" for Head Office; detail panel says "Withheld" for an anonymised actor. |

The reach is a **separate field from the `organizationId` filter**, on purpose:
the filter is what a caller asked for and is optional; the reach is what the
server permits and is required. A future change that loosens the filter cannot
loosen the fence.

## API

`GET /api/v1/activity-logs` — unchanged query string and response shape, plus
an additive `actor.redacted: boolean` on each item.

| Caller | Result |
|---|---|
| none | 401 |
| `SUPER_ADMIN` | 200, every tenant (unchanged) |
| `HEAD_OFFICE` with an organization | 200, own organization only |
| `HEAD_OFFICE` with no organization | 403 |
| `HEAD_OFFICE`, `organizationId` ≠ own | 403 |
| any other role | 403 |

## Data

No schema change, no migration, no backfill. The permission is a code
constant; the access rule is the role list in `lib/activity-log-access.ts`
(the same shape as `lib/pricing-access.ts`), so nothing reads
`role_permissions` for it and no seed has to run before deploy. Running
`db:seed` later only records the new key against Head Office.

## Security

* **Authentication**: `getRequestScope()`; no session → 401.
* **Authorization**: role list in one pure module; the page, proxy and sidebar
  read the same predicate.
* **Tenant isolation**: organization from the `users` row (re-read per
  request by `getRequestScope`), pushed into all three branches of the union
  as a bound parameter. Null-organization rows excluded by equality.
* **Mass assignment / parameter tampering**: `organizationId` other than own →
  403; `branchId` of another tenant can only intersect to nothing; `actorId`
  outside the tenant → empty page.
* **Enumeration**: search resolves people only within the tenant and does not
  match the trail's own actor columns, so a term cannot confirm that an
  anonymised actor's email contains it.
* **Data minimisation**: foreign actors anonymised; network data shown only for
  the tenant's own people; metadata still passes `maskAuditMetadata`.
* **Rate limiting**: unchanged (`search`, keyed on the user).
* **Caching**: unchanged, `private, no-store`.
* **Audit of the read**: still not audited, for the reason the first plan gives.

## Tests

* Unit: `lib/activity-log-access.test.ts` (role matrix, reach, fail-closed,
  organization override, both permissions), `lib/activity-log-reach.test.ts`
  (actor classification and metadata redaction),
  `lib/server/activity-log-sql.test.ts` (fence in every branch, as a
  parameter; search targets narrowed), `components/shell/sidebar.activity.test.ts`.
* Integration: `tests/integration/activity-log-api.test.ts` — Head Office gets
  only organization A's rows from all three tables; never E10/E11/E12; foreign
  `organizationId` 403; foreign branch empty; search for a neighbour's or a
  Super Admin's email finds nothing; Super Admin's rows in A anonymised;
  Head Office with no organization 403; other roles still 403.
* E2E: the Head Office cases in `tests/e2e/activity-log.spec.ts` flip from
  "turned away" to "sees own organization only".

## Risks

* A missed branch of the fence would leak another tenant's audit trail. The
  fence is one condition generated for every branch from one place, and both
  the SQL unit test and the integration suite assert it per source.
* Metadata redaction is key-based and therefore best-effort on legacy rows
  with free-form metadata. It applies only to actions by people outside the
  tenant, which inside a tenant's rows means Apricart staff.
* Rollback: revert the commit. Nothing is migrated.

## Steps

1. Permission + access module + tests.
2. Reach types + redaction module + tests.
3. SQL fence + search narrowing + tests.
4. Query loader + route.
5. Page, proxy, sidebar, screen copy, detail panel.
6. Integration and e2e updates; gates.
