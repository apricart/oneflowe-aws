import { randomUUID } from "node:crypto"

import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"

import { E2E_BASE_URL, E2E_PASSWORD } from "./support/environment"
import {
  SMOKE_GROUP_NAME,
  SMOKE_PRODUCT_CODE,
  SMOKE_USERNAMES,
} from "./support/role-smoke-seed"
import { closeRoleRenameNoticeWhenShown, getReconnecting, markDelivered } from "./support/session"

type JsonBody = Record<string, any>

async function responseJson(response: APIResponse): Promise<JsonBody> {
  const text = await response.text()
  try {
    return JSON.parse(text) as JsonBody
  } catch {
    return { unparsedResponse: text }
  }
}

async function expectJsonStatus(response: APIResponse, status = 200): Promise<JsonBody> {
  const body = await responseJson(response)
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(status)
  return body
}

async function signIn(page: Page, username: string, landingPath: RegExp): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD)
  await closeRoleRenameNoticeWhenShown(page)
  await page.getByRole("button", { name: /sign in/i }).click()
  // A cold Next development server may reload while compiling the first role
  // workspace. Poll the browser's current URL instead of attaching to one
  // particular navigation event, which can be replaced by that reload.
  await expect(page).toHaveURL(landingPath, { timeout: 150_000 })
}

async function authenticatedContext(
  browser: Browser,
  username: string,
  landingPath: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: E2E_BASE_URL })
  // The role cases above exercise the login form itself. This multi-context
  // workflow authenticates through NextAuth directly so React hydration on a
  // freshly compiled login page cannot clear one field between two fills.
  const csrf = await expectJsonStatus(
    await context.request.get(`${E2E_BASE_URL}/api/auth/csrf`),
  )
  const callback = await context.request.post(
    `${E2E_BASE_URL}/api/auth/callback/credentials`,
    {
      form: {
        csrfToken: csrf.csrfToken,
        username,
        password: E2E_PASSWORD,
        callbackUrl: `${E2E_BASE_URL}${landingPath}`,
      },
      headers: { "X-Auth-Return-Redirect": "1" },
      maxRedirects: 0,
    },
  )
  expect([200, 302], `${callback.status()} ${callback.url()}`).toContain(
    callback.status(),
  )
  const session = await expectJsonStatus(
    await context.request.get(`${E2E_BASE_URL}/api/auth/session`),
  )
  expect(session.user?.id).toBeTruthy()

  const page = await context.newPage()
  return { context, page }
}

async function expectSessionRole(page: Page, role: string): Promise<void> {
  const body = await expectJsonStatus(await getReconnecting(page, "/api/auth/session"))
  expect(body.user?.role).toBe(role)
}

async function mutation(
  page: Page,
  path: string,
  data: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<APIResponse> {
  return page.request.post(path, {
    data,
    headers: {
      Origin: E2E_BASE_URL,
      "Sec-Fetch-Site": "same-origin",
      ...extraHeaders,
    },
  })
}

test.describe("role deployment smoke checks", () => {
  const roleCases = [
    {
      name: "Super Admin",
      username: SMOKE_USERNAMES.superAdmin,
      role: "SUPER_ADMIN",
      landing: /\/dashboard$/,
      probe: "/api/v1/organizations?limit=1",
    },
    {
      name: "Head Office",
      username: SMOKE_USERNAMES.headOffice,
      role: "HEAD_OFFICE",
      landing: /\/dashboard$/,
      probe: "/api/v1/branches?limit=1",
    },
    {
      name: "Financial Approver",
      username: SMOKE_USERNAMES.branchAdmin,
      role: "BRANCH_ADMIN",
      landing: /\/dashboard$/,
      probe: "/api/v1/orders?limit=1",
    },
    {
      name: "Order Initiator",
      username: SMOKE_USERNAMES.orderPortal,
      role: "ORDER_PORTAL",
      landing: /\/shop$/,
      probe: `/api/v1/branch/inventory?limit=10&search=${SMOKE_PRODUCT_CODE}`,
      heading: "Order Initiator Portal",
    },
    {
      name: "Group Order Initiator",
      username: SMOKE_USERNAMES.groupOrderPortal,
      role: "GROUP_ORDER_PORTAL",
      landing: /\/group-portal$/,
      probe: "/api/v1/group-portal/groups",
      heading: "Group Order Initiator Portal",
    },
    {
      name: "Group Financial Approver",
      username: SMOKE_USERNAMES.groupUser,
      role: "GROUP_USER",
      landing: /\/dashboard$/,
      probe: "/api/v1/group-portal/approvals?limit=1",
    },
    {
      name: "Employee",
      username: SMOKE_USERNAMES.employee,
      role: "EMPLOYEE",
      landing: /\/shop$/,
      probe: `/api/v1/branch/inventory?limit=10&search=${SMOKE_PRODUCT_CODE}`,
      heading: "Order Initiator Portal",
    },
  ] as const

  for (const roleCase of roleCases) {
    test(`${roleCase.name} signs in and can read its primary workspace`, async ({ page }) => {
      await signIn(page, roleCase.username, roleCase.landing)
      await expectSessionRole(page, roleCase.role)

      if ("heading" in roleCase) {
        await expect(page.getByRole("heading", { name: roleCase.heading })).toBeVisible()
      }

      const body = await expectJsonStatus(await getReconnecting(page, roleCase.probe))
      if (roleCase.role === "GROUP_ORDER_PORTAL") {
        expect(body.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: SMOKE_GROUP_NAME }),
        ]))
      }
      if (roleCase.role === "ORDER_PORTAL" || roleCase.role === "EMPLOYEE") {
        expect(body.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ productCode: SMOKE_PRODUCT_CODE }),
        ]))
      }
    })
  }

  test("Group User resolves only its assigned scope and approval capability", async ({ page }) => {
    await signIn(page, SMOKE_USERNAMES.groupUser, /\/dashboard$/)

    const body = await expectJsonStatus(await getReconnecting(page, "/api/v1/group-portal/scope"))
    expect(body.item).toEqual(expect.objectContaining({
      role: "GROUP_USER",
      canApproveOrders: true,
    }))
    expect(body.item.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: SMOKE_GROUP_NAME }),
    ]))
    expect(body.item.branches).toHaveLength(1)
  })
})

