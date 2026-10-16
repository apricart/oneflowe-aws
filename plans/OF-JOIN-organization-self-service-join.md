# OF-JOIN — Joining an organization from the login page

## What is being asked

1. Each organization gets a **join code**. Only **Head Office** may set it, from
   somewhere in the Head Office portal.
2. The login page gets a **Join organization** action.
3. Joining asks for the organization code **first**. A valid code resolves the
   organization and pins the rest of the form to it.
4. The applicant then fills in the same information the Create User form asks
   for, and may choose only four roles: `BRANCH_ADMIN`, `ORDER_PORTAL`,
   `GROUP_USER`, `GROUP_ORDER_PORTAL`.
5. **The applicant never creates a user.** The submission becomes a request.
6. Head Office — and only Head Office — approves or rejects it. Nobody joins
   without that approval.

## What already exists

| Piece | Where | Note |
|---|---|---|
| Create-user rules | `app/api/v1/users/route.ts` | role shape, tenant references, uniqueness, audit, welcome mail |
| Role assignment authority | `lib/server/user-access-policy.ts` | `canAssignRole` — strictly below the actor |
| Multi-branch scope | `lib/server/multi-branch-scope.ts` | `validateMultiBranchScope`, `replaceMultiBranchScope`, `rejectScopeForSingleBranchRole` |
| Uniqueness | `lib/user-uniqueness.ts` | email / phone / employee number across `users` **and** `employee_credentials` |
| Username uniqueness | `app/api/v1/users/route.ts` (`usernameExists`) | both tables — extracted here so the join path cannot drift |
| Role-allowlist precedent | `lib/user-management-access.ts` | `USER_MANAGEMENT_ROLES` — the shape this feature's authority follows |
| Page-level role gate | `app/(portal)/users/layout.tsx` | server layout renders "Access denied" rather than mounting the UI |
| Rate limiting | `lib/rate-limiter.ts` | `withRateLimit`, `checkRateLimit`, `getClientIdentifier` |

Nothing resembling self-registration exists today. Every account is created by
an administrator.

## Decision 1 — the join code is its own table, not a column on `organizations`

`GET /api/v1/organizations` (`app/api/v1/organizations/route.ts:118`) and
`GET /api/v1/organizations/[id]` (`:102`) both do a bare `db.select()` on the
whole `organizations` row, and between them they admit `SUPER_ADMIN`,
`HEAD_OFFICE`, `BRANCH_ADMIN`, `GROUP_USER` and `ORDER_PORTAL`.

A `join_code` column on that table would therefore be handed to every
`ORDER_PORTAL` employee in the tenant on page load — the one secret in this
feature, leaked to the role furthest from being allowed to set it. Narrowing two
wide selects that many existing clients depend on is a bigger and riskier change
than adding a table.

So the code lives in **`organization_join_codes`**, one row per organization,
reachable only through `GET/PUT/DELETE /api/v1/organizations/join-code`, which
admits Head Office alone. `organizations` is not touched.

The code is stored in plaintext because the flow requires both directions: an
anonymous caller looks an organization up *by* code, and Head Office has to be
able to read the code back in order to hand it out. It is a low-value bearer
secret — holding it buys the right to *ask* to join, nothing more. Its strength
is bounded deliberately: `^[A-Z0-9-]{8,32}$`, enforced by a Zod schema, by a
check constraint, and by `normalizeJoinCode` in one place.

## Decision 2 — "only Head Office" is taken literally

`JOIN_REQUEST_MANAGEMENT_ROLES` is `["HEAD_OFFICE"]`. `SUPER_ADMIN` is
deliberately **not** on it, for the code or for the decisions, because the
request says the tenant's own gatekeeper decides who joins the tenant. Super
Admin is not locked out of anything it needs: it can still create a user in any
organization directly through `POST /api/v1/users`, which is a different and
separately audited act.

This is a role allowlist rather than a `Permission`, following
`lib/user-management-access.ts`. A `Permission` would not express it: the
`ROLE_TEMPLATES.SUPER_ADMIN` permission set is `Object.values(Permission)`, so a
new permission is granted to Super Admin by construction, and `rolePermissions`
rows only exist after `db:seed` runs.

## Decision 3 — the applicant's password is hashed at submission, never stored plain

The join form asks for a password, because the alternative is mailing a
generated one to an address nobody has verified. `bcrypt` runs at submission and
only `password_hash` is persisted on the request row; approval moves that hash
onto the `users` row. There is no code path that can read an applicant's
password back, approved or not.

