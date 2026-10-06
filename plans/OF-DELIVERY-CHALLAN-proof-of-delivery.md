# OF-DELIVERY-CHALLAN — A delivery challan is required to mark an order delivered

## Objective

When Super Admin moves an order to **Delivered**, it must attach the delivery
challan — a photo or scan, or a PDF. Everyone who can already read the order can
view its challan. Super Admin can replace a wrong one; the old file is kept and
the change is audited.

## Decisions (confirmed 2026-10-06)

| Question | Decision |
|---|---|
| Who views it | **Everyone who can read the order** — the same rule as `GET /api/v1/orders/{id}`: Super Admin, Head Office (its organization), Branch Admin (its branch), Group User and Group Order Portal (their assigned branches), Order Portal (its own orders and its branch's group orders). |
| File types | **JPG, PNG, WebP and PDF.** Word/Excel are refused: they carry macros and a challan is a scan, photo or PDF. |
| Replace | **Yes, Super Admin only**, after delivery. The previous file is kept (`replaced_at`, `replaced_by_user_id`) and both events are audited. |

## What exists, and the one choke point

Delivery is recorded only by `POST /api/v1/orders/{id}/fulfillment-status`
(`SUPER_ADMIN` only), called from the orders directory drawer. Fulfilment never
records delivery (`CLAUDE.md`, "No order is fulfilled before it is delivered").
So requiring the challan there covers every way an order becomes Delivered,
Order Desk orders included. The KE import scripts write historic deliveries
directly and are untouched.

## Upload

Through `POST /api/v1/upload/image` with `purpose=delivery-challan` and
`orderId`, because that is the one upload path the production WAF lets through
(the reason the Order Desk screenshot and the product-request picture use it).
Super Admin only for this purpose.

* **Images** are re-encoded through `sharp` (`sanitizeRasterUpload`), which
  drops EXIF and anything embedded.
* **PDFs** are not re-encoded (there is no safe re-encoder in the dependency
  set). They are checked by `inspectPdfUpload` (`lib/server/pdf-upload-security.ts`):
  the `%PDF-` signature and an `%%EOF` trailer; at most 4 MB; refused if
  encrypted, or if — after decoding `#xx` name escapes and inflating every
  Flate stream, under an output cap — they contain JavaScript (`/JavaScript`,
  `/JS`), `/Launch`, `/EmbeddedFile(s)`, `/RichMedia`, `/XFA`, `/SubmitForm`,
  `/ImportData`, `/GoToR` or `/GoToE`. They are then served as a **download**,
  never inline, so nothing in one can run in the application's origin.
* The order must exist, be `APPROVED`, and (for a first challan) not yet be
  delivered; for a replacement, it must be delivered.
* Stored under the private `delivery-challan/` prefix, which the public image
  route (pinned to `products/`) cannot serve. Never a `data:` URL, not even in
  local development.
* A row in `order_delivery_challans` is created **unattached**, bound to the
  order and the uploader. The response carries its id, never a path.
* The browser shrinks a large photo before upload (max 2400 px, JPEG), so a
  phone photo fits under the 4 MB limit. That is a convenience; the server
  checks everything again.

## Attach

* `POST /api/v1/orders/{id}/fulfillment-status` with
  `{ fulfillmentStatus: "DELIVERED", deliveryChallanId }`. The id is
  **required** for DELIVERED and **refused** for any other stage. It is attached
  in the same transaction as the status change, by a conditional update that
  only matches a row for **this order**, uploaded by **this actor**, not yet
  attached. Anything else rolls the delivery back (400).
* `POST /api/v1/orders/{id}/delivery-challan` with `{ deliveryChallanId }`
  replaces the current challan on a delivered order: Super Admin only, same
  conditional attach, previous row marked replaced, same transaction.

## Read

* `GET /api/v1/orders/{id}/delivery-challan` — the current challan's metadata
  (id, file name, type, size, uploaded at, uploader's role), and for Super
  Admin the replaced ones too.
* `GET /api/v1/orders/{id}/delivery-challan/{challanId}/file` — the bytes.
  Non-Super-Admin readers get the current challan only. Headers:
  `Cache-Control: private, no-store`, `nosniff`, a `sandbox` CSP, the stored
  (allowlisted) content type, and `Content-Disposition: attachment` for a PDF,
  `inline` for an image. The file name is sanitised and RFC 5987-encoded.
* Both reads use `canReadOrderDetail` (`lib/server/order-read-access.ts`) —
  the rule `GET /api/v1/orders/{id}` applies, moved into one module so the two
  cannot drift. Out of scope is 404, as on the detail read.

Not admitted: `VIEWER`, `ORDER_DESK`, `APRICART_EXECUTIVE` (none reads the order
detail today; the proxy allowlists for the last two exclude these routes).

## Data

Migration `20261008120000_add_order_delivery_challans.sql` (additive):
`order_delivery_challans` — `id`, `order_id` (cascade), `organization_id`,
`branch_id`, `storage_key` (unique, shape-checked), `file_name`,
`content_type` (checked), `size_bytes` (1 B–4 MB), `uploaded_by_user_id`,
`uploaded_at`, `attached_at`, `replaced_at`, `replaced_by_user_id`. One current
challan per order (partial unique index on `order_id` where attached and not
replaced). A replaced row must have been attached.

Rollback: drop the table. Orders already delivered stay delivered; their
challans are no longer listed (the S3 objects remain).

## Audit

`UPLOAD_DELIVERY_CHALLAN` (after the object lands — an S3 write cannot share a
transaction), `ORDER_FULFILLMENT_STATUS_UPDATE` now carries `deliveryChallanId`,
`REPLACE_DELIVERY_CHALLAN`.

## Tests

Unit: PDF inspection (each forbidden token, escaped names, compressed streams,
encrypted, bad signature, size), file-name sanitising, the delivered-transition
schema. Contract: the read rule is shared with the order detail; the public
image route cannot serve the prefix; the proxy allowlists exclude the routes.
Integration: upload + deliver + read by every role (allowed and refused),
cross-tenant 404, wrong uploader / other order / reused challan refused,
delivery without a challan refused, replace, history visible to Super Admin
only, PDF served as a download.

## Risk

* The production WAF must let a PDF through `POST /api/v1/upload/image`. If it
  blocks `application/pdf` bodies, images still work; test a PDF on staging
  before relying on it.
* Delivery now needs a file, so it can no longer be recorded from a client that
  cannot upload (no such client exists).
