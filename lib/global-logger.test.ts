import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The logger appends JSON lines to files under `<cwd>/logs`. `node:fs` is
 * replaced by an in-memory file table so the tests read back exactly what would
 * have been written — masking, routing between the three files, and rotation —
 * without touching the disk.
 */
const files = vi.hoisted(() => ({
  contents: new Map<string, string>(),
  sizes: new Map<string, number>(),
  dirs: new Set<string>(),
  failAppend: false,
}))

vi.mock("node:fs", () => {
  const api = {
    existsSync: (target: string) => files.contents.has(target) || files.dirs.has(target),
    mkdirSync: (target: string) => {
      files.dirs.add(target)
    },
    statSync: (target: string) => ({
      size: files.sizes.get(target) ?? (files.contents.get(target) ?? "").length,
    }),
    renameSync: (from: string, to: string) => {
      files.contents.set(to, files.contents.get(from) ?? "")
      files.contents.delete(from)
      files.sizes.delete(from)
    },
    appendFileSync: (target: string, content: string) => {
      if (files.failAppend) throw new Error("EACCES")
      files.contents.set(target, (files.contents.get(target) ?? "") + content)
    },
  }
  return { default: api, ...api }
})

import {
  getLogStats,
  logError,
  logEvent,
  logFulfillmentAttempt,
  logInventoryAction,
  logOrderActivity,
  logSecurityEvent,
  logTokenGenerated,
} from "./global-logger"

const LOG_DIR = path.join(process.cwd(), "logs")
const SYSTEM = path.join(LOG_DIR, "system-audit.log")
const ERRORS = path.join(LOG_DIR, "error.log")
const INVENTORY = path.join(LOG_DIR, "inventory-audit.log")

