import { randomUUID } from "node:crypto"

import {
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"
import { Pool } from "pg"

import { E2E_BASE_URL, E2E_PASSWORD } from "./environment"

/**
 * Signing in, and calling the API as the signed-in person.
 *
 * Two ways in, for two purposes. `signIn` drives the login form, which is what
 * a journey that starts at the door should prove. `apiSession` authenticates
 * through NextAuth directly, for the supporting actors in a multi-role journey —
 * the approver, the Super Admin who marks a delivery — whose part is set-up, not
 * the thing under test.
 */

export type JsonBody = Record<string, any>

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim() ?? ""
  if (!url || !/test/i.test(new URL(url).pathname)) {
    throw new Error("TEST_DATABASE_URL must name a disposable test database")
  }
  return url
}

export async function responseJson(response: APIResponse): Promise<JsonBody> {
  const text = await response.text()
  try {
    return JSON.parse(text) as JsonBody
  } catch {
    return { unparsedResponse: text }
  }
}

export async function expectStatus(response: APIResponse, status = 200): Promise<JsonBody> {
  const body = await responseJson(response)
  expect(response.status(), `${response.url()} ${JSON.stringify(body, null, 2)}`).toBe(status)
  return body
}

const roleRenameNoticeHandled = new WeakSet<Page>()

/**
 * Closes the one-time "role names have changed" notice whenever it appears
 * (`components/shell/role-rename-notice.tsx`), the way a person would, so a
 * journey after sign-in is not blocked by the modal. Registered once per page,
 * before the sign-in that marks the notice due. The spec about the notice
 * itself does not call this.
 */
export async function closeRoleRenameNoticeWhenShown(page: Page): Promise<void> {
  if (roleRenameNoticeHandled.has(page)) return
  roleRenameNoticeHandled.add(page)
  const notice = page.getByRole("dialog", { name: "Some role names have changed" })
  await page.addLocatorHandler(notice, async () => {
    await notice.getByRole("button", { name: "Got it" }).click()
  })
}

export async function signIn(page: Page, username: string, landing?: RegExp): Promise<void> {
  await closeRoleRenameNoticeWhenShown(page)
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  // A cold development server may reload while compiling the first workspace,
  // so poll the URL rather than attaching to one navigation.
  if (landing) {
    await expect(page).toHaveURL(landing, { timeout: 150_000 })
  } else {
    await expect(page).not.toHaveURL(/\/login/, { timeout: 150_000 })
  }
}

/**
 * A GET through the page's request client, sent again once if the server reset
 * a reused connection.
 *
 * The request client keeps sockets alive between calls, and the dev server
 * closes an idle one after Node's default five-second `keepAliveTimeout` —
 * `next dev`, unlike `next start`, has no flag to raise it. A call that picks up
 * a pooled socket just as the server closes it fails with ECONNRESET before it
 * reaches the application: `sessionRole`, then a slow redirect, then `signOut`
 * is exactly that shape. Only idempotent GETs come through here, only a reset
 * is retried, and only once; every other failure still fails the test.
 */
export async function getReconnecting(page: Page, url: string): Promise<APIResponse> {
  try {
    return await page.request.get(url)
  } catch (error) {
    if (!(error instanceof Error && /ECONNRESET|socket hang up/i.test(error.message))) throw error
    return page.request.get(url)
  }
}

export async function signOut(page: Page): Promise<void> {
  const csrf = await responseJson(await getReconnecting(page, `${E2E_BASE_URL}/api/auth/csrf`))
  await page.request.post(`${E2E_BASE_URL}/api/auth/signout`, {
    form: { csrfToken: csrf.csrfToken, callbackUrl: `${E2E_BASE_URL}/login` },
    headers: { "X-Auth-Return-Redirect": "1" },
  })
  await page.context().clearCookies()
}

export async function sessionRole(page: Page): Promise<string> {
  const session = await responseJson(await getReconnecting(page, `${E2E_BASE_URL}/api/auth/session`))
  return String(session.user?.role ?? "")
}

export interface ApiSession {
  context: BrowserContext
  page: Page
  close: () => Promise<void>
}

