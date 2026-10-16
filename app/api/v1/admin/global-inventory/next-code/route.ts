import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { nextGlobalProductCode } from "@/lib/server/global-product-code"

// A preview only: POST /api/v1/admin/global-inventory assigns the code itself.
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

    const productCode = await nextGlobalProductCode()
    if (!productCode) {
      return NextResponse.json(
        { error: "Unable to generate a unique product code" },
        { status: 409 }
      )
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
