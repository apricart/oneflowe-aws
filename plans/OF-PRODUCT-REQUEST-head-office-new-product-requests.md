# OF-PRODUCT-REQUEST — Head Office requests a new product from Super Admin

## Objective

Head Office cannot add a product to the catalogue: global products, and every
price on them, are Super Admin's. Today a Head Office user who needs something
the catalogue does not carry has no channel for it inside OneFlowe. This adds
one: a request form for Head Office, and a queue for Super Admin that shows
what was asked for and by whom.

## Acceptance criteria

1. Head Office sees **Product Catalog → Product Requests** and can submit a
   request through a form that takes everything relevant to a new product,
   including an image. **Every field is optional**; a submission with nothing
   in it at all is refused, because it asks for nothing.
2. The request reaches Super Admin: Super Admin sees **Product Catalog →
   Product Requests** with every request across every organization, and for
   each one what was requested (every field, the image) and who requested it
   (name, email, role, organization) and when.
3. Super Admin can mark a pending request **Approved** or **Rejected**, with an
   optional note. Head Office sees that outcome and the note on its own list.
4. RBAC:
   - Only `HEAD_OFFICE` may raise a request.
   - Only `SUPER_ADMIN` may review one.
   - `HEAD_OFFICE` reads the requests of **its own organization only**;
     `SUPER_ADMIN` reads all of them.
   - Every other role is refused by the page and by every handler.
5. Unit and integration tests cover the rule, the validation, and the routes
   (401 / 403 / success / cross-tenant / escalation).

## Decisions

- **Head Office reads its whole organization's requests, not just its own.**
  An organization can have several Head Office users; seeing each other's
  requests stops the same product being asked for twice. Same reach as support
  threads (`lib/support-access.ts`).
- **The image goes through the existing `POST /api/v1/upload/image`, widened to
  `HEAD_OFFICE`.** That path is the only raster upload the production WAF's
  `AllowImageUpload` rule lets through besides support attachments, so a new
  upload route would 403 in production until the infra repo was changed. The
  widening grants Head Office nothing new in substance: it already writes
  `organization_inventory.custom_image_url` through
  `PUT /api/v1/head-office/organization-inventory`. The upload stays sanitised
  through `sharp`, rate limited (`upload`, 20/hour), and audited
  (`UPLOAD_IMAGE`). The stored object is a catalogue-shaped image under
  `products/`, so Super Admin can reuse the same path as the product image
  when adding it.
- **The request stores only a stored image path** (`isStoredImagePath`) —
  never a `data:` URL, never an external URL. A CHECK constraint backs that up.
  In local development without S3 the upload route returns a `data:` URL and
  the request refuses it with a clear message; that is deliberate.
- **Expected price is information only.** It is kept on the request in cents
  so Super Admin knows what Head Office expects to pay. Nothing in the pricing
  ladder reads it, and approving a request creates no product and sets no
  price — Super Admin adds the product through the existing Add Product flow,
  which is where `lib/pricing-access.ts` applies.
- **Approving does not create the product.** Creating a global product needs a
  code, category, unit, price and stock that Super Admin decides. Pre-filling
  the Add Product form from a request is a sensible follow-up, not part of this.
- **No notifications in this change.** The queue and its pending count are the
  channel. An in-app/email notification to Super Admin is a follow-up.
- **Role allowlists, not `Permission` keys** (decided during implementation).
  `ROLE_TEMPLATES.SUPER_ADMIN` is `Object.values(Permission)`, so a
  `PRODUCT_REQUEST_CREATE` key would be granted to Super Admin by construction —
  contradicting "Super Admin does not raise requests" — and `rolePermissions`
  rows exist only after `db:seed`. This follows the documented precedent in
  `lib/organization-join-access.ts`.
- **Request bodies stay under the WAF's 8 KB body limit.** The production
  Core Rule Set refuses bodies over 8 KB outside the upload paths with an
  opaque 403. Description and notes are therefore 1000 characters (an
  all-ASCII form at every limit is ~6 KB), and the form measures the encoded
  body and refuses to send one over `PRODUCT_REQUEST_MAX_BODY_BYTES` (8000)
  with a "shorten it" message — needed because Urdu is two bytes a character.
  Support messages (5000 chars) carry the same latent risk; not changed here.

## Architecture

