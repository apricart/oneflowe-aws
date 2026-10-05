import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `RedisMFA` against the in-memory Redis with a controllable clock. Upstash
 * returns either a JSON string or an already-decoded object depending on what
 * was stored, so each reader is exercised with both shapes, and the TTLs are
 * checked by moving the clock rather than by trusting the arguments.
 */
const store = vi.hoisted(() => ({ instance: null as null | import("@/lib/local-memory-redis").LocalMemoryRedis }))

vi.mock("@upstash/redis", async () => {
  const { LocalMemoryRedis } = await import("@/lib/local-memory-redis")
  return {
    Redis: class {
      constructor() {
        store.instance = new LocalMemoryRedis(() => Date.now())
        return store.instance
      }
    },
  }
})

import { REDIS_KEYS, RedisMFA, isRedisAvailable, redis } from "./redis"

const NOW = new Date("2026-10-06T08:00:00.000Z")

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  for (const key of await redis.keys("*")) await redis.del(key)
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("REDIS_KEYS", () => {
  it("builds namespaced keys", () => {
    expect(REDIS_KEYS.MFA_COOLDOWN("u", "OTP_VERIFY")).toBe("mfa:cooldown:u:OTP_VERIFY")
    expect(REDIS_KEYS.MFA_OTP("u", "123456")).toBe("mfa:otp:u:123456")
    expect(REDIS_KEYS.MFA_OTP_LATEST("u", "LOGIN")).toBe("mfa:otp:latest:u:LOGIN")
    expect(REDIS_KEYS.MFA_ATTEMPTS("u", "LOGIN")).toBe("mfa:attempts:u:LOGIN")
    expect(REDIS_KEYS.MFA_DAILY_COUNT("u", "2026-10-06")).toBe("mfa:daily:u:2026-10-06")
  })

  it("refuses to build a key with a missing part", () => {
    expect(() => REDIS_KEYS.MFA_COOLDOWN("", "x")).toThrow()
    expect(() => REDIS_KEYS.MFA_OTP("u", "")).toThrow()
    expect(() => REDIS_KEYS.MFA_OTP_LATEST("", "LOGIN")).toThrow()
    expect(() => REDIS_KEYS.MFA_ATTEMPTS("u", "")).toThrow()
    expect(() => REDIS_KEYS.MFA_DAILY_COUNT("u", "")).toThrow()
  })
})

describe("cooldowns", () => {
  it("stores a cooldown that ends with its TTL", async () => {
    await RedisMFA.setCooldown("u1", "OTP_VERIFY", 60, 5)

    expect(await RedisMFA.getCooldown("u1", "OTP_VERIFY")).toEqual({
      userId: "u1",
      type: "OTP_VERIFY",
      attempts: 5,
      cooldownUntil: "2026-10-06T08:01:00.000Z",
      timestamp: NOW.getTime() + 60_000,
    })

    vi.advanceTimersByTime(60_000)
    expect(await RedisMFA.getCooldown("u1", "OTP_VERIFY")).toBeNull()
  })

  it.each([
    ["", "T", 60, 1],
    ["u", "", 60, 1],
    ["u", "T", 0, 1],
    ["u", "T", 86_401, 1],
    ["u", "T", 60, 0],
  ])("rejects setCooldown(%j, %j, %j, %j)", async (userId, type, ttl, attempts) => {
    await expect(RedisMFA.setCooldown(userId, type, ttl, attempts)).rejects.toThrow()
  })

  it("reads a cooldown stored as an object and ignores garbage", async () => {
    await redis.setex(REDIS_KEYS.MFA_COOLDOWN("u1", "A"), 60, { userId: "u1", attempts: 2 })
    expect(await RedisMFA.getCooldown("u1", "A")).toEqual({ userId: "u1", attempts: 2 })

    await redis.setex(REDIS_KEYS.MFA_COOLDOWN("u1", "B"), 60, "{not json")
    expect(await RedisMFA.getCooldown("u1", "B")).toBeNull()

    await redis.setex(REDIS_KEYS.MFA_COOLDOWN("u1", "C"), 60, 7)
    expect(await RedisMFA.getCooldown("u1", "C")).toBeNull()

    expect(await RedisMFA.getCooldown("", "A")).toBeNull()
    expect(await RedisMFA.getCooldown("u1", "")).toBeNull()
  })

  it("deletes a cooldown", async () => {
    await RedisMFA.setCooldown("u1", "OTP_REQUEST", 60)
    await RedisMFA.deleteCooldown("u1", "OTP_REQUEST")
    expect(await RedisMFA.getCooldown("u1", "OTP_REQUEST")).toBeNull()
  })
})

