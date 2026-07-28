import { expect, test } from "@playwright/test"

import { login } from "./support/auth"
import { E2E_USERS } from "./support/fixtures"

test("protected pages redirect unauthenticated users to login", async ({ page }) => {
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/)

  await page.goto("/shop")
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/)
})

test("invalid credentials show a safe error", async ({ page }) => {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(E2E_USERS.orderPortal)
  await page.getByLabel("Password").fill("DefinitelyWrong!123")
  await page.getByRole("button", { name: "Sign In" }).click()

  await expect(page.getByText("Invalid credentials. Please check your username/email and password.")).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})

test("Super Admin reaches management pages", async ({ page }) => {
  await login(page, E2E_USERS.superAdmin, "/dashboard")
  await page.goto("/organizations")
  await expect(page).toHaveURL(/\/organizations$/)
})

test("Head Office is denied Super Admin organization management", async ({ page }) => {
  await login(page, E2E_USERS.headOffice, "/dashboard")
  await page.goto("/branches")
  await expect(page).toHaveURL(/\/branches$/)

  await page.goto("/organizations")
  await expect(page).toHaveURL(/\/login$/)
})

test("Branch Admin is redirected from branch management without losing the session", async ({ page }) => {
  await login(page, E2E_USERS.branchAdmin, "/dashboard")
  await page.goto("/branches")
  await expect(page).toHaveURL(/\/dashboard$/)

  const sessionResponse = await page.request.get("/api/auth/session")
  expect(sessionResponse.ok()).toBe(true)
  await expect(sessionResponse.json()).resolves.toMatchObject({
    user: { role: "BRANCH_ADMIN" },
  })
})

test("Branch Admin is denied user management by the page and API", async ({ page }) => {
  await login(page, E2E_USERS.branchAdmin, "/dashboard")

  await page.goto("/users")
  await expect(page).toHaveURL(/\/users$/)
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Create User" })).toHaveCount(0)

  const response = await page.request.get("/api/v1/users")
  expect(response.status()).toBe(403)
})

test("Order Portal is confined to the shop", async ({ page }) => {
  await login(page, E2E_USERS.orderPortal, "/shop")
  await expect(page.getByRole("heading", { name: "Order Portal" })).toBeVisible()

  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/shop$/)
})

test("a transient session network failure preserves the Create User form", async ({ page }) => {
  await login(page, E2E_USERS.superAdmin, "/dashboard")
  await page.goto("/users")

  await page.getByRole("button", { name: "Create User" }).click()
  const firstNameInput = page.getByLabel(/^First Name/)
  await firstNameInput.fill("Unsaved QA User")

  let sessionChecks = 0
  let signOutRequests = 0

  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/signout") {
      signOutRequests += 1
    }
  })

  await page.route("**/api/auth/session", async (route) => {
    sessionChecks += 1
    if (sessionChecks === 1) {
      await route.abort("internetdisconnected")
      return
    }
    await route.continue()
  })

  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"))
  })

  await expect.poll(() => sessionChecks).toBeGreaterThanOrEqual(2)
  await expect(page).toHaveURL(/\/users$/)
  await expect(firstNameInput).toHaveValue("Unsaved QA User")
  expect(signOutRequests).toBe(0)

  await page.getByRole("button", { name: "Cancel" }).click()
  await expect(
    page.getByRole("alertdialog", {
      name: "Discard unsaved user details?",
    }),
  ).toBeVisible()

  await page.getByRole("button", { name: "Keep editing" }).click()
  await expect(firstNameInput).toHaveValue("Unsaved QA User")

  await page.getByRole("button", { name: "Cancel" }).click()
  await page.getByRole("button", { name: "Discard changes" }).click()
  await expect(
    page.getByRole("heading", { name: "Create User" }),
  ).not.toBeVisible()
})
