import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { alias } from "drizzle-orm/pg-core"
import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm"

import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import {
    branches,
    groups,
    orderItems,
    orders,
    organizations,
    refundItems,
    refunds,
    roles,
    users,
} from "@/db/schema"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import {
    parseRequestedOrganizationIds,
    resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"

const requestedByUsers = alias(users, "refund_requested_by_users")
const processedByUsers = alias(users, "refund_processed_by_users")

const parsePositiveIds = (value: string | null) => value
    ? Array.from(new Set(value.split(",").map(Number).filter((id) => Number.isInteger(id) && id > 0)))
    : []

/**
 * GET /api/v1/analytics/refunds
 * Paginated, role-scoped refund records for the Refund Report.
 */
export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const sessionUser = session.user as any
        const [currentUser] = await db
            .select({
                branchId: users.branchId,
                organizationId: users.organizationId,
                roleName: roles.name,
            })
            .from(users)
            .leftJoin(roles, eq(users.roleId, roles.id))
            .where(eq(users.id, sessionUser.id))
            .limit(1)

        const role = String(currentUser?.roleName || sessionUser.role || "")
            .toUpperCase()
            .replace(/\s+/g, "_")
        if (!["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "BRANCH_MANAGER"].includes(role)) {
            return NextResponse.json({ error: "Access denied" }, { status: 403 })
        }

        const { searchParams } = new URL(req.url)
        const page = Math.min(Math.max(Math.trunc(Number(searchParams.get("page"))) || 1, 1), 10_000)
        const limit = Math.min(Math.max(Math.trunc(Number(searchParams.get("limit"))) || 25, 1), 100)
        const offset = (page - 1) * limit
        const startDate = searchParams.get("startDate")
        const endDate = searchParams.get("endDate")
        const status = searchParams.get("status")?.trim().toUpperCase()
        const refundType = searchParams.get("refundType")?.trim().toUpperCase()
        const query = searchParams.get("q")?.trim()
        const branchIds = parsePositiveIds(searchParams.get("branchIds") || searchParams.get("branchId"))
        const groupIds = parsePositiveIds(searchParams.get("groupIds") || searchParams.get("groupId"))
        const requestedOrganizationIds = parseRequestedOrganizationIds({
            organizationIds: searchParams.get("organizationIds"),
            organizationId: searchParams.get("organizationId"),
        })

        if (query && query.length > 100) {
            return NextResponse.json({ error: "Search query must be at most 100 characters" }, { status: 400 })
        }

        const conditions: any[] = []
        const scopedOrganizationIds = resolveAnalyticsOrganizationIds({
            role,
            userOrganizationId: currentUser?.organizationId ?? sessionUser.organizationId,
            requestedOrganizationIds,
        })

        if (role === "SUPER_ADMIN") {
            if (scopedOrganizationIds.length > 0) conditions.push(inArray(orders.organizationId, scopedOrganizationIds))
            if (branchIds.length > 0) conditions.push(inArray(orders.branchId, branchIds))
            if (groupIds.length > 0) conditions.push(inArray(branches.groupId, groupIds))
        } else if (role === "HEAD_OFFICE") {
            if (scopedOrganizationIds.length === 0) {
                return NextResponse.json({ error: "Organization context missing" }, { status: 403 })
            }
            conditions.push(inArray(orders.organizationId, scopedOrganizationIds))
            if (branchIds.length > 0) conditions.push(inArray(orders.branchId, branchIds))
            if (groupIds.length > 0) conditions.push(inArray(branches.groupId, groupIds))
        } else {
            const branchId = Number(currentUser?.branchId ?? sessionUser.branchId)
            if (!Number.isInteger(branchId) || branchId <= 0) {
                return NextResponse.json({ error: "Branch context missing" }, { status: 403 })
            }
            conditions.push(eq(orders.branchId, branchId))
        }

        if (startDate) {
            const start = parseStartDateParam(startDate)
            if (start) conditions.push(gte(refunds.createdAt, start))
        }
        if (endDate) {
            const end = parseEndDateParam(endDate)
            if (end) conditions.push(lte(refunds.createdAt, end))
        }
        if (status && status !== "ALL") {
            conditions.push(eq(sql`UPPER(${refunds.status})`, status))
        }
        if (refundType === "FULL") {
            conditions.push(gte(refunds.amountCents, orders.totalCents))
        } else if (refundType === "PARTIAL") {
            conditions.push(sql`${refunds.amountCents} < ${orders.totalCents}`)
        }
        if (query) {
            const escapedQuery = query.replace(/[\\%_]/g, String.raw`\$&`)
            const pattern = `%${escapedQuery}%`
            conditions.push(or(
                ilike(refunds.refundNumber, pattern),
                ilike(orders.tid, pattern),
                ilike(refunds.reason, pattern),
                ilike(orders.refundReason, pattern),
                ilike(requestedByUsers.fullName, pattern),
                ilike(requestedByUsers.employeeId, pattern),
                ilike(processedByUsers.fullName, pattern),
            ))
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined
        const pricesHidden = await shouldHidePricesForRole(
            role,
            currentUser?.organizationId ?? sessionUser.organizationId,
        )
        const respond = (payload: Record<string, unknown>) => NextResponse.json(
            pricesHidden
                ? redactAnalyticsPrices({ ...payload, pricesHidden: true })
                : { ...payload, pricesHidden: false },
        )

        const [totalRows, summaryRows, refundRows] = await Promise.all([
            db.select({ total: count(refunds.id) })
                .from(refunds)
                .innerJoin(orders, eq(refunds.orderId, orders.id))
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .leftJoin(groups, eq(branches.groupId, groups.id))
                .leftJoin(organizations, eq(orders.organizationId, organizations.id))
                .leftJoin(requestedByUsers, eq(refunds.requestedByUserId, requestedByUsers.id))
                .leftJoin(processedByUsers, eq(refunds.processedByUserId, processedByUsers.id))
                .where(whereClause),
            db.select({
                totalRefunds: count(refunds.id),
                approvedRefunds: sql<number>`COUNT(CASE WHEN UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED') THEN 1 END)`.mapWith(Number),
                pendingRefunds: sql<number>`COUNT(CASE WHEN UPPER(${refunds.status}) = 'PENDING' THEN 1 END)`.mapWith(Number),
                cancelledRefunds: sql<number>`COUNT(CASE WHEN UPPER(${refunds.status}) = 'CANCELLED' THEN 1 END)`.mapWith(Number),
                approvedAmountCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED') THEN ${refunds.amountCents} ELSE 0 END), 0)`.mapWith(Number),
                pendingAmountCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${refunds.status}) = 'PENDING' THEN ${refunds.amountCents} ELSE 0 END), 0)`.mapWith(Number),
            })
                .from(refunds)
                .innerJoin(orders, eq(refunds.orderId, orders.id))
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .leftJoin(groups, eq(branches.groupId, groups.id))
                .leftJoin(organizations, eq(orders.organizationId, organizations.id))
                .leftJoin(requestedByUsers, eq(refunds.requestedByUserId, requestedByUsers.id))
                .leftJoin(processedByUsers, eq(refunds.processedByUserId, processedByUsers.id))
                .where(whereClause),
            db.select({
                id: refunds.id,
                refundNumber: refunds.refundNumber,
                amountCents: refunds.amountCents,
                taxRefundCents: refunds.taxRefundCents,
                reason: sql<string | null>`COALESCE(
                    NULLIF(BTRIM(${refunds.reason}), ''),
                    NULLIF(BTRIM(${orders.refundReason}), '')
                )`,
                status: refunds.status,
                createdAt: refunds.createdAt,
                updatedAt: refunds.updatedAt,
                orderId: orders.id,
                tid: orders.tid,
                orderStatus: orders.status,
                statusAtRefund: orders.statusAtRefund,
                paymentStatus: orders.paymentStatus,
                orderCreatedAt: orders.createdAt,
                orderTotalCents: orders.totalCents,
                organizationId: orders.organizationId,
                organizationName: organizations.name,
                groupId: groups.id,
                groupName: groups.name,
                branchId: branches.id,
                branchName: branches.name,
                requestedByName: requestedByUsers.fullName,
                requestedByEmail: requestedByUsers.email,
                requestedByEmployeeId: requestedByUsers.employeeId,
                processedByName: processedByUsers.fullName,
                processedByEmail: processedByUsers.email,
                quantityRefunded: sql<number>`(
                    SELECT COALESCE(SUM(${refundItems.quantity}), 0)
                    FROM ${refundItems}
                    WHERE ${refundItems.refundId} = ${refunds.id}
                )`.mapWith(Number),
                itemCount: sql<number>`(
                    SELECT COUNT(*)
                    FROM ${refundItems}
                    WHERE ${refundItems.refundId} = ${refunds.id}
                )`.mapWith(Number),
            })
                .from(refunds)
                .innerJoin(orders, eq(refunds.orderId, orders.id))
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .leftJoin(groups, eq(branches.groupId, groups.id))
                .leftJoin(organizations, eq(orders.organizationId, organizations.id))
                .leftJoin(requestedByUsers, eq(refunds.requestedByUserId, requestedByUsers.id))
                .leftJoin(processedByUsers, eq(refunds.processedByUserId, processedByUsers.id))
                .where(whereClause)
                .orderBy(desc(refunds.createdAt), desc(refunds.id))
                .limit(limit)
                .offset(offset),
        ])

        const refundIds = refundRows.map((refund) => refund.id)
        const itemRows = refundIds.length > 0
            ? await db
                .select({
                    refundId: refundItems.refundId,
                    orderItemId: refundItems.orderItemId,
                    productName: orderItems.productName,
                    productCode: orderItems.productCode,
                    unit: orderItems.unit,
                    quantity: refundItems.quantity,
                    amountCents: refundItems.amountCents,
                })
                .from(refundItems)
                .innerJoin(orderItems, eq(refundItems.orderItemId, orderItems.id))
                .where(inArray(refundItems.refundId, refundIds))
                .orderBy(refundItems.id)
            : []

        const itemsByRefund = new Map<number, typeof itemRows>()
        itemRows.forEach((item) => {
            const existing = itemsByRefund.get(item.refundId) || []
            existing.push(item)
            itemsByRefund.set(item.refundId, existing)
        })

        const items = refundRows.map((refund) => ({
            ...refund,
            refundNumber: refund.refundNumber || `Refund-${String(refund.id).padStart(6, "0")}`,
            refundType: Number(refund.amountCents) >= Number(refund.orderTotalCents) ? "FULL" : "PARTIAL",
            itemRefundCents: Math.max(0, Number(refund.amountCents) - Number(refund.taxRefundCents || 0)),
            items: itemsByRefund.get(refund.id) || [],
        }))
        const total = Number(totalRows[0]?.total || 0)

        return respond({
            items,
            count: total,
            summary: summaryRows[0] || {
                totalRefunds: 0,
                approvedRefunds: 0,
                pendingRefunds: 0,
                cancelledRefunds: 0,
                approvedAmountCents: 0,
                pendingAmountCents: 0,
            },
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: page * limit < total,
            },
        })
    } catch (error) {
        console.error("[Analytics Refunds] Error:", error)
        return NextResponse.json({ error: "Failed to fetch refund report" }, { status: 500 })
    }
}
