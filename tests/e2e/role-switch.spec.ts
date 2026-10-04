import { expect, test, type Page } from "@playwright/test"

import {
  SMOKE_BRANCH_NAME,
  SMOKE_GROUP_NAME,
  SMOKE_PRODUCT_CODE,
  SMOKE_USERNAMES,
} from "./support/role-smoke-seed"
import {
  apiSession,
  approveOrder,
  expectStatus,
  fulfilOrder,
  markDelivered,
  placeOrder,
  sessionRole,
  signIn,
  signOut,
} from "./support/session"

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
 * Seed state this relies on (`role-smoke-seed.ts`): the Branch Admin and Group
 * User have no order in flight. The first test raises and approves an order for
 * the Order Portal user itself, and settles it again before it ends, because the
 * seed creates no orders and the smoke journey fulfils the one it raises.
 *
 * This file changes the roles of two seeded users and does not put them back. It
 * sorts last of the E2E specs, so nothing else in a run depends on those roles
 * afterwards, and the seed upserts `role_id` on every run, so the next run starts
 * from the same state. Both facts are load-bearing — a spec added after this one
 * alphabetically must not assume the seeded roles.
 */

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
  test("the lifecycle guard stops the switch while an order is still in flight", async ({ page, browser }) => {
    // An APPROVED, unfulfilled order — money still held against the branch's
    // budget — raised by the user whose role is about to be changed.
    const requester = await apiSession(browser, SMOKE_USERNAMES.orderPortal)
    const approver = await apiSession(browser, SMOKE_USERNAMES.branchAdmin)
    const superAdmin = await apiSession(browser, SMOKE_USERNAMES.superAdmin)
    let inFlight: { id: number; token: string } | null = null
    try {
      const inventory = await expectStatus(
        await requester.page.request.get(`/api/v1/branch/inventory?limit=10&search=${SMOKE_PRODUCT_CODE}`),
      )
      const product = inventory.items.find((item: { productCode: string }) => item.productCode === SMOKE_PRODUCT_CODE)
      const order = await placeOrder(requester.page, [{ organizationInventoryId: product.organizationInventoryId, quantity: 1 }])
      inFlight = { id: Number(order.id), token: await approveOrder(approver.page, Number(order.id)) }

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
    } finally {
      // Leave the shared smoke tenant as the seed made it: nothing in flight.
      if (inFlight) {
        await markDelivered(superAdmin.page, inFlight.id)
        await fulfilOrder(superAdmin.page, inFlight.id, inFlight.token)
      }
      await Promise.all([requester.close(), approver.close(), superAdmin.close()])
    }
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
