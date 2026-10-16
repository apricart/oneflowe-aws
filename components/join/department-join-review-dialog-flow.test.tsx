import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, describe, expect, it, vi } from "vitest"

const { fetcher, jsonFetcher } = vi.hoisted(() => ({ fetcher: vi.fn(), jsonFetcher: vi.fn() }))
vi.mock("@/lib/fetcher", () => ({ fetcher, jsonFetcher }))

import { DepartmentJoinReviewDialog } from "./department-join-review-dialog"

/**
 * Head Office deciding a department sign-up from the review dialog
 * (plans/OF-JOIN-department-signup-multi-user.md). The server is the control
 * for every rule here; this pins what the dialog sends for what it showed, so
 * the approval reproduces the review, and that it offers nothing it should not.
 */

type Review = Record<string, any>

function baseReview(overrides: Review = {}): Review {
  return {
    id: 9,
    status: "pending",
    person: {
      firstName: "Sana",
      lastName: "Mir",
      email: "sana.mir@demo.test",
      username: "sana.mir",
      usernameTaken: false,
      phone: "03001234567",
      employeeId: "E-7",
      department: "Finance",
      ipExtension: "1234",
    },
    initiatorRole: "GROUP_ORDER_PORTAL",
    branches: [
      { requestBranchId: 31, kind: "existing", branchId: 5, name: "Clifton", costCenterId: null },
      { requestBranchId: 32, kind: "existing", branchId: 6, name: "Saddar", costCenterId: null },
    ],
    addresses: [
      { requestAddressId: 41, address: "Plot 4, Clifton", branchId: null },
      { requestAddressId: 42, address: "Office 2, Saddar", branchId: null },
    ],
    approvers: [
      {
        level: 1,
        email: "one@demo.test",
        designation: "Director",
        band: { level: 1, fromCents: 8_000_000, belowCents: null },
        resolution: { kind: "assign", userId: "11111111-1111-4111-8111-111111111111", addBranchIds: [6] },
        existingName: "Omar One",
        recordedResolution: null,
      },
      {
        level: 2,
        email: "two@demo.test",
        designation: "Manager",
        band: { level: 2, fromCents: null, belowCents: 8_000_000 },
        resolution: { kind: "create" },
        existingName: null,
        recordedResolution: null,
      },
    ],
    approvalLevelsApply: true,
    emailDomain: "demo.test",
    decisionReason: null,
    ...overrides,
  }
}

function renderDialog(review: Review) {
  fetcher.mockImplementation(async (url: string) => (url.startsWith("/api/v1/join-requests/")
    ? { item: review }
    : { items: [{ id: 5, name: "Clifton" }, { id: 6, name: "Saddar" }, { id: 7, name: "Gulshan" }] }))
  jsonFetcher.mockResolvedValue({ id: 9, status: "approved" })
  const onDecided = vi.fn()
  const onClose = vi.fn()
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DepartmentJoinReviewDialog requestId={9} organizationId={1} onClose={onClose} onDecided={onDecided} />
    </SWRConfig>,
  )
  return { onDecided, onClose }
}

