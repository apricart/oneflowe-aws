import { expect, test, type APIResponse, type Page } from "@playwright/test"

import { E2E_BASE_URL, E2E_PASSWORD } from "./support/environment"
import {
  SMOKE_BRANCH_NAME,
  SMOKE_GROUP_NAME,
  SMOKE_USERNAMES,
} from "./support/role-smoke-seed"

/**
 * Changing a user's role, through the browser.
 *
 * The unit and integration suites prove the rule and the SQL. This proves the
 * three things only a real browser against a real server can: that the guard
 * actually stops an administrator in the UI, that the switch can actually be
 * performed from the users screen, and that the person then lands in the portal
 * for their **new** role — which needs the session destroyed, the role re-read
 * and `proxy.ts` routing on it, none of which a route-level test exercises
 * together.
 *
 * Seed state this relies on (`role-smoke-seed.ts`): the Order Portal user has an
 * APPROVED, unfulfilled order, and the Branch Admin and Group User have none.
 *
 * This file changes the roles of two seeded users and does not put them back. It
 * sorts last of the E2E specs, so nothing else in a run depends on those roles
 * afterwards, and the seed upserts `role_id` on every run, so the next run starts
 * from the same state. Both facts are load-bearing — a spec added after this one
 * alphabetically must not assume the seeded roles.
 */

type JsonBody = Record<string, any>

async function responseJson(response: APIResponse): Promise<JsonBody> {
  const text = await response.text()
  try {
    return JSON.parse(text) as JsonBody
  } catch {
    return { unparsedResponse: text }
  }
}

async function signIn(page: Page, username: string, landingPath: RegExp): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  // A cold development server may reload while compiling the first workspace,
  // so poll the URL rather than attaching to one navigation.
  await expect(page).toHaveURL(landingPath, { timeout: 150_000 })
}

async function signOut(page: Page): Promise<void> {
  const csrf = await responseJson(await page.request.get(`${E2E_BASE_URL}/api/auth/csrf`))
  await page.request.post(`${E2E_BASE_URL}/api/auth/signout`, {
    form: { csrfToken: csrf.csrfToken, callbackUrl: `${E2E_BASE_URL}/login` },
    headers: { "X-Auth-Return-Redirect": "1" },
  })
  await page.context().clearCookies()
}

/** The role a signed-in session reports for itself. */
async function sessionRole(page: Page): Promise<string> {
  const session = await responseJson(await page.request.get(`${E2E_BASE_URL}/api/auth/session`))
  return String(session.user?.role ?? "")
}

function editDialog(page: Page) {
  return page.getByRole("dialog").filter({ hasText: "Edit User" })
}

/**
 * Open the edit dialog for one user from the users screen.
 *
 * Clicking the row opens the detail sheet; "Edit Profile" in its footer opens the
 * edit dialog. There is no direct row-to-edit control.
 */
async function openEditDialog(page: Page, username: string): Promise<void> {
  await page.goto("/users")
  await page.getByPlaceholder("Search users by name or email...").fill(username)
  const row = page.locator("tr", { hasText: username }).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.click()
  await page.getByRole("button", { name: /edit profile/i }).click()
  await expect(editDialog(page)).toBeVisible({ timeout: 30_000 })
}

async function chooseRole(page: Page, label: RegExp): Promise<void> {
  await editDialog(page).getByLabel("Role *").click()
  await page.getByRole("option", { name: label }).click()
}

async function saveDialog(page: Page): Promise<void> {
  await editDialog(page).getByRole("button", { name: /save changes/i }).click()
  await expect(editDialog(page)).toBeHidden({ timeout: 60_000 })
}

