import { NextResponse } from "next/server"

export type RiderErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INVALID_CREDENTIALS"
  | "RIDER_DISABLED"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR"

export function riderOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(
    {
      success: true,
      data,
      meta: { timestamp: new Date().toISOString() },
    },
    { status },
  )
}

export function riderFail(
  code: RiderErrorCode,
  message: string,
  status: number,
  details: unknown = null,
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code, message, details },
    },
    { status },
  )
}