const approveButton = () => screen.getByRole("button", { name: "Approve and create accounts" })
const sentBody = (call = 0) => JSON.parse(jsonFetcher.mock.calls[call][1].body)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("DepartmentJoinReviewDialog — approving", () => {
  it("sends the outcome it showed for each level, and the branch chosen for each address", async () => {
    const { onDecided, onClose } = renderDialog(baseReview())
    await screen.findByText("Plot 4, Clifton")

    fireEvent.change(screen.getByLabelText("Branch for Plot 4, Clifton"), { target: { value: "31" } })
    fireEvent.change(screen.getByLabelText("Branch for Office 2, Saddar"), { target: { value: "32" } })
    fireEvent.click(approveButton())

    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    expect(jsonFetcher.mock.calls[0][0]).toBe("/api/v1/join-requests/9")
    expect(sentBody()).toEqual({
      decision: "approve",
      reason: null,
      newBranches: [],
      addressBranches: [
        { requestAddressId: 41, requestBranchId: 31 },
        { requestAddressId: 42, requestBranchId: 32 },
      ],
      expectedResolutions: [
        { level: 1, kind: "assign", userId: "11111111-1111-4111-8111-111111111111" },
        { level: 2, kind: "create", userId: null },
      ],
    })
  })

  it("asks no branch per address when there is one branch, and sends none", async () => {
    renderDialog(baseReview({
      initiatorRole: "ORDER_PORTAL",
      branches: [{ requestBranchId: 31, kind: "existing", branchId: 5, name: "Clifton", costCenterId: null }],
    }))
    await screen.findByText("Plot 4, Clifton")
    expect(screen.queryByLabelText("Branch for Plot 4, Clifton")).toBeNull()

    fireEvent.click(approveButton())
    await waitFor(() => expect(jsonFetcher).toHaveBeenCalled())
    expect(sentBody().addressBranches).toEqual([])
  })

  it("sends a replacement username only when the requested one is taken", async () => {
    renderDialog(baseReview({ person: { ...baseReview().person, usernameTaken: true } }))
    const input = await screen.findByLabelText(/The username sana.mir is taken/)
    fireEvent.change(input, { target: { value: "Sana.Mir2" } })
    fireEvent.click(approveButton())
    await waitFor(() => expect(jsonFetcher).toHaveBeenCalled())
    expect(sentBody().username).toBe("sana.mir2")
  })

  it("sends no username when it is free, whatever was typed", async () => {
    renderDialog(baseReview())
    await screen.findByText("Plot 4, Clifton")
    expect(screen.queryByLabelText(/is taken/)).toBeNull()
    fireEvent.click(approveButton())
    await waitFor(() => expect(jsonFetcher).toHaveBeenCalled())
    expect(sentBody()).not.toHaveProperty("username")
  })

  it("keeps Approve off while an approver is blocked, and offers a replacement for that level only", async () => {
    const review = baseReview()
    review.approvers[1] = { ...review.approvers[1], resolution: { kind: "blocked", reason: "This person belongs to another organization." } }
    renderDialog(review)
    await screen.findByText("This person belongs to another organization.")
    expect((approveButton() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByLabelText("Replacement Level 2 approver email")).toBeTruthy()
    expect(screen.queryByLabelText("Replacement Level 1 approver email")).toBeNull()
  })

  it("replaces a blocked approver with the same designation, then reloads the review", async () => {
    const review = baseReview()
    review.approvers[1] = { ...review.approvers[1], resolution: { kind: "blocked", reason: "Blocked." } }
    renderDialog(review)
    const input = await screen.findByLabelText("Replacement Level 2 approver email")
    fireEvent.change(input, { target: { value: " new.two@demo.test " } })
    const reviewReads = fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/join-requests/")).length
    fireEvent.click(screen.getByRole("button", { name: "Replace" }))

    await waitFor(() => expect(jsonFetcher).toHaveBeenCalled())
    expect(sentBody()).toEqual({ replaceApprover: { level: 2, email: "new.two@demo.test", designation: "Manager" } })
    await waitFor(() => expect(
      fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/join-requests/")).length,
    ).toBeGreaterThan(reviewReads))
  })

  it("shows the server's refusal, keeps the dialog open and reloads the review", async () => {
    const { onDecided, onClose } = renderDialog(baseReview({
      initiatorRole: "ORDER_PORTAL",
      branches: [{ requestBranchId: 31, kind: "existing", branchId: 5, name: "Clifton", costCenterId: null }],
    }))
    await screen.findByText("Plot 4, Clifton")
    jsonFetcher.mockRejectedValueOnce(new Error("Level 2 changed since you reviewed this request. Open it again before approving."))
    const reviewReads = fetcher.mock.calls.length

    fireEvent.click(approveButton())
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed since you reviewed/)
    expect(onDecided).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(reviewReads))
  })

  it("maps a CRC onto an existing branch without asking for new-branch details", async () => {
    renderDialog(baseReview({
      initiatorRole: "ORDER_PORTAL",
      branches: [{ requestBranchId: 33, kind: "new", branchId: null, name: null, costCenterId: "NEW-1" }],
    }))
    const select = await screen.findByLabelText("Map CRC NEW-1 to an existing branch")
    await screen.findByRole("option", { name: "Use existing: Gulshan" })
    fireEvent.change(select, { target: { value: "7" } })
    expect(screen.queryByLabelText("Province")).toBeNull()

    fireEvent.click(approveButton())
    await waitFor(() => expect(jsonFetcher).toHaveBeenCalled())
    expect(sentBody().newBranches).toEqual([{ requestBranchId: 33, mapToBranchId: 7 }])
  })
})

describe("DepartmentJoinReviewDialog — rejecting", () => {
  it("sends the decision and the note only, never the approval's details", async () => {
    renderDialog(baseReview())
    await screen.findByText("Plot 4, Clifton")
    fireEvent.change(screen.getByLabelText("Note for your records"), { target: { value: "  Not one of ours  " } })
    fireEvent.click(screen.getByRole("button", { name: "Reject" }))
    await waitFor(() => expect(jsonFetcher).toHaveBeenCalled())
    expect(sentBody()).toEqual({ decision: "reject", reason: "Not one of ours" })
  })

  it("sends a null reason when no note was written", async () => {
    renderDialog(baseReview())
    await screen.findByText("Plot 4, Clifton")
    fireEvent.click(screen.getByRole("button", { name: "Reject" }))
    await waitFor(() => expect(jsonFetcher).toHaveBeenCalled())
    expect(sentBody()).toEqual({ decision: "reject", reason: null })
  })
})

