import { db } from "@/lib/db"
import { roles, rolePermissions, auditLogs } from "@/db/schema"
import { eq } from "drizzle-orm"
import { ok, err, requireApiRole } from "@/lib/api"
import { NextRequest } from "next/server"
import { Permission } from "@/lib/permissions"
import {
  rolePermissionCreateSchema,
  rolePermissionReplaceSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"

const validPermissionKeys = new Set<string>(Object.values(Permission))

export async function GET(req: NextRequest) {
  const authErr = await requireApiRole(["SUPER_ADMIN"])
  if (authErr) return authErr

  const roleId = req.nextUrl.searchParams.get("roleId")

  if (roleId) {
    const permissions = await db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, parseInt(roleId)))

    return ok({ data: permissions })
  }

  const allRoles = await db.select().from(roles)
  const allPermissions = await db.select().from(rolePermissions)

  return ok({
    data: {
      roles: allRoles,
      permissions: allPermissions,
    }
  })
}

export async function POST(req: NextRequest) {
  const authErr = await requireApiRole(["SUPER_ADMIN"])
  if (authErr) return authErr

  try {
    const rawBody = await req.json().catch(() => null)
    const parsedBody = rolePermissionCreateSchema.safeParse(rawBody)
    if (!parsedBody.success) return err(validationMessage(parsedBody.error), 400)
    const { roleId, permissionKey, allowed } = parsedBody.data
    if (!validPermissionKeys.has(permissionKey)) return err("Invalid permission key", 400)

    const [targetRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1)
    if (!targetRole) return err("Invalid role", 400)

    // Insert new permission
    const [newPermission] = await db
      .insert(rolePermissions)
      .values({
        roleId,
        permissionKey,
        allowed,
      })
      .returning()

    // Log the action
    await db.insert(auditLogs).values({
      action: "CREATE_PERMISSION",
      entity: "role_permissions",
      entityId: newPermission.id.toString(),
      metadata: { roleId, permissionKey, allowed },
    })

    return ok({ data: newPermission })
  } catch (error: any) {
    return err("Failed to create permission", 500)
  }
}

export async function PUT(req: NextRequest) {
  const authErr = await requireApiRole(["SUPER_ADMIN"])
  if (authErr) return authErr

  try {
    const rawBody = await req.json().catch(() => null)
    const parsedBody = rolePermissionReplaceSchema.safeParse(rawBody)
    if (!parsedBody.success) return err(validationMessage(parsedBody.error), 400)
    const { roleId } = parsedBody.data
    const permissions = [...new Set(parsedBody.data.permissions)]
    if (permissions.some((key) => !validPermissionKeys.has(key))) {
      return err("Invalid permission key", 400)
    }

    const [targetRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1)
    if (!targetRole) return err("Invalid role", 400)

    // Delete existing permissions for this role
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId))

    // Insert new permissions
    if (permissions.length > 0) {
      const permissionValues = permissions.map((key: string) => ({
        roleId,
        permissionKey: key,
        allowed: true,
      }))

      await db.insert(rolePermissions).values(permissionValues)
    }

    // Update role's permissions JSONB field for backward compatibility
    const permissionsObj = permissions.reduce((acc: any, key: string) => {
      acc[key] = true
      return acc
    }, {})

    await db
      .update(roles)
      .set({
        permissions: permissionsObj,
        updatedAt: new Date(),
      })
      .where(eq(roles.id, roleId))

    // Log the action
    await db.insert(auditLogs).values({
      action: "UPDATE_ROLE_PERMISSIONS",
      entity: "roles",
      entityId: roleId.toString(),
      metadata: { permissions },
    })

    return ok({ message: "Permissions updated successfully" })
  } catch (error: any) {
    return err("Failed to update permissions", 500)
  }
}

export async function DELETE(req: NextRequest) {
  const authErr = await requireApiRole(["SUPER_ADMIN"])
  if (authErr) return authErr

  try {
    const { searchParams } = req.nextUrl
    const id = searchParams.get("id")

    if (!id) {
      return err("Permission id is required", 400)
    }

    await db.delete(rolePermissions).where(eq(rolePermissions.id, parseInt(id)))

    // Log the action
    await db.insert(auditLogs).values({
      action: "DELETE_PERMISSION",
      entity: "role_permissions",
      entityId: id,
    })

    return ok({ message: "Permission deleted successfully" })
  } catch (error: any) {
    return err("Failed to delete permission", 500)
  }
}

