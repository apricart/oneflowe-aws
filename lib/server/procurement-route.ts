import "server-only"

import { NextResponse } from "next/server"

import { handleError } from "@/lib/error-handler"
import type { ProcurementActor } from "@/lib/server/procurement"
import { STOCK_LEDGER_GLOBAL_MESSAGE } from "@/lib/server/procurement"
import { isStockLedgerMissing } from "@/lib/server/warehouse-stock-errors"

/**
 * What every purchasing handler shares: the response headers, the actor, how a
 * domain outcome becomes a status, and the answer before the migration exists.
 * Authentication and the capability check stay in each handler, where the
 * contract tests read them. See plans/OF-PROCUREMENT-purchasing.md.
 */

export const NO_STORE = { "Cache-Control": "private, no-store" }

export const PROCUREMENT_MISSING_MESSAGE = "Purchasing is not set up yet: apply migration 20261106120000 first."

export function procurementActor(user: { id: string; role: string; email?: string | null }): ProcurementActor {
  return { id: user.id, role: user.role, email: user.email ?? null }
}

/** A JSON body with the no-store header. */
export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

type FailureOutcome =
  | { kind: "not-found" }
  | { kind: "warehouse-not-found" }
  | { kind: "forbidden"; error: string }
  | { kind: "refused"; error: string }
  | { kind: "conflict"; error: string }
  | { kind: "duplicate" }
  | { kind: "stock-ledger-global" }

/** The response for a failed outcome; null when the outcome is a success the handler shapes itself. */
export function failureResponse(outcome: { kind: string } & Partial<{ error: string }>): NextResponse | null {
  const failure = outcome as FailureOutcome
  switch (failure.kind) {
    case "not-found":
      return json({ error: "Not found" }, 404)
    case "warehouse-not-found":
      return json({ error: "Warehouse not found" }, 404)
    case "forbidden":
      return json({ error: failure.error }, 403)
    case "refused":
      return json({ error: failure.error }, 400)
    case "conflict":
      return json({ error: failure.error }, 409)
    case "duplicate":
      return json({ error: "That already exists." }, 409)
    case "stock-ledger-global":
      return json({ error: STOCK_LEDGER_GLOBAL_MESSAGE, code: "STOCK_LEDGER_GLOBAL" }, 409)
    default:
      return null
  }
}

/** A thrown error: 503 before the migration is applied, otherwise the safe message. */
export function caughtResponse(caught: unknown, label: string): NextResponse {
  if (isStockLedgerMissing(caught)) return json({ error: PROCUREMENT_MISSING_MESSAGE }, 503)
  const handled = handleError(caught, label)
  return json({ error: handled.message }, handled.status)
}

/** A positive integer route id, or null. */
export function routeId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null
}
