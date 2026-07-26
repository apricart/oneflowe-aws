import { NextRequest } from "next/server"

import { error, ok } from "@/lib/api"
import { env } from "@/lib/server/env"
import { processOrderEmailOutbox } from "@/lib/server/order-notifications"

export async function POST(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
    return error("Unauthorized", 401)
  }

  const body = await req.json().catch(() => ({}))
  const requestedLimit = Number(body?.limit)
  const limit = Number.isInteger(requestedLimit) ? requestedLimit : 25

  try {
    const result = await processOrderEmailOutbox({ limit })
    console.info("[OrderNotifications] Scheduled outbox processing complete", result)
    return ok(result)
  } catch (processingError) {
    console.error("[OrderNotifications] Scheduled outbox processing failed", {
      error: processingError instanceof Error ? processingError.name : "UnknownError",
    })
    return error("Order email processing failed", 500)
  }
}
