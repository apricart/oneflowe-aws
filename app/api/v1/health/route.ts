import { NextResponse } from "next/server"
import { Pool } from "pg"
import { env } from "@/lib/server/env"

export const runtime = "nodejs"

export async function GET() {
  const startedAt = Date.now()
  const details: Record<string, unknown> = {
    uptimeMs: process.uptime() * 1000,
    timestamp: new Date().toISOString(),
  }

  try {
    const pool = new Pool({ connectionString: env.DATABASE_URL })
    await pool.query("select 1")
    const elapsedMs = Date.now() - startedAt
    return NextResponse.json(
      {
        status: "ok",
        checks: { database: { ok: true, latencyMs: elapsedMs } },
        details,
      },
      { status: 200 }
    )
  } catch (error: unknown) {
    console.error(`[Health Check] Database failed:`, error)
    return NextResponse.json(
      {
        status: "error",
        checks: { database: { ok: false, error: "Database connection failed" } },
        details,
      },
      { status: 503 }
    )
  }
}
