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
    ? value.split(",").map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : []

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

    const scopedOrganizationId = role === "HEAD_OFFICE"
      ? userOrgId
      : Number.isInteger(requestedOrgId) && requestedOrgId > 0
        ? requestedOrgId
        : undefined

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

    let periodList: string[]
    if (periodParam && periodPattern.test(periodParam)) {
      periodList = [periodParam]
    } else {
      const requestedStartDate = parseStartDateParam(startDateParam)
      const requestedEndDate = parseEndDateParam(endDateParam)
      let startDate = requestedStartDate
      const endDate = requestedEndDate || new Date()

      if (presetParam === "all") {
        const firstQuantityBudget = await db
          .select({ period: productQuantityBudgets.period })
          .from(productQuantityBudgets)
          .where(eq(productQuantityBudgets.organizationId, scopedOrganizationId))
          .orderBy(productQuantityBudgets.period)
          .limit(1)

        startDate = firstQuantityBudget.length > 0
          ? new Date(`${firstQuantityBudget[0].period}-01T00:00:00.000Z`)
          : new Date(`${currentBudgetPeriod()}-01T00:00:00.000Z`)
      } else if (!startDate) {
        startDate = new Date(`${currentBudgetPeriod()}-01T00:00:00.000Z`)
      }

      if (!startDateParam) startDate.setHours(0, 0, 0, 0)
      if (!endDateParam) endDate.setHours(23, 59, 59, 999)

      periodList = buildAppMonthPeriods(startDate, endDate, parsedMonths, parsedYears)
      if (["today", "3d", "7d", "monthly", "thisMonth"].includes(presetParam)) {
        periodList = [getAppMonthPeriod(endDate)]
      }
      if (periodList.length === 0) periodList = [currentBudgetPeriod()]
    }

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

    const productSummaryByKey = new Map<string, {
      quantityBudgetId: number
      organizationId: number
      branchId: number
      organizationInventoryId: number
      globalProductId: number
      productCode?: string | null
      productName: string
      unit?: string | null
      baseQuantity: number
      addonQuantity: number
      totalQuantity: number
      spentQuantity: number
      remainingQuantity: number
    }>()

    for (const row of quantityRows) {
      const key = `${row.branchId}:${row.organizationInventoryId}`
      const existing = productSummaryByKey.get(key) || {
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
      productSummaryByKey.set(key, existing)
    }

    const products = Array.from(productSummaryByKey.values())

    const branchSummaryById = new Map<number, {
      branchId: number
      baseQuantity: number
      addonQuantity: number
      totalQuantity: number
      spentQuantity: number
      remainingQuantity: number
      productCount: number
    }>()

    for (const product of products) {
      const summary = branchSummaryById.get(product.branchId) || {
        branchId: product.branchId,
        baseQuantity: 0,
        addonQuantity: 0,
        totalQuantity: 0,
        spentQuantity: 0,
        remainingQuantity: 0,
        productCount: 0,
      }

      summary.baseQuantity += product.baseQuantity
      summary.addonQuantity += product.addonQuantity
      summary.totalQuantity += product.totalQuantity
      summary.spentQuantity += product.spentQuantity
      summary.remainingQuantity += product.remainingQuantity
      summary.productCount += 1
      branchSummaryById.set(product.branchId, summary)
    }

    return NextResponse.json({
      period: periodList.length === 1 ? periodList[0] : undefined,
      periods: periodList,
      branches: Array.from(branchSummaryById.values()),
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
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const role = (session.user as any).role
    const userId = (session.user as any).id
    const rawUserOrgId = (session.user as any).organizationId
    const userOrgId = Number.isFinite(Number(rawUserOrgId)) ? Number(rawUserOrgId) : undefined

    if (role !== "HEAD_OFFICE" && role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    if (role === "HEAD_OFFICE" && !userOrgId) {
      return NextResponse.json({ error: "Organization context required" }, { status: 400 })
    }

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

    const scopedOrganizationId = role === "HEAD_OFFICE"
      ? userOrgId
      : Number.isInteger(requestedOrgId) && requestedOrgId > 0
        ? requestedOrgId
        : undefined

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
    if (error?.message === "QUANTITY_BUDGET_RESET_HAS_COMMITMENTS") {
      return NextResponse.json({
        error: "Cannot reset quantity budgets while orders are held or spent in the selected period",
      }, { status: 409 })
    }
    return NextResponse.json({ error: "Failed to reset quantity budgets" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const role = (session.user as any).role
    const userId = (session.user as any).id
    const rawUserOrgId = (session.user as any).organizationId
    const userOrgId = Number.isFinite(Number(rawUserOrgId)) ? Number(rawUserOrgId) : undefined

    if (role !== "HEAD_OFFICE" && role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

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

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "At least one product quantity allocation is required" }, { status: 400 })
    }

    if (items.length > 100) {
      return NextResponse.json({ error: "Too many allocation lines in one request" }, { status: 400 })
    }

    for (const item of items) {
      if (!isPositiveId(item.branchInventoryId)) {
        return NextResponse.json({ error: "Each item requires a valid branchInventoryId" }, { status: 400 })
      }
      const parsedQuantity = parseQuantity(item.quantity)
      if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
        return NextResponse.json({ error: "Each quantity must be a positive number" }, { status: 400 })
      }
      item.quantity = parsedQuantity
    }

    const branchInventoryIds = items.map((item) => item.branchInventoryId)
    if (new Set(branchInventoryIds).size !== branchInventoryIds.length) {
      return NextResponse.json({ error: "Each product can only appear once in a quantity allocation" }, { status: 400 })
    }

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

    const quantityByBranchInventoryId = new Map(
      items.map((item) => [item.branchInventoryId, item.quantity])
    )

    const allocationLines = assignedProducts.map((product) => {
      const quantity = quantityByBranchInventoryId.get(product.branchInventoryId) || 0
      const priceCents = product.customPrice ?? product.basePrice

      if (!Number.isFinite(priceCents) || priceCents <= 0) {
        throw new Error(`Pricing is unavailable for ${product.customName || product.productName}`)
      }

      const quantityValidation = validateProductQuantity(quantity, {
        allowDecimalQuantity: product.allowDecimalQuantity,
        quantityStep: product.quantityStep,
        label: `Quantity for ${product.customName || product.productName}`,
      })
      if (!quantityValidation.ok) throw new Error(quantityValidation.error)

      return {
        ...product,
        quantity: quantityValidation.quantity,
        priceCents,
        amountCents: calculateLineCents(priceCents, quantityValidation.quantity),
      }
    })

    const totalAmountCents = allocationLines.reduce((sum, line) => sum + line.amountCents, 0)
    const totalQuantity = allocationLines.reduce((sum, line) => sum + line.quantity, 0)

    if (!Number.isSafeInteger(totalAmountCents) || totalAmountCents < 0) {
      return NextResponse.json({ error: "Calculated allocation amount is invalid" }, { status: 400 })
    }

    if (totalAmountCents > Number.MAX_SAFE_INTEGER / 2) {
      return NextResponse.json({ error: "Allocation amount exceeds maximum allowed value" }, { status: 400 })
    }

    const period = currentBudgetPeriod()

    const result = await db.transaction(async (tx) => {
      const selectedOrganizationInventoryIds = allocationLines.map((line) => line.organizationInventoryId)

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

      const monthlyAmountByOrgInvId = new Map(
        allocationLines.map((line) => [line.organizationInventoryId, line.amountCents])
      )

      const monthlyBaselineAmountCents = type === "monthly"
        ? Array.from(new Set([
          ...existingQuantityRows.map((row) => row.organizationInventoryId),
          ...selectedOrganizationInventoryIds,
        ])).reduce((sum, organizationInventoryId) => {
          const updatedAmount = monthlyAmountByOrgInvId.get(organizationInventoryId)
          if (updatedAmount !== undefined) return sum + updatedAmount

          const existing = existingQuantityByOrgInvId.get(organizationInventoryId)
          return sum + (existing?.amountAllocatedCents || 0)
        }, 0)
        : totalAmountCents

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
        const existing = existingQuantityByOrgInvId.get(line.organizationInventoryId)
        const currentUsedOrHeld = (existing?.usedQuantity || 0) + (existing?.heldQuantity || 0)
        const proposedQuantityTotal = type === "monthly"
          ? line.quantity + (existing?.creditedQuantity || 0)
          : (existing?.allocatedQuantity || 0) + (existing?.creditedQuantity || 0) + line.quantity

        if (proposedQuantityTotal < currentUsedOrHeld) {
          throw new Error(`Quantity allocation for ${line.customName || line.productName} cannot be lower than already used or held quantity (${formatQuantity(currentUsedOrHeld)}).`)
        }

        const [quantityBudget] = await tx
          .insert(productQuantityBudgets)
          .values({
            organizationId: branch.organizationId,
            branchId: branch.id,
            organizationInventoryId: line.organizationInventoryId,
            globalProductId: line.globalProductId,
            period,
            allocatedQuantity: type === "monthly" ? line.quantity : 0,
            creditedQuantity: type === "addon" ? line.quantity : 0,
            amountAllocatedCents: type === "monthly" ? line.amountCents : 0,
            amountCreditedCents: type === "addon" ? line.amountCents : 0,
            createdByUserId: userId,
            updatedByUserId: userId,
          })
          .onConflictDoUpdate({
            target: [
              productQuantityBudgets.branchId,
              productQuantityBudgets.organizationInventoryId,
              productQuantityBudgets.period,
            ],
            set: type === "monthly"
              ? {
                allocatedQuantity: line.quantity,
                amountAllocatedCents: line.amountCents,
                globalProductId: line.globalProductId,
                updatedByUserId: userId,
                updatedAt: new Date(),
              }
              : {
                creditedQuantity: sql`${productQuantityBudgets.creditedQuantity} + ${line.quantity}`,
                amountCreditedCents: sql`${productQuantityBudgets.amountCreditedCents} + ${line.amountCents}`,
                globalProductId: line.globalProductId,
                updatedByUserId: userId,
                updatedAt: new Date(),
              },
          })
          .returning()

        await tx.insert(productQuantityBudgetAllocations).values({
          quantityBudgetId: quantityBudget.id,
          budgetId: moneyBudget.id,
          organizationId: branch.organizationId,
          branchId: branch.id,
          organizationInventoryId: line.organizationInventoryId,
          globalProductId: line.globalProductId,
          period,
          allocationType: type,
          quantity: line.quantity,
          priceCents: line.priceCents,
          amountCents: line.amountCents,
          createdByUserId: userId,
          metadata: {
            branchInventoryId: line.branchInventoryId,
            productName: line.customName || line.productName,
            productCode: line.productCode,
            unit: line.unit,
          },
        })

        quantityBudgetRows.push(quantityBudget)
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
    const message = error?.message || "Internal Server Error"
    const status = message.startsWith("Validation Failed") || message.includes("cannot be lower") || message.includes("Pricing is unavailable")
      ? 400
      : 500
    return NextResponse.json({ error: status === 400 ? message : "Internal Server Error" }, { status })
  }
}
