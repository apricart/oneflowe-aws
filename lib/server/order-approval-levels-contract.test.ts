import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Structural controls for order approval levels
 * (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md).
 *
 * Behaviour is covered by the unit, schema, component and integration tests;
 * this pins what a reviewer would otherwise have to remember: who may write the
 * levels and the switch, that the write is serialised, and that phase 1 has not
 * quietly grown a reader in the order path.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")

/** Every .ts/.tsx under a folder, as repo-relative paths with forward slashes. */
function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
        out.push(relative(process.cwd(), full).split(sep).join("/"))
      }
    }
  }
  walk(join(process.cwd(), root))
  return out
}

const PRODUCTION_SOURCES = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")]

const ROUTE = "app/api/v1/organizations/[id]/approval-levels/route.ts"
const SERVER_MODULE = "lib/server/order-approval-levels.ts"
const ORGANIZATIONS_ROUTE = "app/api/v1/organizations/route.ts"

/** The handler named, from its `export async function` to the next one. */
function handlerBody(source: string, method: string): string {
  const start = source.indexOf(`export async function ${method}(`)
  expect(start, `${method} handler is missing`).toBeGreaterThanOrEqual(0)
  const next = source.indexOf("export async function ", start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe("order approval levels — who writes them", () => {
  it("writes the levels table from the server module alone", () => {
    const writers = PRODUCTION_SOURCES.filter((file) =>
      /(insert|update|delete)\(\s*organizationApprovalLevels\b/.test(read(file)),
    )
    expect(writers).toEqual([SERVER_MODULE])
  })

  it("sets the switch only on creation and through the server module", () => {
    // Written as a property, explicit (`orderApprovalLevelsEnabled: x`) or shorthand.
    const writers = PRODUCTION_SOURCES.filter((file) => /\borderApprovalLevelsEnabled\s*[:,]/.test(read(file)))
      .filter((file) => !file.startsWith("components/") && !file.startsWith("app/(portal)/"))
    expect(writers.sort()).toEqual([ORGANIZATIONS_ROUTE, SERVER_MODULE].sort())
  })

  it("reaches the levels from the organization POST through the shared replacement only", () => {
    const post = handlerBody(read(ORGANIZATIONS_ROUTE), "POST")
    expect(post).toContain("replaceOrganizationApprovalLevels(tx")
    expect(post).not.toMatch(/insert\(\s*organizationApprovalLevels/)
  })

  it("leaves the organization PATCH alone", () => {
    expect(read("app/api/v1/organizations/[id]/route.ts")).not.toMatch(/orderApprovalLevels|approvalLevel/i)
  })
})

describe("order approval levels — the endpoint", () => {
  const route = read(ROUTE)

  it.each(["GET", "PUT"])("%s is Super Admin only, before anything else runs", (method) => {
    const body = handlerBody(route, method)
    expect(body).toMatch(/requireApiRole\(\["SUPER_ADMIN"\]\)/)
    expect(body.indexOf("requireApiRole")).toBeLessThan(body.indexOf("await props.params"))
  })

  it("validates the body with the shared strict schema", () => {
    expect(handlerBody(route, "PUT")).toContain("orderApprovalLevelsSchema.safeParse(")
  })

  it("takes the actor from the session, never the request", () => {
    const put = handlerBody(route, "PUT")
    expect(put).toContain("getRequestScope()")
    expect(put).not.toMatch(/body\.(actor|userId|role)/)
  })

  it("carries no Viewer marker in a write handler (lib/viewer-access.test.ts)", () => {
    expect(handlerBody(route, "PUT")).not.toMatch(/VIEWER|viewerRead|viewerReadsAsHeadOffice/)
  })
})

describe("order approval levels — the write", () => {
  const serverModule = read(SERVER_MODULE)

  it("locks the organization row before reading what it replaces", () => {
    const save = serverModule.slice(serverModule.indexOf("export async function saveOrganizationApprovalLevels"))
    expect(save).toContain("db.transaction(")
    const lock = save.indexOf('.for("update")')
    expect(lock).toBeGreaterThan(0)
    expect(lock).toBeLessThan(save.indexOf("loadOrganizationApprovalLevels(tx"))
  })

  it("records the change inside that transaction, with before and after", () => {
    expect(serverModule).toMatch(/recordAuditEvent\(\s*tx\s*,/)
    expect(serverModule).toContain("ORDER_APPROVAL_LEVELS_AUDIT_ACTION")
    expect(serverModule).toMatch(/\bbefore,\s*\n\s*after,/)
  })

  it("stays server-only", () => {
    expect(serverModule.startsWith('import "server-only"')).toBe(true)
  })
})

describe("order approval levels — phase 1 reads nothing in the order path", () => {
  it("is not read by any order, decision or notification module yet", () => {
    const readers = PRODUCTION_SOURCES.filter((file) =>
      /order-approval-levels|organizationApprovalLevels|orderApprovalLevelsEnabled/.test(read(file)),
    )
    const allowed = new Set([
      ROUTE,
      SERVER_MODULE,
      ORGANIZATIONS_ROUTE,
      "lib/order-approval-levels.ts",
      "lib/server/mutation-validation.ts",
      "components/organizations/order-approval-levels-fields.tsx",
      "app/(portal)/organizations/page.tsx",
    ])
    // A new reader is phase 2: route orders deliberately, and update this list
    // and the plan together.
    expect(readers.filter((file) => !allowed.has(file))).toEqual([])
  })
})
