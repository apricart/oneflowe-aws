import { afterEach, describe, expect, it, vi } from "vitest"
import { randomId } from "@/lib/random-id"

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

describe("randomId", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("uses crypto.randomUUID in a secure context", () => {
    const id = randomId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(id).toMatch(IDEMPOTENCY_KEY_PATTERN)
  })

  it("falls back to crypto.getRandomValues, never Math.random, without randomUUID", () => {
    const mathRandom = vi.spyOn(Math, "random")
    const realCrypto = globalThis.crypto
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => realCrypto.getRandomValues(array),
    })

    const id = randomId()

    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(id).toMatch(IDEMPOTENCY_KEY_PATTERN)
    expect(mathRandom).not.toHaveBeenCalled()
  })

  it("does not repeat across calls on the fallback path", () => {
    const realCrypto = globalThis.crypto
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => realCrypto.getRandomValues(array),
    })

    const ids = new Set(Array.from({ length: 1000 }, () => randomId()))

    expect(ids.size).toBe(1000)
  })
})
