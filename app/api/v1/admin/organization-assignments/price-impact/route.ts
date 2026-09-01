import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { priceMutationFailure } from "@/lib/pricing-access"
import { loadPropagationContext } from "@/lib/server/group-price-propagation"

/**
 * What a pending organization price change would do to each group.
 *
 * Read-only. It returns the current state — the product's tiers and every group
 * of its organization with that group's own price — so the confirmation screen
 * can run the shared planner and show the outcome of each option before
 * anything is written.
 *
 * Gated by the same rule as the write it precedes: only a Super Admin may
 * change a price, so only a Super Admin is shown the consequences of doing so.
 * The organization is taken from the catalogue item itself, never from the
 * request, which is what keeps the group list inside one tenant.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const failure = priceMutationFailure((session.user as any).role)
    if (failure) {
      return NextResponse.json({ error: failure.message }, { status: failure.status })
    }

    const raw = new URL(req.url).searchParams.get("organizationInventoryId") || ""
    const organizationInventoryId = Number.parseInt(raw)
    if (!Number.isInteger(organizationInventoryId) || organizationInventoryId <= 0) {
      return NextResponse.json({ error: "A valid organizationInventoryId is required" }, { status: 400 })
    }

    const context = await loadPropagationContext(db, organizationInventoryId)
    if (!context) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 })
    }

    return NextResponse.json(context)
  } catch (error) {
    console.error("Failed to load group price impact:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
