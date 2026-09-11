import { describe, expect, it } from "vitest"

import { LocalMemoryRedis } from "@/lib/local-memory-redis"

describe("LocalMemoryRedis", () => {
  it("supports expiring values", async () => {
    let now = 1_000
    const redis = new LocalMemoryRedis(() => now)

    await redis.setex("session", 5, JSON.stringify({ valid: true }))
    expect(await redis.get("session")).toBe('{"valid":true}')
    expect(await redis.ttl("session")).toBe(5)

    now += 5_000
    expect(await redis.get("session")).toBeNull()
    expect(await redis.ttl("session")).toBe(-2)
  })

  it("runs the rate-limiter pipeline in order", async () => {
    const redis = new LocalMemoryRedis()
    const pipeline = redis.pipeline()

    pipeline.incr("rate:user").ttl("rate:user")
    await expect(pipeline.exec<[number, number]>()).resolves.toEqual([1, -1])

    expect(await redis.expire("rate:user", 60)).toBe(1)
    expect(await redis.incr("rate:user")).toBe(2)
    expect(await redis.ttl("rate:user")).toBeGreaterThan(0)
  })

  it("finds and deletes cache keys by prefix", async () => {
    const redis = new LocalMemoryRedis()
    await redis.setex("cache:orders:1", 60, "one")
    await redis.setex("cache:orders:2", 60, "two")
    await redis.setex("cache:users:1", 60, "user")

    const keys = await redis.keys("cache:orders:*")
    expect(keys.sort()).toEqual(["cache:orders:1", "cache:orders:2"])
    expect(await redis.del(...keys)).toBe(2)
    expect(await redis.keys("cache:orders:*")).toEqual([])
  })
})
