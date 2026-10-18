import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { isValidImageKey, isValidSupportAttachmentKey } from "./image-storage"

/**
 * Contract tests for the support channel.
 *
 * These read the source and assert on its shape, the way
 * `security-boundaries.test.ts` and `pricing-access.test.ts` do. They exist for
 * the guarantees that are structural rather than behavioural: "every support
 * route authenticates", "no support route trusts a tenant from the request".
 *
 * **When you add a route under `app/api/v1/support/`, add it to the list
 * below.** A route missing from it is silently unchecked.
 */

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const SUPPORT_ROUTES = [
  "app/api/v1/support/threads/route.ts",
  "app/api/v1/support/stats/route.ts",
  "app/api/v1/support/products/route.ts",
  "app/api/v1/support/threads/[id]/route.ts",
  "app/api/v1/support/threads/[id]/messages/route.ts",
  "app/api/v1/support/attachments/route.ts",
  "app/api/v1/support/attachments/[id]/route.ts",
]

describe("every support route is a closed door", () => {
  it("refuses a caller with no session", () => {
    for (const path of SUPPORT_ROUTES) {
      const route = repositoryFile(path)
      const authenticates =
        route.includes("{ status: 401 }") || route.includes("resolveSupportAuthor()")
      expect(authenticates, `${path} must reject an unauthenticated caller`).toBe(true)
    }
  })

  it("refuses a role that is not a party to a support conversation", () => {
    for (const path of SUPPORT_ROUTES) {
      const route = repositoryFile(path)
      const authorizes =
        route.includes("isSupportParticipantRole") || route.includes("canRaiseSupportThread")
      expect(authorizes, `${path} must check the caller's role`).toBe(true)
      expect(route, `${path} must be able to answer 403`).toContain("{ status: 403 }")
    }
  })

  it("rate limits every route", () => {
    for (const path of SUPPORT_ROUTES) {
      expect(repositoryFile(path), `${path} must go through withRateLimit`).toContain(
        "withRateLimit(",
      )
    }
  })

  it("returns errors through the shared handler, never a raw exception", () => {
    for (const path of SUPPORT_ROUTES) {
      const route = repositoryFile(path)
      expect(route, `${path} must use handleError`).toContain("handleError(")
      expect(route, `${path} must not leak an error message directly`).not.toMatch(
        /error:\s*(error|err)\.message/,
      )
    }
  })

  it("never takes the caller's tenant from the request", () => {
    for (const path of SUPPORT_ROUTES) {
      const route = repositoryFile(path)
      // The one permitted read of `organizationId` from the request is Apricart
      // *narrowing* an already-unrestricted scope, in the list handler, and it
      // is guarded by the Apricart-side check right there (`SUPPORT_APRICART_ROLES`,
      // whose every member already reads every tenant).
      const body = route.replace(
        /isSupportApricartRole\(viewer\.role\) && Number\.isInteger\(organizationId\)[\s\S]*?: undefined,/,
        "",
      )
      expect(body, `${path} must not read organizationId from the request body`).not.toMatch(
        /(?:body|parsed\.data)[\s\S]{0,40}\borganizationId\b/,
      )
      expect(body, `${path} must not read branchId from the request`).not.toMatch(
        /(?:body|parsed\.data|searchParams[^\n]*)\.?\bbranchId\b/,
      )
    }
  })

  it("answers 404, not 403, for a thread outside the caller's scope", () => {
    // 403 would confirm the thread exists. Every thread-addressed route says
    // the same thing whether the id is unknown or simply not the caller's.
    for (const path of SUPPORT_ROUTES.filter((route) => route.includes("[id]"))) {
      expect(repositoryFile(path), `${path} must answer 404 for an out-of-scope id`).toContain(
        "{ status: 404 }",
      )
    }
  })
})

