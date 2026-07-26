import { Redis } from '@upstash/redis'
import { env } from '@/lib/server/env'

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
})

export { redis }

// Redis key patterns for MFA system
export const REDIS_KEYS = {
  MFA_COOLDOWN: (userId: string, type: string) => {
    if (!userId || !type) {
      throw new Error('userId and type are required for MFA_COOLDOWN key')
    }
    return `mfa:cooldown:${userId}:${type}`
  },
  MFA_OTP: (userId: string, code: string) => {
    if (!userId || !code) {
      throw new Error('userId and code are required for MFA_OTP key')
    }
    return `mfa:otp:${userId}:${code}`
  },
  MFA_OTP_LATEST: (userId: string, type: string) => {
    if (!userId || !type) {
      throw new Error('userId and type are required for MFA_OTP_LATEST key')
    }
    return `mfa:otp:latest:${userId}:${type}`
  },
  MFA_ATTEMPTS: (userId: string, type: string) => {
    if (!userId || !type) {
      throw new Error('userId and type are required for MFA_ATTEMPTS key')
    }
    return `mfa:attempts:${userId}:${type}`
  },
  MFA_DAILY_COUNT: (userId: string, date: string) => {
    if (!userId || !date) {
      throw new Error('userId and date are required for MFA_DAILY_COUNT key')
    }
    return `mfa:daily:${userId}:${date}`
  },
} as const

