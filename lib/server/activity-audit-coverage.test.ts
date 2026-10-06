import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Which mutating routes record what they did — **all of them**.
 *
 * An audit review found the trail scattered and absent from most of the API.
 * This is the control that keeps it complete. Every route file under
 * `app/api/v1/**` that exports a POST, PUT, PATCH or DELETE handler must appear
 * in exactly one of the three lists below, and `every mutating route is
 * classified` is the test that makes it so: a **new** mutating route fails this
 * suite until somebody says which list it belongs in.
 *
 * That is the point. The previous version of this file listed only the seven
 * routes one change had retrofitted, which said nothing about the rest.
 *
 *  * `DIRECT` — the handler calls `recordAuditEvent` itself, inside the
 *    transaction that performs the change.
 *  * `VIA_LIB` — the write happens in a shared `lib/` module the route
 *    delegates to. That is the better place when several routes reach the same
 *    transition: `fulfillApprovedOrder` is reached from three of them, and
 *    recording it per route would have meant three spellings of one event.
 *  * `LEGACY_DIRECT` — audited already, but with a hand-written
 *    `insert(auditLogs)` rather than through the writer.
 *  * `NOT_AUDITED` — deliberately not recorded, each with the reason. A gap
 *    that is written down is a decision; a gap that is not is an oversight.
 */

type DirectRoute = {
  file: string
  /** The handlers that mutate and must each record. */
  handlers: readonly string[]
  /** The action strings written, so a rename cannot go unnoticed. */
  actions: readonly string[]
  /**
   * True when the write cannot share a transaction with the change — an S3
   * object. Those call `recordAuditEvent(db, …)` by necessity, and the reason is
   * in a comment at the call site.
   */
  nonTransactional?: true
}

const DIRECT: readonly DirectRoute[] = [
  {
    file: "app/api/v1/categories/route.ts",
    handlers: ["POST", "PUT", "DELETE"],
    actions: ["CREATE_CATEGORY", "UPDATE_CATEGORY", "DELETE_CATEGORY"],
  },
  {
    file: "app/api/v1/subcategories/route.ts",
    handlers: ["POST", "PUT", "DELETE"],
    actions: ["CREATE_SUBCATEGORY", "UPDATE_SUBCATEGORY", "DELETE_SUBCATEGORY"],
  },
  {
    file: "app/api/v1/modifiers/route.ts",
    handlers: ["POST", "PUT", "DELETE"],
    actions: ["CREATE_MODIFIER", "UPDATE_MODIFIER", "DELETE_MODIFIER"],
  },
  {
    file: "app/api/v1/suppliers/route.ts",
    handlers: ["POST"],
    actions: ["CREATE_SUPPLIER"],
  },
  {
    file: "app/api/v1/suppliers/[id]/route.ts",
    handlers: ["PATCH", "DELETE"],
    actions: ["UPDATE_SUPPLIER", "DELETE_SUPPLIER"],
  },
  {
    file: "app/api/v1/branches/[id]/route.ts",
    handlers: ["PATCH", "DELETE"],
    actions: ["UPDATE_BRANCH", "DEACTIVATE_BRANCH"],
  },
  {
    file: "app/api/v1/reports/schedule/route.ts",
    handlers: ["POST", "DELETE"],
    actions: ["CREATE_REPORT_SCHEDULE", "UPDATE_REPORT_SCHEDULE", "DELETE_REPORT_SCHEDULE"],
  },
  {
    file: "app/api/v1/admin/cleanup-inventory/route.ts",
    handlers: ["POST"],
    actions: ["CLEANUP_ORGANIZATION_INVENTORY_NAMES"],
  },
  {
    file: "app/api/v1/admin/repair-budgets/route.ts",
    handlers: ["POST"],
    actions: ["RESET_BRANCH_BUDGETS", "REBUILD_BRANCH_BUDGETS"],
  },
  {
    file: "app/api/v1/reports/process-schedules/route.ts",
    handlers: ["POST"],
    actions: ["SEND_SCHEDULED_REPORT"],
  },
  {
    file: "app/api/v1/support/attachments/route.ts",
    handlers: ["POST"],
    actions: ["UPLOAD_SUPPORT_ATTACHMENT"],
  },
  {
    // S3 is not transactional; see the comment at the call site.
    file: "app/api/v1/upload/image/route.ts",
    handlers: ["POST"],
    actions: ["UPLOAD_IMAGE", "UPLOAD_ORDER_INTAKE_ATTACHMENT"],
    nonTransactional: true,
  },
  {
    // Also the route that used to delete the order's `system_logs` history. It
    // no longer does — audit rows are append-only (rule 06), and a hard delete
    // is the one case where that history matters most.
    file: "app/api/v1/admin/delete-order/route.ts",
    handlers: ["DELETE"],
    actions: ["DELETE_ORDER"],
  },
]

