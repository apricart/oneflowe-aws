import "server-only"

import { randomUUID } from "node:crypto"
import { SignJWT, jwtVerify } from "jose"
import { and, eq, isNull, or, sql } from "drizzle-orm"
import { NextRequest } from "next/server"
import { riderProfiles, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { verifyPassword } from "@/lib/password"
import { RIDER_ROLE } from "@/lib/rider-access"
import { env } from "@/lib/server/env"
import {
  createAuthSessionRecord,
  revokeAuthSessionRecord,
} from "@/lib/server/auth-session-store"
import {
  issueSessionPolicyClaims,
  SESSION_ABSOLUTE_TIMEOUT_SECONDS,
} from "@/lib/session-policy"
import {
  clearFailedLogins,
  evaluateLockout,
  registerFailedLogin,
} from "@/lib/server/auth-lockout"

const ACCESS_TTL_SECONDS = SESSION_ABSOLUTE_TIMEOUT_SECONDS
const REFRESH_TTL_SECONDS = SESSION_ABSOLUTE_TIMEOUT_SECONDS

function secretKey() {
  return new TextEncoder().encode(env.NEXTAUTH_SECRET)
}

export type RiderSession = {
  userId: string
  role: typeof RIDER_ROLE
  sessionId: string
  code: string
  name: string
  phone: string | null
  vehicleNumber: string | null
  isOnDuty: boolean
  avatarUrl: string | null
}

export type RiderPublic = {
  id: string
  name: string
  phone: string | null
  vehicleNumber: string | null
  isOnDuty: boolean
  avatarUrl: string | null
}

export function toRiderPublic(session: RiderSession): RiderPublic {
  return {
    id: session.code,
    name: session.name,
    phone: session.phone,
    vehicleNumber: session.vehicleNumber,
    isOnDuty: session.isOnDuty,
    avatarUrl: session.avatarUrl,
  }
}

function normalizeIdentifier(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toLowerCase()
}

async function loadRiderByIdentifier(identifier: string) {
  const normalized = normalizeIdentifier(identifier)
  const phoneDigits = identifier.replace(/[^\d+]/g, "")

  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
      deletedAt: users.deletedAt,
      fullName: users.fullName,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
      failedLoginAttempts: users.failedLoginAttempts,
      lockoutUntil: users.lockoutUntil,
      code: riderProfiles.code,
      profilePhone: riderProfiles.phone,
      vehicleNumber: riderProfiles.vehicleNumber,
      isOnDuty: riderProfiles.isOnDuty,
      avatarUrl: riderProfiles.avatarUrl,
      roleName: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .innerJoin(riderProfiles, eq(riderProfiles.userId, users.id))
    .where(
      and(
        eq(roles.name, RIDER_ROLE),
        or(
          sql`lower(${riderProfiles.code}) = ${normalized}`,
          sql`lower(${users.email}) = ${normalized}`,
          sql`lower(coalesce(${users.username}, '')) = ${normalized}`,
          sql`lower(replace(coalesce(${users.phone}, ''), ' ', '')) = ${normalized}`,
          sql`lower(replace(coalesce(${riderProfiles.phone}, ''), ' ', '')) = ${normalized}`,
          phoneDigits.length >= 10
            ? sql`regexp_replace(coalesce(${users.phone}, ''), '[^0-9+]', '', 'g') = ${phoneDigits}`
            : sql`false`,
        ),
      ),
    )
    .limit(1)

  return row ?? null
}

function displayName(row: {
  fullName: string | null
  firstName: string | null
  lastName: string | null
}): string {
  if (row.fullName?.trim()) return row.fullName.trim()
  const parts = [row.firstName, row.lastName].filter(Boolean)
  return parts.length ? parts.join(" ") : "Rider"
}

async function signTokens(input: {
  userId: string
  sessionId: string
  code: string
}) {
  const now = Math.floor(Date.now() / 1000)
  const accessToken = await new SignJWT({
    role: RIDER_ROLE,
    sid: input.sessionId,
    code: input.code,
    typ: "rider_access",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TTL_SECONDS)
    .sign(secretKey())

  const refreshToken = await new SignJWT({
    role: RIDER_ROLE,
    sid: input.sessionId,
    typ: "rider_refresh",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + REFRESH_TTL_SECONDS)
    .sign(secretKey())

  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }
}

export type RiderLoginResult =
  | { kind: "ok"; tokens: Awaited<ReturnType<typeof signTokens>>; rider: RiderPublic }
  | { kind: "invalid" }
  | { kind: "disabled" }
  | { kind: "locked"; until: Date }

export async function loginRider(
  identifier: string,
  password: string,
): Promise<RiderLoginResult> {
  const row = await loadRiderByIdentifier(identifier)
  if (!row) return { kind: "invalid" }

  const lockout = evaluateLockout({
    failedLoginAttempts: row.failedLoginAttempts,
    lockoutUntil: row.lockoutUntil,
  })
  if (lockout.locked) {
    return { kind: "locked", until: lockout.until }
  }

  if (!row.isActive || row.deletedAt) return { kind: "disabled" }

  const ok = await verifyPassword(password, row.passwordHash)
  if (!ok) {
    await registerFailedLogin({ kind: "user", id: row.userId })
    return { kind: "invalid" }
  }

  await clearFailedLogins({ kind: "user", id: row.userId })

  const sessionId = randomUUID()
  const claims = issueSessionPolicyClaims(Date.now(), 15)
  await createAuthSessionRecord({
    sessionId,
    subjectId: row.userId,
    organizationId: null,
    claims,
  })

  const tokens = await signTokens({
    userId: row.userId,
    sessionId,
    code: row.code,
  })

  const rider: RiderPublic = {
    id: row.code,
    name: displayName(row),
    phone: row.profilePhone ?? row.phone,
    vehicleNumber: row.vehicleNumber,
    isOnDuty: row.isOnDuty,
    avatarUrl: row.avatarUrl,
  }

  return { kind: "ok", tokens, rider }
}

export async function refreshRiderTokens(
  refreshToken: string,
): Promise<RiderLoginResult> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"]
  try {
    ;({ payload } = await jwtVerify(refreshToken, secretKey()))
  } catch {
    return { kind: "invalid" }
  }
  if (payload.typ !== "rider_refresh" || payload.role !== RIDER_ROLE) {
    return { kind: "invalid" }
  }
  const userId = typeof payload.sub === "string" ? payload.sub : null
  const sessionId = typeof payload.sid === "string" ? payload.sid : null
  if (!userId || !sessionId) return { kind: "invalid" }

  const [row] = await db
    .select({
      userId: users.id,
      isActive: users.isActive,
      deletedAt: users.deletedAt,
      fullName: users.fullName,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
      code: riderProfiles.code,
      profilePhone: riderProfiles.phone,
      vehicleNumber: riderProfiles.vehicleNumber,
      isOnDuty: riderProfiles.isOnDuty,
      avatarUrl: riderProfiles.avatarUrl,
    })
    .from(users)
    .innerJoin(riderProfiles, eq(riderProfiles.userId, users.id))
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1)

  if (!row || !row.isActive) return { kind: "disabled" }

  const tokens = await signTokens({
    userId: row.userId,
    sessionId,
    code: row.code,
  })
  return {
    kind: "ok",
    tokens,
    rider: {
      id: row.code,
      name: displayName(row),
      phone: row.profilePhone ?? row.phone,
      vehicleNumber: row.vehicleNumber,
      isOnDuty: row.isOnDuty,
      avatarUrl: row.avatarUrl,
    },
  }
}

