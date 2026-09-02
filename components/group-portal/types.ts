/**
 * Shapes shared by the Group Order Portal workspace.
 *
 * The client keeps display fields (name, unit, price) alongside each selected
 * line purely so the running summary and the review step can be rendered
 * without another round trip. They are stripped before anything is sent: the
 * server re-prices every line from the database, so nothing here is ever
 * treated as authoritative.
 */

import type { BranchBudgetSummary } from "@/lib/branch-budget-summary"

export type ScopedBranch = {
  id: number
  name: string
  city: string | null
  costCenterId: string | null
  groupId: number | null
}

export type ScopedGroup = {
  id: number | null
  name: string
  branches: ScopedBranch[]
}

/**
 * This month's money budget for one location.
 *
 * Re-exported from the module that derives it so the sidebar and the server
 * agree on the shape by construction. Display only, like every other figure
 * here: the ordering engine re-reads and locks the real budget row before it
 * accepts anything.
 */
export type { BranchBudgetSummary } from "@/lib/branch-budget-summary"

export type BranchBudgetResponse = {
  items: BranchBudgetSummary[]
  /** The `YYYY-MM` period the figures belong to. */
  period: string
}

export type CatalogItem = {
  organizationInventoryId: number
  globalProductId: number
  name: string
  productCode: string | null
  description: string | null
  imageUrl: string | null
  unit: string
  priceCents: number
  stockQuantity: number
  allowDecimalQuantity: boolean
  quantityStep: number | null
  categoryName: string | null
  quantityBudgetRemaining: number | null
}

/** One chip on the storefront's category ribbon. */
export type CatalogCategory = {
  id: number
  name: string
}

/** The orders the storefront offers; mirrors the catalogue endpoint's allowlist. */
export type CatalogSort = "name" | "price-low" | "price-high"

export type CatalogResponse = {
  items: CatalogItem[]
  total: number
  page: number
  limit: number
  excludedProductCount: number
  quantityBudgetActive: boolean
  categoryFacets: CatalogCategory[]
}

/**
 * A line as held in the browser while the order is being built.
 *
 * The quantity rules travel with the line so it can still be edited on the
 * review step, where the catalogue that produced it is no longer on screen.
 * They are optional because a resumed draft may predate them; the fallback is
 * whole numbers, which is the stricter of the two and never invents permission
 * the product does not have. The server re-validates every quantity regardless.
 */
export type SelectedLine = {
  organizationInventoryId: number
  quantity: number
  name: string
  unit: string
  priceCents: number
  allowDecimalQuantity?: boolean
  quantityStep?: number | null
}

/** One saved step: the branches it covers and the items chosen for them. */
export type GroupOrderEntry = {
  /** Client-only key so React can track entries across reordering and removal. */
  key: string
  branchIds: number[]
  lines: SelectedLine[]
}

/** The merged view: what one branch's order will actually contain. */
export type BranchPlan = {
  branch: ScopedBranch
  lines: SelectedLine[]
  totalCents: number
}

export type BranchResult =
  | {
    status: "created"
    branchId: number
    branchName: string
    orderId: number
    tid: string
    totalCents: number
    itemCount: number
  }
  | {
    status: "failed"
    branchId: number
    branchName: string
    reason: string
  }

export type GroupOrderSubmission = {
  id: number
  reference: string
  createdAt: string | null
  notes: string | null
  groupId: number | null
  groupName: string
  requestedBranchCount: number
  createdOrderCount: number
  results: BranchResult[]
  replayed: boolean
}

export type GroupOrderHistoryItem = {
  id: number
  reference: string
  createdAt: string | null
  notes: string | null
  groupId: number | null
  groupName: string
  requestedBranchCount: number
  createdOrderCount: number
  failures: Array<{ branchId: number; branchName: string; reason: string }>
  totalCents: number
  statusCounts: Record<string, number>
  orders: Array<{
    id: number
    tid: string
    branchId: number
    branchName: string
    status: string
    /** Set once refunded; decides whether a refunded row still offers its invoice. */
    statusAtRefund: string | null
    fulfillmentStatus: string
    totalCents: number
    itemCount: number
    createdAt: string | null
    approvedAt: string | null
    rejectionReason: string | null
    /** Server-gated: only ever set for an approved order this user raised. */
    approvalToken: string | null
  }>
}

/**
 * Refund shapes for the group refund workspace.
 *
 * As with the ordering flow, everything the browser holds here is for display
 * and arithmetic only. The server re-reads every order, re-derives every
 * remaining quantity, and re-prices every line at submission time, so a stale
 * or tampered payload can only ever be rejected — never honoured.
 */

export type RefundableLine = {
  orderItemId: number
  productName: string
  productCode: string | null
  unit: string | null
  globalProductId: number
  priceCents: number
  quantityOrdered: number
  /** Ordered minus everything already approved or still pending. */
  quantityRemaining: number
  allowDecimalQuantity: boolean
  quantityStep: number | null
}

export type RefundableOrder = {
  orderId: number
  tid: string
  branchId: number
  branchName: string
  status: string
  fulfillmentStatus: string
  totalCents: number
  /** Order total minus refunds already approved or pending against it. */
  remainingRefundableCents: number
  createdAt: string | null
  lines: RefundableLine[]
}

export type IneligibleOrder = {
  orderId: number
  tid: string
  branchId: number
  branchName: string
  status: string
  fulfillmentStatus: string
  reason: string
}

export type GroupRefundWorkspace = {
  groupOrder: {
    id: number
    reference: string
    groupName: string
    createdAt: string | null
  }
  refundable: RefundableOrder[]
  ineligible: IneligibleOrder[]
}

/** One line of a submitted request, as the server accepted it. */
export type GroupRefundOrderResult =
  | {
    status: "requested"
    orderId: number
    tid: string
    branchName: string
    refundId: number
    refundNumber: string | null
    amountCents: number
    itemCount: number
  }
  | {
    status: "skipped"
    orderId: number
    tid: string
    branchName: string
    reason: string
  }

export type GroupRefundSubmission = {
  reference: string
  requestedOrderCount: number
  skippedOrderCount: number
  totalAmountCents: number
  results: GroupRefundOrderResult[]
}

export type GroupRefundHistoryEntry = {
  refundId: number
  refundNumber: string | null
  status: string
  amountCents: number
  reason: string | null
  createdAt: string | null
  orderId: number
  tid: string
  branchId: number
  branchName: string
  items: Array<{
    orderItemId: number
    productName: string
    unit: string | null
    quantity: number
    amountCents: number
  }>
}

export type GroupRefundHistoryItem = {
  groupOrderId: number
  reference: string
  groupName: string
  createdAt: string | null
  totalAmountCents: number
  statusCounts: Record<string, number>
  refunds: GroupRefundHistoryEntry[]
}
