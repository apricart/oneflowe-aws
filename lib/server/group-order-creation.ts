import "server-only"

import { createHash, randomBytes } from "node:crypto"

import { and, eq, inArray, isNull, sql } from "drizzle-orm"

import {
  branchInventory,
  branches,
  budgets,
  globalProducts,
  groupAuditLogs,
  groupOrders,
  groups,
  orderItems,
  organizationInventory,
  orders,
  productQuantityBudgets,
  systemLogs,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  generateNextInvoiceNumber,
  hasInvoiceSequenceTable,
  lockInvoiceTenantForIssuance,
} from "@/lib/invoice-number"
import { calculateLineCents, formatQuantity, roundQuantity, validateProductQuantity } from "@/lib/quantity"
import { generateReceiptData } from "@/lib/receipt-generator"
import { resolveTaxRateBp, splitInclusiveCents } from "@/lib/tax"
import { getOrganizationTaxRateBp } from "@/lib/server/tax-rate"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { resolveInitialOrderApproval } from "@/lib/server/order-creation-approval"
import { isOrganizationBudgetEnabled, resolveOrderBudgetTracking } from "@/lib/server/organization-budget-policy"
import { BUDGET_POLICY_CHANGED_MESSAGE } from "@/lib/organization-budget-policy"
import { settleDueAddonsOnBudget } from "@/lib/server/budget-addon-expiry"
import { assertBranchMayOrder } from "@/lib/server/payment-control"
import { PAYMENT_CONTROL_BLOCKED_CODE, isPaymentControlBlockedError } from "@/lib/payment-control-policy"
import { assertBranchDeliveriesAcknowledged } from "@/lib/server/unacknowledged-delivery-block"
import {
  UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE,
  isDeliveryAcknowledgementBlockedError,
} from "@/lib/unacknowledged-delivery-block"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import {
  attemptImmediateOrderEmailDelivery,
  queueOrderCreatedNotifications,
  queueSuperAdminAutoApprovalNotifications,
} from "@/lib/server/order-notifications"
import {
  loadGroupPriceOverrides,
  resolveBranchGroupId,
  resolveEffectivePriceCents,
} from "@/lib/server/effective-price"
import {
  UNGROUPED_BUCKET_NAME,
  type ResolvedSubmissionScope,
  type ScopedBranch,
} from "@/lib/server/group-order-portal"

/**
 * Turns one Group Order Portal submission into one ordinary order per branch.
 *
 * Design contract, in order of importance:
 *
 *  1. **Nothing new reaches the rest of the system.** Each branch order is an
 *     ordinary `orders` row created with the same locks, budget holds, stock
 *     decrements, and receipt snapshot as a single-branch order. Approval,
 *     refund, and reporting paths see nothing unusual. The only addition is the
 *     nullable `groupOrderId` back-reference.
 *  2. **Branches are independent.** Each branch is created in its own
 *     transaction, so one branch running out of budget or stock cannot roll back
 *     the branches that already succeeded. Failures are collected with a
 *     user-correctable reason and reported back.
 *  3. **Branches are processed in ascending id order** so concurrent group
 *     submissions always take row locks in the same sequence and cannot
 *     deadlock against one another.
 */

/** One saved step of the wizard: a set of branches and the items chosen for them. */
export type GroupOrderEntry = {
  branchIds: number[]
  items: Array<{ organizationInventoryId: number; quantity: number }>
}

export type GroupOrderBranchResult =
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
    /** Present only when the branch was refused by an ordering block. */
    code?: typeof PAYMENT_CONTROL_BLOCKED_CODE | typeof UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE
    /** With PAYMENT_CONTROL_BLOCKED. */
    unpaidInvoiceCount?: number
    /** With UNACKNOWLEDGED_DELIVERIES_BLOCKED. */
    unacknowledgedDeliveryCount?: number
  }

export type GroupOrderSubmission = {
  id: number
  reference: string
  createdAt: Date | null
  notes: string | null
  poNumber: string | null
  groupId: number | null
  groupName: string
  requestedBranchCount: number
  createdOrderCount: number
  results: GroupOrderBranchResult[]
  replayed: boolean
}

