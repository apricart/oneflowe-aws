import type { NextAuthOptions } from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { db } from "@/lib/db"
import { users,roles,employeeCredentials,organizations,branches } from "@/db/schema"
import { eq,and,isNull,sql,or } from "drizzle-orm"
import { verifyPassword } from "@/lib/password"
import { verifyOTP,clearDailyCount } from "@/lib/mfa"
import { compare } from "bcryptjs"
import { getSessionValidationCache,setSessionValidationCache } from "@/lib/session-validation-cache"
import { env } from "@/lib/server/env"

type SessionDbUser = {
  isActive: boolean
  deletedAt: Date | null
  sessionVersion: number
  orgStatus: string | null
  branchStatus: string | null
}

function assignTokenToSessionUser(session: any, token: any): void {
  Object.assign(session.user, {
    id: token.sub,
    role: token.role,
    organizationId: token.organizationId,
    branchId: token.branchId,
    fullName: token.fullName,
    username: token.username,
    isEmployee: token.isEmployee,
    employeeId: token.employeeId,
    mustChangePassword: token.mustChangePassword ?? false,
  })
}

async function loadSessionDbUser(
  userId: string,
  isEmployee: boolean,
  orgJoinCondition: any,
  branchJoinCondition: any,
): Promise<SessionDbUser | null> {
  if (isEmployee) {
    const numericId = Number.parseInt(userId.replace("emp_", ""), 10)
    const [employee] = await db
      .select({
        isActive: employeeCredentials.isActive,
        deletedAt: sql<Date | null>`NULL`,
        sessionVersion: employeeCredentials.sessionVersion,
        orgStatus: organizations.status,
        branchStatus: branches.status,
      })
      .from(employeeCredentials)
      .leftJoin(organizations, orgJoinCondition)
      .leftJoin(branches, branchJoinCondition)
      .where(eq(employeeCredentials.id, numericId))
      .limit(1)
    return employee as SessionDbUser | null
  }

  const [user] = await db
    .select({
      isActive: users.isActive,
      deletedAt: users.deletedAt,
      sessionVersion: users.sessionVersion,
      orgStatus: organizations.status,
      branchStatus: branches.status,
    })
    .from(users)
    .leftJoin(organizations, orgJoinCondition)
    .leftJoin(branches, branchJoinCondition)
    .where(eq(users.id, userId))
    .limit(1)
  return user as SessionDbUser | null
}

function invalidSessionReason(
  dbUser: SessionDbUser | null,
  token: any,
  isEmployee: boolean,
  tokenOrgId: number | null,
  tokenBranchId: number | null,
): string | null {
  if (!dbUser || !dbUser.isActive || (dbUser.deletedAt && !isEmployee) || dbUser.sessionVersion !== token.sessionVersion) {
    return "Status/Version mismatch"
  }
  if (tokenOrgId && dbUser.orgStatus?.toLowerCase() !== 'active') return "Org deactivated"
  if (tokenBranchId && dbUser.branchStatus?.toLowerCase() !== 'active') return "Branch deactivated"
  return null
}

async function validateSessionAgainstDatabase(session: any, token: any): Promise<any> {
  try {
    const userId = token.sub as string
    if (!userId) return session

    const isEmployee = token.isEmployee === true
    const tokenOrgId = token.organizationId ? Number(token.organizationId) : null
    const tokenBranchId = token.branchId ? Number(token.branchId) : null
    const tokenSessionVersion = typeof token.sessionVersion === "number" ? token.sessionVersion : null
    const cachedValidation = await getSessionValidationCache(userId)
    if (
      cachedValidation?.sv === tokenSessionVersion &&
      cachedValidation.org === tokenOrgId &&
      cachedValidation.br === tokenBranchId
    ) {
      return session
    }

    const dbUser = await loadSessionDbUser(
      userId,
      isEmployee,
      tokenOrgId ? eq(organizations.id, tokenOrgId) : sql`false`,
      tokenBranchId ? eq(branches.id, tokenBranchId) : sql`false`,
    )
    const invalidReason = invalidSessionReason(dbUser, token, isEmployee, tokenOrgId, tokenBranchId)
    if (invalidReason) {
      console.log(`[Auth] Invaliding session for user ${userId}: ${invalidReason}`)
      return null
    }

    await setSessionValidationCache(userId, { sv: tokenSessionVersion, org: tokenOrgId, br: tokenBranchId })
  } catch (error) {
    console.error("[Auth] Session validation error:", error)
  }
  return session
}

