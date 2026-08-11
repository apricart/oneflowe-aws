import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { categories, globalProducts } from "@/db/schema"
import { eq, and, ilike, desc, sql, isNotNull } from "drizzle-orm"
import { getCached, invalidateByPrefix, CACHE_TTL } from "@/lib/cache-utils"

// GET /api/v1/subcategories - List subcategories
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN" && userRole !== "HEAD_OFFICE" && userRole !== "BRANCH_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const searchRaw = searchParams.get("search") || ""
    const search = searchRaw.trim().toLowerCase()
    const categoryId = searchParams.get("categoryId")
    const page = Number.parseInt(searchParams.get("page") || "1")
    const limit = Number.parseInt(searchParams.get("limit") || "50")
    const offset = (page - 1) * limit

    // Build where clause - subcategories have parentId set
    const conditions = [isNotNull(categories.parentId)]

    if (search) {
      const { escapeLikePattern } = await import("@/lib/utils")
      conditions.push(ilike(categories.name, `%${escapeLikePattern(search)}%`))
    }

    if (categoryId) {
      conditions.push(eq(categories.parentId, Number.parseInt(categoryId)))
    }

    const whereClause = and(...conditions)

    const cacheKey = `cache:subcategories:search=${search}&cat=${categoryId || ''}&page=${page}&limit=${limit}`

    const result = await getCached(cacheKey, async () => {
      const [items, totalResult] = await Promise.all([
        db
          .select({
            id: categories.id,
            name: categories.name,
            parentId: categories.parentId,
            createdAt: categories.createdAt,
            updatedAt: categories.updatedAt,
            productsCount: sql<number>`(
              SELECT COALESCE(COUNT(*), 0)::int 
              FROM global_products gp
              WHERE gp.category_id = categories.id
            )`,
          })
          .from(categories)
          .where(whereClause)
          .orderBy(desc(categories.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)` })
          .from(categories)
          .where(whereClause)
      ])

      // Get parent category names
      const parentIds = [...new Set(items.map(item => item.parentId).filter(Boolean))] as number[]
      let parentCategories: { id: number; name: string }[] = []

      if (parentIds.length > 0) {
        parentCategories = await db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(sql`${categories.id} IN (${sql.join(parentIds.map(id => sqlString(id)), sql.raw(", "))})`)
      }

      const parentMap = new Map(parentCategories.map(c => [c.id, c.name]))

      const enrichedItems = items.map(item => ({
        ...item,
        categoryName: item.parentId ? parentMap.get(item.parentId) || "Unknown" : null,
      }))

      const total = totalResult[0]?.count || 0

      return {
        items: enrichedItems,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      }
    }, CACHE_TTL.SETTINGS)

    return NextResponse.json(result)
  } catch (error) {
    console.error("Subcategories GET error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// POST /api/v1/subcategories - Create subcategory
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const body = await req.json()
    const { name, categoryId } = body

    if (!name || name.trim().length === 0) {
      return NextResponse.json({ error: "Subcategory name is required" }, { status: 400 })
    }

    if (!categoryId) {
      return NextResponse.json({ error: "Parent category is required" }, { status: 400 })
    }

    // Verify parent category exists
    const parentCategory = await db
      .select()
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1)

    if (parentCategory.length === 0) {
      return NextResponse.json({ error: "Parent category not found" }, { status: 404 })
    }

    // Check if subcategory with same name exists under this parent
    const existing = await db
      .select()
      .from(categories)
      .where(and(
        eq(categories.name, name.trim()),
        eq(categories.parentId, categoryId)
      ))
      .limit(1)

    if (existing.length > 0) {
      return NextResponse.json({ error: "Subcategory with this name already exists in this category" }, { status: 409 })
    }

    const newSubcategory = await db
      .insert(categories)
      .values({
        name: name.trim(),
        parentId: categoryId,
        organizationId: null,
      })
      .returning()

    await invalidateByPrefix('subcategories')
    await invalidateByPrefix('categories')

    return NextResponse.json({ item: newSubcategory[0] }, { status: 201 })
  } catch (error) {
    console.error("Subcategories POST error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// PUT /api/v1/subcategories - Update subcategory
export async function PUT(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const body = await req.json()
    const { id, name, categoryId } = body

    if (!id) {
      return NextResponse.json({ error: "Subcategory ID is required" }, { status: 400 })
    }

    if (!name || name.trim().length === 0) {
      return NextResponse.json({ error: "Subcategory name is required" }, { status: 400 })
    }

    // Check if subcategory exists
    const existing = await db
      .select()
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1)

    if (existing.length === 0) {
      return NextResponse.json({ error: "Subcategory not found" }, { status: 404 })
    }

    // Check for duplicate name
    const duplicate = await db
      .select()
      .from(categories)
      .where(and(
        eq(categories.name, name.trim()),
        eq(categories.parentId, categoryId || existing[0].parentId),
        sql`${categories.id} != ${id}`
      ))
      .limit(1)

    if (duplicate.length > 0) {
      return NextResponse.json({ error: "Subcategory with this name already exists" }, { status: 409 })
    }

    const updateData: { name: string; parentId?: number; updatedAt: Date } = {
      name: name.trim(),
      updatedAt: new Date(),
    }

    if (categoryId) {
      updateData.parentId = categoryId
    }

    const updated = await db
      .update(categories)
      .set(updateData)
      .where(eq(categories.id, id))
      .returning()

    await invalidateByPrefix('subcategories')
    await invalidateByPrefix('categories')

    return NextResponse.json({ item: updated[0] })
  } catch (error) {
    console.error("Subcategories PUT error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// DELETE /api/v1/subcategories - Delete subcategory
export async function DELETE(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "Subcategory ID is required" }, { status: 400 })
    }

    // Check if subcategory exists
    const existing = await db
      .select()
      .from(categories)
      .where(eq(categories.id, Number.parseInt(id)))
      .limit(1)

    if (existing.length === 0) {
      return NextResponse.json({ error: "Subcategory not found" }, { status: 404 })
    }

    // Check if subcategory has products
    const products = await db
      .select({ count: sql<number>`count(*)` })
      .from(globalProducts)
      .where(eq(globalProducts.categoryId, Number.parseInt(id)))

    const productCount = products[0]?.count || 0

    if (productCount > 0) {
      return NextResponse.json({
        error: `Cannot delete subcategory with ${productCount} product${productCount > 1 ? 's' : ''} assigned. Remove products first.`,
        productCount
      }, { status: 400 })
    }

    await db
      .delete(categories)
      .where(eq(categories.id, Number.parseInt(id)))

    await invalidateByPrefix('subcategories')
    await invalidateByPrefix('categories')

    return NextResponse.json({ message: "Subcategory deleted successfully" })
  } catch (error) {
    console.error("Subcategories DELETE error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