/**
 * Routes whose audit write lives in a module they import. The module is named so
 * a reader can follow it, and asserted to still write.
 */
const VIA_LIB: readonly { file: string; module: string }[] = [
  // Authentication events go to `system_logs` through `recordAuthAuditEvent`,
  // whose looser columns suit an event with no verified tenant or account.
  { file: "app/api/v1/mfa/toggle/route.ts", module: "lib/server/auth-audit.ts" },
  { file: "app/api/v1/mfa/send-otp/route.ts", module: "lib/server/auth-audit.ts" },
  { file: "app/api/v1/mfa/verify-otp/route.ts", module: "lib/server/auth-audit.ts" },
  { file: "app/api/v1/mfa/login/send-otp/route.ts", module: "lib/server/auth-audit.ts" },
  { file: "app/api/v1/mfa/login/verify-otp/route.ts", module: "lib/server/auth-audit.ts" },
  { file: "app/api/v1/users/me/change-password/route.ts", module: "lib/server/password-change.ts" },
  // Public recovery. Every outcome — including requests for accounts that do
  // not exist — is recorded by the service, never by the route.
  { file: "app/api/v1/auth/password-reset/request/route.ts", module: "lib/server/password-reset.ts" },
  { file: "app/api/v1/auth/password-reset/verify/route.ts", module: "lib/server/password-reset.ts" },
  { file: "app/api/v1/auth/password-reset/complete/route.ts", module: "lib/server/password-reset.ts" },
  { file: "app/api/v1/users/me/email-verification/send/route.ts", module: "lib/server/email-verification.ts" },
  { file: "app/api/v1/users/me/email-verification/verify/route.ts", module: "lib/server/email-verification.ts" },

  // The APPROVED → FULFILLED transition. Three routes reach it; the record
  // belongs with the ledger move, not with any one of them.
  { file: "app/api/v1/orders/[id]/fulfill/route.ts", module: "lib/server/order-fulfillment.ts" },

  { file: "app/api/v1/orders/[id]/approve/route.ts", module: "lib/server/order-decision-service.ts" },
  { file: "app/api/v1/orders/[id]/reject/route.ts", module: "lib/server/order-decision-service.ts" },
  { file: "app/api/v1/group-portal/approvals/decide/route.ts", module: "lib/server/order-decision-service.ts" },
  // Return for correction and resubmission: both record inside the
  // transaction that moves the order (ORDER_RETURNED_FOR_CORRECTION,
  // ORDER_RESUBMITTED).
  { file: "app/api/v1/orders/[id]/return-for-correction/route.ts", module: "lib/server/order-correction.ts" },
  { file: "app/api/v1/orders/[id]/resubmit/route.ts", module: "lib/server/order-correction.ts" },
  // Replacing a delivered order's challan records REPLACE_DELIVERY_CHALLAN
  // in the same transaction as the swap.
  { file: "app/api/v1/orders/[id]/delivery-challan/route.ts", module: "lib/server/delivery-challan.ts" },
  { file: "app/api/v1/group-portal/orders/route.ts", module: "lib/server/group-order-creation.ts" },
  { file: "app/api/v1/group-portal/refunds/route.ts", module: "lib/server/group-order-refunds.ts" },
  { file: "app/api/v1/group-portal/orders/[groupOrderId]/tokens/route.ts", module: "lib/server/group-order-tokens.ts" },
  { file: "app/api/v1/budgets/cron/expire-addons/route.ts", module: "lib/server/budget-addon-expiry.ts" },
  { file: "app/api/v1/payment-control/exceptions/route.ts", module: "lib/server/payment-control.ts" },
  { file: "app/api/v1/payment-control/exceptions/[id]/revoke/route.ts", module: "lib/server/payment-control.ts" },
  { file: "app/api/v1/support/threads/route.ts", module: "lib/server/support-threads.ts" },
  { file: "app/api/v1/support/threads/[id]/route.ts", module: "lib/server/support-threads.ts" },
  { file: "app/api/v1/support/threads/[id]/messages/route.ts", module: "lib/server/support-threads.ts" },

  // New-product requests. Head Office raising one and Super Admin deciding it
  // record through one module, inside the transaction that writes the row.
  { file: "app/api/v1/product-requests/route.ts", module: "lib/server/product-requests.ts" },
  { file: "app/api/v1/product-requests/[id]/route.ts", module: "lib/server/product-requests.ts" },

  // Self-service joining. Opening a tenant to outsiders and deciding who gets in
  // are both privileged, and both record through one module so the two halves of
  // the story cannot be spelled differently.
  { file: "app/api/v1/organizations/join-code/route.ts", module: "lib/server/organization-join-audit.ts" },
  { file: "app/api/v1/join-requests/[id]/route.ts", module: "lib/server/organization-join-audit.ts" },

  // Delivery addresses. Asking for a destination and granting one are both on
  // the trail — an approved address diverts stock to somewhere the branch's own
  // record does not mention — and both record through one module so the two
  // halves of the story cannot be spelled differently.
  { file: "app/api/v1/delivery-addresses/route.ts", module: "lib/server/delivery-address-audit.ts" },
  { file: "app/api/v1/delivery-addresses/[id]/route.ts", module: "lib/server/delivery-address-audit.ts" },

  // Apricart's Order Desk. Its fulfil step reaches `fulfillApprovedOrder`,
  // which records the APPROVED → FULFILLED move with the ledger; cancel and
  // edit record inside their own transactions. A Super Admin granting a desk
  // user's reach records inside the replacement.
  { file: "app/api/v1/order-desk/orders/[id]/fulfil/route.ts", module: "lib/server/order-desk-orders.ts" },
  { file: "app/api/v1/order-desk/orders/[id]/cancel/route.ts", module: "lib/server/order-desk-orders.ts" },
  { file: "app/api/v1/order-desk/orders/[id]/route.ts", module: "lib/server/order-desk-edit.ts" },
  { file: "app/api/v1/order-desk/team/[userId]/assignments/route.ts", module: "lib/server/order-desk-team.ts" },
]

