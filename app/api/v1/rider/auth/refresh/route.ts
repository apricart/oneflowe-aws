import { z } from "zod"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { refreshRiderTokens } from "@/lib/server/rider-auth"

const bodySchema = z.object({ refreshToken: z.string().min(1) }).strict()

export async function POST(req: Request) {
  try {
    const json = await req.json().catch(() => null)
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return riderFail("VALIDATION_ERROR", "refreshToken is required", 400)
    }

    const result = await refreshRiderTokens(parsed.data.refreshToken)
    if (result.kind === "disabled") {
      return riderFail("RIDER_DISABLED", "Rider account is disabled", 403)
    }
    if (result.kind !== "ok") {
      return riderFail("UNAUTHORIZED", "Invalid refresh token", 401)
    }

    return riderOk({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.expiresIn,
      rider: result.rider,
    })
  } catch (error) {
    console.error("[rider/auth/refresh]", error)
    return riderFail("INTERNAL_ERROR", "Refresh failed", 500)
  }
}
