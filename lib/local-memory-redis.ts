type StoredValue = {
  value: unknown
  expiresAt: number | null
}

type PipelineCommand = () => Promise<unknown>

export interface RedisPipelineLike {
  incr(key: string): RedisPipelineLike
  ttl(key: string): RedisPipelineLike
  exec<T extends unknown[]>(): Promise<T>
}

export interface RedisLike {
  ping(): Promise<string>
  get<T = unknown>(key: string): Promise<T | null>
  setex(key: string, ttlSeconds: number, value: unknown): Promise<"OK">
  del(...keys: string[]): Promise<number>
  keys(pattern: string): Promise<string[]>
  incr(key: string): Promise<number>
  expire(key: string, ttlSeconds: number): Promise<number>
  ttl(key: string): Promise<number>
  pipeline(): RedisPipelineLike
}

/**
 * Small Redis-compatible store for one-process local development.
 *
 * The application only needs this subset of Redis. Keeping it in memory makes
 * offline development independent of Upstash and avoids network timeout pauses.
 * Production can never select this adapter because environment validation
 * rejects offline mode outside NODE_ENV=development.
 */
export class LocalMemoryRedis implements RedisLike {
  private readonly values = new Map<string, StoredValue>()

  constructor(private readonly now: () => number = Date.now) {}

  private current(key: string): StoredValue | null {
    const entry = this.values.get(key)
    if (!entry) return null

    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.values.delete(key)
      return null
    }

    return entry
  }

  async ping(): Promise<string> {
    return "PONG"
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.current(key)?.value as T | undefined) ?? null
  }

  async setex(key: string, ttlSeconds: number, value: unknown): Promise<"OK"> {
    this.values.set(key, {
      value,
      expiresAt: this.now() + ttlSeconds * 1000,
    })
    return "OK"
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0
    for (const key of keys) {
      if (this.values.delete(key)) removed += 1
    }
    return removed
  }

  async keys(pattern: string): Promise<string[]> {
    const source = [...pattern]
      .map((character) => {
        if (character === "*") return ".*"
        if (character === "?") return "."
        return character.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
      })
      .join("")
    const matcher = new RegExp(`^${source}$`)

    return [...this.values.keys()].filter((key) => {
      this.current(key)
      return this.values.has(key) && matcher.test(key)
    })
  }

  async incr(key: string): Promise<number> {
    const entry = this.current(key)
    const previous = entry?.value === undefined ? 0 : Number(entry.value)
    if (!Number.isFinite(previous)) {
      throw new TypeError("Value is not an integer")
    }

    const next = previous + 1
    this.values.set(key, {
      value: next,
      expiresAt: entry?.expiresAt ?? null,
    })
    return next
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.current(key)
    if (!entry) return 0

    entry.expiresAt = this.now() + ttlSeconds * 1000
    return 1
  }

  async ttl(key: string): Promise<number> {
    const entry = this.current(key)
    if (!entry) return -2
    if (entry.expiresAt === null) return -1
    return Math.max(0, Math.ceil((entry.expiresAt - this.now()) / 1000))
  }

  pipeline(): RedisPipelineLike {
    const commands: PipelineCommand[] = []

    const pipeline: RedisPipelineLike = {
      incr: (key) => {
        commands.push(() => this.incr(key))
        return pipeline
      },
      ttl: (key) => {
        commands.push(() => this.ttl(key))
        return pipeline
      },
      exec: async <T extends unknown[]>() => {
        const results: unknown[] = []
        for (const command of commands) results.push(await command())
        return results as T
      },
    }

    return pipeline
  }
}

const globalRedis = globalThis as typeof globalThis & {
  __onefloweLocalMemoryRedis?: RedisLike
}

export function getLocalMemoryRedis(): RedisLike {
  globalRedis.__onefloweLocalMemoryRedis ??= new LocalMemoryRedis()
  return globalRedis.__onefloweLocalMemoryRedis
}
