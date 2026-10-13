import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import type { ProductPriceHistoryRole } from "@/lib/product-price-history"
import { loadProductPriceHistory, type ProductPriceHistoryAccess } from "@/lib/server/product-price-history"

const ALLOWED_ROLES = new Set<ProductPriceHistoryRole>(["SUPER_ADMIN", "HEAD_OFFICE"])

async function getProductPriceHistory(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const actor = session.user as { role?: string; organizationId?: number | string | null }
  if (!ALLOWED_ROLES.has(actor.role as ProductPriceHistoryRole)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const sessionOrganizationId = Number(actor.organizationId)
  if (actor.role === "HEAD_OFFICE" && (!Number.isSafeInteger(sessionOrganizationId) || sessionOrganizationId <= 0)) {
    return NextResponse.json({ error: "Organization context required" }, { status: 403 })
  }
  const access: ProductPriceHistoryAccess = actor.role === "HEAD_OFFICE"
    ? { role: "HEAD_OFFICE", organizationId: sessionOrganizationId }
    : { role: "SUPER_ADMIN" }

  const result = await loadProductPriceHistory(request.nextUrl.searchParams, access)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result.body, { headers: { "Cache-Control": "private, no-store" } })
}

export async function GET(request: NextRequest) {
  try {
    return await getProductPriceHistory(request)
  } catch (error) {
    console.error("Failed to load product price history:", error)
    return NextResponse.json({ error: "Failed to load product price history" }, { status: 500 })
  }
}
