import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { globalProducts, organizationInventory, branchInventory, branches } from "@/db/schema"
import { and, eq, inArray, isNull } from "drizzle-orm"

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const url = new URL(req.url)
        const organizationIdsParam = url.searchParams.get("organizationIds")
        const groupIdsParam = url.searchParams.get("groupIds")
        const branchIdsParam = url.searchParams.get("branchIds")

        let organizationIds = organizationIdsParam ? organizationIdsParam.split(",").map(Number).filter(n => !isNaN(n)) : []
        const groupIds = groupIdsParam ? groupIdsParam.split(",").map(Number).filter(n => !isNaN(n)) : []
        let branchIds = branchIdsParam ? branchIdsParam.split(",").map(Number).filter(n => !isNaN(n)) : []

        // If groupIds provided but no branchIds, find all branches in those groups
        if (groupIds.length > 0 && branchIds.length === 0) {
            const groupBranches = await db.select({ id: branches.id })
                .from(branches)
                .where(inArray(branches.groupId, groupIds))
            branchIds = groupBranches.map(b => b.id)
        }

        let query = db.select({
            id: globalProducts.id,
            name: globalProducts.name,
            productCode: globalProducts.productCode,
        }).from(globalProducts)

        const conditions: any[] = [isNull(globalProducts.deletedAt)]

        if (branchIds.length > 0) {
            query = query.innerJoin(branchInventory, eq(branchInventory.organizationInventoryId, globalProducts.id)) as any // Wait, check the join
            // Actually, branchInventory links to organizationInventory.id, which links to globalProducts.id
            // Let's re-verify the branchInventory join.
        }

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
