/**
 * Multi-Factor Authentication (MFA) System
 * Handles OTP generation, validation, and security features
 * Uses Redis for caching and cooldown management
 */

import { db } from "@/lib/db"
import { users,mfaCodes } from "@/db/schema"
import { eq,and,gte,desc,sql } from "drizzle-orm"
import { randomInt } from "node:crypto"
import { RedisMFA, type RedisOTPData } from "@/lib/redis"
import { logError } from "@/lib/global-logger"
import { isValidEmailAddress } from "@/lib/validation/email"

type MFACodeType = 'LOGIN' | 'VERIFY_EMAIL' | 'RESET_PASSWORD'
type MFACooldownType = 'OTP_REQUEST' | 'OTP_VERIFY'

export interface MFACode {
  id: string
  userId: string
  code: string
  type: MFACodeType
  expiresAt: Date
  attempts: number
  isUsed: boolean
  createdAt: Date
}

export interface MFAResult {
  success: boolean
  message: string
  remainingAttempts?: number
  cooldownUntil?: Date
}

export interface MFACooldown {
  userId: string
  type: MFACooldownType
  cooldownUntil: Date
  attempts: number
  timestamp?: number
}

// OTP Configuration
const OTP_CONFIG = {
  LENGTH: 6,
  EXPIRY_MINUTES: 2,
  MAX_ATTEMPTS: 5,
  COOLDOWN_MINUTES: 1,
  MAX_DAILY_REQUESTS: 20
} as const

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false
  return isValidEmailAddress(email)
}

/**
 * Validate MFA type
 */
function isValidMFAType(type: string): type is MFACodeType {
  return type === 'LOGIN' || type === 'VERIFY_EMAIL' || type === 'RESET_PASSWORD'
}

/**
 * Generate a secure 6-digit OTP
 */
export function generateOTP(): string {
  try {
    const otp = randomInt(100000, 999999).toString()

    // Validate generated OTP
    if (otp.length !== OTP_CONFIG.LENGTH) {
      throw new Error(`Generated OTP length invalid: ${otp.length}`)
    }

    return otp
  } catch (error) {
    console.error('[MFA] Error generating OTP:', error)
    throw new Error('Failed to generate OTP', { cause: error })
  }
}

/**
 * Send OTP via email
 */
export async function sendOTPEmail(email: string, code: string, type: string): Promise<boolean> {
  try {
    // Validate inputs
    if (!isValidEmail(email)) {
      console.error('[MFA] Invalid email format:', email)
      return false
    }

    if (!code || typeof code !== 'string' || code.length !== OTP_CONFIG.LENGTH) {
      console.error('[MFA] Invalid OTP code format')
      return false
    }

    if (!isValidMFAType(type)) {
      console.error('[MFA] Invalid MFA type:', type)
      return false
    }

    // Use the email service to send the OTP
    const { sendOTPEmail: sendEmail } = await import('@/lib/email')
    return await sendEmail(email, code, type as MFACodeType)

  } catch (error) {
    logError(error, 'MFA_SEND_EMAIL', { email, type })
    return false
  }
}

/**
 * Check if user is in cooldown period
 */
export async function checkCooldown(userId: string, type: MFACooldownType): Promise<MFACooldown | null> {
  try {
    const cooldown = await RedisMFA.getCooldown(userId, type)
    if (cooldown && new Date(cooldown.cooldownUntil) > new Date()) {
      return {
        ...cooldown,
        type,
        cooldownUntil: new Date(cooldown.cooldownUntil),
      }
    }
    return null
  } catch (error) {
    console.error("Error checking cooldown:", error)
    return null
  }
}

/**
 * Set cooldown for user
 */
export async function setCooldown(userId: string, type: MFACooldownType, attempts: number): Promise<void> {
  try {
    const ttlSeconds = OTP_CONFIG.COOLDOWN_MINUTES * 60
    await RedisMFA.setCooldown(userId, type, ttlSeconds, attempts)
  } catch (error) {
    console.error("Error setting cooldown:", error)
  }
}

function getCooldownRemainingMs(cooldown: MFACooldown): number {
  return cooldown.timestamp
    ? cooldown.timestamp - Date.now()
    : new Date(cooldown.cooldownUntil).getTime() - Date.now()
}

