import { desc, eq, inArray } from "drizzle-orm"
import { error, ok, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import {
  auditLogs,
  branchInventory,
  branches,
  budgetAddons,
  budgets,
  categories,
  employeeCredentials,
  globalProducts,
  groups,
  orderItems,
  orders,
  organizationInventory,
  organizations,
  productQuantityBudgetAllocations,
  productQuantityBudgets,
  refundItems,
  refunds,
  roles,
  suppliers,
  systemLogs,
  users,
} from "@/db/schema"
import type { BranchExportSheet } from "@/lib/branch-excel-export"

export const dynamic = "force-dynamic"

const toDateTime = (value: Date | string | null | undefined) => {
  if (!value) return "-"
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString()
}

const toMoney = (value: number | null | undefined) =>
  Number((Number(value || 0) / 100).toFixed(2))

const toStatus = (value: string | null | undefined, fallback = "Active") => {
  if (!value?.trim()) return fallback
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

const toYesNo = (value: unknown) => value ? "Yes" : "No"

const toJsonText = (value: unknown) => {
  if (value === null || value === undefined) return "-"
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const displayName = (user: {
  id: string
  fullName?: string | null
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}) => {
  const composedName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
  return user.fullName?.trim() || composedName || user.email || user.id
}

export async function GET(
  _: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN"])
  if (authError) return authError

  const params = await props.params
  if (!/^\d+$/.test(params.id)) return error("Invalid branch ID", 400)
  const branchId = Number(params.id)

  try {
    const [branch] = await db
      .select({
        id: branches.id,
        name: branches.name,
        code: branches.code,
        organizationId: branches.organizationId,
        organizationName: organizations.name,
        organizationCode: organizations.code,
        status: branches.status,
        province: branches.province,
        city: branches.city,
        address: branches.address,
        costCenterId: branches.costCenterId,
        adminUserId: branches.adminUserId,
        baselineBudgetCents: branches.baselineBudgetCents,
        groupId: branches.groupId,
        groupName: groups.name,
        groupDescription: groups.description,
        groupStatus: groups.status,
        createdAt: branches.createdAt,
        updatedAt: branches.updatedAt,
      })
      .from(branches)
      .innerJoin(organizations, eq(branches.organizationId, organizations.id))
      .leftJoin(groups, eq(branches.groupId, groups.id))
      .where(eq(branches.id, branchId))
      .limit(1)

    if (!branch) return error("Branch not found", 404)

    const [
      organizationUsers,
      portalAccounts,
      orderRows,
      inventoryRows,
      budgetRows,
      quantityBudgetRows,
      quantityAllocationRows,
      supplierRows,
      auditRows,
      systemRows,
    ] = await Promise.all([
      db
        .select({
          id: users.id,
          branchId: users.branchId,
          email: users.email,
          username: users.username,
          fullName: users.fullName,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          employeeId: users.employeeId,
          role: roles.name,
          isActive: users.isActive,
          mfaEnabled: users.mfaEnabled,
          imprestHolder: users.imprestHolder,
          contactPerson: users.contactPerson,
          location: users.location,
          address: users.address,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
          deletedAt: users.deletedAt,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.organizationId, branch.organizationId))
        .orderBy(desc(users.createdAt)),
      db
        .select({
          id: employeeCredentials.id,
          username: employeeCredentials.username,
          email: employeeCredentials.email,
          firstName: employeeCredentials.firstName,
          lastName: employeeCredentials.lastName,
          mfaEnabled: employeeCredentials.mfaEnabled,
          isActive: employeeCredentials.isActive,
          createdByUserId: employeeCredentials.createdByUserId,
          createdAt: employeeCredentials.createdAt,
          updatedAt: employeeCredentials.updatedAt,
          deactivatedAt: employeeCredentials.deactivatedAt,
        })
        .from(employeeCredentials)
        .where(eq(employeeCredentials.branchId, branchId))
        .orderBy(desc(employeeCredentials.createdAt)),
      db
        .select({
          id: orders.id,
          tid: orders.tid,
          status: orders.status,
          fulfillmentStatus: orders.fulfillmentStatus,
          paymentStatus: orders.paymentStatus,
          subtotalCents: orders.subtotalCents,
          taxCents: orders.taxCents,
          totalCents: orders.totalCents,
          refundAmountCents: orders.refundAmountCents,
          notes: orders.notes,
          createdByUserId: orders.createdByUserId,
          createdAt: orders.createdAt,
          approvedByUserId: orders.approvedByUserId,
          approvedAt: orders.approvedAt,
          rejectedByUserId: orders.rejectedByUserId,
          rejectedAt: orders.rejectedAt,
          rejectionReason: orders.rejectionReason,
          fulfilledByUserId: orders.fulfilledByUserId,
          fulfilledAt: orders.fulfilledAt,
          deliveredAt: orders.deliveredAt,
          paidByUserId: orders.paidByUserId,
          paidAt: orders.paidAt,
          refundedByUserId: orders.refundedByUserId,
          refundedAt: orders.refundedAt,
          refundReason: orders.refundReason,
          statusAtRefund: orders.statusAtRefund,
          receiptData: orders.receiptData,
          updatedAt: orders.updatedAt,
        })
        .from(orders)
        .where(eq(orders.branchId, branchId))
        .orderBy(desc(orders.createdAt)),
      db
        .select({
          assignmentId: branchInventory.id,
          organizationInventoryId: branchInventory.organizationInventoryId,
          productId: globalProducts.id,
          productCode: globalProducts.productCode,
          productName: globalProducts.name,
          customName: organizationInventory.customName,
          description: globalProducts.description,
          customDescription: organizationInventory.customDescription,
          categoryName: categories.name,
          unit: globalProducts.unit,
          globalStatus: globalProducts.status,
          globalStockQuantity: globalProducts.stockQuantity,
          basePriceCents: globalProducts.basePrice,
          customPriceCents: organizationInventory.customPrice,
          organizationItemActive: organizationInventory.isActive,
          branchVisible: branchInventory.isVisible,
          branchActive: branchInventory.isActive,
          assignedByUserId: branchInventory.assignedByUserId,
          assignedAt: branchInventory.assignedAt,
          updatedAt: branchInventory.updatedAt,
          deletedAt: branchInventory.deletedAt,
        })
        .from(branchInventory)
        .innerJoin(
          organizationInventory,
          eq(branchInventory.organizationInventoryId, organizationInventory.id),
        )
        .innerJoin(
          globalProducts,
          eq(organizationInventory.globalProductId, globalProducts.id),
        )
        .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
        .where(eq(branchInventory.branchId, branchId))
        .orderBy(globalProducts.name),
      db
        .select()
        .from(budgets)
        .where(eq(budgets.branchId, branchId))
        .orderBy(desc(budgets.period)),
      db
        .select({
          id: productQuantityBudgets.id,
          period: productQuantityBudgets.period,
          productId: productQuantityBudgets.globalProductId,
          productCode: globalProducts.productCode,
          productName: globalProducts.name,
          unit: globalProducts.unit,
          allocatedQuantity: productQuantityBudgets.allocatedQuantity,
          heldQuantity: productQuantityBudgets.heldQuantity,
          usedQuantity: productQuantityBudgets.usedQuantity,
          creditedQuantity: productQuantityBudgets.creditedQuantity,
          amountAllocatedCents: productQuantityBudgets.amountAllocatedCents,
          amountCreditedCents: productQuantityBudgets.amountCreditedCents,
          createdByUserId: productQuantityBudgets.createdByUserId,
          updatedByUserId: productQuantityBudgets.updatedByUserId,
          createdAt: productQuantityBudgets.createdAt,
          updatedAt: productQuantityBudgets.updatedAt,
        })
        .from(productQuantityBudgets)
        .innerJoin(
          globalProducts,
          eq(productQuantityBudgets.globalProductId, globalProducts.id),
        )
        .where(eq(productQuantityBudgets.branchId, branchId))
        .orderBy(desc(productQuantityBudgets.period), globalProducts.name),
      db
        .select({
          id: productQuantityBudgetAllocations.id,
          quantityBudgetId: productQuantityBudgetAllocations.quantityBudgetId,
          moneyBudgetId: productQuantityBudgetAllocations.budgetId,
          period: productQuantityBudgetAllocations.period,
          productId: productQuantityBudgetAllocations.globalProductId,
          productCode: globalProducts.productCode,
          productName: globalProducts.name,
          unit: globalProducts.unit,
          allocationType: productQuantityBudgetAllocations.allocationType,
          quantity: productQuantityBudgetAllocations.quantity,
          priceCents: productQuantityBudgetAllocations.priceCents,
          amountCents: productQuantityBudgetAllocations.amountCents,
          createdByUserId: productQuantityBudgetAllocations.createdByUserId,
          metadata: productQuantityBudgetAllocations.metadata,
          createdAt: productQuantityBudgetAllocations.createdAt,
        })
        .from(productQuantityBudgetAllocations)
        .innerJoin(
          globalProducts,
          eq(productQuantityBudgetAllocations.globalProductId, globalProducts.id),
        )
        .where(eq(productQuantityBudgetAllocations.branchId, branchId))
        .orderBy(desc(productQuantityBudgetAllocations.createdAt)),
      db
        .select()
        .from(suppliers)
        .where(eq(suppliers.branchId, branchId))
        .orderBy(suppliers.name),
      db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.branchId, branchId))
        .orderBy(desc(auditLogs.createdAt)),
      db
        .select()
        .from(systemLogs)
        .where(eq(systemLogs.branchId, branchId))
        .orderBy(desc(systemLogs.timestamp)),
    ])

    const orderIds = orderRows.map((order) => order.id)
    const budgetIds = budgetRows.map((budget) => budget.id)

    const [orderItemRows, refundRows, budgetAddonRows] = await Promise.all([
      orderIds.length > 0
        ? db
          .select()
          .from(orderItems)
          .where(inArray(orderItems.orderId, orderIds))
          .orderBy(orderItems.orderId, orderItems.id)
        : Promise.resolve([]),
      orderIds.length > 0
        ? db
          .select()
          .from(refunds)
          .where(inArray(refunds.orderId, orderIds))
          .orderBy(desc(refunds.createdAt))
        : Promise.resolve([]),
      budgetIds.length > 0
        ? db
          .select()
          .from(budgetAddons)
          .where(inArray(budgetAddons.budgetId, budgetIds))
          .orderBy(desc(budgetAddons.createdAt))
        : Promise.resolve([]),
    ])

    const refundIds = refundRows.map((refund) => refund.id)
    const refundItemRows = refundIds.length > 0
      ? await db
        .select()
        .from(refundItems)
        .where(inArray(refundItems.refundId, refundIds))
        .orderBy(refundItems.refundId, refundItems.id)
      : []

    const userNameById = new Map(
      organizationUsers.map((user) => [user.id, displayName(user)]),
    )
    const getUserName = (userId: string | null | undefined) =>
      userId ? userNameById.get(userId) || userId : "-"

    const orderById = new Map(orderRows.map((order) => [order.id, order]))
    const orderItemById = new Map(orderItemRows.map((item) => [item.id, item]))
    const refundById = new Map(refundRows.map((refund) => [refund.id, refund]))
    const budgetById = new Map(budgetRows.map((budget) => [budget.id, budget]))
    const branchUsers = organizationUsers.filter((user) => user.branchId === branchId)
    const exportedAt = new Date()

    const profileRows = [
      { Field: "Branch ID", Value: branch.id },
      { Field: "Branch Name", Value: branch.name },
      { Field: "Branch Code", Value: branch.code || "-" },
      { Field: "Organization", Value: branch.organizationName },
      { Field: "Organization Code", Value: branch.organizationCode || "-" },
      { Field: "Status", Value: toStatus(branch.status) },
      { Field: "Province", Value: branch.province || "-" },
      { Field: "City", Value: branch.city || "-" },
      { Field: "Address", Value: branch.address || "-" },
      { Field: "Cost Center ID", Value: branch.costCenterId || "-" },
      { Field: "Group / Cluster", Value: branch.groupName || "Ungrouped" },
      { Field: "Group Description", Value: branch.groupDescription || "-" },
      { Field: "Group Status", Value: branch.groupId ? toStatus(branch.groupStatus) : "-" },
      { Field: "Branch Administrator", Value: getUserName(branch.adminUserId) },
      { Field: "Baseline Budget (PKR)", Value: toMoney(branch.baselineBudgetCents) },
      { Field: "Users", Value: branchUsers.length },
      { Field: "Portal Accounts", Value: portalAccounts.length },
      { Field: "Orders", Value: orderRows.length },
      {
        Field: "Gross Order Value (PKR)",
        Value: toMoney(orderRows.reduce((total, order) => total + Number(order.totalCents || 0), 0)),
      },
      {
        Field: "Refunded Value (PKR)",
        Value: toMoney(orderRows.reduce((total, order) => total + Number(order.refundAmountCents || 0), 0)),
      },
      { Field: "Inventory Products", Value: inventoryRows.length },
      { Field: "Money Budget Periods", Value: budgetRows.length },
      { Field: "Quantity Budget Records", Value: quantityBudgetRows.length },
      { Field: "Quantity Allocation Events", Value: quantityAllocationRows.length },
      { Field: "Suppliers", Value: supplierRows.length },
      { Field: "Created At", Value: toDateTime(branch.createdAt) },
      { Field: "Last Updated", Value: toDateTime(branch.updatedAt) },
      { Field: "Exported At", Value: toDateTime(exportedAt) },
    ]

    const activityRows = [
      ...auditRows.map((activity) => ({
        Source: "Audit Log",
        "Activity ID": activity.id,
        Timestamp: toDateTime(activity.createdAt),
        User: getUserName(activity.userId),
        Role: "-",
        Action: activity.action,
        "Entity / Resource": activity.entity,
        "Resource ID": activity.entityId || "-",
        Success: "-",
        Details: toJsonText(activity.metadata),
      })),
      ...systemRows.map((activity) => ({
        Source: "System Log",
        "Activity ID": activity.id,
        Timestamp: toDateTime(activity.timestamp),
        User: activity.userId ? getUserName(activity.userId) : activity.userEmail || "-",
        Role: activity.userRole || "-",
        Action: activity.action,
        "Entity / Resource": activity.resourceType,
        "Resource ID": activity.resourceId || "-",
        Success: toYesNo(activity.success),
        Details: activity.errorMessage || toJsonText(activity.details),
      })),
    ].sort((a, b) => String(b.Timestamp).localeCompare(String(a.Timestamp)))

    const sheets: BranchExportSheet[] = [
      {
        name: "Branch Details",
        headers: ["Field", "Value"],
        rows: profileRows,
        columnWidths: [30, 55],
      },
      {
        name: "Users",
        headers: [
          "User ID", "Name", "Email", "Username", "Phone", "Employee ID", "Role",
          "Status", "MFA Enabled", "Imprest Holder", "Contact Person", "Location",
          "Address", "Created At", "Last Updated", "Deleted At",
        ],
        rows: branchUsers.map((user) => ({
          "User ID": user.id,
          Name: displayName(user),
          Email: user.email,
          Username: user.username || "-",
          Phone: user.phone || "-",
          "Employee ID": user.employeeId || "-",
          Role: user.role || "-",
          Status: user.deletedAt ? "Deleted" : user.isActive ? "Active" : "Inactive",
          "MFA Enabled": toYesNo(user.mfaEnabled),
          "Imprest Holder": user.imprestHolder || "-",
          "Contact Person": user.contactPerson || "-",
          Location: user.location || "-",
          Address: user.address || "-",
          "Created At": toDateTime(user.createdAt),
          "Last Updated": toDateTime(user.updatedAt),
          "Deleted At": toDateTime(user.deletedAt),
        })),
      },
      {
        name: "Portal Accounts",
        headers: [
          "Account ID", "Name", "Email", "Username", "Status", "MFA Enabled",
          "Created By", "Created At", "Last Updated", "Deactivated At",
        ],
        rows: portalAccounts.map((account) => ({
          "Account ID": account.id,
          Name: [account.firstName, account.lastName].filter(Boolean).join(" ") || account.email,
          Email: account.email,
          Username: account.username || "-",
          Status: account.isActive ? "Active" : "Inactive",
          "MFA Enabled": toYesNo(account.mfaEnabled),
          "Created By": getUserName(account.createdByUserId),
          "Created At": toDateTime(account.createdAt),
          "Last Updated": toDateTime(account.updatedAt),
          "Deactivated At": toDateTime(account.deactivatedAt),
        })),
      },
      {
        name: "Orders",
        headers: [
          "Order ID", "TID", "Status", "Fulfillment Status", "Payment Status",
          "Invoice Number", "Buyer Name", "Buyer Phone", "Buyer Address",
          "Subtotal (PKR)", "Tax (PKR)", "Total (PKR)", "Refund (PKR)", "Net (PKR)",
          "Notes", "Created By", "Created At", "Approved By", "Approved At",
          "Rejected By", "Rejected At", "Rejection Reason", "Fulfilled By",
          "Fulfilled At", "Delivered At", "Paid By", "Paid At", "Refunded By",
          "Refunded At", "Refund Reason", "Status At Refund", "Last Updated",
        ],
        rows: orderRows.map((order) => ({
          "Order ID": order.id,
          TID: order.tid,
          Status: toStatus(order.status),
          "Fulfillment Status": toStatus(order.fulfillmentStatus),
          "Payment Status": toStatus(order.paymentStatus),
          "Invoice Number": order.receiptData?.invoiceNumber || "-",
          "Buyer Name": order.receiptData?.buyerName || "-",
          "Buyer Phone": order.receiptData?.buyerPhone || "-",
          "Buyer Address": order.receiptData?.buyerAddress || "-",
          "Subtotal (PKR)": toMoney(order.subtotalCents),
          "Tax (PKR)": toMoney(order.taxCents),
          "Total (PKR)": toMoney(order.totalCents),
          "Refund (PKR)": toMoney(order.refundAmountCents),
          "Net (PKR)": toMoney(Number(order.totalCents || 0) - Number(order.refundAmountCents || 0)),
          Notes: order.notes || "-",
          "Created By": getUserName(order.createdByUserId),
          "Created At": toDateTime(order.createdAt),
          "Approved By": getUserName(order.approvedByUserId),
          "Approved At": toDateTime(order.approvedAt),
          "Rejected By": getUserName(order.rejectedByUserId),
          "Rejected At": toDateTime(order.rejectedAt),
          "Rejection Reason": order.rejectionReason || "-",
          "Fulfilled By": getUserName(order.fulfilledByUserId),
          "Fulfilled At": toDateTime(order.fulfilledAt),
          "Delivered At": toDateTime(order.deliveredAt),
          "Paid By": getUserName(order.paidByUserId),
          "Paid At": toDateTime(order.paidAt),
          "Refunded By": getUserName(order.refundedByUserId),
          "Refunded At": toDateTime(order.refundedAt),
          "Refund Reason": order.refundReason || "-",
          "Status At Refund": order.statusAtRefund ? toStatus(order.statusAtRefund) : "-",
          "Last Updated": toDateTime(order.updatedAt),
        })),
      },
      {
        name: "Order Items",
        headers: [
          "Order ID", "TID", "Item ID", "Product ID", "Product Code", "Product Name",
          "Organization Inventory ID", "Unit", "Quantity", "Unit Price (PKR)",
          "Line Total (PKR)", "Created At",
        ],
        rows: orderItemRows.map((item) => {
          const order = orderById.get(item.orderId)
          return {
            "Order ID": item.orderId,
            TID: order?.tid || "-",
            "Item ID": item.id,
            "Product ID": item.globalProductId,
            "Product Code": item.productCode || "-",
            "Product Name": item.productName,
            "Organization Inventory ID": item.organizationInventoryId || "-",
            Unit: item.unit,
            Quantity: Number(item.quantity),
            "Unit Price (PKR)": toMoney(item.priceCents),
            "Line Total (PKR)": toMoney(Number(item.priceCents) * Number(item.quantity)),
            "Created At": toDateTime(item.createdAt),
          }
        }),
      },
      {
        name: "Refunds",
        headers: [
          "Refund ID", "Refund Number", "Order ID", "TID", "Status", "Amount (PKR)",
          "Reason", "Requested By", "Processed By", "Created At", "Last Updated",
        ],
        rows: refundRows.map((refund) => ({
          "Refund ID": refund.id,
          "Refund Number": refund.refundNumber || "-",
          "Order ID": refund.orderId,
          TID: orderById.get(refund.orderId)?.tid || "-",
          Status: toStatus(refund.status),
          "Amount (PKR)": toMoney(refund.amountCents),
          Reason: refund.reason || "-",
          "Requested By": getUserName(refund.requestedByUserId),
          "Processed By": getUserName(refund.processedByUserId),
          "Created At": toDateTime(refund.createdAt),
          "Last Updated": toDateTime(refund.updatedAt),
        })),
      },
      {
        name: "Refund Items",
        headers: [
          "Refund ID", "Refund Number", "Order ID", "TID", "Order Item ID",
          "Product Code", "Product Name", "Quantity", "Amount (PKR)", "Created At",
        ],
        rows: refundItemRows.map((item) => {
          const refund = refundById.get(item.refundId)
          const orderItem = orderItemById.get(item.orderItemId)
          const order = refund ? orderById.get(refund.orderId) : undefined
          return {
            "Refund ID": item.refundId,
            "Refund Number": refund?.refundNumber || "-",
            "Order ID": refund?.orderId || "-",
            TID: order?.tid || "-",
            "Order Item ID": item.orderItemId,
            "Product Code": orderItem?.productCode || "-",
            "Product Name": orderItem?.productName || "-",
            Quantity: Number(item.quantity),
            "Amount (PKR)": toMoney(item.amountCents),
            "Created At": toDateTime(item.createdAt),
          }
        }),
      },
      {
        name: "Inventory",
        headers: [
          "Assignment ID", "Organization Inventory ID", "Product ID", "Product Code",
          "Product Name", "Description", "Category", "Unit", "Global Status",
          "Global Stock Quantity", "Base Price (PKR)", "Custom Price (PKR)",
          "Effective Price (PKR)", "Branch Visible", "Branch Active",
          "Organization Item Active", "Assigned By", "Assigned At", "Last Updated",
          "Deleted At",
        ],
        rows: inventoryRows.map((item) => ({
          "Assignment ID": item.assignmentId,
          "Organization Inventory ID": item.organizationInventoryId,
          "Product ID": item.productId,
          "Product Code": item.productCode,
          "Product Name": item.customName || item.productName,
          Description: item.customDescription || item.description || "-",
          Category: item.categoryName || "Uncategorized",
          Unit: item.unit,
          "Global Status": toStatus(item.globalStatus),
          "Global Stock Quantity": Number(item.globalStockQuantity),
          "Base Price (PKR)": toMoney(item.basePriceCents),
          "Custom Price (PKR)": item.customPriceCents === null ? "-" : toMoney(item.customPriceCents),
          "Effective Price (PKR)": toMoney(item.customPriceCents ?? item.basePriceCents),
          "Branch Visible": toYesNo(item.branchVisible),
          "Branch Active": toYesNo(item.branchActive),
          "Organization Item Active": toYesNo(item.organizationItemActive),
          "Assigned By": getUserName(item.assignedByUserId),
          "Assigned At": toDateTime(item.assignedAt),
          "Last Updated": toDateTime(item.updatedAt),
          "Deleted At": toDateTime(item.deletedAt),
        })),
      },
      {
        name: "Money Budgets",
        headers: [
          "Budget ID", "Period", "Allocated (PKR)", "Credited (PKR)", "Spent (PKR)",
          "Held (PKR)", "Remaining (PKR)", "Created At", "Last Updated",
        ],
        rows: budgetRows.map((budget) => ({
          "Budget ID": budget.id,
          Period: budget.period,
          "Allocated (PKR)": toMoney(budget.amountAllocatedCents),
          "Credited (PKR)": toMoney(budget.amountCreditedCents),
          "Spent (PKR)": toMoney(budget.amountSpentCents),
          "Held (PKR)": toMoney(budget.amountHeldCents),
          "Remaining (PKR)": toMoney(
            Number(budget.amountAllocatedCents) +
            Number(budget.amountCreditedCents) -
            Number(budget.amountSpentCents) -
            Number(budget.amountHeldCents),
          ),
          "Created At": toDateTime(budget.createdAt),
          "Last Updated": toDateTime(budget.updatedAt),
        })),
      },
      {
        name: "Budget Add-ons",
        headers: [
          "Add-on ID", "Budget ID", "Period", "Amount (PKR)", "Reason",
          "Created By", "Created At",
        ],
        rows: budgetAddonRows.map((addon) => ({
          "Add-on ID": addon.id,
          "Budget ID": addon.budgetId,
          Period: budgetById.get(addon.budgetId)?.period || "-",
          "Amount (PKR)": toMoney(addon.amountCents),
          Reason: addon.reason || "-",
          "Created By": getUserName(addon.createdByUserId),
          "Created At": toDateTime(addon.createdAt),
        })),
      },
      {
        name: "Quantity Budgets",
        headers: [
          "Budget ID", "Period", "Product ID", "Product Code", "Product Name", "Unit",
          "Allocated Quantity", "Credited Quantity", "Used Quantity", "Held Quantity",
          "Remaining Quantity", "Allocated Value (PKR)", "Credited Value (PKR)",
          "Created By", "Last Updated By", "Created At", "Last Updated",
        ],
        rows: quantityBudgetRows.map((budget) => ({
          "Budget ID": budget.id,
          Period: budget.period,
          "Product ID": budget.productId,
          "Product Code": budget.productCode,
          "Product Name": budget.productName,
          Unit: budget.unit,
          "Allocated Quantity": Number(budget.allocatedQuantity),
          "Credited Quantity": Number(budget.creditedQuantity),
          "Used Quantity": Number(budget.usedQuantity),
          "Held Quantity": Number(budget.heldQuantity),
          "Remaining Quantity":
            Number(budget.allocatedQuantity) +
            Number(budget.creditedQuantity) -
            Number(budget.usedQuantity) -
            Number(budget.heldQuantity),
          "Allocated Value (PKR)": toMoney(budget.amountAllocatedCents),
          "Credited Value (PKR)": toMoney(budget.amountCreditedCents),
          "Created By": getUserName(budget.createdByUserId),
          "Last Updated By": getUserName(budget.updatedByUserId),
          "Created At": toDateTime(budget.createdAt),
          "Last Updated": toDateTime(budget.updatedAt),
        })),
      },
      {
        name: "Quantity Allocations",
        headers: [
          "Allocation ID", "Quantity Budget ID", "Money Budget ID", "Period",
          "Product ID", "Product Code", "Product Name", "Unit", "Allocation Type",
          "Quantity", "Unit Price (PKR)", "Amount (PKR)", "Created By",
          "Metadata", "Created At",
        ],
        rows: quantityAllocationRows.map((allocation) => ({
          "Allocation ID": allocation.id,
          "Quantity Budget ID": allocation.quantityBudgetId,
          "Money Budget ID": allocation.moneyBudgetId || "-",
          Period: allocation.period,
          "Product ID": allocation.productId,
          "Product Code": allocation.productCode,
          "Product Name": allocation.productName,
          Unit: allocation.unit,
          "Allocation Type": toStatus(allocation.allocationType),
          Quantity: Number(allocation.quantity),
          "Unit Price (PKR)": toMoney(allocation.priceCents),
          "Amount (PKR)": toMoney(allocation.amountCents),
          "Created By": getUserName(allocation.createdByUserId),
          Metadata: toJsonText(allocation.metadata),
          "Created At": toDateTime(allocation.createdAt),
        })),
      },
      {
        name: "Suppliers",
        headers: [
          "Supplier ID", "Name", "Contact", "Email", "Address", "Description",
          "Created At", "Last Updated",
        ],
        rows: supplierRows.map((supplier) => ({
          "Supplier ID": supplier.id,
          Name: supplier.name,
          Contact: supplier.contact || "-",
          Email: supplier.email || "-",
          Address: supplier.address || "-",
          Description: supplier.description || "-",
          "Created At": toDateTime(supplier.createdAt),
          "Last Updated": toDateTime(supplier.updatedAt),
        })),
      },
      {
        name: "Activity",
        headers: [
          "Source", "Activity ID", "Timestamp", "User", "Role", "Action",
          "Entity / Resource", "Resource ID", "Success", "Details",
        ],
        rows: activityRows,
      },
    ]

    return ok({
      item: {
        branchName: branch.name,
        branchCode: branch.code || "",
        generatedAt: exportedAt.toISOString(),
        sheets,
      },
    })
  } catch (exportError) {
    console.error("Branch export failed", exportError)
    return error("Failed to generate branch export", 500)
  }
}