type BranchPlan = {
  branch: ScopedBranch
  items: Array<{ organizationInventoryId: number; quantity: number }>
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Same shape as the single-branch portal: timestamp base36 + secure random hex. */
function generateTid(): string {
  return (Date.now().toString(36) + randomBytes(8).toString("hex")).slice(0, 26)
}

function generateGroupReference(): string {
  return `GRP-${randomBytes(5).toString("hex").toUpperCase()}`
}

/**
 * Collapse the wizard's entries into the order each branch will actually
 * receive. A branch appearing in several entries gets one order whose lines are
 * the summed quantities, which is what "keep adding to the same group order"
 * means to the user.
 */
export function mergeEntriesByBranch(
  entries: GroupOrderEntry[],
  branchesById: Map<number, ScopedBranch>,
): BranchPlan[] {
  const quantitiesByBranch = new Map<number, Map<number, number>>()

  for (const entry of entries) {
    for (const branchId of entry.branchIds) {
      const lines = quantitiesByBranch.get(branchId) ?? new Map<number, number>()
      for (const item of entry.items) {
        const merged = (lines.get(item.organizationInventoryId) ?? 0) + item.quantity
        lines.set(item.organizationInventoryId, roundQuantity(merged))
      }
      quantitiesByBranch.set(branchId, lines)
    }
  }

  return [...quantitiesByBranch.entries()]
    // Ascending branch id: a stable lock order across concurrent submissions.
    .sort(([left], [right]) => left - right)
    .flatMap(([branchId, lines]) => {
      const branch = branchesById.get(branchId)
      if (!branch || lines.size === 0) return []
      return [{
        branch,
        items: [...lines.entries()]
          .map(([organizationInventoryId, quantity]) => ({ organizationInventoryId, quantity }))
          .sort((left, right) => left.organizationInventoryId - right.organizationInventoryId),
      }]
    })
}

/**
 * Canonical digest of what was asked for. A replayed Idempotency-Key carrying a
 * different payload is rejected rather than silently returning someone else's
 * result.
 */
export function groupOrderFingerprint(input: {
  organizationId: number
  groupId: number | null
  notes: string | null
  poNumber: string | null
  plans: BranchPlan[]
}): string {
  const canonical = {
    organizationId: input.organizationId,
    groupId: input.groupId,
    notes: input.notes || null,
    poNumber: input.poNumber || null,
    branches: input.plans.map((plan) => ({
      branchId: plan.branch.id,
      items: plan.items,
    })),
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

/**
 * Messages that describe something the user can fix (budget, stock, an item
 * that was withdrawn). Anything else is reported generically so an internal
 * failure never leaks implementation detail into the portal.
 */
function toUserFacingReason(caughtError: unknown): string {
  if (isPaymentControlBlockedError(caughtError)) return caughtError.message
  if (isDeliveryAcknowledgementBlockedError(caughtError)) return caughtError.message
  const message = String((caughtError as { message?: unknown })?.message ?? "")
  const normalized = message.toLowerCase()
  const isCustomerError = message.startsWith("Insufficient stock")
    || message === BUDGET_POLICY_CHANGED_MESSAGE
    || message.startsWith("Budget not configured")
    || message.includes("Insufficient budget")
    || normalized.includes("quantity budget")
    || normalized.includes("negative state")
    || normalized.includes("no longer")
    || normalized.includes("pricing is unavailable")
    || normalized.includes("quantity for ")
  if (isCustomerError) return message

  console.error("Group order branch creation failed", caughtError)
  return "This branch could not be ordered for. Please try again or contact support."
}

function budgetShortfallMessage(total: number, available: number): string | null {
  if (available < 0) return "Budget is in negative state. Please contact head office."
  if (total <= available) return null
  return `Insufficient budget. Required: ${(total / 100).toFixed(2)} PKR, Available: ${(available / 100).toFixed(2)} PKR`
}

/**
 * The branch's money budget for the current period, created from the branch
 * baseline when absent — identical to how the single-branch portal behaves.
 */
async function getOrCreateBranchBudget(branchId: number, period: string) {
  const [existing] = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.branchId, branchId), eq(budgets.period, period)))
    .limit(1)
  if (existing) return existing

  const [branch] = await db
    .select({
      baselineBudgetCents: branches.baselineBudgetCents,
      organizationId: branches.organizationId,
    })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1)
  if (!branch?.baselineBudgetCents || branch.baselineBudgetCents <= 0) return null

  const [inserted] = await db
    .insert(budgets)
    .values({
      organizationId: branch.organizationId,
      branchId,
      period,
      amountAllocatedCents: branch.baselineBudgetCents,
      amountSpentCents: 0,
      amountHeldCents: 0,
      amountCreditedCents: 0,
    })
    .onConflictDoNothing()
    .returning()
  if (inserted) return inserted

  const [raced] = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.branchId, branchId), eq(budgets.period, period)))
    .limit(1)
  return raced ?? null
}