describe("OTP records", () => {
  it("stores the code and a pointer to the latest code for its type, both expiring together", async () => {
    await RedisMFA.setOTP("u1", "123456", 120, "LOGIN")

    expect(await RedisMFA.getOTP("u1", "123456")).toMatchObject({
      userId: "u1",
      code: "123456",
      type: "LOGIN",
      attempts: 0,
      isUsed: false,
    })
    expect(await RedisMFA.getLatestOTPCode("u1", "LOGIN")).toBe("123456")
    expect(await RedisMFA.getLatestOTPCode("u1", "VERIFY_EMAIL")).toBeNull()

    vi.advanceTimersByTime(120_000)
    expect(await RedisMFA.getOTP("u1", "123456")).toBeNull()
    expect(await RedisMFA.getLatestOTPCode("u1", "LOGIN")).toBeNull()
  })

  it("moves the latest pointer to the newest code", async () => {
    await RedisMFA.setOTP("u1", "111111", 120, "LOGIN")
    await RedisMFA.setOTP("u1", "222222", 120, "LOGIN")
    expect(await RedisMFA.getLatestOTPCode("u1", "LOGIN")).toBe("222222")
  })

  it("reads a numeric latest pointer as a string", async () => {
    await redis.setex(REDIS_KEYS.MFA_OTP_LATEST("u1", "LOGIN"), 60, 654321)
    expect(await RedisMFA.getLatestOTPCode("u1", "LOGIN")).toBe("654321")
    await redis.setex(REDIS_KEYS.MFA_OTP_LATEST("u1", "LOGIN"), 60, { code: 1 })
    expect(await RedisMFA.getLatestOTPCode("u1", "LOGIN")).toBeNull()
  })

  it("records attempts and use on the stored code", async () => {
    await RedisMFA.setOTP("u1", "123456", 600, "VERIFY_EMAIL")
    await RedisMFA.updateOTPAttempts("u1", "123456", 3)
    expect((await RedisMFA.getOTP("u1", "123456"))?.attempts).toBe(3)

    await RedisMFA.markOTPUsed("u1", "123456")
    expect((await RedisMFA.getOTP("u1", "123456"))?.isUsed).toBe(true)
  })

  it("updates a code stored as an object too", async () => {
    await redis.setex(REDIS_KEYS.MFA_OTP("u1", "123456"), 60, { code: "123456", attempts: 0, isUsed: false })
    await RedisMFA.updateOTPAttempts("u1", "123456", 1)
    await RedisMFA.markOTPUsed("u1", "123456")
    expect(await RedisMFA.getOTP("u1", "123456")).toMatchObject({ attempts: 1, isUsed: true })
  })

  it("leaves a missing or corrupt record alone", async () => {
    await RedisMFA.updateOTPAttempts("u1", "000000", 1)
    await RedisMFA.markOTPUsed("u1", "000000")
    expect(await RedisMFA.getOTP("u1", "000000")).toBeNull()

    await redis.setex(REDIS_KEYS.MFA_OTP("u1", "999999"), 60, "{corrupt")
    await RedisMFA.updateOTPAttempts("u1", "999999", 1)
    await RedisMFA.markOTPUsed("u1", "999999")
    expect(await RedisMFA.getOTP("u1", "999999")).toBeNull()
    expect(await redis.get(REDIS_KEYS.MFA_OTP("u1", "999999"))).toBe("{corrupt")
  })

  it("deletes the code and the latest pointer", async () => {
    await RedisMFA.setOTP("u1", "123456", 120, "LOGIN")
    await RedisMFA.deleteLatestOTP("u1", "LOGIN")
    await RedisMFA.deleteOTP("u1", "123456")
    expect(await RedisMFA.getLatestOTPCode("u1", "LOGIN")).toBeNull()
    expect(await RedisMFA.getOTP("u1", "123456")).toBeNull()
  })
})

describe("daily request count", () => {
  it("counts requests for the day and can be cleared", async () => {
    expect(await RedisMFA.getDailyCount("u1")).toBe(0)
    expect(await RedisMFA.incrementDailyCount("u1")).toBe(1)
    expect(await RedisMFA.incrementDailyCount("u1")).toBe(2)
    expect(await RedisMFA.getDailyCount("u1")).toBe(2)

    await RedisMFA.deleteDailyCount("u1")
    expect(await RedisMFA.getDailyCount("u1")).toBe(0)
  })

  it("keeps separate counts per user", async () => {
    await RedisMFA.incrementDailyCount("u1")
    expect(await RedisMFA.getDailyCount("u2")).toBe(0)
  })

  it("reads a string count and ignores a non-numeric one", async () => {
    await redis.setex(REDIS_KEYS.MFA_DAILY_COUNT("u1", "2026-10-06"), 60, "7")
    expect(await RedisMFA.getDailyCount("u1")).toBe(7)
    await redis.setex(REDIS_KEYS.MFA_DAILY_COUNT("u1", "2026-10-06"), 60, "x")
    expect(await RedisMFA.getDailyCount("u1")).toBe(0)
  })

  it("refuses to clear a count without a user", async () => {
    await expect(RedisMFA.deleteDailyCount("")).rejects.toThrow("Invalid userId for deleteDailyCount")
  })
})

describe("isRedisAvailable", () => {
  it("is true when Redis answers", async () => {
    expect(await isRedisAvailable()).toBe(true)
  })

  it("is false when Redis refuses, whether for credentials or anything else", async () => {
    const ping = vi.spyOn(redis, "ping")
    ping.mockRejectedValueOnce(new Error("WRONGPASS"))
    expect(await isRedisAvailable()).toBe(false)
    ping.mockRejectedValueOnce(new Error("ECONNRESET"))
    expect(await isRedisAvailable()).toBe(false)
  })
})
