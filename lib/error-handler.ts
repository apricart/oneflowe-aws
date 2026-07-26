/**
 * Centralized error handling utilities for consistent error responses
 */

export type ErrorType =
  | 'VALIDATION_ERROR'
  | 'PERMISSION_ERROR'
  | 'NOT_FOUND_ERROR'
  | 'DUPLICATE_ERROR'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'MFA_ERROR'
  | 'DATABASE_ERROR'
  | 'TIMEOUT_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'CONFLICT_ERROR'
  | 'BAD_REQUEST_ERROR'
  | 'INTERNAL_ERROR'

export interface ErrorDetails {
  type: ErrorType
  message: string
  field?: string
  code?: string
  statusCode: number
  context?: Record<string, any>
  recoverySuggestion?: string
  retryable?: boolean
}

/**
 * Standard error messages for common scenarios
 */
export const ERROR_MESSAGES = {
  // Validation errors
  REQUIRED_FIELD: (field: string) => `${field} is required`,
  INVALID_EMAIL: 'Please enter a valid email address',
  INVALID_PASSWORD: 'Password must be at least 12 characters long, with uppercase, lowercase, number, and special character',
  INVALID_ROLE: 'Please select a valid role',
  INVALID_INPUT: 'Invalid input provided',
  INVALID_FORMAT: (field: string) => `${field} has an invalid format`,
  OUT_OF_RANGE: (field: string, min?: number, max?: number) => {
    if (min !== undefined && max !== undefined) {
      return `${field} must be between ${min} and ${max}`
    }
    return `${field} is out of acceptable range`
  },

  // Permission errors
  ORGANIZATION_SCOPE: 'You can only manage users within your own organization',
  BRANCH_SCOPE: 'You can only manage users within your own branch',
  INSUFFICIENT_PERMISSIONS: 'You don\'t have permission to perform this action',
  UNAUTHORIZED: 'Authentication required to access this resource',
  FORBIDDEN: 'Access to this resource is forbidden',

  // Duplicate errors
  DUPLICATE_EMAIL: 'This email address is already registered. Please use a different email',
  DUPLICATE_ENTRY: (field: string) => `This ${field} already exists`,
  CONFLICT: 'The resource you\'re trying to modify has been changed by another user',

  // Not found errors
  USER_NOT_FOUND: 'User not found. It may have been deleted by another user',
  ORGANIZATION_NOT_FOUND: 'Organization not found',
  BRANCH_NOT_FOUND: 'Branch not found',
  RESOURCE_NOT_FOUND: (resource: string) => `${resource} not found`,
  NOT_FOUND: 'The requested resource was not found',

  // Network errors
  REQUEST_TIMEOUT: 'Request timed out. Please check your connection and try again',
  NETWORK_ERROR: 'Network error. Please check your connection and try again',
  CONNECTION_ERROR: 'Unable to connect to the server. Please try again later',

  // Server errors
  UNABLE_TO_VERIFY_PERMISSIONS: 'Unable to verify permissions',
  DATABASE_ERROR: 'Database error. Please try again',
  DATABASE_CONNECTION_ERROR: 'Unable to connect to database. Please try again later',
  DATABASE_TIMEOUT: 'Database operation timed out. Please try again',
  TRANSACTION_FAILED: 'Transaction failed. Please try again',
  UNKNOWN_ERROR: 'An unexpected error occurred. Please try again',
  INTERNAL_ERROR: 'An internal server error occurred. Our team has been notified',

  // MFA errors
  DAILY_LIMIT_EXCEEDED: 'Daily OTP request limit exceeded. Please try again tomorrow.',
  COOLDOWN_ACTIVE: 'Please wait before requesting another OTP.',
  INVALID_OTP: 'Invalid OTP code. Please check your email and try again.',
  OTP_EXPIRED: 'OTP has expired. Please request a new one.',

  // Rate limiting
  RATE_LIMIT_EXCEEDED: 'Too many requests. Please slow down and try again later',

  // Inventory specific
  INSUFFICIENT_STOCK: 'Insufficient stock available',
  INVALID_QUANTITY: 'Please enter a valid quantity',
  NEGATIVE_STOCK: 'Stock quantity cannot be negative',
} as const

/**
 * Parse error message to determine error type and details
 */