/**
 * Routes that already audited before the centralized writer existed, with a
 * direct `insert(auditLogs)` (or `system_logs` / `group_audit_logs`).
 *
 * They are audited, so they are not gaps — but they are not going through
 * `recordAuditEvent` either, which means each spells its own action however its
 * author chose (`CREATE`, `import_products`, `CASCADE_UPDATE`) and none of them
 * masks its metadata or records an IP. `lib/activity-log.ts` classifies those
 * spellings precisely because these rows exist.
 *
 * Migrating them is a separate change, deliberately not attempted here:
 * thirty-eight files across orders, budgets, pricing and RBAC, every one of them
 * money- or permission-bearing, is not a diff anybody can review alongside a new
 * screen. What this list does is make them visible and keep them writing.
 */
const LEGACY_DIRECT: readonly string[] = [
  "app/api/v1/admin/clear-branch-inventory/route.ts",
  "app/api/v1/admin/global-inventory/import/route.ts",
  "app/api/v1/admin/global-inventory/route.ts",
  "app/api/v1/admin/organization-assignments/import/route.ts",
  "app/api/v1/admin/organization-assignments/route.ts",
  "app/api/v1/admin/refunds/[id]/route.ts",
  "app/api/v1/admin/refunds/route.ts",
  "app/api/v1/branch/inventory/route.ts",
  "app/api/v1/branches/route.ts",
  "app/api/v1/budget-quantity/route.ts",
  "app/api/v1/budgets/route.ts",
  "app/api/v1/groups/[id]/branches/clean/route.ts",
  "app/api/v1/groups/[id]/branches/route.ts",
  "app/api/v1/groups/[id]/prices/route.ts",
  "app/api/v1/groups/[id]/route.ts",
  "app/api/v1/groups/route.ts",
  "app/api/v1/head-office/branch-assignments/route.ts",
  "app/api/v1/head-office/branch-assignments/toggle/route.ts",
  "app/api/v1/head-office/organization-inventory/route.ts",
  "app/api/v1/inventory/branch-products/route.ts",
  "app/api/v1/inventory/global-products/[id]/route.ts",
  "app/api/v1/inventory/import/route.ts",
  "app/api/v1/inventory/organization-products/route.ts",
  "app/api/v1/orders/[id]/fulfillment-status/route.ts",
  "app/api/v1/orders/[id]/payment-status/route.ts",
  "app/api/v1/orders/[id]/refunds/route.ts",
  "app/api/v1/orders/[id]/route.ts",
  "app/api/v1/orders/[id]/send-token-email/route.ts",
  "app/api/v1/orders/cron/auto-fulfill/route.ts",
  "app/api/v1/orders/route.ts",
  "app/api/v1/organizations/[id]/network-policy/route.ts",
  "app/api/v1/organizations/[id]/route.ts",
  "app/api/v1/organizations/route.ts",
  "app/api/v1/roles/permissions/route.ts",
  "app/api/v1/settings/route.ts",
  "app/api/v1/users/[id]/access/route.ts",
  "app/api/v1/users/[id]/route.ts",
  "app/api/v1/users/route.ts",
]