/**
 * Check if Redis is available
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    await redis.ping()
    return true
  } catch (error: any) {
    if (error.message?.includes('WRONGPASS') || error.message?.includes('unauthorized')) {
      console.error('[Redis] Authentication failed. Please check UPSTASH_REDIS_REST_TOKEN.')
    } else {
      console.error('[Redis] Connection check failed:', error)
    }
    return false
  }
}

// Helper functions for Redis operations
export class RedisMFA {
  // Set cooldown with TTL
  static async setCooldown(userId: string, type: string, ttlSeconds: number, attempts: number = 1): Promise<void> {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        throw new Error('Invalid userId for setCooldown')
      }
      if (!type || typeof type !== 'string') {
        throw new Error('Invalid type for setCooldown')
      }
      if (typeof ttlSeconds !== 'number' || ttlSeconds <= 0 || ttlSeconds > 86400) {
        throw new Error('ttlSeconds must be a positive number not exceeding 24 hours')
      }
      if (typeof attempts !== 'number' || attempts < 1) {
        throw new Error('attempts must be a positive number')
      }

      const key = REDIS_KEYS.MFA_COOLDOWN(userId, type)
      const cooldownUntil = new Date(Date.now() + ttlSeconds * 1000)
      const cooldownData = {
        userId,
        type,
        attempts,
        cooldownUntil: cooldownUntil.toISOString(),
        timestamp: cooldownUntil.getTime()
      }
      await redis.setex(key, ttlSeconds, JSON.stringify(cooldownData))
    } catch (error) {
      console.error('[Redis] Failed to set cooldown:', error)
      throw error
    }
  }

  // Get cooldown data
  static async getCooldown(userId: string, type: string): Promise<any | null> {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        console.error('[Redis] Invalid userId for getCooldown')
        return null
      }
      if (!type || typeof type !== 'string') {
        console.error('[Redis] Invalid type for getCooldown')
        return null
      }

      const key = REDIS_KEYS.MFA_COOLDOWN(userId, type)
      const data = await redis.get(key)

      if (!data) return null

      // Handle different data types from Upstash Redis
      if (typeof data === 'string') {
        try {
          return JSON.parse(data)
        } catch (error) {
          console.error('Error parsing cooldown data:', error, 'Data:', data)
          return null
        }
      } else if (typeof data === 'object') {
        return data
      }
      return null
    } catch (error) {
      console.error('[Redis] Failed to get cooldown:', error)
      return null
    }
  }

  // Delete cooldown
  static async deleteCooldown(userId: string, type: string): Promise<void> {
    const key = REDIS_KEYS.MFA_COOLDOWN(userId, type)
    await redis.del(key)
  }

  // Set OTP with TTL
  static async setOTP(userId: string, code: string, ttlSeconds: number, type: string): Promise<void> {
    const key = REDIS_KEYS.MFA_OTP(userId, code)
    const latestKey = REDIS_KEYS.MFA_OTP_LATEST(userId, type)
    const otpData = {
      userId,
      code,
      type,
      createdAt: new Date().toISOString(),
      attempts: 0,
      isUsed: false,
    }
    await redis.setex(key, ttlSeconds, JSON.stringify(otpData))
    await redis.setex(latestKey, ttlSeconds, code)
  }

  // Get OTP data
  static async getOTP(userId: string, code: string): Promise<any | null> {
    const key = REDIS_KEYS.MFA_OTP(userId, code)
    const data = await redis.get(key)
    if (!data) return null

    // Handle different data types from Upstash Redis
    if (typeof data === 'string') {
      try {
        return JSON.parse(data)
      } catch (error) {
        console.error('Error parsing OTP data:', error, 'Data:', data)
        return null
      }
    } else if (typeof data === 'object') {
      return data
    }
    return null
  }

  // Get latest active OTP code for a user and MFA type
  static async getLatestOTPCode(userId: string, type: string): Promise<string | null> {
    const key = REDIS_KEYS.MFA_OTP_LATEST(userId, type)
    const data = await redis.get(key)

    if (!data) return null
    if (typeof data === 'string') return data
    if (typeof data === 'number') return String(data)

    return null
  }

  // Update OTP attempts
  static async updateOTPAttempts(userId: string, code: string, attempts: number): Promise<void> {
    const key = REDIS_KEYS.MFA_OTP(userId, code)
    const data = await redis.get(key)
    if (data) {
      let otpData
      if (typeof data === 'string') {
        try {
          otpData = JSON.parse(data)
        } catch (error) {
          console.error('Error parsing OTP data for update:', error)
          return
        }
      } else if (typeof data === 'object') {
        otpData = data
      } else {
        return
      }

      otpData.attempts = attempts
      await redis.setex(key, 120, JSON.stringify(otpData)) // 2 minutes TTL
    }
  }

  // Mark OTP as used
  static async markOTPUsed(userId: string, code: string): Promise<void> {
    const key = REDIS_KEYS.MFA_OTP(userId, code)
    const data = await redis.get(key)
    if (data) {
      let otpData
      if (typeof data === 'string') {
        try {
          otpData = JSON.parse(data)
        } catch (error) {
          console.error('Error parsing OTP data for mark used:', error)
          return
        }
      } else if (typeof data === 'object') {
        otpData = data
      } else {
        return
      }

      otpData.isUsed = true
      await redis.setex(key, 120, JSON.stringify(otpData)) // 2 minutes TTL
    }
  }

  // Clear latest OTP pointer after successful verification
  static async deleteLatestOTP(userId: string, type: string): Promise<void> {
    const key = REDIS_KEYS.MFA_OTP_LATEST(userId, type)
    await redis.del(key)
  }

  // Delete OTP
  static async deleteOTP(userId: string, code: string): Promise<void> {
    const key = REDIS_KEYS.MFA_OTP(userId, code)
    await redis.del(key)
  }

  // Increment daily count
  static async incrementDailyCount(userId: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0]
    const key = REDIS_KEYS.MFA_DAILY_COUNT(userId, today)
    const count = await redis.incr(key)
    // Set expiry to end of day (24 hours from now)
    const ttl = Math.ceil((new Date().setHours(23, 59, 59, 999) - Date.now()) / 1000)
    await redis.expire(key, ttl)
    return count
  }

  // Get daily count
  static async getDailyCount(userId: string): Promise<number> {
    const today = new Date().toISOString().split('T')[0]
    const key = REDIS_KEYS.MFA_DAILY_COUNT(userId, today)
    const count = await redis.get(key)
    if (!count) return 0

    if (typeof count === 'string') {
      const parsed = parseInt(count)
      return isNaN(parsed) ? 0 : parsed
    } else if (typeof count === 'number') {
      return count
    }
    return 0
  }

  // Delete daily count
  static async deleteDailyCount(userId: string): Promise<void> {
    try {
      if (!userId || typeof userId !== 'string') {
        throw new Error('Invalid userId for deleteDailyCount')
      }
      const today = new Date().toISOString().split('T')[0]
      const key = REDIS_KEYS.MFA_DAILY_COUNT(userId, today)
      await redis.del(key)
    } catch (error) {
      console.error('[Redis] Failed to delete daily count:', error)
      throw error
    }
  }

  // Clean up expired keys (optional maintenance function)
  static async cleanupExpiredKeys(): Promise<void> {
    // Redis automatically handles TTL, but we can add cleanup logic here if needed
    // Redis automatically handles TTL — no manual cleanup needed
  }
}
