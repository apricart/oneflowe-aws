import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  VIEWER_AREAS,
  VIEWER_DASHBOARD_ROUTES,
  VIEWER_HOME,
  VIEWER_ORGANIZATION_AREAS,
  VIEWER_ORGANIZATION_EXACT_AREAS,
  VIEWER_OWN_ACCOUNT_WRITES,
  VIEWER_READ_HELPERS,
  VIEWER_READ_ROUTES,
  VIEWER_ROLE,
  isOrganizationViewer,
  isReadOnlyRole,
  isViewerApiRequestAllowed,
  isViewerAreaAllowed,
  isViewerRole,
  resolveViewerBranchIds,
  resolveViewerScope,
  viewerMayFilterBranches,
  viewerReadRole,
  viewerReadScope,
} from "@/lib/viewer-access"
import { ROLE_TEMPLATES } from "@/lib/permissions"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("isViewerRole", () => {
  it("recognises the role and nothing else", () => {
    expect(isViewerRole(VIEWER_ROLE)).toBe(true)
    for (const other of [
      "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN",
      "GROUP_USER", "GROUP_ORDER_PORTAL", "ORDER_PORTAL",
    ]) {
      expect(isViewerRole(other)).toBe(false)
    }
  })

  it.each([null, undefined, "", "viewer", 1, {}])("refuses %s", (value) => {
    expect(isViewerRole(value)).toBe(false)
  })
})

describe("resolveViewerScope", () => {
  it("takes the organization from the session and never from the request", () => {
    expect(resolveViewerScope({ organizationId: 17, branchId: null })).toEqual({
      organizationId: 17,
      branchId: null,
    })
  })

  it("refuses an account with no organization rather than reading every tenant", () => {
    for (const organizationId of [null, undefined, 0, -1]) {
      const resolved = resolveViewerScope({ organizationId, branchId: null })
      expect(resolved.error).toMatch(/not assigned to an organization/)
      expect(resolved.organizationId).toBeUndefined()
    }
  })

  it("honours a requested branch for an unpinned viewer", () => {
    expect(resolveViewerScope({
      organizationId: 17,
      branchId: null,
      requestedBranchId: 42,
    })).toEqual({ organizationId: 17, branchId: 42 })
  })

  it("keeps a pinned viewer on its own branch when the request names another", () => {
    expect(resolveViewerScope({
      organizationId: 17,
      branchId: 42,
      requestedBranchId: 99,
    })).toEqual({ organizationId: 17, branchId: 42 })
  })

  it("ignores a malformed requested branch instead of widening or throwing", () => {
    for (const requestedBranchId of [0, -3, Number.NaN, null]) {
      expect(resolveViewerScope({
        organizationId: 17,
        branchId: null,
        requestedBranchId: requestedBranchId as number,
      })).toEqual({ organizationId: 17, branchId: null })
    }
  })
})

describe("resolveViewerBranchIds", () => {
  it("collapses a pinned viewer to its own branch whatever was requested", () => {
    expect(resolveViewerBranchIds({ branchId: 42, requestedBranchIds: [7, 8, 9] })).toEqual([42])
  })

  it("passes an unpinned viewer's request through, de-duplicated and cleaned", () => {
    expect(resolveViewerBranchIds({
      branchId: null,
      requestedBranchIds: [7, 7, "8", 0, -1, "x", null],
    })).toEqual([7, 8])
  })

  it("returns nothing for an unpinned viewer that asked for nothing", () => {
    expect(resolveViewerBranchIds({ branchId: null })).toEqual([])
  })
})

describe("viewerMayFilterBranches", () => {
  it("offers the filter only to an unpinned viewer", () => {
    expect(viewerMayFilterBranches(null)).toBe(true)
    expect(viewerMayFilterBranches(undefined)).toBe(true)
    expect(viewerMayFilterBranches(42)).toBe(false)
  })
})

const ORGANIZATION_WIDE = { organizationId: 17, branchId: null }
const PINNED = { organizationId: 17, branchId: 42 }

describe("the two shapes of the role", () => {
  it("is organization-wide only with an organization and no branch", () => {
    expect(isOrganizationViewer({ role: VIEWER_ROLE, ...ORGANIZATION_WIDE })).toBe(true)
    expect(isOrganizationViewer({ role: VIEWER_ROLE, ...PINNED })).toBe(false)
    expect(isOrganizationViewer({ role: VIEWER_ROLE, organizationId: null, branchId: null })).toBe(false)
    expect(isOrganizationViewer({ role: VIEWER_ROLE, organizationId: 0, branchId: null })).toBe(false)
    expect(isOrganizationViewer({ role: "HEAD_OFFICE", ...ORGANIZATION_WIDE })).toBe(false)
  })
})

