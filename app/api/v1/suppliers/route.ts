import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { branches, suppliers } from "@/db/schema"
import { and, desc, eq } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { supplierCreateSchema, validationMessage } from "@/lib/server/mutation-validation"

export async function GET(req: Request) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (err) return err
  const { searchParams } = new URL(req.url)

  // BOLA: HEAD_OFFICE must be scoped to their own organization
  const scope = await getRequestScope()
  let organizationId = searchParams.get("organizationId")
  if (scope?.role === "HEAD_OFFICE") {
    // Force org from session, ignore query param
    organizationId = scope.organizationId ? String(scope.organizationId) : null
    if (!organizationId) return error("Organization context required", 400)
  }

  const branchId = searchParams.get("branchId")
  const where = [
    organizationId ? eq(suppliers.organizationId, Number(organizationId)) : undefined,
    branchId ? eq(suppliers.branchId, Number(branchId)) : undefined,
  ].filter(Boolean) as any
  try {
    const items = await db
      .select()
      .from(suppliers)
      .where(where.length ? and(...where) : (undefined as any))
      .orderBy(desc(suppliers.createdAt))
      .limit(500)
    return ok({ items })
  } catch (e: any) {
    if (e?.code === '42P01') {
      // relation does not exist (migrations not applied yet)
      return ok({ items: [] })
    }
    throw e
  }
}

export async function POST(req: Request) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (err) return err
  const rawBody = await readJson<unknown>(req)
  const parsedBody = supplierCreateSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const input = parsedBody.data

  const scope = await getRequestScope()
  if (scope?.role === "HEAD_OFFICE" && input.organizationId !== scope.organizationId) {
    return error("You can only create suppliers in your organization", 403)
  }

  const [branch] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(
      eq(branches.id, input.branchId),
      eq(branches.organizationId, input.organizationId),
    ))
    .limit(1)
  if (!branch) return error("Branch does not belong to the selected organization", 400)

  const [item] = await db
    .insert(suppliers)
    .values({
      organizationId: input.organizationId,
      branchId: input.branchId,
      name: input.name,
      address: input.address ?? null,
      contact: input.contact ?? null,
      email: input.email ?? null,
      description: input.description ?? null,
    })
    .returning()
  return ok({ item }, { status: 201 })
}

