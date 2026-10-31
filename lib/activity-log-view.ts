import {
  ACTIVITY_ACTOR_ROLES,
  ACTIVITY_MAX_WINDOW_DAYS,
  ACTIVITY_TENANT_ACTOR_ROLES,
  MS_PER_DAY,
  isActivityActorRole,
  type ActivityActorRole,
  type ActivityEvent,
  type ActivityOperation,
  type ActivitySeverity,
} from "@/lib/activity-log"
import { compareCodeUnits } from "@/lib/code-unit-order"
import { ROLE_DISPLAY_NAMES } from "@/lib/role-display-names"

/**
 * Presentation rules for the activity screen, kept out of the components so
 * every one of them can be unit-tested: the window presets, the badge tones,
 * the CSV serializer and the summary of what is currently filtered.
 *
 * Nothing here decides what a reader may see — that is
 * `lib/activity-log-access.ts` and the route. This only decides how what they
 * may see is drawn.
 */

// ---------------------------------------------------------------------------
// Window presets
// ---------------------------------------------------------------------------

export type WindowPresetId = "24h" | "7d" | "30d" | "90d" | "custom"

export type WindowPreset = {
  id: WindowPresetId
  label: string
  /** Null for `custom`, which takes its dates from the two pickers. */
  days: number | null
}

/**
 * Deliberately bounded, and every one inside `ACTIVITY_MAX_WINDOW_DAYS`: the
 * endpoint refuses a longer range, and a preset that produced a 400 would look
 * like a broken screen rather than a refused query. There is no "all time"
 * preset for the same reason.
 */
export const WINDOW_PRESETS: readonly WindowPreset[] = [
  { id: "24h", label: "Last 24 hours", days: 1 },
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "custom", label: "Custom range", days: null },
]

export const DEFAULT_WINDOW_PRESET: WindowPresetId = "7d"

export function windowForPreset(id: WindowPresetId, now: Date): { from: Date; to: Date } | null {
  const preset = WINDOW_PRESETS.find((candidate) => candidate.id === id)
  if (!preset || preset.days === null) return null
  const days = Math.min(preset.days, ACTIVITY_MAX_WINDOW_DAYS)
  return { from: new Date(now.getTime() - days * MS_PER_DAY), to: now }
}

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

/**
 * Tailwind classes per severity.
 *
 * Colour is never the only signal — every badge also carries its own text, and
 * `severityMeaning` supplies the wording a screen reader announces. A reader who
 * cannot distinguish the tones loses nothing.
 */
export const SEVERITY_TONE: Readonly<Record<ActivitySeverity, string>> = {
  critical:
    "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300",
  warning:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
  notice:
    "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-300",
  info:
    "border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
}

export const SEVERITY_LABEL: Readonly<Record<ActivitySeverity, string>> = {
  critical: "Critical",
  warning: "Warning",
  notice: "Notice",
  info: "Info",
}

/** Why a row carries the weight it does, for a tooltip and for a screen reader. */
export const SEVERITY_MEANING: Readonly<Record<ActivitySeverity, string>> = {
  critical: "Removes data, changes a price, or changes who can do what",
  warning: "The attempt did not succeed",
  notice: "Moves money, or changes a tenant or an account",
  info: "Routine activity",
}

export const OPERATION_TONE: Readonly<Record<ActivityOperation, string>> = {
  auth: "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300",
  create: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
  update: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300",
  delete: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300",
  approve: "border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-300",
  reject: "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/60 dark:text-orange-300",
  export: "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300",
  other: "border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
}

export const OPERATION_LABEL: Readonly<Record<ActivityOperation, string>> = {
  auth: "Sign-in",
  create: "Created",
  update: "Updated",
  delete: "Deleted",
  approve: "Approved",
  reject: "Rejected",
  export: "Viewed",
  other: "Other",
}

export const ACTOR_ROLE_LABEL: Readonly<Record<ActivityActorRole, string>> = {
  SUPER_ADMIN: "Super Admin",
  HEAD_OFFICE: "Head Office",
  GROUP_USER: ROLE_DISPLAY_NAMES.GROUP_USER,
  BRANCH_ADMIN: ROLE_DISPLAY_NAMES.BRANCH_ADMIN,
  GROUP_ORDER_PORTAL: ROLE_DISPLAY_NAMES.GROUP_ORDER_PORTAL,
  ORDER_PORTAL: ROLE_DISPLAY_NAMES.ORDER_PORTAL,
  VIEWER: "Viewer",
  ORDER_DESK: "Order Desk",
  APRICART_EXECUTIVE: "Apricart Executive",
  WAREHOUSE: "Warehouse",
  APRICART_SUPPORT: "Apricart Support",
  FINANCE: "Finance",
  PROCUREMENT: "Procurement",
}

export type ActorRoleOption = { value: ActivityActorRole; label: string }

/**
 * The role filter's options for this reader. Presentation only — the endpoint
 * refuses an Apricart role from a tenant reader. A tenant sees its own roles
 * and nothing of Apricart's internal ones.
 */
export function actorRoleOptions(platformWide: boolean): ActorRoleOption[] {
  const roles = platformWide ? ACTIVITY_ACTOR_ROLES : ACTIVITY_TENANT_ACTOR_ROLES
  return roles.map((role) => ({ value: role, label: ACTOR_ROLE_LABEL[role] }))
}

