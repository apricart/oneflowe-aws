import { NextRequest } from "next/server"
import { z } from "zod"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession } from "@/lib/server/rider-auth"
import { upsertRiderLocation } from "@/lib/server/rider-location"

const bodySchema = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
    accuracyMeters: z.number().nullable().optional(),
    heading: z.number().nullable().optional(),
    speedMps: z.number().nullable().optional(),
    recordedAt: z.string().min(1),
    isOnDuty: z.boolean().optional(),
  })
  .strict()

export async function POST(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return riderFail("VALIDATION_ERROR", "Invalid location payload", 400)
    }

    const result = await upsertRiderLocation({
      riderUserId: session.userId,
      isOnDuty: parsed.data.isOnDuty ?? session.isOnDuty,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      accuracyMeters: parsed.data.accuracyMeters,
      heading: parsed.data.heading,
      speedMps: parsed.data.speedMps,
      recordedAt: parsed.data.recordedAt,
    })

    if (result.kind === "rejected") {
      if (result.reason === "off_duty") {
        return riderFail("FORBIDDEN", "Rider is off duty", 403)
      }
      if (result.reason === "rate_limited") {
        return riderFail("RATE_LIMITED", "Location updates too frequent", 429)
      }
      if (result.reason === "stale") {
        return riderOk({ accepted: false, reason: "stale" })
      }
      return riderFail("VALIDATION_ERROR", "Invalid location", 400)
    }

    return riderOk({ accepted: true })
  } catch (error) {
    console.error("[rider/location]", error)
    return riderFail("INTERNAL_ERROR", "Failed to update location", 500)
  }
}
