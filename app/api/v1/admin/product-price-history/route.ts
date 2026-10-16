import { viewerReadRole } from "@/lib/viewer-access"
import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import type { ProductPriceHistoryRole } from "@/lib/product-price-history"
import { loadProductPriceHistory, type ProductPriceHistoryAccess } from "@/lib/server/product-price-history"

const ALLOWED_ROLES = new Set<ProductPriceHistoryRole>(["SUPER_ADMIN", "HEAD_OFFICE"])

async function getProductPriceHistory(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const actor = session.user as { role?: string; organizationId?: number | string | null; branchId?: number | null }
  // An organization-wide Viewer reads its tenant's history as Head Office does;
  // a pinned one is refused. Everything below reads `role`, never `actor.role`,
  // because the fallback at the end is Super Admin's unfenced access.
  const role = viewerReadRole(actor)
  if (!role || !ALLOWED_ROLES.has(role as ProductPriceHistoryRole)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const sessionOrganizationId = Number(actor.organizationId)
  if (role === "HEAD_OFFICE" && (!Number.isSafeInteger(sessionOrganizationId) || sessionOrganizationId <= 0)) {
    return NextResponse.json({ error: "Organization context required" }, { status: 403 })
  }
  const access: ProductPriceHistoryAccess = role === "HEAD_OFFICE"
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