/** Deliberately not recorded. Every entry states why. */
const NOT_AUDITED: readonly { file: string; reason: string }[] = [
  {
    file: "app/api/v1/notifications/route.ts",
    reason:
      "PATCH is mark-all-read on the caller's own notifications — per-viewer UI "
      + "state. A row every time somebody opens the bell menu would be thousands "
      + "a day, and the signal the screen exists to show would drown in it.",
  },
  {
    file: "app/api/v1/notifications/email-outbox/process/route.ts",
    reason:
      "`email_outbox` already carries status, attempts, recipient, template and "
      + "payload for every message, which *is* the delivery record. A row per "
      + "cron sweep would add nothing a reviewer cannot read there.",
  },
  {
    file: "app/api/v1/group-portal/draft/route.ts",
    reason:
      "A scratch draft, upserted repeatedly while somebody composes an order. "
      + "The submission is audited (lib/server/group-order-creation.ts); auditing "
      + "the keystrokes before it would bury that.",
  },
  {
    file: "app/api/v1/inventory/transactions/route.ts",
    reason: "POST is a stub that always answers 501. Nothing is written.",
  },
  {
    file: "app/api/v1/inventory/branch-products/restock/route.ts",
    reason:
      "POST is a deprecated stub that always answers 400 — stock is global-only. "
      + "Nothing is written.",
  },
  {
    file: "app/api/v1/join/lookup/route.ts",
    reason:
      "A read that is a POST only so the join code never reaches a URL, a log "
      + "line or a Referer. It changes nothing: it resolves an organization from "
      + "a code and returns branch and group names. Its abuse signal is the rate "
      + "limiter, which is where a burst of wrong codes shows up.",
  },
  {
    file: "app/api/v1/join/requests/route.ts",
    reason:
      "Anonymous, and the `organization_join_requests` row it writes IS the "
      + "record: who applied, from which address, with which agent, when, and "
      + "later who decided it and what was granted. A second row per submission "
      + "would duplicate that and hand anybody holding a leaked code a way to "
      + "flood audit_logs. The privileged half — the decision that actually "
      + "creates an account — is audited through "
      + "lib/server/organization-join-audit.ts.",
  },
]

const API_ROOT = "app/api/v1"
const MUTATING = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8")
}

/** Every `route.ts` under the v1 API, as a repo-relative POSIX path. */
function routeFiles(directory: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) {
      found.push(...routeFiles(path))
    } else if (name === "route.ts") {
      found.push(relative(process.cwd(), path).split("\\").join("/"))
    }
  }
  return found
}

const MUTATING_ROUTES = routeFiles(join(process.cwd(), API_ROOT)).filter((file) =>
  MUTATING.test(read(file)),
)

describe("every mutating route is classified", () => {
  it("finds the mutating routes at all, so a broken scan cannot pass vacuously", () => {
    expect(MUTATING_ROUTES.length).toBeGreaterThan(50)
  })

  it("accounts for every one of them exactly once", () => {
    const classified = new Map<string, string>()
    const duplicates: string[] = []
    const add = (file: string, list: string) => {
      if (classified.has(file)) duplicates.push(`${file} is in both ${classified.get(file)} and ${list}`)
      else classified.set(file, list)
    }
    for (const entry of DIRECT) add(entry.file, "DIRECT")
    for (const entry of VIA_LIB) add(entry.file, "VIA_LIB")
    for (const file of LEGACY_DIRECT) add(file, "LEGACY_DIRECT")
    for (const entry of NOT_AUDITED) add(entry.file, "NOT_AUDITED")

    expect(duplicates).toEqual([])

    const unclassified = MUTATING_ROUTES.filter((file) => !classified.has(file))
    expect(
      unclassified,
      "These routes mutate and are in no list. Add each to DIRECT (it records "
        + "itself through recordAuditEvent), VIA_LIB (a module it imports "
        + "records), LEGACY_DIRECT (it writes insert(auditLogs) by hand), or "
        + "NOT_AUDITED (with a reason).",
    ).toEqual([])
  })

  it("lists nothing that has stopped mutating or moved", () => {
    const stale = [
      ...DIRECT.map((entry) => entry.file),
      ...VIA_LIB.map((entry) => entry.file),
      ...LEGACY_DIRECT,
      ...NOT_AUDITED.map((entry) => entry.file),
    ].filter((file) => !MUTATING_ROUTES.includes(file))
    expect(stale, "Listed but no longer a mutating route — remove the entry.").toEqual([])
  })
})

