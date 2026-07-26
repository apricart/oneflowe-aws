import bcrypt from "bcryptjs"
import { randomInt } from "crypto"
import { env } from "@/lib/server/env"

const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 128
const SALT_ROUNDS = env.BCRYPT_ROUNDS

/**
 * Validate password meets bank-grade requirements
 */
export function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!password || typeof password !== 'string') {
    errors.push('Password must be a string')
    return { valid: false, errors }
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`)
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    errors.push(`Password must not exceed ${MAX_PASSWORD_LENGTH} characters`)
  }

  // Mandatory complexity for bank-grade security
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }
  if (!/\d/.test(password)) {
    errors.push('Password must contain at least one number')
  }
  if (!/[^a-zA-Z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character (!@#$%^&*)')
  }

  // Check for common weak passwords (basic check)
  const weakPasswords = ['password', '123456', 'qwerty', 'abc123', 'password123']
  if (weakPasswords.includes(password.toLowerCase())) {
    errors.push('Password is too common and weak')
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Check password strength (returns score 0-4)
 */
export function checkPasswordStrength(password: string): {
  score: number
  feedback: string[]
} {
  const feedback: string[] = []
  let score = 0

  if (!password || typeof password !== 'string') {
    return { score: 0, feedback: ['Invalid password'] }
  }

  // Length check
  if (password.length >= 8) score++
  if (password.length >= 12) score++

  // Complexity checks
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) {
    score++
    feedback.push('Good: Mixed case letters')
  } else {
    feedback.push('Suggestion: Use both uppercase and lowercase letters')
  }

  if (/\d/.test(password)) {
    score++
    feedback.push('Good: Contains numbers')
  } else {
    feedback.push('Suggestion: Add numbers')
  }

  if (/[^a-zA-Z0-9]/.test(password)) {
    score++
    feedback.push('Good: Contains special characters')
  } else {
    feedback.push('Suggestion: Add special characters (!@#$%^&*)')
  }

  // Cap score at 4
  score = Math.min(score, 4)

  return { score, feedback }
}

/**
 * Hash a password with bcrypt
 * @param plain - Plain text password
 * @returns Promise<string> - Hashed password
 */
export async function hashPassword(plain: string): Promise<string> {
  try {
    // Validate input
    if (!plain || typeof plain !== 'string') {
      throw new Error('Password must be a non-empty string')
    }

    if (plain.trim().length === 0) {
      throw new Error('Password cannot be empty or whitespace')
    }

    const validation = validatePassword(plain)
    if (!validation.valid) {
      throw new Error(`Invalid password: ${validation.errors.join(', ')}`)
    }

    // Hash password
    const hash = await bcrypt.hash(plain, SALT_ROUNDS)

    if (!hash || typeof hash !== 'string') {
      throw new Error('Failed to generate password hash')
    }

    return hash
  } catch (error) {
    console.error('[Password] Hashing error:', error)
    throw new Error(error instanceof Error ? error.message : 'Failed to hash password')
  }
}

/**
 * Verify a password against its hash
 * @param plain - Plain text password to verify
 * @param hash - Hashed password to compare against
 * @returns Promise<boolean> - True if password matches
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    // Validate inputs
    if (!plain || typeof plain !== 'string') {
      console.error('[Password] Invalid password provided for verification')
      return false
    }

    if (!hash || typeof hash !== 'string') {
      console.error('[Password] Invalid hash provided for verification')
      return false
    }

    // Validate hash format (bcrypt hashes start with $2a$, $2b$, or $2y$)
    if (!hash.startsWith('$2a$') && !hash.startsWith('$2b$') && !hash.startsWith('$2y$')) {
      console.error('[Password] Invalid hash format')
      return false
    }

    // Bcrypt compare
    const isMatch = await bcrypt.compare(plain, hash)
    return isMatch
  } catch (error) {
    console.error('[Password] Verification error:', error)
    return false
  }
}

/**
 * Generate a cryptographically secure random password
 * Uses crypto.randomInt() instead of Math.random() for bank-grade security
 * @param length - Length of password (default: 16)
 * @returns string - Random password
 */
export function generateRandomPassword(length: number = 16): string {
  try {
    if (typeof length !== 'number' || length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH) {
      length = 16
    }

    const charset = {
      lowercase: 'abcdefghijklmnopqrstuvwxyz',
      uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      numbers: '0123456789',
      special: '!@#$%^&*()_+-=[]{}|;:,.<>?'
    }

    // Ensure at least one character from each set (cryptographically secure)
    let password = ''
    password += charset.lowercase[randomInt(charset.lowercase.length)]
    password += charset.uppercase[randomInt(charset.uppercase.length)]
    password += charset.numbers[randomInt(charset.numbers.length)]
    password += charset.special[randomInt(charset.special.length)]

    // Fill remaining length with random characters from all sets
    const allChars = charset.lowercase + charset.uppercase + charset.numbers + charset.special
    for (let i = password.length; i < length; i++) {
      password += allChars[randomInt(allChars.length)]
    }

    // Fisher-Yates shuffle using crypto.randomInt (not Math.random)
    const arr = password.split('')
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(i + 1)
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr.join('')
  } catch (error) {
    console.error('[Password] Error generating random password:', error)
    throw new Error('Failed to generate random password')
  }
}

/**
 * Check if a hash needs rehashing (e.g., due to changed salt rounds)
 */
export function needsRehash(hash: string): boolean {
  try {
    if (!hash || typeof hash !== 'string') {
      return true
    }

    // Extract rounds from hash
    const parts = hash.split('$')
    if (parts.length < 4) {
      return true
    }

    const rounds = parseInt(parts[2])
    if (isNaN(rounds)) {
      return true
    }

    // Rehash if rounds don't match current configuration
    return rounds !== SALT_ROUNDS
  } catch (error) {
    console.error('[Password] Error checking if rehash needed:', error)
    return true
  }
}