test("an order can be created, approved, and fulfilled only by the correct roles", async ({ browser }) => {
  // This API-focused RBAC journey compiles several routes on a cold Next dev
  // server. Keep its budget independent from the shorter UI role checks.
  test.setTimeout(300_000)

  const requester = await authenticatedContext(
    browser,
    SMOKE_USERNAMES.orderPortal,
    "/shop",
  )
  const approver = await authenticatedContext(
    browser,
    SMOKE_USERNAMES.branchAdmin,
    "/dashboard",
  )
  const fulfiller = await authenticatedContext(
    browser,
    SMOKE_USERNAMES.superAdmin,
    "/dashboard",
  )

  try {
    const inventory = await expectJsonStatus(
      await getReconnecting(
        requester.page,
        `/api/v1/branch/inventory?limit=10&search=${SMOKE_PRODUCT_CODE}`,
      ),
    )
    const product = inventory.items.find(
      (item: JsonBody) => item.productCode === SMOKE_PRODUCT_CODE,
    )
    expect(product, "The smoke product must be visible to the requester").toBeTruthy()

    const createBody = await expectJsonStatus(
      await mutation(
        requester.page,
        "/api/v1/orders",
        {
          items: [{ organizationInventoryId: product.organizationInventoryId, quantity: 1 }],
          notes: "Playwright deployment smoke order",
        },
        { "Idempotency-Key": `smoke-${randomUUID()}` },
      ),
    )
    const orderId = Number(createBody.order?.id)
    expect(Number.isSafeInteger(orderId) && orderId > 0).toBe(true)
    expect(createBody.order?.status).toBe("PENDING")

    // The requester owns creation, not approval.
    await expectJsonStatus(
      await mutation(requester.page, `/api/v1/orders/${orderId}/approve`, {}),
      403,
    )

    const approverView = await expectJsonStatus(
      await getReconnecting(approver.page, `/api/v1/orders?id=${orderId}`),
    )
    expect(approverView.items).toEqual([
      expect.objectContaining({ id: orderId, status: "PENDING" }),
    ])

    const approvalBody = await expectJsonStatus(
      await mutation(approver.page, `/api/v1/orders/${orderId}/approve`, {}),
    )
    expect(approvalBody.approvalToken).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)

    // Approval does not grant the approver the Super Admin fulfillment power.
    await expectJsonStatus(
      await mutation(approver.page, `/api/v1/orders/${orderId}/fulfill`, {
        approvalToken: approvalBody.approvalToken,
      }),
      403,
    )

    // Not even Super Admin fulfils goods that have not been delivered.
    await expectJsonStatus(
      await mutation(fulfiller.page, `/api/v1/orders/${orderId}/fulfill`, {
        approvalToken: approvalBody.approvalToken,
      }),
      409,
    )

    // Super Admin may not mark it delivered without a delivery challan.
    await markDelivered(fulfiller.page, orderId)

    await expectJsonStatus(
      await mutation(fulfiller.page, `/api/v1/orders/${orderId}/fulfill`, {
        approvalToken: approvalBody.approvalToken,
      }),
    )

    const requesterView = await expectJsonStatus(
      await getReconnecting(requester.page, `/api/v1/orders?id=${orderId}`),
    )
    expect(requesterView.items).toEqual([
      expect.objectContaining({ id: orderId, status: "FULFILLED" }),
    ])
  } finally {
    await Promise.all([
      requester.context.close(),
      approver.context.close(),
      fulfiller.context.close(),
    ])
  }
})
