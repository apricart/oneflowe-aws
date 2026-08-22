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
import { generateNextInvoiceNumber, hasInvoiceSequenceTable } from "@/lib/invoice-number"
import { calculateLineCents, formatQuantity, roundQuantity, validateProductQuantity } from "@/lib/quantity"
import { generateReceiptData } from "@/lib/receipt-generator"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
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
  }

export type GroupOrderSubmission = {
  id: number
  reference: string
  createdAt: Date | null
  notes: string | null
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
  plans: BranchPlan[]
}): string {
  const canonical = {
    organizationId: input.organizationId,
    groupId: input.groupId,
    notes: input.notes || null,
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
  const message = String((caughtError as { message?: unknown })?.message ?? "")
  const normalized = message.toLowerCase()
  const isCustomerError = message.startsWith("Insufficient stock")
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
  inventoryById: Map<number, { id: number; globalProductId: number; customPrice: number | null }>
  productById: Map<number, {
    id: number
    name: string
    productCode: string | null
    unit: string
    basePrice: number
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

  return {
    inventoryById: new Map(inventory.map((row) => [row.id, row])),
    productById: new Map(products.map((row) => [row.id, row])),
  }
}

type PricedLine = {
  organizationInventoryId: number
  globalProductId: number
  quantity: number
  priceCents: number
  productName: string
  productCode: string | null
  unit: string
}

/** Price the locked rows. Prices always come from the database, never the request. */
function priceLockedLines(
  requested: Array<{ organizationInventoryId: number; quantity: number }>,
  locked: LockedCatalogue,
): { items: PricedLine[]; total: number } {
  let subtotal = 0
  const items = requested.map((line) => {
    const inventoryItem = locked.inventoryById.get(line.organizationInventoryId)
    if (!inventoryItem) throw new Error("An inventory item is no longer available")
    const product = locked.productById.get(inventoryItem.globalProductId)
    if (!product) throw new Error("A product is no longer available")

    const validation = validateProductQuantity(line.quantity, {
      allowDecimalQuantity: Boolean(product.allowDecimalQuantity),
      quantityStep: product.quantityStep ?? undefined,
      label: `Quantity for ${product.name}`,
    })
    if (!validation.ok) throw new Error(validation.error)

    const priceCents = inventoryItem.customPrice ?? product.basePrice
    if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
      throw new Error(`Pricing is unavailable for ${product.name}`)
    }
    subtotal += calculateLineCents(priceCents, validation.quantity)

    return {
      organizationInventoryId: inventoryItem.id,
      globalProductId: product.id,
      quantity: validation.quantity,
      priceCents,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
    }
  })

  if (!Number.isSafeInteger(subtotal) || subtotal < 0) {
    throw new Error("Calculated order total is invalid")
  }
  return { items, total: subtotal }
}

function assertStockAvailable(items: PricedLine[], locked: LockedCatalogue): void {
  for (const item of items) {
    const product = locked.productById.get(item.globalProductId)
    if (!product) throw new Error(`Product not found: ${item.productName}`)
    if (product.stockQuantity < item.quantity) {
      throw new Error(
        `Insufficient stock for ${product.name}. Available: ${formatQuantity(product.stockQuantity)}, Requested: ${formatQuantity(item.quantity)}`,
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
    budgetId: number
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
    total: number
    invoiceSequenceReady: boolean
  },
) {
  let receiptData: Awaited<ReturnType<typeof generateReceiptData>> | null = null
  try {
    receiptData = await generateReceiptData({
      orderId: context.orderId,
      orderTid: context.tid,
      status: "PENDING",
      organizationId: context.organizationId,
      branchId: context.branchId,
      orderItemsData: context.items,
      subtotalCents: context.total,
      taxCents: 0,
      totalCents: context.total,
      discountCents: 0,
      deliveryChargesCents: 0,
    })
  } catch (receiptError) {
    console.error("Receipt generation failed during group order creation", receiptError)
  }
  if (!receiptData) return

  receiptData.invoiceNumber = context.invoiceSequenceReady
    ? await generateNextInvoiceNumber(tx, context.organizationId)
    : context.tid
  await tx.update(orders).set({ receiptData: receiptData as never }).where(eq(orders.id, context.orderId))
}

type BranchCreationContext = {
  plan: BranchPlan
  organizationId: number
  groupOrderId: number
  reference: string
  notes: string | null
  period: string
  mode: string
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

async function createBranchOrder(context: BranchCreationContext): Promise<GroupOrderBranchResult> {
  const { plan, organizationId } = context
  const branchId = plan.branch.id
  const inventoryIds = plan.items.map((item) => item.organizationInventoryId)

  const budget = await getOrCreateBranchBudget(branchId, context.period)
  if (!budget) {
    return {
      status: "failed",
      branchId,
      branchName: plan.branch.name,
      reason: `Budget not configured for ${context.period}. Please contact head office to allocate budget for this branch.`,
    }
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [lockedBudget] = await tx
        .select()
        .from(budgets)
        .where(eq(budgets.id, budget.id))
        .for("update")
      if (!lockedBudget) throw new Error(`Budget not configured for ${context.period}`)

      const available = lockedBudget.amountAllocatedCents + lockedBudget.amountCreditedCents
        - lockedBudget.amountSpentCents - lockedBudget.amountHeldCents

      const locked = await lockBranchCatalogue(tx, { organizationId, branchId, inventoryIds })
      const priced = priceLockedLines(plan.items, locked)

      const shortfall = budgetShortfallMessage(priced.total, available)
      if (shortfall) throw new Error(shortfall)
      assertStockAvailable(priced.items, locked)

      const quantityBudgets = await lockQuantityBudgets(tx, {
        mode: context.mode,
        organizationId,
        branchId,
        period: context.period,
        items: priced.items,
      })

      const tid = generateTid()
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
          status: "PENDING",
          subtotalCents: priced.total,
          taxCents: 0,
          totalCents: priced.total,
          notes: context.notes,
          createdByUserId: context.actor.userId,
        })
        .returning({ id: orders.id, tid: orders.tid, totalCents: orders.totalCents })

      await tx.insert(orderItems).values(priced.items.map((item) => ({
        ...item,
        orderId: order.id,
        organizationId,
      })))

      await applyLedgerHolds(tx, {
        items: priced.items,
        budgetId: lockedBudget.id,
        total: priced.total,
        quantityBudgets,
      })

      await attachReceipt(tx, {
        orderId: order.id,
        tid,
        organizationId,
        branchId,
        items: priced.items,
        total: priced.total,
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
        },
        ipAddress: context.actor.ipAddress,
        userAgent: context.actor.userAgent,
        success: true,
      })

      return { order, itemCount: priced.items.length, total: priced.total }
    })

    return {
      status: "created",
      branchId,
      branchName: plan.branch.name,
      orderId: created.order.id,
      tid: created.order.tid,
      totalCents: created.total,
      itemCount: created.itemCount,
    }
  } catch (branchError) {
    return {
      status: "failed",
      branchId,
      branchName: plan.branch.name,
      reason: toUserFacingReason(branchError),
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

  const period = new Date().toISOString().slice(0, 7)
  const [mode, invoiceSequenceReady] = await Promise.all([
    getBudgetAllocationModeForOrganization(input.organizationId),
    hasInvoiceSequenceTable(db),
  ])
  const childNotes = buildChildOrderNotes(envelope.reference, input.notes)

  const results: GroupOrderBranchResult[] = []
  for (const plan of plans) {
    // Sequential on purpose: branch orders take row locks on shared product
    // stock, so running them in parallel would trade throughput for deadlocks.
    results.push(await createBranchOrder({
      plan,
      organizationId: input.organizationId,
      groupOrderId: envelope.id,
      reference: envelope.reference,
      notes: childNotes,
      period,
      mode,
      actor: input.actor,
      invoiceSequenceReady,
    }))
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

  return {
    ok: true,
    submission: {
      id: envelope.id,
      reference: envelope.reference,
      createdAt: envelope.createdAt,
      notes: envelope.notes,
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
    groupId: envelope.groupId,
    groupName: group?.name ?? UNGROUPED_BUCKET_NAME,
    requestedBranchCount: envelope.requestedBranchCount,
    createdOrderCount: envelope.createdOrderCount,
    results,
    replayed,
  }
}