An approved join user is created with `must_change_password = false` — unlike
`POST /api/v1/users`, which sets it because an administrator chose the password.
Here the person chose it themselves, so there is nothing to rotate away from.

## Decision 4 — the organization comes from the code, on every request

Neither public endpoint accepts an `organizationId`. Both take the code, resolve
the organization from it server-side, and use only that. This is the control
that makes the whole feature tenant-safe: an applicant cannot name a tenant, so
there is no id to tamper with. Branch and group ids **are** accepted, and each
one is re-checked against the resolved organization before it is stored and
again before it is used at approval.

The lookup returns the organization's **name** and the id/name of its active
branches and groups — the form cannot be filled in without them. That is real
disclosure, and it is what the code buys. It is bounded: identity fields only
(no budget baselines, no admin user, no external ids, no codes), active rows
only, and hard-limited.

## Decision 5 — the four roles are an allowlist, and a privileged field is not a field

`JOINABLE_ROLES` is `["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER",
"GROUP_ORDER_PORTAL"]`, enforced by Zod, by `isJoinableRole`, and by a check
constraint on the table. `HEAD_OFFICE` and `SUPER_ADMIN` cannot be requested at
any layer.

The submit schema is `.strict()` and simply has no `isActive`, `mfaEnabled` or
`budgetAllocationEnabled` member — an applicant cannot activate themselves, turn
MFA off, or grant themselves the Group User budget-allocation right. That last
one moves money, so it is Head Office's to grant, at approval, defaulting off.

## Decision 6 — approval may adjust, because Head Office owns the outcome

`PATCH /api/v1/join-requests/[id]` takes `decision: "approve" | "reject"` and,
on approve, optional `role`, `branchId`, `groupIds`, `branchIds`,
`budgetAllocationEnabled`. Omitted, the request is approved as submitted. Any
override runs through exactly the same allowlist and tenant validation as the
submission, so an override cannot reach further than a submission could.

## Decision 7 — what the public surface must not tell an anonymous caller

Three oracles, closed:

* **Which organization a code belongs to.** A wrong code answers with one
  generic message and no organization detail.
* **Whether an email or username is already registered.** The submit endpoint
  answers a conflict on email, username, phone, employee number or a duplicate
  pending request with one constant message per form that never singles out
  the field: it lists every field that form checks (email, username, mobile,
  employee number — the department sign-up omits username, which it never
  asks for) and why each can clash, so the applicant knows what to check
  without learning which one clashed (revised 2026-10-16; the earlier text
  named nothing and left applicants guessing). The department sign-up does not
  refuse on its derived username at all — the review flags it and Head Office
  picks another before approving. The public surface
  deliberately has **no** username-availability endpoint; the authenticated
  `/api/v1/users/check-username` stays authenticated.
* **How often either may be tried.** Both public endpoints are rate-limited on
  the `login` budget per client, and each is additionally limited on a hash of
  the code, so one tenant's code cannot be fanned out from many addresses
  without being throttled per tenant too.

## Work

### Schema — `drizzle/20260929120000_add_organization_join.sql`

Two new tables, nothing altered:

* `organization_join_codes` — `organization_id` unique, `code` unique,
  `code ~ '^[A-Z0-9-]{8,32}$'`, who set it and when.
* `organization_join_requests` — the submitted person, the requested role and
  scope, `password_hash`, `status`, the decision and who made it, the created
  user id, and the submitting address for abuse investigation. Check constraints
  pin the status enum, the role allowlist, the role/scope shape (a single-branch
  role has a branch and no lists; a group role has at least one list entry and
  no branch), and that a decision and a pending status cannot coexist. A partial
  unique index on `email` and on `username` **where status = 'pending'** makes a
  duplicate pending request a database error, not a race.

Additive only; rollback is two `DROP TABLE`s.

### Pure logic

* `lib/organization-join.ts` — `JOINABLE_ROLES`, `isJoinableRole`,
  `normalizeJoinCode`, `joinCodeError`, `JOIN_REQUEST_STATUSES`,
  `joinRequestScopeShapeError`, and the generic public messages. No imports that
  need a server.
* `lib/organization-join-access.ts` — `JOIN_REQUEST_MANAGEMENT_ROLES`,
  `canManageJoinRequests`.
* `lib/user-username-uniqueness.ts` — `usernameExists`, lifted out of
  `app/api/v1/users/route.ts` so both creation paths ask the same question of
  the same two tables.

### Server logic — `lib/server/organization-join.ts`