export function parseError(error: any): ErrorDetails {
  const errorMsg = error?.message || error?.toString() || ''
  const databaseError = error?.cause || error

  // Drizzle includes SQL column names such as `organization_id` in query
  // failures. Classify database failures before user-facing keyword matching so
  // they are not incorrectly reported as organization permission errors.
  if (
    error?.name === 'DrizzleQueryError' ||
    errorMsg.includes('Failed query:') ||
    databaseError?.severity ||
    databaseError?.routine ||
    isDatabaseError(databaseError)
  ) {
    return parseDatabaseError(databaseError)
  }

  // Validation errors
  if (errorMsg.includes('required')) {
    if (errorMsg.includes('firstName')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.REQUIRED_FIELD('First name'),
        field: 'firstName',
        statusCode: 400
      }
    }
    if (errorMsg.includes('lastName')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.REQUIRED_FIELD('Last name'),
        field: 'lastName',
        statusCode: 400
      }
    }
    if (errorMsg.includes('email')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.REQUIRED_FIELD('Email'),
        field: 'email',
        statusCode: 400
      }
    }
    if (errorMsg.includes('password')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.REQUIRED_FIELD('Password'),
        field: 'password',
        statusCode: 400
      }
    }
    if (errorMsg.includes('role')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.REQUIRED_FIELD('Role'),
        field: 'role',
        statusCode: 400
      }
    }
    if (errorMsg.includes('organizationId')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.REQUIRED_FIELD('Organization'),
        field: 'organizationId',
        statusCode: 400
      }
    }
    if (errorMsg.includes('branchId')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.REQUIRED_FIELD('Branch'),
        field: 'branchId',
        statusCode: 400
      }
    }
  }

  // Duplicate errors (username, email, phone, and employee number)
  if (errorMsg.includes('already exists') || errorMsg.includes('already registered') || errorMsg.includes('unique')) {
    if (errorMsg.includes('username') && (errorMsg.includes('taken') || errorMsg.includes('use') || errorMsg.includes('exists') || errorMsg.includes('idx') || errorMsg.includes('uq'))) {
      return {
        type: 'DUPLICATE_ERROR',
        message: 'This username already exists. Please choose a different username.',
        field: 'username',
        statusCode: 400
      }
    }
    if (errorMsg.includes('email')) {
      return {
        type: 'DUPLICATE_ERROR',
        message: 'This email is already registered with this app. Please use another email.',
        field: 'email',
        statusCode: 400
      }
    }
    if (errorMsg.includes('phone')) {
      return {
        type: 'DUPLICATE_ERROR',
        message: 'This phone number is already registered with this app. Please use another phone number.',
        field: 'phone',
        statusCode: 400
      }
    }
    if (errorMsg.includes('employee')) {
      return {
        type: 'DUPLICATE_ERROR',
        message: 'This employee number is already registered with this app. Please use another employee number.',
        field: 'employeeId',
        statusCode: 400
      }
    }
  }


  // Permission errors
  if (errorMsg.includes('organization')) {
    return {
      type: 'PERMISSION_ERROR',
      message: ERROR_MESSAGES.ORGANIZATION_SCOPE,
      statusCode: 403
    }
  }

  if (errorMsg.includes('permission') || errorMsg.includes('unauthorized')) {
    return {
      type: 'PERMISSION_ERROR',
      message: ERROR_MESSAGES.INSUFFICIENT_PERMISSIONS,
      statusCode: 403
    }
  }

  // Not found errors
  if (errorMsg.includes('not found') || errorMsg.includes('404')) {
    return {
      type: 'NOT_FOUND_ERROR',
      message: ERROR_MESSAGES.USER_NOT_FOUND,
      statusCode: 404
    }
  }

  // Network errors
  if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
    return {
      type: 'NETWORK_ERROR',
      message: ERROR_MESSAGES.REQUEST_TIMEOUT,
      statusCode: 408
    }
  }

  if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
    return {
      type: 'NETWORK_ERROR',
      message: ERROR_MESSAGES.NETWORK_ERROR,
      statusCode: 503
    }
  }

  // MFA errors must be checked before generic "Invalid ... email" validation,
  // because the user-facing invalid OTP message asks users to check their email.
  if (errorMsg.includes('Daily OTP request limit exceeded') || errorMsg.includes('daily limit')) {
    return {
      type: 'MFA_ERROR',
      message: ERROR_MESSAGES.DAILY_LIMIT_EXCEEDED,
      statusCode: 400
    }
  }

  if (errorMsg.includes('cooldown') || errorMsg.includes('wait before requesting')) {
    return {
      type: 'MFA_ERROR',
      message: ERROR_MESSAGES.COOLDOWN_ACTIVE,
      statusCode: 400
    }
  }

  if (errorMsg.includes('Invalid OTP') || errorMsg.includes('Invalid or expired OTP code') || errorMsg.includes('invalid code')) {
    return {
      type: 'MFA_ERROR',
      message: ERROR_MESSAGES.INVALID_OTP,
      statusCode: 400
    }
  }

  if (errorMsg.includes('expired') || errorMsg.includes('OTP has expired')) {
    return {
      type: 'MFA_ERROR',
      message: ERROR_MESSAGES.OTP_EXPIRED,
      statusCode: 400
    }
  }

  // Invalid format errors
  if (errorMsg.includes('Invalid')) {
    if (errorMsg.includes('email')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.INVALID_EMAIL,
        field: 'email',
        statusCode: 400
      }
    }
    if (errorMsg.includes('role')) {
      return {
        type: 'VALIDATION_ERROR',
        message: ERROR_MESSAGES.INVALID_ROLE,
        field: 'role',
        statusCode: 400
      }
    }
  }

  if (errorMsg.includes('password')) {
    return {
      type: 'VALIDATION_ERROR',
      message: ERROR_MESSAGES.INVALID_PASSWORD,
      field: 'password',
      statusCode: 400
    }
  }

  // Pre-mapped specific messages from our APIs (e.g. blockers)
  if (errorMsg.startsWith('Cannot delete') || errorMsg.includes('Please') || errorMsg.includes('assigned') || errorMsg.includes('records') || errorMsg.includes('Linked')) {
    return {
      type: 'VALIDATION_ERROR',
      message: errorMsg,
      statusCode: 400
    }
  }

  // If we already have a 400-level error with a descriptive message, use it
  if (error?.status >= 400 && error?.status < 500 && errorMsg && !errorMsg.includes('status')) {
    return {
      type: 'VALIDATION_ERROR',
      message: errorMsg,
      statusCode: error.status
    }
  }

  // Default server error - NEVER expose raw error messages to users
  // Log the actual error for debugging but return generic message
  if (process.env.NODE_ENV !== 'production') {
    console.error('Unhandled error:', errorMsg)
  }
  return {
    type: 'SERVER_ERROR',
    message: ERROR_MESSAGES.UNKNOWN_ERROR,
    statusCode: 500
  }
}