type LockedCatalogue = {
  /**
   * The group tier of the price ladder for the branch being priced, keyed by
   * `organization_inventory.id`. Empty for a branch that belongs to no group,
   * which leaves the organization price in force.
   */
  groupPriceByInventoryId: Map<number, number>
  inventoryById: Map<number, {
    id: number
    globalProductId: number
    customPrice: number | null
    /** The tenant's own name for the product, when it set one. */
    customName: string | null
  }>
  productById: Map<number, {
    id: number
    name: string
    productCode: string | null
    unit: string
    basePrice: number
    /** Basis points; NULL means the product follows the organization rate. */
    taxRateBp: number | null
    stockQuantity: number
    allowDecimalQuantity: boolean | null
    quantityStep: number | null
  }>
}

/**
 * Take row locks on everything the branch order will consume, and confirm every
 * requested item is still assigned to this branch. Locking before pricing is
 * what makes two concurrent orders for the same branch serialize.
 */
async function lockBranchCatalogue(
  tx: Transaction,
  context: { organizationId: number; branchId: number; inventoryIds: number[] },
): Promise<LockedCatalogue> {
  const assignments = await tx
    .select({ organizationInventoryId: branchInventory.organizationInventoryId })
    .from(branchInventory)
    .where(and(
      eq(branchInventory.branchId, context.branchId),
      eq(branchInventory.organizationId, context.organizationId),
      eq(branchInventory.isActive, true),
      eq(branchInventory.isVisible, true),
      isNull(branchInventory.deletedAt),
      inArray(branchInventory.organizationInventoryId, context.inventoryIds),
    ))
    .for("update")
  if (assignments.length !== context.inventoryIds.length) {
    throw new Error("Some items are no longer available for this branch")
  }

  const inventory = await tx
    .select({
      id: organizationInventory.id,
      globalProductId: organizationInventory.globalProductId,
      customPrice: organizationInventory.customPrice,
      customName: organizationInventory.customName,
    })
    .from(organizationInventory)
    .where(and(
      eq(organizationInventory.organizationId, context.organizationId),
      eq(organizationInventory.isActive, true),
      isNull(organizationInventory.deletedAt),
      inArray(organizationInventory.id, context.inventoryIds),
    ))
    .for("update")
  if (inventory.length !== context.inventoryIds.length) {
    throw new Error("Some items are no longer active for this organization")
  }

  const products = await tx
    .select({
      id: globalProducts.id,
      name: globalProducts.name,
      productCode: globalProducts.productCode,
      unit: globalProducts.unit,
      basePrice: globalProducts.basePrice,
      taxRateBp: globalProducts.taxRateBp,
      stockQuantity: globalProducts.stockQuantity,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
    })
    .from(globalProducts)
    .where(and(
      inArray(globalProducts.id, inventory.map((row) => row.globalProductId)),
      eq(globalProducts.status, "active"),
      isNull(globalProducts.deletedAt),
    ))
    .for("update")

  // Resolved from the branch inside this transaction rather than from the
  // submission scope, so a branch moved between groups while the submission was
  // in flight is priced by the group it actually belongs to now.
  const groupId = await resolveBranchGroupId(tx, {
    branchId: context.branchId,
    organizationId: context.organizationId,
  })
  const groupPriceByInventoryId = await loadGroupPriceOverrides(tx, {
    organizationId: context.organizationId,
    groupId,
    organizationInventoryIds: context.inventoryIds,
  })

  return {
    groupPriceByInventoryId,
    inventoryById: new Map(inventory.map((row) => [row.id, row])),
    productById: new Map(products.map((row) => [row.id, row])),
  }
}

type PricedLine = {
  organizationInventoryId: number
  globalProductId: number
  quantity: number
  priceCents: number
  taxRateBp: number
  taxCents: number
  productName: string
  productCode: string | null
  unit: string
}

