export const E2E_PASSWORD = "OneFloweE2E!2026"

export const E2E_USERS = {
  superAdmin: "e2e.superadmin",
  headOffice: "e2e.headoffice",
  branchAdmin: "e2e.branchadmin",
  orderPortal: "e2e.orderportal",
} as const

export const E2E_ORGANIZATION = {
  code: "E2E-ORG-A",
  name: "E2E Organization Alpha",
} as const

export const E2E_SECONDARY_ORGANIZATION = {
  code: "E2E-ORG-B",
  name: "E2E Organization Beta",
} as const

export const E2E_BRANCH = {
  code: "E2E-SHOP-A",
  name: "E2E Shop Branch",
} as const

export const E2E_ADMIN_BRANCH = {
  code: "E2E-ADMIN-A",
  name: "E2E Admin Branch",
} as const

export const E2E_SECONDARY_BRANCH = {
  code: "E2E-SHOP-B",
  name: "E2E Tenant B Branch",
} as const

export const E2E_PRODUCT = {
  code: "E2E-PRODUCT-1250",
  name: "E2E Coffee Beans",
  priceCents: 1_250,
  startingStock: 100,
} as const

export const E2E_SECONDARY_PRODUCT = {
  code: "E2E-TENANT-B-SECRET",
  name: "E2E Tenant B Secret Product",
  priceCents: 999,
  startingStock: 10,
} as const

export const E2E_BUDGET_CENTS = 100_000