test.describe("changing a user's role", () => {
  test("the lifecycle guard stops the switch while an order is still in flight", async ({ page }) => {
    // The seeded Order Portal user has an APPROVED, unfulfilled order — money
    // still held against their branch's budget.
    await signIn(page, SMOKE_USERNAMES.headOffice, /\/dashboard/)
    await openEditDialog(page, SMOKE_USERNAMES.orderPortal)

    const role = editDialog(page).getByLabel("Role *")
    await expect(role).toBeVisible()
    // The readiness check is a network round trip, and on a cold development
    // server this is the first request to that route, so wait it out rather than
    // reading the select while it is still "Checking...".
    await expect(
      editDialog(page).getByText(/checking whether this role can be changed/i),
    ).toBeHidden({ timeout: 150_000 })
    // Refused in the UI, and the server refuses it again on submit — the select
    // is a courtesy, never the control.
    await expect(role).toBeDisabled()
    await expect(
      editDialog(page).getByText(/order\(s\) still in progress/i),
    ).toBeVisible()
    await expect(
      editDialog(page).getByText(/approved but not yet fulfilled/i),
    ).toBeVisible()
  })

  test("a clean Branch Admin becomes an Order Portal user and lands in the store", async ({ page }) => {
    const target = SMOKE_USERNAMES.branchAdmin

    await signIn(page, SMOKE_USERNAMES.headOffice, /\/dashboard/)
    await openEditDialog(page, target)

    // Enabled, which is itself the feature: this control used to carry a bare
    // `disabled` attribute and no role could be changed at all. Gated on the
    // readiness request, so allow for a cold compile.
    await expect(editDialog(page).getByLabel("Role *")).toBeEnabled({ timeout: 150_000 })
    await chooseRole(page, /^Order Portal User$/)
    await expect(
      editDialog(page).getByText(/signs this user out of every device/i),
    ).toBeVisible()
    await saveDialog(page)
    await signOut(page)

    // They now land in the employee store. This only works if the switch
    // destroyed their session and `proxy.ts` re-read the new role.
    await signIn(page, target, /\/shop/)
    expect(await sessionRole(page)).toBe("ORDER_PORTAL")

    // And the admin dashboard is no longer theirs to open.
    await page.goto("/dashboard")
    await expect(page).toHaveURL(/\/shop/, { timeout: 60_000 })
    await signOut(page)

    // Now the other direction across shapes: into a group role, which cannot be
    // saved until a group or branch is assigned.
    await signIn(page, SMOKE_USERNAMES.headOffice, /\/dashboard/)
    await openEditDialog(page, target)
    await chooseRole(page, /^Group Order Portal User$/)

    await expect(
      editDialog(page).getByText(/at least one group or one branch/i),
    ).toBeVisible()

    await editDialog(page).getByLabel("Groups").click()
    await page.getByRole("option", { name: new RegExp(SMOKE_GROUP_NAME, "i") }).click()
    await page.keyboard.press("Escape")
    await expect(
      editDialog(page).getByText(/at least one group or one branch/i),
    ).toBeHidden()
    await saveDialog(page)
    await signOut(page)

    // The group portal is a third workspace, distinct from /shop and /dashboard.
    await signIn(page, target, /\/group-portal/)
    expect(await sessionRole(page)).toBe("GROUP_ORDER_PORTAL")
  })

  test("a Group User moving to a single-branch role must be given a branch", async ({ page }) => {
    const target = SMOKE_USERNAMES.groupUser

    await signIn(page, SMOKE_USERNAMES.headOffice, /\/dashboard/)
    await openEditDialog(page, target)

    await expect(editDialog(page).getByLabel("Role *")).toBeEnabled({ timeout: 150_000 })
    await chooseRole(page, /^Branch Admin$/)
    // A group-based user carries no branch, so moving to a pinned role has to
    // collect one. The dialog says so rather than letting the server refuse it.
    await expect(editDialog(page).getByText(/branch is required for this role/i))
      .toBeVisible({ timeout: 30_000 })

    await editDialog(page).getByLabel("Branch Assignment *").click()
    await page.getByRole("option", { name: new RegExp(SMOKE_BRANCH_NAME, "i") }).click()
    await saveDialog(page)
    await signOut(page)

    await signIn(page, target, /\/dashboard/)
    expect(await sessionRole(page)).toBe("BRANCH_ADMIN")
  })
})