describe("the thread rule is stated in exactly one place", () => {
  it("is never restated as an inline role comparison in a route", () => {
    for (const path of SUPPORT_ROUTES) {
      const route = repositoryFile(path)
      // A route may ask whether the caller is on the Apricart side when Apricart
      // *narrows* the list to one tenant. It must never decide who reads a
      // thread by an inline role comparison — that is `lib/support-access.ts`.
      const readDecisions = route.match(/role === ["'](HEAD_OFFICE|BRANCH_ADMIN|ORDER_PORTAL)["']/g)
      expect(readDecisions, `${path} must not inline a visibility role check`).toBeNull()
    }
  })

  it("routes every scoped read through the shared scope condition", () => {
    const service = repositoryFile("lib/server/support-threads.ts")
    expect(service).toContain("supportThreadVisibilityScope")
    // The list and the single-thread read share one predicate, so they cannot
    // drift apart and let a detail page show what a list would not.
    expect(service).toContain("listSupportThreads(viewer, { threadId")
  })

  it("counts the KPI figures under the same scope the list reads", () => {
    // A tile that counted further than the list reads would disclose the
    // existence of threads the caller cannot open — the aggregate equivalent
    // of a missing tenant filter.
    const service = repositoryFile("lib/server/support-threads.ts")
    const stats = service.slice(service.indexOf("export async function getSupportThreadStats"))
    const body = stats.slice(0, stats.indexOf("async function loadAssigneeNames"))

    expect(body, "the stats reader must derive its predicate from the shared scope").toContain(
      "supportScopeCondition(viewer)",
    )
    // Nothing at all when the viewer may see nothing, rather than the table.
    expect(body).toContain("if (!scopeCondition) return")
    expect(body, "the stats query must be filtered by that predicate").toContain(
      ".where(scopeCondition)",
    )
  })

  it("lets a query cite only a product the author's own organization carries", () => {
    // Citing is a write, and the organization it is checked against comes from
    // the author the server resolved — never from the request.
    const service = repositoryFile("lib/server/support-threads.ts")
    const start = service.indexOf("async function verifyProductReference")
    expect(start, "verifyProductReference must exist").toBeGreaterThan(-1)
    const check = service.slice(start, service.indexOf("export type PostSupportMessageInput"))

    expect(check, "must scope to the author's organization").toContain(
      "eq(organizationInventory.organizationId, author.organizationId)",
    )
    expect(check, "a disabled assignment is not a citable product").toContain(
      "eq(organizationInventory.isActive, true)",
    )
    expect(check, "nor is a withdrawn one").toContain(
      "isNull(organizationInventory.deletedAt)",
    )
    // `organization_products` looks like the catalogue and is written by nothing
    // but the K-Electric sync. Citing it refuses every product of every tenant
    // whose catalogue was assigned through the application.
    expect(check, "the catalogue is organization_inventory").not.toContain(
      "organizationProducts",
    )
    // One answer for "no such product" and "not yours", so the field cannot be
    // used to discover another tenant's catalogue.
    expect(check).toContain("That product could not be found.")
  })

  it("keeps the product search scoped to the caller's own organization", () => {
    const route = repositoryFile("app/api/v1/support/products/route.ts")
    expect(route, "the organization must come from the viewer").toContain(
      "eq(organizationInventory.organizationId, organizationId)",
    )
    expect(route, "and the viewer from the session").toContain(
      "const organizationId = viewer.organizationId",
    )
    // The picker must offer the catalogue the store is built from, or it offers
    // nothing at all — see the verifyProductReference case above.
    expect(route, "the catalogue is organization_inventory").not.toContain(
      "organizationProducts",
    )
    // A picker has no business carrying a price; price visibility is
    // `lib/price-visibility.ts`'s question and is avoided rather than answered.
    expect(route).not.toMatch(/basePrice|customPrice|priceCents/)
    expect(route, "the result set must be bounded").toContain("RESULT_LIMIT")
  })

  it("searches by order id without letting the search widen a scope", () => {
    const service = repositoryFile("lib/server/support-threads.ts")
    const start = service.indexOf("function supportOrderSearchCondition")
    expect(start, "supportOrderSearchCondition must exist").toBeGreaterThan(-1)
    const condition = service.slice(start, service.indexOf("export type SupportThreadListItem"))

    // A typed `%` searches for a percent sign. Unescaped it would turn the
    // filter into "everything", which is the wrong answer for a search box.
    expect(condition, "the term must be escaped before it becomes a pattern").toContain(
      "escapeLikePattern(term)",
    )
    expect(condition, "the term is a parameter, never spliced into the SQL").not.toContain(
      "sql.raw",
    )

    // The scope condition opens `conditions`; the search is pushed onto the
    // same array, so it is ANDed underneath rather than replacing it.
    expect(service).toContain("const conditions: SQL[] = [scopeCondition]")
    expect(service).toContain(
      "if (filters.orderSearch) conditions.push(supportOrderSearchCondition(filters.orderSearch))",
    )
  })

  it("bounds the order search at the route rather than in the query", () => {
    const route = repositoryFile("app/api/v1/support/threads/route.ts")
    // The only free-text parameter this route takes. It is parsed by the pure
    // module, and a term too long to name an order is refused outright.
    expect(route, "the search must go through the shared parser").toContain(
      'parseSupportOrderSearch(params.get("orderSearch"))',
    )
    expect(route, "and be answerable with a 400").toMatch(
      /orderSearch\.ok[\s\S]{0,120}\{ status: 400 \}/,
    )
  })

  it("keeps triage rights with Apricart alone", () => {
    const detail = repositoryFile("app/api/v1/support/threads/[id]/route.ts")
    expect(detail).toContain("canManageSupportThread")
    expect(detail).toMatch(/isTriage[\s\S]{0,200}\{ status: 403 \}/)
  })
})

describe("attachments are not served by the public image route", () => {
  const supportKey = "support/2f7a1c40-9c1e-4d3b-8f52-7c0b6a1d9e33.png"
  const productKey = "products/2f7a1c40-9c1e-4d3b-8f52-7c0b6a1d9e33.png"

  it("keeps the product-image validator blind to a support key", () => {
    // `GET /api/v1/images/[...key]` authenticates but does not authorize, so a
    // support attachment must be unreachable through it.
    expect(isValidImageKey(supportKey)).toBe(false)
    expect(isValidImageKey(productKey)).toBe(true)
  })

  it("keeps the support validator blind to a product key", () => {
    expect(isValidSupportAttachmentKey(productKey)).toBe(false)
    expect(isValidSupportAttachmentKey(supportKey)).toBe(true)
  })

  it("rejects traversal and prefix-confusion attempts on either validator", () => {
    const probes = [
      "support/../products/2f7a1c40-9c1e-4d3b-8f52-7c0b6a1d9e33.png",
      "../support/2f7a1c40-9c1e-4d3b-8f52-7c0b6a1d9e33.png",
      "supportx/2f7a1c40-9c1e-4d3b-8f52-7c0b6a1d9e33.png",
      "support/2f7a1c40-9c1e-4d3b-8f52-7c0b6a1d9e33.svg",
      "support/not-a-uuid.png",
      "support/",
      "",
    ]
    for (const probe of probes) {
      expect(isValidSupportAttachmentKey(probe), probe).toBe(false)
      expect(isValidImageKey(probe), probe).toBe(false)
    }
  })

  it("serves an attachment only after resolving it through its thread", () => {
    const route = repositoryFile("app/api/v1/support/attachments/[id]/route.ts")
    expect(route).toContain("getSupportAttachmentForViewer")
    // The key is read out of the row and re-validated; it never comes from the
    // request.
    expect(route).toContain("isValidSupportAttachmentKey(attachment.storageKey)")
    // Never inline: an attachment is arbitrary user content.
    expect(route).toMatch(/Content-Disposition["']\s*\]?\s*:\s*`attachment;/)
    expect(route).toContain("private, no-store")
  })

  it("sanitises the upload through sharp and stores it under the support prefix", () => {
    const route = repositoryFile("app/api/v1/support/attachments/route.ts")
    expect(route).toContain("sanitizeRasterUpload")
    expect(route).toContain("buildSupportAttachmentKey")
    // No data-URL fallback at any tier: an attachment never enters a column.
    expect(route).not.toContain("data:")
  })
})

describe("the support email never carries the conversation", () => {
  it("sends a link rather than the message body", () => {
    const template = repositoryFile("lib/email/support.ts")
    // An email leaves the application's access control behind. It says that
    // something happened; reading it requires signing in.
    expect(template).not.toMatch(/payload\.(body|message)\b/)
    expect(template).toContain("Sign in to OneFlowe to read and reply")
  })

  it("re-checks the recipient's right to the thread at delivery time", () => {
    const notifications = repositoryFile("lib/server/support-notifications.ts")
    expect(notifications).toContain("canReadSupportThread")
    expect(notifications).toContain("no longer authorized for this support thread")
  })
})

describe("the outbox still delivers order mail the way it always did", () => {
  it("retires an order lifecycle row that has lost its order scope", () => {
    const orders = repositoryFile("lib/server/order-notifications.ts")
    // `order_id` and `branch_id` became nullable when support threads joined
    // the table; an order row missing either is malformed, not deliverable.
    expect(orders).toContain("Order lifecycle email is missing its order scope")
    expect(orders).toMatch(/\.orderId === null \|\| \w+\.branchId === null/)
  })

  it("dispatches by template family rather than assuming every row is an order", () => {
    const orders = repositoryFile("lib/server/order-notifications.ts")
    expect(orders).toContain("isSupportEmailTemplate(row.template)")
    expect(orders).toContain("deliverClaimedSupportEmail")
  })
})
