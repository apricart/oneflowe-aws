import { NextRequest,NextResponse } from "next/server"

// POST /api/v1/inventory/branch-products/restock - Deprecated: stock is global-only
export async function POST(req: NextRequest) {
  try {
    // Global-only stock: this endpoint is no longer supported
    return NextResponse.json(
      { error: "Per-branch restocking has been disabled. Update global product stock instead." },
      { status: 400 }
    )
  } catch (error: any) {
    console.error("Error restocking product:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