describe("routes that record for themselves", () => {
  it.each(DIRECT)("$file records every mutation it performs", ({ file, handlers, actions }) => {
    const source = read(file)

    expect(source, `${file} must import the centralized writer`).toContain(
      "@/lib/server/activity-audit",
    )

    const writes = source.match(/recordAuditEvent\(/g) ?? []
    expect(
      writes.length,
      `${file} has ${handlers.length} mutating handlers but ${writes.length} audit writes`,
    ).toBeGreaterThanOrEqual(handlers.length)

    for (const action of actions) {
      expect(source, `${file} no longer writes ${action}`).toContain(`"${action}"`)
    }
  })

  it.each(DIRECT.filter((entry) => !entry.nonTransactional))(
    "$file writes its audit row inside the transaction",
    ({ file }) => {
      const source = read(file)

      // `recordAuditEvent(db, …)` would commit independently of the change it
      // claims to describe — the "best effort" pattern the review flagged.
      const executors = [...source.matchAll(/recordAuditEvent\(\s*([A-Za-z_$][\w$]*)/g)].map(
        (match) => match[1],
      )
      expect(executors.length).toBeGreaterThan(0)
      for (const executor of executors) {
        expect(executor, `${file} passes "${executor}" instead of a transaction handle`).toBe("tx")
      }

      expect(source, `${file} must open a transaction around the change and its record`).toMatch(
        /db\.transaction\(/,
      )
    },
  )

  it.each(DIRECT.filter((entry) => entry.nonTransactional))(
    "$file says why its write cannot be transactional",
    ({ file }) => {
      // The exemption is only legitimate with the reason written down beside it.
      const source = read(file)
      expect(source).toMatch(/recordAuditEvent\(\s*db\b/)
      expect(source.toLowerCase()).toMatch(/not transactional|cannot join a transaction|no transaction/)
    },
  )

  it("keeps the writer the only way these routes reach audit_logs", () => {
    for (const { file } of DIRECT) {
      expect(read(file), `${file} bypasses the writer`).not.toMatch(/insert\(auditLogs\)/)
    }
  })
})

describe("routes whose record is written by a module they delegate to", () => {
  it.each(VIA_LIB)("$file delegates to $module, which still writes", ({ file, module }) => {
    const source = read(file)
    const importPath = `@/${module.replace(/\.ts$/, "")}`
    expect(source, `${file} no longer imports ${module}`).toContain(importPath)

    const moduleSource = read(module)
    expect(
      moduleSource,
      `${module} no longer writes an audit row, so ${file} is now unaudited`,
    ).toMatch(/recordAuditEvent\(|recordAuthAuditEvent\(|insert\((auditLogs|systemLogs|groupAuditLogs)\)/)
  })
})

describe("routes that still audit by hand", () => {
  it.each(LEGACY_DIRECT)("%s still writes its own audit row", (file) => {
    // Not required to use the writer — but it must not quietly stop recording,
    // which is the regression this list exists to catch.
    expect(read(file)).toMatch(/insert\((auditLogs|systemLogs|groupAuditLogs)\)/)
  })

  it("is shrinking, not growing", () => {
    // A number, so migrating one of these to `recordAuditEvent` is a visible,
    // deliberate edit to this file rather than something nobody notices.
    expect(LEGACY_DIRECT).toHaveLength(38)
  })
})

describe("routes deliberately not audited", () => {
  it.each(NOT_AUDITED)("$file states why", ({ reason }) => {
    // A reason long enough to be an argument rather than a shrug.
    expect(reason.length).toBeGreaterThan(40)
  })

  it.each(NOT_AUDITED)("$file really writes nothing to the trail", ({ file }) => {
    const source = read(file)
    expect(source).not.toMatch(/recordAuditEvent\(|recordAuthAuditEvent\(/)
    expect(source).not.toMatch(/insert\((auditLogs|systemLogs|groupAuditLogs)\)/)
  })
})

describe("the writer itself", () => {
  const source = read("lib/server/activity-audit.ts")

  it("stays server-only", () => {
    expect(source).toContain('import "server-only"')
  })

  it("does not fall back to its own client when given an executor", () => {
    expect(source).toMatch(/executor\.insert\(auditLogs\)/)
    expect(source).not.toMatch(/executor: AuditExecutor = db/)
  })

  it("masks the payload on the way in", () => {
    expect(source).toContain("maskAuditMetadata")
  })
})
