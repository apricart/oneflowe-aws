import { describe, expect, it } from "vitest"
import { getReceiptUserDisplayName } from "./receipt-user"

describe("receipt user display name", () => {
  it("uses the same readable identity fallback order for initiators and approvers", () => {
    expect(getReceiptUserDisplayName({ fullName: "Salman Akram", username: "salman" }, "Unknown"))
      .toBe("Salman Akram")
    expect(getReceiptUserDisplayName({ firstName: "Ayesha", lastName: "Khan" }, "Unknown"))
      .toBe("Ayesha Khan")
    expect(getReceiptUserDisplayName({ username: "approver.user" }, "Unknown"))
      .toBe("approver.user")
    expect(getReceiptUserDisplayName(null, "N/A")).toBe("N/A")
  })
})
