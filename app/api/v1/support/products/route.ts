import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"

import { globalProducts, organizationInventory } from "@/db/schema"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { isSupportParticipantRole } from "@/lib/support-access"
import { supportViewerFromSession } from "@/lib/server/support-session"
import { escapeLikePattern } from "@/lib/utils"

/**
 * The products a requester may cite on a support query.
 *
 * Deliberately narrow. The organization comes from the session and there is no
 * parameter for it, so this cannot be pointed at another tenant's catalogue.
 * The only input is a search term, and it is used as a bound `ILIKE` pattern.
 *
 * Three fields come back — id, code, name — and no price. Who may see a price
 * is `lib/price-visibility.ts`'s business, and a picker has no need of one, so
 * the question is avoided rather than answered.
 *
 * `/api/v1/inventory/organization-products` was not reused: it returns the whole
 * catalogue with pricing, cached per role, which is far more than this needs and
 * more than a requester should receive.
 *
 * The catalogue is `organization_inventory` — the table the Super Admin
 * assignment endpoint writes and `/api/v1/branch/inventory` reads to build the
 * store, so the picker offers exactly what the requester can order. The
 * similarly named `organization_products` is written by nothing but the
 * K-Electric sync; searching it returned an empty list for every tenant whose
 * catalogue was assigned through the application.
 */

/** Bounded so the endpoint cannot be used to walk a catalogue. */
const RESULT_LIMIT = 20
const QUERY_MAX_LENGTH = 100

/** Escapes the wildcards so a search for "50%" means what it says. */
function likePattern(term: string): string {
  return `%${escapeLikePattern(term)}%`
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const viewer = supportViewerFromSession(session)
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("search", viewer.userId)
    if (rateLimit) return rateLimit

    // Apricart holds no catalogue of its own — it answers threads rather than
    // raising them — so an absent organization is an empty list, never every
    // organization's products.
    const organizationId = viewer.organizationId
    if (!organizationId) return NextResponse.json({ items: [] })

    const term = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, QUERY_MAX_LENGTH)

    const conditions: SQL[] = [
      eq(organizationInventory.organizationId, organizationId),
      eq(organizationInventory.isActive, true),
      isNull(organizationInventory.deletedAt),
      eq(globalProducts.status, "active"),
      isNull(globalProducts.deletedAt),
    ]

    if (term) {
      const pattern = likePattern(term)
      conditions.push(
        or(
          ilike(globalProducts.productCode, pattern),
          ilike(globalProducts.name, pattern),
          ilike(organizationInventory.customName, pattern),
        )!,
      )
    }

    const items = await db
      .select({
        id: globalProducts.id,
        productCode: globalProducts.productCode,
        name: globalProducts.name,
        customName: organizationInventory.customName,
      })
      .from(globalProducts)
      .innerJoin(
        organizationInventory,
        eq(organizationInventory.globalProductId, globalProducts.id),
      )
      .where(and(...conditions))
      .orderBy(asc(globalProducts.productCode))
      .limit(RESULT_LIMIT)

    return NextResponse.json(
      {
        items: items.map((item) => ({
          id: item.id,
          productCode: item.productCode,
          // The tenant's own name for it wins, as it does everywhere else.
          name: item.customName?.trim() || item.name,
        })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/support/products")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
