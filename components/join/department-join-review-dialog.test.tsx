import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, describe, expect, it, vi } from "vitest"

const { fetcher, jsonFetcher } = vi.hoisted(() => ({ fetcher: vi.fn(), jsonFetcher: vi.fn() }))
vi.mock("@/lib/fetcher", () => ({ fetcher, jsonFetcher }))

import { DepartmentJoinReviewDialog } from "./department-join-review-dialog"

/**
 * Head Office approving a department sign-up that asks for a new branch
 * (plans/OF-JOIN-department-signup-multi-user.md). The schema is the control;
 * this pins that the dialog names the missing new-branch details instead of
 * sending them and showing the server's refusal.
 */

const REVIEW = {
  id: 9,
  status: "pending",
  person: {
    firstName: "Mahmood",
    lastName: "Khan",
    email: "mahmood.khan@demo.test",
    username: "mahmood.khan",
    usernameTaken: false,
    phone: "03001234567",
    employeeId: "E-1",
    department: "Finance",
    ipExtension: "1234",
  },
  initiatorRole: "ORDER_PORTAL",
  branches: [{ requestBranchId: 31, kind: "new", branchId: null, name: null, costCenterId: "DEMOTTTT" }],
  addresses: [{ requestAddressId: 41, address: "Plot 4, Clifton", branchId: null }],
  approvers: [],
  approvalLevelsApply: true,
  decisionReason: null,
}

function renderDialog(organizationBranches: Array<{ id: number; name: string }> = []) {
  fetcher.mockImplementation(async (url: string) => (url.startsWith("/api/v1/join-requests/")
    ? { item: REVIEW }
    : { items: organizationBranches }))
  jsonFetcher.mockResolvedValue({ id: 9, status: "approved" })
  const onDecided = vi.fn()
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DepartmentJoinReviewDialog requestId={9} organizationId={1} onClose={vi.fn()} onDecided={onDecided} />
    </SWRConfig>,
  )
  return onDecided
}

const approve = () => fireEvent.click(screen.getByRole("button", { name: "Approve and create accounts" }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("DepartmentJoinReviewDialog — a new branch's details", () => {
  it("names the missing fields and sends nothing", async () => {
    renderDialog()
    await screen.findByLabelText("Province")

    approve()

    expect(screen.getByRole("alert").textContent)
      .toBe("Complete the new branch for CRC DEMOTTTT before approving: province, city.")
    expect(screen.getByText("Enter the province")).toBeTruthy()
    expect(screen.getByText("Enter the city")).toBeTruthy()
    expect(screen.getByLabelText("Province").getAttribute("aria-invalid")).toBe("true")
    expect(jsonFetcher).not.toHaveBeenCalled()
  })

  it("sends the branch once it is complete", async () => {
    const onDecided = renderDialog()
    await screen.findByLabelText("Province")

    fireEvent.change(screen.getByLabelText("Province"), { target: { value: "Sindh" } })
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Karachi" } })
    approve()

    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    const body = JSON.parse(jsonFetcher.mock.calls[0][1].body)
    expect(body.newBranches).toEqual([
      { requestBranchId: 31, name: "DEMOTTTT", province: "Sindh", city: "Karachi", address: "Plot 4, Clifton" },
    ])
  })

  it("asks for no details when the CRC is mapped onto an existing branch", async () => {
    const onDecided = renderDialog([{ id: 296, name: "Demo North Branch" }])
    await screen.findByText("Use existing: Demo North Branch")

    fireEvent.change(screen.getByLabelText("Map CRC DEMOTTTT to an existing branch"), { target: { value: "296" } })
    approve()

    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(JSON.parse(jsonFetcher.mock.calls[0][1].body).newBranches).toEqual([{ requestBranchId: 31, mapToBranchId: 296 }])
  })
})
