import { describe, expect, it } from "vitest"

import {
  ACTIVITY_MAX_WINDOW_DAYS,
  ACTIVITY_OPERATIONS,
  ACTIVITY_SEVERITIES,
  MS_PER_DAY,
  type ActivityEvent,
} from "@/lib/activity-log"
import {
  CSV_COLUMNS,
  OPERATION_LABEL,
  OPERATION_TONE,
  SEVERITY_LABEL,
  SEVERITY_MEANING,
  SEVERITY_TONE,
  WINDOW_PRESETS,
  actorLabel,
  changedFields,
  contextEntries,
  csvCell,
  csvFileName,
  eventAriaLabel,
  eventsToCsv,
  scopeLabel,
  windowForPreset,
} from "@/lib/activity-log-view"

/** How the screen draws an event. Pure, so none of it needs a rendered component. */

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "audit:1",
    source: "audit",
    occurredAt: "2026-09-26T10:00:00.000Z",
    action: "UPDATE_CATEGORY",
    actionLabel: "Update category",
    operation: "update",
    category: "catalogue",
    severity: "info",
    entity: "category",
    entityLabel: "Category",
    entityId: "42",
    actor: { id: "u-1", email: "ali@example.test", name: "Ali Raza", role: "SUPER_ADMIN", redacted: false },
    organizationId: 3,
    organizationName: "Apricart",
    branchId: 9,
    branchName: "North",
    success: true,
    errorMessage: null,
    ipAddress: "198.51.100.7",
    userAgent: "Mozilla/5.0",
    metadata: {},
    ...overrides,
  }
}

describe("window presets", () => {
  const now = new Date("2026-09-26T12:00:00.000Z")

  it("stays inside the maximum the endpoint accepts", () => {
    // A preset that produced a 400 would look like a broken screen rather than
    // a refused query.
    for (const preset of WINDOW_PRESETS) {
      if (preset.days === null) continue
      expect(preset.days).toBeLessThanOrEqual(ACTIVITY_MAX_WINDOW_DAYS)
    }
  })

  it("offers no unbounded option", () => {
    expect(WINDOW_PRESETS.map((preset) => preset.id)).not.toContain("all")
  })

  it("resolves a preset to a range ending now", () => {
    const window = windowForPreset("30d", now)
    expect(window?.to).toEqual(now)
    expect(window && (now.getTime() - window.from.getTime()) / MS_PER_DAY).toBe(30)
  })

  it("resolves custom to nothing, because its dates come from the pickers", () => {
    expect(windowForPreset("custom", now)).toBeNull()
  })
})

describe("tones and labels", () => {
  it("covers every severity and every operation", () => {
    // A value with no tone would render unstyled and unlabelled.
    for (const severity of ACTIVITY_SEVERITIES) {
      expect(SEVERITY_TONE[severity]).toBeTruthy()
      expect(SEVERITY_LABEL[severity]).toBeTruthy()
      expect(SEVERITY_MEANING[severity]).toBeTruthy()
    }
    for (const operation of ACTIVITY_OPERATIONS) {
      expect(OPERATION_TONE[operation]).toBeTruthy()
      expect(OPERATION_LABEL[operation]).toBeTruthy()
    }
  })

  it("defines a dark-mode variant for every tone, so neither theme is unreadable", () => {
    for (const tone of [...Object.values(SEVERITY_TONE), ...Object.values(OPERATION_TONE)]) {
      expect(tone).toContain("dark:")
    }
  })
})

describe("actorLabel", () => {
  it("prefers the most identifying thing present", () => {
    expect(actorLabel(event())).toBe("Ali Raza")
    expect(actorLabel(event({ actor: { id: "u", email: "a@b.test", name: null, role: null, redacted: false } }))).toBe("a@b.test")
    expect(actorLabel(event({ actor: { id: "emp_9", email: null, name: null, role: null, redacted: false } }))).toBe("emp_9")
  })

  it("names an actorless row System rather than leaving it blank", () => {
    expect(actorLabel(event({ actor: { id: null, email: null, name: null, role: null, redacted: false } }))).toBe("System")
  })
})

describe("scopeLabel", () => {
  it("joins what is known", () => {
    expect(scopeLabel(event())).toBe("Apricart · North")
    expect(scopeLabel(event({ branchName: null }))).toBe("Apricart")
  })

  it("calls a row with no tenant Platform", () => {
    expect(scopeLabel(event({ organizationName: null, branchName: null }))).toBe("Platform")
  })
})