/**
 * Create a user-friendly error message for frontend display
 */
export function createUserFriendlyError(error: any): { message: string; field?: string; type: ErrorType; status: number } {
  const errorDetails = parseError(error)
  return {
    message: errorDetails.message,
    field: errorDetails.field,
    type: errorDetails.type,
    status: errorDetails.statusCode
  }
}

/**
 * Log error for debugging while returning user-friendly message
 */
export function handleError(error: any, context: string): { message: string; field?: string; type: ErrorType; status: number } {
  const errorDetails = parseError(error)
  const isValidationError = errorDetails.statusCode >= 400 && errorDetails.statusCode < 500

  // Use quieter logging for expected validation failures
  if (isValidationError) {
    console.warn(`[Validation] ${context}: ${errorDetails.message}`)
  } else {
    console.error(`[Critical] Error in ${context}:`, error)
  }

  return createUserFriendlyError(error)
}

/**
 * Check if error is a database error
 */
export function isDatabaseError(error: any): boolean {
  if (!error) return false
  const errorMsg = error?.message || error?.toString() || ''
  return errorMsg.includes('database') ||
    errorMsg.includes('SQL') ||
    errorMsg.includes('query') ||
    errorMsg.includes('relation') ||
    errorMsg.includes('ECONNREFUSED') ||
    errorMsg.includes('ETIMEDOUT') ||
    error?.code === 'ECONNREFUSED' ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === '23505' || // Unique violation
    error?.code === '23503' || // Foreign key violation
    error?.code === '23502'    // Not null violation
}

/**
 * Check if error is a timeout error
 */
export function isTimeoutError(error: any): boolean {
  if (!error) return false
  const errorMsg = error?.message || error?.toString() || ''
  return errorMsg.includes('timeout') ||
    errorMsg.includes('timed out') ||
    errorMsg.includes('ETIMEDOUT') ||
    error?.code === 'ETIMEDOUT'
}

/**
 * Check if error is a conflict/concurrency error
 */
export function isConflictError(error: any): boolean {
  if (!error) return false
  const errorMsg = error?.message || error?.toString() || ''
  return errorMsg.includes('conflict') ||
    errorMsg.includes('concurrent') ||
    errorMsg.includes('modified by another') ||
    error?.code === '40001' || // Serialization failure
    error?.code === '40P01'    // Deadlock
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: any): boolean {
  return isTimeoutError(error) ||
    isConflictError(error) ||
    (isDatabaseError(error) && error?.code === 'ETIMEDOUT')
}

/**
 * Mask sensitive data in error context
 */
export function maskSensitiveData(data: any): any {
  if (!data || typeof data !== 'object') return data

  const masked = { ...data }
  const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'otp', 'pin']

  for (const key of Object.keys(masked)) {
    if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
      masked[key] = '***MASKED***'
    } else if (typeof masked[key] === 'object' && masked[key] !== null) {
      masked[key] = maskSensitiveData(masked[key])
    }
  }

  return masked
}