| Layer | Piece |
|---|---|
| Pure domain | `lib/product-request.ts` — statuses, field limits, Zod schemas (create, review, list query), normalisation, "at least one field", reference-URL rule, transition rule, list response types |
| Pure form helper | `lib/product-request-form.ts` — form strings → API body (price via `parsePriceInput`, body-size guard) |
| Pure access rule | `lib/product-request-access.ts` — who raises, who reviews, visibility scope (role allowlists; see Decisions) |
| Server domain | `lib/server/product-requests.ts` — create, list, review (SQL, transaction, row lock, audit) |
| Route handlers | `app/api/v1/product-requests/route.ts` (GET, POST), `app/api/v1/product-requests/[id]/route.ts` (PATCH) |
| Persistence | `product_requests` table, migration `20260930180000_add_product_requests.sql` |
| UI | `app/(portal)/inventory/product-requests/{page,loading}.tsx` (server-gated page, as `price-history` is), `components/product-requests/*`, sidebar entries |

The access rule mirrors `lib/support-access.ts`: the list query is built from
`productRequestVisibilityScope`, so the list and any single-row check cannot
disagree.

## API

### `GET /api/v1/product-requests`

Query: `status` (`PENDING|APPROVED|REJECTED`, optional), `organizationId`
(Super Admin only — ignored for Head Office, whose scope is its own tenant),
`page` (default 1), `pageSize` (default 20, max 50).

`200 { items, total, page, pageSize, counts: { PENDING, APPROVED, REJECTED } }`
— each item carries the request fields, `requestedBy { id, fullName, email,
role }`, `organization { id, name }`, category and subcategory names, and
`reviewedBy { id, fullName }`. `Cache-Control: private, no-store`.

401 no session · 403 role other than SA/HO, or HO with no organization · 400
malformed query.

### `POST /api/v1/product-requests`

Head Office only. Rate limit `sensitive`. Body (strict — unknown keys are
refused), every field optional:

| Field | Type / limit |
|---|---|
| `productName` | string ≤ 255 |
| `brand` | string ≤ 255 |
| `description` | string ≤ 1000 |
| `categoryId` | positive integer, a top-level category |
| `subcategoryId` | positive integer, a child of `categoryId` when both are given |
| `unit` | string ≤ 64 |
| `packSize` | string ≤ 128 |
| `barcode` | string ≤ 64 |
| `expectedPriceCents` | integer cents, 0 … `MAX_PRICE_CENTS` (the browser converts with `parsePriceInput`, never sends a float) |
| `estimatedMonthlyQuantity` | number ≥ 0, ≤ `MAX_BUSINESS_QUANTITY` |
| `preferredSupplier` | string ≤ 255 |
| `referenceUrl` | `http(s)` URL ≤ 2048, no credentials |
| `notes` | string ≤ 1000 |
| `imageUrl` | a stored image path (`/api/v1/images/products/<uuid>.<ext>`) |

Blank strings normalise to null. At least one field must carry a value.
`organizationId`, `requestedByUserId`, `status` are never read from the body —
a body carrying one is refused by the strict schema.

`201 { id }` · 400 validation (field-level message) · 401 · 403 not Head Office
/ no organization · 429.

### `PATCH /api/v1/product-requests/[id]`

Super Admin only. Rate limit `write` (a Super Admin working through a queue
should not hit the 10-per-5-minutes `sensitive` tier). Body (strict):
`{ status: "APPROVED" | "REJECTED", reviewNote?: string ≤ 1000 }`.

The update is conditional on `status = 'PENDING'` in one statement, so a
double submission or two reviewers racing cannot both succeed.

`200 { id, status }` · 400 · 401 · 403 · 404 unknown id · 409 already reviewed.

## Data

New table `product_requests`, additive only:

```
id serial PK
organization_id int NOT NULL → organizations
requested_by_user_id uuid NOT NULL → users
status varchar(32) NOT NULL DEFAULT 'PENDING'
product_name varchar(255), brand varchar(255), description text,
category_id int → categories ON DELETE SET NULL,
subcategory_id int → categories ON DELETE SET NULL,
unit varchar(64), pack_size varchar(128), barcode varchar(64),
expected_price_cents int, estimated_monthly_quantity numeric(12,3),
preferred_supplier varchar(255), reference_url text, notes text, image_url text,
review_note text, reviewed_by_user_id uuid → users, reviewed_at timestamptz,
created_at, updated_at timestamptz DEFAULT now()
```

