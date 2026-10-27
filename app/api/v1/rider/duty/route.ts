import { NextRequest } from "next/server"
import { z } from "zod"
import { eq } from "drizzle-orm"
import { riderProfiles } from "@/db/schema"
import { db } from "@/lib/db"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession, toRiderPublic } from "@/lib/server/rider-auth"

const bodySchema = z.object({ isOnDuty: z.boolean() }).strict()

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const json = await req.json().catch(() => null)
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return riderFail("VALIDATION_ERROR", "isOnDuty is required", 400)
    }

    await db
      .update(riderProfiles)
      .set({ isOnDuty: parsed.data.isOnDuty, updatedAt: new Date() })
      .where(eq(riderProfiles.userId, session.userId))

    return riderOk({
      rider: { ...toRiderPublic(session), isOnDuty: parsed.data.isOnDuty },
    })
  } catch (error) {
    console.error("[rider/duty]", error)
    return riderFail("INTERNAL_ERROR", "Failed to update duty", 500)
  }
}
