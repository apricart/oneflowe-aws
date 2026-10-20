import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { installDomPolyfills } from "@/tests/support/ui-mocks"

const { fetcher, jsonFetcher } = vi.hoisted(() => ({ fetcher: vi.fn(), jsonFetcher: vi.fn() }))
vi.mock("@/lib/fetcher", () => ({ fetcher, jsonFetcher }))

import { DepartmentJoinReviewDialog } from "./department-join-review-dialog"

/**
 * Head Office approving a department sign-up that asks for a new branch
 * (plans/OF-JOIN-department-signup-multi-user.md). The schema is the control;
 * this pins that the dialog names the missing new-branch details instead of
 * sending them and showing the server's refusal, and that a new branch is
 * named as the applicant named it — never after its CRC.
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
  branches: [{
    requestBranchId: 31,
    kind: "new",
    branchId: null,
    name: null,
    costCenterId: "DEMOTTTT",
    requestedName: "Demo Tower" as string | null,
    crcMatch: null as { branchId: number; name: string } | null,
  }],
  addresses: [{ requestAddressId: 41, address: "Plot 4, Clifton", branchId: null }],
  approvers: [],
  approvalLevelsApply: true,
  warehouseCities: [{ city: "Karachi", warehouseCount: 1 }],
  decisionReason: null,
}

function renderDialog(organizationBranches: Array<{ id: number; name: string }> = [], review: typeof REVIEW = REVIEW) {
  fetcher.mockImplementation(async (url: string) => (url.startsWith("/api/v1/join-requests/")
    ? { item: review }
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

/** Pick a city the way Head Office does: open the list, search, choose. */
async function chooseCity(search: string, name = search) {
  fireEvent.click(screen.getByRole("combobox", { name: "City" }))
  fireEvent.change(await screen.findByLabelText("Search city"), { target: { value: search } })
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(`^${name}`) }))
  await waitFor(() => expect(screen.getByRole("combobox", { name: "City" }).textContent).toBe(name))
}

