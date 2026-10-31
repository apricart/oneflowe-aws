import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { PROCUREMENT_READ_ROLES, PROCUREMENT_SETTINGS_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { loadProcurementSettings, updateProcurementSettings } from "@/lib/server/procurement"
import { caughtResponse, json, procurementActor } from "@/lib/server/procurement-route"
import { procurementSettingsSchema } from "@/lib/server/procurement-validation"

/**
 * The over-delivery tolerance: read by everyone in purchasing, changed by
 * Super Admin only (audited `UPDATE_PROCUREMENT_SETTINGS`). A change applies to
 * POs approved after it; an approved PO keeps its own snapshot.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET() {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_READ_ROLES])
    if (roleError) return roleError
    return json(await loadProcurementSettings(db))
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/settings")
  }
}

export async function PUT(req: Request) {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_SETTINGS_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = procurementSettingsSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    return json(await updateProcurementSettings({ ...parsed.data, actor: procurementActor(user) }))
  } catch (caught) {
    return caughtResponse(caught, "PUT /api/v1/procurement/settings")
  }
}
