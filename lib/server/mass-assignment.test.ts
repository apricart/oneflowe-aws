import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  adminRefundProcessSchema,
  branchProductUpdateSchema,
  globalProductUpdateSchema,
  moneyBudgetUpdateSchema,
  orderCreateSchema,
  organizationProductUpdateSchema,
  supplierCreateSchema,
  userAccessUpdateSchema,
  userCreateSchema,
  userProfileUpdateSchema,
} from "@/lib/server/mutation-validation"
import {
  canAssignRole,
  canManageUser,
  canUseOrganization,
  isSelfAccessChange,
} from "@/lib/server/user-access-policy"

const strongPassword = "ValidPassword1!"

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory()
      ? routeFiles(path)
      : entry === "route.ts" ? [path] : []
  })
}

describe("strict mutation schemas", () => {
  it("rejects hidden privilege and tenant fields during user creation", () => {
    const result = userCreateSchema.safeParse({
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      username: "test.user",
      password: strongPassword,
      role: "BRANCH_ADMIN",
      organizationId: 10,
      branchId: 20,
      tenantId: "another-tenant",
      isAdmin: true,
      isSuperAdmin: true,
      permissions: ["ALL"],
      approvedBy: "attacker",
      createdBy: "attacker",
    })

    expect(result.success).toBe(false)
  })

  it("rejects access fields on the profile-only user operation", () => {
    const injected = {
      name: "Test User",
      role: "SUPER_ADMIN",
      tenantId: "another-tenant",
      organizationId: 999,
      branchId: 999,
      isActive: true,
      permissions: ["ALL"],
    }

    expect(userProfileUpdateSchema.safeParse(injected).success).toBe(false)
  })

  it("allows only enumerated access fields on the separate access operation", () => {
    expect(userAccessUpdateSchema.safeParse({
      role: "BRANCH_ADMIN",
      organizationId: 10,
      branchId: 20,
      isActive: false,
    }).success).toBe(true)

    expect(userAccessUpdateSchema.safeParse({
      role: "SUPER_ADMIN",
      permissions: ["ALL"],
    }).success).toBe(false)
    expect(userAccessUpdateSchema.safeParse({ role: "OWNER" }).success).toBe(false)
  })

  it("rejects creator, approval, price, total, and status manipulation on orders", () => {
    const validOrder = {
      organizationId: 10,
      branchId: 20,
      items: [{ organizationInventoryId: 30, quantity: 2 }],
      notes: "Needed",
    }

    for (const hiddenField of [
      "createdByUserId",
      "approvedByUserId",
      "priceCents",
      "totalCents",
      "paymentStatus",
      "deliveredAt",
      "refundAmountCents",
      "status",
    ]) {
      expect(orderCreateSchema.safeParse({
        ...validOrder,
        [hiddenField]: hiddenField.endsWith("Cents") ? 1 : "attacker",
      }).success).toBe(false)
    }
  })

  it("rejects server-maintained financial and approval fields", () => {
    expect(moneyBudgetUpdateSchema.safeParse({
      branchId: 20,
      amountAllocatedCents: 10_000,
      amountSpentCents: 0,
      approvedBy: "attacker",
    }).success).toBe(false)

    expect(adminRefundProcessSchema.safeParse({
      orderId: 1,
      items: [{ itemId: 2, quantity: 1 }],
      refundAmount: 1,
      status: "APPROVED",
      processedByUserId: "attacker",
    }).success).toBe(false)
  })

  it("rejects owner and price injection on scoped inventory operations", () => {
    expect(supplierCreateSchema.safeParse({
      organizationId: 10,
      branchId: 20,
      name: "Supplier",
      createdBy: "attacker",
      isActive: true,
    }).success).toBe(false)

    expect(organizationProductUpdateSchema.safeParse({
      organizationProductId: 1,
      isEnabled: true,
      updatedByUserId: "attacker",
      organizationId: 999,
    }).success).toBe(false)

    expect(branchProductUpdateSchema.safeParse({
      branchProductId: 1,
      isAvailable: true,
      branchId: 999,
    }).success).toBe(false)

    expect(globalProductUpdateSchema.safeParse({
      name: "Product",
      approvedBy: "attacker",
    }).success).toBe(false)
  })
})

describe("role and tenant administration policy", () => {
  it("prevents self-access changes", () => {
    expect(isSelfAccessChange("user-1", "user-1")).toBe(true)
    expect(isSelfAccessChange("user-1", "user-2")).toBe(false)
  })

  it("prevents peer, upward, and super-admin assignment", () => {
    expect(canAssignRole("HEAD_OFFICE", "BRANCH_ADMIN")).toBe(true)
    expect(canAssignRole("HEAD_OFFICE", "HEAD_OFFICE")).toBe(false)
    expect(canAssignRole("HEAD_OFFICE", "SUPER_ADMIN")).toBe(false)
    expect(canAssignRole("SUPER_ADMIN", "HEAD_OFFICE")).toBe(true)
    expect(canAssignRole("SUPER_ADMIN", "SUPER_ADMIN")).toBe(false)

    expect(canManageUser("HEAD_OFFICE", "BRANCH_ADMIN")).toBe(true)
    expect(canManageUser("HEAD_OFFICE", "HEAD_OFFICE")).toBe(false)
  })

  it("prevents lower-level tenant reassignment", () => {
    expect(canUseOrganization("HEAD_OFFICE", 10, 10)).toBe(true)
    expect(canUseOrganization("HEAD_OFFICE", 10, 11)).toBe(false)
    expect(canUseOrganization("SUPER_ADMIN", null, 11)).toBe(true)
  })
})

describe("request-to-database assignment guard", () => {
  it("contains no direct request-object writes or request-object spreads", () => {
    const files = routeFiles(resolve(process.cwd(), "app/api"))
    const forbidden = [
      /[.]set[(](?:body|input|data|requestBody)[)]/,
      /[.]values[(](?:body|input|data|requestBody)[)]/,
      /Object[.]assign[(]/,
      /[.][.][.](?:body|input|requestBody)\b/,
    ]

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      for (const pattern of forbidden) {
        expect(source, `${file} matched ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it("does not expose a generic order status PATCH operation", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/api/v1/orders/[id]/route.ts"),
      "utf8",
    )
    expect(source).not.toMatch(/export async function PATCH/)
  })
})