function getTooManyFailedAttemptsMessage(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60000)
  return `Too many failed attempts. Please wait ${minutes} minute${minutes !== 1 ? 's' : ''} before trying again`
}

async function incrementOTPAttempts(
  otp: Pick<MFACode, 'id' | 'code' | 'attempts'>,
  userId: string,
  type: MFACodeType
): Promise<number> {
  const [updatedOTP] = await db
    .update(mfaCodes)
    .set({ attempts: sql`${mfaCodes.attempts} + 1` })
    .where(and(
      eq(mfaCodes.id, otp.id),
      eq(mfaCodes.userId, userId),
      eq(mfaCodes.type, type),
      eq(mfaCodes.isUsed, false)
    ))
    .returning({ attempts: mfaCodes.attempts })

  if (!updatedOTP) {
    throw new Error('Active OTP was not available for attempt update')
  }

  const attempts = updatedOTP.attempts

  try {
    await RedisMFA.updateOTPAttempts(userId, otp.code, attempts)
  } catch (redisError) {
    logError(redisError, 'MFA_REDIS_UPDATE_OTP_ATTEMPTS', { userId, type })
  }

  return attempts
}

/**
 * Check daily OTP request limit
 */
export async function checkDailyLimit(userId: string): Promise<boolean> {
  try {
    const count = await RedisMFA.getDailyCount(userId)
    return count < OTP_CONFIG.MAX_DAILY_REQUESTS
  } catch (error) {
    console.error("Error checking daily limit:", error)
    return true // Allow request if Redis fails
  }
}

function validateOtpRequest(userId: string, email: string, type: MFACodeType): MFAResult | null {
  if (!userId || typeof userId !== 'string') {
    console.error('[MFA] Invalid userId:', userId)
    return { success: false, message: "Invalid user ID" }
  }
  if (!isValidEmail(email)) {
    console.error('[MFA] Invalid email:', email)
    return { success: false, message: "Invalid email address" }
  }
  if (!isValidMFAType(type)) {
    console.error('[MFA] Invalid MFA type:', type)
    return { success: false, message: "Invalid request type" }
  }
  return null
}

/**
 * Generate and send OTP for user
 */
export async function generateAndSendOTP(
  userId: string,
  email: string,
  type: MFACodeType
): Promise<MFAResult> {
  try {
    const validationError = validateOtpRequest(userId, email, type)
    if (validationError) return validationError

    // Check cooldown
    const cooldown = await checkCooldown(userId, 'OTP_REQUEST')

    if (cooldown) {
      const remainingMs = cooldown.timestamp ?
        cooldown.timestamp - Date.now() :
        new Date(cooldown.cooldownUntil).getTime() - Date.now()

      if (remainingMs > 0) {
        const minutes = Math.ceil(remainingMs / 60000)
        return {
          success: false,
          message: `Please wait ${minutes} minute${minutes !== 1 ? 's' : ''} before requesting another OTP`,
          cooldownUntil: new Date(cooldown.cooldownUntil)
        }
      }
    }

    // Check daily limit
    const withinLimit = await checkDailyLimit(userId)

    if (!withinLimit) {
      return {
        success: false,
        message: "Daily OTP request limit exceeded. Please try again tomorrow."
      }
    }

    // Generate OTP
    const code = generateOTP()
    const ttlSeconds = OTP_CONFIG.EXPIRY_MINUTES * 60
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

    // Keep exactly one active OTP per user and MFA type.
    // Any resend invalidates earlier unused codes before the new code is persisted.
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(mfaCodes)
          .set({ isUsed: true })
          .where(and(
            eq(mfaCodes.userId, userId),
            eq(mfaCodes.type, type),
            eq(mfaCodes.isUsed, false)
          ))

        await tx.insert(mfaCodes).values({
          userId,
          code,
          type,
          expiresAt,
          attempts: 0,
          isUsed: false
        })
      })
    } catch (dbError) {
      logError(dbError, 'MFA_DB_INSERT_CODE', { userId, type })
      return {
        success: false,
        message: "Failed to save OTP. Please try again."
      }
    }

    // Save OTP to Redis after the database state is authoritative.
    try {
      await RedisMFA.setOTP(userId, code, ttlSeconds, type)
    } catch (redisError) {
      logError(redisError, 'MFA_REDIS_SET_OTP', { userId, type })
      // Continue even if Redis fails - verification can fall back to database
    }

    // Send OTP via email
    const emailSent = await sendOTPEmail(email, code, type)

    if (!emailSent) {
      return {
        success: false,
        message: "Failed to send OTP email. Please try again."
      }
    }

    // Increment daily count
    try {
      await RedisMFA.incrementDailyCount(userId)
    } catch (error) {
      // Log but don't fail - daily count is not critical
      console.error('[MFA] Failed to increment daily count:', error)
    }

    return {
      success: true,
      message: `OTP sent to ${email}. Valid for ${OTP_CONFIG.EXPIRY_MINUTES} minutes.`
    }

  } catch (error) {
    logError(error, 'MFA_GENERATE_AND_SEND', { userId, email, type })
    return {
      success: false,
      message: "Failed to generate OTP. Please try again."
    }
  }
}

