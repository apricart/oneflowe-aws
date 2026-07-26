/**
 * Controlled, one-time SUPER_ADMIN bootstrap.
 *
 * The password is read only from SUPER_ADMIN_PASSWORD so it is not exposed in
 * shell history or the process argument list. Remove both bootstrap variables
 * from the environment immediately after successful use.
 */

import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'

import { auditLogs, roles, users } from '@/db/schema'
import { db } from '@/lib/db-cli'
import { loadBootstrapEnv } from '@/lib/server/bootstrap-env'

const CONFIRMATION = '--confirm=CREATE_SUPER_ADMIN'

async function main() {
  if (!process.argv.includes(CONFIRMATION)) {
    throw new Error(`Administrator bootstrap requires ${CONFIRMATION}`)
  }

  const bootstrapEnv = loadBootstrapEnv()
  const [superAdminRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'SUPER_ADMIN'))
    .limit(1)

  if (!superAdminRole) {
    throw new Error('SUPER_ADMIN role not found; run npm run db:seed first')
  }

  const [existingAdministrator] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(roles.name, 'SUPER_ADMIN'))
    .limit(1)

  if (existingAdministrator) {
    throw new Error('Administrator bootstrap refused because a SUPER_ADMIN already exists')
  }

  const passwordHash = await bcrypt.hash(bootstrapEnv.SUPER_ADMIN_PASSWORD, 12)
  const createdId = await db.transaction(async (transaction) => {
    const [created] = await transaction
      .insert(users)
      .values({
        email: bootstrapEnv.SUPER_ADMIN_EMAIL,
        passwordHash,
        roleId: superAdminRole.id,
        fullName: 'Super Admin',
        isActive: true,
        mustChangePassword: true,
      })
      .returning({ id: users.id })

    if (!created) throw new Error('Administrator bootstrap did not create a user')

    await transaction.insert(auditLogs).values({
      userId: created.id,
      action: 'SUPER_ADMIN_BOOTSTRAPPED',
      entity: 'User',
      entityId: created.id,
      metadata: { source: 'controlled-one-time-bootstrap' },
    })

    return created.id
  })

  console.log(`SUPER_ADMIN bootstrap completed for user id ${createdId}.`)
  console.log('Remove SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD from the environment now.')
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Administrator bootstrap failed')
    process.exit(1)
  })
