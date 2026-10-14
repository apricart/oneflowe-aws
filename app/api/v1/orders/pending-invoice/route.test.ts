import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  rows: [] as Array<{ orderId: number; orderReference: string; invoiceNumber: string | null }>,
}))

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => mocks.rows }),
          }),
        }),
      }),
    }),
  },
}))

import { GET } from "./route"

beforeEach(() => {
  mocks.getCurrentUser.mockReset().mockResolvedValue({
    id: "user-1",
    email: "buyer@example.com",
    role: "ORDER_PORTAL",
    mustChangePassword: false,
  })
  mocks.rows = []
})

describe("GET /api/v1/orders/pending-invoice", () => {
  it("requires an authenticated user", async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    expect((await GET()).status).toBe(401)
  })

  it("honors the password-change boundary", async () => {
    mocks.getCurrentUser.mockResolvedValue({
      id: "user-1",
      email: "buyer@example.com",
      role: "ORDER_PORTAL",
      mustChangePassword: true,
    })
    expect((await GET()).status).toBe(403)
  })

  it("returns an uncached empty status when the user has no pending invoice", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0")
    expect(await response.json()).toEqual({ hasPendingInvoice: false, pendingInvoice: null })
  })

  it("returns only the safe summary needed by the notification", async () => {
    mocks.rows = [{ orderId: 7, orderReference: "TID-7", invoiceNumber: "INV-000007" }]
    const response = await GET()
    expect(await response.json()).toEqual({
      hasPendingInvoice: true,
      pendingInvoice: {
        orderId: 7,
        invoiceNumber: "INV-000007",
        orderReference: "TID-7",
      },
    })
  })

  it("falls back to the order reference for an older invoice snapshot", async () => {
    mocks.rows = [{ orderId: 7, orderReference: "TID-7", invoiceNumber: null }]
    expect((await (await GET()).json()).pendingInvoice.invoiceNumber).toBe("TID-7")
  })
})
