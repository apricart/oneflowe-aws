/**
 * Secure Approval Token Utilities
 * 
 * Generates and verifies approval tokens for order fulfillment.
 * Tokens are hashed using bcrypt - never stored in plaintext.
 */

import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

// Characters used for token generation (no confusing chars like 0/O, 1/I/L)
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const DEFAULT_TOKEN_LENGTH = 10
const MIN_TOKEN_LENGTH = 6
const MAX_TOKEN_LENGTH = 32
const BCRYPT_ROUNDS = 10

/**
 * Validate token length
 */
function validateTokenLength(length: number): number {
    if (typeof length !== 'number' || Number.isNaN(length)) {
        console.warn(`[ApprovalToken] Invalid length: ${length}, using default: ${DEFAULT_TOKEN_LENGTH}`)
        return DEFAULT_TOKEN_LENGTH
    }

    if (length < MIN_TOKEN_LENGTH || length > MAX_TOKEN_LENGTH) {
        console.warn(`[ApprovalToken] Length ${length} out of range (${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH}), using default`)
        return DEFAULT_TOKEN_LENGTH
    }

    return length
}

/**
 * Generate a cryptographically secure approval token
 * @param length Token length (default: 10, min: 6, max: 32)
 * @returns Uppercase alphanumeric token
 */
export function generateApprovalToken(length: number = DEFAULT_TOKEN_LENGTH): string {
    try {
        const validLength = validateTokenLength(length)

        // Generate cryptographically secure random bytes
        const bytes = randomBytes(validLength)
        let token = ''

        for (let i = 0; i < validLength; i++) {
            token += TOKEN_CHARS[bytes[i] % TOKEN_CHARS.length]
        }

        // Validate generated token
        if (token.length !== validLength) {
            throw new Error('Generated token length mismatch')
        }

        return token
    } catch (error) {
        console.error('[ApprovalToken] Error generating token:', error)
        throw new Error('Failed to generate secure approval token')
    }
}

/**
 * Hash an approval token for secure storage
 * @param token Plain text token
 * @returns Bcrypt hash
 */
export async function hashApprovalToken(token: string): Promise<string> {
    try {
        // Validate input
        if (!token || typeof token !== 'string') {
            throw new Error('Token must be a non-empty string')
        }

        const sanitized = token.toUpperCase().trim()

        // Validate sanitized token
        if (sanitized.length === 0) {
            throw new Error('Token cannot be empty after trimming')
        }

        if (sanitized.length < MIN_TOKEN_LENGTH) {
            throw new Error(`Token too short (minimum ${MIN_TOKEN_LENGTH} characters)`)
        }

        if (sanitized.length > MAX_TOKEN_LENGTH) {
            throw new Error(`Token too long (maximum ${MAX_TOKEN_LENGTH} characters)`)
        }

        // Validate token only contains allowed characters
        const validCharsRegex = new RegExp(`^[${TOKEN_CHARS}]+$`)
        if (!validCharsRegex.test(sanitized)) {
            throw new Error('Token contains invalid characters')
        }

        const hash = await bcrypt.hash(sanitized, BCRYPT_ROUNDS)

        // Validate hash was generated
        if (!hash || typeof hash !== 'string') {
            throw new Error('Failed to generate hash')
        }

        return hash
    } catch (error) {
        console.error('[ApprovalToken] Error hashing token:', error)
        throw error instanceof Error ? error : new Error('Failed to hash approval token')
    }
}

/**
 * Verify an approval token against a stored hash
 * @param token Plain text token provided by user
 * @param hash Stored bcrypt hash
 * @returns True if token matches hash
 */
export async function verifyApprovalToken(token: string, hash: string): Promise<boolean> {
    try {
        // Validate inputs
        if (!token || typeof token !== 'string') {
            console.error('[ApprovalToken] Invalid token provided for verification')
            return false
        }

        if (!hash || typeof hash !== 'string') {
            console.error('[ApprovalToken] Invalid hash provided for verification')
            return false
        }

        // Validate hash format (bcrypt hashes start with $2a$, $2b$, or $2y$)
        if (!hash.startsWith('$2a$') && !hash.startsWith('$2b$') && !hash.startsWith('$2y$')) {
            console.error('[ApprovalToken] Invalid hash format')
            return false
        }

        const sanitized = token.toUpperCase().trim()

        // Validate sanitized token
        if (sanitized.length === 0) {
            console.error('[ApprovalToken] Empty token after sanitization')
            return false
        }

        if (sanitized.length < MIN_TOKEN_LENGTH || sanitized.length > MAX_TOKEN_LENGTH) {
            console.error('[ApprovalToken] Token length out of valid range')
            return false
        }

        // Perform comparison
        const isValid = await bcrypt.compare(sanitized, hash)
        return isValid
    } catch (error) {
        console.error('[ApprovalToken] Error verifying token:', error)
        return false
    }
}

/**
 * Validate token format without requiring hash
 * @param token Token to validate
 * @returns True if token has valid format
 */
export function isValidTokenFormat(token: string): boolean {
    try {
        if (!token || typeof token !== 'string') {
            return false
        }

        const sanitized = token.toUpperCase().trim()

        if (sanitized.length < MIN_TOKEN_LENGTH || sanitized.length > MAX_TOKEN_LENGTH) {
            return false
        }

        const validCharsRegex = new RegExp(`^[${TOKEN_CHARS}]+$`)
        return validCharsRegex.test(sanitized)
    } catch (error) {
        console.error('[ApprovalToken] Error validating token format:', error)
        return false
    }
}
