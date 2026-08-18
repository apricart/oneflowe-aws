/**
 * Shapes shared by the Group Order Portal workspace.
 *
 * The client keeps display fields (name, unit, price) alongside each selected
 * line purely so the running summary and the review step can be rendered
 * without another round trip. They are stripped before anything is sent: the
 * server re-prices every line from the database, so nothing here is ever
 * treated as authoritative.
 */

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

export type CatalogResponse = {
  items: CatalogItem[]
  total: number
  page: number
  limit: number
  excludedProductCount: number
  quantityBudgetActive: boolean
}

/** A line as held in the browser while the order is being built. */
export type SelectedLine = {
  organizationInventoryId: number
  quantity: number
  name: string
  unit: string
  priceCents: number
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
    fulfillmentStatus: string
    totalCents: number
    itemCount: number
    createdAt: string | null
    approvedAt: string | null
    rejectionReason: string | null
  }>
}

export type WizardStep = "group" | "branches" | "items" | "review"