`resolveOrganizationByJoinCode`, `loadJoinFormOptions`, `readJoinCode`,
`setJoinCode` (generates when none is supplied), `clearJoinCode`,
`createJoinRequest`, `listJoinRequests`, `decideJoinRequest`. Approval runs in
one transaction: re-read the request `FOR UPDATE`, re-validate the scope, insert
the user, write the group/branch assignments through
`replaceMultiBranchScope`, mark the request approved with the created user id.

### Endpoints

| Route | Method | Who |
|---|---|---|
| `/api/v1/join/lookup` | POST | anonymous, rate-limited |
| `/api/v1/join/requests` | POST | anonymous, rate-limited |
| `/api/v1/organizations/join-code` | GET / PUT / DELETE | HEAD_OFFICE, own organization |
| `/api/v1/join-requests` | GET | HEAD_OFFICE, own organization |
| `/api/v1/join-requests/[id]` | PATCH | HEAD_OFFICE, own organization |

POST rather than GET for the lookup so the code never reaches a URL, a log line
or a `Referer`.

### UI

* `app/(auth)/login/page.tsx` — a "Join an organization" action under Sign In.
* `app/join/page.tsx` — public, two steps: code, then the form.
* `app/(portal)/join-requests/` — `layout.tsx` gating on
  `canManageJoinRequests` the way `users/layout.tsx` does, and a page carrying
  the join-code card and the request queue.
* `components/shell/sidebar.tsx` — one Head Office entry.
* `proxy.ts` — `/join-requests` added to `protectedPrefixes`, the matcher, and
  the Head-Office-only gate beside `/branches`; `/join` named as public.

## Security review — what was examined, and the three things it changed

Run against rule 04 over the finished change, not before it.

### Findings, fixed

**1. The pending-request unique indexes were global, which coupled tenants.**
`organization_join_requests_pending_email_uq` was keyed on `email` alone. Anybody
holding *one* tenant's join code could therefore queue a request for
`someone@example.com` and stop that person from ever applying to a *different*
tenant — a cross-tenant denial neither tenant can see or clear, from an
endpoint neither of them controls. Both partial indexes are now keyed on
`(organization_id, …)`, and the submit-time queue check in
`identityConflictReason` is scoped to the organization for the same reason.

The account rule stays application-wide: `assertUniqueUserFields` and
`usernameExists` are still global, and they run again inside the approval
transaction. So two tenants may each queue the same person, the first approval
creates the account, and the second is refused with a 409. That split is the
honest one — an existing *account* blocks everywhere, a queued *request* blocks
only its own tenant. `tests/integration/organization-join.test.ts` carries the
case both ways.

**2. `Number.parseInt` on the request id decided a different row than the caller
named.** `PATCH /api/v1/join-requests/1.5` parsed to `1` and approved request 1,
creating an account nobody asked for. The id is now matched against `^\d+$`
before it is parsed. Found by the test that expected a 400 and got a 200.

**3. A failed `headers()` lookup took the whole audit row with it.** The trail
was assembled inside one `try`, so no request store meant no `audit_logs` row at
all. The address and user-agent are now resolved separately and default to
`unknown`/null: a header lookup failure costs the trail its decoration, never its
row. Separately, the submit route no longer reaches for `next/headers` — the
`Request` is already in hand.

### Examined and sound

* **Tenant isolation.** Neither public endpoint accepts an `organizationId`; the
  tenant is resolved from the code. The managed endpoints take it from the
  session through `resolveJoinManagementScope`, and `getRequestScope` reads the
  acting user's organization from the **database**, not from the session, so a
  forged session claim cannot move a caller between tenants. Every branch and
  group id is checked against the resolved organization at submission and again
  inside the approval transaction.
* **Privilege escalation.** `JOINABLE_ROLES` is enforced in Zod, in
  `isJoinableRole`, and in a check constraint. `isActive`, `mfaEnabled` and
  `budgetAllocationEnabled` are not members of the strict submit schema, so
  sending one is a 400 rather than something applied.
* **IDOR.** The `FOR UPDATE` lock's `WHERE` carries `(id, organizationId)`, so
  another tenant's request is a 404 — the same answer as a non-existent id.
* **Replay / double submission.** The lock plus the `status !== "pending"` check
  make a second decision a 409. Two concurrent approvals produce one account.
* **Enumeration.** One message for every code failure and one for every identity
  conflict; no public username-availability endpoint. `bcrypt` runs before the
  conflict checks, so a conflict and a success do comparable work.
* **CPU exhaustion.** `bcrypt` on an anonymous endpoint is a cost, but it runs
  only *after* a valid code resolves, and both the caller and the code are
  rate-limited on the `login` budget (15 per 15 minutes).
