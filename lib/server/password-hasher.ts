import "server-only"

/**
 * Bcrypt execution backend for every stored user credential.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bcryptjs` is a pure-JavaScript bcrypt. Its "async" API is not asynchronous
 * in any useful sense: it slices the key-expansion rounds and reschedules them
 * onto the SAME event loop with setImmediate (bcryptjs/index.js: `nextTick`).
 * Concurrent hashes therefore interleave on the one thread that also serves
 * every other request, so under load nothing finishes early -- they all finish
 * late, together -- and unrelated cached endpoints (/api/auth/csrf,
 * /api/auth/session) are starved behind the hash work.
 *
 * Measured, 50 concurrent verifications at cost 12:
 *   bcryptjs        first response 8214ms, worst event-loop stall 5041ms
 *   @node-rs/bcrypt first response  220ms, worst event-loop stall   12ms
 *
 * The native backend runs on the libuv threadpool, so the queue drains in
 * order and the event loop stays free.
 *
 * CREDENTIAL COMPATIBILITY -- THE NON-NEGOTIABLE PART
 * --------------------------------------------------
 * This module changes only WHERE bcrypt runs, never WHAT bcrypt computes.
 * Bcrypt is a fully specified algorithm: a given (password, salt, cost) has
 * exactly one correct digest regardless of implementation. Every stored
 * `$2a$` / `$2b$` / `$2y$` hash keeps verifying, no re-hash and no migration.
 *
 * That claim is not taken on trust. It is enforced three ways:
 *   1. KNOWN_ANSWER_VECTORS below are literal digests produced by bcryptjs.
 *      The native backend must reproduce every accept AND every reject before
 *      it is used even once. A single disagreement permanently disables it.
 *   2. The self-test runs before the first verification, in-process, on the
 *      real deployed binary -- so a wrong or corrupt native build is caught on
 *      that host rather than by a locked-out user.
 *   3. If the native module is missing (musl build, arch mismatch) or fails
 *      the self-test, this module falls back to bcryptjs. The worst possible
 *      outcome of this change is exactly today's behaviour, never a failed
 *      login.
 *
 * PASSWORD_HASHER=bcryptjs forces the legacy backend without a redeploy.
 */

import * as bcryptjs from "bcryptjs"

type BcryptBackend = {
  name: "native" | "bcryptjs"
  hash: (plain: string, rounds: number) => Promise<string>
  compare: (plain: string, hash: string) => Promise<boolean>
}

/**
 * Literal bcryptjs output. Each entry pins one property of the algorithm that
 * implementations have historically disagreed on, so a backend that passes all
 * of them cannot silently reinterpret a stored credential.
 *
 * Regenerate ONLY with bcryptjs, never with the backend under test.
 */
const KNOWN_ANSWER_VECTORS: ReadonlyArray<{
  readonly note: string
  readonly password: string
  /**
   * A password that must NOT verify against `hash`. Always differs from
   * `password` in its FIRST byte, never by an appended suffix: bcrypt truncates
   * its input at 72 bytes, so for a long password a suffix change is invisible
   * to the algorithm and both backends would correctly still return true. A
   * self-test built on suffix mutation would therefore read that correct
   * behaviour as an authentication bypass and disable a healthy backend.
   */
  readonly wrongPassword: string
  readonly hash: string
}> = [
  {
    note: "cost 10 -- the factor used for employee credentials",
    password: "Password123!",
    wrongPassword: `Z${("Password123!").slice(1)}`,
    hash: "$2b$10$tja8OF8fR4VOnkDJrMwkjuqKf4LULRvK9FsCe/BbfA4/2zdbpSeCi",
  },
  {
    note: "cost 12 -- the BCRYPT_ROUNDS default for staff credentials",
    password: "Password123!",
    wrongPassword: `Z${("Password123!").slice(1)}`,
    hash: "$2b$12$uFGfdFQlJAHZRBhgWtnB9u.jpYIyUcwpukKjWennlpZX3B6J5pyc.",
  },
  {
    note: "$2a$ prefix must be read identically to $2b$",
    password: "Password123!",
    wrongPassword: `Z${("Password123!").slice(1)}`,
    hash: "$2a$12$uFGfdFQlJAHZRBhgWtnB9u.jpYIyUcwpukKjWennlpZX3B6J5pyc.",
  },
  {
    note: "$2y$ prefix (PHP-written hashes) must also be accepted",
    password: "Password123!",
    wrongPassword: `Z${("Password123!").slice(1)}`,
    hash: "$2y$12$uFGfdFQlJAHZRBhgWtnB9u.jpYIyUcwpukKjWennlpZX3B6J5pyc.",
  },
  {
    note: "multi-byte UTF-8 must be encoded the same way before hashing",
    password: "Ünïcödé-Pá$$w0rd",
    wrongPassword: `Z${("Ünïcödé-Pá$$w0rd").slice(1)}`,
    hash: "$2b$12$ekpX4bmekhqvtwwUuWy4L.uVImQLaPAtrx99Ii//6B5MH8WTV2dGe",
  },
  {
    note: "over-72-byte input must truncate identically",
    password: `${"x".repeat(80)}A1!`,
    wrongPassword: `Z${(`${"x".repeat(80)}A1!`).slice(1)}`,
    hash: "$2b$12$GPleZ5bhlbKrl/yideFMCu6.mCuP//GvPxtGrR8H9V.MbRf3AT1Sm",
  },
]