/** Price the locked rows. Prices always come from the database, never the request. */
function priceLockedLines(
  requested: Array<{ organizationInventoryId: number; quantity: number }>,
  locked: LockedCatalogue,
  orgTaxRateBp: number,
): { items: PricedLine[]; subtotal: number; tax: number; total: number } {
  let subtotal = 0
  let tax = 0
  let total = 0
  const items = requested.map((line) => {
    const inventoryItem = locked.inventoryById.get(line.organizationInventoryId)
    if (!inventoryItem) throw new Error("An inventory item is no longer available")
    const product = locked.productById.get(inventoryItem.globalProductId)
    if (!product) throw new Error("A product is no longer available")

    // The catalogue and the price refresh both show the tenant's own name for a
    // product, so the order snapshot has to record that same name — otherwise
    // the line the user reviewed is filed under a different name on the order,
    // the receipt, and every refund screen that reads it back.
    const productName = inventoryItem.customName || product.name

    const validation = validateProductQuantity(line.quantity, {
      allowDecimalQuantity: Boolean(product.allowDecimalQuantity),
      quantityStep: product.quantityStep ?? undefined,
      label: `Quantity for ${productName}`,
      // The group portal's quantity control snaps to this same grid, so this
      // can only reject a payload that did not come from the workspace.
      enforceStep: true,
    })
    if (!validation.ok) throw new Error(validation.error)

    const priceCents = resolveEffectivePriceCents({
      groupPriceCents: locked.groupPriceByInventoryId.get(inventoryItem.id),
      organizationPriceCents: inventoryItem.customPrice,
      basePriceCents: product.basePrice,
    })
    if (priceCents === null || !Number.isSafeInteger(priceCents) || priceCents < 0) {
      throw new Error(`Pricing is unavailable for ${productName}`)
    }
    // Prices are tax-inclusive, so this split records how much of the gross
    // line amount is tax without changing what the branch is charged.
    const taxRateBp = resolveTaxRateBp(product.taxRateBp, orgTaxRateBp)
    const lineSplit = splitInclusiveCents(calculateLineCents(priceCents, validation.quantity), taxRateBp)
    subtotal += lineSplit.netCents
    tax += lineSplit.taxCents
    total += lineSplit.grossCents

    return {
      organizationInventoryId: inventoryItem.id,
      globalProductId: product.id,
      quantity: validation.quantity,
      priceCents,
      taxRateBp,
      taxCents: lineSplit.taxCents,
      productName,
      productCode: product.productCode,
      unit: product.unit,
    }
  })

  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Calculated order total is invalid")
  }
  return { items, subtotal, tax, total }
}

function assertStockAvailable(items: PricedLine[], locked: LockedCatalogue): void {
  for (const item of items) {
    const product = locked.productById.get(item.globalProductId)
    if (!product) throw new Error(`Product not found: ${item.productName}`)
    if (product.stockQuantity < item.quantity) {
      throw new Error(
        `Insufficient stock for ${item.productName}. Available: ${formatQuantity(product.stockQuantity)}, Requested: ${formatQuantity(item.quantity)}`,
      )
    }
  }
}

async function lockQuantityBudgets(
  tx: Transaction,
  context: {
    mode: string
    organizationId: number
    branchId: number
    period: string
    items: PricedLine[]
  },
) {
  if (context.mode !== "quantity") return new Map<number, { id: number }>()

  const rows = await tx
    .select()
    .from(productQuantityBudgets)
    .where(and(
      eq(productQuantityBudgets.organizationId, context.organizationId),
      eq(productQuantityBudgets.branchId, context.branchId),
      eq(productQuantityBudgets.period, context.period),
      sql`(${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}) > 0`,
      inArray(productQuantityBudgets.organizationInventoryId, context.items.map((item) => item.organizationInventoryId)),
    ))
    .for("update")

  const byInventory = new Map(rows.map((row) => [row.organizationInventoryId, row]))
  for (const item of context.items) {
    const allocation = byInventory.get(item.organizationInventoryId)
    if (!allocation) {
      throw new Error(`Quantity budget is not allocated for ${item.productName}. Please select an allocated product.`)
    }
    const remaining = allocation.allocatedQuantity + allocation.creditedQuantity
      - allocation.usedQuantity - allocation.heldQuantity
    if (remaining < 0) {
      throw new Error(`Quantity budget for ${item.productName} is in negative state. Please contact head office.`)
    }
    if (item.quantity > remaining) {
      throw new Error(
        `Insufficient quantity budget for ${item.productName}. Available: ${formatQuantity(remaining)}, Requested: ${formatQuantity(item.quantity)}`,
      )
    }
  }
  return byInventory
}

