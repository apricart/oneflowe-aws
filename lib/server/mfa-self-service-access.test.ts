import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { MFA_SELF_SERVICE_ROLES } from "@/lib/server/mfa-self-service-access"

const MFA_SELF_SERVICE_ROUTES = [
  "app/api/v1/mfa/status/route.ts",
  "app/api/v1/mfa/toggle/route.ts",
  "app/api/v1/mfa/send-otp/route.ts",
  "app/api/v1/mfa/verify-otp/route.ts",
] as const

describe("MFA self-service access", () => {
  it("allows the shared Settings roles, including GROUP_USER", () => {
    expect(MFA_SELF_SERVICE_ROLES).toEqual([
      "SUPER_ADMIN",
      "HEAD_OFFICE",
      "BRANCH_ADMIN",
      "GROUP_USER",
    ])
  })

  it("keeps storefront-only roles out of Settings self-service", () => {
    expect(MFA_SELF_SERVICE_ROLES).not.toContain("GROUP_ORDER_PORTAL")
    expect(MFA_SELF_SERVICE_ROLES).not.toContain("ORDER_PORTAL")
  })

  it.each(MFA_SELF_SERVICE_ROUTES)("uses the shared policy in %s", (path) => {
    const source = readFileSync(join(process.cwd(), path), "utf8")

    expect(source).toContain('import { MFA_SELF_SERVICE_ROLES } from "@/lib/server/mfa-self-service-access"')
    expect(source).toContain("requireApiRole(MFA_SELF_SERVICE_ROLES)")
  })
})