function lines(file: string): any[] {
  return (files.contents.get(file) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const user = { id: "u-1", email: "a@example.test", role: "SUPER_ADMIN" }

beforeEach(() => {
  files.contents.clear()
  files.sizes.clear()
  files.dirs.clear()
  files.failAppend = false
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("logEvent masking", () => {
  it("masks secret-looking keys at any depth, whatever their case", () => {
    logEvent({
      event: "X",
      details: {
        apiKey: "k1",
        API_KEY: "k2",
        Authorization: "Bearer t",
        nested: { newPassword: "p", otpCode: "1", keep: "v" },
        list: [{ accessToken: "t" }, { name: "n" }],
      },
    })

    const [entry] = lines(SYSTEM)
    expect(entry.details).toEqual({
      apiKey: "***MASKED***",
      API_KEY: "***MASKED***",
      Authorization: "***MASKED***",
      nested: { newPassword: "***MASKED***", otpCode: "***MASKED***", keep: "v" },
      list: [{ accessToken: "***MASKED***" }, { name: "n" }],
    })
  })

  it("logs an object shared by two siblings in full rather than calling it circular", () => {
    const shared = { sku: "A" }
    logEvent({ event: "X", details: { before: shared, after: shared } })
    expect(lines(SYSTEM)[0].details).toEqual({ before: { sku: "A" }, after: { sku: "A" } })
  })

  it("still breaks a real cycle", () => {
    const node: Record<string, unknown> = { name: "loop" }
    node.self = node
    logEvent({ event: "X", details: node })
    expect(lines(SYSTEM)[0].details).toEqual({ name: "loop", self: "[Circular Reference]" })
  })

  it("stamps a timestamp unless one is given", () => {
    logEvent({ event: "A" })
    logEvent({ event: "B", timestamp: "2026-01-01T00:00:00.000Z" })
    const [first, second] = lines(SYSTEM)
    expect(typeof first.timestamp).toBe("string")
    expect(second.timestamp).toBe("2026-01-01T00:00:00.000Z")
  })

  it("refuses an entry without an event name", () => {
    logEvent({ event: "" })
    expect(files.contents.has(SYSTEM)).toBe(false)
  })

  it("never throws when the disk refuses the write", () => {
    files.failAppend = true
    expect(() => logEvent({ event: "A" })).not.toThrow()
    expect(console.error).toHaveBeenCalled()
  })
})

describe("rotation", () => {
  it("rotates a full log aside before appending, shifting older generations", () => {
    files.contents.set(SYSTEM, "old\n")
    files.sizes.set(SYSTEM, 10 * 1024 * 1024)
    files.contents.set(`${SYSTEM}.1`, "older\n")

    logEvent({ event: "NEW" })

    expect(files.contents.get(`${SYSTEM}.2`)).toBe("older\n")
    expect(files.contents.get(`${SYSTEM}.1`)).toBe("old\n")
    expect(lines(SYSTEM).map((entry) => entry.event)).toEqual(["NEW"])
  })

  it("leaves a log under the limit alone", () => {
    files.contents.set(SYSTEM, "")
    files.sizes.set(SYSTEM, 10 * 1024 * 1024 - 1)
    logEvent({ event: "NEW" })
    expect(files.contents.has(`${SYSTEM}.1`)).toBe(false)
  })
})

describe("logError", () => {
  it("writes to the error log with masked data", () => {
    logError(Object.assign(new Error("boom"), { code: "E1" }), "REPORTS", { token: "t", id: 3 })
    const [entry] = lines(ERRORS)
    expect(entry).toMatchObject({ level: "ERROR", context: "REPORTS", error: "boom", code: "E1", data: { token: "***MASKED***", id: 3 } })
    expect(files.contents.has(SYSTEM)).toBe(false)
  })

  it("mirrors auth, payment and order errors into the audit log", () => {
    for (const context of ["AUTH_LOGIN", "PAYMENT_X", "ORDER_CREATE"]) logError(new Error("x"), context)
    expect(lines(SYSTEM).map((entry) => entry.event)).toEqual(["ERROR_OCCURRED", "ERROR_OCCURRED", "ERROR_OCCURRED"])
  })

  it("copes with a non-Error value", () => {
    logError(undefined, "X")
    expect(lines(ERRORS)[0].error).toBe("Unknown error")
  })
})

describe("domain helpers", () => {
  it("records an order activity", () => {
    logOrderActivity("APPROVE", { id: 9, tid: "T9", status: "APPROVED", totalCents: 500, organizationId: 1, branchId: 2 }, user)
    expect(lines(SYSTEM)[0]).toMatchObject({
      event: "ORDER_APPROVE",
      resourceId: "9",
      organizationId: 1,
      branchId: 2,
      details: { tid: "T9", total: 500, items: [] },
    })
  })

  it("drops an order activity with incomplete identity", () => {
    logOrderActivity("APPROVE", { id: 9 }, { id: "u", email: "", role: "X" })
    logOrderActivity("APPROVE", null, user)
    expect(files.contents.has(SYSTEM)).toBe(false)
  })

  it("defaults a security event's name", () => {
    logSecurityEvent({ userId: "u" })
    logSecurityEvent(null)
    expect(lines(SYSTEM).map((entry) => entry.event)).toEqual(["SECURITY_EVENT"])
  })

  it("records token generation and fulfilment attempts, refusing incomplete calls", () => {
    logTokenGenerated(1, "T1", "u", "e@x.test")
    logTokenGenerated(0, "T1", "u", "e@x.test")
    logFulfillmentAttempt(1, "T1", "u", "e@x.test", "BRANCH_ADMIN", true)
    logFulfillmentAttempt(1, "T1", "u", "e@x.test", "BRANCH_ADMIN", false, "mismatch")
    logFulfillmentAttempt(1, "", "u", "e@x.test", "BRANCH_ADMIN", true)

    expect(lines(SYSTEM).map((entry) => [entry.event, entry.result])).toEqual([
      ["APPROVAL_TOKEN_GENERATED", "SUCCESS"],
      ["ORDER_FULFILLED_WITH_TOKEN", "SUCCESS"],
      ["FULFILLMENT_TOKEN_MISMATCH", "FAILED"],
    ])
  })

  it("writes inventory actions to their own log and mirrors removals into the audit log", () => {
    logInventoryAction("ASSIGN", "BRANCH_ASSIGNMENT", user, { branchId: 2, productIds: [1, 2], metadata: { source: "ui" } })
    logInventoryAction("REMOVE", "BRANCH_ASSIGNMENT", user, { branchId: 2, count: 1 })

    expect(lines(INVENTORY).map((entry) => entry.event)).toEqual([
      "INVENTORY_ASSIGN_BRANCH_ASSIGNMENT",
      "INVENTORY_REMOVE_BRANCH_ASSIGNMENT",
    ])
    expect(lines(INVENTORY)[0].details).toMatchObject({ productIds: [1, 2], source: "ui" })
    expect(lines(SYSTEM).map((entry) => entry.event)).toEqual(["INVENTORY_REMOVE_BRANCH_ASSIGNMENT"])
  })

  it("reports the size of each log", () => {
    files.contents.set(ERRORS, "12345")
    expect(getLogStats()).toEqual({ systemLogSize: 0, errorLogSize: 5, inventoryLogSize: 0 })
  })
})
