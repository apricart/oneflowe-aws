import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { categories, globalProducts } from "@/db/schema"
import { eq, and, desc, sql, isNull } from "drizzle-orm"
import { escapeLikePattern } from "@/lib/utils"
import { getCached, invalidateByPrefix, CACHE_TTL } from "@/lib/cache-utils"

// GET /api/v1/categories - List all categories with optional filtering
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    // Allow Super Admin, Head Office, and Branch Admin to list categories
    if (userRole !== "SUPER_ADMIN" && userRole !== "HEAD_OFFICE" && userRole !== "BRANCH_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const searchRaw = searchParams.get("search") || ""
    const normalizedSearch = searchRaw.trim().toLowerCase()
    const search = normalizedSearch ? escapeLikePattern(normalizedSearch) : "" // Sanitize LIKE patterns
    const page = Number.parseInt(searchParams.get("page") || "1")
    const limit = Number.parseInt(searchParams.get("limit") || "50")
    const offset = (page - 1) * limit

    // Build where clause - flat categories only (no parent)
    const conditions = [isNull(categories.parentId)]
    if (search) {
      conditions.push(sql`lower(${categories.name}) like ${("%" + String(search) + "%")}`)
    }

    const whereClause = and(...conditions)

    const cacheKey = `cache:categories:v2:search=${search}&page=${page}&limit=${limit}`

    const result = await getCached(cacheKey, async () => {
      const [items, totalResult] = await Promise.all([
        db
          .select({
            id: categories.id,
            name: categories.name,
            createdAt: categories.createdAt,
            updatedAt: categories.updatedAt,
            subcategoriesCount: sql<number>`(
              SELECT COALESCE(COUNT(*), 0)::int 
              FROM categories sub
              WHERE sub.parent_id = categories.id
            )`,
            productsCount: sql<number>`(
              SELECT COALESCE(COUNT(*), 0)::int 
              FROM global_products gp
              WHERE gp.category_id IN (
                SELECT sub.id 
                FROM categories sub 
                WHERE sub.parent_id = categories.id
              )
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

      const total = totalResult[0]?.count || 0
      return {
        items,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      }
    }, CACHE_TTL.STATIC)

    return NextResponse.json(result)
  } catch (error) {
    console.error("Categories GET error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// POST /api/v1/categories - Create new category
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
    const { name } = body

    if (!name || name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 })
    }

    // Check if category with same name already exists
    const existingCategory = await db
      .select()
      .from(categories)
      .where(and(
        eq(categories.name, name.trim()),
        isNull(categories.parentId)
      ))
      .limit(1)

    if (existingCategory.length > 0) {
      return NextResponse.json({ error: "Category with this name already exists" }, { status: 409 })
    }

    const newCategory = await db
      .insert(categories)
      .values({
        name: name.trim(),
        parentId: null, // Always null - no subcategories
        organizationId: null, // Global categories for Super Admin
      })
      .returning()

    await invalidateByPrefix('categories')
    await invalidateByPrefix('subcategories')

    return NextResponse.json({ item: newCategory[0] }, { status: 201 })
  } catch (error) {
    console.error("Categories POST error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// PUT /api/v1/categories - Update category
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
    const { id, name, parentId } = body

    if (!id) {
      return NextResponse.json({ error: "Category ID is required" }, { status: 400 })
    }

    if (!name || name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 })
    }

    // Check if category exists
    const existingCategory = await db
      .select()
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1)

    if (existingCategory.length === 0) {
      return NextResponse.json({ error: "Category not found" }, { status: 404 })
    }

    // Check if another category with same name already exists
    const duplicateCategory = await db
      .select()
      .from(categories)
      .where(and(
        eq(categories.name, name.trim()),
        parentId ? eq(categories.parentId, parentId) : isNull(categories.parentId),
        sql`${categories.id} != ${id}`
      ))
      .limit(1)

    if (duplicateCategory.length > 0) {
      return NextResponse.json({ error: "Category with this name already exists" }, { status: 409 })
    }

    // Validate parent category exists if parentId is provided
    if (parentId) {
      const parentCategory = await db
        .select()
        .from(categories)
        .where(eq(categories.id, parentId))
        .limit(1)

      if (parentCategory.length === 0) {
        return NextResponse.json({ error: "Parent category not found" }, { status: 404 })
      }

      // Prevent circular reference
      if (parentId === id) {
        return NextResponse.json({ error: "Category cannot be its own parent" }, { status: 400 })
      }
    }

    const updatedCategory = await db
      .update(categories)
      .set({
        name: name.trim(),
        parentId: parentId || null,
        updatedAt: new Date(),
      })
      .where(eq(categories.id, id))
      .returning()

    await invalidateByPrefix('categories')
    await invalidateByPrefix('subcategories')

    return NextResponse.json({ item: updatedCategory[0] })
  } catch (error) {
    console.error("Categories PUT error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// DELETE /api/v1/categories - Soft delete category
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
      return NextResponse.json({ error: "Category ID is required" }, { status: 400 })
    }

    // Check if category exists
    const existingCategory = await db
      .select()
      .from(categories)
      .where(eq(categories.id, Number.parseInt(id)))
      .limit(1)

    if (existingCategory.length === 0) {
      return NextResponse.json({ error: "Category not found" }, { status: 404 })
    }

    // Check if category has subcategories
    const subcategoryCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(categories)
      .where(eq(categories.parentId, Number.parseInt(id)))

    const subCount = subcategoryCount[0]?.count || 0
    if (subCount > 0) {
      return NextResponse.json({
        error: `Cannot delete category with ${subCount} subcategor${subCount > 1 ? 'ies' : 'y'}. Remove subcategories first.`,
        subcategoriesCount: subCount
      }, { status: 400 })
    }

    // Check if category has products
    const productCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(globalProducts)
      .where(eq(globalProducts.categoryId, Number.parseInt(id)))

    const prodCount = productCount[0]?.count || 0
    if (prodCount > 0) {
      return NextResponse.json({
        error: `Cannot delete category with ${prodCount} product${prodCount > 1 ? 's' : ''} directly assigned.`,
        productsCount: prodCount
      }, { status: 400 })
    }

    await db
      .delete(categories)
      .where(eq(categories.id, Number.parseInt(id)))

    await invalidateByPrefix('categories')
    await invalidateByPrefix('subcategories')

    return NextResponse.json({ message: "Category deleted successfully" })
  } catch (error) {
    console.error("Categories DELETE error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
