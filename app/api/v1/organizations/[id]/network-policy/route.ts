import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { auditLogs, organizationAllowedIps, organizations } from "@/db/schema"
import { asc, eq } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { logError } from "@/lib/global-logger"
import { invalidateByPrefix } from "@/lib/cache-utils"
import {
  invalidateOrganizationNetworkPolicyCache,
  replaceOrganizationAllowedIps,
  resolvePrivateNetworkLoginRows,
} from "@/lib/server/network-policy"
import { privateNetworkLoginSchema, validationMessage } from "@/lib/server/mutation-validation"
import { formatAllowlistEntry } from "@/lib/security/ip-allowlist"

export const dynamic = "force-dynamic"

function parseOrganizationId(value: string): number | null {
  const organizationId = Number(value)
  return Number.isInteger(organizationId) && organizationId > 0 ? organizationId : null
}

/**
 * GET /api/v1/organizations/:id/network-policy
 *
 * Kept off the shared /api/v1/settings endpoint, which HEAD_OFFICE can reach.
 * Who may reach a tenant at all is a platform-level control, so both methods
 * here are SUPER_ADMIN only.
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN"])
  if (authError) return authError

  try {
    const { id } = await props.params
    const organizationId = parseOrganizationId(id)
    if (organizationId === null) return error("Invalid organization ID", 400)

    const [organization] = await db
      .select({ enabled: organizations.privateNetworkLoginEnabled })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)

    if (!organization) return error("Organization not found", 404)

    const rows = await db
      .select({
        ipAddress: organizationAllowedIps.ipAddress,
        prefixLength: organizationAllowedIps.prefixLength,
        label: organizationAllowedIps.label,
      })
      .from(organizationAllowedIps)
      .where(eq(organizationAllowedIps.organizationId, organizationId))
      .orderBy(asc(organizationAllowedIps.id))

    return ok({
      enabled: organization.enabled,
      entries: rows.map((row) => ({
        value: formatAllowlistEntry(row),
        label: row.label,
      })),
    })
  } catch (e: any) {
    logError(e, "ORGANIZATION_NETWORK_POLICY_GET")
    return error("Failed to load private network login settings", 500)
  }
}

/**
 * PUT /api/v1/organizations/:id/network-policy
 *
 * Replaces the toggle and the whole allowlist in one transaction. Whole-set
 * replacement matches the editor UI and removes any window in which a partially
 * applied list could be enforced.
 */
export async function PUT(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN"])
  if (authError) return authError

  try {
    const { id } = await props.params
    const organizationId = parseOrganizationId(id)
    if (organizationId === null) return error("Invalid organization ID", 400)

    const rawBody = await readJson<unknown>(req)
    const parsedBody = privateNetworkLoginSchema.safeParse(rawBody)
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)

    const scope = await getRequestScope()
    if (!scope?.userId) return error("Invalid session data", 401)

    const resolved = resolvePrivateNetworkLoginRows(parsedBody.data)
    if (!resolved.ok) return error(resolved.message, 400)

    const enabled = parsedBody.data.enabled
    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ enabled: organizations.privateNetworkLoginEnabled })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for("update")
        .limit(1)

      if (!existing) return null

      await tx
        .update(organizations)
        .set({ privateNetworkLoginEnabled: enabled, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId))

      await replaceOrganizationAllowedIps(tx, {
        organizationId,
        rows: resolved.rows,
        actorUserId: scope.userId,
      })

      await tx.insert(auditLogs).values({
        userId: scope.userId,
        organizationId,
        action: "UPDATE_PRIVATE_NETWORK_LOGIN",
        entity: "organization",
        entityId: String(organizationId),
        metadata: {
          previousEnabled: existing.enabled,
          enabled,
          allowedNetworks: resolved.rows.map(formatAllowlistEntry),
        },
      })

      return { enabled }
    })

    if (!updated) return error("Organization not found", 404)

    // The login and session paths read this policy through a short-lived cache;
    // clear it so a revoked network stops working immediately rather than
    // within the TTL.
    await invalidateOrganizationNetworkPolicyCache()
    await invalidateByPrefix("organizations")

    return ok({
      enabled,
      entries: resolved.rows.map((row) => ({
        value: formatAllowlistEntry(row),
        label: row.label,
      })),
      message: "Private network login settings saved",
    })
  } catch (e: any) {
    logError(e, "ORGANIZATION_NETWORK_POLICY_PUT")
    return error("Failed to save private network login settings", 500)
  }
}
