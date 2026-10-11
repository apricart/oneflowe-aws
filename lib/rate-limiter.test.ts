import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The limiter talks to Upstash through `redis.pipeline()` / `expire` / `del` /
 * `get` / `ttl`. Redis is replaced by a scriptable fake so every branch —
 * first request, over the limit, a key that lost its TTL, a Redis outage — can
 * be driven deterministically. The env module is mocked so the production /
 * development / E2E exemptions can be switched per test.
 */

const redisState = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  ttls: new Map<string, number>(),
  failWith: null as Error | null,
  pipelineResult: null as unknown[] | null,
}))

vi.mock("@/lib/redis", () => {
  const pipeline = () => {
    const ops: Array<() => unknown> = []
    const api = {
      incr(key: string) {
        ops.push(() => {
          const next = (redisState.counters.get(key) ?? 0) + 1
          redisState.counters.set(key, next)
          return next
        })
        return api
      },
      ttl(key: string) {
        ops.push(() => redisState.ttls.get(key) ?? -1)
        return api
      },
      async exec() {
        if (redisState.failWith) throw redisState.failWith
        if (redisState.pipelineResult) return redisState.pipelineResult
        return ops.map((op) => op())
      },
    }
    return api
  }

  return {
    redis: {
      pipeline,
      expire: vi.fn(async (key: string, seconds: number) => {
        redisState.ttls.set(key, seconds)
        return 1
      }),
      del: vi.fn(async (key: string) => {
        if (redisState.failWith) throw redisState.failWith
        redisState.counters.delete(key)
        return 1
      }),
      get: vi.fn(async (key: string) => {
        if (redisState.failWith) throw redisState.failWith
        return redisState.counters.get(key) ?? null
      }),
      ttl: vi.fn(async (key: string) => redisState.ttls.get(key) ?? -2),
    },
  }
})

const envState = vi.hoisted(() => ({ NODE_ENV: "production", RATE_LIMIT_TRUST_PROXY_HOPS: 1 }))
vi.mock("@/lib/server/env", () => ({ env: envState }))

const headerState = vi.hoisted(() => ({ values: new Map<string, string>(), fail: false }))
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => {
    if (headerState.fail) throw new Error("headers() called outside a request")
    return { get: (name: string) => headerState.values.get(name.toLowerCase()) ?? null }
  }),
}))

import { redis } from "@/lib/redis"
import {
  checkRateLimit,
  getClientIdentifier,
  getRateLimitHeaders,
  getRateLimitStatus,
  rateLimitResponse,
  resetRateLimit,
  withRateLimit,
} from "./rate-limiter"

