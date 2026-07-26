import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { groups, groupAuditLogs, branches, organizations } from "@/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { getCached, invalidateByPrefix, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import { groupCreateSchema, validationMessage } from "@/lib/server/mutation-validation"

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const role = (session.user as any).role
        let orgId = role === "SUPER_ADMIN" ? null : (session.user as any).organizationId
        const { searchParams } = new URL(req.url)
        const orgIdParam = searchParams.get("organizationId")

        // For admin users using context selector, accept organizationId from query param
        if (orgIdParam && role === "SUPER_ADMIN") {
            const parsedOrgId = parseInt(orgIdParam)
            if (Number.isFinite(parsedOrgId)) {
                orgId = parsedOrgId
            }
        }

        if (!orgId && role !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Organization ID required" }, { status: 400 })
        }

        const cacheKey = scopedCacheKey('groups', { orgId: orgId })

        const allGroups = await getCached(cacheKey, async () => {
            return db
                .select({
                    id: groups.id,
                    organizationId: groups.organizationId,
                    organizationName: organizations.name,
                    name: groups.name,
                    description: groups.description,
                    status: sql<string>`CASE 
                        WHEN ${groups.status} = 'deleted' THEN 'deleted'
                        WHEN count(${branches.id}) > 0 THEN 'connected'
                        ELSE 'not connected'
                    END`,
                    createdAt: groups.createdAt,
                    updatedAt: groups.updatedAt,
                    branchCount: sql<number>`count(${branches.id})::int`,
                })
                .from(groups)
                .innerJoin(organizations, eq(groups.organizationId, organizations.id))
                .leftJoin(branches, eq(branches.groupId, groups.id))
                .where(
                    and(
                        orgId ? eq(groups.organizationId, orgId) : undefined,
                        sql`${groups.status} != 'deleted'`
                    )
                )
                .groupBy(groups.id, organizations.id)
                .orderBy(groups.name)
        }, CACHE_TTL.LISTING)

        return NextResponse.json({ groups: allGroups })
    } catch (e: any) {
        console.error("Error fetching groups:", e)
        return NextResponse.json({
            error: "Failed to fetch groups",
            details: "Request failed"
        }, { status: 500 })
    }
}

export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const role = (session.user as any).role
        const userId = (session.user as any).id
        const userOrgId = (session.user as any).organizationId

        // Only Super Admin and Head Office can create groups
        if (role !== "SUPER_ADMIN" && role !== "HEAD_OFFICE") {
            return NextResponse.json({ error: "Forbidden: Insufficient permissions" }, { status: 403 })
        }

        const rawBody = await req.json().catch(() => null)
        const parsedBody = groupCreateSchema.safeParse(rawBody)
        if (!parsedBody.success) {
            return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
        }
        let { organizationId } = parsedBody.data
        const { name, description } = parsedBody.data

        // Security: Head Office can only create groups in their own organization
        if (role === "HEAD_OFFICE") {
            organizationId = userOrgId
        }

        if (!organizationId || !name) {
            return NextResponse.json({ error: "Organization ID and name are required" }, { status: 400 })
        }

        // Check if group already exists for this organization (case-insensitive)
        const [existingGroup] = await db
            .select()
            .from(groups)
            .where(
                and(
                    eq(groups.organizationId, organizationId),
                    sql`lower(${groups.name}) = lower(${name})`,
                    sql`${groups.status} != 'deleted'`
                )
            )
            .limit(1)

        if (existingGroup) {
            return NextResponse.json({ error: `A group named "${name}" already exists.` }, { status: 409 })
        }

        // Create group
        const [newGroup] = await db.insert(groups).values({
            organizationId,
            name,
            description,
            status: "not connected",
            createdByUserId: userId,
        }).returning()

        // Log action
        await db.insert(groupAuditLogs).values({
            organizationId,
            groupId: newGroup.id,
            action: "CREATE_GROUP",
            performedByUserId: userId,
            performedByRole: role,
            metadata: { name, description },
        })

        // Invalidate all group-related caches (list and counts)
        await invalidateByPrefix('group')

        return NextResponse.json({ group: newGroup })
    } catch (e: any) {
        console.error("Error creating group:", e)
        return NextResponse.json({
            error: "Internal Server Error",
            details: "Request failed"
        }, { status: 500 })
    }
}
