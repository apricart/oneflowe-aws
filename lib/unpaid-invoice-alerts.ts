/**
 * The alerts at the top of every page about a branch's unpaid invoices
 * (plans/OF-PAYMENT-CONTROL-unpaid-invoice-alerts.md).
 *
 * Pure. Two states, both measured against the organization's own limit:
 *
 *   last order — one unpaid invoice short of the limit: one more order, then
 *                ordering is blocked unless the dues are cleared.
 *   blocked    — the limit is reached and no Head Office exception is in
 *                force: ordering is refused until the dues are cleared.
 *
 * The counts come from lib/server/unpaid-invoice-alerts.ts, through the same
 * predicate and exception the order gate decides with; the gate remains the
 * control.
 */

/** The roles that are alerted. Head Office and Super Admin are not tied to a branch. */
export const UNPAID_INVOICE_ALERT_ROLES = ["ORDER_PORTAL", "BRANCH_ADMIN", "GROUP_ORDER_PORTAL", "GROUP_USER"] as const
export type UnpaidInvoiceAlertRole = (typeof UNPAID_INVOICE_ALERT_ROLES)[number]

/** Alerted across their resolved assignment set rather than their own branch. */
const GROUP_ALERT_ROLES: readonly string[] = ["GROUP_ORDER_PORTAL", "GROUP_USER"]
/** Approve the branch's orders rather than place them. */
const APPROVER_ALERT_ROLES: readonly string[] = ["BRANCH_ADMIN", "GROUP_USER"]

export type UnpaidInvoiceAlertKind = "blocked" | "lastOrder"

export const UNPAID_INVOICE_ALERT_STORAGE_KEYS: Readonly<Record<UnpaidInvoiceAlertKind, string>> = Object.freeze({
  blocked: "oneflowe.unpaidInvoiceAlertDismissed.blocked",
  lastOrder: "oneflowe.unpaidInvoiceAlertDismissed.lastOrder",
})

export function receivesUnpaidInvoiceAlerts(role: unknown): role is UnpaidInvoiceAlertRole {
  return typeof role === "string" && (UNPAID_INVOICE_ALERT_ROLES as readonly string[]).includes(role)
}

export function alertsAcrossAssignedBranches(role: unknown): boolean {
  return typeof role === "string" && GROUP_ALERT_ROLES.includes(role)
}

const isWhole = (value: number) => Number.isSafeInteger(value)

/**
 * Exactly one order left before the block. With a limit of 1 nothing is ever
 * unpaid at this step, so nothing is said — a permanent "one order left" on
 * every branch would be noise, not a warning.
 */
export function isLastOrderBeforeBlock(unpaidInvoiceCount: number, threshold: number): boolean {
  return isWhole(unpaidInvoiceCount) && isWhole(threshold)
    && unpaidInvoiceCount >= 1
    && unpaidInvoiceCount === threshold - 1
}

/** The limit is reached — the policy's `limitReached` for a configured branch. */
export function hasReachedUnpaidInvoiceLimit(unpaidInvoiceCount: number, threshold: number): boolean {
  return isWhole(unpaidInvoiceCount) && isWhole(threshold)
    && threshold >= 1
    && unpaidInvoiceCount >= threshold
}

export type BranchUnpaidInvoices = {
  branchId: number
  branchName: string
  unpaidInvoiceCount: number
  threshold: number
}

/** The wire shape of `GET /api/v1/payment-control/ordering-alerts`. */
export type UnpaidInvoiceAlertsView = {
  /** Ordering refused: the limit is reached and no exception is in force. */
  blocked: BranchUnpaidInvoices[]
  /** One order left before the block. */
  lastOrder: BranchUnpaidInvoices[]
  /** The caller has an active branch in scope that is not blocked. */
  otherBranchesCanOrder: boolean
  /** The caller has an active branch in scope with neither alert. */
  otherBranchesUnaffected: boolean
}

export const NO_UNPAID_INVOICE_ALERTS: UnpaidInvoiceAlertsView = Object.freeze({
  blocked: [],
  lastOrder: [],
  otherBranchesCanOrder: false,
  otherBranchesUnaffected: false,
})

const byName = (left: BranchUnpaidInvoices, right: BranchUnpaidInvoices) =>
  left.branchName.localeCompare(right.branchName) || left.branchId - right.branchId

/**
 * Sort the caller's active branches into the two alerts. `exceptionActive`
 * is whether the branch's latest Head Office exception is in force now — a
 * branch at its limit with one may still order, so it is neither blocked nor
 * at its last order.
 */
