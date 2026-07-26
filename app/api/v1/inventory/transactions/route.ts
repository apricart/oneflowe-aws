import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { inventory } from "@/db/schema"
import { and, desc, eq } from "drizzle-orm"

export async function GET(req: Request) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"]) 
  if (err) return err
  const { searchParams } = new URL(req.url)
  const branchId = searchParams.get("branchId")
  const type = (searchParams.get("type") || undefined) as any
  const limit = Math.min(Math.max(Math.trunc(Number(searchParams.get("limit"))) || 100, 1), 500)
  const where = [
    branchId ? eq(inventory.branchId, Number(branchId)) : undefined,
  ].filter(Boolean) as any
  const items = await db
    .select()
    .from(inventory)
    .where(where.length ? and(...where) : undefined as any)
    .orderBy(desc(inventory.updatedAt))
    .limit(limit)
  return ok({ items, limit })
}

export async function POST(req: Request) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"]) 
  if (err) return err
  const body = await readJson<any>(req)
  if (!body?.organizationId || !body?.branchId || !Array.isArray(body?.items) || !body?.type) {
    return error("organizationId, branchId, type, items are required", 400)
  }
  // Inventory adjustments by writing to inventory table per SKU
  // For now, respond 501 until full SKU mapping is ready
  return error("Not implemented: inventory transaction write path pending SKU mapping", 501)
}

