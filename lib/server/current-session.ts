import "server-only"

import type { NextRequest } from "next/server"
import { getToken } from "next-auth/jwt"

import { authOptions } from "@/lib/auth-options"
import { env } from "@/lib/server/env"

/**
 * The registry id of the session behind a request, read from the signed JWT.
 *
 * `session.user` deliberately does not carry it: whatever the session callback
 * assigns is also served to the browser by `/api/auth/session`, and the id
 * has no business there. A handler that must tie a write to *this* session —
 * the emailed proof that authorises a password change — reads it here.
 */
export async function getCurrentSessionId(req: NextRequest): Promise<string | null> {
  const token = await getToken({
    req,
    secret: env.NEXTAUTH_SECRET,
    cookieName: authOptions.cookies?.sessionToken?.name,
  })
  const sessionId = token?.sessionId
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null
}
