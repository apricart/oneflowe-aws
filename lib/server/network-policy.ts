import "server-only"

import { eq } from "drizzle-orm"
import { organizationAllowedIps, organizations } from "@/db/schema"
import { db } from "@/lib/db"
import { CACHE_TTL, getCached, invalidateByPrefix, scopedCacheKey } from "@/lib/cache-utils"
import {
  allowlistEntryKey,
  ipMatchesAllowlist,
  parseAllowlistEntry,
  type AllowlistEntry,
} from "@/lib/security/ip-allowlist"

export const NETWORK_POLICY_CACHE_PREFIX = "org-network-policy"

// An access-control change must converge quickly even when best-effort cache
// invalidation fails on one instance, so this is far shorter than CACHE_TTL.SETTINGS.
const NETWORK_POLICY_CACHE_TTL_SECONDS = 30

export type OrganizationNetworkPolicy = {
  enabled: boolean
  entries: AllowlistEntry[]
}

/**
 * "unavailable" is distinct from "denied" on purpose: a lookup failure must
 * surface as a retryable error rather than silently locking a tenant out or,
 * worse, silently letting an outside address through.
 */
export type NetworkAccessDecision = "allowed" | "denied" | "unavailable"

export type NetworkAccessInput = {
  role: unknown
  organizationId: unknown
  clientIp: string | null
}

// Postgres SQLSTATEs for "undefined_column" and "undefined_table".
const MISSING_SCHEMA_ERROR_CODES = new Set(["42703", "42P01"])

/**
 * True when the failure is the feature's own schema being absent, which means
 * the code was deployed ahead of its migration. Any other failure is a genuine
 * outage and must not be mistaken for this.
 */
function isMissingSchemaError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return typeof code === "string" && MISSING_SCHEMA_ERROR_CODES.has(code)
}

function normalizeOrganizationId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Read a tenant's private-network policy. Throws when the policy cannot be
 * read; callers decide how an unreadable policy is handled.
 */
export async function loadOrganizationNetworkPolicy(
  organizationId: number,
): Promise<OrganizationNetworkPolicy> {
  const cacheKey = scopedCacheKey(NETWORK_POLICY_CACHE_PREFIX, { orgId: organizationId })

  return getCached<OrganizationNetworkPolicy>(
    cacheKey,
    async () => {
      const [organization] = await db
        .select({ enabled: organizations.privateNetworkLoginEnabled })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1)

      // A disabled tenant costs one indexed primary-key read and no join.
      if (!organization?.enabled) return { enabled: false, entries: [] }

      const rows = await db
        .select({
          ipAddress: organizationAllowedIps.ipAddress,
          prefixLength: organizationAllowedIps.prefixLength,
        })
        .from(organizationAllowedIps)
        .where(eq(organizationAllowedIps.organizationId, organizationId))

      return { enabled: true, entries: rows }
    },
    Math.min(CACHE_TTL.SETTINGS, NETWORK_POLICY_CACHE_TTL_SECONDS),
  )
}

export async function invalidateOrganizationNetworkPolicyCache(): Promise<void> {
  await invalidateByPrefix(NETWORK_POLICY_CACHE_PREFIX)
}

/**
 * Decide whether a principal may hold a session from the given address.
 *
 * Platform Super Admins are always exempt so a mistaken allowlist can never
 * lock the platform owner out of the tool needed to repair it. Principals with
 * no organization have no tenant policy to apply.
 */