/**
 * The role shown under the person. A recorded role the page knows is shown by
 * its display name; anything else is shown as recorded rather than dropped.
 */
export function actorRoleLabel(role: string | null | undefined): string | null {
  if (!role) return null
  return isActivityActorRole(role) ? ACTOR_ROLE_LABEL[role] : role
}

/** Who did it, in one line, preferring the most identifying thing available. */
export function actorLabel(event: ActivityEvent): string {
  const { actor } = event
  return actor.name ?? actor.email ?? actor.id ?? "System"
}

/** Where it happened, in one line. */
export function scopeLabel(event: ActivityEvent): string {
  const parts = [event.organizationName, event.branchName].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  )
  return parts.length > 0 ? parts.join(" · ") : "Platform"
}

/**
 * A full accessible description of the row, so a screen reader hears the same
 * facts the badges convey visually rather than a bare action string.
 */
export function eventAriaLabel(event: ActivityEvent): string {
  const outcome = event.success ? "succeeded" : `failed${event.errorMessage ? ` (${event.errorMessage})` : ""}`
  const target = event.entityId ? `${event.entityLabel} ${event.entityId}` : event.entityLabel
  return [
    `${event.actionLabel}, ${OPERATION_LABEL[event.operation]}, ${SEVERITY_LABEL[event.severity]}.`,
    `${actorLabel(event)} at ${scopeLabel(event)}.`,
    `Target ${target}.`,
    `${new Date(event.occurredAt).toLocaleString()}, ${outcome}.`,
  ].join(" ")
}

// ---------------------------------------------------------------------------
// The before/after diff
// ---------------------------------------------------------------------------

export type FieldChange = { field: string; before: unknown; after: unknown }

/**
 * The fields that differ between the `before` and `after` a writer recorded.
 *
 * The union of both sides' keys, so a field that only one side has still shows —
 * that is exactly the case a reviewer needs to see, and intersecting would hide
 * a field that was added or cleared.
 */
export function changedFields(metadata: unknown): FieldChange[] {
  if (!metadata || typeof metadata !== "object") return []
  const record = metadata as Record<string, unknown>
  const before = isPlainRecord(record.before) ? record.before : null
  const after = isPlainRecord(record.after) ? record.after : null
  if (!before && !after) return []

  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort(compareCodeUnits)
  const changes: FieldChange[] = []
  for (const key of keys) {
    const previous = before?.[key]
    const next = after?.[key]
    if (stableStringify(previous) === stableStringify(next)) continue
    changes.push({ field: key, before: previous, after: next })
  }
  return changes
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Key order must not decide whether two values look equal. */
function stableStringify(value: unknown): string {
  if (value === undefined) return "\u0000undefined"
  return JSON.stringify(value, (_key, inner) => {
    if (isPlainRecord(inner)) {
      return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
    }
    return inner
  })
}

/**
 * Keys the detail panel already shows in a row of their own.
 *
 * `before`/`after` become the diff; the rest are what `recordAuditEvent` adds
 * about the request itself, and repeating them under "Recorded details" makes
 * the panel look like it holds the same fact twice.
 */
const SURFACED_METADATA_KEYS = new Set([
  "before",
  "after",
  "ip",
  "userAgent",
  "actorRole",
  "actorEmail",
])

/** Everything the writer recorded that is not already shown elsewhere in the panel. */
export function contextEntries(metadata: unknown): [string, unknown][] {
  if (!isPlainRecord(metadata)) return []
  return Object.entries(metadata).filter(([key]) => !SURFACED_METADATA_KEYS.has(key))
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const CSV_COLUMNS = [
  "Time (UTC)",
  "Severity",
  "Operation",
  "Category",
  "Action",
  "Outcome",
  "Actor",
  "Actor role",
  "Organization",
  "Branch",
  "Entity",
  "Entity id",
  "IP address",
  "Source",
  "Details",
] as const

/**
 * One cell.
 *
 * A leading `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an
 * apostrophe: a spreadsheet treats those as the start of a formula, and this
 * export carries attacker-influenced text — an action string, an entity id, a
 * user agent. Quoting alone does not stop a formula from running when the file
 * is opened.
 */
export function csvCell(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value)
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return `"${guarded.replace(/"/g, '""')}"`
}

/** The rows already loaded, as CSV. Never a second server read. */
export function eventsToCsv(events: readonly ActivityEvent[]): string {
  const header = CSV_COLUMNS.map(csvCell).join(",")
  const rows = events.map((event) =>
    [
      new Date(event.occurredAt).toISOString(),
      SEVERITY_LABEL[event.severity],
      OPERATION_LABEL[event.operation],
      event.category,
      event.action,
      event.success ? "Success" : `Failed${event.errorMessage ? `: ${event.errorMessage}` : ""}`,
      actorLabel(event),
      event.actor.role ?? "",
      event.organizationName ?? "",
      event.branchName ?? "",
      event.entityLabel,
      event.entityId ?? "",
      event.ipAddress ?? "",
      event.source,
      event.metadata ?? "",
    ]
      .map(csvCell)
      .join(","),
  )
  return [header, ...rows].join("\r\n")
}

export function csvFileName(now: Date): string {
  return `activity-log-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`
}