export function unpaidInvoiceAlertsOf(
  rows: ReadonlyArray<{ branchId: number; branchName: string; unpaidInvoiceCount: number; exceptionActive?: boolean }>,
  threshold: number,
): UnpaidInvoiceAlertsView {
  const entry = (row: (typeof rows)[number]): BranchUnpaidInvoices =>
    ({ branchId: row.branchId, branchName: row.branchName, unpaidInvoiceCount: row.unpaidInvoiceCount, threshold })

  const blocked = rows
    .filter((row) => hasReachedUnpaidInvoiceLimit(row.unpaidInvoiceCount, threshold) && row.exceptionActive !== true)
    .map(entry)
    .sort(byName)
  const lastOrder = rows
    .filter((row) => isLastOrderBeforeBlock(row.unpaidInvoiceCount, threshold))
    .map(entry)
    .sort(byName)
  return {
    blocked,
    lastOrder,
    otherBranchesCanOrder: rows.length > blocked.length,
    otherBranchesUnaffected: rows.length > blocked.length + lastOrder.length,
  }
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

function parseEntry(value: unknown, belongs: (count: number, threshold: number) => boolean): BranchUnpaidInvoices | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (!isCount(candidate.branchId) || candidate.branchId === 0) return null
  if (typeof candidate.branchName !== "string" || !candidate.branchName.trim()) return null
  if (!isCount(candidate.unpaidInvoiceCount) || !isCount(candidate.threshold)) return null
  if (!belongs(candidate.unpaidInvoiceCount, candidate.threshold)) return null
  return {
    branchId: candidate.branchId,
    branchName: candidate.branchName.trim(),
    unpaidInvoiceCount: candidate.unpaidInvoiceCount,
    threshold: candidate.threshold,
  }
}

function parseList(value: unknown, belongs: (count: number, threshold: number) => boolean): BranchUnpaidInvoices[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => parseEntry(item, belongs))
    .filter((item): item is BranchUnpaidInvoices => item !== null)
}

/** A malformed payload is "nothing to say"; the gate refuses a blocked order anyway. */
export function parseUnpaidInvoiceAlertsView(payload: unknown): UnpaidInvoiceAlertsView {
  if (!payload || typeof payload !== "object") return NO_UNPAID_INVOICE_ALERTS
  const candidate = payload as Record<string, unknown>
  return {
    blocked: parseList(candidate.blocked, hasReachedUnpaidInvoiceLimit),
    lastOrder: parseList(candidate.lastOrder, isLastOrderBeforeBlock),
    otherBranchesCanOrder: candidate.otherBranchesCanOrder === true,
    otherBranchesUnaffected: candidate.otherBranchesUnaffected === true,
  }
}

export type UnpaidInvoiceAlert = {
  kind: UnpaidInvoiceAlertKind
  title: string
  body: string
  /** Listed under the title only when more than one branch is in the alert. */
  branches: Array<{ branchId: number; name: string; detail: string }>
  /** Identifies what a dismissal closed; any change to the branches or counts makes another. */
  dismissalKey: string
}

const unpaidInvoices = (count: number) => `${count} unpaid invoice${count === 1 ? "" : "s"}`
const standing = (entry: BranchUnpaidInvoices) =>
  `${unpaidInvoices(entry.unpaidInvoiceCount)} and ordering stops at ${entry.threshold}`

function dismissalKeyOf(kind: UnpaidInvoiceAlertKind, entries: readonly BranchUnpaidInvoices[]): string {
  const parts = entries.map((entry) => `${entry.branchId}:${entry.unpaidInvoiceCount}:${entry.threshold}`).sort()
  return `${kind}|${parts.join("|")}`
}

type Wording = Omit<UnpaidInvoiceAlert, "kind" | "dismissalKey">

