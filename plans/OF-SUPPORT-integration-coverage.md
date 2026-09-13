# Support threads — integration coverage against a real Postgres

## Why

`plans/OF-SUPPORT-portal-to-apricart-threads.md` closes with:

> The integration suite skipped, so **nothing here has been exercised against a
> real Postgres.** The migration, the row-locked transitions, the attachment
> claim window and the `ON CONFLICT` upserts are unverified against a live
> database and should be run on a disposable one before this reaches production.

That is still true. The pure rules (`lib/support-access.ts`,
`lib/support-thread.ts`, `lib/support-stats.ts`) have behavioural unit tests,
and the seven routes have a *contract* test (`lib/server/support-boundaries.test.ts`)
that reads their source. Nothing runs `lib/server/support-threads.ts` — the
1,000 lines that turn the visibility table into SQL, verify order and product
references, claim attachments, lock rows, and queue notifications — against a
database. That is where a tenant leak or a lost message would actually live.

## What this adds

`tests/integration/support-threads-api.test.ts`, driving the seven route
handlers HTTP-shaped with only identity, rate limiting, S3 and outbound mail
faked, against fixtures from `tests/integration/helpers/support-fixtures.ts`.

Coverage, following rule 03 and the protected-endpoint list in rule 04:

| Concern | How it is exercised |
|---|---|
| 401 / 403 | every route, unauthenticated and as a non-participant role (`GROUP_USER` is a participant; a made-up role is not); Apricart cannot *raise* a thread or upload an attachment because it has no tenant |
| Visibility table, per role | seven seeded threads across two tenants, three branches and every requester role; each role's list is asserted **exactly**, and the detail route answers 404 for everything outside it |
| Tenant isolation | Head Office B and a foreign requester never see, read, reply to or update tenant A's threads; a tenant-A attachment is 404 to tenant B |
| Filters cannot widen | `organizationId` is ignored for Head Office and honoured for Apricart; `orderSearch` narrows within scope only; reference lookup outside scope is empty |
| Validation | missing subject, unknown field, retired category, product-required category without a product, over-long order search, empty PATCH body |
| Order reference | every role against own / colleague / other-branch / other-tenant orders, and a group role through its branch assignment — 400 with one message for "missing" and "not yours" |
| Product reference | own catalogue, other tenant's catalogue, inactive assignment, unassigned product |
| Lifecycle in SQL | posting moves status (`OPEN` ↔ `AWAITING_CUSTOMER`), `firstResponseAt` set once, reply to a resolved thread reopens and clears the settlement stamps, closed thread refuses replies with 409, only Apricart closes / reopens closed / triages, assignee must be an active Apricart administrator |
| Notifications | raising notifies Apricart; an Apricart reply notifies the raiser; a branch administrator replying notifies the raiser; the author is never notified of their own message; `notifications` and `email_outbox` rows both land on the same transaction |
| Attachment claim | only the uploader's own, unclaimed, recent attachments are claimed; a colleague's, a stale one and an already-claimed one are left alone; a claimed attachment appears on the message it was claimed for |
| Attachment read | uploader reads an unclaimed one; anyone in the thread's scope reads a claimed one; everyone else gets 404; response is `private, no-store` and `Content-Disposition: attachment` |
| Upload | a real PNG through `sharp` lands as an unclaimed row; for a **reply** the row takes the thread's tenant and every reader of the thread (Apricart included) may upload, anyone else gets 404; for a **new query** it takes the uploader's own tenant, so Apricart is 403; a non-image and a mismatched declared type are 400; unconfigured storage is 503 |
| Read tracking / stats | opening a thread marks it read; the KPI tiles count exactly the viewer's scope; `unread` and `unanswered` move as expected; the average is null until Apricart has answered |

## The defect this surfaced

The first draft of this suite asserted that an Apricart upload is 403, because
that is what `POST /api/v1/support/attachments` did and what its comment said
it should do. That was testing the code's intent, not the product's: the reply
composer offers Apricart an "Attach a screenshot" button, and in production it
answered "Forbidden". The route resolved the uploader with
`resolveSupportAuthor()`, which needs an organization of its own — right for
raising a query, wrong for answering one.

Fixed in the same change: the picker sends `threadId` when replying, the route
resolves that thread through the ordinary visibility rule (404 when it is not
the caller's) and stamps the row with the thread's organization, which is the
tenant the reply's claim already checked against. Without a `threadId` the
behaviour is unchanged. The suite now fails four tests against the old route.

## How it runs before production

Nothing to wire. `vitest.integration.config.ts` includes
`tests/integration/**/*.test.ts`, and both `.github/workflows/dev-check.yml`
(every PR to `dev`) and `.github/workflows/deploy-prod.yml` (before the image
is built) start a Postgres service container, migrate it, run this project,
and **fail the job on a skip**. Locally it needs `TEST_DATABASE_URL` in
`.env.test.local` pointing at a migrated disposable database.

## Not covered here

- The email *content* (`lib/email/support.ts`) — already unit-tested; delivery
  is mocked so a mail provider is never contacted from a test.
- The React components under `components/support/` — presentation only.
- `purgeExpiredSupportUploads` — a one-statement delete; its window constant is
  the same one the claim test exercises.
