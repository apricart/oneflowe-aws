import { z } from "zod"
import { withRateLimit } from "@/lib/rate-limiter"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { loginRider } from "@/lib/server/rider-auth"

const bodySchema = z
  .object({
    identifier: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(128),
  })
  .strict()

export async function POST(req: Request) {
  try {
    const limited = await withRateLimit("login")
    if (limited) {
      return riderFail("RATE_LIMITED", "Too many login attempts", 429)
    }

    const json = await req.json().catch(() => null)
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return riderFail("VALIDATION_ERROR", "Invalid login body", 400, parsed.error.flatten())
    }

    const result = await loginRider(parsed.data.identifier, parsed.data.password)
    if (result.kind === "locked") {
      return riderFail("FORBIDDEN", "Account temporarily locked", 403, {
        until: result.until.toISOString(),
      })
    }
    if (result.kind === "disabled") {
      return riderFail("RIDER_DISABLED", "Rider account is disabled", 403)
    }
    if (result.kind === "invalid") {
      return riderFail("INVALID_CREDENTIALS", "Invalid credentials", 401)
    }

    return riderOk({
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.expiresIn,
      rider: result.rider,
    })
  } catch (error) {
    console.error("[rider/auth/login]", error)
    return riderFail("INTERNAL_ERROR", "Login failed", 500)
  }
}
