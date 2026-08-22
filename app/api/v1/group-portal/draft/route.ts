import { type NextRequest } from "next/server"
import { and, eq } from "drizzle-orm"

import { groupOrderDrafts } from "@/db/schema"
import { error, ok, readJson } from "@/lib/api"
import { db } from "@/lib/db"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { groupOrderDraftSchema, validationMessage } from "@/lib/server/mutation-validation"

export const dynamic = "force-dynamic"

/**
 * The in-progress group order, saved so a refresh or a different device resumes
 * where the user left off.
 *
 * The draft stores selections only — branch ids, inventory ids, quantities. It
 * is never a source of truth for price, availability, or authorization: the
 * submit endpoint re-resolves the branch scope and re-prices every line from the
 * database, so a stale or tampered draft can only ever be rejected, never
 * honoured on its own terms.
 *
 * One draft per user, keyed by the caller's own id, so there is no addressable
 * identifier another user could ask for.
 */

function draftScope(userId: string, organizationId: number) {
  return and(
    eq(groupOrderDrafts.userId, userId),
    eq(groupOrderDrafts.organizationId, organizationId),
  )
}

export async function GET() {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const [draft] = await db
    .select({
      groupId: groupOrderDrafts.groupId,
      payload: groupOrderDrafts.payload,
      updatedAt: groupOrderDrafts.updatedAt,
    })
    .from(groupOrderDrafts)
    .where(draftScope(actor.scope.userId, actor.organizationId))
    .limit(1)

  return ok({ item: draft ?? null })
}

export async function PUT(req: NextRequest) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const parsed = groupOrderDraftSchema.safeParse(await readJson(req))
  if (!parsed.success) return error(validationMessage(parsed.error), 400)

  const now = new Date()
  await db
    .insert(groupOrderDrafts)
    .values({
      userId: actor.scope.userId,
      organizationId: actor.organizationId,
      groupId: parsed.data.groupId,
      payload: parsed.data,
      updatedAt: now,
    })
    // The unique index on user_id makes this an upsert of that user's own row;
    // the tenant is re-written from the session, never from the request.
    .onConflictDoUpdate({
      target: groupOrderDrafts.userId,
      set: {
        organizationId: actor.organizationId,
        groupId: parsed.data.groupId,
        payload: parsed.data,
        updatedAt: now,
      },
    })

  return ok({ savedAt: now.toISOString() })
}

export async function DELETE() {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  await db.delete(groupOrderDrafts).where(draftScope(actor.scope.userId, actor.organizationId))

  return ok({ cleared: true })
}