Constraints: status in the three values; `expected_price_cents >= 0`;
`estimated_monthly_quantity >= 0`; `image_url` null or under
`/api/v1/images/products/`; reviewed fields all null while `PENDING` and
`reviewed_by_user_id`/`reviewed_at` set otherwise.

Indexes: `(organization_id, created_at)`, `(status, created_at)`,
`(requested_by_user_id)`.

The migration is hand-written, with the journal `when` set to the previous
entry + 3 600 000 (see the generated-migration trap in the repo history). No
backfill. Rollback: `DROP TABLE product_requests;` — nothing else references it.

## Security

- **Authentication**: `getServerSession` → 401.
- **Authorization**: `lib/product-request-access.ts` on every handler; the page
  layout gates on the same function; the sidebar is presentation only.
- **Tenant scope**: the raiser's organization is re-read from the `users` row
  (`getRequestScope()` + a row read), never from the request. The list's
  predicate is built from the viewer's scope. Head Office's `organizationId`
  query parameter is ignored, not honoured.
- **Validation**: strict Zod, field limits, integer cents; the category pair is
  checked against the `categories` table; the image must be a stored path.
- **XSS**: the reference URL is restricted to `http(s)` on write and rendered
  with `rel="noopener noreferrer"`; all other text renders through React.
- **Mass assignment / escalation**: strict schemas refuse `organizationId`,
  `status` on create, `requestedByUserId`, and any unknown key.
- **Replay**: review is a conditional update; a second review gets 409.
- **Audit**: `CREATE_PRODUCT_REQUEST` and `REVIEW_PRODUCT_REQUEST` recorded via
  `recordAuditEvent` inside the transaction; the route goes on the `DIRECT`
  list in `lib/server/activity-audit-coverage.test.ts`.
- **Rate limit**: `sensitive` on POST, `write` on PATCH, `search` on GET.
- **Upload widening**: see Decisions.

## Tests

Unit (beside the code):
- `lib/product-request.test.ts` — normalisation, at-least-one-field, each
  limit, cents conversion, reference URL schemes, image path rule, unknown keys
  refused, review schema, transition rule, list-query parsing and bounds.
- `lib/product-request-access.test.ts` — raise/review/read per role, scope per
  role, missing organization fails closed, lookalike role strings refused.
- `lib/product-request-form.test.ts` — form → body: cents conversion, bad
  amounts flagged per field, the body-size guard, and a body the server schema
  accepts.
- `components/shell/sidebar.product-price-history.test.ts` — the new entry for
  both roles, absent for every other role.
- `lib/server/activity-audit-coverage.test.ts` — both new routes classified
  `VIA_LIB` against `lib/server/product-requests.ts`.

Integration (`tests/integration/product-requests-api.test.ts`, fixtures in
`helpers/product-request-fixtures.ts`, prefix `ITPR-`):
- 401 on every handler without a session.
- 403 for Branch Admin, Order Portal, Group User, Group Order Portal, Viewer.
- Head Office creates; the row carries its own organization and user, whatever
  the body tries; audit row written.
- An empty body → 400; unknown field (`organizationId`, `status`) → 400; a
  `data:` or external image → 400; a subcategory not under the category → 400;
  unknown category → 400.
- Head Office A lists only organization A's requests; Head Office B cannot see
  A's; a Head Office `organizationId=<B>` query still returns only A's.
- Super Admin lists all, filters by organization and status, sees requester
  name/email/role and organization name.
- Super Admin cannot raise (403); Head Office cannot review (403).
- Review approve/reject writes reviewer and time; second review → 409; unknown
  id → 404; audit row written.
- Upload: Head Office now reaches `POST /api/v1/upload/image`; Branch Admin
  still 403.

## Risks

- **Blast radius is small**: a new table, new routes, and one widened role on
  the upload route. No existing table, price, order or budget is touched.
- **Upload widening** is the one change to existing behaviour. If it proves
  unwanted, reverting that one condition restores the previous rule; requests
  keep working without images.
- **Migration** is additive and creates an empty table — no lock on an existing
  large table.

## Steps

1. Domain + access modules with unit tests.
2. Schema + migration; apply to the local test database.
3. Server module + route handlers; widen the upload route.
4. Integration tests.
5. Permissions, sidebar, page, components.
6. Contract-test updates (audit coverage, sidebar).
7. Gates: typecheck, lint, unit, integration (confirm it ran), build.