describe("eventAriaLabel", () => {
  it("says everything the badges say, so colour is never the only signal", () => {
    const label = eventAriaLabel(event({ severity: "critical", operation: "delete" }))
    expect(label).toContain("Deleted")
    expect(label).toContain("Critical")
    expect(label).toContain("Ali Raza")
    expect(label).toContain("Apricart · North")
    expect(label).toContain("succeeded")
  })

  it("announces a failure and its reason", () => {
    const label = eventAriaLabel(event({ success: false, errorMessage: "invalid_password" }))
    expect(label).toContain("failed")
    expect(label).toContain("invalid_password")
  })
})

describe("changedFields", () => {
  it("lists only the fields that differ", () => {
    expect(
      changedFields({ before: { name: "Old", type: "x" }, after: { name: "New", type: "x" } }),
    ).toEqual([{ field: "name", before: "Old", after: "New" }])
  })

  it("shows a field only one side has, which is the case a diff must not hide", () => {
    expect(changedFields({ before: {}, after: { name: "New" } })).toEqual([
      { field: "name", before: undefined, after: "New" },
    ])
    expect(changedFields({ before: { name: "Gone" }, after: {} })).toEqual([
      { field: "name", before: "Gone", after: undefined },
    ])
  })

  it("does not call a row changed because its keys were written in another order", () => {
    expect(
      changedFields({ before: { a: { x: 1, y: 2 } }, after: { a: { y: 2, x: 1 } } }),
    ).toEqual([])
  })

  it("treats null and a missing value as different", () => {
    expect(changedFields({ before: { name: null }, after: {} })).toHaveLength(1)
  })

  it("returns nothing when the writer recorded no diff", () => {
    expect(changedFields({})).toEqual([])
    expect(changedFields({ ip: "1.2.3.4" })).toEqual([])
    expect(changedFields(null)).toEqual([])
    expect(changedFields("not an object")).toEqual([])
  })

  it("is sorted, so two readings of the same row agree", () => {
    const fields = changedFields({ before: { b: 1, a: 1 }, after: { b: 2, a: 2 } })
    expect(fields.map((field) => field.field)).toEqual(["a", "b"])
  })
})

describe("contextEntries", () => {
  it("returns what the writer recorded apart from the diff", () => {
    expect(contextEntries({ before: {}, after: {}, count: 3, reason: "stale" })).toEqual([
      ["count", 3],
      ["reason", "stale"],
    ])
  })

  it("leaves out what the panel already shows in a row of its own", () => {
    // The address, the device and the actor each have their own row; repeating
    // them here made the panel look like it held the same fact twice.
    expect(
      contextEntries({
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
        actorRole: "SUPER_ADMIN",
        actorEmail: "a@b.test",
        count: 1,
      }),
    ).toEqual([["count", 1]])
  })

  it("returns nothing for a non-object", () => {
    expect(contextEntries(null)).toEqual([])
    expect(contextEntries([1, 2])).toEqual([])
  })
})

describe("csvCell", () => {
  it("quotes and escapes", () => {
    expect(csvCell("plain")).toBe('"plain"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
  })

  it("neutralises a formula, which quoting alone does not", () => {
    // This export carries attacker-influenced text — an action string, an entity
    // id, a user agent — and a spreadsheet runs a leading = + - @ on open.
    expect(csvCell("=1+1")).toBe('"\'=1+1"')
    expect(csvCell("+cmd")).toBe('"\'+cmd"')
    expect(csvCell("-2")).toBe('"\'-2"')
    expect(csvCell("@SUM(A1)")).toBe('"\'@SUM(A1)"')
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toMatch(/^"'=/)
  })

  it("leaves an ordinary value untouched", () => {
    expect(csvCell("DELETE_CATEGORY")).toBe('"DELETE_CATEGORY"')
    expect(csvCell(42)).toBe('"42"')
  })

  it("serialises an object rather than printing [object Object]", () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
  })
})

describe("eventsToCsv", () => {
  it("writes the header and one row per event", () => {
    const csv = eventsToCsv([event(), event({ id: "audit:2" })])
    const lines = csv.split("\r\n")
    expect(lines).toHaveLength(3)
    expect(lines[0].split(",")).toHaveLength(CSV_COLUMNS.length)
    expect(lines[1].split('","').length).toBeGreaterThan(1)
  })

  it("carries the facts a reviewer needs offline", () => {
    const csv = eventsToCsv([event({ success: false, errorMessage: "invalid_password" })])
    expect(csv).toContain("UPDATE_CATEGORY")
    expect(csv).toContain("Ali Raza")
    expect(csv).toContain("Apricart")
    expect(csv).toContain("198.51.100.7")
    expect(csv).toContain("Failed: invalid_password")
  })

  it("writes a header alone for an empty list", () => {
    expect(eventsToCsv([]).split("\r\n")).toHaveLength(1)
  })

  it("names the file after the moment it was taken", () => {
    expect(csvFileName(new Date("2026-09-26T10:11:12.000Z"))).toBe("activity-log-2026-09-26-10-11-12.csv")
  })
})
