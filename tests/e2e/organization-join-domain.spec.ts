import { expect, test, type Browser, type Page } from "@playwright/test"

import { E2E_PASSWORD } from "./support/environment"
import {
  CLOSED_ORGANIZATION,
  CONFIG_ORGANIZATION,
  CREATED_ORGANIZATION,
  JOIN_DOMAIN_SUPER_ADMIN_USERNAME,
  OPEN_ORGANIZATION,
  destroyJoinDomainE2E,
  readJoinRequestEmail,
  readOrganizationEmailDomain,
  removeCreatedOrganization,
  seedJoinDomainE2E,
  setOrganizationEmailDomain,
} from "./support/join-domain-seed"
import { closeRoleRenameNoticeWhenShown } from "./support/session"

/**
 * The organization's email domain, in a real browser.
 *
 * What only a browser can prove: that an applicant who follows the login page's
 * link is stopped at a prompt when the organization has no domain; that the form
 * really does fix the domain and send the composed address; and that a domain
 * Super Admin types into Create or Edit Company is the one the join page then
 * uses. The normalisation, the refusals and the tenant resolution themselves are
 * covered by `tests/integration/organization-email-domain.test.ts`.
 */

const DOMAIN_NOT_SET_MESSAGE =
  "Your organization's email domain is not set, so you cannot join yet. Please contact your organization."

/**
 * The seed's own database. Read directly rather than through
 * `resolveTestDatabaseUrl`, whose guard against `DATABASE_URL` naming the same
 * database is for the server and would trip in a worker that inherited global
 * setup's environment.
 */
function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim() ?? ""
  if (!url || !/test/i.test(new URL(url).pathname)) {
    throw new Error("TEST_DATABASE_URL must name a disposable test database")
  }
  return url
}

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD)
  await closeRoleRenameNoticeWhenShown(page)
  await page.getByRole("button", { name: /sign in/i }).click()
  // Leaving /login is the proof of sign-in. Waiting for the landing page's full
  // `load` as well would time out while the dev server compiles the dashboard
  // cold, which is not what this helper is checking.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    waitUntil: "commit",
    timeout: 120_000,
  })
}

/**
 * Open the join page and let it hydrate before anything is typed. On the dev
 * server a click that lands before hydration submits the code form natively (a
 * `GET /join?` reload) instead of through the page's handler.
 */
async function openJoinPage(page: Page): Promise<void> {
  await page.goto("/join")
  await page.waitForLoadState("networkidle")
}

async function enterJoinCode(page: Page, code: string): Promise<void> {
  await page.getByLabel("Organization join code").fill(code)
  await page.getByRole("button", { name: "Continue" }).click()
}

/**
 * An applicant with no session, in a browser context of their own that exists
 * only for `check`. Short-lived on purpose: a page left open while the dev
 * server compiles the admin portal for another context is hot-reloaded under
 * the test, losing whatever step it was on.
 */
async function asApplicant(browser: Browser, check: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await openJoinPage(page)
    await check(page)
  } finally {
    await context.close()
  }
}

/** Every required field except the email, which each journey types itself. */
async function fillApplicantDetails(page: Page, username: string, branchName: string): Promise<void> {
  await page.getByLabel(/^First name/).fill("E2E")
  await page.getByLabel(/^Last name/).fill("Applicant")
  await page.getByLabel(/^Username/).fill(username)
  await page.getByLabel(/^Password/).fill("Join-Flow-2026!x")
  await page.getByLabel(/^Confirm password/).fill("Join-Flow-2026!x")
  // Exact, or it also matches "Group Order Portal User".
  await page.getByRole("button", { name: "Order Initiator", exact: true }).click()
  await page.getByLabel(/^Branch/).selectOption({ label: branchName })
}

