# OF-USERS — Organization prefix on new usernames

## What is being asked

Usernames should be unique within a tenant rather than across every tenant, so
that two organizations can each have a `huzaifa.abid`. To make that work, a new
account's username starts with a prefix taken from its organization's name —
at most three characters — then `-`, then the username exactly as it is formed
today.

## The constraint that shapes it

Sign-in asks for a username (or email) and a password and **no organization**
(`lib/auth-options.ts`). A username has to name one account on its own, so
`users_username_idx` stays global. The prefix is what makes the per-tenant
wish true in practice: `ubl-huzaifa.abid` and `mee-huzaifa.abid` are different
usernames, and the login stays unambiguous. No index changes.

## Decisions (2026-10-16, with the product owner)

| | Decision |
|---|---|
| **D1** | **The prefix is derived from the organization's name**, not stored. Several words → the first letter of each of the first three ("United Bank Limited" → `ubl`, "K-Electric" → `ke`, "K-E-Demo" → `ked`); one word → its first three characters ("Meezan" → `mee`); lower-cased; letters and digits only; a name with none gives no prefix. |
| **D2** | **Every new account in an organization** takes it: Users → Create user (`POST /api/v1/users`), the standard join form, and the department sign-up (initiator and every approver it creates). |
| **D3** | **Existing usernames are never rewritten**, and renaming an existing user (`PATCH /api/v1/users/[id]`) is unchanged. |
| **D4** | **Accounts with no organization take no prefix**: Super Admin, the Order Desk, Apricart Executives, the warehouse. |
| **D5** | **Scripts are out of scope.** `sync:ke` mirrors legacy usernames (`<first>-<code>-ba/-op`) that sign-in and the importers depend on; the bootstrap and CSV import scripts keep the usernames they are given. |

Accepted consequences of D1: two organizations can derive the same prefix, in
which case the global index refuses the second identical username and it is
reported as taken, as any clash is today; renaming an organization changes the
prefix of accounts created afterwards only.

## Design

* `lib/username-prefix.ts` (pure, shared by pages and server):
  `organizationUsernamePrefix`, `prefixedUsername` (idempotent — a username
  already carrying the prefix is left alone, so page and server can both
  compose it), `withoutUsernamePrefix`, `organizationUsername`, and
  `USERNAME_BASE_MAX_LENGTH` (251: the typed part, so prefix and all fit
  `varchar(255)`).
* `lib/server/organization-username.ts`: `organizationUsernameFor(executor,
  organizationId, username)` reads the organization's name from its own row.
* **The server composes; the page only shows.** Every writer prefixes from the
  organization row it reads itself, never from a value the request sends:
  * `POST /api/v1/users` — after the assignment checks, before
    `usernameExists`, so the availability check, the insert and the welcome
    email all use the prefixed username;
  * `POST /api/v1/join/requests` — both forms, from the organization the join
    code resolved; the stored request already holds the final username, so
    Head Office reviews exactly what will be created;
  * the department approval — Head Office's replacement username and every new
    approver's (`freeApproverUsername`);
  * the department edit (`updateDepartmentJoinRequest`).
* Schema bounds: the typed username is at most 251 in `userCreateSchema`,
  `joinRequestSubmitSchema`, the department decision and the department edit.
* UI: `components/users/prefixed-username-input.tsx` shows the prefix fixed in
  front of the box (as the email domain is fixed after its box). Create user
  checks availability on the prefixed username and strips the prefix from a
  suggestion it fills in; the standard join form shows the prefix; the
  department sign-up shows the prefixed usernames it will create.

## Security

* Tenant: the prefix is derived from the organization row the server reads
  (join code → organization; the scoped `organizationId` the create route has
  already validated). A request cannot choose another tenant's prefix — a
  username typed with another prefix is prefixed again (`ubl-mee-ali`).
* No enumeration change: the public join path still never answers whether a
  username is taken.
* Uniqueness unchanged: `users_username_idx` and `usernameExists` (both
  `users` and `employee_credentials`) still decide.

## Tests

* `lib/username-prefix.test.ts` — derivation, idempotence, bounds, the
  K-Electric / K-E-Demo pair (which share email addresses) staying apart.
* `components/users/create-user-dialog.test.tsx` — the prefix is shown and the
  availability check asks about the prefixed username.
* `components/join/department-signup-form.test.tsx` — the generated usernames.
* Integration: `organization-join.test.ts`, `organization-join-department*.test.ts`
  (including "leaves the applicant free of another organization's account with
  the same unprefixed username"), `viewer-role-api.test.ts`.

## Risk and rollback

No migration. Rollback is a code revert; accounts created meanwhile keep their
prefixed usernames and still sign in with them. Tell administrators that a new
account's username now starts with the prefix, and that the welcome and
approval emails name the full username.
