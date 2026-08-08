import { describe, expect, it } from "vitest"
import {
  ORGANIZATION_LIST_HEADERS,
  buildOrganizationListWorkbookData,
  buildOrganizationWorkbookData,
  getOrganizationListExportFilename,
  getOrganizationExportFilename,
} from "./organization-excel-export"

describe("buildOrganizationListWorkbookData", () => {
  it("creates one row per authorized organization with exactly eight columns", () => {
    const rows = buildOrganizationListWorkbookData(
      [
        {
          id: 7,
          name: "Acme Holdings",
          code: "ACME",
          status: "active",
          budgetAllocationMode: "quantity",
          orderApproverRole: "HEAD_OFFICE",
        },
        {
          id: 8,
          name: "Beta Limited",
          code: "BETA",
          status: "inactive",
          budgetAllocationMode: "money",
          orderApproverRole: "BRANCH_ADMIN",
        },
      ],
      [
        { id: 11, organizationId: 7, name: "Karachi", code: "KHI", status: "active" },
        { id: 12, organizationId: 7, name: "Lahore", code: "LHE", status: "inactive" },
        { id: 13, organizationId: 999, name: "Out of scope", code: "OTHER", status: "active" },
      ],
    )

    expect(ORGANIZATION_LIST_HEADERS).toHaveLength(8)
    expect(rows).toHaveLength(2)
    expect(Object.keys(rows[0])).toEqual([...ORGANIZATION_LIST_HEADERS])
    expect(rows[0]).toEqual({
      "Organization Name": "Acme Holdings",
      "Organization Code": "ACME",
      "Status": "Active",
      "Budget Allocation Mode": "Quantity-based",
      "Order Approver": "Head Office",
      "Total Branches": 2,
      "Active Branches": 1,
      "Inactive Branches": 1,
    })
    expect(rows[1]["Total Branches"]).toBe(0)
  })
})

describe("buildOrganizationWorkbookData", () => {
  it("exports the organization summary and only its branches", () => {
    const exportedAt = new Date("2026-07-27T08:15:30.000Z")
    const result = buildOrganizationWorkbookData(
      {
        id: 7,
        name: "Acme Holdings",
        code: "ACME",
        status: "active",
        budgetAllocationMode: "quantity",
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-02-03T04:05:06.000Z",
      },
      [
        {
          id: 11,
          organizationId: 7,
          name: "Karachi Office",
          code: "ACME-01",
          status: "active",
          province: "Sindh",
          city: "Karachi",
          address: "Shahrah-e-Faisal",
          costCenterId: "CC-100",
          groupName: "South",
        },
        {
          id: 12,
          organizationId: 7,
          name: "Lahore Office",
          code: "ACME-02",
          status: "inactive",
        },
        {
          id: 99,
          organizationId: 8,
          name: "Other Company Branch",
          code: "OTHER-01",
          status: "active",
        },
      ],
      exportedAt,
    )

    expect(Object.fromEntries(
      result.organizationDetails.map((row) => [row.Field, row.Value]),
    )).toMatchObject({
      "Organization Name": "Acme Holdings",
      "Organization Code": "ACME",
      "Budget Allocation Mode": "Quantity-based",
      "Total Branches": 2,
      "Active Branches": 1,
      "Inactive Branches": 1,
      "Created At": "2026-01-02 03:04:05 UTC",
      "Exported At": "2026-07-27 08:15:30 UTC",
    })
    expect(result.branchDetails).toHaveLength(2)
    expect(result.branchDetails[0]).toMatchObject({
      "Organization Name": "Acme Holdings",
      "Branch Name": "Karachi Office",
      "Cost Center ID": "CC-100",
      "Group / Cluster": "South",
    })
    expect(result.branchDetails[1]["Group / Cluster"]).toBe("Ungrouped")
  })
})

describe("getOrganizationExportFilename", () => {
  it("creates a safe and dated Excel filename", () => {
    expect(getOrganizationExportFilename(
      { name: "Acme Holdings", code: "../../ACME / North" },
      new Date("2026-07-27T08:15:30.000Z"),
    )).toBe("ACME_North-organization-details-2026-07-27.xlsx")
  })

  it("creates a dated filename for the organization list", () => {
    expect(getOrganizationListExportFilename(
      new Date("2026-07-31T08:15:30.000Z"),
    )).toBe("organizations-2026-07-31.xlsx")
  })
})
