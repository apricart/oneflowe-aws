/**
 * Return the same response without cookie mutations. Used for passive session
 * reads so they can validate state without racing explicit activity renewal.
 */
export function withoutSetCookieHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.delete("set-cookie")

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export const SESSION_VALIDATION_UNAVAILABLE_FIELD =
  "sessionValidationUnavailable"

export function sessionValidationUnavailablePayload(): Record<string, true> {
  return { [SESSION_VALIDATION_UNAVAILABLE_FIELD]: true }
}

export function isSessionValidationUnavailablePayload(
  value: unknown,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[
      SESSION_VALIDATION_UNAVAILABLE_FIELD
    ] === true
  )
}

/**
 * A rejected session makes the `session` callback return `null`, which NextAuth
 * serialises as a JSON `null` body. The NextAuth v4 client runs
 * `Object.keys(data)` on that body and logs CLIENT_FETCH_ERROR on every poll,
 * so it is rewritten to `{}`, NextAuth's own "no session" body.
 */
function withEmptySessionBody(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.set("content-type", "application/json; charset=utf-8")

  return new Response("{}", {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Passive reads never write cookies. A transient server-side validation-store
 * failure is surfaced as 503 for both reads and activity updates, and its
 * response can never overwrite or clear the caller's still-signed cookie.
 */
export async function hardenSessionEndpointResponse(
  response: Response,
  options: { allowCookieWrite: boolean },
): Promise<Response> {
  let validationUnavailable = false
  let emptySession = false
  try {
    const payload = await response.clone().json()
    validationUnavailable = isSessionValidationUnavailablePayload(payload)
    emptySession = payload === null
  } catch {
    // Non-JSON responses are handled by the caller/NextAuth unchanged.
  }

  if (emptySession) {
    response = withEmptySessionBody(response)
  }

  if (validationUnavailable) {
    const headers = new Headers(response.headers)
    headers.delete("set-cookie")
    headers.delete("content-length")
    headers.set("cache-control", "private, no-store, max-age=0")
    headers.set("content-type", "application/json; charset=utf-8")

    return new Response(
      JSON.stringify({ error: "Session validation temporarily unavailable" }),
      { status: 503, headers },
    )
  }

  return options.allowCookieWrite
    ? response
    : withoutSetCookieHeaders(response)
}