describe("DepartmentJoinReviewDialog — editing", () => {
  it("swaps the review for the edit form and hides the decision while editing", async () => {
    renderDialog(baseReview())
    fireEvent.click(await screen.findByRole("button", { name: /Edit details/ }))
    expect(screen.getByLabelText(/^First name/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Approve and create accounts" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(approveButton()).toBeTruthy()
    expect(jsonFetcher).not.toHaveBeenCalled()
  })

  it("saves, reloads the review, and returns to it", async () => {
    renderDialog(baseReview())
    fireEvent.click(await screen.findByRole("button", { name: /Edit details/ }))
    fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: "03119999999" } })
    jsonFetcher.mockResolvedValueOnce({ id: 9, updated: true })
    const reviewReads = fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/join-requests/")).length

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(approveButton()).toBeTruthy())
    expect(sentBody().update.phone).toBe("03119999999")
    await waitFor(() => expect(
      fetcher.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/join-requests/")).length,
    ).toBeGreaterThan(reviewReads))
  })
})

describe("DepartmentJoinReviewDialog — a decided request", () => {
  it("offers no edit and no decision, and shows what was recorded", async () => {
    const review = baseReview({ status: "approved" })
    review.approvers = review.approvers.map((approver: any) => ({ ...approver, recordedResolution: "created" }))
    renderDialog(review)
    await screen.findByText("Plot 4, Clifton")
    expect(screen.queryByRole("button", { name: /Edit details/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Approve and create accounts" })).toBeNull()
    expect(screen.queryByLabelText("Branch for Plot 4, Clifton")).toBeNull()
    expect(screen.getAllByText("Recorded: created")).toHaveLength(2)
  })
})

describe("DepartmentJoinReviewDialog — levels switched off since the request was sent", () => {
  it("says no one will be given a level", async () => {
    const review = baseReview({ approvalLevelsApply: false })
    review.approvers = review.approvers.map((approver: any) => ({
      ...approver,
      resolution: { kind: "not_applied", reason: "Approval levels are off for this organization." },
    }))
    renderDialog(review)
    expect(await screen.findByText(/gives no one a level/)).toBeTruthy()
    expect((approveButton() as HTMLButtonElement).disabled).toBe(false)
  })
})

describe("DepartmentJoinReviewDialog — the role each approver ends with", () => {
  const oneBranch = {
    initiatorRole: "ORDER_PORTAL",
    branches: [{ requestBranchId: 31, kind: "existing", branchId: 5, name: "Clifton", costCenterId: null }],
  }

  it("says a new approver for one branch becomes that branch's Branch Admin", async () => {
    renderDialog(baseReview(oneBranch))
    expect(await screen.findByText(/a Branch Admin of Clifton is created with Level 2/)).toBeTruthy()
    expect(screen.getByText("Order Portal User (one branch)")).toBeTruthy()
  })

  it("says a new approver for several branches becomes a Group User", async () => {
    renderDialog(baseReview())
    expect(await screen.findByText(/a Group User is created with Level 2 and these branches/)).toBeTruthy()
  })

  it("says an existing Branch Admin becomes a Group User and is signed out", async () => {
    const review = baseReview()
    review.approvers[0] = {
      ...review.approvers[0],
      existingRole: "BRANCH_ADMIN",
      resolution: { kind: "assign", userId: "11111111-1111-4111-8111-111111111111", addBranchIds: [6], becomesGroupUser: true },
    }
    renderDialog(review)
    expect(await screen.findByText(/become a Group User instead of a Branch Admin, keep their own branch, and are signed out/)).toBeTruthy()
  })

  it("warns, and changes the roles shown, when mapping a CRC leaves fewer branches", async () => {
    renderDialog(baseReview({
      branches: [
        { requestBranchId: 31, kind: "existing", branchId: 5, name: "Clifton", costCenterId: null },
        { requestBranchId: 33, kind: "new", branchId: null, name: null, costCenterId: "NEW-1" },
      ],
    }))
    const select = await screen.findByLabelText("Map CRC NEW-1 to an existing branch")
    expect(screen.getByText(/a Group User is created with Level 2/)).toBeTruthy()
    await screen.findByRole("option", { name: "Use existing: Clifton" })
    fireEvent.change(select, { target: { value: "5" } })

    expect(screen.getByText(/this person has 1 branch, not 2/)).toBeTruthy()
    expect(screen.getByText(/a Branch Admin of Clifton is created with Level 2/)).toBeTruthy()
    expect(screen.getByText("Order Portal User (one branch)")).toBeTruthy()
  })
})
