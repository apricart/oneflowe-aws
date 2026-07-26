import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { branchProducts, globalProducts, organizationProducts, auditLogs, categories } from "@/db/schema"
import { eq, and, sql } from "drizzle-orm"
import { getCached, invalidateByPrefix, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { branchProductUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

// GET /api/v1/inventory/branch-products - Get products for branch
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    const userOrgId = (session.user as any).organizationId
    const userBranchId = (session.user as any).branchId

    const { searchParams } = new URL(req.url)
    const branchId = searchParams.get("branchId")
    const organizationId = searchParams.get("organizationId")

    if (!branchId || !organizationId) {
      return NextResponse.json({ error: "Branch ID and Organization ID are required" }, { status: 400 })
    }

    // Access control: users can only view their own organization's branches
    // BRANCH_ADMIN can only view their own branch
    if (userRole === "BRANCH_ADMIN") {
      if (userBranchId !== parseInt(branchId) || userOrgId !== parseInt(organizationId)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
    } else if (userRole === "HEAD_OFFICE") {
      if (userOrgId !== parseInt(organizationId)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
    }
    // SUPER_ADMIN can view any branch

    const pricesHidden = await shouldHidePricesForRole(userRole, organizationId)
    const cacheKey = scopedCacheKey('inv:branch-products', { orgId: organizationId, branchId, role: userRole }, { pricesHidden })

    const items = await getCached(cacheKey, async () => {
      const isSuperAdmin = userRole === "SUPER_ADMIN"
      // Fetch all enabled organization products with branch-specific data
      const rows = await db
        .select({
          id: globalProducts.id,
          productCode: globalProducts.productCode,
          name: globalProducts.name,
          description: globalProducts.description,
          categoryId: globalProducts.categoryId,
          categoryName: categories.name,
          imageUrl: globalProducts.imageUrl,
          basePrice: isSuperAdmin ? globalProducts.basePrice : sql`NULL`,
          unit: globalProducts.unit,
          status: globalProducts.status,
          // Organization overrides
          customName: organizationProducts.customName,
          customDescription: organizationProducts.customDescription,
          customPrice: organizationProducts.customPrice,
          customImageUrl: organizationProducts.customImageUrl,
          // Branch specific (visibility + notes only)
          branchProductId: branchProducts.id,
          isAvailable: branchProducts.isAvailable,
          customNotes: branchProducts.customNotes
        })
        .from(globalProducts)
        .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
        .innerJoin(
          organizationProducts,
          and(
            eq(organizationProducts.globalProductId, globalProducts.id),
            eq(organizationProducts.organizationId, parseInt(organizationId)),
            eq(organizationProducts.isEnabled, true)
          )
        )
        .leftJoin(
          branchProducts,
          and(
            eq(branchProducts.globalProductId, globalProducts.id),
            eq(branchProducts.branchId, parseInt(branchId))
          )
        )
        .where(eq(globalProducts.status, "active"))
        .limit(1000)

      return pricesHidden
        ? rows.map((item) => ({ ...item, basePrice: null, customPrice: null }))
        : rows
    }, CACHE_TTL.INVENTORY)

    return NextResponse.json({ items, pricesHidden })
  } catch (error: any) {
    console.error("Error fetching branch products:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// PUT /api/v1/inventory/branch-products - Update branch product stock/availability
export async function PUT(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // RBAC: Only SUPER_ADMIN, HEAD_OFFICE, and BRANCH_ADMIN can update branch products
    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN" && userRole !== "HEAD_OFFICE" && userRole !== "BRANCH_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rawBody = await req.json().catch(() => null)
    const parsedBody = branchProductUpdateSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const input = parsedBody.data
    const { branchProductId, isAvailable, customNotes } = input

    const userOrgId = (session.user as any).organizationId
    const userBranchId = (session.user as any).branchId

    // Build ownership-scoped where clause
    const conditions = [eq(branchProducts.id, branchProductId)]

    // BOLA: Non-Super-Admin users must own the resource
    if (userRole === "HEAD_OFFICE") {
      if (!userOrgId) return NextResponse.json({ error: "Organization context required" }, { status: 400 })
      conditions.push(eq(branchProducts.organizationId, Number(userOrgId)))
    } else if (userRole === "BRANCH_ADMIN") {
      if (!userOrgId || !userBranchId) return NextResponse.json({ error: "Organization and branch context required" }, { status: 400 })
      conditions.push(eq(branchProducts.organizationId, Number(userOrgId)))
      conditions.push(eq(branchProducts.branchId, Number(userBranchId)))
    }

    // Update branch product with ownership check in WHERE clause
    const [updated] = await db.update(branchProducts)
      .set({
        isAvailable,
        customNotes,
        updatedByUserId: (session.user as any).id,
        updatedAt: new Date()
      })
      .where(and(...conditions))
      .returning()

    if (!updated) {
      return NextResponse.json({ error: "Branch product not found or access denied" }, { status: 404 })
    }

    // Log audit
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      organizationId: updated.organizationId,
      branchId: updated.branchId,
      action: "update_branch_product",
      entity: "branch_products",
      entityId: branchProductId.toString(),
      metadata: { changedFields: Object.keys(input) }
    })
    // Invalidate branch-products cache so data refreshes immediately
    await invalidateByPrefix('inv:branch-products')

    return NextResponse.json({ product: updated })
  } catch (error: any) {
    console.error("Error updating branch product:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

