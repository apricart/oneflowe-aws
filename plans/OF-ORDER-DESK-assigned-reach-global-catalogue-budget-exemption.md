# OF-ORDER-DESK — assigned reach, global catalogue and budget exemption

Status: **planned**

Date: 2026-10-22

Depends on: `plans/OF-ORDER-DESK-line-price-entry.md` and its additive
`20261031120000_order_item_entered_price.sql` migration.

## 1. Request

An Order Desk user must continue to create orders only for the organizations
and branches that Super Admin assigned to that user. Inside an assigned target,
the desk must be able to select any active product in Apricart's global
catalogue, including a product that is not assigned to the organization or
branch. The desk enters the agreed unit price, including tax, on every line.
Order Desk orders do not consume or require either a money budget or a quantity
budget.

The resulting rule is:

```text
target access = current Order Desk assignment rules
product access = every active, non-deleted global product
charged price = Order Desk's required tax-inclusive unit price
budget access = no budget check, hold, spend or release
```

## 2. Boundaries

This change does **not** grant an Order Desk user a new organization or branch.
It does not turn the role into a platform-wide tenant reader.

- `organizations.managed_ordering` remains required.
- `order_desk_assignments` remains required. A whole-organization assignment
  reaches its active branches; a single-branch assignment reaches only that
  branch.
- The account, organization and chosen branch must be active and not deleted.
- Reach is read from the database for the catalogue request and checked again
  under the existing locks inside order creation. An empty or stale assignment
  reaches nothing.
- One order still belongs to exactly one organization and one branch. There is
  no cross-organization cart or order.
- No `organization_inventory` or `branch_inventory` row is inserted, restored,
  activated or made visible as a side effect of ordering.
- Global stock, tax, payment-control, unacknowledged-delivery, delivery-address,
  approval, idempotency, invoice, audit and fulfilment rules remain in force.
- Every non-Order-Desk role keeps its current catalogue, price and budget rules.

## 3. Findings

### F1 — Reach and product availability are already separate checks

`isOrderDeskTarget` decides whether the user may order for the selected
organization and branch. `loadOrderDeskCatalogue` then limits products through
`branch_inventory`. The reach check can remain unchanged while the desk-only
catalogue source changes to `global_products`.

### F2 — An order item can already represent a product without organization inventory

`order_items.organization_inventory_id` is nullable, while
`order_items.global_product_id` is required. Stock, invoices and historical
line rendering already use the global product id and the line's name, code,
unit, quantity and price snapshots. An unassigned desk line can therefore store
`organization_inventory_id = NULL` without creating a catalogue assignment.

The write and edit request contracts currently require
`organizationInventoryId`; those contracts and their loaders need the change,
not the database nullability.

### F3 — Budget participation is fixed on the order

`orders.budget_tracked` is the durable answer to whether later operations move
money or quantity through a budget. Setting it to false at desk-order creation
lets edit, rejection, cancellation, fulfilment and refund retain the correct
ledger behaviour without consulting the organization's current budget switch.

### F4 — The entered-price work already defines tax semantics

`unitPriceCents` is a gross, tax-inclusive unit price. The server splits the
line's gross amount into net and tax using the product/organization tax rate;
it does not add tax on top of the entered figure. The order, invoice, approval,
refund and credit-note paths continue to use the stored line snapshots.

## 4. Decisions

### D1 — Keep the existing reach fence exactly as it is

The target picker remains backed by `loadOrderDeskTargets`. The catalogue route
must call `isOrderDeskTarget` before reading global products. `POST /api/v1/orders`
must perform the existing pre-flight reach check and repeat it inside the
transaction with `lock: true` before reading or locking products.

An assignment to organization A never permits a catalogue or order for
organization B. An assignment to branch A1 never permits branch A2. A request
that names a branch under the wrong organization is refused even if both ids
are independently assigned.

### D2 — The desk catalogue is the active global catalogue

For an admitted target, `GET /api/v1/order-desk/catalogue` returns every
`global_products` row whose status is active and whose `deleted_at` is null.
The response includes at least:

```ts
type OrderDeskGlobalCatalogueItem = {
  globalProductId: number
  organizationInventoryId: number | null
  productCode: string
  name: string
  unit: string
  allowDecimalQuantity: boolean
  quantityStep: number
  stockQuantity: number
  assignedToBranch: boolean
  cataloguePriceCents: number | null
}
```

`organizationInventoryId`, `assignedToBranch` and `cataloguePriceCents` are
reference information only:

