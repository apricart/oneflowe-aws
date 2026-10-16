import { describe, expect, it } from "vitest"

import {
  changedApproverLevels,
  changedPersonFields,
  crcDraftError,
  departmentJoinEditErrors,
  draftFromReview,
  editedAddressListError,
  editedBranchListError,
  planAddressEdit,
  planRequestBranchEdit,
  toDepartmentJoinUpdatePayload,
} from "@/lib/join-department-edit"

const REVIEW = {
  person: {
    firstName: "Sana",
    lastName: "Mir",
    email: "sana.mir@demo.test",
    username: "sana.mir",
    phone: "03001234567",
    employeeId: "E-7",
    department: "Finance",
    ipExtension: "1234",
  },
  branches: [
    { kind: "existing" as const, branchId: 5, name: "Clifton", costCenterId: null },
    { kind: "new" as const, branchId: null, name: null, costCenterId: "crc-9" },
  ],
  addresses: [{ requestAddressId: 41, address: "Plot 4, Clifton" }],
  approvers: [
    { level: 2, email: "two@demo.test", designation: "Manager" },
    { level: 1, email: "one@demo.test", designation: "Director" },
  ],
}

describe("planRequestBranchEdit", () => {
  const current = [
    { id: 1, existingBranchId: 5, costCenterId: null },
    { id: 2, existingBranchId: null, costCenterId: "CRC-9" },
    { id: 3, existingBranchId: 6, costCenterId: null },
  ]

  it("keeps rows naming the same branch or CRC, so their ids survive", () => {
    expect(planRequestBranchEdit(current, { existingIds: [5, 6], newCrcs: ["crc-9"] }))
      .toEqual({ deleteIds: [], insertExistingIds: [], insertCrcs: [] })
  })

  it("drops what was removed and adds what is new", () => {
    expect(planRequestBranchEdit(current, { existingIds: [5, 8], newCrcs: ["NEW-1"] }))
      .toEqual({ deleteIds: [2, 3], insertExistingIds: [8], insertCrcs: ["NEW-1"] })
  })

  it("replaces a CRC that now matches a branch with that branch", () => {
    expect(planRequestBranchEdit(current, { existingIds: [5, 6, 9], newCrcs: [] }))
      .toEqual({ deleteIds: [2], insertExistingIds: [9], insertCrcs: [] })
  })
})

describe("planAddressEdit", () => {
  const current = [{ id: 1, address: "Plot 4, Clifton" }, { id: 2, address: "Office 2, Saddar" }]

  it("keeps an unchanged address and replaces an edited one", () => {
    expect(planAddressEdit(current, ["Plot 4, Clifton", "Office 3, Saddar"]))
      .toEqual({ deleteIds: [2], insertAddresses: ["Office 3, Saddar"] })
  })

  it("drops every address that is gone", () => {
    expect(planAddressEdit(current, ["  Office 2, Saddar "])).toEqual({ deleteIds: [1], insertAddresses: [] })
  })
})

describe("changed fields", () => {
  it("names the person fields that differ, treating null as empty", () => {
    const before = { firstName: "Sana", lastName: "Mir", email: "a@x.test", username: "a", phone: null, ipExtension: "123", employeeId: "E", department: "IT" }
    expect(changedPersonFields(before, { ...before, phone: "", email: "b@x.test", department: "Finance" }))
      .toEqual(["email", "department"])
  })

  it("names the levels whose approver changed, ignoring case", () => {
    const current = [{ level: 1, email: "one@x.test", designation: "Director" }, { level: 2, email: "two@x.test", designation: "Manager" }]
    expect(changedApproverLevels(current, [
      { level: 1, email: "ONE@x.test", designation: "Director" },
      { level: 2, email: "two@x.test", designation: "Senior Manager" },
    ])).toEqual([2])
  })
})

describe("list rules", () => {
  it("refuses the same branch or CRC twice, an empty list and too many", () => {
    expect(editedBranchListError([{ branchId: 1 }, { crc: "a-1" }])).toBeNull()
    expect(editedBranchListError([{ crc: "a-1" }, { crc: " A-1 " }])).toBe("The same branch is listed twice")
    expect(editedBranchListError([])).toBe("Keep at least one branch")
    expect(editedBranchListError(Array.from({ length: 11 }, (_, index) => ({ branchId: index + 1 })))).toBe("At most 10 branches")
  })

  it("refuses the same address twice, case and spacing aside", () => {
    expect(editedAddressListError(["Plot 4,  Clifton", "plot 4, clifton"])).toBe("The same delivery address is listed twice")
    expect(editedAddressListError([])).toBe("Keep at least one delivery address")
  })
})