/**
 * Both backends agree on every digest bcrypt can actually produce. They differ
 * only for a stored cost factor outside bcrypt's legal 4-31 range, where
 * bcryptjs throws and the native binding returns false. No bcrypt
 * implementation can emit such a string, so it means corrupt data rather than
 * a real credential -- and either way that login is refused.
 *
 * Both are wrapped so the adapter's contract is "a bad digest is a failed
 * verification, never an exception", identically on either backend. That is
 * already what verifyPassword() did for staff logins; it also stops a corrupt
 * row from turning the employee login path into an unhandled 500.
 */
function refuseOnError(
  compare: (plain: string, hash: string) => Promise<boolean>,
): (plain: string, hash: string) => Promise<boolean> {
  return async (plain, hash) => {
    try {
      return await compare(plain, hash)
    } catch {
      return false
    }
  }
}

const bcryptjsBackend: BcryptBackend = {
  name: "bcryptjs",
  hash: (plain, rounds) => bcryptjs.hash(plain, rounds),
  compare: refuseOnError((plain, hash) => bcryptjs.compare(plain, hash)),
}

/**
 * Dynamic import rather than require(): this module is consumed from both the
 * ESM test runner and Next's server build, and a bare require() is not defined
 * in the former -- it would silently select the fallback and make the
 * compatibility self-test assert nothing.
 *
 * Guarded so a missing platform binary (musl, unusual arch) degrades to the JS
 * backend instead of taking the server down at import time.
 */
