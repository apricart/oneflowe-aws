import { VIEWER_READ_REFUSED, viewerReadRole } from "@/lib/viewer-access"
import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { globalProducts, organizationInventory, branchInventory, branches } from "@/db/schema"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { resolveAnalyticsOrganizationIds } from "@/lib/server/analytics-scope"
import { fenceBranchIdsToOrganization } from "@/lib/server/user-analytics-branch-scope"
import { resolveFinanceReadScope } from "@/lib/server/finance-scope"

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const url = new URL(req.url)
        const organizationIdsParam = url.searchParams.get("organizationIds")
        const groupIdsParam = url.searchParams.get("groupIds")
        const branchIdsParam = url.searchParams.get("branchIds")

        // An organization-wide Viewer reads as Head Office; a pinned one is refused.
        let role = viewerReadRole(session.user as any)
        if (!role) return NextResponse.json({ error: VIEWER_READ_REFUSED }, { status: 403 })
        const userOrganizationId = (session.user as any).organizationId
        // Which products a tenant has assigned is the tenant's own business:
        // anyone but Super Admin filters by its own organization only.
        const requestedOrganizationIds = organizationIdsParam ? organizationIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n)) : []
        // Finance reads as Super Admin, inside the organizations assigned to it.
        const financeScope = await resolveFinanceReadScope({ role, userId: (session.user as any).id, requestedOrganizationIds })
        if (financeScope && !financeScope.ok) return NextResponse.json({ error: financeScope.error }, { status: financeScope.status })
        if (financeScope) role = "SUPER_ADMIN"
        let organizationIds = role === "SUPER_ADMIN" || requestedOrganizationIds.length === 0
            ? requestedOrganizationIds
            : resolveAnalyticsOrganizationIds({ role, userOrganizationId, requestedOrganizationIds })
        if (financeScope) organizationIds = financeScope.organizationIds
        const groupIds = groupIdsParam ? groupIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n)) : []
        let branchIds = branchIdsParam ? branchIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n)) : []

        // If groupIds provided but no branchIds, find all branches in those groups
        if (groupIds.length > 0 && branchIds.length === 0) {
            const groupBranches = await db.select({ id: branches.id })
                .from(branches)
                .where(inArray(branches.groupId, groupIds))
            branchIds = groupBranches.map(b => b.id)
        }

        const requestedAnyBranch = branchIds.length > 0
        branchIds = await fenceBranchIdsToOrganization({ role, userOrganizationId, branchIds })
        if (financeScope && branchIds.length > 0) {
            const fenced = await db.select({ id: branches.id }).from(branches)
                .where(and(inArray(branches.id, branchIds), inArray(branches.organizationId, financeScope.organizationIds)))
            const reachable = new Set(fenced.map((branch) => branch.id))
            branchIds = branchIds.filter((branchId) => reachable.has(branchId))
        }
        if (requestedAnyBranch && branchIds.length === 0) return NextResponse.json({ items: [] })

        const conditions: any[] = [isNull(globalProducts.deletedAt)]

        // Simpler approach: filter by availability if needed, but the user just wants the "Product Names" 
        // that are relevant to the selected context.
        // For Product Intelligence, we usually show all products that have ever been ordered in that context, 
        // or all products assigned to that context.
        
        // Let's just return all non-deleted products for now, as most products are global.
        // If we want to be specific:
        if (branchIds.length > 0) {
            const assignedProducts = await db.select({ id: globalProducts.id })
                .from(branchInventory)
                .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
                .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
                .where(and(inArray(branchInventory.branchId, branchIds), eq(branchInventory.isActive, true)))
            
            const ids = assignedProducts.map(p => p.id)
            if (ids.length > 0) conditions.push(inArray(globalProducts.id, ids))
            else return NextResponse.json({ items: [] })
        } else if (organizationIds.length > 0) {
            const assignedProducts = await db.select({ id: globalProducts.id })
                .from(organizationInventory)
                .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
                .where(and(inArray(organizationInventory.organizationId, organizationIds), eq(organizationInventory.isActive, true)))
            
            const ids = assignedProducts.map(p => p.id)
            if (ids.length > 0) conditions.push(inArray(globalProducts.id, ids))
            else return NextResponse.json({ items: [] })
        }

        const items = await db.select({
            id: globalProducts.id,
            name: globalProducts.name,
            productCode: globalProducts.productCode,
        }).from(globalProducts)
          .where(and(...conditions))
          .orderBy(globalProducts.name)
          .limit(1000)

        return NextResponse.json({ items })
    } catch (error) {
        console.error("Failed to fetch product list:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
