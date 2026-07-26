import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { organizationProducts, globalProducts, auditLogs, branchInventory, branches } from "@/db/schema"
import { eq, and, sql, inArray, exists } from "drizzle-orm"
import { getCached, invalidateByPrefix, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { organizationProductUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

// GET /api/v1/inventory/organization-products - Get products for organization
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    const userOrgId = (session.user as any).organizationId

    const { searchParams } = new URL(req.url)
    const organizationId = searchParams.get("organizationId")
    const groupIds = searchParams.get("groupIds")
    const parsedOrgIds = organizationId ? organizationId.split(',').map(n => parseInt(n)).filter(n => !isNaN(n)) : []
    const parsedGroupIds = groupIds ? groupIds.split(',').map(n => parseInt(n)).filter(n => !isNaN(n)) : []

    // Access control: users can only view their own organization's products
    // except SUPER_ADMIN who can view any organization
    if (userRole !== "SUPER_ADMIN") {
      if (parsedOrgIds.length > 0 && !parsedOrgIds.includes(userOrgId)) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
    }

    const settingOrgId = parsedOrgIds[0] || userOrgId
    const pricesHidden = await shouldHidePricesForRole(userRole, settingOrgId)
    const cacheKey = scopedCacheKey('inv:org-products', { 
        orgId: parsedOrgIds.join(','),
        role: userRole
    }, { pricesHidden })

    const items = await getCached(cacheKey, async () => {
      const isSuperAdmin = userRole === "SUPER_ADMIN"
      const query = db
        .select({
          id: globalProducts.id,
          productCode: globalProducts.productCode,
          name: globalProducts.name,
          description: globalProducts.description,
          categoryId: globalProducts.categoryId,
          imageUrl: globalProducts.imageUrl,
          basePrice: isSuperAdmin ? globalProducts.basePrice : sql`NULL`,
          unit: globalProducts.unit,
          status: globalProducts.status,
          orgProductId: organizationProducts.id,
          isEnabled: organizationProducts.isEnabled,
          customName: organizationProducts.customName,
          customDescription: organizationProducts.customDescription,
          customPrice: organizationProducts.customPrice,
          customImageUrl: organizationProducts.customImageUrl,
          tags: organizationProducts.tags,
          priority: organizationProducts.priority
        })
        .from(globalProducts)

      if (parsedOrgIds.length === 1) {
        // Single organization: join and filter
        query.leftJoin(
          organizationProducts,
          and(
            eq(organizationProducts.globalProductId, globalProducts.id),
            eq(organizationProducts.organizationId, parsedOrgIds[0])
          )
        )
      } else if (parsedOrgIds.length > 1) {
        // Multiple organizations: might need to decide how to join (maybe just join first found? or skip org-specific data)
        // For now, let's join the first one for the names/prices if they exist
        query.leftJoin(
          organizationProducts,
          and(
            eq(organizationProducts.globalProductId, globalProducts.id),
            eq(organizationProducts.organizationId, parsedOrgIds[0])
          )
        )
      } else if (userOrgId) {
          // Default to user's org if none specified
          query.leftJoin(
            organizationProducts,
            and(
              eq(organizationProducts.globalProductId, globalProducts.id),
              eq(organizationProducts.organizationId, userOrgId)
            )
          )
      }

      const whereConditions = [eq(globalProducts.status, "active")]

      if (parsedGroupIds.length > 0) {
        // Filter by group-specific inventory
        whereConditions.push(
          exists(
            db.select()
              .from(branchInventory)
              .innerJoin(branches, eq(branchInventory.branchId, branches.id))
              .innerJoin(organizationProducts, eq(branchInventory.organizationInventoryId, organizationProducts.id))
              .where(
                and(
                  eq(organizationProducts.globalProductId, globalProducts.id),
                  inArray(branches.groupId, parsedGroupIds),
                  eq(branchInventory.isActive, true)
                )
              )
          )
        )
      } else if (parsedOrgIds.length > 0) {
          // If ONLY organization context is specified, only show products assigned to those organizations
          whereConditions.push(
              exists(
                  db.select()
                  .from(organizationProducts)
                  .where(and(
                      eq(organizationProducts.globalProductId, globalProducts.id),
                      inArray(organizationProducts.organizationId, parsedOrgIds)
                  ))
              )
          )
      }

      const rows = await query.where(and(...whereConditions)).limit(1000)
      return pricesHidden
        ? rows.map((item) => ({ ...item, basePrice: null, customPrice: null }))
        : rows
    }, CACHE_TTL.LISTING)

    return NextResponse.json({ items, pricesHidden })
  } catch (error: any) {
    console.error("Error fetching organization products:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// PUT /api/v1/inventory/organization-products/[id] - Update organization product settings
export async function PUT(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN" && userRole !== "HEAD_OFFICE") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rawBody = await req.json().catch(() => null)
    const parsedBody = organizationProductUpdateSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const input = parsedBody.data
    const { organizationProductId, isEnabled, customName, customDescription, customPrice, customImageUrl, tags, priority } = input

    // BOLA: Scope update to user's organization for non-SUPER_ADMIN
    const userOrgId = (session.user as any).organizationId
    const conditions = [eq(organizationProducts.id, organizationProductId)]

    if (userRole === "HEAD_OFFICE") {
      if (!userOrgId) return NextResponse.json({ error: "Organization context required" }, { status: 400 })
      conditions.push(eq(organizationProducts.organizationId, Number(userOrgId)))
    }

    // Update organization product with ownership scope
    const [updated] = await db.update(organizationProducts)
      .set({
        isEnabled,
        customName,
        customDescription,
        customPrice,
        customImageUrl,
        tags,
        priority,
        updatedByUserId: (session.user as any).id,
        updatedAt: new Date()
      })
      .where(and(...conditions))
      .returning()

    if (!updated) {
      return NextResponse.json({ error: "Organization product not found or access denied" }, { status: 404 })
    }

    // Log audit
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      organizationId: updated.organizationId,
      branchId: null,
      action: "update_org_product",
      entity: "organization_products",
      entityId: organizationProductId.toString(),
      metadata: { changedFields: Object.keys(input) }
    })

    // Invalidate inventory caches so data refreshes immediately
    await invalidateByPrefix('inv:org-products')
    await invalidateByPrefix('inv:branch-products')

    return NextResponse.json({ product: updated })
  } catch (error: any) {
    console.error("Error updating organization product:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