async function loadNativeBackend(): Promise<BcryptBackend | null> {
  try {
    const imported = (await import("@node-rs/bcrypt")) as unknown as Record<string, unknown>
    const mod = (imported.default ?? imported) as {
      hash?: (plain: string, rounds: number) => Promise<string>
      verify?: (plain: string, hash: string) => Promise<boolean>
    }

    if (typeof mod.hash !== "function" || typeof mod.verify !== "function") {
      console.warn("[PasswordHasher] Native bcrypt loaded but exports are unusable.", {
        exports: Object.keys(mod).slice(0, 12),
      })
      return null
    }

    const nativeHash = mod.hash
    const nativeVerify = mod.verify

    return {
      name: "native",
      hash: (plain, rounds) => nativeHash(plain, rounds),
      compare: refuseOnError((plain, hash) => nativeVerify(plain, hash)),
    }
  } catch (error) {
    // Logged rather than swallowed: a silent fallback would hide the reason
    // this host lost its threadpool hashing until the next load test.
    console.warn("[PasswordHasher] Native bcrypt could not be loaded.", {
      reason: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * A candidate backend must agree with bcryptjs on every vector -- accepting
 * what bcryptjs accepts AND rejecting what bcryptjs rejects. The reject half
 * matters most: a backend that accepted a wrong password would be an
 * authentication bypass, so it is checked explicitly rather than assumed.
 */
async function passesCompatibilitySelfTest(backend: BcryptBackend): Promise<boolean> {
  for (const vector of KNOWN_ANSWER_VECTORS) {
    try {
      if ((await backend.compare(vector.password, vector.hash)) !== true) {
        console.error(
          "[PasswordHasher] Backend rejected a known-good credential; refusing to use it.",
          { backend: backend.name, vector: vector.note },
        )
        return false
      }

      if ((await backend.compare(vector.wrongPassword, vector.hash)) !== false) {
        console.error(
          "[PasswordHasher] Backend accepted an incorrect password; refusing to use it.",
          { backend: backend.name, vector: vector.note },
        )
        return false
      }
    } catch (error) {
      console.error("[PasswordHasher] Backend self-test raised an error.", {
        backend: backend.name,
        vector: vector.note,
        type: error instanceof Error ? error.name : typeof error,
      })
      return false
    }
  }

  // A backend that verifies old digests must also produce digests the fallback
  // can still read, so reverting to bcryptjs never strands a new password.
  try {
    const roundTrip = await backend.hash("PasswordHasher-RoundTrip-1!", 10)
    if (!(await bcryptjsBackend.compare("PasswordHasher-RoundTrip-1!", roundTrip))) {
      console.error(
        "[PasswordHasher] Backend produced a digest bcryptjs cannot verify; refusing to use it.",
        { backend: backend.name },
      )
      return false
    }
  } catch (error) {
    console.error("[PasswordHasher] Backend round-trip self-test raised an error.", {
      backend: backend.name,
      type: error instanceof Error ? error.name : typeof error,
    })
    return false
  }

  return true
}

function configuredPreference(): "auto" | "native" | "bcryptjs" {
  const raw = process.env.PASSWORD_HASHER?.trim().toLowerCase()
  return raw === "bcryptjs" || raw === "native" ? raw : "auto"
}

let backendPromise: Promise<BcryptBackend> | null = null

async function selectBackend(): Promise<BcryptBackend> {
  const preference = configuredPreference()

  if (preference === "bcryptjs") {
    console.info("[PasswordHasher] Using bcryptjs backend (forced by PASSWORD_HASHER).")
    return bcryptjsBackend
  }

  const native = await loadNativeBackend()
  if (!native) {
    console.warn(
      "[PasswordHasher] Native bcrypt unavailable; falling back to bcryptjs. " +
        "Logins still succeed, but password hashing runs on the event loop.",
    )
    return bcryptjsBackend
  }

  if (!(await passesCompatibilitySelfTest(native))) {
    console.error("[PasswordHasher] Native bcrypt failed its self-test; using bcryptjs.")
    return bcryptjsBackend
  }

  console.info("[PasswordHasher] Using native bcrypt backend (libuv threadpool).")
  return native
}

/**
 * Memoised so the self-test runs once per process. The promise is cached
 * before it settles, so concurrent first requests share one self-test rather
 * than racing several.
 */
function getBackend(): Promise<BcryptBackend> {
  backendPromise ??= selectBackend().catch((error) => {
    console.error("[PasswordHasher] Backend selection failed; using bcryptjs.", {
      type: error instanceof Error ? error.name : typeof error,
    })
    return bcryptjsBackend
  })
  return backendPromise
}

/** Compute a bcrypt digest at the caller's cost factor. */
export async function bcryptHash(plain: string, rounds: number): Promise<string> {
  const backend = await getBackend()
  return backend.hash(plain, rounds)
}

/**
 * Verify a plaintext against a stored digest.
 *
 * Semantics match `bcryptjs.compare` exactly, including returning false rather
 * than throwing for a malformed stored hash.
 */
export async function bcryptCompare(plain: string, hash: string): Promise<boolean> {
  const backend = await getBackend()
  return backend.compare(plain, hash)
}

/** Which backend this process settled on. For health/diagnostics only. */
export async function activePasswordHasher(): Promise<"native" | "bcryptjs"> {
  return (await getBackend()).name
}

/** Test-only: drop the memoised backend so a test can re-select. */
export function resetPasswordHasherForTests(): void {
  backendPromise = null
}

export const PASSWORD_HASHER_TEST_VECTORS = KNOWN_ANSWER_VECTORS