describe("viewerReadRole — the role an admitted read is scoped by", () => {
  it("scopes an organization-wide Viewer as Head Office", () => {
    expect(viewerReadRole({ role: VIEWER_ROLE, ...ORGANIZATION_WIDE })).toBe("HEAD_OFFICE")
  })

  it("refuses a branch-pinned Viewer, or one with no organization", () => {
    expect(viewerReadRole({ role: VIEWER_ROLE, ...PINNED })).toBeNull()
    expect(viewerReadRole({ role: VIEWER_ROLE, organizationId: null, branchId: null })).toBeNull()
    expect(viewerReadRole({ role: VIEWER_ROLE, organizationId: undefined, branchId: undefined })).toBeNull()
  })

  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL", "WAREHOUSE"])(
    "leaves %s exactly as it is",
    (role) => {
      expect(viewerReadRole({ role, ...PINNED })).toBe(role)
      expect(viewerReadRole({ role, organizationId: null, branchId: null })).toBe(role)
    },
  )

  it("never turns a missing role into a role", () => {
    expect(viewerReadRole({ role: undefined, ...ORGANIZATION_WIDE })).toBeNull()
    expect(viewerReadRole({ role: 7, ...ORGANIZATION_WIDE })).toBeNull()
  })
})

describe("viewerReadScope", () => {
  const scope = (role: string, branchId: number | null) => ({ role, userId: "u-1", organizationId: 17, branchId })

  it("keeps the organization and the user, and changes only the role", () => {
    expect(viewerReadScope(scope(VIEWER_ROLE, null))).toEqual(scope("HEAD_OFFICE", null))
  })

  it("refuses a pinned Viewer and passes nothing through for a missing scope", () => {
    expect(viewerReadScope(scope(VIEWER_ROLE, 42))).toBeNull()
    expect(viewerReadScope(null)).toBeNull()
  })

  it("returns every other caller's scope as the same object", () => {
    const branchAdmin = scope("BRANCH_ADMIN", 42)
    expect(viewerReadScope(branchAdmin)).toBe(branchAdmin)
  })
})

describe("the areas the role may navigate to", () => {
  it("is the dashboard alone for a pinned Viewer", () => {
    expect(VIEWER_AREAS).toEqual([VIEWER_HOME])
    expect(VIEWER_HOME).toBe("/dashboard")
    expect(isViewerAreaAllowed("/dashboard", PINNED)).toBe(true)
    for (const path of ["/orders", "/users", "/reports", "/support", "/invoices/1", "/inventory"]) {
      expect(isViewerAreaAllowed(path, PINNED), path).toBe(false)
    }
  })

  it("is Head Office's menu for an organization-wide Viewer", () => {
    for (const path of [...VIEWER_ORGANIZATION_AREAS, ...VIEWER_ORGANIZATION_EXACT_AREAS, "/orders/9", "/reports/user-report"]) {
      expect(isViewerAreaAllowed(path, ORGANIZATION_WIDE), path).toBe(true)
    }
  })

  it("leaves out Head Office's write pages and every other role's area", () => {
    for (const path of [
      "/inventory/add", "/inventory/adjust", "/inventory/assign", "/inventory/org",
      "/organizations", "/approvals", "/shop", "/group-portal", "/branch-inventory",
      "/refunds", "/products", "/employee-management", "/receipts/1", "/ordersx",
    ]) {
      expect(isViewerAreaAllowed(path, ORGANIZATION_WIDE), path).toBe(false)
    }
  })

  it("is confined explicitly in the proxy, which fails open for an unknown role", () => {
    const proxySource = source("proxy.ts")
    expect(proxySource).toContain("{ matches: isViewerRole, allows: isViewerAreaAllowed, home: VIEWER_HOME }")
    expect(proxySource).toContain("return confined.allows(pathname, tenant) ? null : confined.home")
  })
})

describe("the proxy's write fence", () => {
  it.each(["GET", "HEAD", "get"])("lets a %s through to its handler", (method) => {
    expect(isViewerApiRequestAllowed(method, "/api/v1/orders")).toBe(true)
  })

  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses a %s anywhere but the account's own password change", (method) => {
    for (const path of ["/api/v1/orders", "/api/v1/budgets", "/api/v1/users/u-1/access", "/api/v1/notifications", "/api/v1/mfa/toggle"]) {
      expect(isViewerApiRequestAllowed(method, path), `${method} ${path}`).toBe(false)
    }
  })

  it("admits the password change, which the first sign-in forces", () => {
    for (const path of VIEWER_OWN_ACCOUNT_WRITES) {
      expect(isViewerApiRequestAllowed("POST", path)).toBe(true)
      expect(path.startsWith("/api/v1/users/me/")).toBe(true)
    }
  })

  it("is applied in the proxy to every Viewer token", () => {
    expect(source("proxy.ts")).toContain(
      "if (isViewerRole((token as any)?.role) && !isViewerApiRequestAllowed(req.method, pathname)) {",
    )
  })

  it("marks the role read-only for the pages, and no other role", () => {
    expect(isReadOnlyRole(VIEWER_ROLE)).toBe(true)
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL"]) {
      expect(isReadOnlyRole(role)).toBe(false)
    }
  })
})

