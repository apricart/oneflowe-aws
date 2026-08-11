import { stringifyPrimitive } from "./stringify-primitive"
import { and, eq, isNull, ne, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { employeeCredentials, users } from "@/db/schema"

export type UserUniqueInput = {
  email?: string | null
  phone?: string | null
  employeeId?: string | null
}

export class UserUniqueFieldError extends Error {
  field: "email" | "phone" | "employeeId"

  constructor(field: UserUniqueFieldError["field"], message: string) {
    super(message)
    this.name = "UserUniqueFieldError"
    this.field = field
  }
}

export const normalizeEmail = (value: unknown) =>
  stringifyPrimitive(value).trim().toLowerCase()

export const normalizeOptionalText = (value: unknown) => {
  const normalized = stringifyPrimitive(value).trim()
  return normalized.length > 0 ? normalized : null
}

async function assertEmailIsUnique(email: string, excludeUserId?: string, excludeCredentialId?: number) {
  const conditions = [sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)]
  if (excludeUserId) conditions.push(ne(users.id, excludeUserId))

  const [existingUser] = await db.select({ id: users.id }).from(users).where(and(...conditions)).limit(1)
  if (existingUser) {
    throw new UserUniqueFieldError("email", "This email is already registered with this app. Please use another email.")
  }

  const credentialConditions = [sql`lower(${employeeCredentials.email}) = ${email}`]
  if (excludeCredentialId !== undefined) credentialConditions.push(ne(employeeCredentials.id, excludeCredentialId))

  const [existingCredential] = await db
    .select({ id: employeeCredentials.id })
    .from(employeeCredentials)
    .where(and(...credentialConditions))
    .limit(1)
  if (existingCredential) {
    throw new UserUniqueFieldError("email", "This email is already registered with this app. Please use another email.")
  }
}

async function assertPhoneIsUnique(phone: string, excludeUserId?: string) {
  const conditions = [eq(users.phone, phone), isNull(users.deletedAt)]
  if (excludeUserId) conditions.push(ne(users.id, excludeUserId))

  const [existingUser] = await db.select({ id: users.id }).from(users).where(and(...conditions)).limit(1)
  if (existingUser) {
    throw new UserUniqueFieldError("phone", "This phone number is already registered with this app. Please use another phone number.")
  }
}

async function assertEmployeeIdIsUnique(employeeId: string, excludeUserId?: string) {
  const conditions = [sql`lower(${users.employeeId}) = ${employeeId.toLowerCase()}`, isNull(users.deletedAt)]
  if (excludeUserId) conditions.push(ne(users.id, excludeUserId))

  const [existingUser] = await db.select({ id: users.id }).from(users).where(and(...conditions)).limit(1)
  if (existingUser) {
    throw new UserUniqueFieldError("employeeId", "This employee number is already registered with this app. Please use another employee number.")
  }
}

export async function assertUniqueUserFields(input: UserUniqueInput, excludeUserId?: string, excludeCredentialId?: number) {
  const email = normalizeEmail(input.email)
  const phone = normalizeOptionalText(input.phone)
  const employeeId = normalizeOptionalText(input.employeeId)

  if (email) {
    await assertEmailIsUnique(email, excludeUserId, excludeCredentialId)
  }

  if (phone) {
    await assertPhoneIsUnique(phone, excludeUserId)
  }

  if (employeeId) {
    await assertEmployeeIdIsUnique(employeeId, excludeUserId)
  }
}
