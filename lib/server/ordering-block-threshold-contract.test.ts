import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Contract tests for the configurable ordering-block thresholds
 * (plans/OF-ORDERING-BLOCK-configurable-thresholds.md).
 *
 * The rule is exercised in lib/ordering-block-threshold.test.ts and against
 * Postgres in tests/integration/ordering-block-thresholds.test.ts. These pin
 * the shape: the two limits are written only by Super Admin's two organization
 * routes, each change is audited inside the PATCH transaction, and nothing
 * else in the API names either column.
 */
const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

const FIELDS = ["unpaidInvoiceBlockThreshold", "unacknowledgedDeliveryBlockThreshold"] as const
const WRITERS = ["app/api/v1/organizations/route.ts", "app/api/v1/organizations/[id]/route.ts"]

function routeFiles(directory: string): string[] {
  return readdirSync(resolve(process.cwd(), directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return routeFiles(path)
    return entry.name === "route.ts" ? [relative(process.cwd(), resolve(process.cwd(), path)).replace(/\\/g, "/")] : []
  })
}

describe("the limits are Super Admin's alone", () => {
  it.each([
    ["app/api/v1/organizations/route.ts", "export async function POST"],
    ["app/api/v1/organizations/[id]/route.ts", "export async function PATCH"],
  ])("%s writes them only behind a Super Admin gate", (path, handler) => {
    const text = source(path)
    const handlerAt = text.indexOf(handler)
    const gateAt = text.indexOf('requireApiRole(["SUPER_ADMIN"])', handlerAt)
    expect(handlerAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(handlerAt)
    for (const field of FIELDS) {
      expect(text.indexOf(field, handlerAt), field).toBeGreaterThan(gateAt)
    }
  })

  it("creation writes the validated value, never the raw body", () => {
    const text = source("app/api/v1/organizations/route.ts")
    expect(text).toContain("unpaidInvoiceBlockThreshold: body.unpaidInvoiceBlockThreshold,")
    expect(text).toContain("unacknowledgedDeliveryBlockThreshold: body.unacknowledgedDeliveryBlockThreshold,")
    expect(text).toContain("organizationCreateSchema.safeParse(rawBody)")
  })

  it("the update copies them through the explicit allowlist, after the schema", () => {
    const text = source("app/api/v1/organizations/[id]/route.ts")
    const allowlist = text.slice(text.indexOf("const VERBATIM_ORGANIZATION_FIELDS"), text.indexOf("] as const"))
    for (const field of FIELDS) expect(allowlist).toContain(`"${field}"`)
    expect(text).toContain("organizationUpdateSchema.safeParse(rawBody)")
  })

  it("no other API route names either column", () => {
    const others = routeFiles("app/api").filter((path) => !WRITERS.includes(path))
    expect(others.length).toBeGreaterThan(50)
    for (const path of others) {
      const text = source(path)
      for (const field of FIELDS) expect(text, `${path} names ${field}`).not.toContain(field)
    }
  })
})

describe("a change is audited with what it replaced, in the same transaction", () => {
  const text = source("app/api/v1/organizations/[id]/route.ts")

  it("the helper is handed the transaction, inside it, before it returns", () => {
    const patchAt = text.indexOf("export async function PATCH")
    const txAt = text.indexOf("db.transaction(async (tx) => {", patchAt)
    const txEnd = text.indexOf('return { kind: "updated", item: updatedOrganization } as const', txAt)
    const callAt = text.indexOf("await auditOrderingBlockThresholds(tx, {", txAt)
    expect(callAt).toBeGreaterThan(txAt)
    expect(callAt).toBeLessThan(txEnd)
  })

  it("the previous value is read under the PATCH's row lock", () => {
    const lockedSelect = text.slice(text.indexOf("const [existingOrganization] = await tx"), text.indexOf('.for("update")'))
    for (const field of FIELDS) expect(lockedSelect).toContain(`${field}: organizations.${field}`)
  })

  it("writes through that tx, with both values, under its own action", () => {
    const helperAt = text.indexOf("async function auditOrderingBlockThresholds(")
    const helper = text.slice(helperAt, text.indexOf("\n}\n", helperAt))
    expect(helper).toContain("await tx.insert(auditLogs)")
    expect(helper).not.toContain("db.insert(")
    expect(helper).toContain("action: UNPAID_INVOICE_BLOCK_THRESHOLD_AUDIT_ACTION")
    expect(helper).toContain("action: UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD_AUDIT_ACTION")
    expect(helper).toContain("previousUnpaidInvoiceBlockThreshold: existingOrganization.unpaidInvoiceBlockThreshold")
    expect(helper).toContain("previousUnacknowledgedDeliveryBlockThreshold: existingOrganization.unacknowledgedDeliveryBlockThreshold")
  })

  it("creation records both limits in its audit row", () => {
    const create = source("app/api/v1/organizations/route.ts")
    const auditAt = create.indexOf('action: "CREATE_ORGANIZATION"')
    const metadata = create.slice(auditAt, create.indexOf("},\n      })", auditAt))
    for (const field of FIELDS) expect(metadata).toContain(`${field}: body.${field}`)
  })
})

describe("the Company form", () => {
  const page = source("app/(portal)/organizations/page.tsx")

  it("sends the limits only from Super Admin's edit", () => {
    const superAdminBranch = page.slice(page.indexOf("...(isSuperAdmin\n"), page.indexOf(": {}),", page.indexOf("...(isSuperAdmin\n")))
    expect(superAdminBranch).toContain("...orderingBlockThresholdPayload(unpaidInvoiceBlockThreshold, unacknowledgedDeliveryBlockThreshold)")
  })

  it("never restates the bounds or the default", () => {
    expect(page).not.toMatch(/min=\{1\}|max=\{100\}/)
    expect(page).toContain("min={ORDERING_BLOCK_THRESHOLD_MIN}")
    expect(page).toContain("max={ORDERING_BLOCK_THRESHOLD_MAX}")
  })
})
