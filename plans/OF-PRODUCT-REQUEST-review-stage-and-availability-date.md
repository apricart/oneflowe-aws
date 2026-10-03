# OF-PRODUCT-REQUEST — "Under review" stage and an expected availability date

Builds on `plans/OF-PRODUCT-REQUEST-head-office-new-product-requests.md`.

## Objective

Today a request is `PENDING` until Super Admin approves or rejects it, so Head
Office cannot tell a request nobody has looked at from one Super Admin is
working on, and an approval says nothing about when the product will actually
be orderable. This adds:

1. An **Under review** stage Super Admin can put a request into, which Head
   Office sees on its list and in the request.
2. An **expected availability date** Super Admin must give when approving,
   which Head Office sees as "Expected in the catalogue by …".

## Acceptance criteria

1. Super Admin sees a **Mark under review** button on a pending request. Using
   it moves the request to `UNDER_REVIEW` and records who and when.
2. Head Office sees the request as **Under review** — status badge, tab, and
   the progress timeline in the request — with the date review started.
3. Super Admin can **approve or reject at any time before a decision**: from
   `PENDING` directly, or from `UNDER_REVIEW`. Marking under review is never a
   required step.
4. **Approving requires an expected availability date** (`YYYY-MM-DD`), no
   earlier than today and no later than 365 days from today, both in
   Asia/Karachi. Rejecting takes no date, and a date sent with a rejection is
   refused.
5. Head Office sees the date on the approved request ("Expected in the
   catalogue by 15 Oct 2026") and beside the status in the list.
6. A decision stays final (409 on a second), and `UNDER_REVIEW` cannot be
   entered twice or after a decision (409).
7. RBAC unchanged: only `SUPER_ADMIN` moves a request; `HEAD_OFFICE` reads its
   own organization's.

## Decisions

- **"Anytime" means "at any point before the decision"**, not "a decision can
  be changed". Decisions were final in the first release (a double click must
  not flip a request) and stay final. Changing an approved request's date is a
  possible follow-up.
- **A date, not a duration.** "Expected by 15 Oct" means the same thing on the
  day it is written and a week later; "in 2 weeks" does not. The dialog offers
  quick picks (1 week, 2 weeks, 1 month) that fill the date.
- **Bounds are checked by a pure function that takes `now`**
  (`productRequestAvailabilityRefusal`), not inside the Zod schema, so the
  schema stays time-independent and the tests never read the wall clock. The
  schema checks only the shape and that the day exists on the calendar.
- **Requests approved before this change keep a null date.** The constraint
  allows a null date on an approved row; the API requires one for every new
  approval. The UI says "No date was given" for those.
- **The review-start fields are kept on a decided row** when review was
  started, so the timeline can still show when review began. A request decided
  straight from pending has none.
- **No notifications** — unchanged from the first release.

## API change

`PATCH /api/v1/product-requests/[id]` body becomes a discriminated union on
`status`, each branch strict:

| `status` | Other fields |
|---|---|
| `UNDER_REVIEW` | none |
| `APPROVED` | `reviewNote?` ≤ 1000, `estimatedAvailableOn` `YYYY-MM-DD` (required) |
| `REJECTED` | `reviewNote?` ≤ 1000 |

Transitions (`PRODUCT_REQUEST_TRANSITIONS` in `lib/product-request.ts`):

| From | To |
|---|---|
| `PENDING` | `UNDER_REVIEW`, `APPROVED`, `REJECTED` |
| `UNDER_REVIEW` | `APPROVED`, `REJECTED` |
| `APPROVED`, `REJECTED` | — |

`200 { id, status }` unchanged · 400 malformed / date out of range · 409
transition not allowed.

`GET /api/v1/product-requests` accepts `status=UNDER_REVIEW`; `counts` gains
`UNDER_REVIEW`; each item gains `reviewStartedAt`, `reviewStartedBy
{ id, fullName } | null`, `estimatedAvailableOn` (`YYYY-MM-DD` | null).
Additive — no field renamed or removed.

## Data

Migration `20261003120000_add_product_request_review_stage.sql`, hand-written,
journal `when` = previous + 3 600 000:

- `review_started_at timestamptz NULL`
- `review_started_by_user_id uuid NULL → users`
- `estimated_available_on date NULL`
- `product_requests_status_ck` recreated with `UNDER_REVIEW`.
- `product_requests_review_ck` recreated: the decision fields are empty while
  `PENDING` **or** `UNDER_REVIEW`.
- New `product_requests_review_start_ck`: both review-start fields null while
  `PENDING`, both set while `UNDER_REVIEW`, and set together or not at all
  otherwise.
- New `product_requests_availability_ck`: `estimated_available_on` is null
  unless `APPROVED`.

The table is days old and small; recreating the CHECKs validates it under a
brief lock. Every existing row satisfies the new constraints (no row is
`UNDER_REVIEW`, no row has a date or review-start fields).

Rollback: there is no clean rollback once a row is `UNDER_REVIEW` or carries a
date. Move any `UNDER_REVIEW` row back to `PENDING` and clear its review-start
fields, then drop the two new constraints and the three columns and recreate
the original two CHECKs (SQL is in the migration header).

**Apply to production before deploying** — the code selects the new columns.

## Security

- **Authorization** unchanged: `canReviewProductRequest` on the PATCH;
  `UNDER_REVIEW` is a reviewer action like a decision.
- **Validation**: strict per-branch schemas, so `estimatedAvailableOn` on a
  rejection, a note with `UNDER_REVIEW`, or any unknown key is refused.
- **Replay / race**: the row is locked `FOR UPDATE` and the transition re-read
  inside the transaction, and the update is conditional on the from-status, so
  two concurrent moves cannot both succeed.
- **Audit**: `START_PRODUCT_REQUEST_REVIEW` for the review start and
  `REVIEW_PRODUCT_REQUEST` (now carrying `estimatedAvailableOn`) for a
  decision, both inside the transaction.
- **Tenant scope**: unchanged — the list predicate is the viewer's scope.

## Tests

- `lib/product-request.test.ts` — the union schema per branch, the transition
  table, the date bounds against a fixed `now` including the Karachi day
  boundary, the label formatter.
- `components/product-requests/product-requests-view.test.tsx` — Mark under
  review sends `{ status: "UNDER_REVIEW" }`; approve without a date is stopped
  in the dialog; approve sends the date; Head Office sees Under review and the
  expected date; the timeline marks the right step.
- `tests/integration/product-requests-api.test.ts` — under-review round trip
  with audit row, second under-review 409, approve from under review with the
  date stored, approve with no / past / too-far date 400, reject with a date
  400, Head Office reads the stage and the date, the new constraints.
- `tests/e2e/product-requests.spec.ts` — the approval step fills the date.