async function openEditCompany(page: Page, organizationName: string) {
  await page.goto("/organizations")
  await page.getByPlaceholder("Search companies...").fill(organizationName)
  await page
    .locator("article")
    .filter({ hasText: organizationName })
    .getByRole("button", { name: "Edit", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Edit Company" })
  await expect(dialog).toBeVisible()
  return dialog
}

test.describe("joining is locked to the organization's email domain", () => {
  // Seeded here rather than in global setup. After a failure Playwright
  // replaces the worker, running `afterAll` in the old one and `beforeAll` in
  // the new one, so the rows the later journeys need are always put back.
  test.beforeAll(async () => {
    await seedJoinDomainE2E(testDatabaseUrl())
  })

  test.afterAll(async () => {
    await destroyJoinDomainE2E(testDatabaseUrl())
  })

  test("an organization with no domain stops the applicant at a prompt", async ({ page }) => {
    await setOrganizationEmailDomain(testDatabaseUrl(), CLOSED_ORGANIZATION.name, null)

    // Through the login page, because the link being there is part of the path.
    await page.goto("/login")
    await page.getByRole("link", { name: "Join an organization" }).click()
    // The dev server compiles /join on first request, which alone can take
    // longer than the default expect timeout.
    await page.waitForURL(/\/join$/, { timeout: 60_000 })

    await enterJoinCode(page, CLOSED_ORGANIZATION.joinCode)

    const prompt = page.getByRole("alertdialog")
    await expect(prompt).toBeVisible()
    await expect(prompt.getByText("Email domain not set")).toBeVisible()
    await expect(prompt.getByText(DOMAIN_NOT_SET_MESSAGE)).toBeVisible()
    await expect(prompt.getByText(CLOSED_ORGANIZATION.name)).toBeVisible()

    // The form never mounts.
    await expect(page.getByLabel(/^Work email/)).toHaveCount(0)

    await prompt.getByRole("button", { name: "OK" }).click()
    await expect(prompt).toBeHidden()
    await expect(page.getByLabel("Organization join code")).toBeVisible()
    await expect(page.getByLabel(/^Work email/)).toHaveCount(0)
  })

  test("the form fixes the domain, refuses an @, and stores the composed address", async ({ page }) => {
    const username = "e2e-join-domain-applicant"

    await openJoinPage(page)
    await enterJoinCode(page, OPEN_ORGANIZATION.joinCode)

    await expect(page.getByText(`@${OPEN_ORGANIZATION.emailDomain}`, { exact: true })).toBeVisible()
    await expect(page.getByRole("alertdialog")).toHaveCount(0)

    await fillApplicantDetails(page, username, OPEN_ORGANIZATION.branchName)

    // A whole address from somewhere else is refused, not quietly rewritten.
    const email = page.getByLabel(/^Work email/)
    await email.fill("e2e.applicant@gmail.com")
    await page.getByRole("button", { name: "Send request" }).click()
    await expect(page.getByText(/only the part before the @/i)).toBeVisible()
    await expect(page.getByRole("heading", { name: "Request sent" })).toHaveCount(0)

    await email.fill("E2E.Applicant")
    await page.getByRole("button", { name: "Send request" }).click()
    await expect(page.getByRole("heading", { name: "Request sent" })).toBeVisible()

    expect(await readJoinRequestEmail(testDatabaseUrl(), OPEN_ORGANIZATION.name, username))
      .toBe(`e2e.applicant@${OPEN_ORGANIZATION.emailDomain}`)
  })

  test("a domain Super Admin sets in Edit Company opens the join form", async ({ page, browser }) => {
    // The first journey to sign in compiles the whole admin portal on the dev
    // server, which alone can take minutes.
    test.slow()
    await setOrganizationEmailDomain(testDatabaseUrl(), CONFIG_ORGANIZATION.name, null)

    try {
      // Before: an applicant holding the code is stopped at the prompt.
      await asApplicant(browser, async (applicant) => {
        await enterJoinCode(applicant, CONFIG_ORGANIZATION.joinCode)
        await expect(applicant.getByRole("alertdialog")).toBeVisible()
        await expect(applicant.getByLabel(/^Work email/)).toHaveCount(0)
      })

      // Super Admin sets the domain, typed the way a person might.
      await signIn(page, JOIN_DOMAIN_SUPER_ADMIN_USERNAME)
      const dialog = await openEditCompany(page, CONFIG_ORGANIZATION.name)
      const domainField = dialog.getByLabel("Email domain (optional)")
      await expect(domainField).toHaveValue("")

      // A malformed domain cannot be saved.
      await domainField.fill("not a domain")
      await expect(dialog.getByText(/domain such as example\.com/)).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Save Changes" })).toBeDisabled()

      await domainField.fill(" @E2E-Config.Example.TEST ")
      await dialog.getByRole("button", { name: "Save Changes" }).click()
      await expect(dialog).toBeHidden()

      expect(await readOrganizationEmailDomain(testDatabaseUrl(), CONFIG_ORGANIZATION.name))
        .toBe("e2e-config.example.test")

      // Reopening shows what was stored.
      const reopened = await openEditCompany(page, CONFIG_ORGANIZATION.name)
      await expect(reopened.getByLabel("Email domain (optional)")).toHaveValue("e2e-config.example.test")
      await page.keyboard.press("Escape")

      // After: the same code now opens the form, with the new domain fixed on it.
      await asApplicant(browser, async (applicant) => {
        await enterJoinCode(applicant, CONFIG_ORGANIZATION.joinCode)
        await expect(applicant.getByText("@e2e-config.example.test", { exact: true })).toBeVisible()
        await expect(applicant.getByLabel(/^Work email/)).toBeVisible()
        await expect(applicant.getByRole("alertdialog")).toHaveCount(0)
      })
    } finally {
      await setOrganizationEmailDomain(testDatabaseUrl(), CONFIG_ORGANIZATION.name, null)
    }
  })

  test("Create Company stores the domain it is given", async ({ page }) => {
    test.slow()
    await removeCreatedOrganization(testDatabaseUrl())

    await signIn(page, JOIN_DOMAIN_SUPER_ADMIN_USERNAME)
    await page.goto("/organizations")
    await page.getByRole("button", { name: "Create Company" }).click()

    const dialog = page.getByRole("dialog", { name: "Create Company" })
    await dialog.getByLabel("Company name").fill(CREATED_ORGANIZATION.name)
    await dialog.getByLabel("Code", { exact: true }).fill(CREATED_ORGANIZATION.code)
    await dialog.getByLabel("Email domain (optional)").fill("@E2E-Created.Example.TEST")
    await dialog.getByRole("button", { name: "Save Company" }).click()

    // The budget-model confirmation that Create Company always asks for.
    const confirm = page.getByRole("alertdialog")
    await confirm.getByRole("button", { name: "Create Company" }).click()
    await expect(page.getByText("Company created successfully.")).toBeVisible()

    expect(await readOrganizationEmailDomain(testDatabaseUrl(), CREATED_ORGANIZATION.name))
      .toBe("e2e-created.example.test")

    await removeCreatedOrganization(testDatabaseUrl())
  })
})
