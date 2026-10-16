/**
 * What an organization-scoped reader may learn about the people in its trail.
 *
 * Head Office reads every row tagged with its organization, and some of those
 * rows record an action taken *inside* the tenant by someone *outside* it — in
 * practice an Apricart Super Admin changing a price, a setting or an account.
 * The tenant is owed the fact that it happened and what changed. It is not
 * owed who at Apricart did it, from which address, on which device: that is
 * the platform's staff data, not the tenant's.
 *
 * So, for an organization reach:
 *
 * * an actor who is provably one of the tenant's own people is shown in full,
 *   address and device included;
 * * anyone else is anonymised — no id, email or name, no IP or user agent, and
 *   the keys in the row's metadata that name an actor are withheld;
 * * a row with no person behind it (a scheduled job) keeps its action but not
 *   the address it came from.
 *
 * "Provably" is fail-closed: an actor is the tenant's own only if their
 * account is in the tenant, or — for a principal with no account, such as an
 * employee login — the row itself records a tenant role. An unknown actor with
 * no role is treated as outside.
 *
 * Pure, so every case is unit-tested without a database
 * (`lib/activity-log-reach.test.ts`). `plans/OF-AUDIT-head-office-activity-log.md`.
 */

import type { ActivityActor, ActivityReach } from "@/lib/activity-log"

/**
 * The roles whose holders are Apricart's, not any tenant's. Exported for the
 * actor-role filter's SQL, which must exclude the same people this classifier
 * anonymises (`lib/server/activity-log-sql.ts`).
 */
export const PLATFORM_ACTOR_ROLE_NAMES: readonly string[] = ["SUPER_ADMIN"]

const PLATFORM_ACTOR_ROLES: ReadonlySet<string> = new Set(PLATFORM_ACTOR_ROLE_NAMES)

/** What the reader is told about an actor they may not identify. */
export const PLATFORM_ACTOR_LABEL = "Apricart administrator"
export const OUTSIDE_ACTOR_LABEL = "Someone outside your organization"

/** Replaces a metadata value that would identify an outside actor. */
export const WITHHELD = "[withheld]"

/**
 * * `visible` — shown in full.
 * * `outside` — a person the reader may not identify.
 * * `nobody` — no person recorded; the action stands, the origin does not.
 */
export type ActorStanding = "visible" | "outside" | "nobody"

export type ActorEvidence = {
  /** The actor id as the row holds it — a user uuid, or a principal like `emp_42`. */
  actorId: string | null
  /** The email the row itself denormalized, if any (`system_logs` only). */
  actorEmail: string | null
  /** The role the row itself recorded, if any. */
  rowRole: string | null
  /** The account behind `actorId`, if it still exists. */
  account: { organizationId: number | null; role: string | null } | null
}

export function classifyActivityActor(evidence: ActorEvidence, reach: ActivityReach): ActorStanding {
  if (reach.kind === "platform") return "visible"

  if (!evidence.actorId && !evidence.actorEmail) return "nobody"

  const role = evidence.rowRole ?? evidence.account?.role ?? null
  if (role !== null && PLATFORM_ACTOR_ROLES.has(role)) return "outside"
  // The account's role today, too: a row that recorded a tenant role for
  // someone who is now Apricart staff still names Apricart staff.
  if (evidence.account?.role && PLATFORM_ACTOR_ROLES.has(evidence.account.role)) return "outside"

  if (evidence.account) {
    return evidence.account.organizationId === reach.organizationId ? "visible" : "outside"
  }

  // No account: an employee principal, or a deleted user. The row is already
  // fenced to this tenant, so a tenant role recorded on it is the tenant's own
  // person; with no role at all there is nothing to go on.
  return role !== null ? "visible" : "outside"
}

/**
 * The entity id as an organization reader may see it.
 *
 * On an authentication event the "record" is the account itself and
 * `resource_id` holds the identifier as typed (`lib/server/auth-audit.ts`), so
 * for an outside actor it would name the person the row anonymises. Such rows
 * normally carry no organization and are fenced out before they get here; this
 * holds if one ever does not.
 */
export function visibleEntityId(
  entity: string | null,
  entityId: string | null,
  standing: ActorStanding,
): string | null {
  if (standing === "outside" && entity !== null && AUTH_ENTITIES.has(entity.toLowerCase())) return null
  return entityId
}

/** `lib/server/auth-audit.ts` writes `AUTH_AUDIT_RESOURCE` ("auth"); `user` rows name an account too. */
const AUTH_ENTITIES: ReadonlySet<string> = new Set(["auth", "user"])

/** The actor as an organization reader may see them. */
export function redactedActor(actor: ActivityActor): ActivityActor {
  const platform = actor.role !== null && PLATFORM_ACTOR_ROLES.has(actor.role)
  return {
    id: null,
    email: null,
    name: platform ? PLATFORM_ACTOR_LABEL : OUTSIDE_ACTOR_LABEL,
    // "Super Admin" is a fact about the platform, not about a person; any other
    // role of an outside actor would say which tenant they came from.
    role: platform ? actor.role : null,
    redacted: true,
  }
}

/**
 * Metadata keys that name *who did it* or *where from*, compared lower-cased
 * with `_` and `-` removed. `recordAuditEvent` writes `ip`, `userAgent`,
 * `actorRole` and `actorEmail`; the hand-written routes use the `…ByUserId` /
 * `…ByName` family and `performedBy…`.
 *
 * Key-based, so best-effort on free-form legacy metadata — which is why it is
 * applied only to rows whose actor is already known to be outside the tenant,
 * and why the actor and network columns are withheld independently of it.
 */
const IDENTITY_EXACT: ReadonlySet<string> = new Set([
  "ip",
  "ipaddress",
  "useragent",
  "useremail",
  "userid",
  "username",
  "adminid",
  "adminemail",
  "adminname",
  "byemail",
])
const IDENTITY_PREFIXES = ["actor", "performedby"] as const
const IDENTITY_SUFFIXES = ["byuserid", "byname", "byemail", "byid"] as const

export function isActorIdentityKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[-_]/g, "")
  return (
    IDENTITY_EXACT.has(normalized) ||
    IDENTITY_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    IDENTITY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  )
}

const MAX_DEPTH = 8

/** `metadata` with every actor-identifying key withheld, at any depth. */
export function redactActorMetadata(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_DEPTH) return WITHHELD
  if (Array.isArray(value)) return value.map((item) => redactActorMetadata(item, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isActorIdentityKey(key) ? WITHHELD : redactActorMetadata(child, depth + 1)
  }
  return out
}
