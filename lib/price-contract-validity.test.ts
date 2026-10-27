import { describe, expect, it } from "vitest"

import {
  PRICE_CONTRACT_REMINDER_DAYS,
  formatPriceContractDay,
  isPriceContractCalendarDay,
  karachiCalendarDay,
  parsePriceContractReminderPayload,
  priceContractBadge,
  priceContractDateRefusal,
  priceContractDaysLabel,
  priceContractDaysLeft,
  priceContractReminderCopy,
  priceContractReminderEventKey,
  priceContractReminderHorizon,
  priceContractStatus,
} from "@/lib/price-contract-validity"

describe("price contract validity", () => {
  describe("calendar days", () => {
    it("accepts a real day and refuses a rolled-over or malformed one", () => {
      expect(isPriceContractCalendarDay("2026-12-31")).toBe(true)
      expect(isPriceContractCalendarDay("2028-02-29")).toBe(true)
      expect(isPriceContractCalendarDay("2026-02-29")).toBe(false)
      expect(isPriceContractCalendarDay("2026-02-31")).toBe(false)
      expect(isPriceContractCalendarDay("2026-1-01")).toBe(false)
      expect(isPriceContractCalendarDay("31/12/2026")).toBe(false)
      expect(isPriceContractCalendarDay("")).toBe(false)
    })

    it("refuses a day outside the accepted range but allows a past one", () => {
      expect(priceContractDateRefusal("2020-01-01")).toBeNull()
      expect(priceContractDateRefusal("2000-01-01")).toBeNull()
      expect(priceContractDateRefusal("2100-12-31")).toBeNull()
      expect(priceContractDateRefusal("1999-12-31")).toMatch(/between/)
      expect(priceContractDateRefusal("2101-01-01")).toMatch(/between/)
      expect(priceContractDateRefusal("2026-13-01")).toMatch(/real date/)
    })
  })

  describe("status", () => {
    const today = "2026-10-27"

    it("is none without a date", () => {
      expect(priceContractStatus(null, today)).toBe("none")
      expect(priceContractStatus(undefined, today)).toBe("none")
      expect(priceContractStatus("", today)).toBe("none")
      expect(priceContractStatus("not-a-day", today)).toBe("none")
    })

    it("is active while more than the reminder window remains", () => {
      expect(priceContractStatus("2026-11-04", today)).toBe("active")
      expect(priceContractDaysLeft("2026-11-04", today)).toBe(PRICE_CONTRACT_REMINDER_DAYS + 1)
    })

    it("is expiring from seven days out through the last day itself", () => {
      expect(priceContractStatus("2026-11-03", today)).toBe("expiring")
      expect(priceContractStatus("2026-10-28", today)).toBe("expiring")
      expect(priceContractStatus("2026-10-27", today)).toBe("expiring")
    })

    it("is expired the day after its last day", () => {
      expect(priceContractStatus("2026-10-26", today)).toBe("expired")
      expect(priceContractDaysLeft("2026-10-26", today)).toBe(-1)
    })

    it("counts days across a month and a year boundary", () => {
      expect(priceContractDaysLeft("2027-01-02", "2026-12-30")).toBe(3)
      expect(priceContractDaysLeft("2028-03-01", "2028-02-28")).toBe(2)
    })

    it("sets the reminder horizon seven days ahead", () => {
      expect(priceContractReminderHorizon("2026-10-27")).toBe("2026-11-03")
      expect(priceContractReminderHorizon("2026-12-28")).toBe("2027-01-04")
    })
  })

  describe("labels", () => {
    it("formats the day and the days left", () => {
      expect(formatPriceContractDay("2026-12-31")).toBe("31 Dec 2026")
      expect(priceContractDaysLabel(0)).toBe("expires today")
      expect(priceContractDaysLabel(1)).toBe("expires in 1 day")
      expect(priceContractDaysLabel(5)).toBe("expires in 5 days")
      expect(priceContractDaysLabel(-1)).toBe("expired 1 day ago")
      expect(priceContractDaysLabel(-4)).toBe("expired 4 days ago")
    })

    it("flags each status for the Organizations list", () => {
      const today = "2026-10-27"
      expect(priceContractBadge(null, today)).toBeNull()
      expect(priceContractBadge("2026-12-31", today)).toEqual({ status: "active", label: "Prices valid to 31 Dec 2026" })
      expect(priceContractBadge("2026-10-30", today)).toEqual({ status: "expiring", label: "Contract expires in 3 days" })
      expect(priceContractBadge("2026-10-27", today)).toEqual({ status: "expiring", label: "Contract expires today" })
      expect(priceContractBadge("2026-10-01", today)).toEqual({ status: "expired", label: "Price contract expired" })
    })
  })

  describe("reminders", () => {
    it("keys a reminder on the organization, the date and the recipient", () => {
      const base = { organizationId: 4, validUntil: "2026-11-01", recipientUserId: "u-1" }
      expect(priceContractReminderEventKey(base)).toBe("PRICE_CONTRACT_EXPIRING:4:2026-11-01:u-1")
      expect(priceContractReminderEventKey({ ...base, validUntil: "2027-11-01" }))
        .not.toBe(priceContractReminderEventKey(base))
    })

    it("words the reminder without any price", () => {
      const copy = priceContractReminderCopy(
        { organizationId: 4, organizationName: "Acme", organizationCode: "ACM", validUntil: "2026-11-01" },
        5,
      )
      expect(copy.subject).toBe("Price contract for Acme expires in 5 days")
      expect(copy.message).toContain("valid until 1 Nov 2026")
      expect(copy.intro).toContain("Ordering is not affected")
    })

    it("reads a payload back and refuses a malformed one", () => {
      expect(parsePriceContractReminderPayload({
        organizationId: 4, organizationName: "Acme", organizationCode: "ACM", validUntil: "2026-11-01",
      })).toEqual({ organizationId: 4, organizationName: "Acme", organizationCode: "ACM", validUntil: "2026-11-01" })
      expect(parsePriceContractReminderPayload({ organizationId: 4, organizationName: "Acme", validUntil: "2026-02-31" })).toBeNull()
      expect(parsePriceContractReminderPayload({ organizationId: 0, organizationName: "Acme", validUntil: "2026-11-01" })).toBeNull()
      expect(parsePriceContractReminderPayload({ organizationId: 4, organizationName: "", validUntil: "2026-11-01" })).toBeNull()
      expect(parsePriceContractReminderPayload(null)).toBeNull()
    })
  })

  it("names the Karachi day, five hours ahead of UTC", () => {
    expect(karachiCalendarDay(new Date("2026-10-27T18:59:59Z"))).toBe("2026-10-27")
    expect(karachiCalendarDay(new Date("2026-10-27T19:00:00Z"))).toBe("2026-10-28")
  })
})
