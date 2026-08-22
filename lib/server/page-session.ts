import "server-only"

import type { Session } from "next-auth"
import { getSharedServerSession } from "@/lib/auth"
import { isSessionValidationUnavailablePayload } from "@/lib/session-response"

export type ProtectedPageSession =
  | { kind: "authenticated"; session: Session }
  | { kind: "invalid" }
  | { kind: "unavailable" }

export async function getProtectedPageSession(): Promise<ProtectedPageSession> {
  const session = await getSharedServerSession()
  if (isSessionValidationUnavailablePayload(session)) {
    return { kind: "unavailable" }
  }

  if (!session?.user) return { kind: "invalid" }
  return { kind: "authenticated", session }
}