type LatestDbOTP = {
  id: string
  code: string
  attempts: number
  isUsed: boolean
  expiresAt: Date
}

function validateOtpVerificationRequest(userId: string, code: string, type: MFACodeType): MFAResult | null {
  if (!userId || typeof userId !== 'string') {
    console.error('[MFA] Invalid userId for verification')
    return { success: false, message: "Invalid request" }
  }
  if (!code || typeof code !== 'string') {
    console.error('[MFA] Invalid OTP code')
    return { success: false, message: "Invalid OTP code" }
  }
  if (!/^\d{6}$/.test(code.trim())) {
    console.error('[MFA] OTP code format invalid:', code.trim())
    return { success: false, message: "Invalid OTP format" }
  }
  if (!isValidMFAType(type)) {
    console.error('[MFA] Invalid MFA type for verification:', type)
    return { success: false, message: "Invalid request type" }
  }
  return null
}

async function recordFailedOtpAttempt(
  latestDbOTP: LatestDbOTP,
  userId: string,
  type: MFACodeType,
  message: string,
): Promise<MFAResult> {
  let attempts: number
  try {
    attempts = await incrementOTPAttempts(latestDbOTP, userId, type)
  } catch (attemptError) {
    logError(attemptError, 'MFA_DB_INCREMENT_ATTEMPTS', { userId, type })
    return { success: false, message: "Failed to verify OTP. Please try again." }
  }

  if (attempts >= OTP_CONFIG.MAX_ATTEMPTS) {
    await setCooldown(userId, 'OTP_VERIFY', attempts)
    return {
      success: false,
      message: getTooManyFailedAttemptsMessage(OTP_CONFIG.COOLDOWN_MINUTES * 60000),
      remainingAttempts: 0,
    }
  }
  return {
    success: false,
    message,
    remainingAttempts: Math.max(0, OTP_CONFIG.MAX_ATTEMPTS - attempts),
  }
}

async function readRedisOtp(userId: string, code: string, type: MFACodeType): Promise<RedisOTPData | null> {
  try {
    const latestRedisCode = await RedisMFA.getLatestOTPCode(userId, type)
    if (latestRedisCode && latestRedisCode !== code) return null
    return await RedisMFA.getOTP(userId, code)
  } catch (redisError) {
    logError(redisError, 'MFA_REDIS_GET_OTP', { userId })
    return null
  }
}

async function hasActiveDatabaseOtp(userId: string, type: MFACodeType): Promise<boolean> {
  try {
    const [activeOTP] = await db
      .select({ id: mfaCodes.id })
      .from(mfaCodes)
      .where(and(
        eq(mfaCodes.userId, userId),
        eq(mfaCodes.type, type),
        eq(mfaCodes.isUsed, false),
        gte(mfaCodes.expiresAt, new Date()),
      ))
      .orderBy(desc(mfaCodes.expiresAt))
      .limit(1)
    return Boolean(activeOTP)
  } catch (dbError) {
    logError(dbError, 'MFA_DB_ACTIVE_CODE_CHECK', { userId, type })
    return false
  }
}

