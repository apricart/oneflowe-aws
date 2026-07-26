/**
 * General database seed.
 *
 * This script intentionally creates only non-secret reference data. Creating a
 * production administrator is a separate, explicit one-time bootstrap action.
 */

import { eq } from 'drizzle-orm'

import { organizationSettings, organizations, rolePermissions, roles } from '@/db/schema'
import { db } from '@/lib/db-cli'
import { ROLE_TEMPLATES, type Permission } from '@/lib/permissions'

const DEFAULT_SETTINGS = [
  { key: 'default_currency', value: 'PKR' },
  { key: 'tax_rate', value: 0 },
  { key: 'auto_approve_orders', value: false },
  { key: 'order_approval_threshold', value: 10000 },
  { key: 'require_mfa', value: false },
  { key: 'session_timeout_minutes', value: 60 },
  { key: 'low_stock_threshold', value: 10 },
  { key: 'enable_notifications', value: true },
  { key: 'hide_prices_for_branch_admin', value: false },
  { key: 'hide_prices_for_order_portal', value: false },
]

async function seed() {
  console.log('Starting database seed...')

  const roleNames = ['SUPER_ADMIN', 'HEAD_OFFICE', 'BRANCH_ADMIN', 'ORDER_PORTAL'] as const
  for (const roleName of roleNames) {
    const [existingRole] = await db
      .select()
      .from(roles)
      .where(eq(roles.name, roleName))
      .limit(1)

    if (!existingRole) {
      await db.insert(roles).values({
        name: roleName,
        description: ROLE_TEMPLATES[roleName].description,
        permissions: {},
      })
      console.log(`Created role: ${roleName}`)
    }
  }

  const allRoles = await db.select().from(roles)
  for (const role of allRoles) {
    const template = ROLE_TEMPLATES[role.name as keyof typeof ROLE_TEMPLATES]
    if (!template) continue

    const templatePermissions = template.permissions as Permission[]
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id))

    if (templatePermissions.length > 0) {
      await db.insert(rolePermissions).values(
        templatePermissions.map((permissionKey) => ({
          roleId: role.id,
          permissionKey,
          allowed: true,
        })),
      )
    }

    const permissions = Object.fromEntries(
      templatePermissions.map((permissionKey) => [permissionKey, true]),
    )
    await db
      .update(roles)
      .set({ permissions, updatedAt: new Date() })
      .where(eq(roles.id, role.id))
  }

  const allOrganizations = await db.select().from(organizations)
  for (const organization of allOrganizations) {
    const existingSettings = await db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organization.id))
    const existingKeys = new Set(existingSettings.map((setting) => setting.key))

    const missingSettings = DEFAULT_SETTINGS.filter((setting) => !existingKeys.has(setting.key))
    if (missingSettings.length > 0) {
      await db.insert(organizationSettings).values(
        missingSettings.map((setting) => ({
          organizationId: organization.id,
          key: setting.key,
          value: setting.value,
        })),
      )
    }
  }

  console.log(
    `Database seed complete: ${allRoles.length} roles and ${allOrganizations.length} organizations processed.`,
  )
  return { success: true }
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch(() => {
      console.error('Database seed failed.')
      process.exit(1)
    })
}

export { seed }