export const authOptions: NextAuthOptions = {
  secret: env.NEXTAUTH_SECRET,
  useSecureCookies: env.NODE_ENV === "production",
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },  // 8-hour expiry (bank-grade)
  cookies: {
    sessionToken: {
      name: env.NODE_ENV === "production"
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.NODE_ENV === "production",
      },
    },
    callbackUrl: {
      name: env.NODE_ENV === "production"
        ? "__Secure-next-auth.callback-url"
        : "next-auth.callback-url",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.NODE_ENV === "production",
      },
    },
    csrfToken: {
      name: env.NODE_ENV === "production"
        ? "__Host-next-auth.csrf-token"
        : "next-auth.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.NODE_ENV === "production",
      },
    },
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        username: { label: "Username or Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username || "").trim().toLowerCase()
        const password = String(credentials?.password || "")
        if (!username || !password) return null

        const [u] = await db
          .select({
            id: users.id,
            username: users.username,
            email: users.email,
            hash: users.passwordHash,
            roleId: users.roleId,
            organizationId: users.organizationId,
            branchId: users.branchId,
            fullName: users.fullName,
            mfaEnabled: users.mfaEnabled,
            isActive: users.isActive,
            sessionVersion: users.sessionVersion,
            mustChangePassword: users.mustChangePassword,
          })
          .from(users)
          .where(and(or(eq(users.username, username), sql`lower(${users.email}) = ${username}`), isNull(users.deletedAt)))
        if (!u) return null

        const ok = await verifyPassword(password, u.hash)
        if (!ok) return null

        // Check organization status
        if (u.organizationId) {
          const [org] = await db
            .select({ status: organizations.status })
            .from(organizations)
            .where(eq(organizations.id, u.organizationId))
            .limit(1)

          if (!org || org.status?.toLowerCase() !== 'active') {
            throw new Error('ORGANIZATION_INACTIVE')
          }
        }

        // Check branch status
        if (u.branchId) {
          const [branch] = await db
            .select({ status: branches.status })
            .from(branches)
            .where(eq(branches.id, u.branchId))
            .limit(1)

          if (!branch || branch.status?.toLowerCase() !== 'active') {
            throw new Error('BRANCH_INACTIVE')
          }
        }

        // Check user status
        if (!u.isActive) {
          throw new Error('USER_INACTIVE')
        }

        // Check if MFA is enabled for this user
        if (u.mfaEnabled) {
          // Return special error to trigger MFA flow
          // Cooldown will be checked when sending OTP, not during initial login
          throw new Error("MFA_REQUIRED")
        }

        // Clear daily count after successful login (for non-MFA users)
        await clearDailyCount(u.id)

        const [r] = await db.select().from(roles).where(eq(roles.id, u.roleId))
        return {
          id: u.id,
          email: u.email,
          username: u.username,
          role: r?.name || "BRANCH_ADMIN",
          organizationId: u.organizationId,
          branchId: u.branchId,
          fullName: u.fullName,
          isEmployee: false,
          sessionVersion: u.sessionVersion,
          mustChangePassword: u.mustChangePassword,
        } as any
      },
    }),
    Credentials({
      id: "mfa-credentials",
      name: "mfa-credentials",
      credentials: {
        username: { label: "Username or Email", type: "text" },
        password: { label: "Password", type: "password" },
        otp: { label: "OTP Code", type: "text" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username || "").trim().toLowerCase()
        const password = String(credentials?.password || "")
        const otp = String(credentials?.otp || "")

        if (!username || !password || !otp) return null

        // Verify credentials first
        const [u] = await db
          .select({
            id: users.id,
            username: users.username,
            email: users.email,
            hash: users.passwordHash,
            roleId: users.roleId,
            organizationId: users.organizationId,
            branchId: users.branchId,
            fullName: users.fullName,
            mfaEnabled: users.mfaEnabled,
            isActive: users.isActive,
            sessionVersion: users.sessionVersion,
            mustChangePassword: users.mustChangePassword,
          })
          .from(users)
          .where(and(or(eq(users.username, username), sql`lower(${users.email}) = ${username}`), isNull(users.deletedAt)))
        if (!u) return null

        const ok = await verifyPassword(password, u.hash)
        if (!ok) return null

        // Check organization status
        if (u.organizationId) {
          const [org] = await db
            .select({ status: organizations.status })
            .from(organizations)
            .where(eq(organizations.id, u.organizationId))
            .limit(1)

          if (!org || org.status?.toLowerCase() !== 'active') {
            throw new Error('ORGANIZATION_INACTIVE')
          }
        }

        // Check branch status
        if (u.branchId) {
          const [branch] = await db
            .select({ status: branches.status })
            .from(branches)
            .where(eq(branches.id, u.branchId))
            .limit(1)

          if (!branch || branch.status?.toLowerCase() !== 'active') {
            throw new Error('BRANCH_INACTIVE')
          }
        }

        // Check user status
        if (!u.isActive) {
          throw new Error('USER_INACTIVE')
        }

        if (!u.mfaEnabled) return null

        // Verify OTP
        const mfaResult = await verifyOTP(u.id, otp, 'LOGIN')
        if (!mfaResult.success) {
          throw new Error(mfaResult.message)
        }

        // Clear daily count after successful login
        await clearDailyCount(u.id)

        const [r] = await db.select().from(roles).where(eq(roles.id, u.roleId))
        return {
          id: u.id,
          email: u.email,
          username: u.username,
          role: r?.name || "BRANCH_ADMIN",
          organizationId: u.organizationId,
          branchId: u.branchId,
          fullName: u.fullName,
          isEmployee: false,
          sessionVersion: u.sessionVersion,
          mustChangePassword: u.mustChangePassword,
        } as any
      },
    }),
    // Employee Portal Login
    Credentials({
      id: "employee-credentials",
      name: "employee-credentials",
      credentials: {
        username: { label: "Username or Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username || "").trim().toLowerCase()
        const password = String(credentials?.password || "")
        if (!username || !password) {
          return null
        }

        const [emp] = await db
          .select()
          .from(employeeCredentials)
          .where(or(eq(employeeCredentials.username, username), sql`lower(${employeeCredentials.email}) = ${username}`))

        if (!emp) {
          return null
        }



        const passwordMatch = await compare(password, emp.passwordHash)
        if (!passwordMatch) {
          return null
        }

        // Check organization status
        if (emp.organizationId) {
          const [org] = await db
            .select({ status: organizations.status })
            .from(organizations)
            .where(eq(organizations.id, emp.organizationId))
            .limit(1)

          if (!org || org.status?.toLowerCase() !== 'active') {
            throw new Error('ORGANIZATION_INACTIVE')
          }
        }

        // Check branch status
        if (emp.branchId) {
          const [branch] = await db
            .select({ status: branches.status })
            .from(branches)
            .where(eq(branches.id, emp.branchId))
            .limit(1)

          if (!branch || branch.status?.toLowerCase() !== 'active') {
            throw new Error('BRANCH_INACTIVE')
          }
        }

        // Check employee status (already filtered by isActive in WHERE, but explicit check for clarity)
        if (!emp.isActive) {
          throw new Error('USER_INACTIVE')
        }



        // Check if MFA is enabled
        if (emp.mfaEnabled) {
          throw new Error("MFA_REQUIRED")
        }

        return {
          id: `emp_${emp.id}`,
          email: emp.email,
          username: emp.username,
          role: "EMPLOYEE",
          organizationId: emp.organizationId,
          branchId: emp.branchId,
          fullName: `${emp.firstName} ${emp.lastName}`.trim(),
          isEmployee: true,
          employeeId: emp.id,
          sessionVersion: emp.sessionVersion
        } as any
      },
    }),
    // Employee MFA Login
    Credentials({
      id: "employee-mfa-credentials",
      name: "employee-mfa-credentials",
      credentials: {
        username: { label: "Username or Email", type: "text" },
        password: { label: "Password", type: "password" },
        otp: { label: "OTP Code", type: "text" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username || "").trim().toLowerCase()
        const password = String(credentials?.password || "")
        const otp = String(credentials?.otp || "")

        if (!username || !password || !otp) return null

        const [emp] = await db
          .select()
          .from(employeeCredentials)
          .where(or(eq(employeeCredentials.username, username), sql`lower(${employeeCredentials.email}) = ${username}`))

        if (!emp) return null

        const passwordMatch = await compare(password, emp.passwordHash)
        if (!passwordMatch) return null

        // Check organization status
        if (emp.organizationId) {
          const [org] = await db
            .select({ status: organizations.status })
            .from(organizations)
            .where(eq(organizations.id, emp.organizationId))
            .limit(1)

          if (!org || org.status?.toLowerCase() !== 'active') {
            throw new Error('ORGANIZATION_INACTIVE')
          }
        }

        // Check branch status
        if (emp.branchId) {
          const [branch] = await db
            .select({ status: branches.status })
            .from(branches)
            .where(eq(branches.id, emp.branchId))
            .limit(1)

          if (!branch || branch.status?.toLowerCase() !== 'active') {
            throw new Error('BRANCH_INACTIVE')
          }
        }

        // Check employee status
        if (!emp.isActive) {
          throw new Error('USER_INACTIVE')
        }

        if (!emp.mfaEnabled || !emp.mfaSecret) return null

        // Verify OTP for employee
        const mfaResult = await verifyOTP(`emp_${emp.id}`, otp, 'LOGIN')
        if (!mfaResult.success) {
          throw new Error(mfaResult.message)
        }

        return {
          id: `emp_${emp.id}`,
          email: emp.email,
          username: emp.username,
          role: "EMPLOYEE",
          organizationId: emp.organizationId,
          branchId: emp.branchId,
          fullName: `${emp.firstName} ${emp.lastName}`.trim(),
          isEmployee: true,
          employeeId: emp.id,
          sessionVersion: emp.sessionVersion
        } as any
      },
    }),
  ],
  callbacks: {
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`

      try {
        const parsed = new URL(url)
        return parsed.origin === new URL(baseUrl).origin ? parsed.toString() : baseUrl
      } catch {
        return baseUrl
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as any).role
        token.organizationId = (user as any).organizationId
        token.branchId = (user as any).branchId
        token.fullName = (user as any).fullName
        token.username = (user as any).username
        token.isEmployee = (user as any).isEmployee
        token.employeeId = (user as any).employeeId
        token.sessionVersion = (user as any).sessionVersion
        token.mustChangePassword = (user as any).mustChangePassword ?? false
      }
      return token
    },
    async session({ session, token }) {
      if (!session.user) return session
      assignTokenToSessionUser(session, token)
      return validateSessionAgainstDatabase(session, token)
    },
  },
  pages: {
    signIn: "/login",
  },
}
