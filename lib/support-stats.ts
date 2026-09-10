/**
 * The figures at the top of the support queue, and how each side reads them.
 *
 * Pure: no database, no session. The counting happens in
 * `lib/server/support-threads.ts` under the viewer's own scope predicate; this
 * module decides only which of the resulting numbers a given side is shown and
 * what each one is called.
 *
 * It is split out for the same reason `SUPPORT_STATUS_LABELS_APRICART` exists:
 * the two parties read the same row differently. "Needs a reply" to Apricart is
 * "Open" to the person who raised it, and a client has no use for an average
 * first-response time it is not accountable for.
 */

import type { SupportSide, SupportStatus } from "@/lib/support-thread"

/** Every figure the stats endpoint returns. Counts are over the viewer's scope. */
export type SupportStats = {
  /** Every thread the viewer may read. */
  total: number
  /** `OPEN` — the customer wrote last, Apricart owes a reply. */
  open: number
  /** `AWAITING_CUSTOMER` — Apricart wrote last. */
  awaitingCustomer: number
  resolved: number
  closed: number
  /** Threads with a message the viewer has not read. */
  unread: number
  /** Live threads raised as `HIGH` or `URGENT`. */
  urgent: number
  /** Live threads Apricart has never replied to at all. */
  unanswered: number
  /** Raised in the last seven days. */
  openedLast7Days: number
  /** Mean time from raising a thread to Apricart's first reply, in minutes. */
  avgFirstResponseMinutes: number | null
}

export const EMPTY_SUPPORT_STATS: SupportStats = {
  total: 0,
  open: 0,
  awaitingCustomer: 0,
  resolved: 0,
  closed: 0,
  unread: 0,
  urgent: 0,
  unanswered: 0,
  openedLast7Days: 0,
  avgFirstResponseMinutes: null,
}

function counted(value: unknown): number {
  // Postgres returns bigint counts as strings through the driver, so a number
  // and a numeric string are both expected here. Anything else is zero rather
  // than NaN, which would render as "NaN" in a tile.
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
    ? Math.round(parsed)
    : 0
}

function duration(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

/**
 * Reads a stats payload defensively.
 *
 * The tiles render before the request lands and must survive a partial or
 * failed response — a KPI row is not worth breaking the queue over.
 */
export function normalizeSupportStats(value: unknown): SupportStats {
  const raw = (value ?? {}) as Record<string, unknown>

  return {
    total: counted(raw.total),
    open: counted(raw.open),
    awaitingCustomer: counted(raw.awaitingCustomer),
    resolved: counted(raw.resolved),
    closed: counted(raw.closed),
    unread: counted(raw.unread),
    urgent: counted(raw.urgent),
    unanswered: counted(raw.unanswered),
    openedLast7Days: counted(raw.openedLast7Days),
    avgFirstResponseMinutes: duration(raw.avgFirstResponseMinutes),
  }
}

/**
 * A response time, in the largest two units that carry meaning.
 *
 * An em dash when there is nothing to average — no thread has been answered
 * yet — because "0m" would read as an instant reply rather than as no data.
 */
export function formatResponseDuration(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return "—"
  if (minutes < 1) return "< 1m"

  const whole = Math.round(minutes)
  if (whole < 60) return `${whole}m`

  const hours = Math.floor(whole / 60)
  if (hours < 24) {
    const rest = whole % 60
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}

export type SupportStatKey =
  | "total"
  | "open"
  | "awaiting"
  | "unread"
  | "resolved"
  | "recent"
  | "unanswered"
  | "urgent"
  | "firstResponse"

export type SupportStatCard = {
  key: SupportStatKey
  label: string
  /** A count, or an already-formatted string for anything that is not one. */
  value: number | string
  subtitle: string
  /**
   * The list filter this tile stands for, when it stands for exactly one
   * status. Absent where it does not — a tile must never filter to something
   * narrower than the number printed on it.
   */
  statusFilter?: SupportStatus
}

/**
 * The tiles for one side of the conversation.
 *
 * Six either way, so the row reads the same shape whoever is looking at it.
 * Apricart gets the operator's view — what is unanswered, what is urgent, how
 * fast the team replies. The client gets its own — what is still open, what is
 * waiting on them, what they have not read.
 */
export function supportStatCards(stats: SupportStats, side: SupportSide): SupportStatCard[] {
  if (side === "APRICART") {
    return [
      {
        key: "total",
        label: "Total requests",
        value: stats.total,
        subtitle: "Across every organization",
      },
      {
        key: "open",
        label: "Needs a reply",
        value: stats.open,
        subtitle: "The customer wrote last",
        statusFilter: "OPEN",
      },
      {
        key: "unanswered",
        label: "Never answered",
        value: stats.unanswered,
        subtitle: "No reply sent yet",
      },
      {
        key: "urgent",
        label: "Urgent & high",
        value: stats.urgent,
        subtitle: "Live, raised above normal",
      },
      {
        key: "firstResponse",
        label: "Avg first reply",
        value: formatResponseDuration(stats.avgFirstResponseMinutes),
        subtitle: "Across answered requests",
      },
      {
        key: "resolved",
        label: "Resolved",
        value: stats.resolved,
        subtitle: `${stats.closed} closed as well`,
        statusFilter: "RESOLVED",
      },
    ]
  }

  return [
    {
      key: "total",
      label: "Total requests",
      value: stats.total,
      subtitle: "Everything you can see",
    },
    {
      key: "open",
      label: "Open",
      value: stats.open,
      subtitle: "With the Apricart team",
      statusFilter: "OPEN",
    },
    {
      key: "awaiting",
      label: "Awaiting your reply",
      value: stats.awaitingCustomer,
      subtitle: "Apricart is waiting on you",
      statusFilter: "AWAITING_CUSTOMER",
    },
    {
      key: "unread",
      label: "Unread",
      value: stats.unread,
      subtitle: "New replies to read",
    },
    {
      key: "resolved",
      label: "Resolved",
      value: stats.resolved,
      subtitle: `${stats.closed} closed as well`,
      statusFilter: "RESOLVED",
    },
    {
      key: "recent",
      label: "Raised this week",
      value: stats.openedLast7Days,
      subtitle: "In the last 7 days",
    },
  ]
}