* **Injection.** Drizzle throughout; the two raw `sql` fragments interpolate
  values as parameters. The status filter is allowlisted through
  `isJoinRequestStatus`; the ordering is a fixed expression.
* **XSS.** React escapes every applicant-supplied field the queue and the dialog
  render; no `dangerouslySetInnerHTML`; the decision email escapes each
  interpolation and takes its only URL from `NEXTAUTH_URL`.
* **Secrets.** The generated code comes from `node:crypto` `randomInt`, never
  `Math.random`. The code never reaches the audit trail, and no password or hash
  reaches a log, a mail, or any read.
* **Over-exposure.** `listJoinRequests` selects explicit columns and omits
  `password_hash`, `submitted_ip` and `submitted_user_agent`. The lookup returns
  `{id, name}` only.
* **Bounds.** 500 branches and 200 groups on the lookup, 200 on a queue page,
  200 pending requests per tenant.

### Accepted, and written down

* **The lookup tells a code holder the tenant's name and its active branch and
  group names.** That is the price of a form that can be filled in, and it is
  what the code buys. Bounded to identity fields.
* **The code is stored in plaintext**, because Head Office must be able to read
  it back to hand it out and an anonymous caller must be able to resolve a tenant
  by it. It is a low-value bearer secret: holding it buys the right to *ask*.
* **`require_mfa`** is an organization setting that nothing in the login path
  reads today. An approved join account gets `mfaEnabled: false`, exactly as
  `POST /api/v1/users` does when the flag is omitted — so this introduces no new
  gap, and closing the pre-existing one is not this change.

## Verification — as run

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors. The one warning this change introduced in `proxy.ts` (cognitive complexity 15 → 16) was removed by factoring the four role-gated shell areas into `ROLE_GATED_AREAS`, not by silencing the rule |
| `npm test` | 241 files, **3568 passed**, 7 skipped, 0 failed |
| `npm run test:integration` | 23 files, **591 passed**, 12 skipped, 0 failed, stderr confirming `running against oneflowe_test` — it ran, it did not skip |
| `npm run build` | succeeded; `/join` static, `/join-requests` dynamic |
| `npm run db:validate` | clean |
| `npm run db:migrate` (disposable test database) | applied `20260929120000_add_organization_join` |

### The tests

* `lib/organization-join.test.ts` — 43 cases over every pure rule: the four
  joinable roles and every spelling that is not one of them, code normalisation
  and both length boundaries, the punctuation the code may and may not carry,
  each assignment shape and each way of getting it wrong, and the two public
  messages asserted to name neither a field nor an organization.
* `lib/organization-join-access.test.ts` — Head Office only, Super Admin refused
  deliberately, and the set asserted to stay *strictly narrower* than
  `USER_MANAGEMENT_ROLES` so it cannot silently acquire the wider authority.
* `lib/server/organization-join-contract.test.ts` — 29 structural controls, and
  the route lists a new endpoint must be added to. Among them: the public routes
  never read an `organizationId`, both rate limiters are consulted, the
  privileged flags are absent from the executable part of a public route, there
  is exactly **one** `insert(usersTable)` in the feature, the lock is
  `FOR UPDATE` and fenced on the organization, the scope is re-validated twice,
  the queue read omits the hash and the address, and the pending indexes are
  tenant-keyed.
* `tests/integration/organization-join.test.ts` — 54 cases against real Postgres:
  401 unauthenticated and 403 per role on all five endpoints, cross-tenant read
  and cross-tenant decide, `HEAD_OFFICE`/`SUPER_ADMIN` escalation refused at the
  schema boundary, foreign and de-activated branch and deleted group refused,
  every wrong assignment shape, weak passwords, duplicate and cross-tenant
  duplicate submissions, replay of a decision, an identity taken while the
  request waited, a loosely-parsed id, the audit rows, and the whole journey from
  code to account asserted as one sequence.
* `proxy.test.ts` — six routing cases for `/join-requests` (Head Office through,
  every other role bounced home) and `/join` reachable with no session.
* `lib/server/activity-audit-coverage.test.ts` — the repository's own control
  caught all four new mutating routes as unclassified. The two privileged ones
  are now `VIA_LIB` against `lib/server/organization-join-audit.ts`; the two
  public ones are `NOT_AUDITED` with the reason written out.

## Risk and rollback

Nothing existing changes behaviour: two new tables, new endpoints, one new page,
one new sidebar entry, one new login link. A tenant that never sets a join code
cannot be joined at all — the feature is off until Head Office turns it on,
per tenant. Rollback is the two `DROP TABLE`s and reverting the code.
