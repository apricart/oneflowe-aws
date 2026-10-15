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
const USER_LEVEL_MODULE = "lib/server/user-approval-level.ts"
const USER_LEVEL_ROUTE = "app/api/v1/users/[id]/approval-level/route.ts"

/**
 * The text of every `.set(...)` and `.values(...)` call in a source — where a
 * Drizzle write names the columns it writes. Parentheses are balanced, so a
 * nested call does not end the block early.
 */
function writeBlocks(source: string): string[] {
  const blocks: string[] = []
  for (const match of source.matchAll(/\.(?:set|values)\(/g)) {
    let depth = 1
    let index = (match.index ?? 0) + match[0].length
    const start = index
    while (index < source.length && depth > 0) {
      if (source[index] === "(") depth += 1
      else if (source[index] === ")") depth -= 1
      index += 1
    }
    blocks.push(source.slice(start, index - 1))
  }
  return blocks
}

/** Files whose Drizzle writes name `property`, explicitly or as shorthand. */
function writersOf(property: string): string[] {
  const pattern = new RegExp(`\\b${property}\\s*[:,}\\n]`)
  return PRODUCTION_SOURCES
    .filter((file) => !file.startsWith("components/") && !file.startsWith("app/(portal)/"))
    .filter((file) => writeBlocks(read(file)).some((block) => pattern.test(block)))
}

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
    expect(writersOf("orderApprovalLevelsEnabled").sort()).toEqual([ORGANIZATIONS_ROUTE, SERVER_MODULE].sort())
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

  it("PUT is Super Admin only, before anything else runs", () => {
    const body = handlerBody(route, "PUT")
    expect(body).toMatch(/requireApiRole\(\["SUPER_ADMIN"\]\)/)
    expect(body.indexOf("requireApiRole")).toBeLessThan(body.indexOf("await props.params"))
  })

  it("GET admits Super Admin and Head Office only, and fences Head Office to its own organization", () => {
    // plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md: the user forms list
    // the levels to assign.
    const body = handlerBody(route, "GET")
    expect(body).toMatch(/requireApiRole\(\["SUPER_ADMIN", "HEAD_OFFICE"\]\)/)
    expect(body.indexOf("requireApiRole")).toBeLessThan(body.indexOf("await props.params"))
    expect(body).toContain("getRequestScope()")
    expect(body).toMatch(/scope\.role !== "SUPER_ADMIN" && scope\.organizationId !== organizationId/)
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

describe("order approval levels — nothing in the order path reads them yet", () => {
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
      // Phase 2a: assigning users to levels (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md).
      USER_LEVEL_MODULE,
      "components/users/approval-level-field.tsx",
      // The department sign-up (plans/OF-JOIN-department-signup-multi-user.md):
      // the join form of a levels-enabled organization shows the bands, and its
      // approval assigns levels through USER_LEVEL_MODULE. Still not the order
      // path: nothing here routes or decides an order.
      "lib/join-department-signup.ts",
      "lib/join-approver-resolution.ts",
      "lib/server/organization-join-department.ts",
      "app/join/page.tsx",
      "components/join/department-signup-form.tsx",
      "components/join/department-join-review-dialog.tsx",
    ])
    // A new reader is phase 2b: route orders deliberately, and update this list
    // and the plan together.
    expect(readers.filter((file) => !allowed.has(file))).toEqual([])
  })
})

/* plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md */
describe("a user's approval level", () => {
  it("is written only by user creation, the access route (clearing it) and the server module", () => {
    expect(writersOf("orderApprovalLevel").sort()).toEqual([
      "app/api/v1/users/[id]/access/route.ts",
      "app/api/v1/users/route.ts",
      USER_LEVEL_MODULE,
    ].sort())
  })

  it("lets the access route only clear it, never set one", () => {
    const access = read("app/api/v1/users/[id]/access/route.ts")
    expect(access).toContain("orderApprovalLevel: clearsApprovalLevel ? null : undefined")
  })

  it("is assigned through an endpoint for the user-management roles, which does not end sessions", () => {
    const route = read(USER_LEVEL_ROUTE)
    const put = handlerBody(route, "PUT")
    expect(put).toContain("requireApiRole(USER_MANAGEMENT_ROLES)")
    expect(put.indexOf("requireApiRole")).toBeLessThan(put.indexOf("await props.params"))
    expect(put).toContain("userApprovalLevelUpdateSchema.safeParse(")
    expect(put).not.toMatch(/sessions|sessionVersion|VIEWER|viewerRead/)
    expect(route).not.toMatch(/export async function (GET|POST|PATCH|DELETE)\(/)
  })

  it("checks the level under the organization lock, and fences Head Office to its tenant", () => {
    const serverModule = read(USER_LEVEL_MODULE)
    expect(serverModule.startsWith('import "server-only"')).toBe(true)
    expect(serverModule).toMatch(/\.for\("share"\)/)
    expect(serverModule).toMatch(/\.for\("update", \{ of: users \}\)/)
    expect(serverModule).toContain("isSelfAccessChange(")
    expect(serverModule).toContain("canManageUser(")
    expect(serverModule).toMatch(/recordAuditEvent\(\s*tx\s*,/)
  })

  it("refuses to remove a level someone holds, inside the levels save", () => {
    const save = read(SERVER_MODULE)
    expect(save).toContain("heldRemovedApprovalLevels(tx")
    expect(read(ROUTE)).toContain('outcome.kind === "levels-held"')
  })
})
