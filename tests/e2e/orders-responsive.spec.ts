import { expect, test } from "@playwright/test"

import { login } from "./support/auth"
import { E2E_USERS } from "./support/fixtures"

test("Orders stays within a standard desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await login(page, E2E_USERS.superAdmin, "/dashboard")
  await page.goto("/orders")

  await expect(
    page.getByRole("heading", { name: "Order Intelligence" }),
  ).toBeVisible()

  const exportButton = page.getByRole("button", { name: "Export" })
  await expect(exportButton).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0)

  const exportBounds = await exportButton.boundingBox()
  expect(exportBounds).not.toBeNull()
  expect(exportBounds!.x + exportBounds!.width).toBeLessThanOrEqual(1280)
})