function blockedWording(view: UnpaidInvoiceAlertsView, approver: boolean, group: boolean): Wording {
  const entries = view.blocked
  const [only] = entries
  if (!group) {
    return approver
      ? {
        title: "Ordering is blocked for your branch.",
        body: `Your branch has ${unpaidInvoices(only.unpaidInvoiceCount)}. The dues must be cleared before a new order can be created.`,
        branches: [],
      }
      : {
        title: "Your ordering is blocked.",
        body: `You have ${unpaidInvoices(only.unpaidInvoiceCount)}. Clear your dues before creating a new order.`,
        branches: [],
      }
  }

  const others = view.otherBranchesCanOrder
    ? approver ? " Your other branches can still order." : " You can continue ordering for your other branches."
    : ""
  if (entries.length === 1) {
    return {
      title: approver ? `Ordering is blocked for ${only.branchName}.` : `Your ordering is blocked for ${only.branchName}.`,
      body: approver
        ? `${only.branchName} has ${unpaidInvoices(only.unpaidInvoiceCount)}. Its dues must be cleared before a new order can be created for this branch.${others}`
        : `${only.branchName} has ${unpaidInvoices(only.unpaidInvoiceCount)}. Clear its dues before creating a new order for this branch.${others}`,
      branches: [],
    }
  }
  return {
    title: approver ? "Ordering is blocked for these branches:" : "Your ordering is blocked for these branches:",
    body: approver
      ? `Each branch's dues must be cleared before a new order can be created for it.${others}`
      : `Clear each branch's dues before creating a new order for it.${others}`,
    branches: entries.map((entry) => ({ branchId: entry.branchId, name: entry.branchName, detail: unpaidInvoices(entry.unpaidInvoiceCount) })),
  }
}

function lastOrderWording(view: UnpaidInvoiceAlertsView, approver: boolean, group: boolean): Wording {
  const entries = view.lastOrder
  const [only] = entries
  if (!group) {
    return approver
      ? {
        title: "Your branch can place only one more order.",
        body: `Your branch has ${standing(only)}. After its next order, if the invoices are still unpaid, ordering will be blocked for your branch until the dues are cleared.`,
        branches: [],
      }
      : {
        title: "You can place only one more order.",
        body: `Your branch has ${standing(only)}. After your next order, if your invoices are still unpaid, ordering will be blocked until you clear your dues.`,
        branches: [],
      }
  }

  const others = view.otherBranchesUnaffected
    ? approver ? " Your other branches are not affected." : " You can continue ordering for your other branches."
    : ""
  if (entries.length === 1) {
    return {
      title: approver
        ? `${only.branchName} can place only one more order.`
        : `You can place only one more order for ${only.branchName}.`,
      body: `${only.branchName} has ${standing(only)}. After the next order, if its invoices are still unpaid, ordering will be blocked for this branch until its dues are cleared.${others}`,
      branches: [],
    }
  }
  return {
    title: approver
      ? "These branches can place only one more order each:"
      : "You can place only one more order for each of these branches:",
    body: `After the next order for a branch, if its invoices are still unpaid, ordering will be blocked for that branch until its dues are cleared.${others}`,
    branches: entries.map((entry) => ({ branchId: entry.branchId, name: entry.branchName, detail: standing(entry) })),
  }
}

/**
 * What this role is told, the blocked alert first. A single-branch role is
 * told about its own branch only, so at most one of the two applies to it.
 */
export function unpaidInvoiceAlertsFor(view: UnpaidInvoiceAlertsView | null | undefined, role: unknown): UnpaidInvoiceAlert[] {
  if (!view || !receivesUnpaidInvoiceAlerts(role)) return []
  const approver = APPROVER_ALERT_ROLES.includes(role)
  const group = alertsAcrossAssignedBranches(role)
  const alerts: UnpaidInvoiceAlert[] = []
  if (view.blocked.length > 0) {
    alerts.push({ kind: "blocked", ...blockedWording(view, approver, group), dismissalKey: dismissalKeyOf("blocked", view.blocked) })
  }
  if (view.lastOrder.length > 0 && (group || alerts.length === 0)) {
    alerts.push({ kind: "lastOrder", ...lastOrderWording(view, approver, group), dismissalKey: dismissalKeyOf("lastOrder", view.lastOrder) })
  }
  return alerts
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** The key of the alert of this kind last closed in this tab's session, or null. */
export function readDismissedUnpaidInvoiceAlert(kind: UnpaidInvoiceAlertKind): string | null {
  try {
    return sessionStore()?.getItem(UNPAID_INVOICE_ALERT_STORAGE_KEYS[kind]) ?? null
  } catch {
    return null
  }
}

export function rememberDismissedUnpaidInvoiceAlert(kind: UnpaidInvoiceAlertKind, key: string): void {
  try {
    sessionStore()?.setItem(UNPAID_INVOICE_ALERT_STORAGE_KEYS[kind], key)
  } catch {
    // Storage can be blocked; the alert then returns on the next page load.
  }
}
