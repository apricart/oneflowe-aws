import { expect, test } from "@playwright/test"

import { login } from "./support/auth"
import {
  E2E_BRANCH,
  E2E_ORGANIZATION,
  E2E_USERS,
} from "./support/fixtures"

test("Super Admin can retrieve the complete branch workbook data", async ({ page }) => {
  await login(page, E2E_USERS.superAdmin, "/dashboard")

  const branchesResponse = await page.request.get("/api/v1/branches")
  expect(branchesResponse.ok()).toBeTruthy()
  const branchesPayload = await branchesResponse.json()
  const branch = branchesPayload.items.find((item: { code?: string }) => item.code === E2E_BRANCH.code)
  expect(branch).toBeTruthy()

  const exportResponse = await page.request.get(`/api/v1/branches/${branch.id}/export`)
  expect(exportResponse.ok()).toBeTruthy()

  const exportPayload = await exportResponse.json()
  expect(exportPayload.item.branchName).toBe(E2E_BRANCH.name)
  expect(exportPayload.item.sheets.map((sheet: { name: string }) => sheet.name)).toEqual([
    "Branch Details",
    "Users",
    "Portal Accounts",
    "Orders",
    "Order Items",
    "Refunds",
    "Refund Items",
    "Inventory",
    "Money Budgets",
    "Budget Add-ons",
    "Quantity Budgets",
    "Quantity Allocations",
    "Suppliers",
    "Activity",
  ])

  const profile = exportPayload.item.sheets.find(
    (sheet: { name: string }) => sheet.name === "Branch Details",
  )
  expect(profile.rows).toContainEqual({ Field: "Branch Name", Value: E2E_BRANCH.name })
})

test("branch rows show the Excel export action", async ({ page }) => {
  await login(page, E2E_USERS.superAdmin, "/dashboard")
  await page.goto("/organizations")

  await page.getByPlaceholder("Search companies...").fill(E2E_ORGANIZATION.code)
  await page.getByText(E2E_ORGANIZATION.name, { exact: true }).click()

  const branchRow = page.locator("tr", { hasText: E2E_BRANCH.name })
  await expect(
    branchRow.getByRole("button", {
      name: `Export ${E2E_BRANCH.name} complete details to Excel`,
    }),
  ).toBeVisible()
})