export async function logoutRider(accessToken: string | null): Promise<void> {
  if (!accessToken) return
  try {
    const { payload } = await jwtVerify(accessToken, secretKey())
    const sessionId = typeof payload.sid === "string" ? payload.sid : null
    const userId = typeof payload.sub === "string" ? payload.sub : null
    if (!sessionId || !userId) return
    await revokeAuthSessionRecord(sessionId, userId)
  } catch {
    // Already invalid — treat as logged out.
  }
}

export async function requireRiderSession(
  req: NextRequest,
): Promise<RiderSession | null> {
  const header = req.headers.get("authorization")
  if (!header?.toLowerCase().startsWith("bearer ")) return null
  const token = header.slice(7).trim()
  if (!token) return null

  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"]
  try {
    ;({ payload } = await jwtVerify(token, secretKey()))
  } catch {
    return null
  }
  if (payload.typ !== "rider_access" || payload.role !== RIDER_ROLE) return null
  const userId = typeof payload.sub === "string" ? payload.sub : null
  const sessionId = typeof payload.sid === "string" ? payload.sid : null
  const code = typeof payload.code === "string" ? payload.code : null
  if (!userId || !sessionId || !code) return null

  const [row] = await db
    .select({
      userId: users.id,
      isActive: users.isActive,
      deletedAt: users.deletedAt,
      fullName: users.fullName,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
      code: riderProfiles.code,
      profilePhone: riderProfiles.phone,
      vehicleNumber: riderProfiles.vehicleNumber,
      isOnDuty: riderProfiles.isOnDuty,
      avatarUrl: riderProfiles.avatarUrl,
      roleName: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .innerJoin(riderProfiles, eq(riderProfiles.userId, users.id))
    .where(and(eq(users.id, userId), eq(roles.name, RIDER_ROLE)))
    .limit(1)

  if (!row || !row.isActive || row.deletedAt) return null

  return {
    userId: row.userId,
    role: RIDER_ROLE,
    sessionId,
    code: row.code,
    name: displayName(row),
    phone: row.profilePhone ?? row.phone,
    vehicleNumber: row.vehicleNumber,
    isOnDuty: row.isOnDuty,
    avatarUrl: row.avatarUrl,
  }
}