/**
 * Create detailed error for logging (with sensitive data masked)
 */
export function createDetailedError(error: any, context: string, additionalData?: Record<string, any>): {
  error: string
  context: string
  timestamp: string
  data?: Record<string, any>
} {
  return {
    error: error?.message || error?.toString() || 'Unknown error',
    context,
    timestamp: new Date().toISOString(),
    data: additionalData ? maskSensitiveData(additionalData) : undefined
  }
}

/**
 * Enhanced database error parser
 */
export function parseDatabaseError(error: any): ErrorDetails {
  const errorMsg = error?.message || error?.toString() || ''
  const code = error?.code

  // PostgreSQL error codes
  if (code === '23505') { // Unique violation
    return {
      type: 'DUPLICATE_ERROR',
      message: ERROR_MESSAGES.DUPLICATE_ENTRY('record'),
      statusCode: 409,
      code,
      retryable: false
    }
  }

  if (code === '23503') { // Foreign key violation
    return {
      type: 'VALIDATION_ERROR',
      message: 'Referenced resource does not exist',
      statusCode: 400,
      code,
      retryable: false
    }
  }

  if (code === '23502') { // Not null violation
    return {
      type: 'VALIDATION_ERROR',
      message: ERROR_MESSAGES.REQUIRED_FIELD('field'),
      statusCode: 400,
      code,
      retryable: false
    }
  }

  if (code === '40001' || code === '40P01') { // Serialization failure / Deadlock
    return {
      type: 'CONFLICT_ERROR',
      message: ERROR_MESSAGES.CONFLICT,
      statusCode: 409,
      code,
      retryable: true,
      recoverySuggestion: 'Please try again in a moment'
    }
  }

  if (code === 'ECONNREFUSED') {
    return {
      type: 'DATABASE_ERROR',
      message: ERROR_MESSAGES.DATABASE_CONNECTION_ERROR,
      statusCode: 503,
      code,
      retryable: true,
      recoverySuggestion: 'Please contact support if this persists'
    }
  }

  if (code === 'ETIMEDOUT' || errorMsg.includes('timeout')) {
    return {
      type: 'TIMEOUT_ERROR',
      message: ERROR_MESSAGES.DATABASE_TIMEOUT,
      statusCode: 504,
      code,
      retryable: true,
      recoverySuggestion: 'Try simplifying your request or try again later'
    }
  }

  // Generic database error
  return {
    type: 'DATABASE_ERROR',
    message: ERROR_MESSAGES.DATABASE_ERROR,
    statusCode: 500,
    code,
    retryable: false
  }
}

/**
 * Validate input and throw descriptive error if invalid
 */
export function validateInput(value: any, fieldName: string, options?: {
  required?: boolean
  minLength?: number
  maxLength?: number
  pattern?: RegExp
  custom?: (val: any) => boolean
}): void {
  if (options?.required && (value === null || value === undefined || value === '')) {
    throw new Error(ERROR_MESSAGES.REQUIRED_FIELD(fieldName))
  }

  if (value !== null && value !== undefined && value !== '') {
    if (typeof value === 'string') {
      if (options?.minLength && value.length < options.minLength) {
        throw new Error(`${fieldName} must be at least ${options.minLength} characters`)
      }
      if (options?.maxLength && value.length > options.maxLength) {
        throw new Error(`${fieldName} must not exceed ${options.maxLength} characters`)
      }
      if (options?.pattern && !options.pattern.test(value)) {
        throw new Error(ERROR_MESSAGES.INVALID_FORMAT(fieldName))
      }
    }

    if (options?.custom && !options.custom(value)) {
      throw new Error(ERROR_MESSAGES.INVALID_INPUT)
    }
  }
}

/**
 * Validate numeric range
 */
export function validateRange(value: number, fieldName: string, min?: number, max?: number): void {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error(ERROR_MESSAGES.INVALID_FORMAT(fieldName))
  }

  if (min !== undefined && value < min) {
    throw new Error(ERROR_MESSAGES.OUT_OF_RANGE(fieldName, min, max))
  }

  if (max !== undefined && value > max) {
    throw new Error(ERROR_MESSAGES.OUT_OF_RANGE(fieldName, min, max))
  }
}

/**
 * Safe async error wrapper - catches errors and returns ErrorDetails
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  context: string
): Promise<{ data?: T; error?: ErrorDetails }> {
  try {
    const data = await fn()
    return { data }
  } catch (error) {
    console.error(`Error in ${context}:`, createDetailedError(error, context))

    if (isDatabaseError(error)) {
      return { error: parseDatabaseError(error) }
    }

    return { error: parseError(error) }
  }
}

