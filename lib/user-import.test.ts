import { describe, expect, it } from "vitest"
import {
  deriveNameUsername,
  normalizePhoneKey,
  parseImportRole,
  parseUserImportRecords,
  resolveImportBranch,
} from "@/lib/user-import"

describe("user import parsing", () => {
  it("accepts the misspelled UBL headers and maps human-readable roles", () => {
    const [row] = parseUserImportRecords([{
      Name: "Example Person",
      Deparment: "Consumer & ADC Operations",
      "Employee Id": "EMP-10",
      Eamil: " PERSON@EXAMPLE.COM ",
      "Phone ": "+92 300 1234567",
      "User Type": "Branch Admin",
      Address: "Example address",
      Status: "Active",
    }], { usernameFormat: "first.last" })

    expect(row).toMatchObject({
      rowNumber: 2,
      firstName: "Example",
      lastName: "Person",
      fullName: "Example Person",
      email: "person@example.com",
      username: "example.person",
      usernameSource: "name",
      role: "BRANCH_ADMIN",
      branchSource: "Consumer & ADC Operations",
      isActive: true,
    })
    expect(row.issues.filter((issue) => issue.severity === "error")).toEqual([])
  })

  it("derives a normalized first.last username when configured", () => {
    const [row] = parseUserImportRecords([{
      Name: "Éxample M. Person",
      Email: "person@example.com",
      Role: "Head Office",
    }], { usernameFormat: "first.last" })

    expect(row.username).toBe("example.mperson")
    expect(row.usernameSource).toBe("name")
    expect(row.issues.some((issue) => issue.code === "USERNAME_DERIVED_FROM_NAME")).toBe(true)
    expect(deriveNameUsername("First", "Last Name")).toBe("first.lastname")
  })

  it("detects normalized duplicates within a workbook", () => {
    const rows = parseUserImportRecords([
      { Name: "First Person", Email: "same@example.com", Username: "User.One", Role: "Head Office" },
      { Name: "Second Person", Email: "SAME@example.com", Username: "user.one", Role: "Head Office" },
    ])

    expect(rows.every((row) => row.issues.some((issue) => issue.code === "DUPLICATE_EMAIL_IN_FILE"))).toBe(true)
    expect(rows.every((row) => row.issues.some((issue) => issue.code === "DUPLICATE_USERNAME_IN_FILE"))).toBe(true)
  })

  it("requires explicit overrides for intentionally different branch names", () => {
    const branches = [{ id: 1, name: "Procurement" }]

    expect(resolveImportBranch("Procurment", branches).branch).toBeNull()
    expect(resolveImportBranch("Procurment", branches, { Procurment: "Procurement" }).branch?.id).toBe(1)
  })

  it("normalizes role and phone formats deterministically", () => {
    expect(parseImportRole("Order Portal")).toBe("ORDER_PORTAL")
    expect(parseImportRole("SUPER_ADMIN")).toBeNull()
    expect(normalizePhoneKey("+92 (300) 123-4567")).toBe("923001234567")
  })
})
