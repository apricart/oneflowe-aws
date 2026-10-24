# OF-ORDER-DESK — show the customer's screenshot to everyone who reads the order

Status: built 2026-10-22, uncommitted. No migration.

## Requirement

The Order Desk attaches a screenshot of the customer's email/WhatsApp message to
every order it keys in. Until now only the desk and the Apricart Executive could
see it. The warehouse, and every other user who can see an Order Desk order,
must be shown it wherever the order's details are shown.

## Who sees it, and by which rule

Each reader reaches the image through its own route, under exactly the rule that
already decides whether it may read the order. No rule is widened.

| Reader | Route | Rule |
|---|---|---|
| Order Desk | `GET /api/v1/order-desk/orders/[id]/attachment` (unchanged) | desk reach |
| Apricart Executive | `GET /api/v1/executive/approvals/[id]/attachment` (unchanged) | approval reach |
| Super Admin, Head Office, Branch Admin, Group User, Group Order Portal, Apricart Support, organization-wide Viewer | `GET /api/v1/orders/[id]/intake-screenshot` (new) | `canReadOrderDetail` — the order detail's own rule |
| Warehouse | `GET /api/v1/warehouse/orders/[id]/intake-screenshot` (new) | `loadWarehouseOrderInReach` — its branches, approved work only |

An Order Portal user reads only the orders it raised (and its branch's group
orders), so a desk order is a 404 to it — as the order itself is.

Both new routes read the key with `loadDeskOrderIntakeAttachmentKey`, which
returns it only for an order with `created_by_role = 'ORDER_DESK'`, and stream it
through the existing `intakeAttachmentResponse` (private, `no-store`, `nosniff`,
sandboxed). Out of scope, not a desk order, no screenshot, malformed id: the same
404.

## Payloads

The order list, the order detail and the warehouse picking sheet carry
`hasIntakeScreenshot: boolean` (`hasDeskIntakeScreenshot` in
`lib/order-desk-access.ts`). The key itself never leaves the server.

## Allowlists

- `WAREHOUSE_API_RULES`: the warehouse route, GET only.
- `APRICART_SUPPORT_API_RULES`: the order readers' route, GET only.
- `VIEWER_ORGANIZATION_READ_ROUTES`: the order readers' route (it passes
  `viewerReadsAsHeadOffice: true`, like the challan file route).

## UI

`components/orders/order-intake-screenshot.tsx` — inline image that opens full
size in a new tab, with loading and "could not be loaded" states. Used by the
shared order drawer (`OrderDetailPanel`), the order page
(`/orders/[orderId]`) and the warehouse picking sheet.

## Tests

- `tests/integration/order-intake-screenshot-api.test.ts` — role matrix (401,
  403 for desk/executive/warehouse/pinned Viewer on the readers' route, 403 for
  every non-warehouse role on the warehouse route), tenant and branch fence,
  Order Portal 404, non-desk order 404, no-screenshot 404, pending order 404 to
  the warehouse, out-of-reach warehouse 404, and the key absent from list,
  detail and sheet payloads.
- Contract: `lib/server/order-desk-contract.test.ts`; allowlists:
  `lib/warehouse-access.test.ts`, `lib/apricart-support-access.test.ts`,
  `lib/viewer-access.test.ts`; the warehouse and viewer isolation sweeps cover
  the new handlers automatically.
- Components: `order-intake-screenshot.test.tsx`, `warehouse-order-sheet.test.tsx`.

## Security impact

Read-only. The screenshot carries a customer's personal details; it is shown
only to people who can already read the order and its lines. No upload, write,
or price path changes.

## Rollback

Revert the commit. No data or schema change.