- when the product is currently active and visible in the chosen branch,
  `assignedToBranch` is true and `cataloguePriceCents` is resolved through the
  existing group → organization → global ladder;
- otherwise `assignedToBranch` is false and `cataloguePriceCents` is null. The
  endpoint must not expose the global base price as a customer price for a
  product that the branch does not normally carry;
- neither case changes whether the desk may select the active global product.

The endpoint is paginated and searchable by product name or code so "all
products" is not accidentally capped by `ORDER_DESK_CATALOGUE_LIMIT`. Page and
search inputs are bounded. The client keeps selected lines independently of the
visible page so changing the search does not discard the draft.

Inactive, deleted or missing global products are never returned and are
refused again during creation.

### D3 — A desk order line is identified by global product

The desk creation and edit payloads use the stable global product identity:

```json
{
  "globalProductId": 123,
  "quantity": 2,
  "unitPriceCents": 125000
}
```

For `ORDER_DESK`:

- `globalProductId`, `quantity` and `unitPriceCents` are required on every line;
- global product ids must be unique within the order;
- `unitPriceCents` is an integer from `MIN_ENTERED_UNIT_PRICE_CENTS` through
  `MAX_PRICE_CENTS`;
- `organizationInventoryId` from the client is not trusted as authority.

Other roles continue to send `organizationInventoryId` and cannot use the
global-product line shape or enter a line price. Validation stays strict and
role enforcement happens before catalogue, budget or product data is read.

During persistence, `order_items.organization_inventory_id` is the matching
active branch assignment's organization-inventory id when one exists, and null
otherwise. It is lineage only for a desk order; it is never the authority that
made the product orderable. `global_product_id` and the product and price
snapshots are always written.

The idempotency fingerprint includes `globalProductId`, normalized quantity and
entered unit price. Changing any of them while reusing a key returns the
existing idempotency conflict.

### D4 — Every desk line has a required tax-inclusive price

The Order Desk enters the agreed unit price in rupees in the UI; the client
converts it to integer cents and the API accepts only `unitPriceCents`.

- The entered number is the gross unit price, including tax.
- The server never adds tax to that figure.
- `quantity × unitPriceCents` is the gross line amount.
- `splitInclusiveCents` records the included tax portion using the resolved tax
  rate, so `net + tax = gross` exactly.
- A missing, zero, negative, fractional-cent or over-limit price is refused.
- The server repeats price and total calculation inside the transaction.

The entered-price design in `plans/OF-ORDER-DESK-line-price-entry.md` remains
the source of truth for `price_entered_manually` and
`catalogue_price_cents`. When an entered price differs from an available branch
catalogue price, both figures are stored and shown to the Apricart Executive.
When no branch catalogue price exists, the reference is null. Re-entering the
same available catalogue price charges that price and retains the existing
"not an override" semantics.

### D5 — Every desk order is budget-exempt

After the live reach check establishes that the creator is still an active
`ORDER_DESK` user, creation treats the order as budget-exempt:

- the pre-flight does not read or create a `budgets` row;
- insufficient or missing money budget cannot refuse the order;
- quantity-budget allocation cannot hide or refuse a product;
- the transaction does not lock a money or quantity budget row;
- no money or quantity hold is written;
- the order is persisted with `budget_tracked = false`.

The transaction must derive the exemption from the authenticated creator and
the successful live Order Desk reach check, never from a request field. A
client cannot send `budgetTracked` or `budgetExempt`.

Existing downstream calls to `orderTakesBudget` remain authoritative. Editing,
rejecting, cancelling, fulfilling or refunding the order must not create,
release, spend or credit a budget amount that the order never held. Audit
metadata records `budgetExemptionBasis: "ORDER_DESK"` so the absence of a
budget movement is explainable.

### D6 — Stock and catalogue assignments are different things

Every selected global product is locked inside the creation transaction. It
must still be active, not deleted and have sufficient global stock. Creation
decrements global stock; rejection/cancellation restores it; an edit moves
stock by the product-level difference exactly as today.

Ordering an unassigned product never creates or changes:

- `organization_inventory`;
- `branch_inventory`;
- group prices;
- organization prices;
- product visibility for the customer's own users.

This prevents an internal order-entry exception from silently changing the
tenant's shop.

### D7 — Pending approval and the rest of the lifecycle are unchanged

Every desk order remains `PENDING` for an Apricart Executive assigned to the
order's organization. The executive sees the entered tax-inclusive price and,
when one existed, the branch catalogue price beside it. Editing a pending order
continues to invalidate a stale approval through the existing `updatedAt`
conflict.