beforeEach(() => {
  redisState.counters.clear()
  redisState.ttls.clear()
  redisState.failWith = null
  redisState.pipelineResult = null
  envState.NODE_ENV = "production"
  headerState.values.clear()
  headerState.fail = false
  delete process.env.E2E_TESTING
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.mocked(redis.expire).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("checkRateLimit", () => {
  it("allows exactly the configured number of requests in a window, then refuses", async () => {
    // `login` is 15 per 15 minutes.
    const results = []
    for (let i = 0; i < 16; i += 1) results.push(await checkRateLimit("ip:1.2.3.4", "login"))

    expect(results.slice(0, 15).every((result) => result.allowed)).toBe(true)
    expect(results[14].remaining).toBe(0)
    expect(results[15]).toMatchObject({ allowed: false, remaining: 0 })
  })

  it("sets the window expiry on the first request and not again while it holds", async () => {
    await checkRateLimit("user:a", "otpSend")
    expect(redis.expire).toHaveBeenCalledTimes(1)
    expect(redis.expire).toHaveBeenCalledWith("rate_limit:otpSend:user:a", 900)

    await checkRateLimit("user:a", "otpSend")
    expect(redis.expire).toHaveBeenCalledTimes(1)
  })

  it("repairs a key whose expiry was lost so it cannot count forever", async () => {
    redisState.counters.set("rate_limit:api:user:a", 40)
    redisState.ttls.set("rate_limit:api:user:a", -1)

    const result = await checkRateLimit("user:a", "api")

    expect(redis.expire).toHaveBeenCalledWith("rate_limit:api:user:a", 60)
    expect(result).toMatchObject({ allowed: true, remaining: 59, resetIn: 60 })
  })

  it("reports the live TTL as the reset time", async () => {
    redisState.ttls.set("rate_limit:api:user:a", 17)
    expect((await checkRateLimit("user:a", "api")).resetIn).toBe(17)
  })

  it("keeps separate budgets per type and per identifier", async () => {
    for (let i = 0; i < 5; i += 1) await checkRateLimit("user:a", "otpSend")
    expect((await checkRateLimit("user:a", "otpSend")).allowed).toBe(false)
    expect((await checkRateLimit("user:b", "otpSend")).allowed).toBe(true)
    expect((await checkRateLimit("user:a", "otpVerify")).allowed).toBe(true)
  })

  it("refuses an empty identifier or an unknown type rather than counting it", async () => {
    expect(await checkRateLimit("", "api")).toEqual({ allowed: false, remaining: 0, resetIn: 60 })
    expect(await checkRateLimit("user:a", "nope" as never)).toEqual({ allowed: false, remaining: 0, resetIn: 60 })
  })

  it("lets the request through when Redis returns a nonsensical counter", async () => {
    redisState.pipelineResult = ["not-a-number", 10]
    expect(await checkRateLimit("user:a", "api")).toEqual({ allowed: true, remaining: 100, resetIn: 60 })
  })

  describe("when Redis is down", () => {
    beforeEach(() => {
      redisState.failWith = new Error("ECONNREFUSED")
    })

    it.each(["login", "sensitive", "otpSend", "otpVerify", "upload", "import", "report", "order", "refund", "email"] as const)(
      "fails closed for the %s limiter",
      async (type) => {
        expect(await checkRateLimit("user:a", type)).toEqual({ allowed: false, remaining: 0, resetIn: 60 })
      },
    )

    it.each(["api", "search", "write"] as const)("fails open for the %s limiter", async (type) => {
      expect(await checkRateLimit("user:a", type)).toEqual({ allowed: true, remaining: 0, resetIn: 0 })
    })

    it("still fails closed on a Redis authentication error", async () => {
      redisState.failWith = new Error("WRONGPASS invalid password")
      expect((await checkRateLimit("user:a", "login")).allowed).toBe(false)
    })
  })

  describe("exemptions", () => {
    it("skips only the login limiter on the development server", async () => {
      envState.NODE_ENV = "development"
      for (let i = 0; i < 30; i += 1) {
        expect((await checkRateLimit("user:a", "login")).allowed).toBe(true)
      }
      for (let i = 0; i < 5; i += 1) await checkRateLimit("user:a", "otpSend")
      expect((await checkRateLimit("user:a", "otpSend")).allowed).toBe(false)
    })

    it("enforces the login limiter under test and production", async () => {
      for (const nodeEnv of ["test", "production"]) {
        redisState.counters.clear()
        envState.NODE_ENV = nodeEnv
        for (let i = 0; i < 15; i += 1) await checkRateLimit("user:a", "login")
        expect((await checkRateLimit("user:a", "login")).allowed, nodeEnv).toBe(false)
      }
    })

    it("skips every limiter for E2E runs outside production", async () => {
      envState.NODE_ENV = "test"
      process.env.E2E_TESTING = "1"
      redisState.failWith = new Error("should not be called")
      expect(await checkRateLimit("user:a", "otpSend")).toEqual({ allowed: true, remaining: 5, resetIn: 900 })
    })

    it("ignores the E2E switch in production", async () => {
      process.env.E2E_TESTING = "1"
      redisState.failWith = new Error("down")
      expect((await checkRateLimit("user:a", "login")).allowed).toBe(false)
    })
  })
})

describe("getClientIdentifier", () => {
  it("prefers a user id, trimmed", async () => {
    expect(await getClientIdentifier("  abc  ")).toBe("user:abc")
  })

  it("falls back to the client address for a blank user id", async () => {
    headerState.values.set("x-forwarded-for", "203.0.113.9")
    expect(await getClientIdentifier("   ")).toBe("ip:203.0.113.9")
  })

  it("uses the trusted proxy address when there is no user", async () => {
    headerState.values.set("x-forwarded-for", "198.51.100.1")
    expect(await getClientIdentifier()).toBe("ip:198.51.100.1")
  })

  it("buckets every caller together when the headers cannot be read", async () => {
    headerState.fail = true
    expect(await getClientIdentifier()).toBe("ip:unknown")
  })
})

describe("withRateLimit", () => {
  it("returns nothing while within budget", async () => {
    expect(await withRateLimit("api", "u1")).toBeNull()
  })

  it("returns a 429 with Retry-After once the budget is spent", async () => {
    for (let i = 0; i < 5; i += 1) await withRateLimit("otpSend", "u1")
    redisState.ttls.set("rate_limit:otpSend:user:u1", 120)

    const response = await withRateLimit("otpSend", "u1")

    expect(response?.status).toBe(429)
    expect(response?.headers.get("Retry-After")).toBe("120")
    expect(await response?.json()).toMatchObject({ retryAfter: 120 })
  })

  it("refuses a sensitive request outright when Redis is down", async () => {
    redisState.failWith = new Error("down")
    expect((await withRateLimit("refund", "u1"))?.status).toBe(429)
  })
})

describe("rateLimitResponse and headers", () => {
  it("defaults a missing or non-positive reset to 60 seconds", () => {
    expect(rateLimitResponse(0).headers.get("Retry-After")).toBe("60")
    expect(rateLimitResponse(-5).headers.get("Retry-After")).toBe("60")
    expect(rateLimitResponse(Number.NaN).headers.get("Retry-After")).toBe("60")
  })

  it("normalises the informational headers", () => {
    expect(getRateLimitHeaders(-1, -1)).toEqual({
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "0",
      "X-RateLimit-Limit": "100",
    })
    expect(getRateLimitHeaders(7, 30)["X-RateLimit-Remaining"]).toBe("7")
  })
})

describe("resetRateLimit and getRateLimitStatus", () => {
  it("clears a spent budget so the caller may continue", async () => {
    for (let i = 0; i < 6; i += 1) await checkRateLimit("user:a", "otpSend")
    expect(await resetRateLimit("user:a", "otpSend")).toBe(true)
    expect((await checkRateLimit("user:a", "otpSend")).allowed).toBe(true)
  })

  it("reports failure rather than throwing", async () => {
    expect(await resetRateLimit("", "api")).toBe(false)
    redisState.failWith = new Error("down")
    expect(await resetRateLimit("user:a", "api")).toBe(false)
  })

  it("reads the current count and window", async () => {
    await checkRateLimit("user:a", "report")
    await checkRateLimit("user:a", "report")
    expect(await getRateLimitStatus("user:a", "report")).toEqual({ current: 2, limit: 10, resetIn: 600 })
    expect(await getRateLimitStatus("user:none", "report")).toEqual({ current: 0, limit: 10, resetIn: 600 })
  })

  it("returns null for bad input or a Redis failure", async () => {
    expect(await getRateLimitStatus("", "api")).toBeNull()
    redisState.failWith = new Error("down")
    expect(await getRateLimitStatus("user:a", "api")).toBeNull()
  })
})
