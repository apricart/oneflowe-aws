/**
 * Cache invalidation for standalone `tsx` utilities.
 *
 * `lib/cache-utils.ts` reaches Redis through `lib/redis.ts`, which reads
 * `lib/server/env.ts`, which begins with `import "server-only"`. Next.js
 * resolves that to a stub on the server and Vitest aliases it away, but plain
 * `tsx` does neither — so a maintenance script importing `cache-utils` dies
 * with "This module cannot be imported from a Client Component module", and it
 * dies *after* its transaction has committed, which reads like a failed run
 * when the write in fact succeeded.
 *
 * This is the same accommodation `lib/db-cli.ts` makes for the database: a
 * direct client for command-line tools, built from the environment rather than
 * from the validated server config.
 *
 * Key shape is kept identical to `invalidateByPrefix` in `lib/cache-utils.ts`
 * (`cache:<prefix>*`) — if that ever changes, this must change with it.
 */

import { Redis } from "@upstash/redis"

export interface CacheInvalidationResult {
  prefix: string
  keysDeleted: number
  error?: string
}

function client(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return new Redis({ url, token })
}

/**
 * Drop every cache entry under one prefix.
 *
 * Never throws: a cache that could not be cleared is a staleness problem the
 * caller should report, not a reason to fail a completed maintenance run. The
 * error is returned so the caller can say so out loud.
 */
export async function invalidateCachePrefix(prefix: string): Promise<CacheInvalidationResult> {
  const redis = client()
  if (!redis) {
    return { prefix, keysDeleted: 0, error: "UPSTASH_REDIS_REST_URL/TOKEN not set" }
  }
  try {
    const keys = await redis.keys(`cache:${prefix}*`)
    if (keys.length > 0) await redis.del(...keys)
    await redis.del(`cache:${prefix}`)
    return { prefix, keysDeleted: keys.length }
  } catch (error) {
    return {
      prefix,
      keysDeleted: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function invalidateCachePrefixes(
  prefixes: readonly string[],
): Promise<CacheInvalidationResult[]> {
  const results: CacheInvalidationResult[] = []
  for (const prefix of prefixes) results.push(await invalidateCachePrefix(prefix))
  return results
}

export interface KeyDeletionResult {
  keysRequested: number
  keysDeleted: number
  error?: string
}

/**
 * Drop exact keys that live outside the `cache:` namespace — the session
 * validation entries (`session-ok:<user id>`, see
 * `lib/session-validation-cache.ts`) that would otherwise let a session the
 * database has just invalidated survive for one TTL window. Never throws, for
 * the same reason as above.
 */
export async function deleteCacheKeys(keys: readonly string[]): Promise<KeyDeletionResult> {
  if (keys.length === 0) return { keysRequested: 0, keysDeleted: 0 }
  const redis = client()
  if (!redis) {
    return { keysRequested: keys.length, keysDeleted: 0, error: "UPSTASH_REDIS_REST_URL/TOKEN not set" }
  }
  try {
    let keysDeleted = 0
    for (let index = 0; index < keys.length; index += 100) {
      keysDeleted += await redis.del(...keys.slice(index, index + 100))
    }
    return { keysRequested: keys.length, keysDeleted }
  } catch (error) {
    return {
      keysRequested: keys.length,
      keysDeleted: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
