const COMMON_HEADERS = { "Content-Type": "application/json" }

// Configuration with validation
const DEFAULT_TIMEOUT_MS = 30000
const MAX_TIMEOUT_MS = 60000
const MIN_TIMEOUT_MS = 1000

type FetcherError = Error & {
  code?: string
  status?: number
  statusText?: string
  timeout?: number
  url?: string
}

function formatFetcherFailure(url: string, error: FetcherError): string {
  const status = error.status ?? 'N/A'
  const code = error.code ?? 'N/A'
  const message = error.message || 'Unknown error'

  return `[Fetcher] Request failed: ${url} | status=${status} | code=${code} | ${message}`
}

/**
 * Validate URL format - accepts both absolute URLs and relative paths
 */
function isValidUrl(url: string): boolean {
  try {
    if (!url || typeof url !== 'string') {
      console.warn('[Fetcher] isValidUrl: URL is missing or not a string', { url })
      return false
    }
    // Reject explicit stringified null/undefined
    if (url === 'undefined' || url === 'null') {
      console.warn('[Fetcher] isValidUrl: URL is stringified null or undefined', { url })
      return false
    }

    // Accept relative URLs (starting with /)
    if (url.startsWith('/')) return true

    // Validate absolute URLs
    new URL(url)
    return true
  } catch (err) {
    console.warn('[Fetcher] isValidUrl: Failed to construct URL', { url, error: err })
    return false
  }
}

/**
 * JSON fetcher with comprehensive error handling
 */
export async function jsonFetcher<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    // Validate URL
    if (!isValidUrl(url)) {
      throw new Error(`Invalid URL: ${url}`)
    }

    console.debug(`[Fetcher] ${init?.method || 'GET'} ${url}`)
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
      ...init,
    })

    if (!res.ok) {
      let message = `Request failed with status ${res.status}`

      try {
        const data = await res.json()
        message = data?.error || data?.message || message
      } catch (parseError) {
        // Failed to parse error response, use status text
        console.warn('[Fetcher] Failed to parse error response:', parseError)
        message = res.statusText || message
      }

      const error: any = new Error(message)
      error.status = res.status
      error.statusText = res.statusText
      throw error
    }

    // Validate response can be parsed as JSON
    try {
      const data = await res.json()
      return data as T
    } catch (parseError) {
      const error = new Error('Invalid JSON response from server', { cause: parseError }) as FetcherError
      error.code = 'INVALID_JSON'
      error.status = res.status
      error.statusText = res.statusText
      error.url = url
      throw error
    }

  } catch (error: any) {
    // Suppress console.error for expected validation errors (4xx) to avoid noisy console logs
    const isValidationError = error?.status >= 400 && error?.status < 500
    const logMethod = isValidationError ? 'debug' : 'warn'

    // Keep handled request failures out of Next.js' development error overlay.
    // The error is still re-thrown below so SWR and callers receive it normally.
    console[logMethod](formatFetcherFailure(url, error))

    // Also log the full error stack for deep debugging
    if (error?.stack) console.debug('[Fetcher] Error stack:', error.stack)
    throw error
  }
}

export const apiFetch = jsonFetcher

function normalizedTimeout(timeoutMs: number): number {
  const validTimeout = Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
  if (validTimeout !== timeoutMs) {
    console.warn(`[Fetcher] Timeout adjusted from ${timeoutMs}ms to ${validTimeout}ms`)
  }
  return validTimeout
}

async function httpErrorFromResponse(res: Response, url: string): Promise<FetcherError> {
  let errorMessage = `HTTP ${res.status}: ${res.statusText}`
  try {
    if (res.headers.get('content-type')?.includes('application/json')) {
      const errorData = await res.json()
      errorMessage = errorData?.error || errorData?.message || errorMessage
    }
  } catch (parseError) {
    console.warn('[Fetcher] Failed to parse retry error response:', parseError)
  }
  const error = new Error(errorMessage) as FetcherError
  error.status = res.status
  error.statusText = res.statusText
  error.url = url
  return error
}

async function parseFetcherResponse<T>(res: Response, url: string): Promise<T> {
  if (!res.ok) throw await httpErrorFromResponse(res, url)
  try {
    return await res.json() as T
  } catch (parseError) {
    const error = new Error('Server returned invalid JSON', { cause: parseError }) as FetcherError
    error.code = 'INVALID_JSON'
    error.status = res.status
    error.statusText = res.statusText
    error.url = url
    throw error
  }
}

function normalizeFetchFailure(error: FetcherError, validTimeout: number): FetcherError {
  if (error.name === 'AbortError') {
    const timeoutError = new Error(`Request timed out after ${validTimeout}ms. Please try again.`) as FetcherError
    timeoutError.code = 'TIMEOUT'
    timeoutError.timeout = validTimeout
    return timeoutError
  }
  if (error.name === 'TypeError' && error.message?.includes('fetch')) {
    const networkError = new Error('Network error. Please check your connection and try again.') as FetcherError
    networkError.code = 'NETWORK_ERROR'
    return networkError
  }
  return error
}

async function requestJson<T>(url: string, validTimeout: number): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), validTimeout)
  try {
    const res = await fetch(url, { headers: COMMON_HEADERS, signal: controller.signal })
    return await parseFetcherResponse<T>(res, url)
  } catch (error) {
    throw normalizeFetchFailure(error as FetcherError, validTimeout)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Optimized fetcher for SWR with advanced error handling
 */
export async function fetcher<T>(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  try {
    if (!isValidUrl(url)) {
      throw new Error(`Invalid URL validation failed: ${url}`)
    }
    return await requestJson<T>(url, normalizedTimeout(timeoutMs))
  } catch (error: any) {
    const isValidationError = error?.status >= 400 && error?.status < 500
    if (isValidationError) {
      console.debug(`[Fetcher] ${error?.status || '4xx'} Error: ${url} - ${error?.message || 'Validation failed'}`)
    } else {
      console.warn(formatFetcherFailure(url, error))
    }
    throw error
  }
}

/**
 * Safe fetcher that returns null on error instead of throwing
 */
export async function safeFetcher<T>(url: string): Promise<T | null> {
  try {
    return await fetcher<T>(url)
  } catch (error) {
    console.warn('[SafeFetcher] Request failed, returning null:', error)
    return null
  }
}

/**
 * Retry fetcher with exponential backoff
 */
export async function retryFetcher<T>(
  url: string,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: any

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetcher<T>(url)
    } catch (error: any) {
      lastError = error

      // Don't retry on client errors (4xx)
      if (error.status >= 400 && error.status < 500) {
        throw error
      }

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        console.log(`[RetryFetcher] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError
}