Payment controls, delivery blocking, delivery recording, fulfilment, refunds,
screenshots, intake channel/reference and notifications keep their current
rules. This plan introduces no approval, stock, payment or fulfilment bypass.

### D8 — Existing and rollback orders remain manageable

The edit form and server edit path must support both:

- older desk lines backed by `organizationInventoryId`; and
- new desk lines identified by `globalProductId`, including lines whose
  `organizationInventoryId` is null.

Once a direct-global line has been created, disabling the feature may stop new
such lines, but readers and lifecycle operations must retain compatibility.
Rollback must not drop null-backed lines from an edit or try to attach their
orders to a budget retroactively.

## 5. API and server work

### Catalogue

- Keep `requireApiRole(["ORDER_DESK"])`, rate limiting and private/no-store.
- Validate and fence `organizationId` and `branchId` through
  `isOrderDeskTarget` before querying products.
- Replace the branch-inventory-driven product set with a paginated active
  global-product query.
- Left join only the chosen target's active branch and organization inventory
  to calculate reference metadata; those joins never filter eligibility.
- Resolve a reference price only for a currently active and visible branch
  assignment.

### Creation

- Add a strict desk-global line schema beside the existing organization-
  inventory line schema.
- Normalize desk lines by `globalProductId`; keep every other role's normalized
  shape and behaviour unchanged.
- Skip budget pre-flight only after the desk target pre-check succeeds.
- Under the transaction's locked reach check, lock the named global products,
  revalidate status and stock, calculate tax-inclusive lines, write
  `budgetTracked: false`, decrement stock and persist snapshots.
- Include product ids and entered prices in the request fingerprint and audit.

### Editing

- Render null-organization-inventory lines instead of filtering them out.
- Key a desk edit draft and payload by `globalProductId`.
- Re-run active-product, quantity, price, tax and stock-delta checks in the
  transaction.
- Continue to require that the desk reaches the order's organization and
  branch. A product does not confer target reach.
- Use `orderTakesBudget(order)`: all new desk orders skip money and quantity
  budget movement during an edit.

### UI

- Keep organization → branch as the first required choice.
- After a target is chosen, show searchable/paginated Apricart products.
- Label normally assigned products and products outside the branch catalogue;
  the label is informational, not a disabled state.
- Require quantity and "Unit price including tax" for every selected line.
- Show the gross line total and order gross total without adding tax again.
- Preserve selected products across search and page changes.
- In the review step, state that the entered price includes tax and that the
  order does not consume the customer's budget.

## 6. Security and RBAC invariants

1. Super Admin remains the only role that grants Order Desk reach.
2. A desk user never gains a target from product visibility.
3. Catalogue, creation and edit each check the target against the current
   database assignment; creation repeats it under lock.
4. The branch must belong to the named organization at the database and query
   levels.
5. The global-product line shape and budget exemption are accepted only from a
   live `ORDER_DESK` account; request fields cannot opt into either.
6. Other roles retain branch-inventory product fencing and organization budget
   enforcement.
7. Strict validation rejects unknown fields, duplicate products and unbounded
   lists.
8. Catalogue and order responses expose customer/effective reference prices,
   never an unassigned product's global base price.
9. All existing proxy allowlist restrictions remain. No general global-product,
   inventory or budget endpoint is opened to the desk.

## 7. Files expected to change

| Area | Files |
|---|---|
| Pure contracts | `lib/order-desk-draft.ts`, `lib/order-line-price.ts`, a small desk product/budget policy helper if needed |
| Validation | `lib/server/mutation-validation.ts`, role-specific order-line validation in `app/api/v1/orders/route.ts` |
| Catalogue | `lib/server/order-desk-catalogue.ts`, `app/api/v1/order-desk/catalogue/route.ts` |
| Creation | `app/api/v1/orders/route.ts`, `lib/server/organization-budget-policy.ts` or a creator-aware wrapper |
| Editing | `lib/server/order-desk-edit.ts`, `app/api/v1/order-desk/orders/[id]/route.ts` |
| UI | `components/order-desk/new-desk-order.tsx`, `components/order-desk/desk-order-dialogs.tsx` |
| Reads/approval | `lib/server/order-desk-orders.ts`, executive approval line DTO/components if not already supplied by the entered-price work |
| Tests | focused unit, contract, component and integration suites listed below |

No new product-assignment or budget table is required. The entered-price
migration is the only schema prerequisite currently identified.

