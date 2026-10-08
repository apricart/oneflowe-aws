import type { ReactNode } from "react"
import { vi } from "vitest"

/**
 * Module-mock factories and shared state for UI tests. Deliberately imports no
 * application code: the `next-auth/react` and `next/navigation` mock factories
 * load this file, and anything here that imported a mocked module would
 * deadlock the import graph. Rendering helpers live in `ui-harness.tsx`.
 *
 * ```ts
 * vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
 * vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
 * ```
 */

export type SessionUser = {
  id?: string
  role: string
  organizationId?: number | null
  branchId?: number | null
  email?: string
  name?: string
  [key: string]: unknown
}

type Handled = unknown | { status: number; body: unknown }
type Handler = Handled | ((url: URL, init?: RequestInit) => Handled | Promise<Handled>)
export type FetchRoute = [matcher: string | RegExp, handler: Handler]

export const ui = {
  session: { role: "SUPER_ADMIN", id: "u-1", email: "user@example.test" } as SessionUser | null,
  sessionStatus: "authenticated" as "authenticated" | "loading" | "unauthenticated",
  searchParams: new URLSearchParams(),
  pathname: "/",
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    forward: vi.fn(),
  },
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
  unmatched: [] as string[],
  sessionUpdate: vi.fn(async () => null),
}

// NextAuth hands every render the same session object until it changes;
// a fresh object per render would re-run every effect keyed on the session.
let cachedSessionFor: SessionUser | null | undefined
let cachedSession: { user: SessionUser; expires: string } | null = null
function stableSession() {
  if (cachedSessionFor !== ui.session) {
    cachedSessionFor = ui.session
    cachedSession = ui.session ? { user: ui.session, expires: "2099-01-01T00:00:00.000Z" } : null
  }
  return cachedSession
}

export function nextAuthMock() {
  return {
    useSession: () => ({
      data: stableSession(),
      status: ui.session ? ui.sessionStatus : "unauthenticated",
      update: ui.sessionUpdate,
    }),
    signIn: vi.fn(async () => ({ ok: true, error: null })),
    signOut: vi.fn(async () => undefined),
    getSession: vi.fn(async () => (ui.session ? { user: ui.session } : null)),
    SessionProvider: ({ children }: { children: ReactNode }) => children,
  }
}

export function navigationMock() {
  return {
    useRouter: () => ui.router,
    usePathname: () => ui.pathname,
    useSearchParams: () => ui.searchParams,
    useParams: () => ({}),
    redirect: vi.fn(),
    notFound: vi.fn(),
  }
}

function isResponseShape(value: unknown): value is { status: number; body: unknown } {
  return typeof value === "object" && value !== null && "status" in value && "body" in value
    && Object.keys(value).length === 2
}

/**
 * Answer every `fetch` from the route table, first match wins. A string
 * matcher matches when the request path (without the query) equals it or
 * starts with it followed by `?`; a RegExp is tested against path + query.
 * Unmatched requests answer `{}` and are recorded in `ui.unmatched`.
 */
export function installFetch(routes: FetchRoute[]): void {
  ui.calls.length = 0
  ui.unmatched.length = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const url = new URL(raw, "http://localhost")
    const method = (init?.method ?? "GET").toUpperCase()
    let body: unknown = undefined
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    ui.calls.push({ method, url: url.pathname + url.search, body })

    const target = url.pathname + url.search
    const route = routes.find(([matcher]) =>
      typeof matcher === "string" ? url.pathname === matcher : matcher.test(target),
    )
    if (!route) ui.unmatched.push(`${method} ${target}`)
    const handler = route?.[1]
    const resolved = typeof handler === "function"
      ? await (handler as (url: URL, init?: RequestInit) => Handled | Promise<Handled>)(url, init)
      : handler ?? {}
    const { status, payload } = isResponseShape(resolved)
      ? { status: resolved.status, payload: resolved.body }
      : { status: 200, payload: resolved }

    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", fetchMock)
}

export function callsTo(path: string | RegExp, method?: string) {
  return ui.calls.filter((call) =>
    (method ? call.method === method : true) &&
    (typeof path === "string" ? call.url.split("?")[0] === path : path.test(call.url)),
  )
}

export function installDomPolyfills(): void {
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
  }
  if (!("IntersectionObserver" in globalThis)) {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    })
  }
  const proto = Element.prototype as any
  proto.scrollIntoView ??= () => {}
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
  if (!window.matchMedia) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false },
    }))
  }
  URL.createObjectURL ??= () => "blob:mock"
  URL.revokeObjectURL ??= () => {}
}

export function resetUi(session: SessionUser | null = { role: "SUPER_ADMIN", id: "u-1" }): void {
  ui.session = session ? { email: "user@example.test", ...session } : null
  ui.sessionStatus = "authenticated"
  ui.searchParams = new URLSearchParams()
  ui.pathname = "/"
  for (const fn of Object.values(ui.router)) fn.mockClear()
  ui.sessionUpdate.mockClear()
  try {
    localStorage.clear()
  } catch {
    // jsdom always has storage; ignore if a test removed it
  }
  installDomPolyfills()
}

