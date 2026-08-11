import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind CSS classes with clsx
 */
export function cn(...inputs: ClassValue[]) {
  try {
    return twMerge(clsx(inputs))
  } catch (error) {
    console.error('[Utils] Error merging classes:', error)
    return ''
  }
}

/**
 * Structured logger with timestamp and scope
 */
export function logger(scope: string, data: unknown) {
  try {
    // Validate scope
    if (!scope || typeof scope !== 'string') {
      console.warn('[Utils] Invalid logger scope')
      scope = 'UNKNOWN'
    }

    const ts = new Date().toISOString()
    console.log(`[${ts}] [${scope}]`, data)
  } catch (error) {
    console.error('[Utils] Logger error:', error)
  }
}

const pkFormatter = new Intl.NumberFormat("en-PK", {
  style: "currency",
  currency: "PKR",
})

/**
 * Format number as Pakistani Rupees
 */
export function formatPKR(value: number, options?: Intl.NumberFormatOptions) {
  try {
    // Validate input
    if (typeof value !== 'number' || Number.isNaN(value)) {
      console.warn('[Utils] Invalid value for formatPKR:', value)
      return 'PKR 0.00'
    }

    // Check for extremely large values
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      console.warn('[Utils] Value exceeds safe integer range:', value)
      return 'PKR 0.00'
    }

    if (options) {
      return new Intl.NumberFormat("en-PK", {
        style: "currency",
        currency: "PKR",
        ...options
      }).format(value)
    }

    return pkFormatter.format(value)
  } catch (error) {
    console.error('[Utils] Error formatting PKR:', error)
    return 'PKR 0.00'
  }
}

/**
 * Escape special characters in SQL LIKE patterns
 * Prevents wildcard injection attacks where users could use % or _ to bypass search filters
 */
export function escapeLikePattern(input: string): string {
  try {
    if (!input || typeof input !== 'string') {
      return ''
    }

    // Escape %, _, and \ which have special meaning in LIKE patterns
    return input.replace(/[%_\\]/g, String.raw`\$&`)
  } catch (error) {
    console.error('[Utils] Error escaping LIKE pattern:', error)
    return ''
  }
}

/**
 * Sanitize string input - removes null bytes and trims whitespace
 */
export function sanitizeInput(input: string): string {
  try {
    if (!input || typeof input !== 'string') {
      return ''
    }

    // Remove null bytes, trim whitespace, and limit length
    const sanitized = input.replace(/\0/g, '').trim()

    // Prevent extremely long inputs (DOS attack vector)
    const maxLength = 10000
    if (sanitized.length > maxLength) {
      console.warn(`[Utils] Input truncated from ${sanitized.length} to ${maxLength} chars`)
      return sanitized.substring(0, maxLength)
    }

    return sanitized
  } catch (error) {
    console.error('[Utils] Error sanitizing input:', error)
    return ''
  }
}

/**
 * Safe JSON parse that returns null on error
 */
export function safeJsonParse<T = any>(json: string): T | null {
  try {
    if (!json || typeof json !== 'string') {
      return null
    }

    return JSON.parse(json) as T
  } catch (error) {
    console.error('[Utils] JSON parse error:', error)
    return null
  }
}

/**
 * Safe number conversion
 */
export function safeParseInt(value: string | number, defaultValue: number = 0): number {
  try {
    if (typeof value === 'number') {
      return Number.isNaN(value) ? defaultValue : value
    }

    if (!value || typeof value !== 'string') {
      return defaultValue
    }

    const parsed = Number.parseInt(value, 10)
    return Number.isNaN(parsed) ? defaultValue : parsed
  } catch (error) {
    console.error('[Utils] Error parsing int:', error)
    return defaultValue
  }
}

/**
 * Safe float conversion
 */
export function safeParseFloat(value: string | number, defaultValue: number = 0): number {
  try {
    if (typeof value === 'number') {
      return Number.isNaN(value) ? defaultValue : value
    }

    if (!value || typeof value !== 'string') {
      return defaultValue
    }

    const parsed = Number.parseFloat(value)
    return Number.isNaN(parsed) ? defaultValue : parsed
  } catch (error) {
    console.error('[Utils] Error parsing float:', error)
    return defaultValue
  }
}

/**
 * Format date to readable string
 */
export function formatDate(date: Date | string, locale: string = 'en-US'): string {
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date

    if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
      console.warn('[Utils] Invalid date:', date)
      return 'Invalid Date'
    }

    return dateObj.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  } catch (error) {
    console.error('[Utils] Error formatting date:', error)
    return 'Invalid Date'
  }
}

/**
 * Format date with time
 */
export function formatDateTime(date: Date | string, locale: string = 'en-US'): string {
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date

    if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
      console.warn('[Utils] Invalid date:', date)
      return 'Invalid Date'
    }

    return dateObj.toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch (error) {
    console.error('[Utils] Error formatting datetime:', error)
    return 'Invalid Date'
  }
}

/**
 * Clamp number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  try {
    if (typeof value !== 'number' || typeof min !== 'number' || typeof max !== 'number') {
      console.warn('[Utils] Invalid arguments for clamp')
      return min
    }

    if (Number.isNaN(value) || Number.isNaN(min) || Number.isNaN(max)) {
      console.warn('[Utils] NaN values in clamp')
      return min
    }

    return Math.min(Math.max(value, min), max)
  } catch (error) {
    console.error('[Utils] Error in clamp:', error)
    return min
  }
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  const validMs = typeof ms === 'number' && ms > 0 ? Math.min(ms, 60000) : 1000
  return new Promise(resolve => setTimeout(resolve, validMs))
}

/**
 * Truncate string to specified length
 */
export function truncate(str: string, maxLength: number, suffix: string = '...'): string {
  try {
    if (!str || typeof str !== 'string') {
      return ''
    }

    if (typeof maxLength !== 'number' || maxLength <= 0) {
      maxLength = 100
    }

    if (str.length <= maxLength) {
      return str
    }

    return str.substring(0, maxLength - suffix.length) + suffix
  } catch (error) {
    console.error('[Utils] Error truncating string:', error)
    return str
  }
}