beforeAll(() => installDomPolyfills())

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("DepartmentJoinReviewDialog — a new branch's details", () => {
  it("names the missing fields and sends nothing", async () => {
    renderDialog()
    await screen.findByLabelText("Province")

    approve()

    // The province comes from the city, so the city is the one thing asked for.
    expect(screen.getByRole("alert").textContent)
      .toBe("Complete the new branch for CRC DEMOTTTT before approving: city.")
    expect(screen.getByText("Enter the city")).toBeTruthy()
    expect(screen.queryByText("Enter the province")).toBeNull()
    expect(screen.getByRole("combobox", { name: "City" }).getAttribute("aria-invalid")).toBe("true")
    expect(jsonFetcher).not.toHaveBeenCalled()
  })

  it("sends the branch once it is complete", async () => {
    const onDecided = renderDialog()
    await screen.findByLabelText("Province")

    await chooseCity("karachi", "Karachi")
    const province = screen.getByLabelText("Province") as HTMLInputElement
    expect(province.value).toBe("Sindh")
    expect(province.readOnly).toBe(true)
    approve()

    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    const body = JSON.parse(jsonFetcher.mock.calls[0][1].body)
    expect(body.newBranches).toEqual([
      { requestBranchId: 31, name: "Demo Tower", province: "Sindh", city: "Karachi", address: "Plot 4, Clifton" },
    ])
  })

  it("starts the city and province from the applicant's, and sends them unless Head Office changes them", async () => {
    const located = { ...REVIEW, branches: [{ ...REVIEW.branches[0], requestedCity: "karachi", requestedProvince: "Sindh" }] }
    const onDecided = renderDialog([], located as typeof REVIEW)
    await screen.findByLabelText("Province")
    expect(screen.getByRole("combobox", { name: "City" }).textContent).toBe("Karachi")
    expect((screen.getByLabelText("Province") as HTMLInputElement).value).toBe("Sindh")

    approve()
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(JSON.parse(jsonFetcher.mock.calls[0][1].body).newBranches[0]).toMatchObject({ city: "Karachi", province: "Sindh" })
  })

  it("lets Head Office change the applicant's city", async () => {
    const located = { ...REVIEW, branches: [{ ...REVIEW.branches[0], requestedCity: "Karachi", requestedProvince: "Sindh" }] }
    renderDialog([], located as typeof REVIEW)
    await screen.findByLabelText("Province")
    await chooseCity("Lahore")
    expect((screen.getByLabelText("Province") as HTMLInputElement).value).toBe("Punjab")
  })

  it("starts the branch name from the applicant's, and lists the branch by it", async () => {
    renderDialog()
    expect(((await screen.findByLabelText("Branch name")) as HTMLInputElement).value).toBe("Demo Tower")
    expect(screen.getByText("Demo Tower")).toBeTruthy()
    expect(screen.getByText("CRC DEMOTTTT")).toBeTruthy()
  })

  it("never offers the CRC as the name of a branch an older request did not name", async () => {
    const unnamed = { ...REVIEW, branches: [{ ...REVIEW.branches[0], requestedName: null }] }
    renderDialog([], unnamed)
    expect(((await screen.findByLabelText("Branch name")) as HTMLInputElement).value).toBe("")

    approve()
    expect(screen.getByRole("alert").textContent)
      .toBe("Complete the new branch for CRC DEMOTTTT before approving: branch name, city.")
    expect(jsonFetcher).not.toHaveBeenCalled()
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

/** plans/OF-JOIN-new-branch-city-warehouse.md */
describe("DepartmentJoinReviewDialog — the new branch's city and its warehouse", () => {
  it("finds a city by its province", async () => {
    renderDialog()
    await screen.findByLabelText("Province")

    await chooseCity("Balochistan", "Quetta")
    expect((screen.getByLabelText("Province") as HTMLInputElement).value).toBe("Balochistan")
  })

  it("says a served city's warehouse will take the branch, without naming it", async () => {
    renderDialog()
    await screen.findByLabelText("Province")

    await chooseCity("Karachi")
    expect(screen.getByText(/Karachi is served by an Apricart warehouse\. Approving adds this branch to its deliveries\./)).toBeTruthy()
  })

  it("warns before approving when no warehouse serves the city, and still lets Head Office approve", async () => {
    const onDecided = renderDialog()
    await screen.findByLabelText("Province")

    await chooseCity("Gwadar")
    expect(screen.getByText(/No Apricart warehouse serves Gwadar yet/)).toBeTruthy()
    approve()

    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(JSON.parse(jsonFetcher.mock.calls[0][1].body).newBranches[0]).toMatchObject({ city: "Gwadar", province: "Balochistan" })
  })
})

/**
 * A typed CRC another branch already carries (plans/OF-JOIN-crc-match-at-review.md).
 * The applicant asked for a new branch; it used to be folded silently into the
 * branch with that CRC. Now neither choice is made for Head Office.
 */
describe("DepartmentJoinReviewDialog — a CRC an existing branch carries", () => {
  const MATCHED = {
    ...REVIEW,
    branches: [{ ...REVIEW.branches[0], costCenterId: "0001", requestedName: "Orangi Depot", crcMatch: { branchId: 260, name: "Airport Branch" } }],
  }
  const BRANCHES = [{ id: 260, name: "Airport Branch" }, { id: 50, name: "KE HOUSE" }]
  const choice = () => screen.getByLabelText("Map CRC 0001 to an existing branch") as HTMLSelectElement

  it("names the match and starts with no choice made", async () => {
    renderDialog(BRANCHES, MATCHED)
    await screen.findByText("Airport Branch", { selector: "strong" })

    expect(screen.getByText(/The applicant asked for a new branch named "Orangi Depot"/)).toBeTruthy()
    expect(choice().value).toBe("undecided")
    expect(screen.queryByLabelText("Province")).toBeNull()
    // The matched branch is offered once, beside its CRC.
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Choose: use Airport Branch or create a new branch",
      "Use existing: Airport Branch (has CRC 0001)",
      "Create a new branch",
      "Use existing: KE HOUSE",
    ])
  })

  it("refuses to approve until Head Office chooses, and sends nothing", async () => {
    renderDialog(BRANCHES, MATCHED)
    await screen.findByText("Airport Branch", { selector: "strong" })

    approve()

    expect(screen.getByRole("alert").textContent)
      .toBe("CRC 0001 already belongs to Airport Branch. Choose whether to use Airport Branch or create a new branch before approving.")
    expect(choice().getAttribute("aria-invalid")).toBe("true")
    expect(jsonFetcher).not.toHaveBeenCalled()
  })

  it("sends the matched branch when Head Office uses it", async () => {
    const onDecided = renderDialog(BRANCHES, MATCHED)
    await screen.findByText("Airport Branch", { selector: "strong" })

    fireEvent.change(choice(), { target: { value: "260" } })
    approve()

    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(JSON.parse(jsonFetcher.mock.calls[0][1].body).newBranches).toEqual([{ requestBranchId: 31, mapToBranchId: 260 }])
  })

  it("creates the branch the applicant named when Head Office chooses a new one", async () => {
    const onDecided = renderDialog(BRANCHES, MATCHED)
    await screen.findByText("Airport Branch", { selector: "strong" })

    fireEvent.change(choice(), { target: { value: "" } })
    expect((screen.getByLabelText("Branch name") as HTMLInputElement).value).toBe("Orangi Depot")
    await chooseCity("Karachi")
    approve()

    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(JSON.parse(jsonFetcher.mock.calls[0][1].body).newBranches).toEqual([
      { requestBranchId: 31, name: "Orangi Depot", province: "Sindh", city: "Karachi", address: "Plot 4, Clifton" },
    ])
  })
})
