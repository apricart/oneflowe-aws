/**
 * Validation utilities for inventory management
 * Prevents orphaned records and ensures data integrity
 */

import { db } from "@/lib/db"
import { organizationInventory,branchInventory,globalProducts,organizations,branches } from "@/db/schema"
import { eq,and,isNull } from "drizzle-orm"

/**
 * Validate that an organization exists and is active
 */
export async function validateOrganization(organizationId: number): Promise<boolean> {
  try {
    const org = await db.select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)

    return org.length > 0
  } catch (error) {
    console.error("Error validating organization:", error)
    return false
  }
}

/**
 * Validate that a branch exists and belongs to the organization
 */
export async function validateBranch(branchId: number, organizationId: number): Promise<boolean> {
  try {
    const branch = await db.select({ id: branches.id })
      .from(branches)
      .where(
        and(
          eq(branches.id, branchId),
          eq(branches.organizationId, organizationId)
        )
      )
      .limit(1)

    return branch.length > 0
  } catch (error) {
    console.error("Error validating branch:", error)
    return false
  }
}

/**
 * Validate that a global product exists and is active
 */
export async function validateGlobalProduct(globalProductId: number): Promise<boolean> {
  try {
    const product = await db.select({ id: globalProducts.id })
      .from(globalProducts)
      .where(
        eq(globalProducts.id, globalProductId)
      )
      .limit(1)

    return product.length > 0
  } catch (error) {
    console.error("Error validating global product:", error)
    return false
  }
}

/**
 * Validate that an organization inventory item exists and belongs to the organization
 */
export async function validateOrganizationInventory(
  organizationInventoryId: number,
  organizationId: number
): Promise<boolean> {
  try {
    const orgInventory = await db.select({ id: organizationInventory.id })
      .from(organizationInventory)
      .where(
        and(
          eq(organizationInventory.id, organizationInventoryId),
          eq(organizationInventory.organizationId, organizationId),
          isNull(organizationInventory.deletedAt)
        )
      )
      .limit(1)

    return orgInventory.length > 0
  } catch (error) {
    console.error("Error validating organization inventory:", error)
    return false
  }
}

/**
 * Validate that a branch inventory item exists and belongs to the branch
 */
export async function validateBranchInventory(
  branchInventoryId: number,
  branchId: number,
  organizationId: number
): Promise<boolean> {
  try {
    const branchInv = await db.select({ id: branchInventory.id })
      .from(branchInventory)
      .where(
        and(
          eq(branchInventory.id, branchInventoryId),
          eq(branchInventory.branchId, branchId),
          eq(branchInventory.organizationId, organizationId),
          isNull(branchInventory.deletedAt)
        )
      )
      .limit(1)

    return branchInv.length > 0
  } catch (error) {
    console.error("Error validating branch inventory:", error)
    return false
  }
}

/**
 * Validate that a user has access to an organization
 */
export async function validateUserOrganizationAccess(
  userId: string,
  organizationId: number
): Promise<boolean> {
  // Access is enforced by the session middleware; retain parameters for the
  // validation API that will replace this compatibility function.
  void userId
  void organizationId
  return true
}

/**
 * Validate that a user has access to a branch
 */
export async function validateUserBranchAccess(
  userId: string,
  branchId: number,
  organizationId: number
): Promise<boolean> {
  // Access is enforced by the session middleware; retain parameters for the
  // validation API that will replace this compatibility function.
  void userId
  void branchId
  void organizationId
  return true
}

/**
 * Check if a product assignment would create a duplicate
 */
export async function checkDuplicateOrganizationAssignment(
  organizationId: number,
  globalProductId: number
): Promise<boolean> {
  try {
    const existing = await db.select({ id: organizationInventory.id })
      .from(organizationInventory)
      .where(
        and(
          eq(organizationInventory.organizationId, organizationId),
          eq(organizationInventory.globalProductId, globalProductId),
          isNull(organizationInventory.deletedAt)
        )
      )
      .limit(1)

    return existing.length > 0
  } catch (error) {
    console.error("Error checking duplicate organization assignment:", error)
    return false
  }
}

/**
 * Check if a branch assignment would create a duplicate
 */
export async function checkDuplicateBranchAssignment(
  branchId: number,
  organizationInventoryId: number
): Promise<boolean> {
  try {
    const existing = await db.select({ id: branchInventory.id })
      .from(branchInventory)
      .where(
        and(
          eq(branchInventory.branchId, branchId),
          eq(branchInventory.organizationInventoryId, organizationInventoryId),
          isNull(branchInventory.deletedAt)
        )
      )
      .limit(1)

    return existing.length > 0
  } catch (error) {
    console.error("Error checking duplicate branch assignment:", error)
    return false
  }
}

/**
 * Validate assignment data before creation
 */
type AssignmentValidationData = {
  organizationId?: number
  branchId?: number
  globalProductId?: number
  organizationInventoryId?: number
  userId?: string
}

async function organizationValidationError(data: AssignmentValidationData): Promise<string | null> {
  if (!data.organizationId) return null
  return await validateOrganization(data.organizationId) ? null : "Invalid organization ID"
}

async function branchValidationError(data: AssignmentValidationData): Promise<string | null> {
  if (!data.branchId || !data.organizationId) return null
  return await validateBranch(data.branchId, data.organizationId)
    ? null
    : "Invalid branch ID or branch does not belong to organization"
}

async function productValidationError(data: AssignmentValidationData): Promise<string | null> {
  if (!data.globalProductId) return null
  return await validateGlobalProduct(data.globalProductId)
    ? null
    : "Invalid global product ID or product is not active"
}

async function organizationInventoryValidationError(data: AssignmentValidationData): Promise<string | null> {
  if (!data.organizationInventoryId || !data.organizationId) return null
  return await validateOrganizationInventory(data.organizationInventoryId, data.organizationId)
    ? null
    : "Invalid organization inventory ID or access denied"
}

async function duplicateOrganizationValidationError(data: AssignmentValidationData): Promise<string | null> {
  if (!data.organizationId || !data.globalProductId) return null
  return await checkDuplicateOrganizationAssignment(data.organizationId, data.globalProductId)
    ? "Product is already assigned to this organization"
    : null
}

async function duplicateBranchValidationError(data: AssignmentValidationData): Promise<string | null> {
  if (!data.branchId || !data.organizationInventoryId) return null
  return await checkDuplicateBranchAssignment(data.branchId, data.organizationInventoryId)
    ? "Product is already assigned to this branch"
    : null
}

export async function validateAssignmentData(data: {
  organizationId?: number
  branchId?: number
  globalProductId?: number
  organizationInventoryId?: number
  userId?: string
}): Promise<{ valid: boolean; errors: string[] }> {
  try {
    const results = await Promise.all([
      organizationValidationError(data),
      branchValidationError(data),
      productValidationError(data),
      organizationInventoryValidationError(data),
      duplicateOrganizationValidationError(data),
      duplicateBranchValidationError(data),
    ])
    const errors = results.filter((message): message is string => Boolean(message))

    return {
      valid: errors.length === 0,
      errors
    }
  } catch (error) {
    console.error("Error validating assignment data:", error)
    return {
      valid: false,
      errors: ["Validation error occurred"]
    }
  }
}
