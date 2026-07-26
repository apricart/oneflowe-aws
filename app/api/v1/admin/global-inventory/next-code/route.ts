import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, isNull, sql } from "drizzle-orm"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { globalProducts } from "@/db/schema"
import { getNextCanonicalProductCode } from "@/lib/product-code"

async function productCodeExists(productCode: string) {
  const [existingProduct] = await db
    .select({ id: globalProducts.id })
    .from(globalProducts)
    .where(
      and(
        sql`lower(btrim(${globalProducts.productCode})) = lower(btrim(${productCode}))`,
        isNull(globalProducts.deletedAt)
      )
    )
    .limit(1)

  return Boolean(existingProduct)
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const catalogProducts = await db
      .select({
        productCode: globalProducts.productCode,
      })
      .from(globalProducts)
      .where(isNull(globalProducts.deletedAt))

    const observedProductCodes = catalogProducts.map(({ productCode }) => productCode)
    let productCode = getNextCanonicalProductCode(observedProductCodes)
    let attempts = 0

    while (await productCodeExists(productCode)) {
      observedProductCodes.push(productCode)
      productCode = getNextCanonicalProductCode(observedProductCodes)
      attempts += 1

      if (attempts >= 100) {
        return NextResponse.json(
          { error: "Unable to generate a unique product code" },
          { status: 409 }
        )
      }
    }

    return NextResponse.json(
      { productCode },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error: any) {
    console.error("Error generating next product code:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
