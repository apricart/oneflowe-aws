import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { suppliers } from "@/db/schema"
import { eq } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { supplierUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { recordAuditEvent } from "@/lib/server/activity-audit"

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (err) return err
  const { id } = await params
  const [item] = await db.select().from(suppliers).where(eq(suppliers.id, Number(id)))
  if (!item) return error("Not found", 404)

  // BOLA: HEAD_OFFICE can only view their own org's suppliers
  const scope = await getRequestScope()
  if (scope?.role === "HEAD_OFFICE" && item.organizationId !== scope.organizationId) {
    return error("Forbidden", 403)
  }

  return ok({ item })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (err) return err
  const { id } = await params

  // BOLA: Verify ownership before update
  const [existing] = await db.select().from(suppliers).where(eq(suppliers.id, Number(id)))
  if (!existing) return error("Supplier not found", 404)

  const scope = await getRequestScope()
  if (scope?.role === "HEAD_OFFICE" && existing.organizationId !== scope.organizationId) {
    return error("Forbidden", 403)
  }

  const rawBody = await readJson<unknown>(req)
  if (!rawBody) return error("Invalid body", 400)
  const parsedBody = supplierUpdateSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const input = parsedBody.data
  const item = await db.transaction(async (tx) => {
    const [saved] = await tx.update(suppliers).set({
      name: input.name,
      address: input.address,
      contact: input.contact,
      email: input.email,
      description: input.description,
    }).where(eq(suppliers.id, Number(id))).returning()

    await recordAuditEvent(tx, {
      action: "UPDATE_SUPPLIER",
      entity: "supplier",
      entityId: saved.id,
      actor: { id: scope?.userId ?? null, role: scope?.role ?? null },
      organizationId: saved.organizationId,
      branchId: saved.branchId,
      before: {
        name: existing.name,
        address: existing.address,
        contact: existing.contact,
        email: existing.email,
        description: existing.description,
      },
      after: {
        name: saved.name,
        address: saved.address,
        contact: saved.contact,
        email: saved.email,
        description: saved.description,
      },
    })

    return saved
  })

  return ok({ item })
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const err = await requireApiRole(["SUPER_ADMIN"])
  if (err) return err
  const { id } = await params

  // Read the row first so the audit entry can carry it: after the delete this
  // trail is the only place the supplier exists. A row that is already gone
  // still answers `success` — the delete stays idempotent, as callers expect —
  // and simply records nothing, because nothing happened.
  const [existing] = await db.select().from(suppliers).where(eq(suppliers.id, Number(id)))
  if (!existing) return ok({ success: true })

  const scope = await getRequestScope()
  await db.transaction(async (tx) => {
    await tx.delete(suppliers).where(eq(suppliers.id, Number(id)))

    await recordAuditEvent(tx, {
      action: "DELETE_SUPPLIER",
      entity: "supplier",
      entityId: existing.id,
      actor: { id: scope?.userId ?? null, role: scope?.role ?? null },
      organizationId: existing.organizationId,
      branchId: existing.branchId,
      before: {
        name: existing.name,
        address: existing.address,
        contact: existing.contact,
        email: existing.email,
        description: existing.description,
      },
    })
  })

  return ok({ success: true })
}