Before implementation, read the applicable Next.js 16.3.3 route-handler guide
from `node_modules/next/dist/docs/`, as required by `AGENTS.md`.

## 8. Test plan

### Reach and RBAC

- Whole-organization assignment sees every active branch of that managed
  organization and no other organization.
- Single-branch assignment sees the global catalogue only for that branch.
- Another branch of the same organization returns 403.
- Another organization, an unmanaged organization, inactive branch, inactive
  account and stale/mismatched assignment all return no reach.
- A non-desk role cannot send `globalProductId`, `unitPriceCents` or any budget
  exemption field through the ordinary order route.

### Catalogue

- An active global product appears whether branch-assigned or unassigned.
- Assigned product includes its effective reference price and assignment flag.
- Unassigned product has no customer catalogue reference price and does not
  expose the global base price.
- Inactive and deleted products do not appear.
- Search and pagination cover the full eligible set, and selected draft lines
  survive a page/search change.
- Reading the catalogue creates or updates no organization/branch inventory.

### Price and tax

- Every desk create/edit line requires a positive bounded integer-cent price.
- The price is treated as tax-inclusive: for representative tax rates,
  `net + tax = quantity × entered unit price` with the established rounding.
- Tax is not added to the entered total.
- A differing assigned-product price stores the entered price and reference
  catalogue price and exposes both to the executive.
- An unassigned product stores a null catalogue reference.
- Missing, zero, negative, decimal-cent and over-limit prices are refused.

### Creation and concurrency

- An unassigned active product can be ordered for an assigned target and writes
  `globalProductId`, product snapshots and a null
  `organizationInventoryId`.
- An assigned product retains its organization-inventory lineage.
- No catalogue assignment row is inserted or changed.
- Global stock is decremented; insufficient stock, deactivation or deletion
  before the transaction commits is refused.
- Removing the desk assignment or managed flag before the locked re-check
  refuses the order without stock, order or budget writes.
- Idempotent replay succeeds only for the same target, products, quantities and
  entered prices.

### Budgets

- At a budget-enabled organization with no current budget, a desk order
  succeeds and creates no budget row.
- With insufficient money budget, a desk order succeeds without changing held
  or spent amounts.
- In quantity mode with no allocation, every active global product remains
  orderable by the desk and no quantity hold is written.
- The order stores `budgetTracked = false`.
- Edit, rejection, cancellation, fulfilment and refund move no budget for that
  order.
- Equivalent non-desk orders retain every existing money and quantity budget
  refusal and ledger movement.

### Lifecycle and compatibility

- New null-inventory lines render in desk order details, executive approval,
  invoices, refunds and credit notes.
- Pending edits can retain, add and remove both assigned and unassigned global
  products with correct stock deltas.
- Reject/cancel restores global stock for null-inventory lines.
- Existing desk orders backed by organization inventory remain editable and
  otherwise unchanged.
- Lint, TypeScript, focused Sonar-sensitive rules and the existing Order Desk
  contract suite remain green.

## 9. Implementation sequence

1. Add pure request/catalogue types and role-specific validation tests.
2. Change the fenced catalogue query and add pagination/search tests.
3. Add desk-global normalization and transaction product locking to creation.
4. Add the creator-aware budget exemption and prove every later ledger path
   follows `budgetTracked = false`.
5. Convert desk edit and order DTOs to support global ids and null inventory.
6. Update the new-order and edit UI, including required tax-inclusive prices
   and selected-item persistence across search pages.
7. Add integration and end-to-end coverage for reach, global products, price,
   tax, stock and budget isolation.
8. Run focused tests, full typecheck and ESLint; resolve any new SonarQube or
   security findings before rollout.

## 10. Rollout and rollback

1. Apply `20261031120000_order_item_entered_price.sql` before deploying code
   that writes the entered-price columns.
2. Deploy readers and edit compatibility for null organization-inventory lines
   before enabling direct-global creation.
3. Deploy the catalogue and creation behaviour together so the UI never offers
   a product the server cannot persist.
4. Smoke-test with one whole-organization assignment and one branch-only
   assignment at a budget-enabled tenant.
5. Verify the created order is pending, tax-inclusive, stock-backed,
   `budget_tracked = false`, visible to the assigned executive and absent from
   budget consumption.

Rollback disables creation of new direct-global desk lines first. It must keep
the compatible readers and lifecycle handling for orders already created. Such
orders remain permanently budget-untracked; rollback must never manufacture a
historical hold or spend. No catalogue or business record is deleted.
