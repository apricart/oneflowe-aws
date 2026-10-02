import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { globSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  VIEWER_AREAS,
  VIEWER_HOME,
  VIEWER_READ_ROUTES,
  VIEWER_ROLE,
  isViewerRole,
  resolveViewerBranchIds,
  resolveViewerScope,
  viewerMayFilterBranches,
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

describe("the areas the role may navigate to", () => {
  it("is the dashboard alone", () => {
    expect(VIEWER_AREAS).toEqual([VIEWER_HOME])
    expect(VIEWER_HOME).toBe("/dashboard")
  })

  it("is confined explicitly in the proxy, which fails open for an unknown role", () => {
    const proxySource = source("proxy.ts")
    expect(proxySource).toContain("isViewerRole(role)")
    expect(proxySource).toContain("VIEWER_AREAS")
  })
})

/**
 * The control for this role. `requireApiRole` refuses any role absent from a
 * route's allowlist, so the role is read-only exactly as long as the routes
 * naming it are reads. A route that starts admitting VIEWER without being added
 * to the list fails here.
 */
describe("the routes that admit a Viewer", () => {
  const routeFiles = globSync("app/api/v1/**/route.ts", { cwd: process.cwd() })
    .map((path) => path.split("\\").join("/"))

  it("finds the route files to check", () => {
    expect(routeFiles.length).toBeGreaterThan(50)
  })

  it("lists every route whose allowlist names VIEWER", () => {
    const admitting = routeFiles.filter((path) => /["']VIEWER["']/.test(source(path)))
    expect([...admitting].sort()).toEqual([...VIEWER_READ_ROUTES].sort())
  })

  it("admits the role to reads only — no POST, PUT, PATCH or DELETE route", () => {
    // `app/api/v1/branches/route.ts` exports a POST, but its POST carries its
    // own narrower allowlist (BRANCH_CREATION_ROLES) rather than the GET's, so
    // it is asserted specifically rather than excluded silently.
    const branchesSource = source("app/api/v1/branches/route.ts")
    expect(branchesSource).toContain("requireApiRole(BRANCH_CREATION_ROLES)")
    expect(branchesSource).not.toMatch(/BRANCH_CREATION_ROLES[^\n]*VIEWER/)

    for (const path of VIEWER_READ_ROUTES.filter((route) => route !== "app/api/v1/branches/route.ts")) {
      const routeSource = source(path)
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(routeSource, `${path} exports ${method}`)
          .not.toMatch(new RegExp(`export async function ${method}\\b`))
      }
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

  it("holds no support channel, unlike every other client role", () => {
    const template = (ROLE_TEMPLATES as Record<string, { permissions: string[] }>).VIEWER
    expect(template.permissions.some((permission) => permission.startsWith("support:"))).toBe(false)
  })
})
