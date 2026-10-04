/**
 * A random identifier for browser-side keys: sign-out attempt ids, list entry
 * keys, and the idempotency key the server deduplicates an order on.
 *
 * `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost), so
 * on any other origin this falls back to `crypto.getRandomValues`, which is
 * available everywhere. Neither path uses `Math.random`: an idempotency key
 * must not be predictable or collide with another tab's.
 *
 * Returns a UUID, or 32 lowercase hex characters on the fallback path. Both
 * satisfy the server's `^[A-Za-z0-9._:-]{8,128}$` idempotency-key pattern.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
