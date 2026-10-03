# OF-JOIN — Lock the join form's email to the organization's domain

Builds on `plans/OF-JOIN-organization-self-service-join.md`.

## What is being asked

1. Super Admin can set an organization's **email domain** in both the Create
   Company and the Edit Company dialogs.
2. On the public join form, the domain is filled in already. The applicant types
   only the part before the `@`.
3. If the organization the join code resolves to has **no** domain set, the
   applicant is shown a prompt — "your organization's email domain is not set,
   please contact your organization" — and never reaches the form.
4. Unit, integration and end-to-end tests.

## Acceptance criteria

* Create and Edit Company each carry an optional "Email domain" field. A blank
  field stores nothing; clearing it on edit removes the domain.
* The domain is normalised (trimmed, lower-cased, one leading `@` dropped) and
  its shape validated in the dialog, in the Zod schema, and by a check
  constraint.
* `POST /api/v1/join/lookup` returns the organization's `emailDomain`. When it is
  null, the lookup withholds the branches and groups (the form cannot be used,
  so nothing it needs is disclosed) and the join page shows the prompt instead
  of the form.
* The join form shows `@<domain>` as a fixed suffix; the input takes the local
  part only and refuses an `@` in it.
* `POST /api/v1/join/requests` refuses — and stores nothing — when the
  organization has no domain (409, the same message the prompt shows) or when
  the email is not at exactly that domain (400). The server re-resolves the
  organization from the code, so what the page was told cannot be replayed.
* Head Office's join-code card warns when its organization has no domain, since
  a code handed out then leads nowhere.

## Decisions

### 1. A column on `organizations`, not another table

The join code lives in its own table because `GET /api/v1/organizations`
returns the whole row to every tenant role and the code is a secret. The domain
is **not** a secret — every employee already knows what their email address
ends in — so `organizations.email_domain` is the right home and needs no new
read path. The existing contract test that forbids anything "join"-named on the
`organizations` table still holds: the column is named for what it is.

### 2. Not unique

Organization 10 (K-Electric) and organization 2 (`K-E-Demo`) share email
addresses (`CLAUDE.md`), so they share a domain. A unique index would make one
of them impossible to configure. The domain restricts *what an applicant may
type*; it never *selects* a tenant — the join code does that.

### 3. Exact match, no subdomains

`name@ke.com.pk` matches `ke.com.pk`; `name@mail.ke.com.pk`,
`name@ke.com.pk.evil.test` and `name@evilke.com.pk` do not. Comparison is on the
part after the last `@`, case-insensitive, against the normalised stored value.
A tenant that genuinely needs a subdomain sets that subdomain.

### 4. The domain's shape is the subset `z.email()` accepts

The composed address still has to pass `z.email()` in
`joinRequestSubmitSchema`. Zod's domain rule requires an alphabetic TLD, so the
domain pattern does too, and the local-part rule mirrors Zod's local-part rule.
Nothing the form accepts is then refused by the server for a reason the
applicant cannot see.

### 5. Only Super Admin sets it

The organization create and edit endpoints are already `SUPER_ADMIN`-only and
this rides on them. Head Office sees the domain (read-only) on its join-code
card so it knows why joining might be blocked.

### 6. The lookup answers 200 with `emailDomain: null`, not an error

The lookup's question is "what does this code open?" — "Demo Corp, which cannot
be joined until it sets a domain" is a true answer to it. Answering with a
typed field rather than an error status lets the page tell this case apart from
a wrong code without parsing messages. The submit endpoint, which is an action
that cannot be carried out, answers 409.

This adds no oracle: only a caller holding a *valid* code learns whether the
domain is set, and that caller already learns the organization's name.

### 7. Approval does not re-check the domain

The domain is an intake rule. A request that was valid when submitted stays
decidable if Super Admin later changes or clears the domain; Head Office sees
the email on every request it decides. Re-checking would strand legitimate
requests on a configuration change Head Office cannot make.

## Work

### Schema — `drizzle/20260930120000_add_organization_email_domain.sql`

`ALTER TABLE organizations ADD COLUMN email_domain varchar(253)` (nullable) and
`organizations_email_domain_shape_ck`: null, or lower-case and matching the
domain pattern. Additive; every existing row is null and passes. `organizations`
has a handful of rows, so the brief `ACCESS EXCLUSIVE` lock is negligible.

Rollback: `ALTER TABLE organizations DROP COLUMN email_domain;` (drops the
constraint with it). Behaviour then reverts to "no domain", which blocks
joining — see Risks.

### Pure logic

* `lib/organization-email-domain.ts` — `normalizeEmailDomain`,
  `emailDomainError`, `emailLocalPartError`, `composeDomainEmail`,
  `emailMatchesDomain`, and the length bounds.
* `lib/organization-join.ts` — `JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE`,
  `joinEmailDomainMismatchMessage`, `joinEmailDomainRefusal(email, domain)`.

