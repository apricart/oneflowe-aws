import { expect, type Page } from "@playwright/test"

import { E2E_PASSWORD } from "./fixtures"

export async function login(
  page: Page,
  username: string,
  expectedPath: "/dashboard" | "/shop",
) {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password").fill(E2E_PASSWORD)
  await page.getByRole("button", { name: "Sign In" }).click()
  await page.waitForURL(
    new RegExp(`${expectedPath.replace("/", "\\/")}(?:\\?.*)?$`),
    { timeout: 60_000 },
  )
  await expect(page).toHaveURL(new RegExp(`${expectedPath.replace("/", "\\/")}(?:\\?.*)?$`))
}
