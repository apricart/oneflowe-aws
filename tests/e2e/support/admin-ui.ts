import { expect, type Locator, type Page } from "@playwright/test"

import { expectStatus, patch } from "./session"

/**
 * Screens several specs pass through on the way to the thing they test.
 */

export interface CompanyRef {
  organizationId: number
  organizationName: string
}

/**
 * Open a company's Edit Company dialog from `/organizations`, as Super Admin.
 *
 * The company list is cached server-side for a minute, keyed by role, so a
 * company a spec seeded straight into the database after another spec's Super
 * Admin loaded the list is not in it yet. Any company edit clears that cache;
 * a no-op one (`status` set to what it already is) does so without changing
 * anything a spec asserts on.
 */
export async function openEditCompany(page: Page, company: CompanyRef): Promise<Locator> {
  const { organizationId, organizationName } = company
  await expectStatus(await patch(page, `/api/v1/organizations/${organizationId}`, { status: "active" }))
  await page.goto("/organizations")
  await page.getByPlaceholder("Search companies...").fill(organizationName)
  await page
    .locator("article")
    .filter({ hasText: organizationName })
    .getByRole("button", { name: "Edit", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Edit Company" })
  await expect(dialog).toBeVisible()
  // Every switch in the dialog stays disabled until its settings read returns,
  // which on a cold development server waits for that route to compile.
  await expect(dialog.getByRole("switch", { name: "Require order approval" })).toBeEnabled({ timeout: 120_000 })
  return dialog
}

/** Set one switch in Edit Company and save. */
export async function setCompanySwitch(
  page: Page,
  company: CompanyRef,
  label: string,
  on: boolean,
): Promise<void> {
  const dialog = await openEditCompany(page, company)
  const toggle = dialog.getByRole("switch", { name: label })
  if ((await toggle.getAttribute("data-state")) !== (on ? "checked" : "unchecked")) {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute("data-state", on ? "checked" : "unchecked")
  await dialog.getByRole("button", { name: "Save Changes" }).click()
  await expect(dialog).toBeHidden({ timeout: 150_000 })
}

/**
 * Put one product in the Order Portal cart and open the confirmation step.
 *
 * The cart survives a reload, so after an attempt the store refused, the
 * product is still in it and its card shows a quantity stepper instead of the
 * add button. Either way the cart ends up holding it.
 */
export async function openShopCheckout(page: Page): Promise<Locator> {
  const add = page.getByRole("button", { name: /Add .* to Cart/ }).first()
  const inCart = page.getByRole("button", { name: "Open Cart" })
  await expect(add.or(inCart).first()).toBeVisible({ timeout: 120_000 })
  if (await add.isVisible()) await add.click()
  await page.getByRole("button", { name: "Open Cart" }).click()
  await page.getByRole("button", { name: /Proceed to checkout/ }).click()
  const checkout = page.getByRole("dialog", { name: "Order Confirmation" })
  await expect(checkout).toBeVisible()
  return checkout
}

/**
 * Go to a page through its sidebar entry.
 *
 * The entry must be offered — that is what the journey proves — but the move
 * itself loads the entry's address rather than clicking it: on a development
 * server still compiling the route, a client-side navigation can be swallowed
 * while the shell re-renders, which tests the dev server rather than the app.
 */
export async function openFromSidebar(page: Page, name: string): Promise<void> {
  const entry = page.getByRole("link", { name, exact: true }).first()
  await expect(entry).toBeAttached({ timeout: 150_000 })
  const href = await entry.getAttribute("href")
  if (!href) throw new Error(`Sidebar entry "${name}" has no address`)
  await page.goto(href)
}
