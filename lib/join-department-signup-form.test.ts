import { describe, expect, it } from "vitest"

import {
  CRC_MAX_LENGTH,
  NEW_BRANCH_FIELD_RULES,
  SIGNUP_ADDRESS_MAX_LENGTH,
  SIGNUP_DESIGNATION_MAX_LENGTH,
  SIGNUP_FULL_NAME_MAX_LENGTH,
  SIGNUP_MAX_ADDRESSES,
  SIGNUP_MAX_BRANCHES,
  encodedBodyBytes,
} from "./join-department-signup"
import {
  type DepartmentSignupDraft,
  addressDraftError,
  departmentSignupErrors,
  emptyDepartmentSignupDraft,
  joinPasswordError,
  newBranchChipError,
  newBranchNameChipError,
  payloadSizeError,
  sameBranchName,
  toDepartmentSignupPayload,
} from "./join-department-signup-form"
import { MAX_APPROVAL_LEVELS } from "./order-approval-levels"

/** plans/OF-JOIN-department-signup-multi-user.md */

function validDraft(): DepartmentSignupDraft {
  return {
    ...emptyDepartmentSignupDraft(2),
    fullName: "Huzaifa Abid",
    emailLocalPart: "huzaifa.abid",
    phone: "03001234567",
    ipExtension: "1234",
    employeeId: "E-1",
    department: "Finance",
    approvers: [
      { level: 1, emailLocalPart: "first.approver", designation: "Head of Finance" },
      { level: 2, emailLocalPart: "second.approver", designation: "Manager" },
    ],
    branches: [
      { key: "b1", kind: "existing", branchId: 4, label: "Head Office", checked: true },
      { key: "cX", kind: "crc", crc: "AB-ABC-123", name: "Korangi Depot", label: "Korangi Depot", checked: true },
      { key: "cY", kind: "crc", crc: "AB-ABC-999", name: "Unchecked Depot", label: "Unchecked Depot", checked: false },
    ],
    addresses: [
      { key: "a1", address: "Plot 1, Clifton, Karachi", checked: true },
      { key: "a2", address: "Unchecked address", checked: false },
    ],
    password: "Str0ng!Password",
    confirmPassword: "Str0ng!Password",
    termsAccepted: true,
  }
}

describe("departmentSignupErrors", () => {
  it("passes a complete draft", () => {
    expect(departmentSignupErrors(validDraft())).toEqual({})
  })

  it("starts with one approver card per level", () => {
    expect(emptyDepartmentSignupDraft(3).approvers.map((approver) => approver.level)).toEqual([1, 2, 3])
  })

  it("names each missing or malformed field", () => {
    const errors = departmentSignupErrors({
      ...emptyDepartmentSignupDraft(1),
      phone: "3001234567",
      ipExtension: "12",
    })
    expect(Object.keys(errors).sort()).toEqual([
      "addresses", "approver1Designation", "approver1Email", "branches", "department",
      "email", "employeeId", "fullName", "ipExtension", "password", "phone", "terms",
    ].sort())
  })

  it("refuses an approver who is the initiator, or the same person twice", () => {
    const draft = validDraft()
    draft.approvers[0].emailLocalPart = "HUZAIFA.ABID"
    draft.approvers[1].emailLocalPart = "huzaifa.abid"
    const errors = departmentSignupErrors(draft)
    expect(errors.approver1Email).toMatch(/cannot be the person placing the orders/)
    expect(errors.approver2Email).toMatch(/cannot be the person placing the orders|different approver/)
  })

  it("counts only checked branches and addresses", () => {
    const draft = validDraft()
    draft.branches = draft.branches.map((chip) => ({ ...chip, checked: false }))
    draft.addresses = draft.addresses.map((chip) => ({ ...chip, checked: false }))
    const errors = departmentSignupErrors(draft)
    expect(errors.branches).toBe("Add at least one branch and keep it checked")
    expect(errors.addresses).toMatch(/at least one delivery address/)
  })

  it("holds the password to the server's rule and to its confirmation", () => {
    expect(joinPasswordError("short")).toMatch(/12 characters/)
    expect(joinPasswordError("alllowercase12345")).toMatch(/uppercase/)
    expect(joinPasswordError("Str0ng!Password")).toBeUndefined()
    expect(departmentSignupErrors({ ...validDraft(), confirmPassword: "different" }).confirmPassword).toMatch(/do not match/)
  })

  it("refuses a new branch with no name of its own, a name already listed, or a bad or repeated CRC", () => {
    const chips = validDraft().branches
    const known = ["Head Office", "Clifton Branch"]
    expect(newBranchNameChipError(chips, known, " ")).toBe("Enter the branch name")
    expect(newBranchNameChipError(chips, known, "K")).toBe("The branch name needs at least 2 characters")
    expect(newBranchNameChipError(chips, known, "x".repeat(NEW_BRANCH_FIELD_RULES.name.max + 1)))
      .toBe(`The branch name can be at most ${NEW_BRANCH_FIELD_RULES.name.max} characters`)
    // An organization's own branch is picked, never asked for again.
    expect(newBranchNameChipError(chips, known, "  clifton   BRANCH ")).toMatch(/already exists/)
    expect(newBranchNameChipError(chips, known, "korangi depot")).toBe("This branch is already added")
    expect(newBranchNameChipError(chips, known, "Saddar Depot")).toBeNull()

    expect(newBranchChipError(chips, known, { name: "Saddar Depot", crc: "" })).toEqual({ field: "crc", message: "Enter a CRC number" })
    expect(newBranchChipError(chips, known, { name: "Saddar Depot", crc: "AB 12" }))
      .toEqual({ field: "crc", message: "Use letters, numbers and dashes only" })
    expect(newBranchChipError(chips, known, { name: "Saddar Depot", crc: " ab-abc-123 " }))
      .toEqual({ field: "crc", message: "This CRC is already added" })
    expect(newBranchChipError(chips, known, { name: "K", crc: "AB-1" })?.field).toBe("name")
    expect(newBranchChipError(chips, known, { name: "Saddar Depot", crc: "ab-1" })).toBeNull()
  })

  it("reads two branch names as one, case and spacing aside", () => {
    expect(sameBranchName(" Clifton  Branch", "clifton branch")).toBe(true)
    expect(sameBranchName("Clifton", "Clifton 2")).toBe(false)
  })

  it("refuses an address too short or too long to add", () => {
    expect(addressDraftError("abc")).toMatch(/at least 5/)
    expect(addressDraftError("x".repeat(SIGNUP_ADDRESS_MAX_LENGTH + 1))).toMatch(/At most/)
    expect(addressDraftError("Plot 1, Clifton")).toBeNull()
  })
})