describe("the dialog's draft", () => {
  it("starts from the review, approvers in level order and CRCs normalised", () => {
    const draft = draftFromReview(REVIEW)
    expect(draft.approvers.map((approver) => approver.level)).toEqual([1, 2])
    expect(draft.branches.map((entry) => entry.key)).toEqual(["branch:5", "crc:CRC-9"])
    expect(draft.addresses).toEqual([{ key: "address:41", address: "Plot 4, Clifton" }])
    expect(departmentJoinEditErrors(draft, "demo.test")).toEqual({})
  })

  it("holds every field to the submission's rules", () => {
    const draft = {
      ...draftFromReview(REVIEW),
      firstName: " ",
      email: "sana@elsewhere.test",
      username: "a b",
      phone: "12345",
      ipExtension: "12",
      employeeId: "",
      department: "Nowhere",
      branches: [],
      addresses: [{ key: "a", address: "abc" }],
    }
    expect(departmentJoinEditErrors(draft, "demo.test")).toEqual({
      firstName: "Enter the first name",
      email: "Use an @demo.test email address",
      username: "A username cannot contain spaces",
      phone: "Enter an 11-digit mobile number starting with 0",
      ipExtension: "Enter 3 to 6 digits",
      employeeId: "Enter the employee ID",
      department: "Select a department",
      branches: "Keep at least one branch",
      addresses: "Each delivery address needs at least 5 characters",
    })
  })

  it("refuses an approver who is the initiator, repeated, or off the domain", () => {
    const base = draftFromReview(REVIEW)
    const errors = departmentJoinEditErrors({
      ...base,
      approvers: [
        { level: 1, email: "sana.mir@demo.test", designation: "Director" },
        { level: 2, email: "x@other.test", designation: "M" },
      ],
    }, "demo.test")
    expect(errors.approver1Email).toBe("An approver cannot be the person placing the orders")
    expect(errors.approver2Email).toBe("Use an @demo.test email address")
    expect(errors.approver2Designation).toBe("Enter the designation")
  })

  it("refuses a CRC already listed or malformed", () => {
    const draft = draftFromReview(REVIEW)
    expect(crcDraftError(draft, "crc-9")).toBe("That CRC is already listed")
    expect(crcDraftError(draft, "bad crc")).toBe("Use letters, numbers and dashes only")
    expect(crcDraftError(draft, "NEW-2")).toBeNull()
  })

  it("sends trimmed, lower-cased identities and the lists as edited", () => {
    const draft = { ...draftFromReview(REVIEW), email: " Sana.Mir@Demo.Test ", username: "Sana.Mir" }
    expect(toDepartmentJoinUpdatePayload(draft)).toEqual({
      update: {
        firstName: "Sana",
        lastName: "Mir",
        email: "sana.mir@demo.test",
        username: "sana.mir",
        phone: "03001234567",
        ipExtension: "1234",
        employeeId: "E-7",
        department: "Finance",
        branches: [{ branchId: 5 }, { crc: "CRC-9" }],
        addresses: ["Plot 4, Clifton"],
        approvers: [
          { level: 1, email: "one@demo.test", designation: "Director" },
          { level: 2, email: "two@demo.test", designation: "Manager" },
        ],
      },
    })
  })
})