/**
 * The control for this role. A route reaches a Viewer only by naming it — the
 * role itself, the read-scope helpers or the `viewerReadsAsHeadOffice` opt-in —
 * or by calling one of `VIEWER_READ_HELPERS`. The list must be exactly that
 * set, and no write handler may name the role at all.
 */
describe("the routes that admit a Viewer", () => {
  // `fs.globSync` would read better but only exists from Node 22; CI runs 20.19.
  const routeFiles = readdirSync(resolve(process.cwd(), "app/api/v1"), { recursive: true, encoding: "utf8" })
    .map((path) => `app/api/v1/${path.split("\\").join("/")}`)
    .filter((path) => path.endsWith("/route.ts"))

  const MARKER = /["']VIEWER["']|viewerReadRole|viewerReadScope|viewerReadsAsHeadOffice|isOrganizationViewer|supportReaderFromSession/
  const WRITE = /export\s+(?:async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/g
  const ANY_HANDLER = /\nexport\s+(?:async\s+function|const)\s+(?:GET|HEAD|POST|PUT|PATCH|DELETE)\b/

  /** The source of each exported write handler, up to the next exported handler. */
  function writeHandlerBodies(text: string): Array<{ method: string; body: string }> {
    return [...text.matchAll(WRITE)].map((match) => {
      const start = match.index ?? 0
      const rest = text.slice(start + match[0].length)
      const next = rest.search(ANY_HANDLER)
      return { method: match[1], body: text.slice(start, next < 0 ? text.length : start + match[0].length + next) }
    })
  }

  const helperCallers = (entry: string) => routeFiles.filter((path) => new RegExp(String.raw`\b${entry}\(`).test(source(path)))

  it("finds the route files to check", () => {
    expect(routeFiles.length).toBeGreaterThan(50)
  })

  it("lists exactly the routes that name the role or call a read helper", () => {
    const admitting = new Set(routeFiles.filter((path) => MARKER.test(source(path))))
    for (const { entry } of VIEWER_READ_HELPERS) for (const path of helperCallers(entry)) admitting.add(path)
    expect([...admitting].sort()).toEqual([...VIEWER_READ_ROUTES].sort())
  })

  it("keeps the dashboard's four routes on the list", () => {
    for (const route of VIEWER_DASHBOARD_ROUTES) expect(VIEWER_READ_ROUTES).toContain(route)
  })

  it("never names the role inside a write handler", () => {
    const offenders: string[] = []
    for (const path of VIEWER_READ_ROUTES) {
      for (const { method, body } of writeHandlerBodies(source(path))) {
        if (MARKER.test(body)) offenders.push(`${method} ${path}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("never defaults the opt-in to true", () => {
    for (const path of VIEWER_READ_ROUTES) {
      expect(source(path), path).not.toMatch(/viewerReadsAsHeadOffice\??:\s*boolean\s*=\s*true/)
      expect(source(path), path).not.toMatch(/viewerReadsAsHeadOffice:\s*true\s*}\s*=/)
    }
  })

  it.each(VIEWER_READ_HELPERS)("calls $entry from read-only routes alone", ({ module, entry }) => {
    expect(source(module)).toMatch(/viewerReadRole|viewerReadScope/)
    const callers = helperCallers(entry)
    expect(callers.length).toBeGreaterThan(0)
    for (const path of callers) {
      expect(source(path), `${path} exports a write handler`).not.toMatch(
        /export\s+(?:async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/,
      )
    }
  })
})

describe("the role's permission template", () => {
  it("exists and carries reads only", () => {
    const template = (ROLE_TEMPLATES as Record<string, { permissions: string[] }>).VIEWER
    expect(template).toBeDefined()
    for (const permission of template.permissions) {
      expect(permission, `${permission} is not a read`).toMatch(/:(view|view_.*)$/)
    }
  })

  it("reads support threads but raises and answers none", () => {
    const template = (ROLE_TEMPLATES as Record<string, { permissions: string[] }>).VIEWER
    expect(template.permissions).toContain("support:view")
    expect(template.permissions.some((permission) => /^support:(create|reply|manage)/.test(permission))).toBe(false)
  })
})