describe("toDepartmentSignupPayload", () => {
  it("sends checked chips only, the organization's domain on every address, and no username or role", () => {
    const payload = toDepartmentSignupPayload(validDraft(), "ubl.com.pk")
    expect(payload).toEqual({
      formVersion: 2,
      fullName: "Huzaifa Abid",
      email: "huzaifa.abid@ubl.com.pk",
      password: "Str0ng!Password",
      phone: "03001234567",
      ipExtension: "1234",
      employeeId: "E-1",
      department: "Finance",
      branches: [{ branchId: 4 }, { name: "Korangi Depot", crc: "AB-ABC-123" }],
      addresses: ["Plot 1, Clifton, Karachi"],
      approvers: [
        { level: 1, email: "first.approver@ubl.com.pk", designation: "Head of Finance" },
        { level: 2, email: "second.approver@ubl.com.pk", designation: "Manager" },
      ],
      termsAccepted: true,
    })
    expect(payload).not.toHaveProperty("username")
    expect(payload).not.toHaveProperty("role")
  })
})

describe("the 8 KB WAF limit", () => {
  it("is not reached by the largest ASCII submission the bounds allow", () => {
    const local = "a".repeat(55)
    const domain = "a-long-organization-domain.com.pk"
    const worst = {
      ...toDepartmentSignupPayload({
        ...validDraft(),
        fullName: "N".repeat(SIGNUP_FULL_NAME_MAX_LENGTH),
        emailLocalPart: local,
        employeeId: "E".repeat(64),
        department: "Sales & Marketing",
        approvers: Array.from({ length: MAX_APPROVAL_LEVELS }, (_, index) => ({
          level: index + 1,
          emailLocalPart: `${"b".repeat(80)}${index}`,
          designation: "D".repeat(SIGNUP_DESIGNATION_MAX_LENGTH),
        })),
        branches: Array.from({ length: SIGNUP_MAX_BRANCHES }, (_, index) => ({
          key: `c${index}`,
          kind: "crc" as const,
          crc: `${index}`.padEnd(CRC_MAX_LENGTH, "C"),
          name: `${index}`.padEnd(NEW_BRANCH_FIELD_RULES.name.max, "N"),
          label: "",
          checked: true,
        })),
        addresses: Array.from({ length: SIGNUP_MAX_ADDRESSES }, (_, index) => ({
          key: `a${index}`,
          address: `${index}`.padEnd(SIGNUP_ADDRESS_MAX_LENGTH, "A"),
          checked: true,
        })),
        password: `Aa1!${"p".repeat(124)}`,
      }, domain),
      code: "ABCD-EFGH-JKLM-NPQR-TUVW-XY34-679",
    }
    expect(encodedBodyBytes(worst)).toBeLessThan(7_500)
    expect(payloadSizeError(worst)).toBeNull()
  })

  it("is caught before sending when non-Latin text makes the body heavier than it looks", () => {
    // 4,100 characters, but two bytes each in UTF-8: over 8,000 bytes.
    const heavy = { addresses: ["ک".repeat(4_100)] }
    expect(payloadSizeError(heavy)).toMatch(/too long/)
  })
})