describe("edge cases", () => {
  it("adds every row of a request that had none, and deletes every row when all are replaced", () => {
    expect(planRequestBranchEdit([], { existingIds: [1, 2], newCrcs: ["A-1"] }))
      .toEqual({ deleteIds: [], insertExistingIds: [1, 2], insertCrcs: ["A-1"] })
    expect(planRequestBranchEdit(
      [{ id: 1, existingBranchId: 5, costCenterId: null }, { id: 2, existingBranchId: null, costCenterId: "B-1" }],
      { existingIds: [9], newCrcs: [] },
    )).toEqual({ deleteIds: [1, 2], insertExistingIds: [9], insertCrcs: [] })
  })

  it("never keeps a CRC row for an existing branch of the same id, or the reverse", () => {
    // A stored existing-branch row and a stored CRC row are matched only by their own kind.
    expect(planRequestBranchEdit(
      [{ id: 1, existingBranchId: null, costCenterId: "5" }],
      { existingIds: [5], newCrcs: [] },
    )).toEqual({ deleteIds: [1], insertExistingIds: [5], insertCrcs: [] })
  })

  it("matches stored addresses one for one, so a repeated address is not kept twice", () => {
    expect(planAddressEdit(
      [{ id: 1, address: "Plot 4, Clifton" }, { id: 2, address: "Plot 4, Clifton" }],
      ["Plot 4, Clifton"],
    )).toEqual({ deleteIds: [2], insertAddresses: [] })
    expect(planAddressEdit([], ["Plot 4, Clifton"])).toEqual({ deleteIds: [], insertAddresses: ["Plot 4, Clifton"] })
  })

  it("names a level the edit adds as changed, and none when nothing moved", () => {
    const current = [{ level: 1, email: "one@x.test", designation: "Director" }]
    expect(changedApproverLevels(current, [...current, { level: 2, email: "two@x.test", designation: "Manager" }])).toEqual([2])
    expect(changedApproverLevels(current, [{ level: 1, email: " one@x.test ", designation: " Director " }])).toEqual([])
  })

  it("names no person field when only spacing or a null-for-empty differs", () => {
    const before = { firstName: "Sana", lastName: "", email: "a@x.test", username: "a", phone: null, ipExtension: null, employeeId: null, department: null }
    expect(changedPersonFields(before, { ...before, lastName: null as unknown as string, phone: "" })).toEqual([])
  })

  it("skips the domain check when the organization has no domain, but still needs an address", () => {
    const draft = { ...draftFromReview(REVIEW), email: "sana@anywhere.test" }
    expect(departmentJoinEditErrors(draft, null).email).toBeUndefined()
    expect(departmentJoinEditErrors({ ...draft, email: "no-at-sign" }, null).email).toBe("Enter an email address")
  })

  it("holds names, designations and lists to their maximums exactly", () => {
    const base = draftFromReview(REVIEW)
    expect(departmentJoinEditErrors({ ...base, firstName: "x".repeat(100), lastName: "y".repeat(100) }, "demo.test")).toEqual({})
    expect(departmentJoinEditErrors({ ...base, firstName: "x".repeat(101) }, "demo.test").firstName).toBe("At most 100 characters")
    expect(departmentJoinEditErrors({ ...base, lastName: "y".repeat(101) }, "demo.test").lastName).toBe("At most 100 characters")

    const designation = (value: string) => departmentJoinEditErrors({
      ...base,
      approvers: [{ level: 1, email: "one@demo.test", designation: value }, base.approvers[1]],
    }, "demo.test").approver1Designation
    expect(designation("x".repeat(60))).toBeUndefined()
    expect(designation("x".repeat(61))).toBe("At most 60 characters")

    const addresses = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `a${index}`, address: `Plot ${index + 10}, Clifton` }))
    expect(departmentJoinEditErrors({ ...base, addresses: addresses(5) }, "demo.test").addresses).toBeUndefined()
    expect(departmentJoinEditErrors({ ...base, addresses: addresses(6) }, "demo.test").addresses).toBe("At most 5 delivery addresses")
    expect(departmentJoinEditErrors({ ...base, addresses: [] }, "demo.test").addresses).toBe("Keep at least one delivery address")
    expect(departmentJoinEditErrors({
      ...base,
      addresses: [{ key: "a", address: "Plot 4, Clifton" }, { key: "b", address: "PLOT 4,   clifton" }],
    }, "demo.test").addresses).toBe("The same delivery address is listed twice")
  })

  it("refuses an eleventh branch", () => {
    const draft = {
      ...draftFromReview(REVIEW),
      branches: Array.from({ length: 10 }, (_, index) => ({
        key: `branch:${index + 1}`,
        kind: "existing" as const,
        branchId: index + 1,
        label: `B${index + 1}`,
      })),
    }
    expect(departmentJoinEditErrors(draft, "demo.test").branches).toBeUndefined()
    expect(crcDraftError(draft, "NEW-1")).toBe("At most 10 branches")
  })

  it("asks for the username, phone and extension in the shapes the server accepts", () => {
    const base = draftFromReview(REVIEW)
    const errors = (patch: Partial<typeof base>) => departmentJoinEditErrors({ ...base, ...patch }, "demo.test")
    expect(errors({ username: "ab" }).username).toBe("At least 3 characters")
    expect(errors({ username: "abc" }).username).toBeUndefined()
    expect(errors({ phone: "0300123456" }).phone).toBeDefined()
    expect(errors({ phone: "030012345678" }).phone).toBeDefined()
    expect(errors({ ipExtension: "1234567" }).ipExtension).toBeDefined()
    expect(errors({ ipExtension: "123" }).ipExtension).toBeUndefined()
    expect(errors({ employeeId: "x".repeat(65) }).employeeId).toBe("At most 64 characters")
  })

  it("keeps the largest edit the bounds allow under the WAF's 8 KB", async () => {
    const { payloadSizeError } = await import("@/lib/join-department-signup-form")
    const draft = {
      firstName: "x".repeat(100),
      lastName: "y".repeat(100),
      email: `${"e".repeat(64)}@demo.test`,
      username: "u".repeat(64),
      phone: "03001234567",
      ipExtension: "123456",
      employeeId: "i".repeat(64),
      department: "Sales & Marketing",
      branches: Array.from({ length: 10 }, (_, index) => ({ key: `c${index}`, kind: "crc" as const, crc: `${"C".repeat(29)}-${index}`, label: "" })),
      addresses: Array.from({ length: 5 }, (_, index) => ({ key: `a${index}`, address: `${index}${"a".repeat(199)}` })),
      approvers: Array.from({ length: 5 }, (_, index) => ({ level: index + 1, email: `${"p".repeat(100)}${index}@demo.test`, designation: "d".repeat(60) })),
    }
    expect(payloadSizeError(toDepartmentJoinUpdatePayload(draft))).toBeNull()
  })
})
