import { and, eq } from "drizzle-orm"

import { organizationSettings } from "@/db/schema"
import { db } from "@/lib/db"
import {
  DEFAULT_TAX_RATE_BP,
  TAX_RATE_SETTING_KEY,
  isValidTaxRateBp,
  taxRatePercentToBp,
} from "@/lib/tax"

/**
 * Read an organization's default sales-tax rate.
 *
 * The stored setting is a percentage exactly as a human enters it: 18 means
 * 18%. It is converted to basis points here and nowhere else.
 *
 * The setting predates this feature and was originally validated as a 0-1
 * fraction, so the migration that introduced tax normalises every stored value
 * to a percentage first. Keeping a single interpretation matters more than
 * being lenient: reading "1" as either 1% or 100% depending on a heuristic is
 * exactly the kind of ambiguity that produces a hundredfold tax error.
 */
export async function getOrganizationTaxRateBp(organizationId: unknown): Promise<number> {
  const orgId = Number(organizationId)
  if (!Number.isFinite(orgId) || orgId <= 0) return DEFAULT_TAX_RATE_BP

  // A single indexed row read, deliberately uncached: a rate change has to be
  // in force for the very next order, and caching it would let an order be
  // priced against a rate the organization has already moved away from.
  const settings = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(
      and(
        eq(organizationSettings.organizationId, orgId),
        eq(organizationSettings.key, TAX_RATE_SETTING_KEY),
      )
    )
    .limit(1)

  if (settings.length === 0) return DEFAULT_TAX_RATE_BP
  return parseStoredTaxRatePercent(settings[0]?.value)
}

/**
 * Interpret a stored `tax_rate` value, which is a percentage.
 *
 * A row that is present but unreadable falls back to the standard rate rather
 * than to zero, because a malformed setting means "nobody knows", and treating
 * that as untaxed would silently under-report output tax on every order. A
 * value of exactly 0 is honoured as a deliberate zero rate.
 */
export function parseStoredTaxRatePercent(value: unknown): number {
  const bp = taxRatePercentToBp(typeof value === "number" ? value : Number.NaN)
  return isValidTaxRateBp(bp) ? bp : DEFAULT_TAX_RATE_BP
}