### Validation — `lib/server/mutation-validation.ts`

`emailDomain` on `organizationCreateSchema` (optional) and
`organizationUpdateSchema` (nullable; `null` or `""` clears).

### Endpoints

| Route | Change |
|---|---|
| `POST /api/v1/organizations` | stores `emailDomain`; in the `CREATE_ORGANIZATION` audit metadata |
| `PATCH /api/v1/organizations/[id]` | sets/clears it; `UPDATE_ORGANIZATION_EMAIL_DOMAIN` audit row with before/after when it changes |
| `POST /api/v1/join/lookup` | returns `emailDomain`; withholds branches/groups when null |
| `POST /api/v1/join/requests` | `joinEmailDomainRefusal` before hashing the password |
| `GET /api/v1/organizations/join-code` | also returns the caller's own `emailDomain` |

### UI

* `app/(portal)/organizations/page.tsx` — "Email domain" input with an `@`
  prefix in Create and Edit Company, validated inline.
* `app/join/page.tsx` — the prompt (an alert dialog) when the lookup returns no
  domain.
* `components/join/join-request-form.tsx` — local-part input with a fixed
  `@domain` suffix.
* `components/join/join-code-card.tsx` — the missing-domain warning.

## Security

* **Authentication / authorization** — unchanged: the domain is written only
  through the two `SUPER_ADMIN` organization endpoints.
* **Tenant isolation** — the public endpoints still take no organization id; the
  domain comes from the organization the code resolves to, on every request.
* **Validation** — Zod + pure rule + check constraint; the submit check is
  server-side, so editing the page or calling the API directly does not bypass
  it. Lookalike domains are refused by exact comparison.
* **Enumeration** — see Decision 6. The unknown-code answer is unchanged.
* **Audit** — creating with a domain and every change of it are recorded.

## Tests

* **Unit** — `lib/organization-email-domain.test.ts` (normalisation, every shape
  rule and length boundary, lookalikes, local-part rules, agreement with
  `z.email()`); additions to `lib/organization-join.test.ts`;
  `lib/server/organization-email-domain-schema.test.ts` for the two schemas;
  component tests for the join page, the join form, the join-code card and the
  organizations dialogs; contract additions to
  `lib/server/organization-join-contract.test.ts`.
* **Integration** — `tests/integration/organization-email-domain.test.ts`:
  401/403/200 on create and edit, normalisation, invalid shape, two tenants on
  one domain, clearing, the audit rows, the check constraint rejecting a raw
  write, the lookup with and without a domain, and the submit refusing no-domain,
  wrong-domain, subdomain and lookalike addresses while accepting the right one.
  The existing join fixtures get a domain so their 54 cases keep passing.
* **E2E** — `tests/e2e/organization-join-domain.spec.ts`: the prompt for a
  domain-less organization, a full join with the fixed suffix, Super Admin
  setting a domain in Edit Company that then opens the form, and Create Company
  storing one.

## Security review — as run

No finding required a code change. Examined: authentication and enumeration
(the unknown-code answer is unchanged; only a valid-code holder learns whether a
domain is set; a domain refusal is faster than a bcrypt success, which reveals
the domain rule and nothing about accounts), authorization (writes stay on the
two `SUPER_ADMIN` endpoints, 401/403 tested), tenant isolation (lookup/submit
read the domain off the code-resolved organization; the join-code read is
fenced on `scope.organizationId`; no cache holds the domain on the public
path), injection (Zod-bounded input, parameterised SQL, both regexes anchored
over bounded input), XSS (the domain renders as React text only), and audit
(creation metadata and every change, with before/after).

**Accepted, and written down:** the domain constrains how an address is
*spelled*, not who *owns* the mailbox. An applicant can type a colleague's
local part; an address that already belongs to an account is still refused by
the existing identity-conflict rule, and Head Office approval remains the
control. Proving mailbox ownership would need an email verification step —
a separate change.

## Verification — as run

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors; 1 warning in `components/dashboard/branch-admin-dashboard.tsx`, untouched by this change |
| `npm test` | 263 files, 3911 passed, 7 skipped, 0 failed |
| `npm run test:integration` | 28 files, 731 passed, 0 failed, every file `running against oneflowe_test` |
| `npm run build` | succeeded |
| `npm run db:validate` | clean |
| `npm run db:migrate` (disposable test DB) | applied `20260930120000_add_organization_email_domain` |
| `npx playwright test tests/e2e/organization-join-domain.spec.ts` | 4 passed |

A mutation check — the submit route's domain refusal disabled — failed 7
integration cases, so the suite detects its removal.

## Risks

* **Joining is closed for every organization until Super Admin sets a domain.**
  That is what was asked for, and the join feature is not yet deployed, so no
  live tenant loses anything. Head Office sees the warning on its card.
* A tenant whose staff use several domains cannot join through the form; they
  are still created directly by an administrator. Multiple domains would be a
  follow-up.
