// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The helper issues two queries in order — the token hand-off, then the people
 * it needs to name — so the stub answers them from a queue rather than
 * pretending to be a database.
 */
const store = vi.hoisted(() => ({ results: [] as any[][] }))

vi.mock("@/lib/db", () => {
  const chain = (): any => {
    const builder: any = {
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      then: (resolve: any, reject: any) =>
        Promise.resolve(store.results.shift() ?? []).then(resolve, reject),
    }
    return builder
  }
  return { db: { select: () => chain() } }
})

import { loadInvoiceParticipants } from "@/lib/server/invoice-participants"

const INITIATOR = "user-initiator"
const APPROVER = "user-approver"
const TOKEN_SENDER = "user-token-sender"
const ADMIN = "user-super-admin"

const order = {
  id: 1904,
  createdByUserId: INITIATOR,
  approvedByUserId: APPROVER,
  status: "FULFILLED",
  fulfilledAt: new Date("2026-08-27T09:00:00.000Z"),
}

const people = [
  { id: INITIATOR, fullName: "Salman Akram", phone: "0341-7679658" },
  { id: APPROVER, fullName: "Salman Khan", phone: null },
  { id: TOKEN_SENDER, fullName: "Ayesha Khan", phone: null },
  { id: ADMIN, fullName: "Super Admin", phone: null },
]

beforeEach(() => {
  store.results = []
})

describe("who the invoice names as the fulfiller", () => {
  it("names the person who sent the fulfilment token, not the administrator who redeemed it", async () => {
    store.results = [[{ userId: TOKEN_SENDER }], people]

    const participants = await loadInvoiceParticipants(order)

    expect(participants.fulfilledByName).toBe("Ayesha Khan")
    expect(participants.fulfilledByName).not.toBe("Super Admin")
  })

  /**
   * A token shared by hand — email, chat, over a desk — leaves no record of
   * who sent it. The approver holds the plaintext token, so they are named
   * rather than the administrator who typed it into the fulfil dialog.
   */
  it("falls back to the approver when the token was handed over outside the app", async () => {
    store.results = [[], people]

    const participants = await loadInvoiceParticipants(order)

    expect(participants.fulfilledByName).toBe("Salman Khan")
    expect(participants.fulfilledByName).not.toBe("Super Admin")
  })

  it("never names the administrator who redeemed the token", async () => {
    store.results = [[], people]

    const participants = await loadInvoiceParticipants({ ...order, approvedByUserId: null })

    expect(participants.fulfilledByName).toBe("N/A")
  })

  it("reports an unresolvable sender rather than falling back to the administrator", async () => {
    store.results = [[{ userId: "user-since-deleted" }], people]

    const participants = await loadInvoiceParticipants(order)

    expect(participants.fulfilledByName).toBe("Unknown")
  })

  /**
   * The invoice is available from the moment the order exists, so most of the
   * invoices anyone previews are for orders that have not been settled. Those
   * have no fulfiller, and the approver must not be printed as one.
   */
  it("names no fulfiller on an approved order that has not been fulfilled", async () => {
    store.results = [people]

    const participants = await loadInvoiceParticipants({
      ...order,
      status: "APPROVED",
      fulfilledAt: null,
    })

    expect(participants.fulfilledByName).toBe("N/A")
    expect(participants.approvedByName).toBe("Salman Khan")
  })

  it("names no fulfiller on a pending order", async () => {
    store.results = [people]

    const participants = await loadInvoiceParticipants({
      ...order,
      status: "PENDING",
      approvedByUserId: null,
      fulfilledAt: null,
    })

    expect(participants.fulfilledByName).toBe("N/A")
  })

  /**
   * A hand-off writes its audit entry whether or not the fulfilment behind it
   * actually claimed the order, so the entry alone is not a settlement.
   */
  it("names no fulfiller when a hand-off was recorded but the order never settled", async () => {
    store.results = [[{ userId: TOKEN_SENDER }], people]

    const participants = await loadInvoiceParticipants({
      ...order,
      status: "APPROVED",
      fulfilledAt: null,
    })

    expect(participants.fulfilledByName).toBe("N/A")
  })

  it("names no fulfiller on a rejected or cancelled order", async () => {
    store.results = [people]

    const participants = await loadInvoiceParticipants({
      ...order,
      status: "REJECTED",
      fulfilledAt: null,
    })

    expect(participants.fulfilledByName).toBe("N/A")
  })

  /** A refund is applied to an order that was fulfilled first. */
  it("keeps the fulfiller on a refunded order", async () => {
    store.results = [[{ userId: TOKEN_SENDER }], people]

    const participants = await loadInvoiceParticipants({
      ...order,
      status: "REFUNDED",
      fulfilledAt: null,
    })

    expect(participants.fulfilledByName).toBe("Ayesha Khan")
  })

  it("still names the initiator and the approver from the order itself", async () => {
    store.results = [[{ userId: TOKEN_SENDER }], people]

    const participants = await loadInvoiceParticipants(order)

    expect(participants.placedByName).toBe("Salman Akram")
    expect(participants.placedByPhone).toBe("0341-7679658")
    expect(participants.approvedByName).toBe("Salman Khan")
  })

  it("reports no approver for an order that was never approved", async () => {
    store.results = [[], people]

    const participants = await loadInvoiceParticipants({ ...order, approvedByUserId: null })

    expect(participants.approvedByName).toBe("N/A")
  })
})