async function applyLedgerHolds(
  tx: Transaction,
  context: {
    items: PricedLine[]
    /** Null for an order of a tenant with budgets off: stock only, no hold. */
    budgetId: number | null
    total: number
    quantityBudgets: Map<number, { id: number }>
  },
) {
  for (const item of context.items) {
    await tx
      .update(globalProducts)
      .set({
        stockQuantity: sql`${globalProducts.stockQuantity} - ${item.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(globalProducts.id, item.globalProductId))
  }

  if (context.budgetId === null) return

  await tx
    .update(budgets)
    .set({ amountHeldCents: sql`${budgets.amountHeldCents} + ${context.total}` })
    .where(eq(budgets.id, context.budgetId))

  for (const item of context.items) {
    const allocation = context.quantityBudgets.get(item.organizationInventoryId)
    if (!allocation) continue
    await tx
      .update(productQuantityBudgets)
      .set({
        heldQuantity: sql`${productQuantityBudgets.heldQuantity} + ${item.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(productQuantityBudgets.id, allocation.id))
  }
}

async function attachReceipt(
  tx: Transaction,
  context: {
    orderId: number
    tid: string
    organizationId: number
    branchId: number
    items: PricedLine[]
    subtotal: number
    tax: number
    total: number
    status: "PENDING" | "APPROVED"
    poNumber: string | null
    invoiceSequenceReady: boolean
  },
) {
  const receiptData = await generateReceiptData({
    orderId: context.orderId,
    orderTid: context.tid,
    status: context.status,
    organizationId: context.organizationId,
    branchId: context.branchId,
    orderItemsData: context.items,
    subtotalCents: context.subtotal,
    taxCents: context.tax,
    totalCents: context.total,
    discountCents: 0,
    deliveryChargesCents: 0,
  })

  // The buyer's own reference, recorded with the invoice so a reissue prints
  // what was agreed rather than the invoice number over again.
  if (context.poNumber) receiptData.poNumber = context.poNumber
  if (context.invoiceSequenceReady) {
    receiptData.invoiceNumber = await generateNextInvoiceNumber(tx, context.organizationId)
  } else {
    await lockInvoiceTenantForIssuance(tx, context.organizationId)
    receiptData.invoiceNumber = context.tid
  }
  await tx.update(orders).set({ receiptData: receiptData as never }).where(eq(orders.id, context.orderId))
}

type BranchCreationContext = {
  plan: BranchPlan
  organizationId: number
  groupOrderId: number
  reference: string
  notes: string | null
  poNumber: string | null
  period: string
  mode: string
  /** The pre-flight's reading of the tenant's budget switch; the transaction re-reads it under lock. */
  budgetsEnabled: boolean
  actor: { userId: string; role: string; ipAddress: string; userAgent: string | null }
  invoiceSequenceReady: boolean
}

/**
 * Child orders carry their own idempotency key derived from the envelope, so a
 * retry of the same submission cannot double-create a branch order and the
 * `orders_creator_idempotency_uq` index stays satisfied for every sibling.
 */
function childIdempotencyKey(groupOrderId: number, branchId: number): string {
  return `grp-${groupOrderId}-b${branchId}`
}

/**
 * One branch's outcome, plus the notification events queued for it. The event
 * keys never reach the caller of the API — the submission delivers them once
 * every branch has committed.
 */
type BranchCreationOutcome = {
  result: GroupOrderBranchResult
  eventKeys: string[]
}

async function createBranchOrder(context: BranchCreationContext): Promise<BranchCreationOutcome> {
  const { plan, organizationId } = context
  const branchId = plan.branch.id
  const inventoryIds = plan.items.map((item) => item.organizationInventoryId)

  const orgTaxRateBp = await getOrganizationTaxRateBp(organizationId)
  // A tenant with budgets off needs no budget row; none is read or opened.
  const budget = context.budgetsEnabled ? await getOrCreateBranchBudget(branchId, context.period) : null
  if (context.budgetsEnabled && !budget) {
    return {
      result: {
        status: "failed",
        branchId,
        branchName: plan.branch.name,
        reason: `Budget not configured for ${context.period}. Please contact head office to allocate budget for this branch.`,
      },
      eventKeys: [],
    }
  }

  try {
    const created = await db.transaction(async (tx) => {
      // Per branch, because each branch commits on its own: a payment-blocked
      // branch is reported as failed and the others still go through.
      await assertBranchMayOrder(tx, { organizationId, branchId })
      await assertBranchDeliveriesAcknowledged(tx, { organizationId, branchId })
      // Read under the organization row's shared lock, as on the single-branch
      // path, and stored on the order for every later ledger move.
      const budgetTracked = await resolveOrderBudgetTracking(tx, organizationId)
      if (budgetTracked && !budget) throw new Error(BUDGET_POLICY_CHANGED_MESSAGE)

      let lockedBudget: typeof budgets.$inferSelect | null = null
      if (budgetTracked && budget) {
        // A due add-on is withdrawn under the row lock before the hold, so a
        // group submission cannot spend money that has expired.
        await settleDueAddonsOnBudget(tx, budget.id, new Date(), { actorUserId: context.actor.userId })
        const [lockedRow] = await tx
          .select()
          .from(budgets)
          .where(eq(budgets.id, budget.id))
          .for("update")
        if (!lockedRow) throw new Error(`Budget not configured for ${context.period}`)
        lockedBudget = lockedRow
      }

      const locked = await lockBranchCatalogue(tx, { organizationId, branchId, inventoryIds })
      const priced = priceLockedLines(plan.items, locked, orgTaxRateBp)

      if (lockedBudget) {
        const available = lockedBudget.amountAllocatedCents + lockedBudget.amountCreditedCents
          - lockedBudget.amountSpentCents - lockedBudget.amountHeldCents
        const shortfall = budgetShortfallMessage(priced.total, available)
        if (shortfall) throw new Error(shortfall)
      }
      assertStockAvailable(priced.items, locked)

      const quantityBudgets = budgetTracked
        ? await lockQuantityBudgets(tx, {
          mode: context.mode,
          organizationId,
          branchId,
          period: context.period,
          items: priced.items,
        })
        : new Map<number, { id: number }>()

      const tid = generateTid()
      const initialApproval = await resolveInitialOrderApproval(tx, organizationId)
      const [order] = await tx
        .insert(orders)
        .values({
          tid,
          idempotencyKey: childIdempotencyKey(context.groupOrderId, branchId),
          requestFingerprint: createHash("sha256")
            .update(JSON.stringify({ groupOrderId: context.groupOrderId, branchId, items: plan.items }))
            .digest("hex"),
          organizationId,
          branchId,
          groupOrderId: context.groupOrderId,
          ...initialApproval.values,
          subtotalCents: priced.subtotal,
          taxCents: priced.tax,
          totalCents: priced.total,
          notes: context.notes,
          poNumber: context.poNumber,
          createdByUserId: context.actor.userId,
          // Pinned at creation, as on the single-branch path. A group order is
          // an ordinary order of the branch's and is attributed the same way.
          createdByRole: context.actor.role,
          ...(budgetTracked ? {} : { budgetTracked: false }),
        })
        .returning({ id: orders.id, tid: orders.tid, totalCents: orders.totalCents })

      await tx.insert(orderItems).values(priced.items.map((item) => ({
        ...item,
        orderId: order.id,
        organizationId,
      })))

      await applyLedgerHolds(tx, {
        items: priced.items,
        budgetId: lockedBudget?.id ?? null,
        total: priced.total,
        quantityBudgets,
      })

      await attachReceipt(tx, {
        orderId: order.id,
        tid,
        organizationId,
        branchId,
        items: priced.items,
        subtotal: priced.subtotal,
        tax: priced.tax,
        total: priced.total,
        status: initialApproval.values.status,
        poNumber: context.poNumber,
        invoiceSequenceReady: context.invoiceSequenceReady,
      })

      await tx.insert(systemLogs).values({
        userId: context.actor.userId,
        userRole: context.actor.role,
        organizationId,
        branchId,
        action: "GROUP_ORDER_CREATE",
        resourceType: "order",
        resourceId: String(order.id),
        details: {
          tid,
          total: priced.total,
          items: priced.items.length,
          groupOrderId: context.groupOrderId,
          groupOrderReference: context.reference,
          autoApproved: !initialApproval.approvalRequired,
        },
        ipAddress: context.actor.ipAddress,
        userAgent: context.actor.userAgent,
        success: true,
      })

      // The approver has to learn about this order the same way it learns about
      // a single-branch one: a bell notification and an "awaiting approval"
      // email, addressed to the tenant's configured approver for this branch.
      // An order the tenant's policy approved at creation has no approver to
      // ask, so Super Admins are told it is ready for review instead.
      // Queued inside the branch's own transaction so an order and its event
      // are committed together, and never allowed to fail an order that is
      // otherwise complete — branches stay independent.
      let eventKeys: string[] = []
      const notificationOrder = {
        id: order.id,
        tid: order.tid,
        organizationId,
        branchId,
        createdByUserId: context.actor.userId,
      }
      try {
        const queued = initialApproval.approvalRequired
          ? await queueOrderCreatedNotifications(tx, {
            order: notificationOrder,
            requestedBy: "Group Order Portal user",
          })
          : await queueSuperAdminAutoApprovalNotifications(tx, { order: notificationOrder })
        eventKeys = queued.eventKeys
      } catch (notificationError) {
        console.error("Group order approval notification could not be queued", notificationError)
      }

      return { order, itemCount: priced.items.length, total: priced.total, eventKeys }
    })

    return {
      result: {
        status: "created",
        branchId,
        branchName: plan.branch.name,
        orderId: created.order.id,
        tid: created.order.tid,
        totalCents: created.total,
        itemCount: created.itemCount,
      },
      eventKeys: created.eventKeys,
    }
  } catch (branchError) {
    return {
      result: {
        status: "failed",
        branchId,
        branchName: plan.branch.name,
        reason: toUserFacingReason(branchError),
        ...(isPaymentControlBlockedError(branchError)
          ? { code: branchError.code, unpaidInvoiceCount: branchError.details.overdueCount }
          : {}),
        ...(isDeliveryAcknowledgementBlockedError(branchError)
          ? { code: branchError.code, unacknowledgedDeliveryCount: branchError.details.unacknowledgedCount }
          : {}),
      },
      eventKeys: [],
    }
  }
}

/** Compose the note stored on each branch order. */
function buildChildOrderNotes(reference: string, notes: string | null): string {
  const trailer = `Group order ${reference}`
  return (notes ? `${notes}\n${trailer}` : trailer).slice(0, 2_000)
}

export type CreateGroupOrderInput = {
  scope: ResolvedSubmissionScope
  organizationId: number
  entries: GroupOrderEntry[]
  notes: string | null
  poNumber: string | null
  idempotencyKey: string
  actor: { userId: string; role: string; ipAddress: string; userAgent: string | null }
}

export type CreateGroupOrderOutcome =
  | { ok: true; submission: GroupOrderSubmission }
  | { ok: false; message: string; status: number }

/**
 * Create the envelope and then every branch order beneath it.
 *
 * The envelope row is inserted first so a crash mid-way still leaves a
 * traceable record, and so the unique `(created_by_user_id, idempotency_key)`
 * index arbitrates between two concurrent submissions of the same key.
 */
export async function createGroupOrder(
  input: CreateGroupOrderInput,
): Promise<CreateGroupOrderOutcome> {
  const branchesById = new Map(input.scope.branches.map((branch) => [branch.id, branch]))
  const plans = mergeEntriesByBranch(input.entries, branchesById)
  if (plans.length === 0) {
    return { ok: false, message: "Add at least one product for at least one branch", status: 400 }
  }

  const fingerprint = groupOrderFingerprint({
    organizationId: input.organizationId,
    groupId: input.scope.group.id,
    notes: input.notes,
    poNumber: input.poNumber,
    plans,
  })

  const existing = await findSubmissionByIdempotencyKey(input.actor.userId, input.idempotencyKey)
  if (existing) {
    return existing.requestFingerprint === fingerprint
      ? { ok: true, submission: await describeSubmission(existing, true) }
      : { ok: false, message: "Idempotency key was already used for a different group order", status: 409 }
  }

  let envelope: typeof groupOrders.$inferSelect
  try {
    const [inserted] = await db
      .insert(groupOrders)
      .values({
        reference: generateGroupReference(),
        organizationId: input.organizationId,
        groupId: input.scope.group.id,
        createdByUserId: input.actor.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        notes: input.notes,
        poNumber: input.poNumber,
        requestedBranchCount: plans.length,
      })
      .returning()
    envelope = inserted
  } catch (insertError) {
    // A concurrent request with the same key won the unique index; replay it
    // instead of creating a second set of branch orders.
    const raced = await findSubmissionByIdempotencyKey(input.actor.userId, input.idempotencyKey)
    if (raced && raced.requestFingerprint === fingerprint) {
      return { ok: true, submission: await describeSubmission(raced, true) }
    }
    if (raced) {
      return { ok: false, message: "Idempotency key was already used for a different group order", status: 409 }
    }
    throw insertError
  }

  const period = budgetPeriodOf(new Date())
  const [mode, invoiceSequenceReady, budgetsEnabled] = await Promise.all([
    getBudgetAllocationModeForOrganization(input.organizationId),
    hasInvoiceSequenceTable(db),
    isOrganizationBudgetEnabled(input.organizationId),
  ])
  const childNotes = buildChildOrderNotes(envelope.reference, input.notes)

  const results: GroupOrderBranchResult[] = []
  const notificationEventKeys: string[] = []
  for (const plan of plans) {
    // Sequential on purpose: branch orders take row locks on shared product
    // stock, so running them in parallel would trade throughput for deadlocks.
    const outcome = await createBranchOrder({
      plan,
      organizationId: input.organizationId,
      groupOrderId: envelope.id,
      reference: envelope.reference,
      notes: childNotes,
      poNumber: envelope.poNumber,
      period,
      mode,
      budgetsEnabled,
      actor: input.actor,
      invoiceSequenceReady,
    })
    results.push(outcome.result)
    notificationEventKeys.push(...outcome.eventKeys)
  }

  const failures = results
    .filter((result): result is Extract<GroupOrderBranchResult, { status: "failed" }> => result.status === "failed")
    .map((result) => ({ branchId: result.branchId, branchName: result.branchName, reason: result.reason }))
  const createdOrderCount = results.length - failures.length

  await db
    .update(groupOrders)
    .set({ createdOrderCount, failures })
    .where(eq(groupOrders.id, envelope.id))

  await recordGroupAudit({
    organizationId: input.organizationId,
    groupId: input.scope.group.id,
    actor: input.actor,
    reference: envelope.reference,
    requestedBranchCount: plans.length,
    createdOrderCount,
  })

  // Best-effort first delivery, exactly as the single-branch endpoint does. The
  // events are already committed, so anything not sent here is picked up by the
  // outbox processor rather than lost.
  await attemptImmediateOrderEmailDelivery(notificationEventKeys)

  return {
    ok: true,
    submission: {
      id: envelope.id,
      reference: envelope.reference,
      createdAt: envelope.createdAt,
      notes: envelope.notes,
      poNumber: envelope.poNumber,
      groupId: input.scope.group.id,
      groupName: input.scope.group.name,
      requestedBranchCount: plans.length,
      createdOrderCount,
      results,
      replayed: false,
    },
  }
}

async function recordGroupAudit(input: {
  organizationId: number
  groupId: number | null
  actor: { userId: string; role: string }
  reference: string
  requestedBranchCount: number
  createdOrderCount: number
}): Promise<void> {
  try {
    await db.insert(groupAuditLogs).values({
      organizationId: input.organizationId,
      groupId: input.groupId,
      action: "CREATE_GROUP_ORDER",
      performedByUserId: input.actor.userId,
      performedByRole: input.actor.role,
      metadata: {
        reference: input.reference,
        requestedBranchCount: input.requestedBranchCount,
        createdOrderCount: input.createdOrderCount,
      },
    })
  } catch (auditError) {
    // Auditing must never fail a submission that already created orders.
    console.error("Group order audit log failed", auditError)
  }
}

async function findSubmissionByIdempotencyKey(userId: string, idempotencyKey: string) {
  const [row] = await db
    .select()
    .from(groupOrders)
    .where(and(
      eq(groupOrders.createdByUserId, userId),
      eq(groupOrders.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
  return row ?? null
}

/**
 * Rebuild the per-branch outcome of a stored submission from its child orders
 * plus the recorded failures, so a replay tells the user exactly what a fresh
 * submission would have.
 */
async function describeSubmission(
  envelope: typeof groupOrders.$inferSelect,
  replayed: boolean,
): Promise<GroupOrderSubmission> {
  const childOrders = await db
    .select({
      orderId: orders.id,
      tid: orders.tid,
      branchId: orders.branchId,
      branchName: branches.name,
      totalCents: orders.totalCents,
      itemCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id}
      )`.mapWith(Number),
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(
      eq(orders.groupOrderId, envelope.id),
      eq(orders.organizationId, envelope.organizationId),
    ))
    .orderBy(orders.branchId)

  const [group] = envelope.groupId
    ? await db
      .select({ name: groups.name })
      .from(groups)
      .where(and(
        eq(groups.id, envelope.groupId),
        eq(groups.organizationId, envelope.organizationId),
      ))
      .limit(1)
    : [null]

  const results: GroupOrderBranchResult[] = [
    ...childOrders.map((row): GroupOrderBranchResult => ({
      status: "created",
      branchId: row.branchId,
      branchName: row.branchName ?? `Branch ${row.branchId}`,
      orderId: row.orderId,
      tid: row.tid,
      totalCents: row.totalCents,
      itemCount: row.itemCount,
    })),
    ...(envelope.failures ?? []).map((failure): GroupOrderBranchResult => ({
      status: "failed",
      branchId: failure.branchId,
      branchName: failure.branchName,
      reason: failure.reason,
    })),
  ]

  return {
    id: envelope.id,
    reference: envelope.reference,
    createdAt: envelope.createdAt,
    notes: envelope.notes,
    poNumber: envelope.poNumber,
    groupId: envelope.groupId,
    groupName: group?.name ?? UNGROUPED_BUCKET_NAME,
    requestedBranchCount: envelope.requestedBranchCount,
    createdOrderCount: envelope.createdOrderCount,
    results,
    replayed,
  }
}
