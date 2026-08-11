import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { users, branches, roles } from "@/db/schema"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userRole = ((session.user as any).role || "").toUpperCase().replace(/\s+/g, '_')
        const userOrgId = (session.user as any).organizationId
        const userBranchId = (session.user as any).branchId

        const url = new URL(req.url)
        const organizationIdsParam = url.searchParams.get("organizationIds")
        const groupIdsParam = url.searchParams.get("groupIds")
        const branchIdsParam = url.searchParams.get("branchIds")

        let organizationIds: number[] = []
        if (organizationIdsParam) {
            organizationIds = organizationIdsParam.split(",").map(Number).filter(id => !Number.isNaN(id) && id > 0)
        } else if (userOrgId) {
            organizationIds = [userOrgId]
        }

        let branchIds: number[] = []
        if (branchIdsParam) {
            branchIds = branchIdsParam.split(",").map(Number).filter(id => !Number.isNaN(id) && id > 0)
        } else if (groupIdsParam) {
            const gIds = groupIdsParam.split(",").map(Number).filter(id => !Number.isNaN(id) && id > 0)
            if (gIds.length > 0) {
                const b = await db.select({ id: branches.id }).from(branches).where(inArray(branches.groupId, gIds))
                branchIds = b.map(br => br.id)
            }
        } 
        
        // If still no branchIds but we have org, and we are NOT branch admin, resolve all branches in org
        if (branchIds.length === 0 && organizationIds.length > 0 && userRole !== "BRANCH_ADMIN" && userRole !== "BRANCH_MANAGER") {
             const b = await db.select({ id: branches.id }).from(branches).where(inArray(branches.organizationId, organizationIds))
             branchIds = b.map(br => br.id)
        } else if (branchIds.length === 0 && (userRole === "BRANCH_ADMIN" || userRole === "BRANCH_MANAGER")) {
             branchIds = [userBranchId]
        }

        const conditions: any[] = [isNull(users.deletedAt)]
        
        // Final guard: unless Super Admin, must be restricted to Org at minimum
        if (userRole !== "SUPER_ADMIN") {
            conditions.push(eq(users.organizationId, userOrgId))
        } else if (organizationIds.length > 0) {
            conditions.push(inArray(users.organizationId, organizationIds))
        }

        if (branchIds.length > 0) {
            conditions.push(inArray(users.branchId, branchIds))
        }

        const items = await db
            .select({
                id: users.id,
                name: sql<string>`COALESCE(${users.fullName}, ${users.firstName} || ' ' || ${users.lastName}, ${users.email})`,
                employeeId: users.employeeId,
                branchId: users.branchId,
                organizationId: users.organizationId
            })
            .from(users)
            .innerJoin(roles, eq(users.roleId, roles.id))
            .where(and(...conditions, eq(roles.name, "ORDER_PORTAL")))
            .groupBy(users.id, users.fullName, users.firstName, users.lastName, users.email, users.employeeId, users.branchId, users.organizationId)
            .orderBy(users.fullName)
            .limit(1000)

        return NextResponse.json({ items })
    } catch (error: any) {
        console.error("User filter list fetch failed: ", error)
        return NextResponse.json({ error: "Failed to fetch user list" }, { status: 500 })
    }
}