async function rejectInvalidStoredOtp(latestDbOTP: LatestDbOTP, userId: string, type: MFACodeType): Promise<MFAResult> {
  const hasActiveOTP = await hasActiveDatabaseOtp(userId, type)
  const message = hasActiveOTP
    ? "Invalid OTP code. Please check your email and try again."
    : "OTP has expired. Please request a new one."
  return recordFailedOtpAttempt(latestDbOTP, userId, type, message)
}

async function completeOtpVerification(latestDbOTP: LatestDbOTP, userId: string, code: string, type: MFACodeType): Promise<void> {
  try {
    await RedisMFA.markOTPUsed(userId, code)
    await RedisMFA.deleteLatestOTP(userId, type)
  } catch (redisError) {
    logError(redisError, 'MFA_REDIS_MARK_USED', { userId })
  }

  try {
    await db.update(mfaCodes).set({ isUsed: true }).where(and(
      eq(mfaCodes.id, latestDbOTP.id),
      eq(mfaCodes.userId, userId),
      eq(mfaCodes.type, type),
    ))
  } catch (dbError) {
    logError(dbError, 'MFA_DB_MARK_USED', { userId, type })
  }

  try {
    await clearAllMFACooldowns(userId)
  } catch (error) {
    console.error('[MFA] Failed to clear cooldowns:', error)
  }
}

/**
 * Verify OTP code
 */
export async function verifyOTP(
  userId: string,
  code: string,
  type: MFACodeType
): Promise<MFAResult> {
  try {
    const validationError = validateOtpVerificationRequest(userId, code, type)
    if (validationError) return validationError

    const sanitizedCode = code.trim()

    // Check cooldown
    const cooldown = await checkCooldown(userId, 'OTP_VERIFY')
    if (cooldown && cooldown.attempts >= OTP_CONFIG.MAX_ATTEMPTS) {
      const remainingMs = getCooldownRemainingMs(cooldown)

      if (remainingMs > 0) {
        return {
          success: false,
          message: getTooManyFailedAttemptsMessage(remainingMs),
          cooldownUntil: new Date(cooldown.cooldownUntil)
        }
      }
    }

    let latestDbOTP: LatestDbOTP | null = null

    try {
      const [latestOTP] = await db
        .select({
          id: mfaCodes.id,
          code: mfaCodes.code,
          attempts: mfaCodes.attempts,
          isUsed: mfaCodes.isUsed,
          expiresAt: mfaCodes.expiresAt,
        })
        .from(mfaCodes)
        .where(and(
          eq(mfaCodes.userId, userId),
          eq(mfaCodes.type, type),
          eq(mfaCodes.isUsed, false),
          gte(mfaCodes.expiresAt, new Date())
        ))
        .orderBy(desc(mfaCodes.expiresAt))
        .limit(1)

      latestDbOTP = latestOTP || null
    } catch (dbError) {
      logError(dbError, 'MFA_DB_LATEST_CODE_CHECK', { userId, type })
      return {
        success: false,
        message: "Failed to verify OTP. Please request a new one."
      }
    }

    if (!latestDbOTP) {
      return {
        success: false,
        message: "OTP has expired. Please request a new one."
      }
    }

    if (latestDbOTP.code !== sanitizedCode) {
      return recordFailedOtpAttempt(
        latestDbOTP,
        userId,
        type,
        "Invalid OTP code. Please use the latest code sent to your email.",
      )
    }

    const otpData = await readRedisOtp(userId, sanitizedCode, type) ?? {
        userId,
        code: latestDbOTP.code,
        type,
        attempts: latestDbOTP.attempts,
        isUsed: latestDbOTP.isUsed,
        expiresAt: latestDbOTP.expiresAt,
    }

    if (otpData.isUsed || otpData.type !== type) {
      return rejectInvalidStoredOtp(latestDbOTP, userId, type)
    }

    // Check attempt limit
    const attempts = Math.max(latestDbOTP.attempts, Number(otpData.attempts || 0))
    if (attempts >= OTP_CONFIG.MAX_ATTEMPTS) {
      return {
        success: false,
        message: "OTP code has exceeded maximum attempts. Please request a new one."
      }
    }

    await completeOtpVerification(latestDbOTP, userId, sanitizedCode, type)

    return {
      success: true,
      message: "OTP verified successfully"
    }

  } catch (error) {
    logError(error, 'MFA_VERIFY_OTP', { userId, type })
    return {
      success: false,
      message: "Failed to verify OTP. Please try again."
    }
  }
}

