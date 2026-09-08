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
      // is guarded by a SUPER_ADMIN comparison right there.
      const body = route.replace(
        /viewer\.role === "SUPER_ADMIN" && Number\.isInteger\(organizationId\)[\s\S]*?: undefined,/,
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
      // A route may name SUPER_ADMIN when Apricart *narrows* the list to one
      // tenant. It must never decide who reads a thread that way — that is
      // `lib/support-access.ts`.
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