export async function apiSession(
  browser: Browser,
  username: string,
  password = E2E_PASSWORD,
): Promise<ApiSession> {
  const context = await browser.newContext({ baseURL: E2E_BASE_URL })
  const csrf = await expectStatus(await context.request.get(`${E2E_BASE_URL}/api/auth/csrf`))
  const callback = await context.request.post(`${E2E_BASE_URL}/api/auth/callback/credentials`, {
    form: {
      csrfToken: csrf.csrfToken,
      username,
      password,
      callbackUrl: `${E2E_BASE_URL}/dashboard`,
    },
    headers: { "X-Auth-Return-Redirect": "1" },
    maxRedirects: 0,
  })
  expect([200, 302], `${callback.status()} ${callback.url()}`).toContain(callback.status())
  const session = await expectStatus(await context.request.get(`${E2E_BASE_URL}/api/auth/session`))
  expect(session.user?.id, `${username} did not get a session`).toBeTruthy()
  const page = await context.newPage()
  return { context, page, close: () => context.close() }
}

function sameOrigin(extra: Record<string, string> = {}): Record<string, string> {
  return { Origin: E2E_BASE_URL, "Sec-Fetch-Site": "same-origin", ...extra }
}

export function post(page: Page, path: string, data: unknown, headers: Record<string, string> = {}) {
  return page.request.post(path, { data, headers: sameOrigin(headers) })
}

export function put(page: Page, path: string, data: unknown, headers: Record<string, string> = {}) {
  return page.request.put(path, { data, headers: sameOrigin(headers) })
}

export function patch(page: Page, path: string, data: unknown, headers: Record<string, string> = {}) {
  return page.request.patch(path, { data, headers: sameOrigin(headers) })
}

/** A new order through the real endpoint, as the requester would place it. */
export async function placeOrder(
  page: Page,
  items: Array<{ organizationInventoryId: number; quantity: number }>,
  extra: Record<string, unknown> = {},
): Promise<JsonBody> {
  const body = await expectStatus(
    await post(page, "/api/v1/orders", { items, ...extra }, { "Idempotency-Key": `e2e-${randomUUID()}` }),
  )
  return body.order
}

export async function approveOrder(page: Page, orderId: number): Promise<string> {
  const body = await expectStatus(await post(page, `/api/v1/orders/${orderId}/approve`, {}))
  return String(body.approvalToken)
}

/**
 * An uploaded, not yet attached delivery challan for one order, as the upload
 * route would leave it — the browser suite has no S3 to upload to. Mirrors
 * `stageDeliveryChallan` in `tests/integration/helpers/delivery-challan-fixtures.ts`.
 */
export async function stageDeliveryChallan(orderId: number, uploadedByUserId: string): Promise<number> {
  const pool = new Pool({ connectionString: testDatabaseUrl(), max: 1 })
  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO order_delivery_challans
         (order_id, organization_id, branch_id, storage_key, file_name, content_type, size_bytes, uploaded_by_user_id)
       SELECT id, organization_id, branch_id, $2, 'delivery-challan.pdf', 'application/pdf', 512, $3
         FROM orders WHERE id = $1
       RETURNING id`,
      [orderId, `delivery-challan/${randomUUID()}.pdf`, uploadedByUserId],
    )
    if (!rows[0]) throw new Error(`Order ${orderId} not found for a delivery challan`)
    return rows[0].id
  } finally {
    await pool.end()
  }
}

/**
 * Walk an approved order's delivery progress to DELIVERED, one step at a time,
 * as Super Admin — who may not mark it delivered without a challan.
 */
/**
 * Moves an order through every remaining delivery stage to DELIVERED, from
 * Not Started unless `from` names the stage it has already reached.
 */
export async function markDelivered(
  page: Page,
  orderId: number,
  options: { from?: "NOT_STARTED" | "IN_PROCESS" } = {},
): Promise<void> {
  const steps = options.from === "IN_PROCESS" ? ["OUT_FOR_DELIVERY"] : ["IN_PROCESS", "OUT_FOR_DELIVERY"]
  for (const fulfillmentStatus of steps) {
    await expectStatus(await post(page, `/api/v1/orders/${orderId}/fulfillment-status`, { fulfillmentStatus }))
  }
  const session = await responseJson(await getReconnecting(page, `${E2E_BASE_URL}/api/auth/session`))
  const deliveryChallanId = await stageDeliveryChallan(orderId, String(session.user?.id))
  await expectStatus(await post(page, `/api/v1/orders/${orderId}/fulfillment-status`, {
    fulfillmentStatus: "DELIVERED",
    deliveryChallanId,
  }))
}

export async function fulfilOrder(page: Page, orderId: number, approvalToken: string): Promise<void> {
  await expectStatus(await post(page, `/api/v1/orders/${orderId}/fulfill`, { approvalToken }))
}
