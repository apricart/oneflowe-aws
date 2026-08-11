import { NextRequest,NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { modifiers,productModifiers } from "@/db/schema"
import { eq,and,like,or,desc,sql } from "drizzle-orm"
import { escapeLikePattern } from "@/lib/utils"

// GET /api/v1/modifiers - List all modifiers with search/filter
export async function GET(req: NextRequest) {
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
    const searchRaw = searchParams.get("search") || ""
    const search = searchRaw ? escapeLikePattern(searchRaw) : "" // Sanitize LIKE patterns
    const type = searchParams.get("type") || ""
    const status = searchParams.get("status") || ""
    const page = Number.parseInt(searchParams.get("page") || "1")
    const limit = Number.parseInt(searchParams.get("limit") || "50")
    const offset = (page - 1) * limit

    // Build where clause
    const conditions = []
    if (search) {
      conditions.push(
        or(
          like(modifiers.name, `%${search}%`),
          like(modifiers.description, `%${search}%`)
        )
      )
    }
    if (type) {
      conditions.push(eq(modifiers.type, type))
    }
    if (status) {
      conditions.push(eq(modifiers.status, status))
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    // Fetch modifiers with usage count
    const [items, totalResult] = await Promise.all([
      db
        .select({
          id: modifiers.id,
          name: modifiers.name,
          description: modifiers.description,
          type: modifiers.type,
          status: modifiers.status,
          createdAt: modifiers.createdAt,
          updatedAt: modifiers.updatedAt,
          usageCount: sql<number>`(
            SELECT COUNT(*)::int 
            FROM ${productModifiers} 
            WHERE modifier_id = ${modifiers.id}
          )`,
        })
        .from(modifiers)
        .where(whereClause)
        .orderBy(desc(modifiers.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(modifiers)
        .where(whereClause)
    ])

    const total = totalResult[0]?.count || 0

    return NextResponse.json({
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error("Modifiers GET error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// POST /api/v1/modifiers - Create modifier
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
    const { name, description, type, status } = body

    if (!name || name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 })
    }

    if (!type || type.trim().length === 0) {
      return NextResponse.json({ error: "Type is required" }, { status: 400 })
    }

    // Check if modifier with same name and type already exists
    const existingModifier = await db
      .select()
      .from(modifiers)
      .where(and(
        eq(modifiers.name, name.trim()),
        eq(modifiers.type, type.trim())
      ))
      .limit(1)

    if (existingModifier.length > 0) {
      return NextResponse.json({ error: "Modifier with this name and type already exists" }, { status: 409 })
    }

    const newModifier = await db
      .insert(modifiers)
      .values({
        name: name.trim(),
        description: description?.trim() || null,
        type: type.trim(),
        status: status || "active",
        createdByUserId: (session.user as any).id,
      })
      .returning()

    return NextResponse.json({ item: newModifier[0] }, { status: 201 })
  } catch (error) {
    console.error("Modifiers POST error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// PUT /api/v1/modifiers - Update modifier
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
    const { id, name, description, type, status } = body

    if (!id) {
      return NextResponse.json({ error: "Modifier ID is required" }, { status: 400 })
    }

    if (!name || name.trim().length === 0) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 })
    }

    if (!type || type.trim().length === 0) {
      return NextResponse.json({ error: "Type is required" }, { status: 400 })
    }

    // Check if modifier exists
    const existingModifier = await db
      .select()
      .from(modifiers)
      .where(eq(modifiers.id, id))
      .limit(1)

    if (existingModifier.length === 0) {
      return NextResponse.json({ error: "Modifier not found" }, { status: 404 })
    }

    // Check if another modifier with same name and type already exists
    const duplicateModifier = await db
      .select()
      .from(modifiers)
      .where(and(
        eq(modifiers.name, name.trim()),
        eq(modifiers.type, type.trim()),
        sql`${modifiers.id} != ${id}`
      ))
      .limit(1)

    if (duplicateModifier.length > 0) {
      return NextResponse.json({ error: "Modifier with this name and type already exists" }, { status: 409 })
    }

    const updatedModifier = await db
      .update(modifiers)
      .set({
        name: name.trim(),
        description: description?.trim() || null,
        type: type.trim(),
        status: status || "active",
        updatedAt: new Date(),
      })
      .where(eq(modifiers.id, id))
      .returning()

    return NextResponse.json({ item: updatedModifier[0] })
  } catch (error) {
    console.error("Modifiers PUT error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// DELETE /api/v1/modifiers - Delete modifier
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
      return NextResponse.json({ error: "Modifier ID is required" }, { status: 400 })
    }

    // Check if modifier exists
    const existingModifier = await db
      .select()
      .from(modifiers)
      .where(eq(modifiers.id, Number.parseInt(id)))
      .limit(1)

    if (existingModifier.length === 0) {
      return NextResponse.json({ error: "Modifier not found" }, { status: 404 })
    }

    // Check if modifier is being used by any products
    const productUsage = await db
      .select()
      .from(productModifiers)
      .where(eq(productModifiers.modifierId, Number.parseInt(id)))
      .limit(1)

    if (productUsage.length > 0) {
      return NextResponse.json({ error: "Cannot delete modifier that is being used by products" }, { status: 400 })
    }

    await db
      .delete(modifiers)
      .where(eq(modifiers.id, Number.parseInt(id)))

    return NextResponse.json({ message: "Modifier deleted successfully" })
  } catch (error) {
    console.error("Modifiers DELETE error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