export async function evaluateNetworkAccess(
  input: NetworkAccessInput,
): Promise<NetworkAccessDecision> {
  if (input.role === "SUPER_ADMIN") return "allowed"

  const organizationId = normalizeOrganizationId(input.organizationId)
  if (organizationId === null) return "allowed"

  let policy: OrganizationNetworkPolicy
  try {
    policy = await loadOrganizationNetworkPolicy(organizationId)
  } catch (error) {
    // Deployed ahead of the migration: without the schema the restriction
    // cannot be enabled for anyone, so nothing is being bypassed. Blocking here
    // would instead lock every tenant out during a routine deploy window.
    if (isMissingSchemaError(error)) {
      console.error(
        "[Auth] Private network login schema is missing; run the pending migration. Treating tenants as unrestricted.",
        { organizationId },
      )
      return "allowed"
    }

    console.error("[Auth] Unable to resolve the organization network policy:", error)
    return "unavailable"
  }

  if (!policy.enabled) return "allowed"

  // The API refuses to leave a tenant enabled with an empty allowlist, so this
  // state is only reachable by editing the database directly. Denying here
  // would lock out every member with no in-app way back in, and anyone able to
  // reach the rows directly could clear the flag anyway — so allow, loudly.
  if (policy.entries.length === 0) {
    console.error(
      "[Auth] Private network login is enabled with an empty allowlist; allowing access",
      { organizationId },
    )
    return "allowed"
  }

  return ipMatchesAllowlist(input.clientIp, policy.entries) ? "allowed" : "denied"
}

export type PrivateNetworkLoginInput = {
  enabled: boolean
  entries: Array<{ value: string; label?: string | null }>
}

export type AllowedIpRow = {
  ipAddress: string
  prefixLength: number
  label: string | null
}

export type PrivateNetworkLoginResolution =
  | { ok: true; rows: AllowedIpRow[] }
  | { ok: false; message: string }

const MAX_REPORTED_INVALID_VALUES = 5

/**
 * Turn submitted entries into storable rows, rejecting the whole submission if
 * any value is unparseable. Partial acceptance is deliberately not offered: an
 * administrator who mistypes one address must not be left believing a network
 * is allowed when it was silently dropped.
 */
export function resolvePrivateNetworkLoginRows(
  input: PrivateNetworkLoginInput,
): PrivateNetworkLoginResolution {
  const rows: AllowedIpRow[] = []
  const invalidValues: string[] = []
  const seen = new Set<string>()

  for (const entry of input.entries) {
    const parsed = parseAllowlistEntry(entry.value)
    if (!parsed) {
      invalidValues.push(entry.value.trim())
      continue
    }

    const key = allowlistEntryKey(parsed)
    if (seen.has(key)) continue
    seen.add(key)

    rows.push({
      ipAddress: parsed.ipAddress,
      prefixLength: parsed.prefixLength,
      label: entry.label?.trim() || null,
    })
  }

  if (invalidValues.length > 0) {
    const shown = invalidValues.slice(0, MAX_REPORTED_INVALID_VALUES).join(", ")
    const remaining = invalidValues.length - MAX_REPORTED_INVALID_VALUES
    const suffix = remaining > 0 ? ` (and ${remaining} more)` : ""
    return {
      ok: false,
      message: `Enter a valid IP address or CIDR range. Not valid: ${shown}${suffix}`,
    }
  }

  // Enabling with nothing allowed would lock every member out of the tenant.
  if (input.enabled && rows.length === 0) {
    return {
      ok: false,
      message: "Add at least one IP address before enabling private network login",
    }
  }

  return { ok: true, rows }
}

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Replace a tenant's allowlist wholesale inside the caller's transaction, so an
 * edit is never observable as a half-applied set of allowed networks.
 */
export async function replaceOrganizationAllowedIps(
  tx: TransactionExecutor,
  params: {
    organizationId: number
    rows: AllowedIpRow[]
    actorUserId: string
  },
): Promise<void> {
  await tx
    .delete(organizationAllowedIps)
    .where(eq(organizationAllowedIps.organizationId, params.organizationId))

  if (params.rows.length === 0) return

  await tx.insert(organizationAllowedIps).values(
    params.rows.map((row) => ({
      organizationId: params.organizationId,
      ipAddress: row.ipAddress,
      prefixLength: row.prefixLength,
      label: row.label,
      createdBy: params.actorUserId,
    })),
  )
}