/**
 * Enable MFA for user
 */
export async function enableMFA(userId: string): Promise<MFAResult> {
  try {
    // Validate userId
    if (!userId || typeof userId !== 'string') {
      console.error('[MFA] Invalid userId for enable MFA')
      return {
        success: false,
        message: "Invalid user ID"
      }
    }

    await db
      .update(users)
      .set({ mfaEnabled: true })
      .where(eq(users.id, userId))

    return {
      success: true,
      message: "MFA enabled successfully"
    }
  } catch (error) {
    logError(error, 'MFA_ENABLE', { userId })
    return {
      success: false,
      message: "Failed to enable MFA. Please try again."
    }
  }
}

/**
 * Disable MFA for user
 */
export async function disableMFA(userId: string): Promise<MFAResult> {
  try {
    // Validate userId
    if (!userId || typeof userId !== 'string') {
      console.error('[MFA] Invalid userId for disable MFA')
      return {
        success: false,
        message: "Invalid user ID"
      }
    }

    await db
      .update(users)
      .set({ mfaEnabled: false })
      .where(eq(users.id, userId))

    // Clean up any pending OTP codes from database
    try {
      await db
        .delete(mfaCodes)
        .where(eq(mfaCodes.userId, userId))
    } catch (deleteError) {
      console.error('[MFA] Failed to delete MFA codes:', deleteError)
      // Log but continue - main goal achieved
    }

    // Clean up Redis cooldowns and OTPs
    try {
      await clearAllMFACooldowns(userId)
    } catch (clearError) {
      console.error('[MFA] Failed to clear cooldowns:', clearError)
      // Log but continue
    }

    return {
      success: true,
      message: "MFA disabled successfully"
    }
  } catch (error) {
    logError(error, 'MFA_DISABLE', { userId })
    return {
      success: false,
      message: "Failed to disable MFA. Please try again."
    }
  }
}

/**
 * Check if user has MFA enabled
 */
export async function isMFAEnabled(userId: string): Promise<boolean> {
  try {
    // Validate userId
    if (!userId || typeof userId !== 'string') {
      console.error('[MFA] Invalid userId for MFA status check')
      return false
    }

    const [user] = await db
      .select({ mfaEnabled: users.mfaEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    return user?.mfaEnabled || false
  } catch (error) {
    logError(error, 'MFA_CHECK_STATUS', { userId })
    return false
  }
}

/**
 * Check MFA cooldown for auth flow
 */
export async function checkMfaCooldown(userId: string): Promise<number> {
  try {
    const cooldown = await RedisMFA.getCooldown(userId, 'OTP_REQUEST')
    if (cooldown) {
      const remainingMs = cooldown.timestamp ?
        cooldown.timestamp - Date.now() :
        new Date(cooldown.cooldownUntil).getTime() - Date.now()

      return Math.max(remainingMs, 0)
    }
    return 0
  } catch (error) {
    console.error("Error checking MFA cooldown:", error)
    return 0
  }
}

/**
 * Clear all MFA cooldowns for a user
 */
export async function clearAllMFACooldowns(userId: string): Promise<void> {
  try {
    await RedisMFA.deleteCooldown(userId, 'OTP_REQUEST')
    await RedisMFA.deleteCooldown(userId, 'OTP_VERIFY')
  } catch (error) {
    console.error("Error clearing MFA cooldowns:", error)
  }
}

/**
 * Clear daily OTP count for a user (called after successful login)
 */
export async function clearDailyCount(userId: string): Promise<void> {
  if (process.env.NODE_ENV !== "production" && process.env.E2E_TESTING === "1") {
    return
  }

  try {
    await RedisMFA.deleteDailyCount(userId)
  } catch (error) {
    // Only log error, don't throw as this is a non-critical cleanup operation
    console.error(`[MFA] Error clearing daily count for user ${userId}:`, error)
  }
}

// Redis is now used for all caching and cooldown management
