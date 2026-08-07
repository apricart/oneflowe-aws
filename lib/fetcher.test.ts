import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetcher, jsonFetcher } from './fetcher'

describe('fetcher error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns parsed JSON for a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))

    await expect(fetcher<{ ok: boolean }>('/api/v1/example')).resolves.toEqual({ ok: true })
  })

  it('warns without triggering console.error for a server failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Database temporarily unavailable' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'content-type': 'application/json' },
      }),
    ))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const request = fetcher('/api/v1/branches')

    await expect(request).rejects.toMatchObject({
      message: 'Database temporarily unavailable',
      status: 503,
      url: '/api/v1/branches',
    })
    expect(warn).toHaveBeenCalledWith(
      '[Fetcher] Request failed: /api/v1/branches | status=503 | code=N/A | Database temporarily unavailable',
    )
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('keeps expected client failures at debug level', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      }),
    ))
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(fetcher('/api/v1/missing')).rejects.toMatchObject({
      message: 'Not found',
      status: 404,
    })
    expect(debug).toHaveBeenCalledWith('[Fetcher] 404 Error: /api/v1/missing - Not found')
    expect(warn).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('preserves invalid JSON details without using console.error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(jsonFetcher('/api/v1/example')).rejects.toMatchObject({
      message: 'Invalid JSON response from server',
      code: 'INVALID_JSON',
      status: 200,
      url: '/api/v1/example',
    })
    expect(warn).toHaveBeenCalledWith(
      '[Fetcher] Request failed: /api/v1/example | status=200 | code=INVALID_JSON | Invalid JSON response from server',
    )
    expect(consoleError).not.toHaveBeenCalled()
  })
})
