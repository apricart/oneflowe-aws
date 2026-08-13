import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"

import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { calculateLineCents, formatQuantity, parseQuantity, validateProductQuantity } from "@/lib/quantity"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { buildAppMonthPeriods, getAppMonthPeriod, parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import {
  auditLogs,
  branchInventory,
  branches,
  budgetAddons,
  budgets,
  globalProducts,
  organizationInventory,
  productQuantityBudgetAllocations,
  productQuantityBudgets,
} from "@/db/schema"
import {
  quantityBudgetAllocationSchema,
  quantityBudgetResetSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"

type AllocationType = "addon" | "monthly"

interface QuantityAllocationRequestItem {
  branchInventoryId: number
  quantity: number
}

const currentBudgetPeriod = () => new Date().toISOString().slice(0, 7)
const periodPattern = /^\d{4}-\d{2}$/

const isPositiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0

const parseNumberList = (value: string | null) =>
  value
    ? value.split(",").map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : []

function resolveQuantityBudgetOrganizationId(role: string, userOrganizationId: number | undefined, requestedOrganizationId: number) {
  if (role === "HEAD_OFFICE") return userOrganizationId
  return Number.isInteger(requestedOrganizationId) && requestedOrganizationId > 0 ? requestedOrganizationId : undefined
}

async function resolveQuantityBudgetPeriods(context: any) {
  if (context.period && periodPattern.test(context.period)) return [context.period]
  const requestedStart = parseStartDateParam(context.startDate)
  const end = parseEndDateParam(context.endDate) || new Date()
  let start = requestedStart
  if (context.preset === "all") {
    const [first] = await db.select({ period: productQuantityBudgets.period }).from(productQuantityBudgets)
      .where(eq(productQuantityBudgets.organizationId, context.organizationId)).orderBy(productQuantityBudgets.period).limit(1)
    start = new Date(`${first?.period || currentBudgetPeriod()}-01T00:00:00.000Z`)
  } else start ??= new Date(`${currentBudgetPeriod()}-01T00:00:00.000Z`)
  if (!context.startDate) start.setHours(0, 0, 0, 0)
  if (!context.endDate) end.setHours(23, 59, 59, 999)
  if (["today", "3d", "7d", "monthly", "thisMonth"].includes(context.preset)) return [getAppMonthPeriod(end)]
  const periods = buildAppMonthPeriods(start, end, context.months, context.years)
  return periods.length > 0 ? periods : [currentBudgetPeriod()]
}

function summarizeQuantityProducts(rows: any[]) {
  const byKey = new Map<string, any>()
  rows.forEach((row) => {
    const key = `${row.branchId}:${row.organizationInventoryId}`
    const existing = byKey.get(key) || {
      quantityBudgetId: row.quantityBudgetId,
      organizationId: row.organizationId,
      branchId: row.branchId,
      organizationInventoryId: row.organizationInventoryId,
      globalProductId: row.globalProductId,
      productCode: row.productCode,
      productName: row.customName || row.globalProductName || `Product ${row.globalProductId}`,
      unit: row.unit,
      baseQuantity: 0,
      addonQuantity: 0,
      totalQuantity: 0,
      spentQuantity: 0,
      remainingQuantity: 0,
    }
    existing.baseQuantity += row.baseQuantity
    existing.addonQuantity += row.addonQuantity
    existing.totalQuantity = existing.baseQuantity + existing.addonQuantity
    existing.spentQuantity += row.usedQuantity + row.heldQuantity
    existing.remainingQuantity = existing.totalQuantity - existing.spentQuantity
    byKey.set(key, existing)
  })
  return [...byKey.values()]
}

function summarizeQuantityBranches(products: any[]) {
  const byId = new Map<number, any>()
  products.forEach((product) => {
    const summary = byId.get(product.branchId) || {
      branchId: product.branchId, baseQuantity: 0, addonQuantity: 0, totalQuantity: 0,
      spentQuantity: 0, remainingQuantity: 0, productCount: 0,
    }
    summary.baseQuantity += product.baseQuantity
    summary.addonQuantity += product.addonQuantity
    summary.totalQuantity += product.totalQuantity
    summary.spentQuantity += product.spentQuantity
    summary.remainingQuantity += product.remainingQuantity
    summary.productCount++
    byId.set(product.branchId, summary)
  })
  return [...byId.values()]
}

function validateQuantityAllocationItems(items: QuantityAllocationRequestItem[]) {
  if (items.length === 0) return "At least one product quantity allocation is required"
  if (items.length > 100) return "Too many allocation lines in one request"
  for (const item of items) {
    if (!isPositiveId(item.branchInventoryId)) return "Each item requires a valid branchInventoryId"
    const quantity = parseQuantity(item.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) return "Each quantity must be a positive number"
    item.quantity = quantity
  }
  const ids = items.map((item) => item.branchInventoryId)
  return new Set(ids).size === ids.length ? null : "Each product can only appear once in a quantity allocation"
}

function buildQuantityAllocationLines(products: any[], items: QuantityAllocationRequestItem[]) {
  const quantities = new Map(items.map((item) => [item.branchInventoryId, item.quantity]))
  return products.map((product) => {
    const quantity = quantities.get(product.branchInventoryId) || 0
    const priceCents = product.customPrice ?? product.basePrice
    if (!Number.isFinite(priceCents) || priceCents <= 0) throw new Error(`Pricing is unavailable for ${product.customName || product.productName}`)
    const validation = validateProductQuantity(quantity, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.customName || product.productName}`,
    })
    if (!validation.ok) throw new Error(validation.error)
    return { ...product, quantity: validation.quantity, priceCents, amountCents: calculateLineCents(priceCents, validation.quantity) }
  })
}

function getMonthlyBaselineAmount(lines: any[], existingRows: any[], allocationType: AllocationType, totalAmount: number) {
  if (allocationType !== "monthly") return totalAmount
  const selected = new Map(lines.map((line) => [line.organizationInventoryId, line.amountCents]))
  const existing = new Map(existingRows.map((row) => [row.organizationInventoryId, row]))
  const ids = new Set([...existingRows.map((row) => row.organizationInventoryId), ...lines.map((line) => line.organizationInventoryId)])
  return [...ids].reduce((total, id) => total + (selected.get(id) ?? existing.get(id)?.amountAllocatedCents ?? 0), 0)
}

function validateQuantityBudgetSession(session: any) {
  if (!session?.user) return { error: "Unauthorized", status: 401 }
  const role = session.user.role
  const rawOrganizationId = session.user.organizationId
  const organizationId = Number.isFinite(Number(rawOrganizationId)) ? Number(rawOrganizationId) : undefined
  if (!["HEAD_OFFICE", "SUPER_ADMIN"].includes(role)) return { error: "Forbidden", status: 403 }
  if (role === "HEAD_OFFICE" && !organizationId) return { error: "Organization context required", status: 400 }
  return { role, organizationId, userId: session.user.id }
}

function getQuantityResetErrorResponse(caughtError: any) {
  if (caughtError?.message === "QUANTITY_BUDGET_RESET_HAS_COMMITMENTS") {
    return NextResponse.json({ error: "Cannot reset quantity budgets while orders are held or spent in the selected period" }, { status: 409 })
  }
  return NextResponse.json({ error: "Failed to reset quantity budgets" }, { status: 500 })
}

function validateAllocationTotal(totalAmountCents: number) {
  if (!Number.isSafeInteger(totalAmountCents) || totalAmountCents < 0) return "Calculated allocation amount is invalid"
  if (totalAmountCents > Number.MAX_SAFE_INTEGER / 2) return "Allocation amount exceeds maximum allowed value"
  return null
}

function getQuantityAllocationErrorResponse(caughtError: any) {
  const message = caughtError?.message || "Internal Server Error"
  const isValidationError = message.startsWith("Validation Failed")
    || message.includes("cannot be lower")
    || message.includes("Pricing is unavailable")
  return NextResponse.json({ error: isValidationError ? message : "Internal Server Error" }, { status: isValidationError ? 400 : 500 })
}

async function upsertQuantityBudgetLine(tx: any, context: any) {
  const existing = context.existingByInventoryId.get(context.line.organizationInventoryId)
  const usedOrHeld = (existing?.usedQuantity || 0) + (existing?.heldQuantity || 0)
  const proposedTotal = context.type === "monthly"
    ? context.line.quantity + (existing?.creditedQuantity || 0)
    : (existing?.allocatedQuantity || 0) + (existing?.creditedQuantity || 0) + context.line.quantity
  if (proposedTotal < usedOrHeld) {
    throw new Error(`Quantity allocation for ${context.line.customName || context.line.productName} cannot be lower than already used or held quantity (${formatQuantity(usedOrHeld)}).`)
  }
  const [quantityBudget] = await tx.insert(productQuantityBudgets).values({
    organizationId: context.branch.organizationId,
    branchId: context.branch.id,
    organizationInventoryId: context.line.organizationInventoryId,
    globalProductId: context.line.globalProductId,
    period: context.period,
    allocatedQuantity: context.type === "monthly" ? context.line.quantity : 0,
    creditedQuantity: context.type === "addon" ? context.line.quantity : 0,
    amountAllocatedCents: context.type === "monthly" ? context.line.amountCents : 0,
    amountCreditedCents: context.type === "addon" ? context.line.amountCents : 0,
    createdByUserId: context.userId,
    updatedByUserId: context.userId,
  }).onConflictDoUpdate({
    target: [productQuantityBudgets.branchId, productQuantityBudgets.organizationInventoryId, productQuantityBudgets.period],
    set: context.type === "monthly" ? {
      allocatedQuantity: context.line.quantity,
      amountAllocatedCents: context.line.amountCents,
      globalProductId: context.line.globalProductId,
      updatedByUserId: context.userId,
      updatedAt: new Date(),
    } : {
      creditedQuantity: sql`${productQuantityBudgets.creditedQuantity} + ${context.line.quantity}`,
      amountCreditedCents: sql`${productQuantityBudgets.amountCreditedCents} + ${context.line.amountCents}`,
      globalProductId: context.line.globalProductId,
      updatedByUserId: context.userId,
      updatedAt: new Date(),
    },
  }).returning()
  await tx.insert(productQuantityBudgetAllocations).values({
    quantityBudgetId: quantityBudget.id,
    budgetId: context.moneyBudget.id,
    organizationId: context.branch.organizationId,
    branchId: context.branch.id,
    organizationInventoryId: context.line.organizationInventoryId,
    globalProductId: context.line.globalProductId,
    period: context.period,
    allocationType: context.type,
    quantity: context.line.quantity,
    priceCents: context.line.priceCents,
    amountCents: context.line.amountCents,
    createdByUserId: context.userId,
    metadata: {
      branchInventoryId: context.line.branchInventoryId,
      productName: context.line.customName || context.line.productName,
      productCode: context.line.productCode,
      unit: context.line.unit,
    },
  })
  return quantityBudget
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const role = (session.user as any).role
    const rawUserOrgId = (session.user as any).organizationId
    const userOrgId = Number.isFinite(Number(rawUserOrgId)) ? Number(rawUserOrgId) : undefined

    if (role !== "HEAD_OFFICE" && role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    if (role === "HEAD_OFFICE" && !userOrgId) {
      return NextResponse.json({ error: "Organization context required" }, { status: 400 })
    }

    const { searchParams } = new URL(req.url)
    const requestedOrgId = Number(searchParams.get("organizationId"))
    const periodParam = searchParams.get("period")
    const startDateParam = searchParams.get("startDate")
    const endDateParam = searchParams.get("endDate")
    const monthsParam = searchParams.get("months")
    const yearsParam = searchParams.get("years")
    const presetParam = searchParams.get("preset") || ""

    if (searchParams.get("organizationId") && (!Number.isInteger(requestedOrgId) || requestedOrgId <= 0)) {
      return NextResponse.json({ error: "Invalid organization ID" }, { status: 400 })
    }

    const scopedOrganizationId = resolveQuantityBudgetOrganizationId(role, userOrgId, requestedOrgId)

    if (!scopedOrganizationId) {
      return NextResponse.json({ error: "Select an organization to view quantity budgets" }, { status: 400 })
    }

    const budgetAllocationMode = await getBudgetAllocationModeForOrganization(scopedOrganizationId)
    if (budgetAllocationMode !== "quantity") {
      return NextResponse.json({ error: "This organization uses money-value budgeting" }, { status: 403 })
    }

    const groupIds = parseNumberList(searchParams.get("groupIds"))
    const branchIds = parseNumberList(searchParams.get("branchIds"))
    const parsedMonths = parseNumberList(monthsParam)
      .filter((month) => month >= 1 && month <= 12)
    const parsedYears = parseNumberList(yearsParam)
      .filter((year) => year >= 2000 && year <= 2100)

    const periodList = await resolveQuantityBudgetPeriods({
      period: periodParam,
      startDate: startDateParam,
      endDate: endDateParam,
      preset: presetParam,
      months: parsedMonths,
      years: parsedYears,
      organizationId: scopedOrganizationId,
    })

    const quantityRows = await db
      .select({
        quantityBudgetId: productQuantityBudgets.id,
        organizationId: productQuantityBudgets.organizationId,
        branchId: productQuantityBudgets.branchId,
        organizationInventoryId: productQuantityBudgets.organizationInventoryId,
        globalProductId: productQuantityBudgets.globalProductId,
        productCode: globalProducts.productCode,
        globalProductName: globalProducts.name,
        customName: organizationInventory.customName,
        unit: globalProducts.unit,
        baseQuantity: productQuantityBudgets.allocatedQuantity,
        addonQuantity: productQuantityBudgets.creditedQuantity,
        heldQuantity: productQuantityBudgets.heldQuantity,
        usedQuantity: productQuantityBudgets.usedQuantity,
      })
      .from(productQuantityBudgets)
      .innerJoin(
        branches,
        and(
          eq(productQuantityBudgets.branchId, branches.id),
          eq(productQuantityBudgets.organizationId, branches.organizationId),
        )
      )
      .leftJoin(organizationInventory, eq(productQuantityBudgets.organizationInventoryId, organizationInventory.id))
      .leftJoin(globalProducts, eq(productQuantityBudgets.globalProductId, globalProducts.id))
      .where(and(
        inArray(productQuantityBudgets.period, periodList),
        eq(branches.status, "active"),
        scopedOrganizationId ? eq(productQuantityBudgets.organizationId, scopedOrganizationId) : undefined,
        groupIds.length > 0 ? inArray(branches.groupId, groupIds) : undefined,
        branchIds.length > 0 ? inArray(productQuantityBudgets.branchId, branchIds) : undefined,
      ))

    const products = summarizeQuantityProducts(quantityRows)

    return NextResponse.json({
      period: periodList.length === 1 ? periodList[0] : undefined,
      periods: periodList,
      branches: summarizeQuantityBranches(products),
      products,
    })
  } catch (error: any) {
    console.error("[BudgetQuantity] Quantity summary fetch failed:", error)
    return NextResponse.json({ error: "Failed to fetch quantity budgets" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const access = validateQuantityBudgetSession(session)
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })
    const { role, userId, organizationId: userOrgId } = access

    const rawBody = await req.json().catch(() => ({}))
    const parsedBody = quantityBudgetResetSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const body = parsedBody.data

    const requestedOrgId = Number(body.organizationId)
    if (body.organizationId !== undefined && (!Number.isInteger(requestedOrgId) || requestedOrgId <= 0)) {
      return NextResponse.json({ error: "Invalid organization ID" }, { status: 400 })
    }

    const scopedOrganizationId = resolveQuantityBudgetOrganizationId(role, userOrgId, requestedOrgId)

    if (!scopedOrganizationId) {
      return NextResponse.json({ error: "Select an organization before resetting quantity budgets" }, { status: 400 })
    }

    const budgetAllocationMode = await getBudgetAllocationModeForOrganization(scopedOrganizationId)
    if (budgetAllocationMode !== "quantity") {
      return NextResponse.json({ error: "This organization uses money-value budgeting" }, { status: 403 })
    }

    const requestedBranchIds = body.branchIds ?? []
    const requestedGroupIds = body.groupIds ?? []
    const period = body.period && periodPattern.test(body.period)
      ? body.period
      : currentBudgetPeriod()

    const scopedBranches = await db
      .select({
        id: branches.id,
        name: branches.name,
      })
      .from(branches)
      .where(and(
        eq(branches.organizationId, scopedOrganizationId),
        eq(branches.status, "active"),
        requestedBranchIds.length > 0 ? inArray(branches.id, requestedBranchIds) : undefined,
        requestedGroupIds.length > 0 ? inArray(branches.groupId, requestedGroupIds) : undefined,
      ))

    if (scopedBranches.length === 0) {
      return NextResponse.json({
        message: "No active branches matched the current quantity budget view",
        reset: { branchCount: 0, period },
      })
    }

    const scopedBranchIds = scopedBranches.map((branch) => branch.id)

    const result = await db.transaction(async (tx) => {
      const lockedMoneyBudgets = await tx
        .select({
          amountSpentCents: budgets.amountSpentCents,
          amountHeldCents: budgets.amountHeldCents,
        })
        .from(budgets)
        .where(and(
          eq(budgets.organizationId, scopedOrganizationId),
          eq(budgets.period, period),
          inArray(budgets.branchId, scopedBranchIds),
        ))
        .for('update')

      const lockedQuantityBudgets = await tx
        .select({
          heldQuantity: productQuantityBudgets.heldQuantity,
          usedQuantity: productQuantityBudgets.usedQuantity,
        })
        .from(productQuantityBudgets)
        .where(and(
          eq(productQuantityBudgets.organizationId, scopedOrganizationId),
          eq(productQuantityBudgets.period, period),
          inArray(productQuantityBudgets.branchId, scopedBranchIds),
        ))
        .for('update')

      const hasCommittedUsage = lockedMoneyBudgets.some((budget) =>
        Number(budget.amountSpentCents || 0) > 0 || Number(budget.amountHeldCents || 0) > 0
      ) || lockedQuantityBudgets.some((budget) =>
        Number(budget.heldQuantity || 0) > 0 || Number(budget.usedQuantity || 0) > 0
      )

      if (hasCommittedUsage) throw new Error("QUANTITY_BUDGET_RESET_HAS_COMMITMENTS")

      await tx
        .update(productQuantityBudgets)
        .set({
          allocatedQuantity: 0,
          creditedQuantity: 0,
          heldQuantity: 0,
          usedQuantity: 0,
          amountAllocatedCents: 0,
          amountCreditedCents: 0,
          updatedByUserId: userId,
          updatedAt: new Date(),
        })
        .where(and(
          eq(productQuantityBudgets.organizationId, scopedOrganizationId),
          eq(productQuantityBudgets.period, period),
          inArray(productQuantityBudgets.branchId, scopedBranchIds),
        ))

      await tx
        .update(budgets)
        .set({
          amountAllocatedCents: 0,
          amountCreditedCents: 0,
          amountSpentCents: 0,
          amountHeldCents: 0,
          updatedAt: new Date(),
        })
        .where(and(
          eq(budgets.organizationId, scopedOrganizationId),
          eq(budgets.period, period),
          inArray(budgets.branchId, scopedBranchIds),
        ))

      await tx
        .update(branches)
        .set({
          baselineBudgetCents: 0,
          updatedAt: new Date(),
        })
        .where(and(
          eq(branches.organizationId, scopedOrganizationId),
          inArray(branches.id, scopedBranchIds),
        ))

      await tx.insert(auditLogs).values({
        userId,
        organizationId: scopedOrganizationId,
        action: "RESET_ALL_QUANTITY_BUDGETS",
        entity: "PRODUCT_QUANTITY_BUDGET",
        entityId: String(scopedOrganizationId),
        metadata: {
          period,
          branchCount: scopedBranchIds.length,
          branchIds: scopedBranchIds,
          groupIds: requestedGroupIds,
          resetMoneyBudgetView: true,
        },
      })

      return {
        branchCount: scopedBranchIds.length,
      }
    })

    return NextResponse.json({
      message: "Quantity budgets reset successfully",
      reset: {
        period,
        branchCount: result.branchCount,
      },
    })
  } catch (error: any) {
    console.error("[BudgetQuantity] Reset failed:", error)
    return getQuantityResetErrorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const access = validateQuantityBudgetSession(session)
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status })
    const { role, userId, organizationId: userOrgId } = access

    const rawBody = await req.json().catch(() => null)
    if (!rawBody) {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 })
    }

    const parsedBody = quantityBudgetAllocationSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const body = parsedBody.data

    const branchId = Number(body.branchId)
    const type: AllocationType = body.type
    const items = body.items

    if (!Number.isInteger(branchId) || branchId <= 0) {
      return NextResponse.json({ error: "branchId must be a positive number" }, { status: 400 })
    }

    const itemValidationError = validateQuantityAllocationItems(items)
    if (itemValidationError) return NextResponse.json({ error: itemValidationError }, { status: 400 })
    const branchInventoryIds = items.map((item) => item.branchInventoryId)

    const [branch] = await db.select().from(branches).where(eq(branches.id, branchId)).limit(1)
    if (!branch) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404 })
    }

    if (role === "HEAD_OFFICE" && branch.organizationId !== userOrgId) {
      return NextResponse.json({ error: "Unauthorized: Branch belongs to different organization" }, { status: 403 })
    }

    const budgetAllocationMode = await getBudgetAllocationModeForOrganization(branch.organizationId)
    if (budgetAllocationMode !== "quantity") {
      return NextResponse.json({
        error: "This organization uses money-value budgeting. Quantity budget allocation is not available."
      }, { status: 403 })
    }

    const assignedProducts = await db
      .select({
        branchInventoryId: branchInventory.id,
        organizationInventoryId: branchInventory.organizationInventoryId,
        globalProductId: organizationInventory.globalProductId,
        productName: globalProducts.name,
        productCode: globalProducts.productCode,
        customName: organizationInventory.customName,
        customPrice: organizationInventory.customPrice,
        basePrice: globalProducts.basePrice,
        unit: globalProducts.unit,
        allowDecimalQuantity: globalProducts.allowDecimalQuantity,
        quantityStep: globalProducts.quantityStep,
      })
      .from(branchInventory)
      .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
      .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
      .where(and(
        eq(branchInventory.branchId, branch.id),
        eq(branchInventory.organizationId, branch.organizationId),
        inArray(branchInventory.id, branchInventoryIds),
        eq(branchInventory.isActive, true),
        eq(organizationInventory.isActive, true),
        eq(globalProducts.status, "active"),
        isNull(branchInventory.deletedAt),
        isNull(organizationInventory.deletedAt),
        isNull(globalProducts.deletedAt),
      ))

    if (assignedProducts.length !== branchInventoryIds.length) {
      return NextResponse.json({
        error: "Some selected products are not assigned to this branch or are inactive"
      }, { status: 400 })
    }

    const allocationLines = buildQuantityAllocationLines(assignedProducts, items)

    const totalAmountCents = allocationLines.reduce((sum, line) => sum + line.amountCents, 0)
    const totalQuantity = allocationLines.reduce((sum, line) => sum + line.quantity, 0)

    const totalValidationError = validateAllocationTotal(totalAmountCents)
    if (totalValidationError) return NextResponse.json({ error: totalValidationError }, { status: 400 })

    const period = currentBudgetPeriod()

    const result = await db.transaction(async (tx) => {
      // Match checkout's lock order: money budget first, then product budgets.
      await tx.insert(budgets).values({
        organizationId: branch.organizationId,
        branchId: branch.id,
        period,
        amountAllocatedCents: branch.baselineBudgetCents ?? 0,
        amountCreditedCents: 0,
        amountSpentCents: 0,
        amountHeldCents: 0,
      }).onConflictDoNothing()

      const [existingBudget] = await tx
        .select()
        .from(budgets)
        .where(and(eq(budgets.branchId, branch.id), eq(budgets.period, period)))
        .limit(1)
        .for('update')

      const existingQuantityRows = await tx
        .select()
        .from(productQuantityBudgets)
        .where(and(
          eq(productQuantityBudgets.branchId, branch.id),
          eq(productQuantityBudgets.period, period),
        ))
        .for('update')

      const existingQuantityByOrgInvId = new Map(
        existingQuantityRows.map((row) => [row.organizationInventoryId, row])
      )

      const monthlyBaselineAmountCents = getMonthlyBaselineAmount(allocationLines, existingQuantityRows, type, totalAmountCents)

      const currentSpent = (existingBudget?.amountSpentCents || 0) + (existingBudget?.amountHeldCents || 0)
      const oldAllocated = existingBudget?.amountAllocatedCents ?? branch.baselineBudgetCents ?? 0
      const oldCredited = existingBudget?.amountCreditedCents ?? 0

      const newAllocated = type === "monthly" ? monthlyBaselineAmountCents : oldAllocated
      const newCredited = type === "addon" ? oldCredited + totalAmountCents : oldCredited
      const proposedTotal = newAllocated + newCredited

      if (proposedTotal < currentSpent) {
        throw new Error(`Validation Failed: Total budget (${(proposedTotal / 100).toFixed(2)} PKR) cannot be less than current total spent (${(currentSpent / 100).toFixed(2)} PKR).`)
      }

      if (type === "monthly") {
        await tx.update(branches)
          .set({ baselineBudgetCents: monthlyBaselineAmountCents, updatedAt: new Date() })
          .where(eq(branches.id, branch.id))
      }

      const [moneyBudget] = await tx
        .insert(budgets)
        .values({
          organizationId: branch.organizationId,
          branchId: branch.id,
          period,
          amountAllocatedCents: newAllocated,
          amountCreditedCents: newCredited,
          amountSpentCents: existingBudget?.amountSpentCents ?? 0,
          amountHeldCents: existingBudget?.amountHeldCents ?? 0,
        })
        .onConflictDoUpdate({
          target: [budgets.branchId, budgets.period],
          set: {
            amountAllocatedCents: newAllocated,
            amountCreditedCents: newCredited,
            updatedAt: new Date(),
          },
        })
        .returning()

      if (type === "addon") {
        await tx.insert(budgetAddons).values({
          budgetId: moneyBudget.id,
          amountCents: totalAmountCents,
          reason: body.reason || "Product quantity budget allocation",
          createdByUserId: userId,
        })
      }

      const quantityBudgetRows = []
      for (const line of allocationLines) {
        quantityBudgetRows.push(await upsertQuantityBudgetLine(tx, {
          line,
          existingByInventoryId: existingQuantityByOrgInvId,
          type,
          branch,
          period,
          userId,
          moneyBudget,
        }))
      }
      await tx.insert(auditLogs).values({
        userId,
        organizationId: branch.organizationId,
        branchId: branch.id,
        action: type === "monthly" ? "SET_QUANTITY_BUDGET" : "ADD_QUANTITY_BUDGET_CREDIT",
        entity: "PRODUCT_QUANTITY_BUDGET",
        entityId: String(branch.id),
        metadata: {
          branchName: branch.name,
          period,
          allocationType: type,
          totalQuantity,
          totalAmount: totalAmountCents / 100,
          products: allocationLines.map((line) => ({
            organizationInventoryId: line.organizationInventoryId,
            globalProductId: line.globalProductId,
            productName: line.customName || line.productName,
            quantity: line.quantity,
            price: line.priceCents / 100,
            amount: line.amountCents / 100,
          })),
        },
      })

      return {
        moneyBudget,
        quantityBudgets: quantityBudgetRows,
        totalAmountCents,
        totalQuantity,
      }
    })

    return NextResponse.json({
      message: type === "monthly"
        ? "Quantity baseline allocated successfully"
        : "Quantity add-on allocated successfully",
      allocation: {
        branchId: branch.id,
        branchName: branch.name,
        period,
        type,
        totalQuantity: result.totalQuantity,
        totalAmountCents: result.totalAmountCents,
        productCount: allocationLines.length,
      },
    })
  } catch (error: any) {
    console.error("[BudgetQuantity] Allocation failed:", error)
    return getQuantityAllocationErrorResponse(error)
  }
}
