const SAFE_IMAGE_DATA_URL =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i

export const MAX_STORED_IMAGE_URL_LENGTH = 6_000_000

/**
 * Product images are rendered in many browser locations. Keep their source
 * limited to same-origin paths, HTTPS URLs, or validated raster data URLs.
 * SVG and other active-content formats are deliberately excluded.
 */
export function normalizeSafeImageUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > MAX_STORED_IMAGE_URL_LENGTH) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null

  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//") || trimmed.includes("\\")) return null
    return trimmed
  }

  if (trimmed.startsWith("data:")) {
    return SAFE_IMAGE_DATA_URL.test(trimmed) ? trimmed : null
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== "https:") return null
    if (parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * Return a same-origin application path suitable for client-side navigation.
 * Protocol-relative, absolute, backslash and script-scheme values fall back.
 */
export function safeInternalRedirectPath(
  value: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (!value || value === "undefined" || value === "null") return fallback

  const trimmed = value.trim()
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return fallback
  }

  try {
    const base = new URL("https://oneflowe.invalid")
    const parsed = new URL(trimmed, base)
    if (parsed.origin !== base.origin) return fallback
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}

export function safeFilenamePart(value: unknown, fallback = "file"): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 100)
  return normalized || fallback
}
